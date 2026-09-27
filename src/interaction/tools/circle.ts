// Circle tool, spec §4.2 + the radius model (§3), Point Targets per Phase 3.4. Phase 5.2 item 17:
// two modes — Set radius (centre, then a point or drag that fixes the radius; the radius is then
// remembered) and Same radius (the remembered radius, placed at each new centre). The remembered
// radius is shared with Arc (doc.toolPrefs.lastRadius).

import { addCircleEntity, addCircleWithRadius, addOnCurvePoint, addOrReuseFreePoint } from '../../model/doc.ts';
import type { AppController, IncircleLine, ViewTransform } from '../../app/controller.ts';
import { screenToWorld } from '../../app/controller.ts';
import { dist } from '../../geometry/vec.ts';
import { curveCandidatesAt, isNearAnyCurve } from '../hittest.ts';
import { deriveSelectableGroups, groupContainingParam } from '../../geometry/segments.ts';
import { incircleOfLines, type InfiniteLine } from '../../geometry/incircle.ts';
import { buildNodeInset } from '../nodeinset.ts';
import { confirmSnap, noPointGesture, PointHold, resolveTap, showNoPoint, SnapTracker } from '../snap.ts';
import { materializeRef, refAt, refFromHit, refLocation, type PointRef } from '../pointref.ts';
import { showToast } from '../../ui/toast.ts';
import type { Doc } from '../../model/types.ts';
import { resolveEntityGeom, epsilon } from '../../geometry/kernel.ts';
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

/** Same radius: press on a centre, see the circle, slide to another centre if needed, release to
 * place it. Nothing under the finger at release means nothing is created. */
function sameRadiusGesture(controller: AppController, view: ViewTransform, screenPos: { x: number; y: number }, radius: number): Gesture | null {
  const doc = controller.doc;
  const tracker = new SnapTracker(doc);
  let centre = tracker.pick(view, screenPos);
  if (!centre) return tracker.noPoint ? noPointGesture(controller, tracker.noPoint) : null;
  const show = () => {
    controller.preview = centre ? { kind: 'circle', centre: centre.at, through: { x: centre.at.x + radius, y: centre.at.y } } : null;
    controller.notifyView();
  };
  show();
  const hold = new PointHold(controller, view, tracker, screenPos);
  return {
    onMove(sp) {
      const held = hold.move(sp);
      if (held !== undefined) {
        centre = held;
        show();
        return;
      }
      if (hold.open) return;
      centre = tracker.pick(view, sp);
      controller.nodeInset = centre ? buildNodeInset(doc, view, sp, centre.at, tracker) : null;
      show();
    },
    onUp(_sp, wasDrag) {
      const held = hold.release();
      if (held) centre = held;
      const hit = centre;
      controller.preview = null;
      controller.nodeInset = null;
      if (!hit) {
        controller.notify();
        return;
      }
      const place = (h: NonNullable<typeof hit>) => {
        if (circleExists(doc, refFromHit(h), radius)) {
          showToast('Already drawn');
          controller.notify();
          return;
        }
        controller.commit((d) => {
          addCircleWithRadius(d, materializeRef(d, refFromHit(h)), radius);
        });
      };
      if (wasDrag || held) {
        confirmSnap(controller, hit);
        place(hit);
      } else resolveTap(controller, tracker, hit, place);
    },
    onCancel() {
      hold.cancel();
      controller.preview = null;
      controller.nodeInset = null;
      controller.notify();
    },
  };
}

