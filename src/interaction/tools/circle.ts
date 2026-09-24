// Circle tool, spec §4.2 + the radius model (§3), Point Targets per Phase 3.4. Phase 5.2 item 17:
// two modes — Set radius (centre, then a point or drag that fixes the radius; the radius is then
// remembered) and Same radius (the remembered radius, placed at each new centre). The remembered
// radius is shared with Arc (doc.toolPrefs.lastRadius).

import { addCircleEntity, addCircleWithRadius } from '../../model/doc.ts';
import type { AppController, ViewTransform } from '../../app/controller.ts';
import { screenToWorld } from '../../app/controller.ts';
import { dist } from '../../geometry/vec.ts';
import { isNearAnyCurve, pickPointTarget } from '../hittest.ts';
import { buildNodeInset } from '../nodeinset.ts';
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
  let centre = pickPointTarget(doc, view, screenPos);
  if (!centre) return null;
  const show = () => {
    controller.preview = centre ? { kind: 'circle', centre: centre.at, through: { x: centre.at.x + radius, y: centre.at.y } } : null;
    controller.notifyView();
  };
  show();
  return {
    onMove(sp) {
      centre = pickPointTarget(doc, view, sp);
      controller.nodeInset = centre ? buildNodeInset(doc, view, sp, centre.at) : null;
      show();
    },
    onUp() {
      const hit = centre;
      controller.preview = null;
      controller.nodeInset = null;
      if (!hit) {
        controller.notify();
        return;
      }
      if (circleExists(doc, refFromHit(hit), radius)) {
        showToast('Already drawn');
        controller.notify();
        return;
      }
      controller.commit((d) => {
        addCircleWithRadius(d, materializeRef(d, refFromHit(hit)), radius);
      });
    },
    onCancel() {
      controller.preview = null;
      controller.nodeInset = null;
      controller.notify();
    },
  };
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
    const remembered = doc.toolPrefs.lastRadius;
    if (doc.toolPrefs.circleMode === 'same' && remembered) return sameRadiusGesture(controller, view, screenPos, remembered);

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
        const hit = pickPointTarget(doc, view, sp);
        const through = hit ? hit.at : screenToWorld(view, sp);
        controller.preview = { kind: 'circle', centre: centreAt, through };
        controller.nodeInset = hit ? buildNodeInset(doc, view, sp, hit.at) : null;
        const lockedOut = !doc.pointTargets.free && !hit && isNearAnyCurve(doc, view, sp);
        const transitioned = lockedOut !== controller.pointLockHint;
        controller.pointLockHint = lockedOut;
        // Rendering-only update, except when the Point Targets hint itself just changed.
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
          // Touched a curve with no eligible point there — no point is planted, and the centre
          // stays armed for a fresh attempt.
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
        controller.cancelPending();
      },
    };
  },
};
