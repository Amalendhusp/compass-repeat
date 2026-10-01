// Select tool, spec §1.2 / §4.9. Phase 5.2: no filter row — what gets selected follows from what
// the finger touches and how:
// - tap a point → that point. Tap a curve (Phase 5.10, progressive scope — each tap on the same
//   spot widens it, so a broad selection is always deliberate):
//     1st → the one SEGMENT under the finger (between the two split points around the tap)
//     2nd → its RUN — the visually continuous stretch (Phase 5.9: through crossings, same style)
//     3rd → the WHOLE shape; 4th → nothing.
//   Driven by what is CURRENTLY selected, never by tap timing. The segment under a finger that is
//   still down is highlighted before release. Tap inside a closed region → that region's whole
//   boundary; tap empty → clear.
// - press and hold: on a crowded cluster of points → the precision loupe (slide, release); inside a
//   region → start collecting regions of that same type (item 11).
// - drag across curves → collect every segment crossed, of the first one's type (item 12).
// - while a point is being edited (Move/Rebind, items 13–15), gestures belong to that edit.

import type { Doc, Entity, Vec2 } from '../../model/types.ts';
import type { AppController, SelectCandidate, ViewTransform } from '../../app/controller.ts';
import { screenToWorld, worldToScreen } from '../../app/controller.ts';
import { projectOntoEntity, resolveEntityGeom, resolvePoint } from '../../geometry/kernel.ts';
import { deriveSegments, deriveSelectableGroups, groupContainingParam, type DerivedSegment } from '../../geometry/segments.ts';
import { dist } from '../../geometry/vec.ts';
import { isUniformlyFair, pickCurveHit, pickPointTarget, pickRegionAt, pickSelectCandidates, segmentContainingParam } from '../hittest.ts';
import { ambiguousCandidates, closePrecision, movePrecision, openPrecision } from '../precision.ts';
import { materializeRef, refFromHit, type PointRef } from '../pointref.ts';
import { mergePointInto, moveFreePoint, rebindEndpoint, slideOnCurvePoint } from '../../model/doc.ts';
import type { Gesture, ToolModule } from './types.ts';

const DRAG_START_PX = 12; // matches PointerManager's tap tolerance — below this a touch is a tap
const HOLD_MS = 350; // §2/§5.4: press-then-slide opens the precision loupe on a point cluster
const LONG_PRESS_MS = 450; // item 11: the one deliberate long-press — multi-region selection
const SWEEP_SAMPLE_PX = 6;
const DEPENDENT_PICK_PX = 28;
const POINT_AIMED_PX = 4; // a Select tap this close to a point means the point (lines are crossed every few px)

type SegmentCandidate = Extract<SelectCandidate, { kind: 'segment' }>;
type RegionCandidate = Extract<SelectCandidate, { kind: 'region' }>;

function sameSegment(a: SelectCandidate, b: SelectCandidate): boolean {
  return a.kind === 'segment' && b.kind === 'segment' && a.entityId === b.entityId && a.from === b.from && a.to === b.to;
}

function candidateCovers(parent: SelectCandidate, entityId: string): boolean {
  return (parent.kind === 'entity' && parent.entityId === entityId) || (parent.kind === 'group' && parent.entityIds.includes(entityId));
}

const sameKeys = (a: SegmentCandidate, b: SegmentCandidate) => a.keys.length === b.keys.length && a.keys.every((k) => b.keys.includes(k));

/** Phase 5.10: nothing → segment → run → whole shape → nothing, for the curve nearest the tap. */
function tapCurve(controller: AppController, view: ViewTransform, sp: Vec2, tiers: SelectCandidate[]): void {
  const first = tiers[0]!;
  const entityId = first.kind === 'segment' ? first.entityId : first.kind === 'entity' ? first.entityId : first.kind === 'group' ? first.entityIds[0]! : '';
  const segment: SegmentCandidate | null = first.kind === 'segment' ? { ...first, scope: 'segment' } : null;
  const hit = pickCurveHit(controller.doc, view, sp);
  const vr = hit && hit.entity.id === entityId ? visualRun(controller.doc, hit.entity, hit.param) : { run: null, whole: false };
  let run: SegmentCandidate | null = vr.run ? { ...vr.run, scope: 'run' } : null;
  if (run && segment && sameKeys(run, segment)) run = null; // nothing wider to show at this step
  const parent = tiers.find((t) => (t.kind === 'entity' || t.kind === 'group') && candidateCovers(t, entityId)) ?? null;
  const current = controller.selection.length === 1 ? controller.selection[0]! : null;
  const coversTap = (c: SelectCandidate) => c.kind === 'segment' && !!segment && c.entityId === entityId && segment.keys.every((k) => c.keys.includes(k));

  if (current?.kind === 'segment' && current.scope !== 'run' && segment && sameSegment(current, segment)) {
    controller.select(run ? [run] : parent ? [parent] : []);
    return;
  }
  if (current?.kind === 'segment' && current.scope === 'run' && coversTap(current)) {
    controller.select(parent ? [parent] : []);
    return;
  }
  if (current && parent && (current.kind === 'entity' || current.kind === 'group') && candidateCovers(current, entityId)) {
    controller.select([]);
    return;
  }
  controller.select([segment ?? run ?? parent ?? first]);
}

