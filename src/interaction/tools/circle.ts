// Circle tool, spec §4.2 + the radius model (§3), Point Targets per Phase 3.4. Phase 5.2 item 17:
// two modes — Set radius (centre, then a point or drag that fixes the radius; the radius is then
// remembered) and Same radius (the remembered radius, placed at each new centre). The remembered
// radius is shared with Arc (doc.toolPrefs.lastRadius).

import { addCircleEntity, addCircleWithRadius } from '../../model/doc.ts';
import type { AppController, ViewTransform } from '../../app/controller.ts';
import { screenToWorld } from '../../app/controller.ts';
import { dist } from '../../geometry/vec.ts';
import { isNearAnyCurve } from '../hittest.ts';
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
    if (controller.pending?.kind === 'circle') {
      return controller.pointLockHint ? 'Point Targets · choose an existing point' : 'Drag to set the radius, or tap a point';
    }
    return 'Tap a point or a curve';
  },
  beginGesture(controller, view, screenPos): Gesture | null {
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
