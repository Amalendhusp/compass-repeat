// Circle tool, spec §4.2 + the radius model (§3), Point Targets per Phase 3.4. Phase 5.13 — direct
// manipulation, three ways, no buttons: finger down begins, a drag shows the live ghost, release
// commits (Undo corrects; pointercancel abandons):
// - By radius: press a centre, drag out (the radius end snaps to points), release. A tap on a centre
//   and a later tap/drag for the radius still works. The radius is remembered for Arc.
// - Between edges: tap 3–6 edges; the circle appears the moment they close a polygon that has one,
//   and is made on that release.
// - Copy circle: tap a circle to take its radius, then press/drag the copy into place — its centre
//   snaps to points and slides along lines and curves — and release to make it. Repeat for more.

import { addCircleEntity, addCircleWithExactRadius, addOnCurvePoint, addOrReuseFreePoint } from '../../model/doc.ts';
import type { AppController, CopyRadiusState, IncircleLine, IncircleState, ViewTransform } from '../../app/controller.ts';
import { screenToWorld } from '../../app/controller.ts';
import { dist } from '../../geometry/vec.ts';
import { curveCandidatesAt, isNearAnyCurve } from '../hittest.ts';
import { deriveSegments, isParamTrimmed } from '../../geometry/segments.ts';
import { circleInEdges, type EdgeInput } from '../../geometry/incircle.ts';
import { buildNodeInset } from '../nodeinset.ts';
import { confirmSnap, noPointGesture, PointHold, resolveTap, showNoPoint, SnapTracker, type SnapHit } from '../snap.ts';
import { materializeRef, refAt, refFromHit, refLocation, type PointRef } from '../pointref.ts';
import { showToast } from '../../ui/toast.ts';
import type { Doc, Entity, EntityId, Vec2 } from '../../model/types.ts';
import { resolveEntityGeom, epsilon, intersectEntities, projectOntoEntity } from '../../geometry/kernel.ts';
import type { Gesture, ToolModule } from './types.ts';

/** Phase 5.5: the same circle again (same centre point, same radius) is never useful, and a
 * doubled curve used to merge the regions on either side of it — so it simply isn't created. */
function circleExists(doc: Doc, centre: PointRef, radius: number): boolean {
  if (centre.kind !== 'existing') return false;
  const tol = epsilon(doc) * 100;
  return doc.entities.some((e) => {
    if (e.kind !== 'circle' || e.centre !== centre.id) return false;
    const g = resolveEntityGeom(doc, e);
    return g.kind === 'circle' && Math.abs(g.radius - radius) < tol;
  });
}

function sameExisting(a: PointRef, b: PointRef): boolean {
  return a.kind === 'existing' && b.kind === 'existing' && a.id === b.id;
}

