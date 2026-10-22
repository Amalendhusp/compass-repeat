// Reference Transform: while it is on (controller.referenceTransform), every finger on the canvas
// moves the reference instead of reaching a tool or the camera (PointerManager's takeover). One
// finger slides it; two fingers scale it uniformly and turn it together, about the point between
// them — as if the image were held under the fingers. Only this workspace's placement of it changes
// (centre, width, rotation, in the artwork's own coordinates — render/underlay.ts): never another
// workspace's, no camera and no geometry.
//
// The touch is shown live (controller.underlayDraft) and committed once, when the last finger
// lifts — one Undo step per complete gesture. A pointercancel puts it back untouched.

import type { Underlay, Vec2 } from '../model/types.ts';
import type { AppController, ViewTransform } from '../app/controller.ts';
import { screenToPaper, screenToWorld } from '../app/controller.ts';
import type { PointerTakeover } from './pointer.ts';
import { underlayIn, withPlacement } from '../render/underlay.ts';
import { aboutPivot, alignedAnchor, anchorTargets, SoftSnap } from '../reference/anchors.ts';

/** The reference stays between these widths, as multiples of the frame radius. */
const MIN_WIDTH = 0.05;
const MAX_WIDTH = 2000;
/** Below this finger spacing (px) a second finger only moves — too close to judge a scale or turn. */
const MIN_SPREAD_PX = 12;

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** The reference as moved by the fingers since `basePts` (world): one finger slides it; two map
 * the pair as it was onto the pair as it is — scale, turn and slide in one. */
export function transformedUnderlay(base: Underlay, basePts: Vec2[], pts: Vec2[], radius: number, zoom: number): Underlay {
  if (pts.length === 1 || basePts.length === 1) {
    const d = sub(pts[0]!, basePts[0]!);
    return { ...base, centre: { x: base.centre.x + d.x, y: base.centre.y + d.y } };
  }
  const v0 = sub(basePts[1]!, basePts[0]!);
  const v1 = sub(pts[1]!, pts[0]!);
  const m0 = mid(basePts[0]!, basePts[1]!);
  const m1 = mid(pts[0]!, pts[1]!);
  const l0 = Math.hypot(v0.x, v0.y);
  const l1 = Math.hypot(v1.x, v1.y);
  if (l0 * zoom < MIN_SPREAD_PX || l1 * zoom < MIN_SPREAD_PX) {
    return { ...base, centre: { x: base.centre.x + m1.x - m0.x, y: base.centre.y + m1.y - m0.y } };
  }
  const width = Math.min(MAX_WIDTH * radius, Math.max(MIN_WIDTH * radius, base.width * (l1 / l0)));
  const s = width / base.width;
  const turn = Math.atan2(v0.x * v1.y - v0.y * v1.x, v0.x * v1.x + v0.y * v1.y);
  const c = Math.cos(turn);
  const n = Math.sin(turn);
  const r = sub(base.centre, m0);
  let rotation = base.rotation + turn;
  rotation = Math.atan2(Math.sin(rotation), Math.cos(rotation));
  return { ...base, width, rotation, centre: { x: m1.x + s * (r.x * c - r.y * n), y: m1.y + s * (r.x * n + r.y * c) } };
}

/** The takeover for one touch while Transform is on — or null when there's nothing to transform. */
export function referenceTakeover(controller: AppController, getView: () => ViewTransform): PointerTakeover | null {
  // Placing anchors is a tool of its own (fingers there are one anchor or the camera).
  if (!controller.referenceTransform || controller.referenceAnchorMode || !controller.doc.underlay) return null;
  const view = getView(); // the camera can't move during the touch: every finger is the reference's
  const ws = controller.doc.view.workspace;
  const start = underlayIn(controller.doc.underlay, ws); // as this workspace shows it
  let base: Underlay = start;
  let basePts: Vec2[] = [];
  const world = (pts: Vec2[]) => pts.slice(0, 2).map((p) => screenToWorld(view, p));
  // Soft snapping to the construction's points (reference/anchors.ts): a moving finger is gently
  // drawn onto them; scaling and turning pull nothing — but turn about an anchor already aligned.
  const targets = anchorTargets(controller.doc, ws);
  const snap = new SoftSnap(targets);
  let pivot = alignedAnchor(start, view, targets);
  /** The last one-finger sample as the finger alone placed it (before any pull). */
  let lastRaw: Underlay | null = null;
  return {
    update(points, phase) {
      const pts = world(points);
      // A finger added or lifted: carry on from where the reference is now, with the new fingers —
      // and about whichever anchor is aligned now (one may have just been drawn onto its point).
      if (phase !== 'move' || pts.length !== basePts.length) {
        base = controller.underlayDraft ?? start;
        basePts = pts;
        pivot = alignedAnchor(base, view, targets);
        lastRaw = null;
        return;
      }
      const raw = transformedUnderlay(base, basePts, pts, controller.doc.frame.radius, view.zoom);
      lastRaw = pts.length >= 2 ? null : raw;
      controller.underlayDraft = pts.length >= 2 ? (pivot ? aboutPivot(base, raw, pivot.at) : raw) : snap.apply(raw, view);
      controller.notifyView();
    },
    end() {
      // Released within a pull: the anchor settles exactly onto its point.
      const next = lastRaw ? snap.settle(lastRaw, view) : controller.underlayDraft;
      controller.underlayDraft = null;
      const moved = next && (next.centre.x !== start.centre.x || next.centre.y !== start.centre.y || next.width !== start.width || next.rotation !== start.rotation);
      if (moved) {
        controller.commit((d) => {
          if (d.underlay) d.underlay = withPlacement(d.underlay, ws, next);
        });
      } else controller.notifyView();
    },
    cancel() {
      controller.underlayDraft = null;
      controller.notifyView();
    },
  };
}

