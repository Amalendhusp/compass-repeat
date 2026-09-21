// Line tool, spec §4.3, Point Lock per Phase 1.2a. Both endpoints must be point targets —
// unlike Circle's radius, Line has no free-point fallback, so an empty-space release cancels
// the pending step (§1.3) rather than planting a point.
//
// Phase 3.1 item 3: Fair's "Line" sub-mode wants this exact A→B gesture (same Point Lock rules,
// same anchor-survives-pinch/pan behaviour, same node inset) but landing as a Fair segment
// instead of a plain construction line — so the gesture itself is factored out as
// beginLineLikeGesture, parameterised by what "landing" on a committed pair of points means.

import type { Doc, EntityId, PointId } from '../../model/types.ts';
import { addLineEntity } from '../../model/doc.ts';
import type { AppController, ViewTransform } from '../../app/controller.ts';
import { screenToWorld } from '../../app/controller.ts';
import { deriveSegments } from '../../geometry/segments.ts';
import { isNearAnyCurve, pickPointTarget } from '../hittest.ts';
import { buildNodeInset } from '../nodeinset.ts';
import { materializeRef, refFromHit, refLocation, type PointRef } from '../pointref.ts';
import type { Gesture, ToolModule } from './types.ts';

function sameExisting(a: PointRef, b: PointRef): boolean {
  return a.kind === 'existing' && b.kind === 'existing' && a.id === b.id;
}

/** The shared A→B point-to-point gesture. `land` runs inside the commit and decides what the
 * new pair of points becomes (a plain line, or — Fair's Line sub-mode — a line pre-fired as a
 * Fair segment); returning null means "nothing was created" (e.g. A and B coincided). `onLanded`
 * runs after the commit with whatever `land` returned, for tool-specific post-commit UI. */
export function beginLineLikeGesture(
  controller: AppController,
  view: ViewTransform,
  screenPos: { x: number; y: number },
  land: (d: Doc, aId: PointId, bId: PointId) => EntityId | null,
  onLanded?: (newId: EntityId | null) => void,
): Gesture | null {
  const doc = controller.doc;
  let aRef: PointRef;
  // See circle.ts: only gates onUp's tap-vs-plant distinction, never onCancel.
  let justSetA = false;

  if (controller.pending?.kind === 'line') {
    aRef = controller.pending.a;
  } else {
    const hit = pickPointTarget(doc, view, screenPos);
    if (!hit) return null;
    aRef = refFromHit(hit);
    controller.pending = { kind: 'line', a: aRef };
    justSetA = true;
  }

  const aAt = refLocation(doc, aRef);
  controller.preview = { kind: 'line', a: aAt, b: aAt };
  controller.notify();

  const finish = (bRef: PointRef) => {
    if (sameExisting(aRef, bRef)) {
      controller.pending = null;
      controller.preview = null;
      controller.nodeInset = null;
      controller.notify();
      return;
    }
    let newId: EntityId | null = null;
    controller.commit((d) => {
      const aId = materializeRef(d, aRef);
      const bId = materializeRef(d, bRef);
      if (aId !== bId) newId = land(d, aId, bId);
    });
    controller.pending = null;
    controller.preview = null;
    controller.nodeInset = null;
    controller.pointLockHint = false;
    onLanded?.(newId);
    controller.notify();
  };

  return {
    onMove(sp) {
      const hit = pickPointTarget(doc, view, sp);
      const b = hit ? hit.at : screenToWorld(view, sp);
      controller.preview = { kind: 'line', a: aAt, b };
      controller.nodeInset = hit ? buildNodeInset(doc, view, sp, hit.at) : null;
      const lockedOut = !doc.pointTargets.free && !hit && isNearAnyCurve(doc, view, sp);
      const transitioned = lockedOut !== controller.pointLockHint;
      controller.pointLockHint = lockedOut;
      // Rendering-only, except when the lock hint itself changed — see circle.ts's onMove.
      if (transitioned) controller.notify();
      else controller.notifyView();
    },
    onUp(sp, wasDrag) {
      if (!wasDrag && justSetA) {
        controller.preview = null;
        controller.nodeInset = null;
        controller.notify();
        return;
      }
      const hit = pickPointTarget(doc, view, sp);
      if (hit) {
        finish(refFromHit(hit));
        return;
      }
      if (!doc.pointTargets.free && isNearAnyCurve(doc, view, sp)) {
        // Point Lock: touched a curve with no explicit point there — stay armed for a fresh
        // attempt at B rather than cancelling A (§Phase 1.2a acceptance: A survives).
        controller.preview = { kind: 'line', a: aAt, b: aAt };
        controller.nodeInset = null;
        controller.pointLockHint = true;
        controller.notify();
        return;
      }
      // No free-point fallback for Line; empty release/miss cancels the pending step.
      controller.cancelPending();
    },
    onCancel() {
      // Phase 3.2 item 4: a second finger (pinch/pan) now cancels the pending anchor outright —
      // the earlier Phase 1.1 item 3 behaviour (preserve A across a view gesture) is no longer
      // wanted now that the node inset exists to disambiguate a finger-occluded target, so a
      // pinch/pan is free to mean "start over" instead. The tool itself stays active; the next
      // tap after the view gesture is a fresh point A. No geometry is created or committed here.
      controller.cancelPending();
    },
  };
}

export const lineTool: ToolModule = {
  id: 'line',
  hint(controller) {
    if (controller.pending?.kind === 'line') {
      return controller.pointLockHint ? 'Point Targets · choose an existing point' : 'Tap or drag to the second point';
    }
    return 'Tap a point or a curve';
  },
  beginGesture(controller, view, screenPos): Gesture | null {
    return beginLineLikeGesture(
      controller,
      view,
      screenPos,
      // Phase 3.4 item 2: Line only ever creates Construction or Extension geometry, chosen by
      // the context bar's mode toggle before the gesture starts — never Fair (that's Fair's own
      // promotion job, item 1). An Extension line commits already `extended` (drives the existing
      // dashed-tail rendering) AND with every one of its derived segments explicitly marked
      // `state: 'extension'` (dashed/subdued for the between-points span too, not just the
      // tails) — future splits inherit this automatically via segmentstate.ts's existing,
      // state-agnostic migration, the same mechanism Fair state has always relied on.
      (d, aId, bId) => {
        const entity = addLineEntity(d, aId, bId);
        if (controller.lineMode === 'extension' && entity.kind === 'line') {
          entity.extended = true;
          for (const seg of deriveSegments(d, entity)) d.segmentStates.set(seg.key, { state: 'extension' });
        }
        return entity.id;
      },
      (newId) => {
        if (!newId) return;
        const entity = controller.doc.entities.find((e) => e.id === newId);
        if (entity?.kind === 'line' && !entity.extended) {
          controller.setExtendChip(newId);
          setTimeout(() => {
            if (controller.extendChip?.entityId === newId) controller.setExtendChip(null);
          }, 4000);
        }
        // Phase 3.4 item 3: offered for either mode — an Extension line "may later be promoted
        // where appropriate" just as much as a Construction one.
        controller.setFairPromoteChip(newId);
        setTimeout(() => {
          if (controller.fairPromoteChip?.entityId === newId) controller.setFairPromoteChip(null);
        }, 4000);
      },
    );
  },
};