export const circleTool: ToolModule = {
  id: 'circle',
  hint(controller) {
    if (controller.circleVariant === 'three-lines') return 'Tap the edges around the circle';
    if (controller.circleVariant === 'copy-radius') return controller.copyRadius?.radius ? 'Drag the copy into place' : 'Tap a circle';
    if (controller.pending?.kind === 'circle') {
      return controller.pointLockHint ? 'Point Targets · choose an existing point' : 'Drag to set the radius, or tap a point';
    }
    return 'Tap a point or a curve';
  },
  beginGesture(controller, view, screenPos): Gesture | null {
    if (controller.circleVariant === 'three-lines') return betweenEdgesGesture(controller, view, screenPos);
    if (controller.circleVariant === 'copy-radius') return copyCircleGesture(controller, view, screenPos);
    // Phase 5.13: By radius only — Same radius is now Copy circle (any circle's radius, exactly).
    const doc = controller.doc;

    const tracker = new SnapTracker(doc);
    let centreHit: ReturnType<SnapTracker['pick']> = null;
    let centreRef: PointRef;
    // True only while THIS gesture is the one still choosing the centre (down → first move/up).
    // Used solely to decide what a plain tap-without-drag means in onUp below. It must never
    // gate onCancel: per Phase 1.1 item 3, once pending.centre is set — even by this same
    // still-active gesture — a second finger must not be able to undo it.
    let justSetCentre = false;

    if (controller.pending?.kind === 'circle') {
      centreRef = controller.pending.centre;
    } else {
      const hit = tracker.pick(view, screenPos);
      if (!hit) return tracker.noPoint ? noPointGesture(controller, tracker.noPoint) : null;
      centreHit = hit;
      centreRef = refFromHit(hit);
      controller.pending = { kind: 'circle', centre: centreRef };
      justSetCentre = true;
    }

    let centreAt = refLocation(doc, centreRef);
    controller.preview = { kind: 'circle', centre: centreAt, through: centreAt };
    controller.notify();
    // Phase 5.9: holding still on a crowded spot opens the precision loupe (centre or radius point).
    if (!justSetCentre) tracker.pick(view, screenPos);
    const hold = new PointHold(controller, view, tracker, screenPos);

    const finish = (throughRef: PointRef) => {
      if (circleExists(doc, centreRef, dist(refLocation(doc, centreRef), refLocation(doc, throughRef)))) {
        showToast('Already drawn');
        controller.cancelPending();
        controller.nodeInset = null;
        return;
      }
      if (sameExisting(centreRef, throughRef)) {
        controller.pending = null;
        controller.preview = null;
        controller.nodeInset = null;
        controller.notify();
        return;
      }
      let radius = 0;
      controller.commit((d) => {
        const centreId = materializeRef(d, centreRef);
        const throughId = materializeRef(d, throughRef);
        if (centreId !== throughId) addCircleEntity(d, centreId, throughId);
        radius = dist(refLocation(d, centreRef), refLocation(d, throughRef));
      });
      if (radius > 0) controller.doc.toolPrefs.lastRadius = radius;
      controller.pending = null;
      controller.preview = null;
      controller.nodeInset = null;
      controller.pointLockHint = false;
      controller.notify();
    };

    return {
      onMove(sp) {
        const held = hold.move(sp);
        if (held !== undefined) {
          if (justSetCentre) {
            centreRef = refFromHit(held);
            centreAt = held.at;
            controller.pending = { kind: 'circle', centre: centreRef };
            controller.preview = null;
          } else controller.preview = { kind: 'circle', centre: centreAt, through: held.at };
          controller.notifyView();
          return;
        }
        if (hold.open) return;
        const hit = tracker.pick(view, sp);
        const through = hit ? hit.at : screenToWorld(view, sp);
        controller.preview = { kind: 'circle', centre: centreAt, through };
        controller.nodeInset = hit ? buildNodeInset(doc, view, sp, hit.at, tracker) : null;
        const lockedOut = !doc.pointTargets.free && !hit && isNearAnyCurve(doc, view, sp);
        const transitioned = lockedOut !== controller.pointLockHint;
        controller.pointLockHint = lockedOut;
        // Rendering-only update, except when the Point Targets hint itself just changed.
        if (transitioned) controller.notify();
        else controller.notifyView();
      },
      onUp(sp, wasDrag) {
        const held = hold.release();
        if (held) {
          confirmSnap(controller, held);
          if (justSetCentre) {
            centreRef = refFromHit(held);
            controller.pending = { kind: 'circle', centre: centreRef };
            controller.preview = null;
            controller.nodeInset = null;
            controller.notify();
          } else finish(refFromHit(held));
          return;
        }
        if (!wasDrag && justSetCentre) {
          // First tap only planted the centre; wait for the next tap or drag.
          controller.preview = null;
          controller.nodeInset = null;
          resolveTap(controller, tracker, centreHit, (h) => {
            centreRef = refFromHit(h);
            centreAt = refLocation(doc, centreRef);
            controller.pending = { kind: 'circle', centre: centreRef };
          });
          controller.notify();
          return;
        }
        const hit = tracker.pick(view, sp);
        if (hit) {
          if (wasDrag) {
            confirmSnap(controller, hit);
            finish(refFromHit(hit));
          } else resolveTap(controller, tracker, hit, (h) => finish(refFromHit(h)));
          return;
        }
        if (!doc.pointTargets.free && isNearAnyCurve(doc, view, sp)) {
          // Touched a curve with no eligible point there — no point is planted, and the centre
          // stays armed for a fresh attempt.
          if (tracker.noPoint && !wasDrag) showNoPoint(controller, tracker.noPoint);
          controller.preview = { kind: 'circle', centre: centreAt, through: centreAt };
          controller.nodeInset = null;
          controller.pointLockHint = true;
          controller.notify();
          return;
        }
        if (wasDrag) {
          // Radius model: a drag released in truly empty space still creates a free point.
          finish(refAt(screenToWorld(view, sp)));
        } else {
          // §1.3: a tap-miss on a later step cancels back to waiting for a fresh centre.
          controller.cancelPending();
        }
      },
      onCancel() {
        // Phase 3.2 item 4: a second finger (pinch/pan) cancels the pending centre; the tool stays.
        hold.cancel();
        controller.cancelPending();
      },
    };
  },
};

