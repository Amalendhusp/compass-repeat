// Intersection: an exploratory composition space — a few copies of the construction, each moved and
// turned freely, to discover the forms their lines make where they cross. Entirely its own: Repeat's
// lattice (doc.repeat) is never read or changed here.
//
// It starts with the Primary and two copies (a compact three-cell group at Repeat's default spacing);
// copies can be added (up to MAX_CONSTRUCTIONS in all), each placed in a free spot with a colour of
// its own, and removed again — never the Primary.
//
// Spread: every arrangement keeps a reference — each construction's reference centre and the
// reference group's centre (the mean of those centres, fixed when the reference is set). What is
// shown is centre + spread × (reference − centre): Spread pulls the centres in or pushes them out
// proportionally, never changing sizes or rotations. Moving a construction at any Spread updates its
// reference so that it stays exactly where it was put (shown = centre + spread × reference offset),
// and the group centre stays put — so nothing ever drifts. Setting the reference makes what is
// shown now the 100% arrangement (nothing moves), with its own mean as the new centre — for exactly
// the copies present then. Adding or removing a copy never silently redefines it: the arrangement
// is kept exactly as shown, and Spread waits for a new Reference (referenceCurrent()).

import type { Doc, IntersectionLayout, Vec2 } from '../model/types.ts';
import { defaultLatticeVectors, motifRadius, type InstancePose } from './lattice.ts';

/** The Primary's key; every copy has its own key too (colour and Extensions are kept by key). */
export const PRIMARY = '0,0';
/** Constructions in all, the Primary included. */
export const MAX_CONSTRUCTIONS = 6;

/** Analysis colours: the Primary ink, then one each for the copies, in the order they're needed. */
const PALETTE = ['#1E2A36', '#C6402C', '#2F6FB0', '#3F8B5E', '#C98A2C', '#8B3A62', '#2AA3A3'];
/** Colours of copies made before keys were arbitrary (lattice offsets), so they keep theirs. */
const LEGACY_COLOURS: Record<string, string> = { '0,0': PALETTE[0]!, '1,0': PALETTE[1]!, '0,1': PALETTE[2]!, '1,1': PALETTE[3]! };

const mean = (ps: Vec2[]): Vec2 => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length });

/** The starting arrangement: the Primary and two copies, a compact three-cell group at Repeat's
 * default spacing, no rotation — its own reference at 100%. */
export function defaultLayout(doc: Doc): IntersectionLayout {
  const { a, b } = defaultLatticeVectors(doc, 'triangle');
  const pieces = [
    { key: PRIMARY, x: 0, y: 0, rotation: 0 },
    { key: '1,0', x: a.x, y: a.y, rotation: 0 },
    { key: '0,1', x: b.x, y: b.y, rotation: 0 },
  ];
  return { pieces, centre: mean(pieces), spread: 1, referenceKeys: pieces.map((p) => p.key) };
}

/** The artwork's arrangement — or, until one has been made, the starting one. */
export function layoutOf(doc: Doc): IntersectionLayout {
  return doc.intersection?.layout ?? defaultLayout(doc);
}

/** Whether the reference is for exactly the copies present (an arrangement saved before references
 * recorded their copies counts as current). Spread applies only then. */
export function referenceCurrent(layout: IntersectionLayout): boolean {
  if (!layout.referenceKeys) return true;
  const now = layout.pieces.map((p) => p.key);
  return now.length === layout.referenceKeys.length && now.every((k) => layout.referenceKeys!.includes(k));
}

/** Where each construction's centre offset is shown at `spread`. */
function shownAt(layout: IntersectionLayout, piece: IntersectionLayout['pieces'][number], spread: number): Vec2 {
  return { x: layout.centre.x + spread * (piece.x - layout.centre.x), y: layout.centre.y + spread * (piece.y - layout.centre.y) };
}

export interface IntersectionCopy {
  key: string;
  label: string;
  colour: string;
  /** Whether this copy's extension geometry (its dashed extended lines) is drawn. Its bounded
   * construction always is. */
  extensions: boolean;
  /** Where it is shown: its frame centre moved by `translate`, turned by `rotation` about it. */
  pose: InstancePose;
  /** Locked: it stays exactly where it is — never dragged, turned, aligned onto another or spread —
   * while it stays selectable and a reference others can be aligned to. */
  locked: boolean;
}

/** Every construction as shown — including a live move/turn (`controller.intersectionDrag`) and a
 * Spread being dragged (`spreadDraft`), neither yet committed. */
