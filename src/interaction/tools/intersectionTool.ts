// Intersection's single always-on tool: every construction can be moved and turned on its own.
// One finger on a construction drags it (and selects it); on the selected construction's ring it
// turns it about its own centre — with Repeat's rotation ring feel and snapping to the same nice
// fractions of a turn. Two fingers are pan/zoom, as everywhere (claimed upstream in PointerManager).
// Each move or turn is one Undo step. Moving is always free: nothing ever pulls a construction.
//
// A tap (a press that never leaves the drag slop) picks geometry for an explicit Snap
// (geometry/intersectionSnap.ts): the line — or, with the Snap row's switch on Point, the point —
// under the finger. Choosing by kind rather than by distance matters: in a dense construction there
// is a crossing every pixel or two along every line. A tap inside a construction away from its
// lines selects the construction; a tap on empty canvas clears both.

import type { Vec2 } from '../../model/types.ts';
import type { AppController, ViewTransform } from '../../app/controller.ts';
import { screenToWorld, worldToScreen } from '../../app/controller.ts';
import { motifRadius, snapRotation } from '../../geometry/lattice.ts';
import { dist } from '../../geometry/vec.ts';
import { intersectionCopies, layoutOf, placedAt, withLayout, type IntersectionCopy } from '../../geometry/intersection.ts';
import { canMoveAgainst, pickAtTap, pickCarrier, samePick, withPick, type IntersectionPick } from '../../geometry/intersectionSnap.ts';
import { ringRadius } from '../../render/intersectionRenderer.ts';
import type { Gesture, ToolModule } from './types.ts';

const RING_HIT_BAND = 22; // px either side of the ring's own radius, as Repeat's
const DRAG_SLOP_PX = 6; // as Repeat: a press that stays within this moves nothing — it's a tap
/** How close (px) a tap must be to pick a line or point. */
export const PICK_REACH_PX = 14;

function centreOf(controller: AppController, view: ViewTransform, copy: IntersectionCopy): Vec2 {
  const pivot = controller.doc.frame.origin;
  return worldToScreen(view, { x: pivot.x + copy.pose.translate.x, y: pivot.y + copy.pose.translate.y });
}

function commitPlacement(controller: AppController, key: string, at: Vec2, rotation: number): void {
  controller.commit((d) => {
    d.intersection = withLayout(d, placedAt(layoutOf(d), key, at, rotation));
  });
}

function moveGesture(controller: AppController, view: ViewTransform, copy: IntersectionCopy, down: Vec2, onTap: () => void): Gesture {
  const start = copy.pose.translate;
  let moving = false;
  return {
    onMove(sp) {
      if (!moving && dist(sp, down) <= DRAG_SLOP_PX) return;
      moving = true;
      controller.intersectionSelected = copy.key;
      controller.intersectionDrag = { key: copy.key, x: start.x + (sp.x - down.x) / view.zoom, y: start.y + (sp.y - down.y) / view.zoom, rotation: copy.pose.rotation, mode: 'move' };
      controller.notifyView();
    },
    onUp() {
      const drag = controller.intersectionDrag;
      controller.intersectionDrag = null;
      if (moving && drag) commitPlacement(controller, copy.key, { x: drag.x, y: drag.y }, drag.rotation);
      else onTap();
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
      else {
        if (!moving) pickAt(controller, view, down); // a tap on the ring may still be on a line
        controller.notify();
      }
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
      const body = hit;
      return moveGesture(controller, view, body, sp, () => {
        // A tap on a construction: its line or point if the finger is on one, else the construction.
        if (!pickAt(controller, view, sp)) controller.intersectionSelected = body.key;
        controller.notify();
      });
    }
    // Outside every construction: a tap picks an extension line or a crossing out there, or —
    // on empty canvas — clears the picks and the selection.
    return {
      onMove() {},
      onUp(_sp, wasDrag) {
        if (wasDrag) return;
        if (!pickAt(controller, view, sp)) {
          if (!controller.intersectionSelected && controller.intersectionPicks.length === 0) return;
          controller.intersectionSelected = null;
          controller.intersectionPicks = [];
        }
        controller.notify();
      },
      onCancel() {},
    };
  },
};

/** The line or point under a tap at `sp`, if any — once there is a reference, one that can move
 * against it first (or the picks themselves, to un-pick them). */
function pickUnder(controller: AppController, view: ViewTransform, sp: Vec2): IntersectionPick | null {
  const [reference, moving] = controller.intersectionPicks;
  const accept = (p: IntersectionPick) => !reference || samePick(reference, p) || (!!moving && samePick(moving, p)) || canMoveAgainst(reference, p);
  return pickAtTap(controller.doc, intersectionCopies(controller.doc), screenToWorld(view, sp), PICK_REACH_PX / view.zoom, controller.intersectionPickKind, accept);
}

/** Picks what is under a tap (see withPick); the construction that would move — else the one
 * picked — becomes the selected one, so its ring shows which it is. False if nothing is there. */
function pickAt(controller: AppController, view: ViewTransform, sp: Vec2): boolean {
  const pick = pickUnder(controller, view, sp);
  if (!pick) return false;
  controller.intersectionPicks = withPick(controller.intersectionPicks, pick);
  const [reference, moving] = controller.intersectionPicks;
  const owner = moving ?? reference;
  controller.intersectionSelected = owner ? pickCarrier(owner) : null;
  return true;
}