export const circleTool: ToolModule = {
  id: 'circle',
  hint(controller) {
    if (controller.circleVariant === 'three-lines') return incirclePrompt(controller);
    if (controller.pending?.kind === 'circle') {
      return controller.pointLockHint ? 'Point Targets · choose an existing point' : 'Drag to set the radius, or tap a point';
    }
    return 'Tap a point or a curve';
  },
  beginGesture(controller, view, screenPos): Gesture | null {
    if (controller.circleVariant === 'three-lines') return threeLinesGesture(controller, view);
    const doc = controller.doc;
    const remembered = doc.toolPrefs.lastRadius;
    if (doc.toolPrefs.circleMode === 'same' && remembered) return sameRadiusGesture(controller, view, screenPos, remembered);

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

// ---- Phase 5.12b: Between 3 Lines — the circle inscribed in the triangle three lines form ----
//
// Each tap chooses one line: the whole infinite line takes part in the geometry, but only the
// local piece that was tapped is highlighted (Phase 5.10 — a tap never lights up a whole line).
// Tapping a chosen piece again removes it; with three chosen, a new line replaces the most recent
// choice, so an invalid set can be corrected without starting over. The geometry always uses the
// lines in a fixed order, so the order they were chosen in never changes the circle.

const TRIANGLE_PROBLEM = 'These three lines do not form a triangle';
const MIN_RADIUS_EPS = 20;
const ORDINALS = ['first', 'second', 'third'];

function emptyIncircle(): NonNullable<AppController['incircle']> {
  return { lines: [], result: null, problem: null };
}

/** The chosen lines in a fixed order (by entity id), independent of the order they were tapped. */
function canonicalLines(lines: IncircleLine[]): IncircleLine[] {
  return [...lines].sort((p, q) => (p.entityId < q.entityId ? -1 : p.entityId > q.entityId ? 1 : 0));
}

function infiniteLine(doc: Doc, entityId: string): InfiniteLine | null {
  const e = doc.entities.find((x) => x.id === entityId);
  if (!e || e.kind !== 'line') return null;
  const g = resolveEntityGeom(doc, e);
  return g.kind === 'line' ? { a: g.a, b: g.b } : null;
}

/** Recomputes the circle for the lines chosen so far (only three give one). */
export function recomputeIncircle(controller: AppController): void {
  const st = controller.incircle;
  if (!st) return;
  st.result = null;
  st.problem = null;
  if (st.lines.length < 3) return;
  const lines = canonicalLines(st.lines).map((l) => infiniteLine(controller.doc, l.entityId));
  if (lines.some((l) => !l)) {
    st.problem = TRIANGLE_PROBLEM;
    return;
  }
  // Smaller than this and its centre and tangency points would merge into each other (the model
  // merges points closer than epsilon), so it could not be built as a true tangent circle.
  const r = incircleOfLines(lines as [InfiniteLine, InfiniteLine, InfiniteLine], epsilon(controller.doc) * MIN_RADIUS_EPS);
  if (r.ok) st.result = r.circle;
  else st.problem = r.reason === 'same-line' ? 'Two of these are the same line' : TRIANGLE_PROBLEM;
}

export function incirclePrompt(controller: AppController): string {
  const st = controller.incircle;
  const n = st?.lines.length ?? 0;
  if (st?.problem) return n === 3 ? `${st.problem} · tap a chosen line to swap it` : st.problem;
  if (n === 0) return 'Select first line';
  if (n < 3) return `${n} of 3 · Select ${ORDINALS[n]} line`;
  return '3 of 3';
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/** A tap chooses (or un-chooses) the line under the finger; a drag does nothing. */
function threeLinesGesture(controller: AppController, view: ViewTransform): Gesture {
  return {
    onMove() {},
    onUp(sp, wasDrag) {
      if (wasDrag) return;
      const doc = controller.doc;
      const prev = controller.incircle ?? emptyIncircle();
      const near = curveCandidatesAt(doc, view, sp);
      const hit = near.find((h) => h.entity.kind === 'line');
      if (!hit) {
        // With three lines already chosen, a stray tap changes nothing; before that, say what's wanted.
        if (prev.lines.length === 3) return;
        controller.incircle = { lines: prev.lines, result: null, problem: near.length > 0 ? 'Choose a straight line' : 'Tap a line' };
        controller.notify();
        return;
      }
      const group = groupContainingParam(deriveSelectableGroups(doc, hit.entity), hit.param, false);
      const pick: IncircleLine = { entityId: hit.entity.id, keys: group ? group.segments.map((s) => s.key) : [] };
      const lines = [...prev.lines];
      const i = lines.findIndex((l) => l.entityId === pick.entityId);
      if (i >= 0) {
        // The same line again: tapping its chosen piece removes it; another piece just moves the mark.
        if (sameKeys(lines[i]!.keys, pick.keys)) lines.splice(i, 1);
        else lines[i] = pick;
      } else if (lines.length < 3) lines.push(pick);
      else lines[2] = pick;
      controller.incircle = { lines, result: null, problem: null };
      recomputeIncircle(controller);
      controller.notify();
    },
    onCancel() {},
  };
}

/** Commits the previewed circle as one undoable step: its centre (an existing point if one is
 * already there) and a through-point at the exact tangency on the first line (in fixed order);
 * the other two tangencies are materialized like any other crossing. */
export function createIncircle(controller: AppController): void {
  const st = controller.incircle;
  const c = st?.result;
  if (!st || !c) return;
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
  const first = canonicalLines(st.lines)[0]!;
  controller.commit((d) => {
    const centre = addOrReuseFreePoint(d, c.centre);
    const through = addOnCurvePoint(d, first.entityId, c.params[0], c.feet[0]);
    addCircleEntity(d, centre, through);
  });
  controller.incircle = emptyIncircle();
  controller.notify();
}

export function cancelIncircle(controller: AppController): void {
  controller.incircle = emptyIncircle();
  controller.notify();
}