export function intersectionCopies(doc: Doc, live?: { drag?: { key: string; x: number; y: number; rotation: number } | null; spread?: number | null }): IntersectionCopy[] {
  const layout = layoutOf(doc);
  const saved = doc.intersection?.copies ?? {};
  const spread = live?.spread ?? layout.spread;
  return layout.pieces.map((piece, n) => {
    const locked = !!saved[piece.key]?.locked;
    const drag = !locked && live?.drag?.key === piece.key ? live.drag : null;
    // A locked construction is not spread while Spread is being dragged (see withSpreadAround).
    const at = drag ? { x: drag.x, y: drag.y } : shownAt(layout, piece, locked ? layout.spread : spread);
    const [i, j] = piece.key.split(',').map(Number) as [number, number];
    return {
      key: piece.key,
      label: n === 0 ? 'Primary' : `Copy ${n}`,
      colour: saved[piece.key]?.colour ?? LEGACY_COLOURS[piece.key] ?? PALETTE[n % PALETTE.length]!,
      extensions: saved[piece.key]?.extensions ?? true,
      pose: { i, j, translate: at, rotation: drag ? drag.rotation : piece.rotation, mirror: false },
      locked,
    };
  });
}

/** The arrangement with one construction placed (as shown) and turned — its reference updated so it
 * stays exactly there at the current Spread; the group centre does not move. */
export function placedAt(layout: IntersectionLayout, key: string, shown: Vec2, rotation: number): IntersectionLayout {
  const s = layout.spread;
  return {
    ...layout,
    pieces: layout.pieces.map((p) =>
      p.key === key ? { key, x: layout.centre.x + (shown.x - layout.centre.x) / s, y: layout.centre.y + (shown.y - layout.centre.y) / s, rotation } : { ...p },
    ),
  };
}

/** The arrangement as shown now, made the reference: nothing moves; Spread reads 100% again, about
 * the mean of the centres, for exactly the copies present. */
export function asReference(layout: IntersectionLayout): IntersectionLayout {
  const pieces = layout.pieces.map((p) => ({ ...p, ...shownAt(layout, p, layout.spread) }));
  return { ...layout, pieces, centre: mean(pieces), spread: 1, referenceKeys: pieces.map((p) => p.key) };
}

/** Everything kept exactly where it is shown, at Spread 100% about the same centre — what a change
 * to the copy set does, so nothing moves and the old reference is not silently stretched over a
 * different set of copies. referenceKeys stays as it was: the reference is now out of date. */
function baked(layout: IntersectionLayout): IntersectionLayout {
  return { ...layout, pieces: layout.pieces.map((p) => ({ ...p, ...shownAt(layout, p, layout.spread) })), spread: 1 };
}

/** The artwork's Intersection with one more copy (if there's room): placed in a free spot next to
 * the group at Repeat's default spacing, unturned, with the first analysis colour not yet in use. */
export function withAddedCopy(doc: Doc): NonNullable<Doc['intersection']> | null {
  const layout = baked(layoutOf(doc));
  if (layout.pieces.length >= MAX_CONSTRUCTIONS) return null;
  const shown = intersectionCopies(doc);
  const spacing = Math.hypot(defaultLatticeVectors(doc, 'triangle').a.x, defaultLatticeVectors(doc, 'triangle').a.y);
  const centres = shown.map((c) => c.pose.translate);
  const free = (p: Vec2) => centres.every((c) => Math.hypot(c.x - p.x, c.y - p.y) >= spacing * 0.9);
  // Around each construction in turn (the Primary first), the first free spot of six.
  let place: Vec2 | null = null;
  for (const c of centres) {
    for (let k = 0; k < 6 && !place; k++) {
      const p = { x: c.x + spacing * Math.cos((k * Math.PI) / 3), y: c.y + spacing * Math.sin((k * Math.PI) / 3) };
      if (free(p)) place = p;
    }
    if (place) break;
  }
  place ??= { x: centres[centres.length - 1]!.x + spacing / 2, y: centres[centres.length - 1]!.y + spacing / 2 };
  let n = 1;
  while (layout.pieces.some((p) => p.key === `c${n}`)) n++;
  const key = `c${n}`;
  const used = new Set(shown.map((c) => c.colour.toLowerCase()));
  const colour = PALETTE.find((c) => !used.has(c.toLowerCase())) ?? PALETTE[1]!;
  return {
    copies: { ...(doc.intersection?.copies ?? {}), [key]: { colour } },
    layout: { ...layout, pieces: [...layout.pieces, { key, x: place.x, y: place.y, rotation: 0 }] },
  };
}

