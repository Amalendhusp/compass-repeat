// Select tool, spec §1.2 / §4.9, extended per Phase 1.2 items 3–4: Point → Segment → whole
// Entity cycling on repeated taps, and a marquee drag for multi-selection. Never constructs.
// Phase 3.1 item 4: the marquee also picks out individual derived segments (not just whole
// untouched entities) — required to multi-select several Fair pieces of the same split circle
// or line without needing to select each one separately.

import type { Doc, Entity, Vec2 } from '../../model/types.ts';
import type { AppController, SelectCandidate, ViewTransform } from '../../app/controller.ts';
import { worldToScreen } from '../../app/controller.ts';
import { resolveEntityGeom, resolvePoint } from '../../geometry/kernel.ts';
import { deriveSelectableGroups, type DerivedSegment } from '../../geometry/segments.ts';
import { isPointOrphanedByTrim } from '../../geometry/usage.ts';
import { dist } from '../../geometry/vec.ts';
import { entityMatchesFilter, entityScreenBounds, groupMatchesFilter, pickSelectCandidates, pointMatchesFilter } from '../hittest.ts';
import { ambiguousCandidates, closePrecision, movePrecision, openPrecision } from '../precision.ts';
import { mergePoint } from '../../model/doc.ts';
import type { Gesture, ToolModule } from './types.ts';

const CYCLE_DIST = 10; // pt, §5.4
const CYCLE_TIME_MS = 1500; // §5.4
const HOLD_MS = 350; // §2/§5.4: "press ≥350ms then slide" opens the precision loupe
const HOLD_MOVE_TOLERANCE = 8; // px of travel before the hold fires that cancels it (becomes a drag)
const DOUBLE_TAP_TIME_MS = 350; // Phase 2.3: a real double-tap, not the slower cycle window
const DOUBLE_TAP_DIST = 10; // pt

/**
 * Phase 3.6 item 5: repeated taps at (roughly) the same screen location, on the same underlying
 * entity, step through a fixed cycle — nothing → local Segment → parent Entity → nothing — rather
 * than the old generic "Point · 1/4"-style walk through every stacked candidate. `index` is the
 * position just shown: 0 = Segment, 1 = Entity/Group, and (tierCount) itself = deselected: the
 * next matching tap always advances `(index + 1) % (tierCount + 1)`, so a deselect naturally
 * rolls back around to Segment. Module-level: selectTool is a singleton, so this persists across
 * separate tap gestures — exactly what "repeated tap at the same location" needs to track. Points
 * never enter this cycle — a tap that lands on an explicit point always resolves directly.
 */
let lastCycleTap: { screen: Vec2; time: number; entityId: string; index: number } | null = null;
/** Phase 2.3: the segment (if any) the most recent tap resolved to, and when/where — a second
 * tap on the SAME segment within the double-tap window escalates straight to its parent entity
 * or group, taking priority over the ordinary cycle. */
let lastSegmentSelect: { entityId: string; from: string; to: string; screen: Vec2; time: number } | null = null;

function normalizeRect(a: Vec2, b: Vec2): { minX: number; minY: number; maxX: number; maxY: number } {
  return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
}

function pointInRect(p: Vec2, r: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  return p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;
}

