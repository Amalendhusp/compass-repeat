// Reference anchors and the soft snapping that uses them.
//
// An anchor is a place in the reference image the participant has marked themselves — a crossing,
// a polygon vertex, a star's point — kept in the image's own fractions (types.ts — ReferenceAnchor),
// so it travels with the image through every move, scale and turn. Anchors never become
// construction points and never change the geometry: they only let the image be aligned BY HAND to
// the construction's points, with gentle help.
//
// Soft snapping (applied while the image is moved in Transform — interaction/referenceTransform.ts):
// - Moving: when an anchor comes near a construction point it is drawn onto it — progressively,
//   never with a jump: from SOFT_REACH_PX in, the pull grows until, within HOLD_PX, the two
//   coincide exactly and stay so while the finger moves a little further (the slight resistance).
//   Moving on releases it just as smoothly. One correspondence pulls at a time, and keeps pulling
//   until it lets go; where points are close together each one's reach shrinks to half the gap, so
//   their pulls never overlap — nothing flickers or jumps between neighbours, and the image is
//   never trapped among them.
// - Scaling / turning: no pull at all (it would mean unexpected sliding) — except that an anchor
//   already sitting exactly on a point when the gesture starts becomes the pivot: the image scales
//   and turns about it, so it stays aligned while a second anchor is brought round to its point.
// Distances are in screen pixels, so the feel is the same at every zoom. The image stays one rigid
// picture with a single uniform scale throughout.

import type { Doc, ReferenceAnchor, Underlay, Vec2, Workspace } from '../model/types.ts';
import type { ViewTransform } from '../app/controller.ts';
import { worldToScreen } from '../app/controller.ts';
import { resolvePoint } from '../geometry/kernel.ts';
import { isPointOrphanedByTrim } from '../geometry/usage.ts';
import { isPointTargetEligibleIn } from '../interaction/hittest.ts';
import { intersectionCopies } from '../geometry/intersection.ts';
import { localPoints, pointShown } from '../geometry/intersectionSnap.ts';
import { transformPoint } from '../geometry/lattice.ts';

/** Within this (px) an anchor sits exactly on its point. */
export const HOLD_PX = 6;
/** From this (px) in, a nearby point begins to draw the anchor towards it. */
export const SOFT_REACH_PX = 14;
/** An anchor this close (px) to a point counts as aligned (a pivot for scaling and turning). */
export const ALIGNED_PX = 0.5;
/** Within this (px) of a point an anchor shows that it is approaching. */
export const NEAR_PX = 28;

const half = (u: Underlay) => ({ w: u.width / 2, h: u.width / u.aspect / 2 });

/** Where an anchor is, in the artwork's coordinates, with the image placed as `u`. */
export function anchorWorld(u: Underlay, a: { u: number; v: number }): Vec2 {
  const { w, h } = half(u);
  const lx = (a.u - 0.5) * 2 * w;
  const ly = (a.v - 0.5) * 2 * h;
  const c = Math.cos(u.rotation);
  const s = Math.sin(u.rotation);
  return { x: u.centre.x + lx * c - ly * s, y: u.centre.y + lx * s + ly * c };
}

/** The image fractions of an artwork point, with the image placed as `u` (may lie outside 0–1). */
export function anchorAt(u: Underlay, p: Vec2): { u: number; v: number } {
  const { w, h } = half(u);
  const dx = p.x - u.centre.x;
  const dy = p.y - u.centre.y;
  const c = Math.cos(u.rotation);
  const s = Math.sin(u.rotation);
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  return { u: lx / (2 * w) + 0.5, v: ly / (2 * h) + 0.5 };
}

/** Whether an artwork point lies on the image. */
export function onImage(u: Underlay, p: Vec2): boolean {
  const f = anchorAt(u, p);
  return f.u >= 0 && f.u <= 1 && f.v >= 0 && f.v <= 1;
}

/** The construction points an anchor can be aligned to in a workspace (artwork coordinates): in
 * Construct its points as they are targeted; in Intersect every instance's shown points, placed;
 * none in Repeat (the reference there is only a backdrop). */
