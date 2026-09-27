// Smart Snap — novice-friendly point targeting for Circle, Line and Arc.
//
// - Nearest wins: among eligible points (Point Targets still decide which categories may compete),
//   the one closest to the finger ON SCREEN is chosen — a Division point right under the finger is
//   never silently replaced by a Centre a little further away.
// - Hysteresis: once a point is chosen, small finger wobble doesn't flip it; another point has to
//   become clearly closer (SWITCH_PX) before the choice moves.
// - Phase 5.8, one place = one candidate: points that sit on the same spot on screen (within
//   COINCIDENT_PX — e.g. a Centre where three lines also cross) are merged into ONE candidate
//   location before anything else happens. All their provenance is kept (for the label), but the
//   participant is never asked to choose between visually identical positions.
// - Crowded spots (Phase 5.9 — spatial, never a list): a plain tap takes the nearest location and
//   says so ("Crowded here · hold to choose"); pressing and HOLDING opens the precision loupe with
//   the nearby points spread apart, and the finger slides to the one it wants and releases
//   (PointHold below, interaction/precision.ts).
// - Phase 5.8, no point here: a tap that lies right on a curve, well away from any point on it, is
//   not quietly snapped to a neighbouring point — it says "No point here yet" (and, near the middle
//   of a segment, offers the ordinary Divide ÷2 as a shortcut).
// - Confirmation: the chosen point briefly shows its label after it is used.

import type { Doc, Point, PointId, Vec2 } from '../model/types.ts';
import type { AppController, NoPointHint, ViewTransform } from '../app/controller.ts';
import { worldToScreen } from '../app/controller.ts';
import { resolveEntityGeom, resolvePoint } from '../geometry/kernel.ts';
import { deriveSelectableGroups, groupContainingParam } from '../geometry/segments.ts';
import { isCrossingPoint, isPointOrphanedByTrim } from '../geometry/usage.ts';
import { dist } from '../geometry/vec.ts';
import type { Gesture } from './tools/types.ts';
import { curveCandidatesAt, isPointTargetEligibleIn, pickPointTarget, POINT_HIT_RADIUS, type PointHit } from './hittest.ts';
import { closePrecision, movePrecision, openPrecision } from './precision.ts';

export const SWITCH_PX = 6;
export const AMBIGUITY_PX = 7;
/** A second location counts as "about as close" only if it is within d1 × RELATIVE_CLEAR + ABSOLUTE_CLEAR_PX. */
const RELATIVE_CLEAR = 2.5;
const ABSOLUTE_CLEAR_PX = 3;
/** Candidates closer together than this on screen are one visible location. */
export const COINCIDENT_PX = 1;
/** "On the curve": a tap this close to a line/arc counts as touching it. */
const ON_CURVE_PX = 3.5;
/** A tap on a curve takes a point on it only if the point is within this share of the segment's
 * on-screen length (or a few px) — otherwise the tap is "somewhere along the curve", not "at that point". */
const ON_CURVE_POINT_SHARE = 0.3;
const ON_CURVE_POINT_MIN_PX = 6;
/** Within this share of a segment's middle, "No point here yet" offers Divide ÷2. */
const MIDPOINT_SHARE = 0.12;
const CONFIRM_MS = 1100;

export function snapLabel(p: Point): string {
  switch (p.kind) {
    case 'centre':
      return 'Centre';
    case 'intersection':
      return 'Intersection';
    case 'frame-vertex':
      return 'Frame vertex';
    case 'midpoint':
      return 'Midpoint';
    case 'division':
      return 'Division point';
    case 'free':
      return 'Free point';
    case 'on-curve':
      return p.arcEnd ? 'Arc end' : 'Point on curve';
  }
}

/** Which of several coincident points stands for the location (and heads its label). */
function kindRank(p: Point): number {
  switch (p.kind) {
    case 'centre':
      return 0;
    case 'frame-vertex':
      return 1;
    case 'division':
      return 2;
    case 'midpoint':
      return 3;
    case 'on-curve':
      return p.arcEnd ? 4 : 6;
    case 'intersection':
      return 5;
    case 'free':
      return 7;
  }
}

const plural = (label: string) => (label.endsWith('x') ? `${label}es` : `${label}s`);