function toggleRegion(controller: AppController, region: RegionCandidate): void {
  const rest = controller.selection.filter((c) => !(c.kind === 'region' && c.sig === region.sig));
  const next = rest.length === controller.selection.length ? [...controller.selection, region] : rest;
  if (next.length === 0) controller.multiRegion = null;
  controller.select(next);
}

// ---- Phase 5.9: what the eye sees as one run ----

/** A piece's visual "kind" for grouping: Fair, trimmed (a gap), or construction on a given side of
 * an Extension line's own span (its tails read as different from its span). */
function runStyle(doc: Doc, entity: Entity, s: DerivedSegment): string {
  const st = doc.segmentStates.get(s.key)?.state;
  if (st === 'trimmed') return 'gap';
  if (st === 'fair') return 'fair';
  if (entity.kind === 'line' && entity.extended) {
    const mid = (s.fromParam + s.toParam) / 2;
    return mid < -1e-9 ? 'tail-' : mid > 1 + 1e-9 ? 'tail+' : 'span';
  }
  return 'construction';
}

function asCandidate(entity: Entity, pieces: DerivedSegment[]): SegmentCandidate {
  const first = pieces[0]!;
  const last = pieces[pieces.length - 1]!;
  return { kind: 'segment', entityId: entity.id, from: first.from, to: last.to, fromParam: first.fromParam, toParam: last.toParam, keys: pieces.map((p) => p.key) };
}

/**
 * The visually continuous run through the piece at `param`: neighbouring pieces of the same style
 * on the same curve, through every crossing (a crossing is not a break the eye sees). Null when
 * the run is the whole shape — then the shape itself is the natural first selection.
 */
function visualRun(doc: Doc, entity: Entity, param: number): { run: SegmentCandidate | null; whole: boolean } {
  const segs = deriveSegments(doc, entity);
  const isCircle = entity.kind === 'circle';
  const seed = segmentContainingParam(segs, param, isCircle);
  if (!seed) return { run: null, whole: false };
  const style = runStyle(doc, entity, seed);
  if (style === 'gap') return { run: null, whole: false };
  const i0 = segs.findIndex((s) => s.key === seed.key);
  const n = segs.length;
  const same = (i: number) => runStyle(doc, entity, segs[i]!) === style;
  let lo = i0;
  let hi = i0;
  if (isCircle) {
    let count = 1;
    while (count < n && same((hi + 1) % n)) {
      hi = (hi + 1) % n;
      count++;
    }
    if (count === n) return { run: null, whole: true };
    while (same((lo - 1 + n) % n)) lo = (lo - 1 + n) % n;
    const pieces: DerivedSegment[] = [];
    for (let i = lo; ; i = (i + 1) % n) {
      pieces.push(segs[i]!);
      if (i === hi) break;
    }
    return { run: asCandidate(entity, pieces), whole: false };
  }
  while (hi + 1 < n && same(hi + 1)) hi++;
  while (lo - 1 >= 0 && same(lo - 1)) lo--;
  const whole = lo === 0 && hi === n - 1;
  return { run: whole ? null : asCandidate(entity, segs.slice(lo, hi + 1)), whole };
}

/** The segment under `sp` — the selectable group between the split points around it. */
function segmentCandidateAt(doc: Doc, view: ViewTransform, sp: Vec2): SegmentCandidate | null {
  const hit = pickCurveHit(doc, view, sp);
  if (!hit) return null;
  const group = groupContainingParam(deriveSelectableGroups(doc, hit.entity), hit.param, hit.entity.kind === 'circle');
  if (!group) return null;
  return { ...asCandidate(hit.entity, group.segments), scope: 'segment' };
}