/** The artwork's Intersection without one copy (never the Primary); everything else stays put. */
export function withoutCopy(doc: Doc, key: string): NonNullable<Doc['intersection']> | null {
  if (key === PRIMARY) return null;
  const layout = baked(layoutOf(doc));
  if (!layout.pieces.some((p) => p.key === key)) return null;
  const { [key]: _gone, ...copies } = doc.intersection?.copies ?? {};
  return { copies, layout: { ...layout, pieces: layout.pieces.filter((p) => p.key !== key) } };
}

export const SPREAD_MIN = 0.25;
export const SPREAD_MAX = 5;

/** The Spread slider is logarithmic — equal steps are equal ratios, so 100% sits in the middle with
 * the same fine control either side — from 25% (position 0) through 100% (500) to 500% (1000). */
export const SPREAD_SLIDER_MAX = 1000;
export function spreadToSlider(spread: number): number {
  const lg = Math.log(spread);
  return Math.round(lg < 0 ? 500 * (1 + lg / Math.log(1 / SPREAD_MIN)) : 500 * (1 + lg / Math.log(SPREAD_MAX)));
}
export function sliderToSpread(pos: number): number {
  const t = pos / 500 - 1;
  const spread = t < 0 ? Math.exp(t * Math.log(1 / SPREAD_MIN)) : Math.exp(t * Math.log(SPREAD_MAX));
  return Math.abs(spread - 1) < 0.004 ? 1 : spread; // a little detent at 100%
}

export function withSpread(layout: IntersectionLayout, spread: number): IntersectionLayout {
  return { ...layout, pieces: layout.pieces.map((p) => ({ ...p })), spread: Math.min(SPREAD_MAX, Math.max(SPREAD_MIN, spread)) };
}

/** Spread changed for the unlocked constructions only: each locked one's reference is re-stated so
 * it stays exactly where it is shown (Spread then moves the others in or out about the same centre —
 * no longer a uniform scaling of the whole group, which is what locking one means). */
export function withSpreadAround(doc: Doc, spread: number): IntersectionLayout {
  const layout = layoutOf(doc);
  const next = withSpread(layout, spread);
  const copies = doc.intersection?.copies ?? {};
  return {
    ...next,
    pieces: next.pieces.map((p) => {
      if (!copies[p.key]?.locked) return p;
      const shown = shownAt(layout, p, layout.spread);
      return { ...p, x: next.centre.x + (shown.x - next.centre.x) / next.spread, y: next.centre.y + (shown.y - next.centre.y) / next.spread };
    }),
  };
}

/** Whether a construction is locked in place. */
export function isLocked(doc: Doc, key: string): boolean {
  return !!doc.intersection?.copies?.[key]?.locked;
}

/** The artwork's Intersection with one construction locked or unlocked (nothing moves). */
export function withLock(doc: Doc, key: string, locked: boolean): NonNullable<Doc['intersection']> {
  const copies = { ...(doc.intersection?.copies ?? {}) };
  const own = { ...copies[key] };
  if (locked) own.locked = true;
  else delete own.locked;
  copies[key] = own;
  return { copies, layout: structuredClone(layoutOf(doc)) };
}

/** The world-space bounds of the constructions as shown — what Intersection's Fit frames. */
export function intersectionBounds(doc: Doc): { minX: number; minY: number; maxX: number; maxY: number } {
  const pivot = doc.frame.origin;
  const r = motifRadius(doc);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { pose } of intersectionCopies(doc)) {
    const cx = pivot.x + pose.translate.x;
    const cy = pivot.y + pose.translate.y;
    minX = Math.min(minX, cx - r);
    maxX = Math.max(maxX, cx + r);
    minY = Math.min(minY, cy - r);
    maxY = Math.max(maxY, cy + r);
  }
  return { minX, minY, maxX, maxY };
}

/** The artwork's Intersection settings with one copy's colour or extensions changed. */
export function withCopySetting(doc: Doc, key: string, patch: { colour?: string; extensions?: boolean }): NonNullable<Doc['intersection']> {
  const copies = { ...(doc.intersection?.copies ?? {}) };
  copies[key] = { ...copies[key], ...patch };
  return { ...doc.intersection, copies };
}

/** The artwork's Intersection settings with a new arrangement. */
export function withLayout(doc: Doc, layout: IntersectionLayout): NonNullable<Doc['intersection']> {
  return { copies: { ...(doc.intersection?.copies ?? {}) }, layout };
}