/** "Centre · 3 intersections", "Division point · intersection", "Intersection ×4". */
export function mergedLabel(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  const [head, ...rest] = labels;
  if (rest.every((l) => l === head)) return `${head} ×${labels.length}`;
  const counts = new Map<string, number>();
  for (const l of rest) counts.set(l, (counts.get(l) ?? 0) + 1);
  const parts = [...counts].map(([l, n]) => (n === 1 ? l.toLowerCase() : `${n} ${plural(l.toLowerCase())}`));
  return `${head} · ${parts.join(' · ')}`;
}

export interface SnapCandidate {
  /** The representative point for this location (any member is the same place). */
  id: PointId;
  at: Vec2;
  screen: Vec2;
  screenD: number;
  label: string;
  /** Every point merged into this location, representative first. */
  members: { id: PointId; label: string }[];
}

/** Every eligible existing point within reach of the finger, merged by location, nearest first. */
export function snapCandidates(doc: Doc, view: ViewTransform, screenPos: Vec2, exclude?: ReadonlySet<PointId>): SnapCandidate[] {
  const raw: { p: Point; at: Vec2; screen: Vec2; d: number; label?: string }[] = [];
  for (const p of doc.points) {
    if (p.kind === 'free' && p.hidden) continue;
    if (exclude?.has(p.id)) continue;
    if (!isPointTargetEligibleIn(doc, p)) continue;
    if (isPointOrphanedByTrim(doc, p.id)) continue;
    const at = resolvePoint(doc, p.id);
    const screen = worldToScreen(view, at);
    const d = dist(screen, screenPos);
    if (d > POINT_HIT_RADIUS) continue;
    // Phase 5.12f: a plain point on a curve that other geometry now crosses is, to the participant,
    // an intersection.
    const crossing = p.kind === 'on-curve' && !p.arcEnd && isCrossingPoint(doc, p.id);
    raw.push({ p, at, screen, d, ...(crossing ? { label: 'Intersection' } : {}) });
  }
  return clusterByLocation(raw);
}

/** Phase 5.8: merges points within COINCIDENT_PX of each other on screen into one location. */
export function clusterByLocation(raw: { p: Point; at: Vec2; screen: Vec2; d: number; label?: string }[]): SnapCandidate[] {
  raw.sort((a, b) => a.d - b.d);
  const groups: { items: typeof raw; screen: Vec2 }[] = [];
  for (const r of raw) {
    const g = groups.find((x) => dist(x.screen, r.screen) <= COINCIDENT_PX);
    if (g) g.items.push(r);
    else groups.push({ items: [r], screen: r.screen });
  }
  return groups.map(({ items }) => {
    const ordered = [...items].sort((a, b) => kindRank(a.p) - kindRank(b.p) || a.d - b.d);
    const rep = ordered[0]!;
    const members = ordered.map((x) => ({ id: x.p.id, label: x.label ?? snapLabel(x.p) }));
    return { id: rep.p.id, at: rep.at, screen: rep.screen, screenD: Math.min(...items.map((x) => x.d)), label: mergedLabel(members.map((m) => m.label)), members };
  });
}

/** A PointHit, plus (Phase 5.8) the merged label of the location it stands for. */
export type SnapHit = PointHit & { label?: string };

/** One gesture's targeting, with memory: what it chose last and what it was choosing between. */
export class SnapTracker {
  private doc: Doc;
  private current: PointId | null = null;
  candidates: SnapCandidate[] = [];
  /** Phase 5.8: set when the last pick landed on a curve with no point there. */
  noPoint: Omit<NoPointHint, 'until'> | null = null;

  constructor(doc: Doc) {
    this.doc = doc;
  }

  pick(view: ViewTransform, screenPos: Vec2): SnapHit | null {
    let cands = snapCandidates(this.doc, view, screenPos);
    this.noPoint = null;
    const onCurve = this.onCurveWithoutPoint(view, screenPos, cands[0]);
    if (onCurve) {
      cands = [];
      this.candidates = cands;
      this.current = null;
      // Free on curve allows a new point exactly here; otherwise say plainly there is none.
      if (this.doc.pointTargets.free) return onCurve.hit;
      this.noPoint = onCurve.info;
      return null;
    }
    this.candidates = cands;
    if (cands.length === 0) {
      this.current = null;
      if (onCurve) return null;
      // Nothing explicit here: the usual implicit on-curve projection, when Free on curve allows it.
      return pickPointTarget(this.doc, view, screenPos);
    }
    let chosen = cands[0]!;
    const held = this.current ? cands.find((c) => c.members.some((m) => m.id === this.current)) : undefined;
    if (held && held.screenD - chosen.screenD < SWITCH_PX) chosen = held;
    this.current = chosen.id;
    return { id: chosen.id, at: chosen.at, screenD: chosen.screenD, label: chosen.label };
  }

