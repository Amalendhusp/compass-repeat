// Intersection: an exploratory composition space — a few copies of the construction, each moved and
// turned freely, to discover the forms their lines make where they cross. Entirely its own: Repeat's
// lattice (doc.repeat) is never read or changed here.
//
// Square / Triangle / Hexagon only choose the starting arrangement — how many constructions, and
// their first places (the corners of one lattice cell, from the same default spacing Repeat starts
// with) — never a constraint afterwards.
//
// Spread: every arrangement keeps a reference — each construction's reference centre and the
// reference group's centre (the mean of those centres, fixed when the reference is set). What is
// shown is centre + spread × (reference − centre): Spread pulls the centres in or pushes them out
// proportionally, never changing sizes or rotations. Moving a construction at any Spread updates its
// reference so that it stays exactly where it was put (shown = centre + spread × reference offset),
// and the group centre stays put — so nothing ever drifts. Setting the reference makes what is
// shown now the 100% arrangement (nothing moves), with its own mean as the new centre.

import type { Doc, IntersectionLayout, Vec2 } from '../model/types.ts';
import { defaultLatticeVectors, motifRadius, suggestedFamily, type InstancePose } from './lattice.ts';

export type IntersectionFamily = IntersectionLayout['family'];

/** Analysis colours, by copy — the same copy keeps its colour across starting arrangements. */
const DEFAULT_COLOURS: Record<string, string> = {
  '0,0': '#1E2A36', // the primary: ink
  '1,0': '#C6402C', // red
  '0,1': '#2F6FB0', // blue
  '1,1': '#3F8B5E', // green
};

/** The constructions of each starting arrangement: Square 4 (the corners of a square cell), Triangle
 * and Hexagon 3 (a compact three-cell group). Keys are the lattice offsets they start at. */
const SLOTS: Record<IntersectionFamily, { i: number; j: number }[]> = {
  square: [{ i: 0, j: 0 }, { i: 1, j: 0 }, { i: 0, j: 1 }, { i: 1, j: 1 }],
  triangle: [{ i: 0, j: 0 }, { i: 1, j: 0 }, { i: 0, j: 1 }],
  hex: [{ i: 0, j: 0 }, { i: 1, j: 0 }, { i: 0, j: 1 }],
};

const mean = (ps: Vec2[]): Vec2 => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length });

/** A fresh starting arrangement: lattice-cell places at Repeat's default spacing, no rotation, as
 * its own reference at 100%. */
export function seedLayout(doc: Doc, family: IntersectionFamily): IntersectionLayout {
  const { a, b } = defaultLatticeVectors(doc, family);
  const pieces = SLOTS[family].map(({ i, j }) => ({ key: `${i},${j}`, x: a.x * i + b.x * j, y: a.y * i + b.y * j, rotation: 0 }));
  return { family, pieces, centre: mean(pieces), spread: 1 };
}

/** The artwork's arrangement — or, until one has been made, the starting one its frame suggests. */
export function layoutOf(doc: Doc): IntersectionLayout {
  return doc.intersection?.layout ?? seedLayout(doc, suggestedFamily(doc.frame.kind));
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
}

/** Every construction as shown — including a live move/turn (`controller.intersectionDrag`) and a
 * Spread being dragged (`spreadDraft`), neither yet committed. */
export function intersectionCopies(doc: Doc, live?: { drag?: { key: string; x: number; y: number; rotation: number } | null; spread?: number | null }): IntersectionCopy[] {
  const layout = layoutOf(doc);
  const saved = doc.intersection?.copies ?? {};
  const spread = live?.spread ?? layout.spread;
  return layout.pieces.map((piece, n) => {
    const drag = live?.drag?.key === piece.key ? live.drag : null;
    const at = drag ? { x: drag.x, y: drag.y } : shownAt(layout, piece, spread);
    const [i, j] = piece.key.split(',').map(Number) as [number, number];
    return {
      key: piece.key,
      label: n === 0 ? 'Primary' : `Copy ${n}`,
      colour: saved[piece.key]?.colour ?? DEFAULT_COLOURS[piece.key] ?? '#1E2A36',
      extensions: saved[piece.key]?.extensions ?? true,
      pose: { i, j, translate: at, rotation: drag ? drag.rotation : piece.rotation, mirror: false },
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
 * the mean of the centres. */
export function asReference(layout: IntersectionLayout): IntersectionLayout {
  const pieces = layout.pieces.map((p) => ({ ...p, ...shownAt(layout, p, layout.spread) }));
  return { ...layout, pieces, centre: mean(pieces), spread: 1 };
}

export const SPREAD_MIN = 0.25;
export const SPREAD_MAX = 2.5;

export function withSpread(layout: IntersectionLayout, spread: number): IntersectionLayout {
  return { ...layout, pieces: layout.pieces.map((p) => ({ ...p })), spread: Math.min(SPREAD_MAX, Math.max(SPREAD_MIN, spread)) };
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
