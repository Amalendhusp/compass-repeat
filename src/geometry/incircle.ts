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

// ---- Phase 5.13b: Between edges — an ordered chain of supporting lines, closed on purpose ----
//
// Each chosen edge stands for its whole supporting line, with the place it was tapped. The chain's
// order is the polygon's order: consecutive lines meet at its corners (L1∩L2, L2∩L3, …), and only
// when the first edge is tapped again does the last line close it (Ln∩L1). A corner counts only
// where it is really drawn from the tap along that line (the caller's `reachable`: inside the
// line's own span, through no trimmed piece — other curves crossing it do not matter), each tap
// must lie between its two corners, and the polygon must be convex and wind once. A circle inside
// it tangent to every side exists only for a tangential polygon (every triangle; squares, rhombi,
// kites, regular polygons…) — it is found exactly or not at all, never fitted. Three lines use the
// triangle incircle above, so a triangle's circle is the same to the last bit as before.

/** Residual tangency error allowed, relative to the polygon's size: exact up to floating-point
 * rounding of constructed geometry (~1e-13), far below anything a drawing could show. */
const EXACT_REL = 1e-9;

export interface ChainInput {
  /** The whole supporting line (its entity's two defining points); feet and params refer to it. */
  line: InfiniteLine;
  /** Where it was tapped. */
  tap: Vec2;
}

export interface EdgeCircle {
  centre: Vec2;
  radius: number;
  /** The tangency point on each input line, in input order. */
  feet: Vec2[];
  /** Each foot as a parameter along its line (0 at `a`, 1 at `b`). */
  params: number[];
  /** The polygon's corners, in chain order (L1∩L2, L2∩L3, …, Ln∩L1). */
  vertices: Vec2[];
}

export type ChainResult =
  /** A consistent chain, not closed. `corners[i]` = line i ∩ line i+1. */
  | { kind: 'open'; corners: Vec2[] }
  /** Inconsistent: two consecutive lines parallel, a corner not reached along drawn geometry, a tap
   * outside its corners, or a chain that bends both ways / winds more than once. */
  | { kind: 'invalid'; reason: 'parallel' | 'unreachable' | 'order' | 'not-convex'; corners: Vec2[] }
  /** Closed, but no single circle touches every side. */
  | { kind: 'no-circle'; polygon: Vec2[]; residual: number }
  | { kind: 'circle'; polygon: Vec2[]; circle: EdgeCircle; residual: number };

export interface ChainOptions {
  /** Close the chain (the first edge was tapped again). */
  close: boolean;
  /** Line i is really drawn all the way from its tap to `to`. */
  reachable: (i: number, to: Vec2) => boolean;
  /** How far (world units) a tap may lie beyond one of its corners and still count as between them. */
  tapSlack?: number;
  minRadius?: number;
  /** The fixed order to solve the circle in (e.g. by entity id), so tap order never changes it. */
  solveOrder?: number[];
}

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

const turnOf = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);

