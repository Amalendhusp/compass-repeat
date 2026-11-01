// Close Gap in Repeat (Stage C): the session state of the explicit action, and the lookup a tap makes.
//
// Close Gap → tap near a gap → the nearest VALID gap there is previewed at once, with up to two more
// nearby as alternatives → Apply (one Undo step) or Cancel (nothing changes). The lattice handles stay
// completely free throughout: dragging one simply returns to picking. Nothing about the artwork changes
// before Apply — the preview is drawn from a corrected copy of the lattice that lives only here.

import type { Doc, RepeatSystem, Vec2 } from '../model/types.ts';
import { findGaps, gapsNear, tolerances, validate, type GapCandidate, type Validation } from '../geometry/closeGap.ts';

/** One gap found near the tap, ready to preview. */
export interface LocalGap {
  cand: GapCandidate;
  /** Where the gap is, near the tap (artwork units): its middle, and the two points that will meet. */
  at: Vec2;
  p: Vec2;
  q: Vec2;
  /** The copy the gap's base side belongs to there (lattice indices). */
  copy: [number, number];
  /** The lattice with the one arm corrected — what Apply would make. */
  repeat: RepeatSystem;
}

export type CloseGapState = { phase: 'pick' } | { phase: 'preview'; local: LocalGap[]; index: number };

interface Checked {
  valid: { cand: GapCandidate; v: Validation }[];
  invalid: { cand: GapCandidate; v: Validation }[];
}
// Worked out once per artwork state (a commit makes a new Doc): candidates and their validation.
const cache = new WeakMap<Doc, Checked>();

function checked(doc: Doc): Checked {
  let c = cache.get(doc);
  if (!c) {
    const tol = tolerances(doc);
    c = { valid: [], invalid: [] };
    for (const cand of findGaps(doc, tol).candidates) {
      const v = validate(doc, cand, tol);
      (v.ok ? c.valid : c.invalid).push({ cand, v });
    }
    cache.set(doc, c);
  }
  return c;
}

/**
 * The gaps near a tap at `at` (artwork units) within `reach`: the valid ones, nearest first, at most
 * three (each with its corrected lattice), and — when none is valid — why the nearby ones were turned
 * down.
 */
export function gapsAtTap(doc: Doc, at: Vec2, reach: number): { local: LocalGap[]; rejected: string[] } {
  const c = checked(doc);
  const byCand = new Map(c.valid.map((x) => [x.cand, x.v]));
  const local = gapsNear(doc, c.valid.map((x) => x.cand), at, reach, 3).map((g) => ({
    cand: g.cand,
    at: g.at,
    p: g.p,
    q: g.q,
    copy: g.copy,
    repeat: byCand.get(g.cand)!.repeat,
  }));
  const why = new Map(c.invalid.map((x) => [x.cand, x.v.conflicts[0]?.why ?? 'it would change the pattern elsewhere']));
  const rejected = local.length ? [] : gapsNear(doc, c.invalid.map((x) => x.cand), at, reach, 3).map((g) => why.get(g.cand)!);
  return { local, rejected };
}

/** How far the arm moves, and which. */
export function describeGap(g: LocalGap): string {
  return `${g.cand.arm.toUpperCase()} moves ${Math.hypot(g.cand.delta.x, g.cand.delta.y).toFixed(2)}`;
}

/** Where copy `copy` stands under `repeat` relative to the lattice's own origin copy — so a preview
 * can hold the tapped copy still and show its neighbour closing the gap. */
export function copyShift(g: LocalGap): Vec2 {
  const along = g.cand.arm === 'a' ? g.copy[0] : g.copy[1];
  return { x: g.cand.delta.x * along, y: g.cand.delta.y * along };
}