// ---- Between edges (Phase 5.12b/c → 5.13): the exact circle inside 3–6 chosen edges ----
//
// A tap chooses an EDGE — the continuous visible stretch of the tapped line between the nearest
// genuine crossings with other curves on either side (Phase 5.12c) — because that is how an edge is
// read in a dense construction. The whole infinite line takes part in the geometry. Tapping a chosen
// edge again removes it; a tap on empty canvas clears them all. The edges are used in a fixed order
// (by line id), so the order they were chosen in never changes the circle. The moment the chosen
// edges close a polygon end to end that has one exact tangent circle (geometry/incircle.ts
// circleInEdges), the circle shows while the finger is still down and is made when it lifts.

const MAX_EDGES = 6;
const MIN_RADIUS_EPS = 20;

function emptyEdges(): IncircleState {
  return { lines: [], result: null, polygon: null, status: 'open' };
}

/** The chosen edges in a fixed order (by entity id), independent of the order they were tapped. */
function canonicalLines(lines: IncircleLine[]): IncircleLine[] {
  return [...lines].sort((p, q) => (p.entityId < q.entityId ? -1 : p.entityId > q.entityId ? 1 : 0));
}

function lineAt(g: { a: Vec2; b: Vec2 }, t: number): Vec2 {
  return { x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t };
}

/**
 * The edge of `line` through `param`: out to the nearest genuine crossing with another curve on
 * each side, else to where the line's visible extent (or a trimmed gap) ends. A crossing is
 * genuine only where the other curve is really there — inside a finite line's own span, not in a
 * trimmed piece — and a circle merely touching the line (tangent) does not count.
 */
export function edgeRunAt(doc: Doc, line: Extract<Entity, { kind: 'line' }>, param: number): { t0: number; t1: number } | null {
  const eps = epsilon(doc);
  const segs = deriveSegments(doc, line);
  if (segs.length === 0) return null;
  const extent = [Math.min(...segs.map((s) => s.fromParam)), Math.max(...segs.map((s) => s.toParam))] as const;
  if (param < extent[0] - 1e-9 || param > extent[1] + 1e-9) return null;
  const stops: number[] = [extent[0], extent[1]];
  for (const s of segs) {
    if (doc.segmentStates.get(s.key)?.state !== 'trimmed') continue;
    if (param > s.fromParam && param < s.toParam) return null; // tapped where nothing is drawn
    stops.push(s.fromParam, s.toParam);
  }
  for (const other of doc.entities) {
    if (other.id === line.id) continue;
    const pts = intersectEntities(doc, line, other);
    if (other.kind === 'circle' && pts.length === 1) continue; // tangent: touches, doesn't cross
    for (const pt of pts) {
      const onOther = projectOntoEntity(doc, other, pt).param;
      if (other.kind === 'line' && !other.extended && (onOther < -eps || onOther > 1 + eps)) continue;
      if (isParamTrimmed(doc, other, onOther)) continue;
      stops.push(projectOntoEntity(doc, line, pt).param);
    }
  }
  let t0 = extent[0];
  let t1 = extent[1];
  for (const t of stops) {
    if (t < param && t > t0) t0 = t;
    if (t > param && t < t1) t1 = t;
  }
  return t1 - t0 > 1e-12 ? { t0, t1 } : null;
}