/** Phase 5.2 item 12: drag across segments — the first one crossed fixes the type (Fair or
 * Construction) for the whole gesture; the other type is ignored until the finger lifts. */
function beginSweep(controller: AppController, view: ViewTransform, start: Vec2) {
  const collected: SegmentCandidate[] = [];
  let type: boolean | null = null; // true = Fair
  let last = start;
  const visit = (sp: Vec2) => {
    const cand = segmentCandidateAt(controller.doc, view, sp);
    if (!cand) return;
    const fair = isUniformlyFair(controller.doc, cand.keys);
    if (type === null) type = fair;
    if (fair !== type || collected.some((c) => sameSegment(c, cand))) return;
    collected.push(cand);
  };
  visit(start);
  controller.sweep = [start];
  return {
    move(sp: Vec2) {
      const steps = Math.max(1, Math.ceil(dist(last, sp) / SWEEP_SAMPLE_PX));
      for (let i = 1; i <= steps; i++) visit({ x: last.x + ((sp.x - last.x) * i) / steps, y: last.y + ((sp.y - last.y) * i) / steps });
      last = sp;
      controller.sweep!.push(sp);
      controller.selection = [...collected];
      controller.notifyView();
    },
    finish() {
      controller.sweep = null;
      controller.multiRegion = null;
      controller.select([...collected]);
    },
  };
}

/** The dependent construction whose curve passes closest to the tap — how the participant picks
 * WHICH of several constructions sharing a point should be re-anchored (item 15). */
function pickDependent(controller: AppController, view: ViewTransform, sp: Vec2) {
  const edit = controller.pointEdit!;
  const doc = controller.doc;
  const world = screenToWorld(view, sp);
  let best: (typeof edit.dependents)[number] | null = null;
  let bestPx = DEPENDENT_PICK_PX;
  for (const dep of edit.dependents) {
    const entity = doc.entities.find((e) => e.id === dep.entityId);
    if (!entity) continue;
    const px = distanceToEntityPx(doc, view, entity, world);
    if (px < bestPx) {
      bestPx = px;
      best = dep;
    }
  }
  return best;
}

function distanceToEntityPx(doc: Doc, view: ViewTransform, entity: Entity, world: Vec2): number {
  const g = resolveEntityGeom(doc, entity);
  if (g.kind === 'circle') return projectOntoEntity(doc, entity, world).d * view.zoom;
  const abx = g.b.x - g.a.x;
  const aby = g.b.y - g.a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((world.x - g.a.x) * abx + (world.y - g.a.y) * aby) / len2));
  return Math.hypot(world.x - (g.a.x + abx * t), world.y - (g.a.y + aby * t)) * view.zoom;
}

/**
 * Phase 5.2 items 13–15. The drag is relative (the point follows the finger's movement rather
 * than jumping under it, so the fingertip never hides the thing being placed).
 * - move: a hand-placed point moves freely; dropped onto another point, it merges into it.
 * - slide: an on-curve point (an Arc's end, say) moves along its own curve.
 * - rebind: the chosen dependent's end follows the finger and must land on a real target.
 */