export function anchorTargets(doc: Doc, ws: Workspace): Vec2[] {
  if (ws === 'construct') {
    const out: Vec2[] = [];
    for (const p of doc.points) {
      if (p.kind === 'free' && p.hidden) continue;
      if (!isPointTargetEligibleIn(doc, p) || isPointOrphanedByTrim(doc, p.id)) continue;
      out.push(resolvePoint(doc, p.id));
    }
    return out;
  }
  if (ws === 'intersection') {
    const out: Vec2[] = [];
    const pivot = doc.frame.origin;
    const pts = localPoints(doc);
    for (const copy of intersectionCopies(doc)) for (const p of pts) if (pointShown(doc, p.id, p.at, copy.extensions)) out.push(transformPoint(pivot, copy.pose, p.at));
    return out;
  }
  return [];
}

/** The nearest target to an anchor (screen px), or null if none is within `reach`. */
function nearest(view: ViewTransform, at: Vec2, targets: Vec2[], reach: number): { target: Vec2; index: number; d: number } | null {
  const s = worldToScreen(view, at);
  let best: { target: Vec2; index: number; d: number } | null = null;
  targets.forEach((t, index) => {
    const q = worldToScreen(view, t);
    const d = Math.hypot(q.x - s.x, q.y - s.y);
    if (d <= reach && (!best || d < best.d)) best = { target: t, index, d };
  });
  return best;
}

/** The anchor (if any) sitting exactly on a construction point — the pivot for scaling and turning. */
export function alignedAnchor(u: Underlay, view: ViewTransform, targets: Vec2[]): { anchor: ReferenceAnchor; at: Vec2 } | null {
  for (const a of u.anchors ?? []) {
    const n = nearest(view, anchorWorld(u, a), targets, ALIGNED_PX);
    if (n) return { anchor: a, at: n.target };
  }
  return null;
}

/** One moving gesture's soft snap: which correspondence is pulling, kept between samples. */
type Pull = { anchorId: string; index: number; d: number; reach: number; from: Vec2; to: Vec2 };

export class SoftSnap {
  private active: { anchorId: string; index: number } | null = null;
  private readonly targets: Vec2[];
  private readonly reachCache = new Map<number, number>();
  constructor(targets: Vec2[]) {
    this.targets = targets;
  }

  /** How far a target's pull reaches (px): SOFT_REACH_PX — or less where other points are close, so
   * that no two points' pulls ever overlap. Moving from one point to its neighbour then passes
   * through a moment of no pull at all: never a jump, and never trapped among crowded points. */
  private reachOf(index: number, view: ViewTransform): number {
    let r = this.reachCache.get(index);
    if (r !== undefined) return r;
    const q = worldToScreen(view, this.targets[index]!);
    let nearestOther = Infinity;
    this.targets.forEach((t, i) => {
      if (i === index) return;
      const o = worldToScreen(view, t);
      const d = Math.hypot(o.x - q.x, o.y - q.y);
      if (d > 1e-6 && d < nearestOther) nearestOther = d; // a coincident duplicate is the same place
    });
    r = Math.min(SOFT_REACH_PX, nearestOther / 2);
    this.reachCache.set(index, r);
    return r;
  }

