// Close Gap (Stage C; from the proof of concept at f75482a): explicit, designer-chosen correction of
// small gaps in Repeat.
//
// Finds small, unintended gaps between neighbouring repeated Fair outlines along a lattice arm (A or
// B), and plans the correction the designer picks — the smallest change to that ONE arm that makes
// the two chosen features meet — then validates it against the whole periodic arrangement before
// it may be applied.
//
// - Fair geometry only (no frame or construction fallback); geometric gaps, independent of stroke.
// - Every copy (i, j) sits at i·a + j·b, turned / mirrored by its parity under the rule; so changing
//   arm A by δ shifts every pair of copies Δi apart by Δi·δ and leaves Δi = 0 pairs alone. Pairs of
//   the same offset and parity type are identical, so checking one of each covers the whole field.
// - A candidate keeps the identities of its two features; candidates are grouped only when they ask
//   for the same correction, never by "globally closest".
// - Validation compares, for every copy pair the correction moves, each nearby feature pair's
//   relation before and after: new crossings, crossings lost or changed, contacts broken. Any of these
//   marks the correction invalid (it is never silently replaced by another).

import type { Doc, Vec2 } from '../model/types.ts';
import { instancePose } from './lattice.ts';
import { add, boxOf, crossingsOf, cross, insideOutline, len, motifScale, nearPairs, placeAll, relate, sub, type Feature, type Placed } from './fairGeometry.ts';
import { compositionFeatures } from './repeatComposition.ts';

export { motifScale };

// ---- copies and their pairs ----------------------------------------------------------------

/** One copy's features, placed. For an Intersect source the unit's own placements are already in
 * the features; the copy's pose is applied on top. */
function copyAt(doc: Doc, features: Feature[], i: number, j: number, repeat = doc.repeat): Placed[] {
  return placeAll(features, doc.frame.origin, instancePose(repeat, i, j));
}

/** Copy (i, j)'s Fair runs as placed by `repeat` (default: the artwork's own lattice) — for a
 * preview, which draws the current and the corrected arrangement side by side. */
export function copyFeatures(doc: Doc, i: number, j: number, repeat = doc.repeat, features = compositionFeatures(doc, 'runs')): Placed[] {
  return copyAt(doc, features, i, j, repeat);
}

/** Copies differing only in parity are drawn differently under Alternate / Mirror: one base copy of
 * each parity class (the reference, and its neighbour along the arm). */
function basesFor(doc: Doc, arm: 'a' | 'b'): [number, number][] {
  const uniform = doc.repeat.rule.kind === 'same' || doc.repeat.rule.kind === 'around';
  return uniform ? [[0, 0]] : arm === 'a' ? [[0, 0], [1, 0]] : [[0, 0], [0, 1]];
}

// ---- candidates ----------------------------------------------------------------------------

export interface GapCandidate {
  arm: 'a' | 'b';
  /** The copy pair: base copy (i, j) and its neighbour one arm along. */
  base: [number, number];
  /** Move the arm by this (artwork units): the neighbour's feature then meets the base's. */
  delta: Vec2;
  distance: number;
  /** Every feature pair asking for exactly this correction: [base feature, neighbour feature]. */
  features: [string, string][];
  /** Where they would meet: p on the base copy, q on the neighbour (current positions). */
  p: Vec2;
  q: Vec2;
  /** Every place in the base pair(s) this same correction closes a gap — for finding it by a tap. */
  sites: { base: [number, number]; p: Vec2; q: Vec2 }[];
}

export interface Tolerances {
  /** Geometric coincidence (artwork units). */
  eps: number;
  /** The largest gap treated as unintended (artwork units). */
  maxGap: number;
}
export function tolerances(doc: Doc, maxGapFraction = 0.04): Tolerances {
  const R = motifScale(doc);
  return { eps: R * 1e-7, maxGap: R * maxGapFraction };
}

/**
 * Every small positive gap between a copy and its neighbour along arm A or B (Fair features only).
 * Touching or crossing feature pairs are not gaps. Pairs asking for the same correction are one
 * candidate (e.g. a vertex's two pieces near the same edge). `nearest` reports the smallest
 * separation found up to `lookFar` — so intentional, larger spacing can be shown as excluded.
 */
