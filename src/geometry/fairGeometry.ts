// Shared Fair geometry (Stage B / F0): the exact lines and arcs of Fair geometry, and what can be
// asked of them — runs, placement through instance poses, intersections, tangency and coincidence,
// inside / outside, spatial pairing, and a motif's own scale. Used by Close Gap (geometry/closeGap.ts)
// and, next, Intersect Form Development. No rendering and no state: pure functions of a Doc.
//
// Curves stay curves: a line is its two ends, an arc its centre, radius, start angle and sweep
// (increasing angle, as the renderers draw arcs) — nothing is turned into polylines.

import type { Doc, Vec2 } from '../model/types.ts';
import { resolveEntityGeom } from './kernel.ts';
import { deriveSegments, effectiveSegmentKind } from './segments.ts';
import { motifRadius, transformPoint, type InstancePose } from './lattice.ts';

export const TAU = Math.PI * 2;

// ---- primitives ------------------------------------------------------------------------------

export type Prim = { k: 'seg'; a: Vec2; b: Vec2 } | { k: 'arc'; c: Vec2; r: number; a0: number; sw: number };
/** A Fair piece or run of ONE motif, before any placement: its own id, and the Construct line or
 * circle it lies on (its source). */
export interface MotifFeature {
  id: string;
  entity: string;
  prim: Prim;
}
/** Who owns a feature (Stage D adds 'developed' — Intersect's own Primary geometry), which unit
 * member shows it, and what it came from. */
export interface FeatureSource {
  owner: 'construct' | 'developed';
  member: string;
  entity?: string;
}
/** A feature of a repeat unit, placed as its member shows it; `id` = `${member}|${motif id}`, the same
 * in every lattice copy. */
export interface Feature {
  id: string;
  prim: Prim;
  source?: FeatureSource;
}
export interface Placed {
  id: string;
  prim: Prim;
  box: { x0: number; y0: number; x1: number; y1: number };
}

export const sub = (p: Vec2, q: Vec2): Vec2 => ({ x: p.x - q.x, y: p.y - q.y });
export const add = (p: Vec2, q: Vec2): Vec2 => ({ x: p.x + q.x, y: p.y + q.y });
export const len = (v: Vec2) => Math.hypot(v.x, v.y);
export const cross = (u: Vec2, v: Vec2) => u.x * v.y - u.y * v.x;
export const dot = (u: Vec2, v: Vec2) => u.x * v.x + u.y * v.y;
export const norm = (t: number) => ((t % TAU) + TAU) % TAU;
export const onArc = (arc: { a0: number; sw: number }, t: number, slack = 0) => norm(t - arc.a0) <= arc.sw + slack || norm(t - arc.a0) >= TAU - slack;
export const arcPoint = (c: Vec2, r: number, t: number): Vec2 => ({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });

export function boxOf(p: Prim): Placed['box'] {
  if (p.k === 'seg') return { x0: Math.min(p.a.x, p.b.x), y0: Math.min(p.a.y, p.b.y), x1: Math.max(p.a.x, p.b.x), y1: Math.max(p.a.y, p.b.y) };
  const pts = [arcPoint(p.c, p.r, p.a0), arcPoint(p.c, p.r, p.a0 + p.sw)];
  for (let k = 0; k < 4; k++) if (onArc(p, (k * Math.PI) / 2)) pts.push(arcPoint(p.c, p.r, (k * Math.PI) / 2));
  return { x0: Math.min(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), x1: Math.max(...pts.map((q) => q.x)), y1: Math.max(...pts.map((q) => q.y)) };
}

/** One motif's Fair pieces, entity by entity, in the artwork's own coordinates — exact lines and
 * arcs, each with its piece key (`id`) and its line or circle (`entity`). */
