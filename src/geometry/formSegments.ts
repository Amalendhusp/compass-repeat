// Intersect Form Development (Stage D3): the segments Fair in Intersect can take into the Developed
// Primary — every copy's Fair geometry where that copy stands, split where Fair geometry meets.
//
// - Fair RUNS, not pieces: a Fair line or circle is one run however many construction points lie on
//   it, so nothing is split at unrelated construction points (D3) — only where Fair meets Fair.
// - Split where any two runs meet: a proper crossing, a touch (tangent), a T-junction (one run's end on
//   another), and the ends of an overlap (two copies' strokes lying along one another).
// - Coincident pieces (two copies sharing an edge) are one segment that remembers every contributor
//   (D5): drawn and tapped once, provenance kept.
// - Curves stay curves: a segment is an exact line or arc.
//
// The Developed Primary keeps its own copy of what was taken (DevelopedSegment.geom): moving or
// removing a copy afterwards never changes it. Membership is geometric — a segment is in the Primary
// when a developed segment lies exactly along it.

import type { DevelopedSegment, Doc, Vec2 } from '../model/types.ts';
import { intersectionCopies } from './intersection.ts';
import { arcPoint, boxOf, closestOn, dot, endsOf, hits, len, motifRuns, motifScale, norm, placePrim, sub, TAU, type Placed, type Prim } from './fairGeometry.ts';

export interface FormOrigin {
  copy: string;
  entity: string;
}
export interface FormSegment extends Placed {
  origins: FormOrigin[];
}

/** How close (artwork units) two things must be to count as the same place: rounding, not drawing. */
export function formEps(doc: Doc): number {
  return Math.max(motifScale(doc), 1) * 1e-6;
}

const cache = new WeakMap<Doc, FormSegment[]>();

/** Every selectable segment of the arrangement as committed (one list per artwork state). */
export function formSegments(doc: Doc): FormSegment[] {
  let segs = cache.get(doc);
  if (!segs) {
    segs = buildSegments(doc);
    cache.set(doc, segs);
  }
  return segs;
}

interface Run {
  prim: Prim;
  origin: FormOrigin;
  box: Placed['box'];
}

function buildSegments(doc: Doc): FormSegment[] {
  const eps = formEps(doc);
  const pivot = doc.frame.origin;
  const own = motifRuns(doc);
  const runs: Run[] = [];
  for (const copy of intersectionCopies(doc))
    for (const r of own) {
      const prim = placePrim(r.prim, pivot, copy.pose);
      runs.push({ prim, origin: { copy: copy.key, entity: r.entity }, box: boxOf(prim) });
    }
  const pieces: { prim: Prim; origin: FormOrigin }[] = [];
  for (let i = 0; i < runs.length; i++) {
    const f = runs[i]!;
    const cuts: number[] = [];
    for (let j = 0; j < runs.length; j++) {
      if (j === i) continue;
      const g = runs[j]!;
      if (!boxesMeet(f.box, g.box, eps)) continue;
      for (const h of hits(f.prim, g.prim, eps)) cuts.push(paramOf(f.prim, h.at));
      // A T-junction or the end of an overlap: the other run's end lying on this one.
      for (const e of endsOf(g.prim)) if (closestOn(e, f.prim).d <= eps) cuts.push(paramOf(f.prim, e));
    }
    for (const prim of splitAt(f.prim, cuts, eps)) pieces.push({ prim, origin: f.origin });
  }
  return merged(pieces, eps);
}

const boxesMeet = (a: Placed['box'], b: Placed['box'], eps: number) => a.x0 <= b.x1 + eps && b.x0 <= a.x1 + eps && a.y0 <= b.y1 + eps && b.y0 <= a.y1 + eps;

/** Where `p` lies along `f`: a line's fraction from a to b; an arc's angle past its start. */
function paramOf(f: Prim, p: Vec2): number {
  if (f.k === 'seg') {
    const d = sub(f.b, f.a);
    return dot(sub(p, f.a), d) / dot(d, d);
  }
  return norm(Math.atan2(p.y - f.c.y, p.x - f.c.x) - f.a0);
}

