// Repeat's bounding box: opened by a long-press (touch) or a right-click (mouse) on the central motif,
// closed by a tap or click outside it. It frames what stands at the reference lattice position — the
// motif, or the whole Intersect composition — and edits the shared motif transformation, about the
// Original's frame centre (the pivot), for every copy at once. Each corner is one handle, always in the
// same place:
//
//   top-left: Reset (no turn, 100 %, not reflected — the lattice A / B untouched)
//   top-right: Rotate (drag round the centre; snaps to the same fractions of a turn as before)
//   bottom-left: Reflect (across the motif's own vertical axis: left and right swap)
//   bottom-right: Scale (drag; proportional about the centre, 25–400 %, a light snap at 100 %)
//
// The box is square about the centre and as large as the design reaches in any direction, so turning
// and reflecting never move its corners. A legacy alternating rule (Alternate / Mirror) still applies
// on top: the box edits the transformation every copy shares, and the alternation follows it.
// Screen geometry only: what is stored is `doc.repeat.motif` (rotation, scale, mirror?).

import type { Doc, RepeatSystem, Vec2 } from '../model/types.ts';
import type { AppController, ViewTransform } from '../app/controller.ts';
import { worldToScreen } from '../app/controller.ts';
import { motifExtent, poseScale } from '../geometry/lattice.ts';
import { repeatUnit } from '../geometry/repeatUnit.ts';
import { BOX_HANDLE_TOUCH_PX } from './copyBox.ts';

export type RepeatBoxHandle = 'reset' | 'rotate' | 'reflect' | 'scale';

export interface RepeatBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The pivot (screen px): what everything turns, reflects and scales about. */
  centre: Vec2;
  handles: { id: RepeatBoxHandle; at: Vec2; enabled: boolean }[];
}

/** Clear space between the design and the box (px). */
const MARGIN_PX = 18;
/** Kept this far inside the canvas (px), so every handle can be reached. */
const EDGE_INSET_PX = 26;

/** The shared motif transformation as shown now — a live turn or scale included. */
export function shownMotif(controller: AppController): RepeatSystem['motif'] {
  const m = controller.doc.repeat.motif;
  const rot = controller.repeatRotateDrag?.rawRotation;
  const sc = controller.repeatScaleDrag?.scale;
  if (rot === undefined && sc === undefined) return m;
  return { ...m, ...(rot !== undefined ? { rotation: rot } : null), ...(sc !== undefined ? { scale: sc } : null) };
}

/** Whether the motif is as drawn: no turn, 100 %, not reflected. */
export function motifAsDrawn(motif: RepeatSystem['motif']): boolean {
  return motif.rotation === 0 && poseScale(motif) === 1 && !motif.mirror;
}

/** The box as shown. */
export function repeatBox(controller: AppController, view: ViewTransform): RepeatBox {
  const doc: Doc = controller.doc;
  const motif = shownMotif(controller);
  const centre = worldToScreen(view, doc.frame.origin);
  const reach = (repeatUnit(doc)?.extent ?? motifExtent(doc)) * poseScale(motif) * view.zoom + MARGIN_PX;
  let x0 = Math.max(centre.x - reach, EDGE_INSET_PX);
  let y0 = Math.max(centre.y - reach, EDGE_INSET_PX);
  let x1 = Math.min(centre.x + reach, view.w - EDGE_INSET_PX);
  // (Above the panel and buttons that float over the bottom of the canvas.)
  let y1 = Math.min(centre.y + reach, Math.min(view.h, view.usableBottom && view.usableBottom > 0 ? view.usableBottom : view.h) - EDGE_INSET_PX);
  if (x1 < x0 + 2 * BOX_HANDLE_TOUCH_PX) x1 = x0 + 2 * BOX_HANDLE_TOUCH_PX;
  if (y1 < y0 + 2 * BOX_HANDLE_TOUCH_PX) y1 = y0 + 2 * BOX_HANDLE_TOUCH_PX;
  const handles: RepeatBox['handles'] = [
    { id: 'reset', at: { x: x0, y: y0 }, enabled: !motifAsDrawn(doc.repeat.motif) },
    { id: 'rotate', at: { x: x1, y: y0 }, enabled: true },
    { id: 'reflect', at: { x: x0, y: y1 }, enabled: true },
    { id: 'scale', at: { x: x1, y: y1 }, enabled: true },
  ];
  return { x0, y0, x1, y1, centre, handles };
}

/** Whether Repeat's box is open now. It is open only in Repeat, with its handles shown and no Fill,
 * crossings or Close Gap in progress; anything else closes it for good. */
export function repeatBoxOpen(controller: AppController): boolean {
  if (!controller.repeatBox) return false;
  const ok = controller.doc.view.workspace === 'repeat' && controller.doc.repeatDisplay.handles && !controller.repeatColourMode && !controller.spaceMode && !controller.weaveEdit && !controller.closeGap;
  if (!ok) controller.repeatBox = false;
  return ok;
}

/** The open box's handle under `sp`, if any (screen px). */
export function repeatBoxHandleAt(controller: AppController, view: ViewTransform, sp: Vec2): { box: RepeatBox; handle: RepeatBox['handles'][number] } | null {
  if (!repeatBoxOpen(controller)) return null;
  const box = repeatBox(controller, view);
  let best: RepeatBox['handles'][number] | null = null;
  let bestD = Infinity;
  for (const h of box.handles) {
    const d = Math.hypot(sp.x - h.at.x, sp.y - h.at.y);
    if (d <= BOX_HANDLE_TOUCH_PX && d < bestD) {
      best = h;
      bestD = d;
    }
  }
  return best ? { box, handle: best } : null;
}

/** Whether `sp` is on the central design — where a long-press or right-click opens the box (screen px):
 * within the design's reach of the centre. */
export function onCentralMotif(controller: AppController, view: ViewTransform, sp: Vec2): boolean {
  const doc = controller.doc;
  const centre = worldToScreen(view, doc.frame.origin);
  const reach = (repeatUnit(doc)?.extent ?? motifExtent(doc)) * poseScale(doc.repeat.motif) * view.zoom;
  return Math.hypot(sp.x - centre.x, sp.y - centre.y) <= Math.max(reach, 30);
}

/** Whether `sp` is inside the open box (screen px). */
export function insideRepeatBox(controller: AppController, view: ViewTransform, sp: Vec2): boolean {
  if (!repeatBoxOpen(controller)) return false;
  const b = repeatBox(controller, view);
  return sp.x >= b.x0 && sp.x <= b.x1 && sp.y >= b.y0 && sp.y <= b.y1;
}

/** The motif reflected across its own vertical axis: the flag toggles, the turn stays. */
export function reflectedMotif(motif: RepeatSystem['motif']): RepeatSystem['motif'] {
  const { mirror, ...rest } = motif;
  return mirror ? rest : { ...rest, mirror: true };
}

/** The motif as drawn again: no turn, 100 %, not reflected. */
export function resetMotif(motif: RepeatSystem['motif']): RepeatSystem['motif'] {
  const { mirror: _m, ...rest } = motif;
  return { ...rest, rotation: 0, scale: 1 };
}
