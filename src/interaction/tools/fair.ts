// Fair tool — Phase 3 (spec §4.7), Phase 3.4: a promotion/design tool, never a geometry-creation
// one — it only ever converts already-existing Construction/Extension segments to Fair (and back),
// never materializes a new primitive line. Tap (≤6px travel) toggles one segment. A drag traces a
// connected chain, extending or retracting Fair state through junctions by direction — never by
// connectivity alone (§4.7's whole point, especially at degree-≥6 rosette junctions).

import type { Doc, Entity, SegmentKey, SegmentState, Vec2 } from '../../model/types.ts';
import type { AppController, FairTraceState, ViewTransform } from '../../app/controller.ts';
import { worldToScreen } from '../../app/controller.ts';
import { resolvePoint } from '../../geometry/kernel.ts';
import { deriveSegments, deriveSelectableGroups, groupContainingParam, segmentKey, type DerivedSegment } from '../../geometry/segments.ts';
import { angleBetween, otherEndpoint, outgoingTangent, segmentsAtJunction, type JunctionCandidate } from '../../geometry/trace.ts';
import { dist } from '../../geometry/vec.ts';
import { pickCurveHit, segmentContainingParam } from '../hittest.ts';
import type { Gesture, ToolModule } from './types.ts';

const TAP_TRAVEL_PX = 6; // spec §4.7: "Tap (≤ 6 px travel)"
const JUNCTION_ZONE_PX = 16;
const LOOKAHEAD_PX = 24;
const COMMIT_MAX_ANGLE = 35;
const COMMIT_MARGIN = 12;
const RUNNER_UP_SHOW_ANGLE = 20;
const HEADING_ALPHA = 0.35;
const BACKTRACK_ANGLE = 150;
const RESUME_HIT_PX = 16;

interface ChainLink {
  key: SegmentKey;
  seg: DerivedSegment;
  exitJunction: string;
  entryHeadingScreen: Vec2;
}

function fairStateFor(controller: AppController): SegmentState {
  return { state: 'fair', stroke: { ...controller.doc.fairDefaults } };
}

/** Phase 3.4 item 1: "demote it back to its previous non-Fair state" — an Extension line's
 * segment reverts to Extension (derived from its parent entity's own `extended` flag, the one
 * authoritative fact, rather than tracking a separate "previous state"), everything else reverts
 * to the implicit default by clearing the entry (= 'construction'). Mirrors model/doc.ts's
 * setSegmentFair, which the tap-only path (no active trace) still goes through directly. */
function revertState(controller: AppController, entityId: string): SegmentState | null {
  const entity = controller.doc.entities.find((e) => e.id === entityId);
  return entity?.kind === 'line' && entity.extended ? { state: 'extension' } : null;
}

function selectableGroupHere(doc: Doc, entity: Entity, param: number) {
  const groups = deriveSelectableGroups(doc, entity);
  return groupContainingParam(groups, param, entity.kind === 'circle');
}