/** What the chosen edges make: open, never closable, closed without a circle, or the circle. */
export function evaluateEdges(doc: Doc, lines: IncircleLine[]): IncircleState {
  const edges = canonicalLines(lines);
  const inputs: EdgeInput[] = [];
  for (const l of edges) {
    const e = doc.entities.find((x) => x.id === l.entityId);
    if (!e || e.kind !== 'line') return { lines, result: null, polygon: null, status: 'invalid' };
    const g = resolveEntityGeom(doc, e);
    if (g.kind !== 'line') return { lines, result: null, polygon: null, status: 'invalid' };
    inputs.push({ line: { a: g.a, b: g.b }, run: [l.a, l.b] });
  }
  // Smaller than this and its centre and tangency points would merge into each other (the model
  // merges points closer than epsilon), so it could not be built as a true tangent circle.
  const r = circleInEdges(inputs, { minRadius: epsilon(doc) * MIN_RADIUS_EPS });
  switch (r.kind) {
    case 'open':
      return { lines, result: null, polygon: null, status: 'open' };
    case 'invalid':
      return { lines, result: null, polygon: null, status: 'invalid' };
    case 'no-circle':
      return { lines, result: null, polygon: r.polygon, status: 'no-circle' };
    case 'circle':
      return { lines, result: r.circle, polygon: r.polygon, status: 'circle' };
  }
}

/** Sticky edge: once a press is on an edge, that edge stays the choice unless the finger comes
 * clearly closer to another line — by more than this — or clearly past the crossing that ends the
 * edge. Fingertips drift 2–8 px between touching and lifting, and in a dense construction the next
 * line is often only 5–8 px away; without this, an ordinary tap on a phone could lift off the
 * neighbouring line and choose it instead (a still mouse click never drifts). Deliberate slides
 * still move the choice. */
const STICKY_EDGE_PX = 10;

type EdgeHit = { entity: Extract<Entity, { kind: 'line' }>; param: number; d: number };

function lineHitsAt(doc: Doc, view: ViewTransform, sp: Vec2): EdgeHit[] {
  return curveCandidatesAt(doc, view, sp).filter((h): h is EdgeHit => h.entity.kind === 'line');
}

/** The edge of `hit`'s line through its param, as a choice. */
function edgeOf(doc: Doc, hit: EdgeHit): IncircleLine | null {
  const run = edgeRunAt(doc, hit.entity, hit.param);
  const g = resolveEntityGeom(doc, hit.entity);
  if (!run || g.kind !== 'line') return null;
  return { entityId: hit.entity.id, t0: run.t0, t1: run.t1, a: lineAt(g, run.t0), b: lineAt(g, run.t1) };
}

/** The edge the finger means now, given the edge it meant a moment ago (`held`). */
function stickyEdge(doc: Doc, view: ViewTransform, sp: Vec2, held: IncircleLine | null): IncircleLine | null {
  const hits = lineHitsAt(doc, view, sp);
  const best = hits[0];
  if (!best) return null;
  if (!held) return edgeOf(doc, best);
  const same = hits.find((h) => h.entity.id === held.entityId);
  // The held line is out of reach, or another line is clearly closer: move on.
  if (!same || same.d - best.d > STICKY_EDGE_PX) return edgeOf(doc, best);
  // Still on the held line: keep its edge until the finger is clearly past either end of it.
  const g = resolveEntityGeom(doc, same.entity);
  if (g.kind !== 'line') return held;
  const lenPx = Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) * view.zoom;
  const beyond = Math.max(held.t0 - same.param, same.param - held.t1, 0) * lenPx;
  return beyond > STICKY_EDGE_PX ? edgeOf(doc, same) : held;
}

/** The edges with `pick` toggled: the same edge again removes it, another edge of the same line
 * moves that line's choice, a new line is added (up to six). */
