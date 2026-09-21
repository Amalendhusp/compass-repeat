// Circle tool, spec §4.2 + the radius model (§3), Point Lock per Phase 1.2a.

import { addCircleEntity } from '../../model/doc.ts';
import { screenToWorld } from '../../app/controller.ts';
import { isNearAnyCurve, pickPointTarget } from '../hittest.ts';
import { buildNodeInset } from '../nodeinset.ts';
import { materializeRef, refAt, refFromHit, refLocation, type PointRef } from '../pointref.ts';
import type { Gesture, ToolModule } from './types.ts';

function sameExisting(a: PointRef, b: PointRef): boolean {
  return a.kind === 'existing' && b.kind === 'existing' && a.id === b.id;
}

export const circleTool: ToolModule = {
  id: 'circle',
  hint(controller) {
    if (controller.pending?.kind === 'circle') {
      return controller.pointLockHint ? 'Point Targets · choose an existing point' : 'Drag to set the radius, or tap a point';
    }
    return 'Tap a point or a curve';
  },
  beginGesture(controller, view, screenPos): Gesture | null {
    const doc = controller.doc;
    let centreRef: PointRef;
    // True only while THIS gesture is the one still choosing the centre (down → first move/up).
    // Used solely to decide what a plain tap-without-drag means in onUp below. It must never
    // gate onCancel: per Phase 1.1 item 3, once pending.centre is set — even by this same
    // still-active gesture — a second finger must not be able to undo it.
    let justSetCentre = false;

    if (controller.pending?.kind === 'circle') {
      centreRef = controller.pending.centre;
    } else {
      const hit = pickPointTarget(doc, view, screenPos);
      if (!hit) return null;
      centreRef = refFromHit(hit);
      controller.pending = { kind: 'circle', centre: centreRef };
      justSetCentre = true;
    }

    const centreAt = refLocation(doc, centreRef);
    controller.preview = { kind: 'circle', centre: centreAt, through: centreAt };
    controller.notify();

    const finish = (throughRef: PointRef) => {
      if (sameExisting(centreRef, throughRef)) {
        controller.pending = null;
        controller.preview = null;
        controller.nodeInset = null;
        controller.notify();
        return;
      }
      controller.commit((d) => {
        const centreId = materializeRef(d, centreRef);
        const throughId = materializeRef(d, throughRef);
        if (centreId !== throughId) addCircleEntity(d, centreId, throughId);
      });
      controller.pending = null;
      controller.preview = null;
      controller.nodeInset = null;
      controller.pointLockHint = false;
      controller.notify();
    };

    return {
      onMove(sp) {
        const hit = pickPointTarget(doc, view, sp);
        const through = hit ? hit.at : screenToWorld(view, sp);
        controller.preview = { kind: 'circle', centre: centreAt, through };
        controller.nodeInset = hit ? buildNodeInset(doc, view, sp, hit.at) : null;
        const lockedOut = !doc.pointTargets.free && !hit && isNearAnyCurve(doc, view, sp);
        const transitioned = lockedOut !== controller.pointLockHint;
        controller.pointLockHint = lockedOut;
        // Rendering-only update — the context bar already reflects "preview exists" from the
        // notify() above, so a cheap view-channel notify is enough for per-pixel drag updates
        // (§Phase 1.1 item 2), except when the Point Lock hint itself just changed, which the
        // context bar does need to pick up.
        if (transitioned) controller.notify();
        else controller.notifyView();
      },
      onUp(sp, wasDrag) {
        if (!wasDrag && justSetCentre) {
          // First tap only planted the centre; wait for the next tap or drag.
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
          // Point Lock item 2: touched a curve with no explicit point there — not even a free
          // point is planted, and the anchor stays armed for a fresh attempt.
          controller.preview = { kind: 'circle', centre: centreAt, through: centreAt };
          controller.nodeInset = null;
          controller.pointLockHint = true;
          controller.notify();
          return;
        }
        if (wasDrag) {
          // Radius model: a drag released in truly empty space (not on any curve) still
          // creates a free point — Point Lock only governs curve projections.
          finish(refAt(screenToWorld(view, sp)));
        } else {
          // §1.3: a tap-miss on a later step cancels back to waiting for a fresh anchor.
          controller.cancelPending();
        }
      },
      onCancel() {
        // Phase 3.2 item 4: a second finger (pinch/pan) cancels the pending centre outright —
        // superseding Phase 1.1 item 3's "preserve the anchor" behaviour, no longer wanted now
        // that the node inset exists. Tool stays active; the next tap is a fresh centre. No
        // geometry is created or committed here.
        controller.cancelPending();
      },
    };
  },
};