export function motifPieces(doc: Doc, kind: 'fair' | 'construction' | 'extension' = 'fair'): MotifFeature[] {
  const out: MotifFeature[] = [];
  for (const e of doc.entities) {
    const g = resolveEntityGeom(doc, e);
    const segs = deriveSegments(doc, e);
    for (const seg of segs) {
      // Release R2: Construction or Extension pieces too (Intersect Fair can develop from them) — each
      // piece's state as drawn (explicit, else its default role); trimmed pieces never.
      if (kind === 'fair' ? doc.segmentStates.get(seg.key)?.state !== 'fair' : effectiveSegmentKind(doc, e, seg) !== kind) continue;
      if (g.kind === 'line') {
        if (Math.abs(seg.toParam - seg.fromParam) <= 1e-12) continue; // a zero-length piece
        const at = (t: number) => ({ x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t });
        const [t0, t1] = seg.fromParam <= seg.toParam ? [seg.fromParam, seg.toParam] : [seg.toParam, seg.fromParam];
        out.push({ entity: e.id, id: seg.key, prim: { k: 'seg', a: at(t0), b: at(t1) } });
      } else {
        if (Math.abs(seg.toParam - seg.fromParam) <= 1e-12 && segs.length > 1) continue; // zero-length
        let sw = seg.toParam - seg.fromParam;
        while (sw <= 1e-12) sw += TAU;
        out.push({ entity: e.id, id: seg.key, prim: { k: 'arc', c: { ...g.centre }, r: g.radius, a0: norm(seg.fromParam), sw: Math.min(sw, TAU) } });
      }
    }
  }
  return out;
}

/**
 * One motif's Fair RUNS: each line's or circle's consecutive Fair pieces merged into one feature (a
 * circle Fair all round is one whole circle). Validation compares crossings run against run, so a
 * crossing that slides across the boundary between two pieces of the same run is still the same
 * crossing — not one lost here and one new there.
 */
export function motifRuns(doc: Doc): MotifFeature[] {
  const byEntity = new Map<string, Prim[]>();
  for (const p of motifPieces(doc)) (byEntity.get(p.entity) ?? byEntity.set(p.entity, []).get(p.entity)!).push(p.prim);
  const runs: MotifFeature[] = [];
  for (const [entity, prims] of byEntity) {
    if (prims[0]!.k === 'seg') {
      // Along the line, from its own A: merge pieces that continue one another.
      const segs = prims as Extract<Prim, { k: 'seg' }>[];
      const o = segs[0]!.a;
      const dir = sub(segs[0]!.b, segs[0]!.a);
      const t = (q: Vec2) => dot(sub(q, o), dir);
      const sorted = segs.map((g) => (t(g.a) <= t(g.b) ? { a: g.a, b: g.b } : { a: g.b, b: g.a })).sort((p, q) => t(p.a) - t(q.a));
      let cur = { ...sorted[0]! };
      const flush = () => runs.push({ id: `${entity}#${runs.length}`, entity, prim: { k: 'seg', a: cur.a, b: cur.b } });
      for (const g of sorted.slice(1)) {
        if (len(sub(g.a, cur.b)) <= 1e-9 * (1 + len(dir))) cur.b = g.b;
        else {
          flush();
          cur = { ...g };
        }
      }
      flush();
      continue;
    }
    const arcs = (prims as Extract<Prim, { k: 'arc' }>[]).slice().sort((p, q) => p.a0 - q.a0);
    const merged: Extract<Prim, { k: 'arc' }>[] = [];
    for (const g of arcs) {
      const last = merged[merged.length - 1];
      const gapTo = last ? norm(g.a0 - (last.a0 + last.sw)) : Infinity;
      if (last && (gapTo <= 1e-9 || gapTo >= TAU - 1e-9)) last.sw = Math.min(TAU, last.sw + g.sw);
      else merged.push({ ...g });
    }
    // Round past 0: the last run continuing into the first.
    if (merged.length > 1) {
      const first = merged[0]!;
      const last = merged[merged.length - 1]!;
      const gapTo = norm(first.a0 - (last.a0 + last.sw));
      if (gapTo <= 1e-9 || gapTo >= TAU - 1e-9) {
        last.sw = Math.min(TAU, last.sw + first.sw);
        merged.shift();
      }
    }
    for (const g of merged) runs.push({ id: `${entity}#${runs.length}`, entity, prim: { ...g, sw: g.sw >= TAU - 1e-9 ? TAU : g.sw } });
  }
  return runs;
}