function toggleEdge(lines: IncircleLine[], pick: IncircleLine): IncircleLine[] {
  const out = [...lines];
  const i = out.findIndex((l) => l.entityId === pick.entityId);
  if (i >= 0) {
    if (Math.abs(out[i]!.t0 - pick.t0) < 1e-9 && Math.abs(out[i]!.t1 - pick.t1) < 1e-9) out.splice(i, 1);
    else out[i] = pick;
  } else if (out.length < MAX_EDGES) out.push(pick);
  else return lines;
  return out;
}

/** Press: the edge under the finger is shown as chosen (or un-chosen) at once, with the circle if
 * that closes it; sliding clearly onto another edge moves the choice there (small drift does not —
 * see STICKY_EDGE_PX); lifting keeps it — and makes the circle when there is one. A tap on empty
 * canvas clears the chosen edges. */
function betweenEdgesGesture(controller: AppController, view: ViewTransform, screenPos: Vec2): Gesture {
  const doc = controller.doc;
  const before = controller.incircle ?? emptyEdges();
  let held: IncircleLine | null = null;
  const at = (sp: Vec2): { state: IncircleState; offCurves: boolean } => {
    const pick = (held = stickyEdge(doc, view, sp, held));
    if (!pick) return { state: before, offCurves: curveCandidatesAt(doc, view, sp).length === 0 };
    const lines = toggleEdge(before.lines, pick);
    return { state: lines === before.lines ? before : evaluateEdges(doc, lines), offCurves: false };
  };
  let now = at(screenPos);
  controller.incircle = now.state;
  controller.notifyView();
  return {
    onMove(sp) {
      now = at(sp);
      controller.incircle = now.state;
      controller.notifyView();
    },
    onUp(sp, wasDrag) {
      now = at(sp);
      if (now.state.status === 'circle') {
        createFromEdges(controller, now.state);
      } else if (now.state === before && now.offCurves && !wasDrag) {
        controller.incircle = emptyEdges();
      } else controller.incircle = now.state;
      controller.notify();
    },
    onCancel() {
      controller.incircle = before;
      controller.notify();
    },
  };
}

/** Makes the circle as one undoable step: its centre (an existing point if one is already there)
 * and a through-point at the exact tangency on the first line (in fixed order); the other
 * tangencies are materialized like any other crossing. The chosen edges are then cleared. */
function createFromEdges(controller: AppController, state: IncircleState): void {
  const c = state.result;
  controller.incircle = emptyEdges();
  if (!c) return;
  const doc = controller.doc;
  const tol = epsilon(doc) * 100;
  const exists = doc.entities.some((e) => {
    if (e.kind !== 'circle') return false;
    const g = resolveEntityGeom(doc, e);
    return g.kind === 'circle' && dist(g.centre, c.centre) < tol && Math.abs(g.radius - c.radius) < tol;
  });
  if (exists) {
    showToast('Already drawn');
    return;
  }
  const first = canonicalLines(state.lines)[0]!;
  controller.commit((d) => {
    const centre = addOrReuseFreePoint(d, c.centre);
    const through = addOnCurvePoint(d, first.entityId, c.params[0]!, c.feet[0]!);
    addCircleEntity(d, centre, through);
  });
}

// ---- Copy circle (Phase 5.12d → 5.13): any circle's exact radius, placed by dragging ----
//
// Once made, a circle is just a centre and a radius, however it was constructed. Tap the circle
// itself — anywhere on it — and its radius is read exactly from its stored geometry (never measured
// from the screen). Then press where the copy should go: the whole ghost circle follows the finger,
// its centre snapping to a point near the finger, otherwise sliding along the line or curve under
// it (for placing only — Point Targets are unchanged). Release makes it (one undo step) and the same
// radius stays ready for the next copy. A tap on a bare circle takes that circle's radius instead;
// nothing under the finger means nothing is made. The centre point itself is created only on release.

const SOURCE_FLASH_MS = 1200;

function copyState(controller: AppController): CopyRadiusState {
  return controller.copyRadius ?? { sourceId: null, radius: null, flashUntil: 0, centreAt: null };
}

