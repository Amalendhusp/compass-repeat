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
import { arcPoint, boxOf, closestOn, dot, endsOf, hits, len, motifPieces, motifRuns, motifScale, norm, placePrim, sub, TAU, type Placed, type Prim } from './fairGeometry.ts';

export interface FormOrigin {
  copy: string;
  entity: string;
  /** Release R2: what the piece was in that copy when taken — absent = Fair (as before R2). */
  kind?: 'construction' | 'extension';
}
export interface FormSegment extends Placed {
  origins: FormOrigin[];
  /** Fair if any contributor is Fair; else Construction if any is; else Extension. */
  kind: 'fair' | 'construction' | 'extension';
}

/** Release R2 — what Intersect Fair offers: Fair only (default), or also Construction, or also Extensions. */
export type FormLayer = 'fair' | 'construction' | 'extension';

/** How close (artwork units) two things must be to count as the same place: rounding, not drawing. */
export function formEps(doc: Doc): number {
  return Math.max(motifScale(doc), 1) * 1e-6;
}

const cache = new WeakMap<Doc, Map<FormLayer, FormSegment[]>>();

/** Every selectable segment of the arrangement as committed (one list per artwork state and layer). */
export function formSegments(doc: Doc, layer: FormLayer = 'fair'): FormSegment[] {
  let byLayer = cache.get(doc);
  if (!byLayer) cache.set(doc, (byLayer = new Map()));
  let segs = byLayer.get(layer);
  if (!segs) {
    segs = buildSegments(doc, layer);
    byLayer.set(layer, segs);
  }
  return segs;
}

interface Run {
  prim: Prim;
  origin: FormOrigin;
  box: Placed['box'];
}

function buildSegments(doc: Doc, layer: FormLayer): FormSegment[] {
  const eps = formEps(doc);
  const pivot = doc.frame.origin;
  const copies = intersectionCopies(doc);
  const place = (own: { prim: Prim; entity: string }[], kind?: 'construction' | 'extension'): Run[] =>
    copies.flatMap((copy) =>
      own.map((r) => {
        const prim = placePrim(r.prim, pivot, copy.pose);
        return { prim, origin: { copy: copy.key, entity: r.entity, ...(kind ? { kind } : {}) }, box: boxOf(prim) };
      }),
    );
  const runs = place(motifRuns(doc));
  // Release R2: Construction / Extension pieces of every copy (each a bounded piece of its line or
  // circle, between the points on it), offered beside the Fair runs. Fair is split exactly as before
  // (only where Fair meets Fair), so Fair only is unchanged; the added pieces are split wherever they
  // meet anything offered.
  const extra = layer === 'fair' ? [] : [...place(motifPieces(doc, 'construction'), 'construction'), ...(layer === 'extension' ? place(motifPieces(doc, 'extension'), 'extension') : [])];
  const all = [...runs, ...extra];
  const pieces: { prim: Prim; origin: FormOrigin }[] = [];
  const cut = (f: Run, against: Run[]) => {
    const cuts: number[] = [];
    for (const g of against) {
      if (g === f) continue;
      if (!boxesMeet(f.box, g.box, eps)) continue;
      for (const h of hits(f.prim, g.prim, eps)) cuts.push(paramOf(f.prim, h.at));
      // A T-junction or the end of an overlap: the other run's end lying on this one.
      for (const e of endsOf(g.prim)) if (closestOn(e, f.prim).d <= eps) cuts.push(paramOf(f.prim, e));
    }
    for (const prim of splitAt(f.prim, cuts, eps)) pieces.push({ prim, origin: f.origin });
  };
  for (const f of runs) cut(f, runs);
  for (const f of extra) cut(f, all);
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

const RANK = { fair: 0, construction: 1, extension: 2 } as const;

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
    const kind = piece.origin.kind ?? 'fair';
    if (found) {
      if (!found.origins.some((o) => o.copy === piece.origin.copy && o.entity === piece.origin.entity)) found.origins.push(piece.origin);
      if (RANK[kind] < RANK[found.kind]) found.kind = kind;
      continue;
    }
    const seg: FormSegment = { id: `s${out.length}`, prim: piece.prim, box: boxOf(piece.prim), origins: [piece.origin], kind };
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