// ---- Desktop: trackpad pinch, ⌘/Ctrl-scroll and ⌥-scroll while Transform is on ----
//
// A Mac has no second finger on the canvas: a trackpad pinch arrives as wheel events with ctrlKey
// (Chrome, Firefox, Edge) or as WebKit gesture events (Safari, which also reports a two-finger
// turn). While Transform is on these scale — and ⌥-scroll or Safari's turn rotates — the reference
// about the cursor, exactly as two fingers would on a phone; plain scrolling still pans the view.
// The steps are shown live and committed once the input has been still for a moment: one Undo step
// per pinch or scroll, as one touch gesture is.

const WHEEL_SETTLE_MS = 350;
let pending: { controller: AppController; timer: ReturnType<typeof setTimeout> } | null = null;

/** Commits a pinch/scroll still being shown (on Done, or when it settles). */
export function settleReferenceWheel(): void {
  if (!pending) return;
  const { controller, timer } = pending;
  clearTimeout(timer);
  pending = null;
  const next = controller.underlayDraft;
  controller.underlayDraft = null;
  const u = controller.doc.underlay;
  if (!next || !u) {
    controller.notifyView();
    return;
  }
  const ws = controller.doc.view.workspace;
  const start = underlayIn(u, ws);
  if (next.centre.x === start.centre.x && next.centre.y === start.centre.y && next.width === start.width && next.rotation === start.rotation) {
    controller.notifyView();
    return;
  }
  controller.commit((d) => {
    if (d.underlay) d.underlay = withPlacement(d.underlay, ws, next);
  });
}

/**
 * Scales the reference by `factor` and turns it by `turn` (radians) about canvas point `at`, while
 * Transform is on. False — nothing done — when it isn't (the input then moves the camera as usual).
 */
export function referenceWheel(controller: AppController, getView: () => ViewTransform, at: Vec2, factor: number, turn: number): boolean {
  // While placing anchors the trackpad zooms the view, as it does for building — to place them precisely.
  if (!controller.referenceTransform || controller.referenceAnchorMode || !controller.doc.underlay) return false;
  const view = getView();
  const ws = controller.doc.view.workspace;
  const base = controller.underlayDraft ?? underlayIn(controller.doc.underlay, ws);
  // Scaling and turning go about an anchor aligned with a construction point, else about the cursor.
  const aligned = alignedAnchor(base, view, anchorTargets(controller.doc, ws));
  const p = aligned ? aligned.at : screenToWorld(view, screenToPaper(view, at));
  const radius = controller.doc.frame.radius;
  const width = Math.min(MAX_WIDTH * radius, Math.max(MIN_WIDTH * radius, base.width * factor));
  const s = width / base.width;
  const c = Math.cos(turn);
  const n = Math.sin(turn);
  const r = sub(base.centre, p);
  const rotation = Math.atan2(Math.sin(base.rotation + turn), Math.cos(base.rotation + turn));
  controller.underlayDraft = { ...base, width, rotation, centre: { x: p.x + s * (r.x * c - r.y * n), y: p.y + s * (r.x * n + r.y * c) } };
  controller.notifyView();
  if (pending) clearTimeout(pending.timer);
  pending = { controller, timer: setTimeout(settleReferenceWheel, WHEEL_SETTLE_MS) };
  return true;
}