export function findGaps(doc: Doc, tol = tolerances(doc), lookFar = tol.maxGap * 3) {
  // Whole Fair runs, not pieces: the end of one piece next to a neighbour is no gap when the run it
  // belongs to already crosses or touches that neighbour.
  const features = compositionFeatures(doc, 'runs');
  const candidates: GapCandidate[] = [];
  const nearest: Record<'a' | 'b', number> = { a: Infinity, b: Infinity };
  for (const arm of ['a', 'b'] as const) {
    for (const base of basesFor(doc, arm)) {
      const [i, j] = base;
      const X = copyAt(doc, features, i, j);
      const Y = arm === 'a' ? copyAt(doc, features, i + 1, j) : copyAt(doc, features, i, j + 1);
      const raw: GapCandidate[] = [];
      for (const [x, y] of nearPairs(X, Y, Math.max(tol.maxGap, lookFar))) {
        const r = relate(x.prim, y.prim, tol.eps);
        if (r.d <= tol.eps) continue; // touching or crossing: not a gap
        // A gap is empty space between the two: the point midway lies outside both shapes. (Two
        // overlapping copies also have outlines a small distance apart — inside each other; closing
        // that would push them apart, which Close Gap never does.)
        const mid = { x: (r.p.x + r.q.x) / 2, y: (r.p.y + r.q.y) / 2 };
        const across = sub(r.p, r.q);
        if (insideOutline(mid, across, X) || insideOutline(mid, across, Y)) continue;
        nearest[arm] = Math.min(nearest[arm], r.d);
        if (r.d > tol.maxGap) continue;
        raw.push({ arm, base, delta: sub(r.p, r.q), distance: r.d, features: [[x.id, y.id]], p: r.p, q: r.q, sites: [{ base, p: r.p, q: r.q }] });
      }
      // Group by correction: the same δ (to well within the gap tolerance's resolution).
      const grain = Math.max(tol.eps * 100, tol.maxGap * 1e-6);
      for (const c of raw) {
        // (Across pair types too: under Alternate / Mirror the same change to the arm can close a gap
        // in both kinds of pair — it is one correction, validated against both.)
        const same = candidates.find((o) => o.arm === c.arm && len(sub(o.delta, c.delta)) <= grain);
        if (same) {
          same.features.push(...c.features);
          same.sites.push(...c.sites);
        } else candidates.push(c);
      }
    }
  }
  candidates.sort((p, q) => p.distance - q.distance);
  return { candidates, nearest, features: features.length };
}

// ---- validation ----------------------------------------------------------------------------

/**
 * What validation can find, in three kinds:
 * - definite conflicts: `new-crossing` (two curves that did not cross now do), `crossing-lost` (a
 *   crossing disappears — slides off the end of a Fair run), `contact-broken` (a touch comes apart),
 *   `not-met` (the chosen features still do not meet);
 * - uncertain, rejected conservatively: `shallow-crossing` (the curves cross so nearly in line that
 *   a tiny shift slides the crossing a long way — it may leave its run or pass a vertex), and
 *   `crossing-jumped` (the same number of crossings, but one cannot be matched to where it could
 *   legitimately have travelled);
 * - harmless (not a conflict): an existing crossing that simply moves along its two curves — counted
 *   in `movedCrossings`.
 */
export type ConflictKind = 'new-crossing' | 'crossing-lost' | 'contact-broken' | 'not-met' | 'shallow-crossing' | 'crossing-jumped';
export const UNCERTAIN: ConflictKind[] = ['shallow-crossing', 'crossing-jumped'];
export interface Conflict {
  kind: ConflictKind;
  /** The copy pair: base copy and the other copy's offset from it. */
  base: [number, number];
  offset: [number, number];
  /** The two runs (whole Fair lines / arcs) involved. */
  features: [string, string];
  at: Vec2;
  /** A sentence for the designer. */
  why: string;
}
export interface Validation {
  ok: boolean;
  /** The selected features' distance after the correction (should be ~0). */
  metDistance: number;
  conflicts: Conflict[];
  /** Existing crossings that move along their curves but persist — harmless. */
  movedCrossings: number;
  /** Run pairs that newly touch — the closed gap itself, and any others (allowed). */
  newContacts: number;
  checkedCopyPairs: number;
  checkedFeaturePairs: number;
  /** The corrected lattice (only meaningful when ok). */
  repeat: Doc['repeat'];
}

/** Below this crossing angle (3°) a crossing's travel under a shift is too sensitive to trust. */
const SHALLOW_SIN = Math.sin((3 * Math.PI) / 180);