/** A primitive as copy `pose` shows it (pose about `pivot`, as the renderers place copies). */
export function placePrim(p: Prim, pivot: Vec2, pose: InstancePose): Prim {
  const T = (q: Vec2) => transformPoint(pivot, pose, q);
  if (p.k === 'seg') return { k: 'seg', a: T(p.a), b: T(p.b) };
  const c = T(p.c);
  // Mirroring reverses the direction of travel; the turn adds to every angle.
  const a0 = pose.mirror ? -(p.a0 + p.sw) + pose.rotation : p.a0 + pose.rotation;
  return { k: 'arc', c, r: p.r, a0: norm(a0), sw: p.sw };
}

export function placeAll(features: Feature[], pivot: Vec2, pose: InstancePose): Placed[] {
  return features.map((f) => {
    const prim = placePrim(f.prim, pivot, pose);
    return { id: f.id, prim, box: boxOf(prim) };
  });
}

// ---- distances and crossings -----------------------------------------------------------------

/** How two features relate: the closest points (p on the first, q on the second), their distance,
 * and how many times they properly cross (interior to both; touching at an end is not a crossing). */
export interface Relation {
  d: number;
  p: Vec2;
  q: Vec2;
  crossings: number;
}

export function pointSeg(p: Vec2, a: Vec2, b: Vec2): { q: Vec2; d: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  const q = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return { q, d: len(sub(p, q)) };
}
export function pointArc(p: Vec2, arc: Extract<Prim, { k: 'arc' }>): { q: Vec2; d: number } {
  const v = sub(p, arc.c);
  const t = Math.atan2(v.y, v.x);
  if (len(v) > 0 && onArc(arc, t)) {
    const q = arcPoint(arc.c, arc.r, t);
    return { q, d: len(sub(p, q)) };
  }
  const e0 = arcPoint(arc.c, arc.r, arc.a0);
  const e1 = arcPoint(arc.c, arc.r, arc.a0 + arc.sw);
  const d0 = len(sub(p, e0));
  const d1 = len(sub(p, e1));
  return d0 <= d1 ? { q: e0, d: d0 } : { q: e1, d: d1 };
}
export const endsOf = (p: Prim): Vec2[] => (p.k === 'seg' ? [p.a, p.b] : [arcPoint(p.c, p.r, p.a0), arcPoint(p.c, p.r, p.a0 + p.sw)]);
export const closestOn = (p: Vec2, f: Prim) => (f.k === 'seg' ? pointSeg(p, f.a, f.b) : pointArc(p, f));

/** Interior-ness of a hit along a feature, in length units from its nearer end. */
function interiorSeg(s: Extract<Prim, { k: 'seg' }>, t: number) {
  const l = len(sub(s.b, s.a));
  return Math.min(t, 1 - t) * l;
}
function interiorArc(arc: Extract<Prim, { k: 'arc' }>, t: number) {
  if (arc.sw >= TAU - 1e-9) return Infinity; // a whole circle has no ends
  const d = norm(t - arc.a0);
  return Math.min(d, arc.sw - d) * arc.r;
}

/** Intersections of two features: the point, how far inside each it lies (from its nearer end), and
 * whether it is a tangent touch. */
