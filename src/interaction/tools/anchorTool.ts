// Reference anchors, placed and refined by hand (reference/anchors.ts) — the tool while Transform's
// Anchors is on. One finger: a press on the image starts a new anchor under the finger; sliding
// refines it and release places it there. A drag that starts on an anchor moves it by as much as
// the finger moves (never jumping to the finger); a tap on an anchor selects it (for Remove
// anchor), a tap off the image deselects. While the finger places or moves an anchor, the anchor
// loupe shows the exact spot magnified, clear of the finger. Two fingers are the camera, as
// everywhere — a second finger abandons a placement. Each placement, move or removal is one Undo
// step; the geometry is never touched.

import type { Vec2 } from '../../model/types.ts';
import { screenToWorld, worldToScreen } from '../../app/controller.ts';
import { genId } from '../../model/id.ts';
import { dist } from '../../geometry/vec.ts';
import { underlayIn } from '../../render/underlay.ts';
import { anchorAt, anchorWorld, onImage } from '../../reference/anchors.ts';
import type { Gesture, ToolModule } from './types.ts';

/** An anchor answers a press within this (px) — a comfortable fingertip target. */
export const ANCHOR_TOUCH_PX = 22;
const DRAG_SLOP_PX = 6;

/** Image fractions kept on the image. */
const onTheImage = (f: { u: number; v: number }) => ({ u: Math.min(1, Math.max(0, f.u)), v: Math.min(1, Math.max(0, f.v)) });

export const anchorTool: ToolModule = {
  id: 'select', // routed to directly by main.ts while Anchors is on
  hint() {
    return 'Tap the image to add an anchor · drag one to refine it';
  },
  beginGesture(controller, view, sp): Gesture | null {
    const doc = controller.doc;
    if (!doc.underlay) return null;
    const u = underlayIn(doc.underlay, doc.view.workspace);
    let hit: { id: string; d: number } | null = null;
    for (const a of u.anchors ?? []) {
      const d = dist(worldToScreen(view, anchorWorld(u, a)), sp);
      if (d <= ANCHOR_TOUCH_PX && (!hit || d < hit.d)) hit = { id: a.id, d };
    }
    const down = screenToWorld(view, sp);
    if (hit) {
      const id = hit.id;
      const start = anchorWorld(u, u.anchors!.find((a) => a.id === id)!);
      let moved = false;
      return {
        onMove(p: Vec2) {
          if (!moved && dist(p, sp) <= DRAG_SLOP_PX) return;
          moved = true;
          const w = screenToWorld(view, p);
          controller.anchorDraft = { id, ...onTheImage(anchorAt(u, { x: start.x + w.x - down.x, y: start.y + w.y - down.y })) };
          controller.anchorSelected = id;
          controller.anchorLoupe = p;
          controller.notifyView();
        },
        onUp() {
          const draft = controller.anchorDraft;
          controller.anchorDraft = null;
          controller.anchorLoupe = null;
          if (moved && draft) {
            controller.commit((d) => {
              if (d.underlay) d.underlay = { ...d.underlay, anchors: (d.underlay.anchors ?? []).map((a) => (a.id === draft.id ? { id: a.id, u: draft.u, v: draft.v } : a)) };
            });
          } else {
            controller.anchorSelected = controller.anchorSelected === id ? null : id;
            controller.notify();
          }
        },
        onCancel() {
          controller.anchorDraft = null;
          controller.anchorLoupe = null;
          controller.notifyView();
        },
      };
    }
    if (!onImage(u, down)) {
      return {
        onMove() {},
        onUp(_p, wasDrag) {
          if (wasDrag) return;
          controller.anchorSelected = null;
          controller.notify();
        },
        onCancel() {},
      };
    }
    // A new anchor: under the finger from the press, refined by sliding, placed on release.
    const id = genId('an');
    const follow = (p: Vec2) => {
      controller.anchorDraft = { id, ...onTheImage(anchorAt(u, screenToWorld(view, p))) };
      controller.anchorLoupe = p;
      controller.notifyView();
    };
    follow(sp);
    return {
      onMove: follow,
      onUp(p) {
        follow(p);
        const at = controller.anchorDraft!;
        controller.anchorDraft = null;
        controller.anchorLoupe = null;
        controller.commit((d) => {
          if (d.underlay) d.underlay = { ...d.underlay, anchors: [...(d.underlay.anchors ?? []), { id, u: at.u, v: at.v }] };
        });
        controller.anchorSelected = id;
        controller.notify();
      },
      onCancel() {
        controller.anchorDraft = null;
        controller.anchorLoupe = null;
        controller.notifyView();
      },
    };
  },
};

/** Removes the selected anchor — one Undo step. */
export function removeSelectedAnchor(controller: import('../../app/controller.ts').AppController): void {
  const id = controller.anchorSelected;
  if (!id || !controller.doc.underlay) return;
  controller.anchorSelected = null;
  controller.commit((d) => {
    if (d.underlay) d.underlay = { ...d.underlay, anchors: (d.underlay.anchors ?? []).filter((a) => a.id !== id) };
  });
}
