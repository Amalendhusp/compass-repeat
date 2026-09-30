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

// ---- Phase 5.13: Between edges — one exact circle tangent to 3–6 chosen edges ----
//
// The chosen edges (visible runs of lines, each between the nearest genuine crossings) must close
// a convex polygon END TO END: each edge lies wholly on one side of every other chosen line, the
// region those sides enclose is bounded, and every side of it is exactly one chosen edge — each
// corner is where two chosen edges meet. (So three of a pentagon's five lines never "close" the
// larger triangle they happen to form; the pentagon closes when its fifth edge is chosen.) A circle
// inside such a polygon and tangent to every side exists only for a tangential polygon (every
// triangle; squares, rhombi, kites, regular polygons…) — it is found exactly or not at all, never
// fitted. Three edges use the triangle incircle above, so a triangle's circle is unchanged to the
// last bit.

/** Residual tangency error allowed, relative to the polygon's size: exact up to floating-point
 * rounding of constructed geometry (~1e-13), far below anything a drawing could show. */
const EXACT_REL = 1e-9;
/** A corner and the end of an edge are the same place within this (relative to the polygon's size). */
const CORNER_REL = 1e-7;

export interface EdgeInput {
  /** The whole line (its entity's two defining points); feet and params refer to it. */
  line: InfiniteLine;
  /** The chosen edge: the visible run of that line. */
  run: [Vec2, Vec2];
}

export interface EdgeCircle {
  centre: Vec2;
  radius: number;
  /** The tangency point on each input line, in input order. */
  feet: Vec2[];
  /** Each foot as a parameter along its line (0 at `a`, 1 at `b`). */
  params: number[];
  /** The polygon's corners, in order around it. */
  vertices: Vec2[];
}

export type EdgeSetResult =
  /** Not closed end to end (yet) — more edges may close it. */
  | { kind: 'open' }
  /** These edges can never close one convex boundary (the same line twice; an edge crossing
   * another chosen line; a line that is not one of the sides; an edge off its side). */
  | { kind: 'invalid'; reason: 'same-line' | 'crossing' | 'not-a-side' }
  /** Closed, but no single circle touches every side. */
  | { kind: 'no-circle'; polygon: Vec2[]; residual: number }
  | { kind: 'circle'; polygon: Vec2[]; circle: EdgeCircle; residual: number };

function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