export function hits(f: Prim, g: Prim, eps: number): { at: Vec2; inF: number; inG: number; tangent: boolean }[] {
  if (f.k === 'seg' && g.k === 'seg') {
    const r = sub(f.b, f.a);
    const s = sub(g.b, g.a);
    const den = cross(r, s);
    if (Math.abs(den) <= 1e-12 * len(r) * len(s)) return []; // parallel: contact found by distance
    const t = cross(sub(g.a, f.a), s) / den;
    const u = cross(sub(g.a, f.a), r) / den;
    const tl = eps / len(r);
    const ul = eps / len(s);
    if (t < -tl || t > 1 + tl || u < -ul || u > 1 + ul) return [];
    return [{ at: { x: f.a.x + r.x * t, y: f.a.y + r.y * t }, inF: interiorSeg(f, t), inG: interiorSeg(g, u), tangent: false }];
  }
  if (f.k === 'arc' && g.k === 'seg') return hits(g, f, eps).map((h) => ({ ...h, inF: h.inG, inG: h.inF }));
  if (f.k === 'seg' && g.k === 'arc') {
    const dvec = sub(f.b, f.a);
    const m = sub(f.a, g.c);
    const A = dot(dvec, dvec);
    const B = 2 * dot(m, dvec);
    const Cc = dot(m, m) - g.r * g.r;
    const disc = B * B - 4 * A * Cc;
    if (disc < -1e-12 * A * g.r * g.r) return [];
    const root = Math.sqrt(Math.max(0, disc));
    // Tangent when the line's distance from the centre is the radius, to within eps — judged on
    // that distance itself (the half-chord, a square root, magnifies rounding a millionfold).
    const lineDist = Math.abs(cross(dvec, m)) / Math.sqrt(A);
    const tangent = Math.abs(lineDist - g.r) <= eps;
    const ts = tangent ? [-B / (2 * A)] : [(-B - root) / (2 * A), (B * -1 + root) / (2 * A)];
    const out = [];
    const tl = eps / Math.sqrt(A);
    for (const t of ts) {
      if (t < -tl || t > 1 + tl) continue;
      const at = { x: f.a.x + dvec.x * t, y: f.a.y + dvec.y * t };
      const th = Math.atan2(at.y - g.c.y, at.x - g.c.x);
      if (!onArc(g, th, eps / g.r)) continue;
      out.push({ at, inF: interiorSeg(f, t), inG: interiorArc(g, th), tangent });
    }
    return out;
  }
  // arc–arc
  const F = f as Extract<Prim, { k: 'arc' }>;
  const G = g as Extract<Prim, { k: 'arc' }>;
  const v = sub(G.c, F.c);
  const d = len(v);
  if (d <= 1e-12 * (F.r + G.r) || d > F.r + G.r + eps || d < Math.abs(F.r - G.r) - eps) return [];
  const x = (d * d + F.r * F.r - G.r * G.r) / (2 * d);
  const h2 = F.r * F.r - x * x;
  const h = Math.sqrt(Math.max(0, h2));
  // Tangent (one touching point) when the centres are r1 + r2 or |r1 − r2| apart, to within eps.
  const tangent = Math.abs(d - (F.r + G.r)) <= eps || Math.abs(d - Math.abs(F.r - G.r)) <= eps;
  const u = { x: v.x / d, y: v.y / d };
  const base = { x: F.c.x + u.x * x, y: F.c.y + u.y * x };
  const pts = tangent ? [base] : [{ x: base.x - u.y * h, y: base.y + u.x * h }, { x: base.x + u.y * h, y: base.y - u.x * h }];
  const out = [];
  for (const at of pts) {
    const t1 = Math.atan2(at.y - F.c.y, at.x - F.c.x);
    const t2 = Math.atan2(at.y - G.c.y, at.x - G.c.x);
    if (!onArc(F, t1, eps / F.r) || !onArc(G, t2, eps / G.r)) continue;
    out.push({ at, inF: interiorArc(F, t1), inG: interiorArc(G, t2), tangent });
  }
  return out;
}