/** Takes `circleId`'s radius exactly, and flashes it. */
function captureRadius(controller: AppController, circleId: EntityId): boolean {
  const e = controller.doc.entities.find((x) => x.id === circleId);
  const g = e ? resolveEntityGeom(controller.doc, e) : null;
  if (!g || g.kind !== 'circle') return false;
  controller.copyRadius = { sourceId: circleId, radius: g.radius, flashUntil: performance.now() + SOURCE_FLASH_MS, centreAt: null };
  setTimeout(() => controller.notifyView(), SOURCE_FLASH_MS + 30);
  return true;
}

type Placement = { kind: 'point'; hit: SnapHit; at: Vec2 } | { kind: 'curve'; host: EntityId; circle: boolean; at: Vec2 };

function copyCircleGesture(controller: AppController, view: ViewTransform, screenPos: Vec2): Gesture {
  const doc = controller.doc;
  const st = copyState(controller);

  if (st.radius === null) {
    // Choosing the source: a tap on any circle (or arc) — its curve, not a point on it.
    return {
      onMove() {},
      onUp(sp, wasDrag) {
        if (wasDrag) return;
        const hit = curveCandidatesAt(doc, view, sp).find((h) => h.entity.kind === 'circle');
        if (hit && captureRadius(controller, hit.entity.id)) controller.notify();
      },
      onCancel() {},
    };
  }

  const radius = st.radius;
  const tracker = new SnapTracker(doc);
  const placeAt = (sp: Vec2): Placement | null => {
    const hit = tracker.pick(view, sp);
    if (hit?.id) return { kind: 'point', hit, at: hit.at };
    const curve = curveCandidatesAt(doc, view, sp)[0];
    if (!curve) return null;
    const g = resolveEntityGeom(doc, curve.entity);
    const at =
      g.kind === 'line'
        ? lineAt(g, curve.param)
        : { x: g.centre.x + g.radius * Math.cos(curve.param), y: g.centre.y + g.radius * Math.sin(curve.param) };
    return { kind: 'curve', host: curve.entity.id, circle: curve.entity.kind === 'circle', at };
  };
  let place = placeAt(screenPos);
  const show = (sp: Vec2) => {
    controller.copyRadius = { ...copyState(controller), centreAt: place?.at ?? null };
    controller.nodeInset = place?.kind === 'point' ? buildNodeInset(doc, view, sp, place.at, tracker) : null;
    controller.notifyView();
  };
  show(screenPos);
  const hold = new PointHold(controller, view, tracker, screenPos);
  const clear = () => {
    controller.copyRadius = { ...copyState(controller), centreAt: null };
    controller.nodeInset = null;
    controller.preview = null;
  };
  return {
    onMove(sp) {
      const held = hold.move(sp);
      if (held !== undefined) {
        place = { kind: 'point', hit: held, at: held.at };
        show(sp);
        return;
      }
      if (hold.open) return;
      place = placeAt(sp);
      show(sp);
    },
    onUp(sp, wasDrag) {
      const held = hold.release();
      if (held) place = { kind: 'point', hit: held, at: held.at };
      else if (!hold.open) place = placeAt(sp);
      clear();
      const p = place;
      if (!p) {
        controller.notify();
        return;
      }
      // A plain tap on a bare circle takes its radius (the way a radius is chosen in the first place).
      if (p.kind === 'curve' && p.circle && !wasDrag) {
        captureRadius(controller, p.host);
        controller.notify();
        return;
      }
      const centre: PointRef = p.kind === 'point' ? refFromHit(p.hit) : refAt(p.at);
      if (circleExists(doc, centre, radius)) {
        showToast('Already drawn');
        controller.notify();
        return;
      }
      if (p.kind === 'point') confirmSnap(controller, p.hit);
      controller.commit((d) => {
        // A centre on a line or curve becomes a point there only now, as the circle is made.
        const centreId = centre.kind === 'free' ? addOrReuseFreePoint(d, centre.at) : materializeRef(d, centre);
        addCircleWithExactRadius(d, centreId, radius);
      });
      controller.notify();
    },
    onCancel() {
      hold.cancel();
      clear();
      controller.notify();
    },
  };
}