function beginFairTraceGesture(controller: AppController, view: ViewTransform, screenPos: Vec2): Gesture | null {
  const doc = controller.doc;
  const hit = pickCurveHit(doc, view, screenPos);
  if (!hit) return null;
  const { entity } = hit;

  if (entity.locked && !doc.frame.designEnabled) {
    // Phase 3.6 item 7: locked only protects destructive edits (Trim/Delete) — Fair must still be
    // able to select/highlight a frame segment so the context band can offer "Use frame in
    // design", the one valid action on it while it's outside the design.
    return {
      onMove() {},
      onUp(sp, wasDrag) {
        if (wasDrag) return;
        const reHit = pickCurveHit(doc, view, sp) ?? hit;
        const group = selectableGroupHere(doc, reHit.entity, reHit.param);
        if (group) {
          controller.select([{ kind: 'segment', entityId: group.entityId, from: group.from, to: group.to, fromParam: group.fromParam, toParam: group.toParam, keys: group.segments.map((s) => s.key) }]);
        } else {
          controller.select([{ kind: 'entity', entityId: reHit.entity.id }]);
        }
      },
      onCancel() {
        controller.notify();
      },
    };
  }

  // Phase 3.6 item 4: the tap-only case (never extended into a drag) must promote/demote the
  // whole SelectableGroup as one unit, not just the one granular piece under the finger — segment
  // STATE STORAGE stays granular (see geometry/segments.ts), so every piece in the group is seeded
  // into `draft` up front; if the gesture never becomes a drag, this is exactly what commits.
  const group = selectableGroupHere(doc, entity, hit.param);
  const seg = segmentContainingParam(deriveSegments(doc, entity), hit.param, entity.kind === 'circle');
  if (!seg) return null;

  const key = segmentKey(entity.id, seg.from, seg.to);
  const fairing = (doc.segmentStates.get(key)?.state ?? 'construction') !== 'fair';

  const draft = new Map<SegmentKey, SegmentState | null>();
  const originalStates = new Map<SegmentKey, SegmentState | undefined>();
  for (const groupSeg of group?.segments ?? [seg]) {
    const k = segmentKey(entity.id, groupSeg.from, groupSeg.to);
    originalStates.set(k, doc.segmentStates.get(k));
    draft.set(k, fairing ? fairStateFor(controller) : revertState(controller, entity.id));
  }

  const chain: ChainLink[] = [];
  let headingScreen: Vec2 | null = null;
  let lastScreenPos = screenPos;
  let travel = 0;
  let lookaheadTravel = 0;
  let paused = false;
  let hasLeftPausedZone = false;
  let leaderKey: SegmentKey | null = null;
  let runnerUpKey: SegmentKey | null = null;
  // Phase 3.1 items 1/5/6: the segments actually competing at the junction currently under the
  // finger — feeds both `relevantPointsNow` (item 1: show only their endpoints, not every point
  // the trace passes near) and the node inset (item 6: local geometry at a dense junction).
  let currentJunctionCandidates: JunctionCandidate[] = [];

  function relevantPointsNow(): Set<string> {
    const pts = new Set<string>();
    if (chain.length === 0) {
      pts.add(seg!.from);
      pts.add(seg!.to);
    } else {
      const first = chain[0]!;
      pts.add(otherEndpoint(first.seg, first.exitJunction));
      pts.add(chain[chain.length - 1]!.exitJunction);
    }
    for (const c of currentJunctionCandidates) {
      pts.add(c.seg.from);
      pts.add(c.seg.to);
    }
    return pts;
  }

  function publish(): void {
    const state: FairTraceState = {
      draft: new Map(draft),
      preview: leaderKey ? { leaderKey, runnerUpKey } : null,
      relevantPoints: relevantPointsNow(),
    };
    controller.fairTrace = state;
    controller.notifyView();
  }
  publish();

  function endpointScreen(pointId: string): Vec2 {
    return worldToScreen(view, resolvePoint(doc, pointId));
  }

  function markTouched(entityId: string, s: DerivedSegment): SegmentKey {
    const k = segmentKey(entityId, s.from, s.to);
    if (!originalStates.has(k)) originalStates.set(k, doc.segmentStates.get(k));
    draft.set(k, fairing ? fairStateFor(controller) : revertState(controller, entityId));
    return k;
  }

  function commitOnto(cand: JunctionCandidate, fromJunction: string, heading: Vec2): void {
    const k = markTouched(cand.entity.id, cand.seg);
    const newExit = otherEndpoint(cand.seg, fromJunction);
    chain.push({ key: k, seg: cand.seg, exitJunction: newExit, entryHeadingScreen: heading });
    lookaheadTravel = 0;
    leaderKey = null;
    runnerUpKey = null;
    paused = false;
    currentJunctionCandidates = [];
    controller.nodeInset = null;
    publish();
  }

  function tryResume(sp: Vec2): boolean {
    // §4.7 step 6: "resumes if the finger re-enters any segment's 16pt hit band within 16pt
    // of that segment's endpoint." Endpoint proximity alone isn't enough to pick ONE candidate
    // when several segments share that endpoint (exactly the paused-junction case) — the whole
    // point of pausing was that position alone couldn't disambiguate them. So resume scores by
    // direction too, same as an ordinary junction commit: among the segments near enough to an
    // endpoint, take the one whose tangent best matches where the finger is now heading, and
    // only if that's a plausible direction at all (a looser bar than the normal 35° commit,
    // since resuming is already a deliberate re-entry, not a fast-moving pass-through).
    if (!headingScreen) return false;
    let best: { entityId: string; seg: DerivedSegment; endpointId: string; angle: number } | null = null;
    for (const e of doc.entities) {
      if (e.locked && !doc.frame.designEnabled) continue;
      for (const s of deriveSegments(doc, e)) {
        const k = segmentKey(e.id, s.from, s.to);
        if (draft.has(k)) continue;
        const state = doc.segmentStates.get(k)?.state ?? 'construction';
        if (state === 'trimmed') continue;
        for (const endpointId of [s.from, s.to]) {
          if (dist(sp, endpointScreen(endpointId)) > RESUME_HIT_PX) continue;
          const tangentWorld = outgoingTangent(doc, e, s, endpointId);
          const p0 = endpointScreen(endpointId);
          const p1 = worldToScreen(view, { x: resolvePoint(doc, endpointId).x + tangentWorld.x, y: resolvePoint(doc, endpointId).y + tangentWorld.y });
          const angle = angleBetween(headingScreen, { x: p1.x - p0.x, y: p1.y - p0.y });
          if (angle <= COMMIT_MAX_ANGLE * 1.5 && (!best || angle < best.angle)) best = { entityId: e.id, seg: s, endpointId, angle };
        }
      }
    }
    if (!best) return false;
    const newKey = markTouched(best.entityId, best.seg);
    chain.push({ key: newKey, seg: best.seg, exitJunction: otherEndpoint(best.seg, best.endpointId), entryHeadingScreen: headingScreen });
    lookaheadTravel = 0;
    paused = false;
    currentJunctionCandidates = [];
    controller.nodeInset = null;
    publish();
    return true;
  }

  function updateHeading(delta: Vec2): void {
    const len = Math.hypot(delta.x, delta.y);
    if (len < 0.01) return;
    headingScreen = headingScreen
      ? { x: headingScreen.x * (1 - HEADING_ALPHA) + delta.x * HEADING_ALPHA, y: headingScreen.y * (1 - HEADING_ALPHA) + delta.y * HEADING_ALPHA }
      : delta;
  }

  function checkBacktrack(): void {
    if (chain.length === 0 || !headingScreen) return;
    const last = chain[chain.length - 1]!;
    if (angleBetween(headingScreen, last.entryHeadingScreen) <= BACKTRACK_ANGLE) return;
    // Phase 3E: reverse over the segment just processed — restore it, not toggle it again.
    const orig = originalStates.get(last.key);
    if (orig) draft.set(last.key, orig);
    else draft.delete(last.key);
    chain.pop();
    leaderKey = null;
    runnerUpKey = null;
    lookaheadTravel = 0;
    paused = false;
    currentJunctionCandidates = [];
    controller.nodeInset = null;
    publish();
  }

  return {
    onMove(sp) {
      const delta = { x: sp.x - lastScreenPos.x, y: sp.y - lastScreenPos.y };
      travel += Math.hypot(delta.x, delta.y);
      updateHeading(delta);
      lastScreenPos = sp;

      if (chain.length === 0) {
        // Still on the first segment: determine which endpoint we're heading toward once
        // travel is unambiguous (past the tap threshold).
        if (travel <= TAP_TRAVEL_PX || !headingScreen) return;
        const fromDir = { x: endpointScreen(seg.from).x - screenPos.x, y: endpointScreen(seg.from).y - screenPos.y };
        const toDir = { x: endpointScreen(seg.to).x - screenPos.x, y: endpointScreen(seg.to).y - screenPos.y };
        const exit = angleBetween(headingScreen, fromDir) < angleBetween(headingScreen, toDir) ? seg.from : seg.to;
        chain.push({ key, seg, exitJunction: exit, entryHeadingScreen: headingScreen });
        publish();
        return;
      }

      if (!headingScreen) return;
      const last = chain[chain.length - 1]!;

      if (paused) {
        // §4.7 step 6: "resumes if the finger RE-ENTERS" — a genuine exit first, not a resume
        // attempt on every sample while the finger never actually left the paused junction's
        // zone (which is exactly what a still-ambiguous heading would otherwise re-trigger).
        if (!hasLeftPausedZone) {
          if (dist(sp, endpointScreen(last.exitJunction)) > JUNCTION_ZONE_PX) hasLeftPausedZone = true;
          else controller.nodeInset = { anchorScreen: sp, activeAt: resolvePoint(doc, last.exitJunction), candidates: [] };
          return;
        }
        if (tryResume(sp)) return;
        controller.nodeInset = { anchorScreen: sp, activeAt: resolvePoint(doc, last.exitJunction), candidates: [] };
        return;
      }

      const junctionScreen = endpointScreen(last.exitJunction);
      const distToJunction = dist(sp, junctionScreen);

      if (distToJunction <= JUNCTION_ZONE_PX) {
        const candidates = segmentsAtJunction(doc, last.exitJunction, last.key, doc.frame.designEnabled);
        currentJunctionCandidates = candidates;
        const scored = candidates
          .map((c) => {
            const tangentWorld = outgoingTangent(doc, c.entity, c.seg, last.exitJunction);
            const p0 = endpointScreen(last.exitJunction);
            const p1 = worldToScreen(view, { x: resolvePoint(doc, last.exitJunction).x + tangentWorld.x, y: resolvePoint(doc, last.exitJunction).y + tangentWorld.y });
            const tangentScreen = { x: p1.x - p0.x, y: p1.y - p0.y };
            return { c, angle: angleBetween(headingScreen!, tangentScreen) };
          })
          .sort((a, b) => a.angle - b.angle);

        const leader = scored[0];
        const runnerUp = scored[1];
        if (leader && leader.angle <= COMMIT_MAX_ANGLE && (!runnerUp || runnerUp.angle - leader.angle >= COMMIT_MARGIN)) {
          commitOnto(leader.c, last.exitJunction, headingScreen);
        } else {
          // Phase 3.1 item 6: more than one plausible branch at this junction — show the node
          // inset (local geometry + the leader/runner-up preview drawn within it) so the finger
          // occluding the junction isn't the only view of what's about to be chosen.
          leaderKey = leader ? segmentKey(leader.c.entity.id, leader.c.seg.from, leader.c.seg.to) : null;
          runnerUpKey = runnerUp && leader && runnerUp.angle - leader.angle < RUNNER_UP_SHOW_ANGLE ? segmentKey(runnerUp.c.entity.id, runnerUp.c.seg.from, runnerUp.c.seg.to) : null;
          controller.nodeInset = candidates.length > 1 ? { anchorScreen: sp, activeAt: resolvePoint(doc, last.exitJunction), candidates: [] } : null;
          lookaheadTravel += Math.hypot(delta.x, delta.y);
          if (lookaheadTravel > LOOKAHEAD_PX) {
            // §4.7 step 6: never guess — stop at the junction.
            paused = true;
            hasLeftPausedZone = false;
            leaderKey = null;
            runnerUpKey = null;
          }
          publish();
        }
      } else if (leaderKey || runnerUpKey || currentJunctionCandidates.length > 0) {
        leaderKey = null;
        runnerUpKey = null;
        lookaheadTravel = 0;
        currentJunctionCandidates = [];
        controller.nodeInset = null;
        publish();
      }

      checkBacktrack();
    },
    onUp() {
      controller.fairTrace = null;
      controller.nodeInset = null;
      let changed = false;
      for (const [k, newState] of draft) {
        const orig = originalStates.get(k) ?? null;
        if (JSON.stringify(orig) !== JSON.stringify(newState)) {
          changed = true;
          break;
        }
      }
      if (changed) {
        controller.commit((d) => {
          for (const [k, newState] of draft) {
            if (newState === null) d.segmentStates.delete(k);
            else d.segmentStates.set(k, newState);
          }
        });
      } else {
        controller.notify();
      }
    },
    onCancel() {
      // §2 arbitration: a second finger cancels an in-progress interaction without committing.
      controller.fairTrace = null;
      controller.nodeInset = null;
      controller.notify();
    },
  };
}

export const fairTool: ToolModule = {
  id: 'fair',
  hint() {
    return 'Tap a segment to Fair it, or drag along a chain';
  },
  beginGesture(controller, view, screenPos): Gesture | null {
    return beginFairTraceGesture(controller, view, screenPos);
  },
};