/** Direction of travel along a feature at a point on it. */
export function tangentAt(f: Prim, at: Vec2): Vec2 {
  if (f.k === 'seg') return sub(f.b, f.a);
  return { x: -(at.y - f.c.y), y: at.x - f.c.x };
}
/** Proper crossings of two features, each with the sine of the angle the curves cross at. */
export function crossingsOf(f: Prim, g: Prim, eps: number): { at: Vec2; sin: number }[] {
  return hits(f, g, eps)
    .filter((h) => !h.tangent && h.inF > eps && h.inG > eps)
    .map((h) => {
      const u = tangentAt(f, h.at);
      const v = tangentAt(g, h.at);
      return { at: h.at, sin: Math.abs(cross(u, v)) / (len(u) * len(v)) };
    });
}

/** Closest approach and proper crossings of two features. */
export function relate(f: Prim, g: Prim, eps: number): Relation {
  const hs = hits(f, g, eps);
  if (hs.length) {
    const crossings = hs.filter((h) => !h.tangent && h.inF > eps && h.inG > eps).length;
    return { d: 0, p: hs[0]!.at, q: hs[0]!.at, crossings };
  }
  let best: Relation = { d: Infinity, p: f.k === 'seg' ? f.a : f.c, q: g.k === 'seg' ? g.a : g.c, crossings: 0 };
  const take = (p: Vec2, q: Vec2) => {
    const dd = len(sub(p, q));
    if (dd < best.d) best = { d: dd, p, q, crossings: 0 };
  };
  // Parallel straight pieces are equally close all along their overlap: take the middle of it (the
  // ends would put the gap's midpoint on a neighbouring edge, where inside/outside is ambiguous).
  if (f.k === 'seg' && g.k === 'seg') {
    const r = sub(f.b, f.a);
    const lr = len(r);
    if (lr > 0 && Math.abs(cross(r, sub(g.b, g.a))) <= 1e-12 * lr * len(sub(g.b, g.a))) {
      const u = { x: r.x / lr, y: r.y / lr };
      const s0 = dot(sub(g.a, f.a), u);
      const s1 = dot(sub(g.b, f.a), u);
      const lo = Math.max(0, Math.min(s0, s1));
      const hi = Math.min(lr, Math.max(s0, s1));
      if (lo <= hi) {
        const p = { x: f.a.x + u.x * ((lo + hi) / 2), y: f.a.y + u.y * ((lo + hi) / 2) };
        take(p, pointSeg(p, g.a, g.b).q);
      }
    }
  }
  for (const e of endsOf(f)) {
    const c = closestOn(e, g);
    take(e, c.q);
  }
  for (const e of endsOf(g)) {
    const c = closestOn(e, f);
    take(c.q, e);
  }
  // Interior–interior approaches involving a curve: along the line through a centre.
  if (f.k === 'arc' || g.k === 'arc') {
    const arcs = [f, g].filter((x): x is Extract<Prim, { k: 'arc' }> => x.k === 'arc');
    for (const arc of arcs) {
      const other = arc === f ? g : f;
      // the point of `other` nearest the arc's centre, and the arc point in line with it (both ways)
      const near = other.k === 'seg' ? pointSeg(arc.c, other.a, other.b).q : other.c;
      const v = sub(near, arc.c);
      if (len(v) <= 0) continue;
      const t = Math.atan2(v.y, v.x);
      for (const tt of [t, t + Math.PI]) {
        if (!onArc(arc, tt)) continue;
        const onA = arcPoint(arc.c, arc.r, tt);
        const c = closestOn(onA, other);
        if (arc === f) take(onA, c.q);
        else take(c.q, onA);
      }
    }
  }
  return best;
}

// ---- inside / outside --------------------------------------------------------------------------