/**
 * The selected correction applied to a temporary lattice and checked against the whole periodic
 * arrangement: every copy pair whose relative position the correction changes (any offset within
 * reach, each parity type), Fair run against Fair run, before vs after. Crossings are matched: one
 * that moves along its curves by no more than a shift of that size can move it (the shift ÷ the
 * sine of the crossing angle) is the same crossing, moved — harmless.
 */
export function validate(doc: Doc, cand: GapCandidate, tol = tolerances(doc)): Validation {
  const runs = compositionFeatures(doc, 'runs');
  const before = doc.repeat;
  const after = { ...before, [cand.arm]: add(before[cand.arm], cand.delta) };
  const conflicts: Conflict[] = [];
  let movedCrossings = 0;
  let newContacts = 0;
  let checkedCopyPairs = 0;
  let checkedFeaturePairs = 0;

  // Reach of one copy from its lattice point; copies further apart than twice this never meet.
  const pivot = doc.frame.origin;
  let reach = 0;
  for (const f of runs) {
    const b = boxOf(f.prim);
    for (const e of [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x0, y: b.y1 }, { x: b.x1, y: b.y1 }]) reach = Math.max(reach, len(sub(e, pivot)));
  }
  const step = Math.min(len(before.a), len(before.b), len(after.a), len(after.b));
  const K = Math.min(8, Math.ceil((2 * reach + tol.maxGap) / Math.max(step * 0.5, 1e-9)) + 1);
  const moved = len(cand.delta);

  for (const base of basesFor(doc, cand.arm)) {
    const [bi, bj] = base;
    const X0 = copyAt(doc, runs, bi, bj, before);
    const X1 = new Map(copyAt(doc, runs, bi, bj, after).map((x) => [x.id, x]));
    // The base copy itself moves when it lies along the arm (e.g. copy (0, 1) when B changes): a
    // crossing is matched relative to it, not to the page.
    const baseMoves = cand.arm === 'a' ? bi : bj;
    const baseShift = { x: cand.delta.x * baseMoves, y: cand.delta.y * baseMoves };
    for (let di = -K; di <= K; di++)
      for (let dj = -K; dj <= K; dj++) {
        const along = cand.arm === 'a' ? di : dj;
        if (along <= 0) continue; // unchanged by this arm (0), or the same pair counted from the other side (< 0)
        const off0 = add({ x: before.a.x * di, y: before.a.y * di }, { x: before.b.x * dj, y: before.b.y * dj });
        const off1 = add({ x: after.a.x * di, y: after.a.y * di }, { x: after.b.x * dj, y: after.b.y * dj });
        if (Math.min(len(off0), len(off1)) > 2 * reach + tol.eps) continue;
        checkedCopyPairs++;
        const Y0 = copyAt(doc, runs, bi + di, bj + dj, before);
        const Y1 = new Map(copyAt(doc, runs, bi + di, bj + dj, after).map((y) => [y.id, y]));
        const shift = along * moved; // how far this pair's relative position changes
        for (const [x0, y0] of nearPairs(X0, Y0, shift + tol.eps * 10)) {
          checkedFeaturePairs++;
          const x1 = X1.get(x0.id)!;
          const y1 = Y1.get(y0.id)!;
          const pair: [string, string] = [x0.id, y0.id];
          const where = { base, offset: [di, dj] as [number, number], features: pair };
          const c0 = crossingsOf(x0.prim, y0.prim, tol.eps);
          const c1 = crossingsOf(x1.prim, y1.prim, tol.eps);
          if (c1.length > c0.length) {
            conflicts.push({ kind: 'new-crossing', ...where, at: c1[0]!.at, why: 'two lines that did not cross would cross' });
            continue;
          }
          if (c1.length < c0.length) {
            conflicts.push({ kind: 'crossing-lost', ...where, at: c0[0]!.at, why: 'an existing crossing would slide off the end of a line and disappear' });
            continue;
          }
          // The same number: each existing crossing must still be there, moved no further than this
          // shift can move it. Matched closest pairs first, so two crossings close together are not
          // mistaken for one another.
          const shallow = c0.find((k) => k.sin < SHALLOW_SIN);
          if (shallow) {
            conflicts.push({ kind: 'shallow-crossing', ...where, at: shallow.at, why: `two lines cross at under 3°, so the crossing could slide ${(shift / Math.max(shallow.sin, 1e-9)).toFixed(1)} for a shift of ${shift.toFixed(2)} — too uncertain to accept` });
            continue;
          }
          const options: [number, number, number][] = [];
          c0.forEach((k, i0) => c1.forEach((n, i1) => {
            const d = len(sub(sub(n.at, baseShift), k.at));
            if (d <= (shift / k.sin) * 1.5 + tol.eps * 100) options.push([d, i0, i1]);
          }));
          options.sort((p, q) => p[0] - q[0]);
          const used0 = new Set<number>();
          const used1 = new Set<number>();
          for (const [, i0, i1] of options) {
            if (used0.has(i0) || used1.has(i1)) continue;
            used0.add(i0);
            used1.add(i1);
          }
          if (used0.size < c0.length) {
            const lost = c0.find((_, i0) => !used0.has(i0))!;
            conflicts.push({ kind: 'crossing-jumped', ...where, at: lost.at, why: 'a crossing cannot be matched to where it could have moved — rejected to be safe' });
            continue;
          }
          movedCrossings += c0.length;
          // Touches (no crossing): a contact must survive; a new one is fine.
          if (c0.length === 0) {
            const r0 = relate(x0.prim, y0.prim, tol.eps);
            const r1 = relate(x1.prim, y1.prim, tol.eps);
            if (r0.d <= tol.eps && r1.d > tol.eps) conflicts.push({ kind: 'contact-broken', ...where, at: r0.p, why: 'two lines that touch would come apart' });
            else if (r0.d > tol.eps && r1.d <= tol.eps) newContacts++;
          }
        }
      }
  }

  // The selected features (runs) meet.
  const [bi, bj] = cand.base;
  const X1 = copyAt(doc, runs, bi, bj, after);
  const Y1 = cand.arm === 'a' ? copyAt(doc, runs, bi + 1, bj, after) : copyAt(doc, runs, bi, bj + 1, after);
  const [fx, fy] = cand.features[0]!;
  const met = relate(X1.find((x) => x.id === fx)!.prim, Y1.find((y) => y.id === fy)!.prim, tol.eps);
  if (met.d > tol.eps) conflicts.push({ kind: 'not-met', base: cand.base, offset: cand.arm === 'a' ? [1, 0] : [0, 1], features: [fx, fy], at: met.p, why: 'the chosen features would still not meet' });
  return { ok: conflicts.length === 0, metDistance: met.d, conflicts, movedCrossings, newContacts, checkedCopyPairs, checkedFeaturePairs, repeat: after };
}