/** Solves the 3×3 system m·x = v (Gaussian elimination with partial pivoting); null if singular. */
function solve3(m: number[][], v: number[]): number[] | null {
  const a = m.map((row, i) => [...row, v[i]!]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    if (Math.abs(a[p]![c]!) < 1e-300) return null;
    [a[c], a[p]] = [a[p]!, a[c]!];
    for (let r = c + 1; r < 3; r++) {
      const f = a[r]![c]! / a[c]![c]!;
      for (let k = c; k < 4; k++) a[r]![k]! -= f * a[c]![k]!;
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = a[r]![3]!;
    for (let k = r + 1; k < 3; k++) s -= a[r]![k]! * x[k]!;
    x[r] = s / a[r]![r]!;
  }
  return x;
}

/**
 * The exact circle tangent to every chosen edge's line, inside the convex polygon the edges close
 * end to end — or why there is none. Pass the edges in a fixed order (the caller sorts by entity
 * id) so the result never depends on the order they were chosen in. `minRadius` is the smallest
 * circle worth making.
 */
export function circleInEdges(edges: EdgeInput[], opts: { minRadius?: number } = {}): EdgeSetResult {
  const n = edges.length;
  if (n < 3) return { kind: 'open' };
  const dirs = edges.map((e) => unitDir(e.line));
  if (dirs.some((d) => d === null)) return { kind: 'invalid', reason: 'same-line' };
  const d = dirs as Vec2[];
  let lo = { x: Infinity, y: Infinity };
  let hi = { x: -Infinity, y: -Infinity };
  for (const e of edges) for (const p of e.run) {
    lo = { x: Math.min(lo.x, p.x), y: Math.min(lo.y, p.y) };
    hi = { x: Math.max(hi.x, p.x), y: Math.max(hi.y, p.y) };
  }
  const scale = Math.max(Math.hypot(hi.x - lo.x, hi.y - lo.y), 1e-9);
  const tol = 1e-9 * scale;

  // The same line chosen twice (parallel and on top of each other).
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(d[i]!.x * d[j]!.y - d[i]!.y * d[j]!.x) >= PARALLEL_SIN) continue;
      const off = Math.abs((edges[j]!.line.a.x - edges[i]!.line.a.x) * d[i]!.y - (edges[j]!.line.a.y - edges[i]!.line.a.y) * d[i]!.x);
      if (off < 1e-9 * (1 + Math.hypot(edges[i]!.line.a.x, edges[i]!.line.a.y))) return { kind: 'invalid', reason: 'same-line' };
    }
  }

  // Each line's inward normal: the side every other chosen edge lies on. An edge reaching across
  // another chosen line means the edges cannot be the sides of one convex polygon.
  const normals: Vec2[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < n; i++) {
    let nx = -d[i]!.y;
    let ny = d[i]!.x;
    let o = nx * edges[i]!.line.a.x + ny * edges[i]!.line.a.y;
    const val = (p: Vec2) => nx * p.x + ny * p.y - o;
    let sum = 0;
    for (let j = 0; j < n; j++) if (j !== i) sum += val({ x: (edges[j]!.run[0].x + edges[j]!.run[1].x) / 2, y: (edges[j]!.run[0].y + edges[j]!.run[1].y) / 2 });
    if (sum < 0) {
      nx = -nx;
      ny = -ny;
      o = -o;
    }
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const [p, q] = edges[j]!.run;
      const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      if (val(m) <= tol || val(p) < -tol || val(q) < -tol) return { kind: 'invalid', reason: 'crossing' };
    }
    normals.push({ x: nx, y: ny });
    offsets.push(o);
  }

  // Bounded: the inward normals leave no gap of half a turn or more.
  const angles = normals.map((v) => Math.atan2(v.y, v.x)).sort((a, b) => a - b);
  let maxGap = angles[0]! + Math.PI * 2 - angles[n - 1]!;
  for (let k = 1; k < n; k++) maxGap = Math.max(maxGap, angles[k]! - angles[k - 1]!);
  if (maxGap >= Math.PI - 1e-9) return { kind: 'open' };

  // The polygon: every crossing of two chosen lines that lies inside all the half-planes.
  const inside = (p: Vec2) => normals.every((v, k) => v.x * p.x + v.y * p.y - offsets[k]! >= -tol);
  const corners: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(d[i]!.x * d[j]!.y - d[i]!.y * d[j]!.x) < PARALLEL_SIN) continue;
      const p = cross2(edges[i]!.line, d[i]!, edges[j]!.line, d[j]!);
      if (inside(p) && !corners.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= tol)) corners.push(p);
    }
  }
  const cx = corners.reduce((s, p) => s + p.x, 0) / corners.length;
  const cy = corners.reduce((s, p) => s + p.y, 0) / corners.length;
  const polygon = corners.sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));

  // Every chosen line is a side (two distinct corners on it) with its edge on it; closed when every
  // side is exactly its edge — end to end, corner to corner.
  const sides: [Vec2, Vec2][] = [];
  let closed = true;
  const cornerTol = CORNER_REL * scale;
  for (let i = 0; i < n; i++) {
    const along = (p: Vec2) => (p.x - edges[i]!.line.a.x) * d[i]!.x + (p.y - edges[i]!.line.a.y) * d[i]!.y;
    const on = polygon.filter((p) => Math.abs(normals[i]!.x * p.x + normals[i]!.y * p.y - offsets[i]!) <= tol * 10);
    if (on.length < 2) return { kind: 'invalid', reason: 'not-a-side' };
    on.sort((p, q) => along(p) - along(q));
    const p = on[0]!;
    const q = on[on.length - 1]!;
    if (along(q) - along(p) <= tol) return { kind: 'invalid', reason: 'not-a-side' };
    const r0 = Math.min(along(edges[i]!.run[0]), along(edges[i]!.run[1]));
    const r1 = Math.max(along(edges[i]!.run[0]), along(edges[i]!.run[1]));
    if (Math.min(r1, along(q)) - Math.max(r0, along(p)) <= 0.01 * (r1 - r0)) return { kind: 'invalid', reason: 'not-a-side' };
    if (Math.abs(r0 - along(p)) > cornerTol || Math.abs(r1 - along(q)) > cornerTol) closed = false;
    sides.push([p, q]);
  }
  if (!closed) return { kind: 'open' };

  // The circle: equidistant (distance r) from every line, on the inner side of each.
  let centre: Vec2;
  let radius: number;
  if (n === 3) {
    const r = incircleOfLines([edges[0]!.line, edges[1]!.line, edges[2]!.line], opts.minRadius ?? 0);
    if (!r.ok) return { kind: 'no-circle', polygon, residual: Infinity };
    centre = r.circle.centre;
    radius = r.circle.radius;
  } else {
    const m = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const v = [0, 0, 0];
    for (let k = 0; k < n; k++) {
      const row = [normals[k]!.x, normals[k]!.y, -1];
      for (let a = 0; a < 3; a++) {
        v[a]! += row[a]! * offsets[k]!;
        for (let b = 0; b < 3; b++) m[a]![b]! += row[a]! * row[b]!;
      }
    }
    const x = solve3(m, v);
    if (!x) return { kind: 'no-circle', polygon, residual: Infinity };
    centre = { x: x[0]!, y: x[1]! };
    radius = x[2]!;
  }
  let residual = 0;
  for (let k = 0; k < n; k++) residual = Math.max(residual, Math.abs(normals[k]!.x * centre.x + normals[k]!.y * centre.y - offsets[k]! - radius));
  const polyScale = Math.max(...polygon.map((p) => Math.hypot(p.x - cx, p.y - cy))) * 2;
  if (!(radius > 0) || residual > EXACT_REL * polyScale || radius < (opts.minRadius ?? 0) || radius < MIN_SHAPE * polyScale) {
    return { kind: 'no-circle', polygon, residual };
  }

  // Each tangency on its own side of the polygon (true for a circle inside a convex polygon).
  const feet = edges.map((e, i) => foot(e.line, d[i]!, centre));
  for (let i = 0; i < n; i++) {
    const [p, q] = sides[i]!;
    if (distToSeg(feet[i]!.at, p, q) > tol * 10 + EXACT_REL * polyScale) return { kind: 'no-circle', polygon, residual };
  }
  return {
    kind: 'circle',
    polygon,
    residual,
    circle: { centre, radius, feet: feet.map((f) => f.at), params: feet.map((f) => f.param), vertices: polygon },
  };
}