/** How many times a ray from `m` along `dir` crosses the features (tangent touches not counted). */
export function rayCrossings(m: Vec2, dir: Vec2, features: Placed[]): number {
  let n = 0;
  for (const f of features) {
    const p = f.prim;
    if (p.k === 'seg') {
      const e = sub(p.b, p.a);
      const den = cross(dir, e);
      if (Math.abs(den) < 1e-15) continue;
      const w = sub(p.a, m);
      const t = cross(w, e) / den;
      const u = cross(w, dir) / den;
      if (t > 0 && u >= 0 && u < 1) n++;
      continue;
    }
    const w = sub(m, p.c);
    const B = dot(w, dir);
    const C = dot(w, w) - p.r * p.r;
    const disc = B * B - C;
    if (disc <= 0) continue;
    const root = Math.sqrt(disc);
    for (const t of [-B - root, -B + root]) {
      if (t <= 0) continue;
      const at = { x: m.x + dir.x * t, y: m.y + dir.y * t };
      if (onArc(p, Math.atan2(at.y - p.c.y, at.x - p.c.x))) n++;
    }
  }
  return n;
}
/** Inside the region a copy's Fair outline encloses (even–odd), judged along two rays that must
 * agree — so a point merely beside an open line is not taken as inside. */
export function insideOutline(m: Vec2, along: Vec2, features: Placed[]): boolean {
  // Slightly off the gap's own direction, so a ray never runs exactly through a vertex or an edge.
  const t = Math.atan2(along.y, along.x) + Math.PI / 2 + 0.0137;
  const d1 = { x: Math.cos(t), y: Math.sin(t) };
  const d2 = { x: -d1.x, y: -d1.y };
  return rayCrossings(m, d1, features) % 2 === 1 && rayCrossings(m, d2, features) % 2 === 1;
}

/** Feature pairs (one from each copy) whose boxes come within `reach`. */
export function nearPairs(X: Placed[], Y: Placed[], reach: number): [Placed, Placed][] {
  // Cells about the size of a typical piece (and never smaller than the search reach), so a long
  // piece spans few cells however small the reach is.
  let size = 0;
  for (const y of Y) size += Math.max(y.box.x1 - y.box.x0, y.box.y1 - y.box.y0);
  const cell = Math.max(reach * 4, Y.length ? size / Y.length : 0, 1e-6);
  const grid = new Map<string, Placed[]>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  for (const y of Y) {
    for (let cx = Math.floor((y.box.x0 - reach) / cell); cx <= Math.floor((y.box.x1 + reach) / cell); cx++)
      for (let cy = Math.floor((y.box.y0 - reach) / cell); cy <= Math.floor((y.box.y1 + reach) / cell); cy++) {
        const k = key(cx, cy);
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(y);
      }
  }
  const out: [Placed, Placed][] = [];
  for (const x of X) {
    const seen = new Set<Placed>();
    for (let cx = Math.floor(x.box.x0 / cell); cx <= Math.floor(x.box.x1 / cell); cx++)
      for (let cy = Math.floor(x.box.y0 / cell); cy <= Math.floor(x.box.y1 / cell); cy++)
        for (const y of grid.get(key(cx, cy)) ?? []) {
          if (seen.has(y)) continue;
          seen.add(y);
          if (y.box.x0 - reach > x.box.x1 || x.box.x0 - reach > y.box.x1 || y.box.y0 - reach > x.box.y1 || x.box.y0 - reach > y.box.y1) continue;
          out.push([x, y]);
        }
  }
  return out;
}

/**
 * Relative to the LOCAL motif geometry: the reach of one motif's own Fair outline from its centre
 * (never the size of an Intersect arrangement, which would loosen the threshold as instances are
 * added). Without any Fair geometry, the frame's radius.
 */
export function motifScale(doc: Doc): number {
  const pivot = doc.frame.origin;
  let reach = 0;
  for (const { prim } of motifPieces(doc)) {
    for (const e of endsOf(prim)) reach = Math.max(reach, len(sub(e, pivot)));
    if (prim.k === 'arc') {
      // The arc's farthest point from the centre, if the arc reaches round to it.
      const away = sub(prim.c, pivot);
      const t = len(away) > 0 ? Math.atan2(away.y, away.x) : prim.a0;
      if (onArc(prim, t)) reach = Math.max(reach, len(away) + prim.r);
    }
  }
  return reach > 0 ? reach : motifRadius(doc);
}
