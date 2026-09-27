// Phase 5.12b: the circle inscribed in the triangle formed by three lines — the analytic
// incircle, so the result is tangent to all three lines by construction, not by approximation.
//
// Each line is taken as the infinite mathematical line through its entity's two defining points
// (spec: "the underlying infinite mathematical lines"). Three pairwise non-parallel, non-concurrent
// lines bound exactly one triangle; its incentre is equidistant from all three lines.

import type { Vec2 } from '../model/types.ts';

/** Two lines closer to parallel than this (sine of the angle between them, ≈0.5°) can't bound a
 * usable triangle — their crossing lies too far away to be meaningful or numerically stable. */
const PARALLEL_SIN = Math.sin((0.5 * Math.PI) / 180);
/** A triangle thinner than this (inradius / longest side) is treated as three concurrent lines. */
const MIN_SHAPE = 1e-4;

export interface InfiniteLine {
  a: Vec2;
  b: Vec2;
}

export interface Incircle {
  centre: Vec2;
  radius: number;
  /** The tangency point on each input line, in input order: the foot of the perpendicular from
   * the centre. */
  feet: [Vec2, Vec2, Vec2];
  /** Each foot as a parameter along its line (0 at `a`, 1 at `b`). */
  params: [number, number, number];
  /** The triangle's vertices: the crossing of the other two lines, opposite each input line. */
  vertices: [Vec2, Vec2, Vec2];
}

export type IncircleResult = { ok: true; circle: Incircle } | { ok: false; reason: 'same-line' | 'parallel' | 'concurrent' };

function unitDir(l: InfiniteLine): Vec2 | null {
  const dx = l.b.x - l.a.x;
  const dy = l.b.y - l.a.y;
  const len = Math.hypot(dx, dy);
  return len < 1e-12 ? null : { x: dx / len, y: dy / len };
}

/** Where two (non-parallel) infinite lines cross. */
function cross2(l1: InfiniteLine, d1: Vec2, l2: InfiniteLine, d2: Vec2): Vec2 {
  const denom = d1.x * d2.y - d1.y * d2.x;
  const t = ((l2.a.x - l1.a.x) * d2.y - (l2.a.y - l1.a.y) * d2.x) / denom;
  return { x: l1.a.x + d1.x * t, y: l1.a.y + d1.y * t };
}

function foot(l: InfiniteLine, d: Vec2, p: Vec2): { at: Vec2; param: number } {
  const s = (p.x - l.a.x) * d.x + (p.y - l.a.y) * d.y; // distance along the line from a
  const at = { x: l.a.x + d.x * s, y: l.a.y + d.y * s };
  const len = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
  return { at, param: s / len };
}

/** `minRadius` (world units) is the smallest circle worth making — the caller's drawing tolerance;
 * three lines crossing almost at one point bound a real but microscopic triangle, treated as concurrent. */
export function incircleOfLines(lines: [InfiniteLine, InfiniteLine, InfiniteLine], minRadius = 0): IncircleResult {
  const dirs = lines.map(unitDir);
  if (dirs.some((d) => d === null)) return { ok: false, reason: 'concurrent' };
  const [d0, d1, d2] = dirs as [Vec2, Vec2, Vec2];
  const [l0, l1, l2] = lines;

  const sinBetween = (u: Vec2, v: Vec2) => Math.abs(u.x * v.y - u.y * v.x);
  const pairs: [Vec2, InfiniteLine, Vec2, InfiniteLine][] = [
    [d0, l0, d1, l1],
    [d1, l1, d2, l2],
    [d2, l2, d0, l0],
  ];
  for (const [u, lu, v, lv] of pairs) {
    if (sinBetween(u, v) >= PARALLEL_SIN) continue;
    // Parallel — and if also on top of each other, the same line was chosen twice.
    const offset = Math.abs((lv.a.x - lu.a.x) * u.y - (lv.a.y - lu.a.y) * u.x);
    return { ok: false, reason: offset < 1e-9 * (1 + Math.hypot(lu.a.x, lu.a.y)) ? 'same-line' : 'parallel' };
  }

  // Vertex opposite each line = the crossing of the other two.
  const A = cross2(l1, d1, l2, d2); // opposite line 0
  const B = cross2(l2, d2, l0, d0); // opposite line 1
  const C = cross2(l0, d0, l1, d1); // opposite line 2
  const a = Math.hypot(B.x - C.x, B.y - C.y); // side on line 0
  const b = Math.hypot(C.x - A.x, C.y - A.y); // side on line 1
  const c = Math.hypot(A.x - B.x, A.y - B.y); // side on line 2
  const perimeter = a + b + c;
  const area2 = Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x));
  const radius = area2 / perimeter; // r = Area / s
  if (!(perimeter > 0) || !Number.isFinite(radius) || radius < MIN_SHAPE * Math.max(a, b, c) || radius < minRadius) return { ok: false, reason: 'concurrent' };

  const centre = { x: (a * A.x + b * B.x + c * C.x) / perimeter, y: (a * A.y + b * B.y + c * C.y) / perimeter };
  const f = lines.map((l, i) => foot(l, [d0, d1, d2][i]!, centre));

  // The incentre is equidistant from all three lines; if rounding has broken that, it isn't stable.
  for (const fi of f) {
    if (Math.abs(Math.hypot(fi.at.x - centre.x, fi.at.y - centre.y) - radius) > 1e-7 * Math.max(1, radius)) return { ok: false, reason: 'concurrent' };
  }

  return {
    ok: true,
    circle: {
      centre,
      radius,
      feet: [f[0]!.at, f[1]!.at, f[2]!.at],
      params: [f[0]!.param, f[1]!.param, f[2]!.param],
      vertices: [A, B, C],
    },
  };
}