  /**
   * The tap is right on a curve, and no candidate point is close enough to it — relative to the
   * length of the segment it touched — to be what was meant. Returns what to tell the participant.
   */
  private onCurveWithoutPoint(view: ViewTransform, screenPos: Vec2, nearest: SnapCandidate | undefined): { info: Omit<NoPointHint, 'until'>; hit: SnapHit } | null {
    const doc = this.doc;
    const curve = curveCandidatesAt(doc, view, screenPos, ON_CURVE_PX)[0];
    if (!curve) return null;
    const isCircle = curve.entity.kind === 'circle';
    const group = groupContainingParam(deriveSelectableGroups(doc, curve.entity), curve.param, isCircle);
    if (!group) return null;
    const g = resolveEntityGeom(doc, curve.entity);
    let span = group.toParam - group.fromParam;
    if (isCircle && span <= 0) span += Math.PI * 2;
    const lenPx = g.kind === 'line' ? dist(worldToScreen(view, resolvePoint(doc, group.from)), worldToScreen(view, resolvePoint(doc, group.to))) : g.radius * view.zoom * span;
    if (nearest && nearest.screenD <= Math.max(ON_CURVE_POINT_MIN_PX, ON_CURVE_POINT_SHARE * lenPx)) return null;
    let frac = (curve.param - group.fromParam) / (span || 1);
    if (isCircle) {
      let d = curve.param - group.fromParam;
      d = ((d % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      frac = d / (span || 1);
    }
    const nearMiddle = Math.abs(frac - 0.5) <= MIDPOINT_SHARE && group.from !== group.to;
    const midParam = group.fromParam + span / 2;
    const midAt =
      g.kind === 'line'
        ? { x: g.a.x + (g.b.x - g.a.x) * midParam, y: g.a.y + (g.b.y - g.a.y) * midParam }
        : { x: g.centre.x + Math.cos(midParam) * g.radius, y: g.centre.y + Math.sin(midParam) * g.radius };
    const worldAt =
      g.kind === 'line'
        ? { x: g.a.x + (g.b.x - g.a.x) * curve.param, y: g.a.y + (g.b.y - g.a.y) * curve.param }
        : { x: g.centre.x + Math.cos(curve.param) * g.radius, y: g.centre.y + Math.sin(curve.param) * g.radius };
    return {
      info: {
        anchorScreen: screenPos,
        at: worldAt,
        divide: nearMiddle
          ? { label: 'Segment', scope: 'segment', entityId: curve.entity.id, kind: 'segment', from: group.from, to: group.to, fromParam: group.fromParam, toParam: group.toParam }
          : null,
        midAt: nearMiddle ? midAt : null,
      },
      hit: { id: null, at: worldAt, screenD: curve.d, implicit: { host: curve.entity.id, param: curve.param } },
    };
  }

  /** The genuinely different locations too close to call from the last pick — null when clear.
   * Phase 5.8: "too close to call" is also relative — a tap that lands right on one location
   * (within a pixel or two) while every other is several times farther away is clear, even if
   * those others are only a few pixels off. */
  ambiguous(): SnapCandidate[] | null {
    const c = this.candidates;
    if (c.length < 2) return null;
    const d1 = c[0]!.screenD;
    const close = c.filter((x) => x.screenD - d1 < AMBIGUITY_PX && x.screenD < d1 * RELATIVE_CLEAR + ABSOLUTE_CLEAR_PX);
    return close.length > 1 ? close.slice(0, 4) : null;
  }

  labelOf(id: PointId | null): string | null {
    if (!id) return null;
    const c = this.candidates.find((x) => x.members.some((m) => m.id === id));
    if (c) return c.label;
    const p = this.doc.points.find((q) => q.id === id);
    return p ? snapLabel(p) : null;
  }
}

const NO_POINT_MS = 3200;
const NO_POINT_WITH_OFFER_MS = 6500;

/** Phase 5.8: show "No point here yet" (with the Divide ÷2 offer when it applies). */
export function showNoPoint(controller: AppController, info: Omit<NoPointHint, 'until'>): void {
  const record: NoPointHint = { ...info, until: performance.now() + (info.divide ? NO_POINT_WITH_OFFER_MS : NO_POINT_MS) };
  controller.noPoint = record;
  setTimeout(
    () => {
      if (controller.noPoint === record) {
        controller.noPoint = null;
        controller.notify();
      }
    },
    (info.divide ? NO_POINT_WITH_OFFER_MS : NO_POINT_MS) + 20,
  );
  controller.notify();
}

/** Phase 5.8: a press that found no point (only a bare curve) — on a plain tap, say so. */
export function noPointGesture(controller: AppController, info: Omit<NoPointHint, 'until'>): Gesture {
  return {
    onMove() {},
    onUp(_sp, wasDrag) {
      if (!wasDrag) showNoPoint(controller, info);
    },
    onCancel() {},
  };
}

/** Brief "this one" feedback on the point just used — with an optional second line. */
export function confirmSnap(controller: AppController, hit: SnapHit | null, hint?: string): void {
  if (!hit) return;
  const p = hit.id ? controller.doc.points.find((q) => q.id === hit.id) : undefined;
  const label = hit.label ?? (p ? snapLabel(p) : 'New point on curve');
  const ms = hint ? CONFIRM_WITH_HINT_MS : CONFIRM_MS;
  const record = { at: hit.at, label, hint, until: performance.now() + ms };
  controller.snapConfirm = record;
  controller.notifyView();
  setTimeout(() => {
    if (controller.snapConfirm === record) {
      controller.snapConfirm = null;
      controller.notifyView();
    }
  }, ms + 20);
}

const CONFIRM_WITH_HINT_MS = 2200;

/**
 * A released tap. Phase 5.9: never a list — the nearest location is used at once. When other
 * distinct points were about as close, the confirmation says what was taken and that holding
 * the finger there would have opened the precision loupe.
 */
export function resolveTap(controller: AppController, tracker: SnapTracker, hit: SnapHit | null, use: (hit: PointHit) => void): void {
  if (!hit) return;
  use(hit);
  confirmSnap(controller, hit, hit.id && tracker.ambiguous() ? 'Crowded here · hold to choose' : undefined);
}

// ---- Phase 5.9: press and hold on crowded points opens the precision loupe ----

const HOLD_MS = 380;
const HOLD_SLOP_PX = 7;
/** The loupe gathers the points within this of the press — about a fingertip's width. */
const HOLD_REACH_PX = 16;

/**
 * The hold half of a point-taking gesture. Call `move` from the gesture's onMove: while the loupe
 * is open it steers the loupe and returns the active choice; otherwise it returns undefined (and a
 * move beyond the slop cancels the pending hold). `release` returns the loupe's choice, or
 * undefined when the loupe never opened.
 */
export class PointHold {
  private timer: ReturnType<typeof setTimeout> | null;
  private readonly controller: AppController;
  private readonly view: ViewTransform;

  constructor(controller: AppController, view: ViewTransform, tracker: SnapTracker, press: Vec2, onOpen?: () => void) {
    this.controller = controller;
    this.view = view;
    this.timer = setTimeout(() => {
      this.timer = null;
      // The locations nearest the press (the list is nearest-first) — the finger's own neighbourhood.
      const locs = tracker.candidates.filter((l) => l.screenD <= HOLD_REACH_PX);
      // Only where there is something to choose between: two or more distinct points in reach.
      if (locs.length < 2) return;
      openPrecision(
        controller,
        view,
        locs.map((l) => ({ ref: { kind: 'existing', id: l.id }, at: l.at, label: l.label })),
        press,
      );
      onOpen?.();
    }, HOLD_MS);
    this.press = press;
  }

  private readonly press: Vec2;

  get open(): boolean {
    return !!this.controller.precision;
  }

  move(sp: Vec2): SnapHit | undefined {
    if (this.controller.precision) {
      movePrecision(this.controller, this.view, sp);
      return this.active();
    }
    if (this.timer !== null && dist(sp, this.press) > HOLD_SLOP_PX) this.clear();
    return undefined;
  }

  active(): SnapHit | undefined {
    const s = this.controller.precision;
    const c = s?.candidates[s.activeIndex];
    if (!c || c.ref.kind !== 'existing') return undefined;
    return { id: c.ref.id, at: c.at, screenD: 0, label: c.label };
  }

  release(): SnapHit | undefined {
    this.clear();
    if (!this.controller.precision) return undefined;
    const hit = this.active();
    closePrecision(this.controller, true);
    return hit;
  }

  cancel(): void {
    this.clear();
    if (this.controller.precision) closePrecision(this.controller, false);
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