// ---- finding a gap by a tap ----------------------------------------------------------------

/**
 * The candidates whose gap lies near `at` (artwork units) anywhere in the pattern — not only beside
 * the reference copy: each site repeats at every copy pair of the same kind (any i, j under Uniform;
 * the same parity under Alternate / Mirror). Nearest first, at most `limit`, each with the place it
 * was found (for the magnified preview there).
 */
export function gapsNear(doc: Doc, candidates: GapCandidate[], at: Vec2, radius: number, limit = 3) {
  const { a, b } = doc.repeat;
  const det = cross(a, b);
  const uniform = doc.repeat.rule.kind === 'same' || doc.repeat.rule.kind === 'around';
  const out: { cand: GapCandidate; at: Vec2; distance: number; p: Vec2; q: Vec2 }[] = [];
  for (const cand of candidates) {
    let best: { at: Vec2; distance: number; p: Vec2; q: Vec2 } | null = null;
    for (const site of cand.sites) {
      const m = { x: (site.p.x + site.q.x) / 2, y: (site.p.y + site.q.y) / 2 };
      // The tap in lattice coordinates relative to this site; try the nearby whole steps.
      const d = sub(at, m);
      const u = Math.abs(det) > 1e-12 ? cross(d, b) / det : 0;
      const v = Math.abs(det) > 1e-12 ? cross(a, d) / det : 0;
      for (let i = Math.floor(u) - 1; i <= Math.ceil(u) + 1; i++)
        for (let j = Math.floor(v) - 1; j <= Math.ceil(v) + 1; j++) {
          if (!uniform && (((i + j) % 2) + 2) % 2 !== 0) continue; // same parity as the site's own pair
          const t = { x: a.x * i + b.x * j, y: a.y * i + b.y * j };
          const here = add(m, t);
          const dist = len(sub(at, here));
          if (dist <= radius && (!best || dist < best.distance)) best = { at: here, distance: dist, p: add(site.p, t), q: add(site.q, t) };
        }
    }
    if (best) out.push({ cand, ...best });
  }
  return out.sort((p, q) => p.distance - q.distance || p.cand.distance - q.cand.distance).slice(0, limit);
}
