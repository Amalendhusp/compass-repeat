// Select tool, spec §1.2 / §4.9. Phase 5.2: no filter row — what gets selected follows from what
// the finger touches and how:
// - tap a point → that point; tap a curve → its segment, tap it again → the whole shape, again →
//   nothing (driven by what is CURRENTLY selected, never by tap timing, so it behaves the same on
//   every device); tap inside a closed region → that region's whole boundary; tap empty → clear.
// - long-press inside a region → start collecting regions of that same type (item 11).
// - drag across segments → collect every segment crossed of the first one's type (item 12).
// - while a point is being edited (Move/Rebind, items 13–15), gestures belong to that edit.

import type { Doc, Entity, Vec2 } from '../../model/types.ts';
import type { AppController, SelectCandidate, ViewTransform } from '../../app/controller.ts';
import { screenToWorld, worldToScreen } from '../../app/controller.ts';
import { projectOntoEntity, resolveEntityGeom, resolvePoint } from '../../geometry/kernel.ts';
import { deriveSelectableGroups, groupContainingParam } from '../../geometry/segments.ts';
import { dist } from '../../geometry/vec.ts';
import { isUniformlyFair, pickCurveHit, pickPointTarget, pickRegionAt, pickSelectCandidates } from '../hittest.ts';
import { ambiguousCandidates, closePrecision, movePrecision, openPrecision } from '../precision.ts';
import { materializeRef, refFromHit, type PointRef } from '../pointref.ts';
import { mergePointInto, moveFreePoint, rebindEndpoint, slideOnCurvePoint } from '../../model/doc.ts';
import type { Gesture, ToolModule } from './types.ts';

const DRAG_START_PX = 12; // matches PointerManager's tap tolerance — below this a touch is a tap
const HOLD_MS = 350; // §2/§5.4: press-then-slide opens the precision loupe on a point cluster
const LONG_PRESS_MS = 450; // item 11: the one deliberate long-press — multi-region selection
const SWEEP_SAMPLE_PX = 6;
const DEPENDENT_PICK_PX = 28;

type SegmentCandidate = Extract<SelectCandidate, { kind: 'segment' }>;
type RegionCandidate = Extract<SelectCandidate, { kind: 'region' }>;

function sameSegment(a: SelectCandidate, b: SelectCandidate): boolean {
  return a.kind === 'segment' && b.kind === 'segment' && a.entityId === b.entityId && a.from === b.from && a.to === b.to;
}

function candidateCovers(parent: SelectCandidate, entityId: string): boolean {
  return (parent.kind === 'entity' && parent.entityId === entityId) || (parent.kind === 'group' && parent.entityIds.includes(entityId));
}

/** nothing → Segment → parent shape → nothing, for the curve nearest the tap. */
function tapCurve(controller: AppController, tiers: SelectCandidate[]): void {
  const first = tiers[0]!;
  const entityId = first.kind === 'segment' ? first.entityId : first.kind === 'entity' ? first.entityId : first.kind === 'group' ? first.entityIds[0]! : '';
  const segment = first.kind === 'segment' ? first : null;
  const parent = tiers.find((t) => (t.kind === 'entity' || t.kind === 'group') && candidateCovers(t, entityId)) ?? null;
  const current = controller.selection.length === 1 ? controller.selection[0]! : null;

  if (current && segment && sameSegment(current, segment)) {
    controller.select(parent ? [parent] : []);
    return;
  }
  if (current && parent && (current.kind === 'entity' || current.kind === 'group') && candidateCovers(current, entityId)) {
    controller.select([]);
    return;
  }
  controller.select([segment ?? parent!]);
}

function toggleRegion(controller: AppController, region: RegionCandidate): void {
  const rest = controller.selection.filter((c) => !(c.kind === 'region' && c.sig === region.sig));
  const next = rest.length === controller.selection.length ? [...controller.selection, region] : rest;
  if (next.length === 0) controller.multiRegion = null;
  controller.select(next);
}

function segmentCandidateAt(doc: Doc, view: ViewTransform, sp: Vec2): SegmentCandidate | null {
  const hit = pickCurveHit(doc, view, sp);
  if (!hit) return null;
  const group = groupContainingParam(deriveSelectableGroups(doc, hit.entity), hit.param, hit.entity.kind === 'circle');
  if (!group) return null;
  return { kind: 'segment', entityId: group.entityId, from: group.from, to: group.to, fromParam: group.fromParam, toParam: group.toParam, keys: group.segments.map((s) => s.key) };
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
    let holdTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => {
        holdTimer = null;
        if (ambiguous) {
          openPrecision(controller, ambiguous, screenPos);
          return;
        }
        const region = pickRegionAt(doc, downWorld);
        if (!region) return;
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
        clearHold();
        if (longPressed) return;
        if (!sweep) sweep = beginSweep(controller, view, screenPos);
        sweep.move(sp);
      },
      onUp(sp, wasDrag) {
        clearHold();
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

        const point = candidates.find((c) => c.kind === 'point');
        if (point) {
          const already = controller.selection.length === 1 && controller.selection[0]!.kind === 'point' && controller.selection[0]!.id === point.id;
          controller.select(already ? [] : [point]);
          return;
        }
        const curveTiers = candidates.filter((c) => c.kind === 'segment' || c.kind === 'entity' || c.kind === 'group');
        if (curveTiers.length > 0) {
          tapCurve(controller, curveTiers);
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
