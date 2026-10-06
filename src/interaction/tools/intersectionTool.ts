// Intersection's single always-on tool: every construction can be moved and turned on its own.
// One finger on a construction drags it (and selects it); on the selected construction's ring it
// turns it about its own centre — with Repeat's rotation ring feel and snapping to the same nice
// fractions of a turn. A tap selects; a tap on empty canvas clears the selection. Two fingers are
// pan/zoom, as everywhere (claimed upstream in PointerManager). Each move or turn is one Undo step.

import type { Vec2 } from '../../model/types.ts';
import type { AppController, ViewTransform } from '../../app/controller.ts';
import { worldToScreen } from '../../app/controller.ts';
import { motifRadius, snapRotation } from '../../geometry/lattice.ts';
import { dist } from '../../geometry/vec.ts';
import { intersectionCopies, layoutOf, placedAt, withLayout, type IntersectionCopy } from '../../geometry/intersection.ts';
import { ringRadius } from '../../render/intersectionRenderer.ts';
import type { Gesture, ToolModule } from './types.ts';

const RING_HIT_BAND = 22; // px either side of the ring's own radius, as Repeat's
const DRAG_SLOP_PX = 6; // as Repeat: a press that stays within this moves nothing

function centreOf(controller: AppController, view: ViewTransform, copy: IntersectionCopy): Vec2 {
  const pivot = controller.doc.frame.origin;
  return worldToScreen(view, { x: pivot.x + copy.pose.translate.x, y: pivot.y + copy.pose.translate.y });
}

function commitPlacement(controller: AppController, key: string, at: Vec2, rotation: number): void {
  controller.commit((d) => {
    d.intersection = withLayout(d, placedAt(layoutOf(d), key, at, rotation));
  });
}

function moveGesture(controller: AppController, view: ViewTransform, copy: IntersectionCopy, down: Vec2): Gesture {
  const start = copy.pose.translate;
  let moving = false;
  return {
    onMove(sp) {
      if (!moving && dist(sp, down) <= DRAG_SLOP_PX) return;
      moving = true;
      controller.intersectionDrag = { key: copy.key, x: start.x + (sp.x - down.x) / view.zoom, y: start.y + (sp.y - down.y) / view.zoom, rotation: copy.pose.rotation, mode: 'move' };
      controller.notifyView();
    },
    onUp() {
      const drag = controller.intersectionDrag;
      controller.intersectionDrag = null;
      if (moving && drag) commitPlacement(controller, copy.key, { x: drag.x, y: drag.y }, drag.rotation);
      else controller.notify();
    },
    onCancel() {
      controller.intersectionDrag = null;
      controller.notify();
    },
  };
}

function turnGesture(controller: AppController, view: ViewTransform, copy: IntersectionCopy, down: Vec2): Gesture {
  const centre = centreOf(controller, view, copy);
  const angleAt = (sp: Vec2) => Math.atan2(sp.y - centre.y, sp.x - centre.x) + Math.PI / 2;
  let moving = false;
  return {
    onMove(sp) {
      if (!moving && dist(sp, down) <= DRAG_SLOP_PX) return;
      moving = true;
      controller.intersectionDrag = { key: copy.key, x: copy.pose.translate.x, y: copy.pose.translate.y, rotation: snapRotation(angleAt(sp)), mode: 'turn' };
      controller.notifyView();
    },
    onUp() {
      // As Repeat's ring: keep the rotation shown at release, never one recomputed from pointerup.
      const drag = controller.intersectionDrag;
      controller.intersectionDrag = null;
      if (moving && drag && drag.rotation !== copy.pose.rotation) commitPlacement(controller, copy.key, copy.pose.translate, drag.rotation);
      else controller.notify();
    },
    onCancel() {
      controller.intersectionDrag = null;
      controller.notify();
    },
  };
}

export const intersectionTool: ToolModule = {
  id: 'select', // never looked up by id — main.ts routes to this tool directly for Intersection
  hint() {
    return 'Drag a construction to move it, or its ring to turn it';
  },
  beginGesture(controller, view, sp): Gesture | null {
    const copies = intersectionCopies(controller.doc);
    // The selected construction's ring first: it lies outside every frame it could be confused with.
    const selected = copies.find((c) => c.key === controller.intersectionSelected);
    if (selected && Math.abs(dist(sp, centreOf(controller, view, selected)) - ringRadius(controller.doc, view)) <= RING_HIT_BAND) {
      return turnGesture(controller, view, selected, sp);
    }
    // Otherwise the construction whose centre is nearest, among those whose frame the finger is on.
    const reach = motifRadius(controller.doc) * view.zoom;
    let hit: IntersectionCopy | null = null;
    let best = Infinity;
    for (const c of copies) {
      const d = dist(sp, centreOf(controller, view, c));
      if (d <= reach && d < best) {
        best = d;
        hit = c;
      }
    }
    if (hit) {
      controller.intersectionSelected = hit.key;
      controller.notifyView();
      return moveGesture(controller, view, hit, sp);
    }
    // Empty canvas: a tap clears the selection.
    return {
      onMove() {},
      onUp(_sp, wasDrag) {
        if (wasDrag || !controller.intersectionSelected) return;
        controller.intersectionSelected = null;
        controller.notifyView();
      },
      onCancel() {},
    };
  },
};