function pointEditGesture(controller: AppController, view: ViewTransform, downScreen: Vec2): Gesture {
  const doc = controller.doc;
  const edit = controller.pointEdit!;
  const origin = worldToScreen(view, resolvePoint(doc, edit.pointId));
  let dragging = false;
  let target: PointRef | null = null;
  let snappedId: string | null = null;

  const exclude = new Set<string>([edit.pointId]);
  if (edit.mode === 'rebind' && edit.chosen) {
    const e = doc.entities.find((x) => x.id === edit.chosen!.entityId);
    if (e?.kind === 'line') exclude.add(edit.chosen.role === 'a' ? e.b : e.a);
    if (e?.kind === 'circle') exclude.add(edit.chosen.role === 'centre' ? e.through : e.centre);
  }

  return {
    onMove(sp) {
      if (!dragging && dist(sp, downScreen) <= DRAG_START_PX) return;
      if (edit.mode === 'rebind' && !edit.chosen) return;
      dragging = true;
      const moved = { x: origin.x + sp.x - downScreen.x, y: origin.y + sp.y - downScreen.y };
      target = null;
      snappedId = null;
      if (edit.mode === 'slide') {
        const p = doc.points.find((pt) => pt.id === edit.pointId);
        const host = p?.kind === 'on-curve' ? doc.entities.find((e) => e.id === p.host) : undefined;
        if (host) edit.drag = { at: projectOntoEntity(doc, host, screenToWorld(view, moved)).point, snapped: false };
      } else {
        const hit = pickPointTarget(doc, view, moved, { exclude, explicitOnly: edit.mode === 'move' });
        if (hit) {
          target = refFromHit(hit);
          snappedId = hit.id;
        }
        edit.drag = { at: hit ? hit.at : screenToWorld(view, moved), snapped: !!hit };
      }
      controller.notifyView();
    },
    onUp(sp, wasDrag) {
      if (!dragging || !wasDrag) {
        // A plain tap: in rebind with several candidates, it chooses which construction to move;
        // anywhere else it simply ends point editing.
        if (edit.mode === 'rebind' && !edit.chosen) {
          const dep = pickDependent(controller, view, sp);
          if (dep) {
            edit.chosen = dep;
            controller.notify();
            return;
          }
        }
        controller.pointEdit = null;
        controller.notify();
        return;
      }
      const drag = edit.drag;
      edit.drag = null;
      if (!drag) {
        controller.notify();
        return;
      }
      const pointId = edit.pointId;
      if (edit.mode === 'move') {
        const into = snappedId;
        controller.commit((d) => (into ? mergePointInto(d, pointId, into) : moveFreePoint(d, pointId, drag.at)));
        controller.pointEdit = null;
        controller.select([{ kind: 'point', id: into ?? pointId }]);
        return;
      }
      if (edit.mode === 'slide') {
        const p = doc.points.find((pt) => pt.id === pointId);
        const host = p?.kind === 'on-curve' ? doc.entities.find((e) => e.id === p.host) : undefined;
        if (host) {
          const param = projectOntoEntity(doc, host, drag.at).param;
          controller.commit((d) => slideOnCurvePoint(d, pointId, host.kind === 'circle' ? ((param % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) : Math.max(0, Math.min(1, param))));
        }
        controller.pointEdit = null;
        controller.select([{ kind: 'point', id: pointId }]);
        return;
      }
      // rebind: only a real target re-anchors anything; a drop in empty space changes nothing.
      const chosen = edit.chosen;
      const ref = target;
      if (!chosen || !ref) {
        controller.notify();
        return;
      }
      controller.commit((d) => rebindEndpoint(d, chosen, materializeRef(d, ref)));
      controller.pointEdit = null;
      controller.select([{ kind: 'point', id: pointId }]);
    },
    onCancel() {
      edit.drag = null;
      controller.notify();
    },
  };
}

function mergePickGesture(controller: AppController, view: ViewTransform): Gesture {
  const sourceId = controller.pendingMerge!.sourceId;
  return {
    onMove() {},
    onUp(sp, wasDrag) {
      if (wasDrag) return;
      const pointCand = pickSelectCandidates(controller.doc, view, sp).find((c) => c.kind === 'point');
      controller.pendingMerge = null;
      if (pointCand?.kind === 'point' && pointCand.id !== sourceId) {
        controller.commit((d) => mergePointInto(d, sourceId, pointCand.id));
        controller.select([{ kind: 'point', id: pointCand.id }]);
        return;
      }
      controller.notify(); // a miss simply stops choosing a destination
    },
    onCancel() {
      controller.pendingMerge = null;
      controller.notify();
    },
  };
}

export const selectTool: ToolModule = {
  id: 'select',
  hint() {
    return '';
  },
  beginGesture(controller, view, screenPos): Gesture {
    if (controller.pendingMerge) return mergePickGesture(controller, view);
    if (controller.pointEdit) return pointEditGesture(controller, view, screenPos);

    const doc = controller.doc;
    const downWorld = screenToWorld(view, screenPos);
    let sweep: ReturnType<typeof beginSweep> | null = null;
    let longPressed = false;

    // §2H: a press on a tight cluster of explicit points opens the precision loupe; any other
    // press held still is the deliberate multi-region long-press.
    const ambiguous = ambiguousCandidates(doc, view, screenPos);
    // Phase 5.10: while the finger is down on a curve, emphasise the one segment a tap would take
    // (unless it is aimed at a point) — so at a dense crossing it is visible before release.
    {
      const pc = pickSelectCandidates(doc, view, screenPos).find((c) => c.kind === 'point');
      const pdist = pc?.kind === 'point' ? dist(worldToScreen(view, resolvePoint(doc, pc.id)), screenPos) : Infinity;
      const ch = pickCurveHit(doc, view, screenPos);
      const seg = ch && !(pdist <= POINT_AIMED_PX && pdist <= ch.d + 1.5) && !controller.multiRegion ? segmentCandidateAt(doc, view, screenPos) : null;
      controller.pressHighlight = seg ? seg.keys : null;
      if (seg) controller.notifyView();
    }
    const clearPress = () => {
      if (!controller.pressHighlight) return;
      controller.pressHighlight = null;
      controller.notifyView();
    };
    let holdTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => {
        holdTimer = null;
        // Held on a crowded cluster of points (aimed at the points, or no line there) → the loupe.
        const curveHere = pickCurveHit(doc, view, screenPos);
        const nearestPt = ambiguous ? Math.min(...ambiguous.map((a) => dist(worldToScreen(view, a.at), screenPos))) : Infinity;
        if (ambiguous && (!curveHere || (nearestPt <= POINT_AIMED_PX && nearestPt <= curveHere.d + 1.5))) {
          clearPress();
          openPrecision(controller, view, ambiguous, screenPos);
          return;
        }
        const region = pickRegionAt(doc, downWorld);
        if (!region) return;
        clearPress();
        longPressed = true;
        controller.multiRegion = { fair: region.fair };
        controller.select([region]);
        if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(10);
      },
      ambiguous ? HOLD_MS : LONG_PRESS_MS,
    );
    const clearHold = () => {
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = null;
    };

    return {
      onMove(sp) {
        if (controller.precision) {
          movePrecision(controller, view, sp);
          return;
        }
        if (dist(sp, screenPos) <= DRAG_START_PX && !sweep) return;
        clearPress();
        clearHold();
        if (longPressed) return;
        if (!sweep) sweep = beginSweep(controller, view, screenPos);
        sweep.move(sp);
      },
      onUp(sp, wasDrag) {
        clearHold();
        controller.pressHighlight = null;
        if (controller.precision) {
          const chosen = closePrecision(controller, true);
          controller.select(chosen && chosen.ref.kind === 'existing' ? [{ kind: 'point', id: chosen.ref.id }] : []);
          return;
        }
        if (longPressed) return;
        if (sweep) {
          sweep.finish();
          return;
        }
        if (wasDrag) return;

        const world = screenToWorld(view, sp);
        const candidates = pickSelectCandidates(doc, view, sp);

        if (controller.multiRegion) {
          const region = pickRegionAt(doc, world, controller.multiRegion.fair);
          if (region) {
            toggleRegion(controller, region);
            return;
          }
          controller.multiRegion = null;
          if (candidates.length === 0 && !pickRegionAt(doc, world)) {
            controller.select([]);
            return;
          }
        }

        // Phase 5.9: in a dense drawing a point is almost always within reach — so a tap means the
        // point only when it was aimed at the point itself, or when there is no line under the
        // finger. Otherwise the line (its visible run) is what was meant.
        const pointCand = candidates.find((c) => c.kind === 'point');
        const pd = pointCand?.kind === 'point' ? dist(worldToScreen(view, resolvePoint(doc, pointCand.id)), sp) : Infinity;
        const curve = pickCurveHit(doc, view, sp);
        const point = pointCand && (!curve || (pd <= POINT_AIMED_PX && pd <= curve.d + 1.5)) ? pointCand : undefined;
        if (point && point.kind === 'point') {
          const already = controller.selection.length === 1 && controller.selection[0]!.kind === 'point' && controller.selection[0]!.id === point.id;
          controller.select(already ? [] : [point]);
          return;
        }
        const curveTiers = candidates.filter((c) => c.kind === 'segment' || c.kind === 'entity' || c.kind === 'group');
        if (curveTiers.length > 0) {
          tapCurve(controller, view, sp, curveTiers);
          return;
        }
        const region = pickRegionAt(doc, world);
        if (region) {
          const already = controller.selection.length === 1 && controller.selection[0]!.kind === 'region' && controller.selection[0]!.sig === region.sig;
          controller.select(already ? [] : [region]);
          return;
        }
        controller.select([]);
      },
      onCancel() {
        clearHold();
        controller.pressHighlight = null;
        // Two fingers arriving hand off to pinch/pan: an open loupe or a half-finished sweep is
        // abandoned, not committed.
        if (controller.precision) closePrecision(controller, false);
        if (sweep) {
          controller.sweep = null;
          controller.selection = [];
        }
        controller.notify();
      },
    };
  },
};
