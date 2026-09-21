// Phase 5: Repeat's single always-on manipulation tool — no dock, no tool switching. A
// single-finger touch either drags a lattice-arm handle (redefining that translation), drags the
// rotation ring (redefining the motif's base rotation), or does nothing (Repeat has no
// construction gestures — item 11: two-finger input is already claimed by pan/zoom upstream in
// PointerManager, so everything reaching here is genuinely single-finger).

import type { Vec2 } from '../../model/types.ts';
import type { AppController, ViewTransform } from '../../app/controller.ts';
import { screenToWorld, worldToScreen } from '../../app/controller.ts';
import { motifRadius, snapContact, snapRotation } from '../../geometry/lattice.ts';
import { dist } from '../../geometry/vec.ts';
import type { Gesture, ToolModule } from './types.ts';

const HANDLE_HIT_RADIUS = 26; // px — generous, these are the only two draggable points
const RING_HIT_BAND = 22; // px either side of the ring's own radius

function dragHandleGesture(controller: AppController, view: ViewTransform, dir: 'a' | 'b'): Gesture {
  const pivot = controller.doc.frame.origin;
  function rawTranslateAt(sp: Vec2): Vec2 {
    const w = screenToWorld(view, sp);
    return { x: w.x - pivot.x, y: w.y - pivot.y };
  }
  return {
    onMove(sp) {
      controller.repeatDrag = { dir, rawTranslate: rawTranslateAt(sp) };
      controller.notifyView();
    },
    onUp(sp, wasDrag) {
      controller.repeatDrag = null;
      if (!wasDrag) {
        controller.notify();
        return;
      }
      const raw = rawTranslateAt(sp);
      const snapped = snapContact(controller.doc, raw) ?? raw;
      controller.commit((d) => {
        d.repeat[dir] = snapped;
      });
    },
    onCancel() {
      controller.repeatDrag = null;
      controller.notify();
    },
  };
}

function rotateRingGesture(controller: AppController, view: ViewTransform): Gesture {
  const pivot = controller.doc.frame.origin;
  function angleAt(sp: Vec2): number {
    const centre = worldToScreen(view, pivot);
    return Math.atan2(sp.y - centre.y, sp.x - centre.x) + Math.PI / 2;
  }
  return {
    onMove(sp) {
      controller.repeatRotateDrag = { rawRotation: snapRotation(angleAt(sp)) };
      controller.notifyView();
    },
    onUp(sp, wasDrag) {
      controller.repeatRotateDrag = null;
      if (!wasDrag) {
        controller.notify();
        return;
      }
      const rotation = snapRotation(angleAt(sp));
      controller.commit((d) => {
        d.repeat.motif = { ...d.repeat.motif, rotation };
      });
    },
    onCancel() {
      controller.repeatRotateDrag = null;
      controller.notify();
    },
  };
}

export const repeatTool: ToolModule = {
  id: 'select', // never looked up by id — main.ts routes to this tool directly for the Repeat workspace
  hint() {
    return 'Drag a neighbour to set spacing, or the ring to rotate';
  },
  beginGesture(controller, view, screenPos): Gesture | null {
    if (!controller.doc.repeatGuide) return null; // handles are only reachable while Guide is on
    const doc = controller.doc;
    const pivot = doc.frame.origin;

    for (const dir of ['a', 'b'] as const) {
      const vec = doc.repeat[dir];
      const anchorScreen = worldToScreen(view, { x: pivot.x + vec.x, y: pivot.y + vec.y });
      if (dist(screenPos, anchorScreen) <= HANDLE_HIT_RADIUS) return dragHandleGesture(controller, view, dir);
    }

    const centreScreen = worldToScreen(view, pivot);
    const ringRadius = motifRadius(doc) * view.zoom + 26;
    if (Math.abs(dist(screenPos, centreScreen) - ringRadius) <= RING_HIT_BAND) return rotateRingGesture(controller, view);

    return null;
  },
};
