// An Intersect copy's bounding box (Stage 2b): opened by a long-press (touch) or a right-click (mouse)
// on a copy, closed by a tap or click outside it. Canvas-aligned around what the copy draws (its frame
// and Fair) and around its rotation ring, so the ring's handle stays clear of the corners. Each corner
// is one handle, always in the same place:
//
//   top-left: Reflect ↔ (across the vertical axis through the copy's centre)
//   top-right: Delete (never the Original)
//   bottom-left: Lock / Unlock (a locked copy stays where it is, and stays a reference)
//   bottom-right: Scale (drag; proportional about the copy's centre, 25–400 %, a light snap at 100 %)
//
// Screen geometry only: what is stored is the copy's pose (geometry/intersection.ts).

import type { Doc, Vec2 } from '../model/types.ts';
import type { AppController, ViewTransform } from '../app/controller.ts';
import { worldToScreen } from '../app/controller.ts';
import { MAX_SCALE, MIN_SCALE, motifRadius, poseScale, transformPoint } from '../geometry/lattice.ts';
import { motifRuns } from '../geometry/fairGeometry.ts';
import { PRIMARY, shownCopies, type IntersectionCopy } from '../geometry/intersection.ts';

export type BoxHandle = 'reflect' | 'delete' | 'lock' | 'scale';

export interface CopyBox {
  copy: IntersectionCopy;
  /** The box (screen px, the canvas's own axes). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The copy's centre (screen px): what it turns and scales about. */
  centre: Vec2;
  /** Where each corner handle is, and whether it can be used now. */
  handles: { id: BoxHandle; at: Vec2; enabled: boolean }[];
}

/** A handle is drawn this size (px radius)… */
export const BOX_HANDLE_R = 14;
/** …and answers within this of its centre (px) — a 44 px touch target. */
export const BOX_HANDLE_TOUCH_PX = 22;
/** Clear space between the rotation ring and the box (px), so the ring's handle never meets a corner. */
const RING_CLEARANCE_PX = 18;
/** Kept this far inside the canvas (px), so every handle can be reached. */
const EDGE_INSET_PX = 26;

/** Scale snaps to 100 % within this. */
export const SCALE_SNAP = 0.04;

/** The radius (screen px) of a construction's rotation ring — just outside its frame (at its scale),
 * as Repeat's. */
export function ringRadius(doc: Doc, view: ViewTransform, copy?: IntersectionCopy): number {
  return motifRadius(doc) * (copy ? poseScale(copy.pose) : 1) * view.zoom + 26;
}

const outlineCache = new WeakMap<Doc, Vec2[]>();

/** The construction's outline, unplaced: its frame and its Fair runs, as points. */
function outlineOf(doc: Doc): Vec2[] {
  let pts = outlineCache.get(doc);
  if (pts) return pts;
  pts = [];
  const { origin, radius, rotation, kind } = doc.frame;
  const n = kind === 'square' ? 4 : kind === 'hexagon' ? 6 : kind === 'triangle' ? 3 : 32;
  for (let k = 0; k < n; k++) {
    const a = rotation + (k / n) * Math.PI * 2;
    pts.push({ x: origin.x + radius * Math.cos(a), y: origin.y + radius * Math.sin(a) });
  }
  for (const { prim } of motifRuns(doc)) {
    if (prim.k === 'seg') pts.push(prim.a, prim.b);
    else for (let k = 0; k <= 12; k++) {
      const a = prim.a0 + (prim.sw * k) / 12;
      pts.push({ x: prim.c.x + prim.r * Math.cos(a), y: prim.c.y + prim.r * Math.sin(a) });
    }
  }
  outlineCache.set(doc, pts);
  return pts;
}