/** The chain's polygon (open, or closed on request) and — once closed — its exact circle. */
export function chainPolygon(lines: ChainInput[], opts: ChainOptions): ChainResult {
  const n = lines.length;
  const d = lines.map((l) => unitDir(l.line));
  if (d.some((v) => v === null)) return { kind: 'invalid', reason: 'parallel', corners: [] };
  const dir = d as Vec2[];
  const along = (i: number, p: Vec2) => (p.x - lines[i]!.line.a.x) * dir[i]!.x + (p.y - lines[i]!.line.a.y) * dir[i]!.y;
  const slack = opts.tapSlack ?? 0;
  const meet = (i: number, j: number): Vec2 | null =>
    Math.abs(dir[i]!.x * dir[j]!.y - dir[i]!.y * dir[j]!.x) < PARALLEL_SIN ? null : cross2(lines[i]!.line, dir[i]!, lines[j]!.line, dir[j]!);
  const between = (i: number, p: Vec2, q: Vec2) => {
    const t = along(i, lines[i]!.tap);
    return Math.min(along(i, p), along(i, q)) - slack < t && t < Math.max(along(i, p), along(i, q)) + slack;
  };

  // Consecutive corners, each really reached along both of its lines from their taps.
  const corners: Vec2[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const c = meet(i, i + 1);
    if (!c) return { kind: 'invalid', reason: 'parallel', corners };
    corners.push(c);
    if (!opts.reachable(i, c) || !opts.reachable(i + 1, c)) return { kind: 'invalid', reason: 'unreachable', corners };
  }
  for (let i = 1; i + 1 < n; i++) if (!between(i, corners[i - 1]!, corners[i]!)) return { kind: 'invalid', reason: 'order', corners };
  // An open chain bends one way only.
  const path = [lines[0]!.tap, ...corners, lines[n - 1]!.tap];
  let sign = 0;
  for (let i = 0; i + 2 < path.length; i++) {
    const s = Math.sign(turnOf(path[i]!, path[i + 1]!, path[i + 2]!));
    if (s && sign && s !== sign) return { kind: 'invalid', reason: 'not-convex', corners };
    if (s) sign = s;
  }
  if (!opts.close || n < 3) return { kind: 'open', corners };

  // Closing: the last line meets the first, locally.
  const last = meet(n - 1, 0);
  if (!last) return { kind: 'invalid', reason: 'parallel', corners };
  if (!opts.reachable(n - 1, last) || !opts.reachable(0, last)) return { kind: 'invalid', reason: 'unreachable', corners };
  if (!between(0, last, corners[0]!) || !between(n - 1, corners[n - 2]!, last)) return { kind: 'invalid', reason: 'order', corners };
  const polygon = [...corners, last];
  // Convex and winding once: every turn the same way, turning 360° in all.
  let total = 0;
  sign = 0;
  for (let i = 0; i < n; i++) {
    const p = polygon[(i + n - 1) % n]!;
    const q = polygon[i]!;
    const r = polygon[(i + 1) % n]!;
    const s = Math.sign(turnOf(p, q, r));
    if (!s || (sign && s !== sign)) return { kind: 'invalid', reason: 'not-convex', corners: polygon };
    sign = s;
    total += Math.atan2((q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x), (q.x - p.x) * (r.x - q.x) + (q.y - p.y) * (r.y - q.y));
  }
  if (Math.abs(Math.abs(total) - 2 * Math.PI) > 1e-6) return { kind: 'invalid', reason: 'not-convex', corners: polygon };

  // Side i runs from corner i-1 (line i-1 ∩ line i) to corner i (line i ∩ line i+1).
  const side = (i: number): [Vec2, Vec2] => [polygon[(i + n - 1) % n]!, polygon[i]!];
  const cx = polygon.reduce((s, p) => s + p.x, 0) / n;
  const cy = polygon.reduce((s, p) => s + p.y, 0) / n;
  const size = Math.max(...polygon.map((p) => Math.hypot(p.x - cx, p.y - cy))) * 2;
  // Inward normals (towards the polygon's inside).
  const normals = lines.map((l, i) => {
    let nx = -dir[i]!.y;
    let ny = dir[i]!.x;
    let o = nx * l.line.a.x + ny * l.line.a.y;
    if (nx * cx + ny * cy - o < 0) {
      nx = -nx;
      ny = -ny;
      o = -o;
    }
    return { nx, ny, o };
  });
  const order = opts.solveOrder ?? lines.map((_, i) => i);
  let centre: Vec2;
  let radius: number;
  if (n === 3) {
    const r = incircleOfLines([lines[order[0]!]!.line, lines[order[1]!]!.line, lines[order[2]!]!.line], opts.minRadius ?? 0);
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
    for (const k of order) {
      const w = normals[k]!;
      const row = [w.nx, w.ny, -1];
      for (let a = 0; a < 3; a++) {
        v[a]! += row[a]! * w.o;
        for (let b = 0; b < 3; b++) m[a]![b]! += row[a]! * row[b]!;
      }
    }
    const x = solve3(m, v);
    if (!x) return { kind: 'no-circle', polygon, residual: Infinity };
    centre = { x: x[0]!, y: x[1]! };
    radius = x[2]!;
  }
  let residual = 0;
  for (const w of normals) residual = Math.max(residual, Math.abs(w.nx * centre.x + w.ny * centre.y - w.o - radius));
  if (!(radius > 0) || residual > EXACT_REL * size || radius < (opts.minRadius ?? 0) || radius < MIN_SHAPE * size) return { kind: 'no-circle', polygon, residual };
  // Each tangency on its own side (true for a circle inside a convex polygon).
  const feet = lines.map((l, i) => foot(l.line, dir[i]!, centre));
  for (let i = 0; i < n; i++) {
    const [p, q] = side(i);
    if (distToSeg(feet[i]!.at, p, q) > EXACT_REL * size * 10) return { kind: 'no-circle', polygon, residual };
  }
  return { kind: 'circle', polygon, residual, circle: { centre, radius, feet: feet.map((f) => f.at), params: feet.map((f) => f.param), vertices: polygon } };
}