  /** The image as the finger has moved it (`raw`), drawn the last little way by the pull of one
   * nearby correspondence — or `raw` itself when there is none. Translation only. */
  apply(raw: Underlay, view: ViewTransform): Underlay {
    const anchors = raw.anchors ?? [];
    if (!anchors.length || !this.targets.length) {
      this.active = null;
      return raw;
    }
    const pullOf = (anchorId: string, at: Vec2, index: number): Pull | null => {
      const to = this.targets[index]!;
      const q = worldToScreen(view, to);
      const s = worldToScreen(view, at);
      const d = Math.hypot(q.x - s.x, q.y - s.y);
      const reach = this.reachOf(index, view);
      return d <= reach ? { anchorId, index, d, reach, from: at, to } : null;
    };
    // The pulling correspondence is kept for as long as it is within its reach — a new one takes
    // over only once it has let go, so the hand-over never jumps.
    let pull: Pull | null = null;
    if (this.active) {
      const a = anchors.find((x) => x.id === this.active!.anchorId);
      if (a) pull = pullOf(a.id, anchorWorld(raw, a), this.active.index);
    }
    if (!pull) {
      for (const a of anchors) {
        const at = anchorWorld(raw, a);
        const n = nearest(view, at, this.targets, SOFT_REACH_PX);
        const c = n ? pullOf(a.id, at, n.index) : null;
        if (c && (!pull || c.d < pull.d)) pull = c;
      }
    }
    if (!pull) {
      this.active = null;
      return raw;
    }
    this.active = { anchorId: pull.anchorId, index: pull.index };
    // Full within the hold (the same share of the reach everywhere); fading smoothly to nothing at
    // the edge of the reach.
    const hold = (pull.reach * HOLD_PX) / SOFT_REACH_PX;
    const f = pull.d <= hold ? 1 : (pull.reach - pull.d) / (pull.reach - hold);
    const dx = (pull.to.x - pull.from.x) * f;
    const dy = (pull.to.y - pull.from.y) * f;
    return { ...raw, centre: { x: raw.centre.x + dx, y: raw.centre.y + dy } };
  }
}

/** The image `raw` re-made so it scales and turns about `pivot` (artwork point) by as much as it
 * scales and turns from `base` — its own translation ignored — keeping the pivot fixed. */
export function aboutPivot(base: Underlay, raw: Underlay, pivot: Vec2): Underlay {
  const s = raw.width / base.width;
  const turn = raw.rotation - base.rotation;
  const c = Math.cos(turn);
  const n = Math.sin(turn);
  const r = { x: base.centre.x - pivot.x, y: base.centre.y - pivot.y };
  return { ...raw, centre: { x: pivot.x + s * (r.x * c - r.y * n), y: pivot.y + s * (r.x * n + r.y * c) } };
}

// ---- feedback ----

const SIGNAL = '#2F5BEA';
const INK = '#1E2A36';

/** While Transform is on: each anchor as a small crosshair ring (the selected one larger), and the
 * construction point it is approaching — a faint ring on it, filled in once they coincide. Drawn in
 * the paper frame, like the reference outline. */
export function drawAnchors(ctx: CanvasRenderingContext2D, u: Underlay, view: ViewTransform, targets: Vec2[], selected: string | null, draft: { id: string; u: number; v: number } | null): void {
  const anchors = (u.anchors ?? []).map((a) => (draft && draft.id === a.id ? draft : a));
  if (!anchors.length) return;
  ctx.save();
  for (const a of anchors) {
    const at = anchorWorld(u, a);
    const s = worldToScreen(view, at);
    const n = nearest(view, at, targets, NEAR_PX);
    const aligned = !!n && n.d <= ALIGNED_PX;
    if (n && !aligned) {
      const q = worldToScreen(view, n.target);
      ctx.beginPath();
      ctx.arc(q.x, q.y, 8, 0, Math.PI * 2);
      ctx.strokeStyle = SIGNAL;
      ctx.globalAlpha = n.d <= SOFT_REACH_PX ? 0.75 : 0.35; // nearer: within the pull
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const r = a.id === selected ? 10 : 7;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r + 1.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(251, 249, 245, 0.9)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = aligned || a.id === selected ? SIGNAL : INK;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x - r - 3, s.y);
    ctx.lineTo(s.x - 2, s.y);
    ctx.moveTo(s.x + 2, s.y);
    ctx.lineTo(s.x + r + 3, s.y);
    ctx.moveTo(s.x, s.y - r - 3);
    ctx.lineTo(s.x, s.y - 2);
    ctx.moveTo(s.x, s.y + 2);
    ctx.lineTo(s.x, s.y + r + 3);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    if (aligned) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = SIGNAL;
      ctx.fill();
    }
  }
  ctx.restore();
}