/** `f` cut at the parameters `cuts` (those strictly inside it), as exact pieces. */
function splitAt(f: Prim, cuts: number[], eps: number): Prim[] {
  if (f.k === 'seg') {
    const tol = eps / Math.max(len(sub(f.b, f.a)), 1e-12);
    const ts = distinct(cuts.filter((t) => t > tol && t < 1 - tol), tol);
    const at = (t: number): Vec2 => ({ x: f.a.x + (f.b.x - f.a.x) * t, y: f.a.y + (f.b.y - f.a.y) * t });
    const stops = [0, ...ts, 1];
    const out: Prim[] = [];
    for (let k = 0; k + 1 < stops.length; k++) out.push({ k: 'seg', a: k === 0 ? f.a : at(stops[k]!), b: k + 2 === stops.length ? f.b : at(stops[k + 1]!) });
    return out;
  }
  const tol = eps / f.r;
  const whole = f.sw >= TAU - 1e-9;
  if (whole) {
    // A whole circle: cut round from the first cut (with none, it stays whole).
    const us = distinct(cuts.map((u) => norm(u)), tol);
    if (us.length === 0) return [f];
    if (us.length > 1 && TAU - us[us.length - 1]! + us[0]! <= tol) us.pop(); // the same cut either side of 0
    const out: Prim[] = [];
    for (let k = 0; k < us.length; k++) {
      const u0 = us[k]!;
      const u1 = k + 1 < us.length ? us[k + 1]! : us[0]! + TAU;
      out.push({ k: 'arc', c: f.c, r: f.r, a0: norm(f.a0 + u0), sw: u1 - u0 });
    }
    return out;
  }
  const us = distinct(cuts.filter((u) => u > tol && u < f.sw - tol), tol);
  const stops = [0, ...us, f.sw];
  const out: Prim[] = [];
  for (let k = 0; k + 1 < stops.length; k++) out.push({ k: 'arc', c: f.c, r: f.r, a0: norm(f.a0 + stops[k]!), sw: stops[k + 1]! - stops[k]! });
  return out;
}

/** Sorted, with values within `tol` of one another taken once. */
function distinct(xs: number[], tol: number): number[] {
  const s = xs.slice().sort((p, q) => p - q);
  const out: number[] = [];
  for (const x of s) if (!out.length || x - out[out.length - 1]! > tol) out.push(x);
  return out;
}

/** A point halfway along a piece. */
export function midOf(p: Prim): Vec2 {
  return p.k === 'seg' ? { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 } : arcPoint(p.c, p.r, p.a0 + p.sw / 2);
}

/** Whether two pieces are the same geometry (to within `tol`): same kind, same ends, same middle. */
export function samePiece(p: Prim, q: Prim, tol: number): boolean {
  if (p.k !== q.k) return false;
  if (len(sub(midOf(p), midOf(q))) > tol) return false;
  const [p0, p1] = endsOf(p);
  const [q0, q1] = endsOf(q);
  const near = (u: Vec2, v: Vec2) => len(sub(u, v)) <= tol;
  if (p.k === 'arc' && q.k === 'arc' && (Math.abs(p.r - q.r) > tol || len(sub(p.c, q.c)) > tol)) return false;
  // A whole circle has no ends to compare: same circle is enough.
  if (p.k === 'arc' && q.k === 'arc' && p.sw >= TAU - 1e-9) return q.sw >= TAU - 1e-9;
  return (near(p0!, q0!) && near(p1!, q1!)) || (near(p0!, q1!) && near(p1!, q0!));
}

/** Coincident pieces taken once, every contributor kept (D5). */
function merged(pieces: { prim: Prim; origin: FormOrigin }[], eps: number): FormSegment[] {
  const tol = eps * 10;
  const cell = Math.max(tol * 100, 1e-9);
  const grid = new Map<string, FormSegment[]>();
  const key = (x: number, y: number) => `${x},${y}`;
  const out: FormSegment[] = [];
  for (const piece of pieces) {
    const m = midOf(piece.prim);
    const cx = Math.floor(m.x / cell);
    const cy = Math.floor(m.y / cell);
    let found: FormSegment | undefined;
    for (let dx = -1; dx <= 1 && !found; dx++)
      for (let dy = -1; dy <= 1 && !found; dy++) found = grid.get(key(cx + dx, cy + dy))?.find((s) => samePiece(s.prim, piece.prim, tol));
    if (found) {
      if (!found.origins.some((o) => o.copy === piece.origin.copy && o.entity === piece.origin.entity)) found.origins.push(piece.origin);
      continue;
    }
    const seg: FormSegment = { id: `s${out.length}`, prim: piece.prim, box: boxOf(piece.prim), origins: [piece.origin] };
    out.push(seg);
    (grid.get(key(cx, cy)) ?? grid.set(key(cx, cy), []).get(key(cx, cy))!).push(seg);
  }
  return out;
}

// ---- the Developed Primary's own geometry ----------------------------------------------------------

/** A developed segment's geometry as a primitive. */
export function developedPrim(s: DevelopedSegment): Prim {
  const g = s.geom;
  return g.kind === 'line' ? { k: 'seg', a: g.a, b: g.b } : { k: 'arc', c: g.c, r: g.r, a0: g.a0, sw: g.sw };
}

/** A segment's geometry, copied, to store in the Developed Primary. */
export function geomOf(p: Prim): DevelopedSegment['geom'] {
  return p.k === 'seg' ? { kind: 'line', a: { ...p.a }, b: { ...p.b } } : { kind: 'arc', c: { ...p.c }, r: p.r, a0: p.a0, sw: p.sw };
}

/** The developed segment lying exactly along `seg`, if it is in the Primary. */
export function developedAlong(doc: Doc, developed: DevelopedSegment[], seg: Prim): DevelopedSegment | undefined {
  const tol = formEps(doc) * 10;
  return developed.find((d) => samePiece(developedPrim(d), seg, tol));
}