function rectContains(outer: { minX: number; minY: number; maxX: number; maxY: number }, inner: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

const SEGMENT_MARQUEE_SAMPLES = 8;

/** Sampled screen-space points along one derived segment's actual curve (line or arc piece),
 * for marquee containment — a segment isn't a rectangle, so "fully inside" is approximated by
 * every sample landing inside, same spirit as entityScreenBounds' whole-curve bbox check. */
function segmentSamplesScreen(doc: Doc, view: ViewTransform, entity: Entity, seg: DerivedSegment): Vec2[] {
  const g = resolveEntityGeom(doc, entity);
  const pts: Vec2[] = [];
  let toParam = seg.toParam;
  if (g.kind === 'circle' && toParam < seg.fromParam) toParam += Math.PI * 2;
  for (let i = 0; i <= SEGMENT_MARQUEE_SAMPLES; i++) {
    const t = seg.fromParam + (toParam - seg.fromParam) * (i / SEGMENT_MARQUEE_SAMPLES);
    const at = g.kind === 'circle' ? { x: g.centre.x + Math.cos(t) * g.radius, y: g.centre.y + Math.sin(t) * g.radius } : { x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t };
    pts.push(worldToScreen(view, at));
  }
  return pts;
}

function finishMarquee(controller: AppController, view: ViewTransform, start: Vec2, end: Vec2): void {
  const doc = controller.doc;
  const filter = controller.selectFilter;
  const rect = normalizeRect(start, end);
  const selected: SelectCandidate[] = [];
  for (const p of doc.points) {
    if (p.kind === 'free' && p.hidden) continue;
    if (isPointOrphanedByTrim(doc, p.id)) continue;
    if (!pointMatchesFilter(doc, p.id, filter)) continue;
    const s = worldToScreen(view, resolvePoint(doc, p.id));
    if (pointInRect(s, rect)) selected.push({ kind: 'point', id: p.id });
  }
  // Phase 3.7 item 5: under the Fair/Construction filters, segments/entities are the whole point
  // of the marquee (a dense construction's grey lines must never sneak into a Fair-only drag) —
  // under Points, none of them are reachable at all, matching pickSelectCandidates exactly.
  if (filter === 'points') {
    controller.marquee = null;
    lastCycleTap = null;
    lastSegmentSelect = null;
    controller.select(selected);
    return;
  }
  for (const e of doc.entities) {
    // Phase 3.6 item 4: marquee picks out the same coarser SelectableGroup units as a tap does,
    // not raw granular pieces — a group with Derived targets off shouldn't require the marquee to
    // fully enclose every tiny midpoint-bounded fragment individually.
    const groups = deriveSelectableGroups(doc, e);
    if (groups.length <= 1) {
      // Untouched (or one single group spanning the whole entity) — the existing whole-entity
      // bbox test applies.
      if (!entityMatchesFilter(doc, e, filter)) continue;
      const bounds = entityScreenBounds(doc, view, e);
      if (bounds && rectContains(rect, bounds)) selected.push({ kind: 'entity', entityId: e.id });
      continue;
    }
    for (const group of groups) {
      if (!groupMatchesFilter(doc, group, filter)) continue;
      const samples = group.segments.flatMap((seg) => segmentSamplesScreen(doc, view, e, seg));
      if (samples.every((s) => pointInRect(s, rect))) {
        selected.push({ kind: 'segment', entityId: e.id, from: group.from, to: group.to, fromParam: group.fromParam, toParam: group.toParam, keys: group.segments.map((s) => s.key) });
      }
    }
  }
  controller.marquee = null;
  lastCycleTap = null;
  lastSegmentSelect = null;
  controller.select(selected);
}

export const selectTool: ToolModule = {
  id: 'select',
  hint() {
    return 'Tap a point, segment or shape to inspect it';
  },
  beginGesture(controller, view, screenPos): Gesture {
    const doc = controller.doc;

    // Phase 3.5 item 3: "Merge into…" is armed — the next tap picks the destination, a much
    // simpler gesture than ordinary Select (no marquee, no precision loupe, no cycling) so
    // there's no ambiguity about what a tap here means.
    if (controller.pendingMerge) {
      const sourceId = controller.pendingMerge.sourceId;
      return {
        onMove() {
          // No live preview — picking a destination is a plain tap, not a drag.
        },
        onUp(sp, wasDrag) {
          if (wasDrag) return;
          const candidates = pickSelectCandidates(doc, view, sp);
          const pointCand = candidates.find((c) => c.kind === 'point');
          if (pointCand && pointCand.kind === 'point' && pointCand.id !== sourceId) {
            controller.commit((d) => mergePoint(d, sourceId, pointCand.id));
            controller.pendingMerge = null;
            controller.select([{ kind: 'point', id: pointCand.id }]);
          }
          // A miss, or tapping the source again, leaves it armed — the Cancel chip is the only
          // other way out (see shell.ts's renderSelectActions).
        },
        onCancel() {
          // A second finger (pinch/pan) abandons the pending merge outright rather than trying
          // to preserve it across a view gesture — nothing was committed either way.
          controller.pendingMerge = null;
          controller.notify();
        },
      };
    }

    const candidatesAtDown = pickSelectCandidates(doc, view, screenPos, controller.selectFilter);
    const startedEmpty = candidatesAtDown.length === 0;

    // §2H: a tap landing on a tight cluster of explicit points arms a hold timer; if the finger
    // hasn't moved (or lifted) by HOLD_MS, the precision loupe opens instead of an ordinary tap.
    const ambiguous = ambiguousCandidates(doc, view, screenPos);
    let holdTimer: ReturnType<typeof setTimeout> | null = ambiguous
      ? setTimeout(() => {
          holdTimer = null;
          openPrecision(controller, ambiguous, screenPos);
        }, HOLD_MS)
      : null;
    function clearHold(): void {
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    }

    return {
      onMove(sp) {
        if (controller.precision) {
          movePrecision(controller, view, sp);
          return;
        }
        if (holdTimer !== null && Math.hypot(sp.x - screenPos.x, sp.y - screenPos.y) > HOLD_MOVE_TOLERANCE) clearHold();
        if (!startedEmpty) return;
        // Item 4: a single-finger drag beginning on empty canvas is a marquee, not a pan.
        controller.marquee = { start: screenPos, current: sp };
        controller.notifyView();
      },
      onUp(sp, wasDrag) {
        clearHold();
        if (controller.precision) {
          const chosen = closePrecision(controller, true);
          controller.marquee = null;
          lastCycleTap = null;
          lastSegmentSelect = null;
          if (chosen && chosen.ref.kind === 'existing') controller.select([{ kind: 'point', id: chosen.ref.id }]);
          else controller.select([]);
          return;
        }
        if (startedEmpty && wasDrag) {
          finishMarquee(controller, view, screenPos, sp);
          return;
        }
        controller.marquee = null;
        if (wasDrag) return; // a drag that started on a hit target: no point-dragging in v1 (§12.3)

        const candidates = pickSelectCandidates(doc, view, sp, controller.selectFilter);
        if (candidates.length === 0) {
          lastCycleTap = null;
          lastSegmentSelect = null;
          controller.select([]);
          return;
        }

        // Phase 3.6 item 5: a direct hit on an explicit point always resolves immediately — points
        // are never part of the Segment/Entity cycle.
        const pointHere = candidates.find((c) => c.kind === 'point');
        if (pointHere) {
          lastCycleTap = null;
          lastSegmentSelect = null;
          controller.select([pointHere]);
          return;
        }

        // Phase 4 item 8: a filled region resolves directly too, but only as a FALLBACK — a tap
        // near a boundary curve must still be able to reach that curve's own Segment/Entity (to
        // edit the Fair geometry itself), so fill only wins when nothing curve-shaped is close.
        const curveTiers = candidates.filter((c): c is Extract<SelectCandidate, { kind: 'segment' | 'entity' | 'group' }> => c.kind === 'segment' || c.kind === 'entity' || c.kind === 'group');
        const fillHere = candidates.find((c) => c.kind === 'fill');
        if (curveTiers.length === 0 && fillHere) {
          lastCycleTap = null;
          lastSegmentSelect = null;
          controller.select([fillHere]);
          return;
        }

        // Phase 2.3: double-tap escalation — a second tap on the very segment the previous tap
        // just selected, within the double-tap window, jumps straight to that segment's parent
        // entity/group instead of the ordinary cycle. Checked first, so it always wins when both
        // could apply.
        const segHere = curveTiers.find((c) => c.kind === 'segment');
        if (
          segHere &&
          lastSegmentSelect &&
          lastSegmentSelect.entityId === segHere.entityId &&
          lastSegmentSelect.from === segHere.from &&
          lastSegmentSelect.to === segHere.to &&
          dist(sp, lastSegmentSelect.screen) <= DOUBLE_TAP_DIST &&
          Date.now() - lastSegmentSelect.time <= DOUBLE_TAP_TIME_MS
        ) {
          const parent = curveTiers.find(
            (c) => (c.kind === 'entity' && c.entityId === segHere.entityId) || (c.kind === 'group' && c.entityIds.includes(segHere.entityId)),
          );
          lastCycleTap = null;
          lastSegmentSelect = null;
          controller.select([parent ?? segHere]);
          return;
        }

        // Phase 3.6 item 5: the simplified fixed cycle — nothing → local Segment → parent Entity
        // (or Group) → nothing — scoped to the nearest entity at this tap only, not the whole
        // candidate stack across every overlapping curve.
        const localTiers = curveTiers.slice(0, 2);
        if (localTiers.length === 0) {
          lastCycleTap = null;
          lastSegmentSelect = null;
          controller.select([]);
          return;
        }
        const first = localTiers[0]!;
        const key = first.kind === 'group' ? first.entityIds[0]! : first.entityId;
        let index = 0;
        if (lastCycleTap && lastCycleTap.entityId === key && dist(sp, lastCycleTap.screen) <= CYCLE_DIST && Date.now() - lastCycleTap.time <= CYCLE_TIME_MS) {
          index = (lastCycleTap.index + 1) % (localTiers.length + 1);
        }
        lastCycleTap = { screen: sp, time: Date.now(), entityId: key, index };
        if (index >= localTiers.length) {
          lastSegmentSelect = null;
          controller.select([]);
          return;
        }
        const chosen = localTiers[index]!;
        lastSegmentSelect = chosen.kind === 'segment' ? { entityId: chosen.entityId, from: chosen.from, to: chosen.to, screen: sp, time: Date.now() } : null;
        controller.select([chosen]);
      },
      onCancel() {
        clearHold();
        // Item 4: two fingers arriving mid-drag hands off to pinch/pan — the marquee-in-progress
        // is abandoned, not committed. §2H: an open precision session is likewise abandoned.
        if (controller.precision) closePrecision(controller, false);
        controller.marquee = null;
        controller.notify();
      },
    };
  },
};