/** The box of one copy as shown. */
export function copyBox(doc: Doc, view: ViewTransform, copy: IntersectionCopy): CopyBox {
  const pivot = doc.frame.origin;
  const centre = worldToScreen(view, { x: pivot.x + copy.pose.translate.x, y: pivot.y + copy.pose.translate.y });
  const ring = ringRadius(doc, view, copy) + RING_CLEARANCE_PX;
  let x0 = centre.x - ring;
  let y0 = centre.y - ring;
  let x1 = centre.x + ring;
  let y1 = centre.y + ring;
  for (const p of outlineOf(doc)) {
    const s = worldToScreen(view, transformPoint(pivot, copy.pose, p));
    x0 = Math.min(x0, s.x - 8);
    y0 = Math.min(y0, s.y - 8);
    x1 = Math.max(x1, s.x + 8);
    y1 = Math.max(y1, s.y + 8);
  }
  // Inside the canvas, so a copy larger than the screen (or partly off it) still has all four handles.
  x0 = Math.max(x0, EDGE_INSET_PX);
  y0 = Math.max(y0, EDGE_INSET_PX);
  x1 = Math.min(x1, view.w - EDGE_INSET_PX);
  // (Above the floating dock and its buttons, which lie over the bottom of the canvas.)
  y1 = Math.min(y1, Math.min(view.h, view.usableBottom && view.usableBottom > 0 ? view.usableBottom : view.h) - EDGE_INSET_PX);
  if (x1 < x0 + 2 * BOX_HANDLE_TOUCH_PX) x1 = x0 + 2 * BOX_HANDLE_TOUCH_PX;
  if (y1 < y0 + 2 * BOX_HANDLE_TOUCH_PX) y1 = y0 + 2 * BOX_HANDLE_TOUCH_PX;
  const original = copy.key === PRIMARY;
  const handles: CopyBox['handles'] = [
    { id: 'reflect', at: { x: x0, y: y0 }, enabled: !original && !copy.locked },
    ...(original ? [] : [{ id: 'delete' as const, at: { x: x1, y: y0 }, enabled: true }]),
    { id: 'lock', at: { x: x0, y: y1 }, enabled: true },
    { id: 'scale', at: { x: x1, y: y1 }, enabled: !copy.locked },
  ];
  return { copy, x0, y0, x1, y1, centre, handles };
}

/** The copy whose box is open now, as shown (a live move, turn or scale included) — or null. A box
 * is open only while its copy is the selected one, shown, and Select arranges copies; once its copy is
 * no longer selected it is closed for good (it never comes back by itself). */
export function openBox(controller: AppController): IntersectionCopy | null {
  const key = controller.intersectionBox;
  if (!key) return null;
  if (controller.intersectionSelected !== key) {
    controller.intersectionBox = null;
    return null;
  }
  if (controller.doc.view.workspace !== 'intersection' || controller.tool !== 'select' || controller.intersectionPickKind !== 'instance') return null;
  const copy = shownCopies(controller.doc, { drag: controller.intersectionDrag, spread: controller.intersectionSpreadDraft }).find((c) => c.key === key) ?? null;
  if (!copy) controller.intersectionBox = null;
  return copy;
}

/** The open box's handle under `sp`, if any (screen px). */
export function boxHandleAt(controller: AppController, view: ViewTransform, sp: Vec2): { box: CopyBox; handle: CopyBox['handles'][number] } | null {
  const copy = openBox(controller);
  if (!copy) return null;
  const box = copyBox(controller.doc, view, copy);
  let best: CopyBox['handles'][number] | null = null;
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

/** Whether `sp` is inside the open box (screen px). */
export function insideOpenBox(controller: AppController, view: ViewTransform, sp: Vec2): boolean {
  const copy = openBox(controller);
  if (!copy) return false;
  const b = copyBox(controller.doc, view, copy);
  return sp.x >= b.x0 && sp.x <= b.x1 && sp.y >= b.y0 && sp.y <= b.y1;
}

/** A scale dragged from `start` by the finger's distance from the centre — kept within 25–400 % and
 * pulled to 100 % when close. */
export function draggedScale(start: number, fromCentreAtDown: number, fromCentreNow: number): number {
  const raw = start * (fromCentreNow / Math.max(fromCentreAtDown, 1));
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw));
  return Math.abs(s - 1) <= SCALE_SNAP ? 1 : s;
}

/** A scale as the readout shows it. */
export function scaleLabel(scale: number): string {
  return `${Math.round(scale * 100)} %`;
}
