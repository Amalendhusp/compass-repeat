// Phase 5.6 items 17–30: negative space — the enclosed gaps that repetition creates between motif
// copies. Nothing here reshapes anything: a Space is purely a consequence of the Construct motif's
// Fair strokes, the lattice, its spacing, the motif rotation and the Same/Alternate/Mirror rule.
//
// How: the motif's Fair strokes are sampled (arcs finely) and placed for every copy in a patch
// around the reference; that set of pieces is turned into a planar arrangement (split where copies
// cross or overlap, coincident pieces kept once — the Phase 5.5 lesson), and its faces are traced
// exactly as Construct's Fill regions are. A bounded face lying outside every copy's own Fill
// regions is a Space; the unbounded outside is background, never a Space.
//
// Space classes are periodic, not visual: two Spaces are the same class when one is the other moved
// by a translation that maps the WHOLE pattern onto itself — the lattice itself for Same, the
// every-other-copy sub-lattice for Alternate/Mirror (a copy and its neighbour differ there), unless
// the motif happens to be symmetric under that alternation, when the full lattice applies again.
// A class's identity (what its colour is stored under) is topological: which copy's which curves
// bound it, in order — so a colour survives a spacing nudge that keeps the arrangement, and is
// simply not shown (never moved elsewhere) once the arrangement genuinely changes.
//
// Computed once per change of motif geometry or repeat arrangement and cached; pan/zoom and
// re-colouring never recompute it.

import type { Doc, RepeatSystem, Vec2 } from '../model/types.ts';
import { resolveEntityGeom } from './kernel.ts';
import { deriveSegments } from './segments.ts';
import { computeFairRegions, pointInPolygon } from './regions.ts';
import { instancePose, motifExtent, motifRadius, transformPoint, type InstancePose } from './lattice.ts';

export interface SpaceClass {
  /** Persistent identity: rule/family plus the class's topological signature. */
  key: string;
  /** Classes coloured together (the same Space under the pattern's full period). */
  group: string;
  /** One member's boundary, world space. Every other member is this moved by m·u + n·v. */
  loop: Vec2[];
  area: number;
  centroid: Vec2;
  reach: number;
  u: Vec2;
  v: Vec2;
}

export interface SpaceTopology {
  classes: SpaceClass[];
  groups: Map<string, SpaceClass[]>;
}

const ARC_STEP = Math.PI / 48;
const MAX_COPIES = 220;

interface Stroke {
  entityId: string;
  pts: Vec2[]; // Construct-world, in the curve's own parameter direction
}

/** The motif's Fair pieces as polylines. Arcs are sampled finely, but never into chords shorter
 * than a few snapping tolerances (tiny circles would otherwise collapse into noise). */
function motifStrokes(doc: Doc, tol: number): Stroke[] {
  const out: Stroke[] = [];
  for (const e of doc.entities) {
    const g = resolveEntityGeom(doc, e);
    for (const seg of deriveSegments(doc, e)) {
      if (doc.segmentStates.get(seg.key)?.state !== 'fair') continue;
      if (g.kind === 'circle') {
        const a0 = seg.fromParam;
        let a1 = seg.toParam;
        if (a1 <= a0) a1 += Math.PI * 2;
        const sweep = a1 - a0;
        const n = Math.max(1, Math.min(Math.ceil(sweep / ARC_STEP), Math.floor((sweep * g.radius) / (4 * tol))));
        const pts: Vec2[] = [];
        for (let k = 0; k <= n; k++) {
          const t = a0 + (sweep * k) / n;
          pts.push({ x: g.centre.x + g.radius * Math.cos(t), y: g.centre.y + g.radius * Math.sin(t) });
        }
        out.push({ entityId: e.id, pts });
      } else {
        const at = (t: number) => ({ x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t });
        out.push({ entityId: e.id, pts: [at(seg.fromParam), at(seg.toParam)] });
      }
    }
  }
  return out;
}

const usesParityPeriod = (rule: RepeatSystem['rule']) => rule.kind === 'alternate' || rule.kind === 'mirror';

// ---- a small planar arrangement over straight pieces ----

interface Source {
  i: number;
  j: number;
  entityId: string;
}

class Arrangement {
  xs: number[] = [];
  ys: number[] = [];
  private grid = new Map<string, number[]>();
  private tol: number;
  constructor(tol: number) {
    this.tol = tol;
  }

  vertex(p: Vec2): number {
    const cx = Math.floor(p.x / this.tol);
    const cy = Math.floor(p.y / this.tol);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of this.grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (Math.hypot(this.xs[id]! - p.x, this.ys[id]! - p.y) < this.tol) return id;
        }
      }
    }
    const id = this.xs.length;
    this.xs.push(p.x);
    this.ys.push(p.y);
    const k = `${cx},${cy}`;
    (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(id);
    return id;
  }
}

interface Face {
  loop: Vec2[];
  area: number;
  centroid: Vec2;
  pieces: { src: Source; forward: boolean }[];
}

/** Every bounded face of the arrangement of `edges` (pieces a→b in their curve's direction). */
function traceFaces(arr: Arrangement, edges: { a: number; b: number; src: Source; copy: number }[], tol: number, cell: number): Face[] {
  const { xs, ys } = arr;
  // Index pieces by grid cell (bbox inflated by tol).
  const cellsOf = (e: { a: number; b: number }) => {
    const x0 = Math.floor((Math.min(xs[e.a]!, xs[e.b]!) - tol) / cell);
    const x1 = Math.floor((Math.max(xs[e.a]!, xs[e.b]!) + tol) / cell);
    const y0 = Math.floor((Math.min(ys[e.a]!, ys[e.b]!) - tol) / cell);
    const y1 = Math.floor((Math.max(ys[e.a]!, ys[e.b]!) + tol) / cell);
    return { x0, x1, y0, y1 };
  };
  const grid = new Map<string, number[]>();
  const boxes = edges.map(cellsOf);
  boxes.forEach((bx, idx) => {
    for (let x = bx.x0; x <= bx.x1; x++)
      for (let y = bx.y0; y <= bx.y1; y++) {
        const k = `${x},${y}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(idx);
      }
  });

  const splits: { t: number; v: number }[][] = edges.map(() => []);
  // Crossings between different copies (a copy's own Fair pieces already meet only at shared points).
  for (const [key, list] of grid) {
    const [cx, cy] = key.split(',').map(Number) as [number, number];
    for (let p = 0; p < list.length; p++) {
      const e1 = list[p]!;
      for (let q = p + 1; q < list.length; q++) {
        const e2 = list[q]!;
        if (edges[e1]!.copy === edges[e2]!.copy) continue;
        const b1 = boxes[e1]!;
        const b2 = boxes[e2]!;
        if (Math.max(b1.x0, b2.x0) !== cx || Math.max(b1.y0, b2.y0) !== cy) continue; // test each pair once
        const A = edges[e1]!;
        const B = edges[e2]!;
        const ax = xs[A.a]!, ay = ys[A.a]!, bx = xs[A.b]!, by = ys[A.b]!;
        const cx2 = xs[B.a]!, cy2 = ys[B.a]!, dx = xs[B.b]!, dy = ys[B.b]!;
        const rX = bx - ax, rY = by - ay, sX = dx - cx2, sY = dy - cy2;
        const denom = rX * sY - rY * sX;
        if (Math.abs(denom) < 1e-12 * (Math.abs(rX) + Math.abs(rY)) * (Math.abs(sX) + Math.abs(sY))) continue; // parallel: overlap is handled below
        const t = ((cx2 - ax) * sY - (cy2 - ay) * sX) / denom;
        const u = ((cx2 - ax) * rY - (cy2 - ay) * rX) / denom;
        if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) continue;
        const v = arr.vertex({ x: ax + rX * t, y: ay + rY * t });
        splits[e1]!.push({ t, v });
        splits[e2]!.push({ t: u, v });
      }
    }
  }
  // A point lying on a piece (a T-junction, or where two coincident pieces overlap) splits it too.
  for (let v = 0; v < xs.length; v++) {
    const px = xs[v]!;
    const py = ys[v]!;
    for (const idx of grid.get(`${Math.floor(px / cell)},${Math.floor(py / cell)}`) ?? []) {
      const e = edges[idx]!;
      if (e.a === v || e.b === v) continue;
      const ax = xs[e.a]!, ay = ys[e.a]!;
      const rX = xs[e.b]! - ax, rY = ys[e.b]! - ay;
      const len2 = rX * rX + rY * rY;
      if (len2 < 1e-18) continue;
      const t = ((px - ax) * rX + (py - ay) * rY) / len2;
      if (t <= 0 || t >= 1) continue;
      if (Math.hypot(ax + rX * t - px, ay + rY * t - py) < tol) splits[idx]!.push({ t, v });
    }
  }

  // Pieces between consecutive split points; a piece already present (from any copy) is kept once.
  interface Sub {
    from: number;
    to: number;
    src: Source;
  }
  const subs: Sub[] = [];
  const seen = new Set<number>();
  const BIG = 67108864;
  edges.forEach((e, idx) => {
    const chain = [{ t: 0, v: e.a }, ...splits[idx]!.sort((p, q) => p.t - q.t), { t: 1, v: e.b }];
    for (let k = 0; k + 1 < chain.length; k++) {
      const from = chain[k]!.v;
      const to = chain[k + 1]!.v;
      if (from === to) continue;
      const key = Math.min(from, to) * BIG + Math.max(from, to);
      if (seen.has(key)) continue;
      seen.add(key);
      subs.push({ from, to, src: e.src });
    }
  });

  interface HE {
    sub: Sub;
    forward: boolean;
    from: number;
    to: number;
    angle: number;
    twin: HE | null;
    used: boolean;
  }
  const at = new Map<number, HE[]>();
  const all: HE[] = [];
  for (const sub of subs) {
    const f: HE = { sub, forward: true, from: sub.from, to: sub.to, angle: Math.atan2(ys[sub.to]! - ys[sub.from]!, xs[sub.to]! - xs[sub.from]!), twin: null, used: false };
    const b: HE = { sub, forward: false, from: sub.to, to: sub.from, angle: Math.atan2(ys[sub.from]! - ys[sub.to]!, xs[sub.from]! - xs[sub.to]!), twin: f, used: false };
    f.twin = b;
    all.push(f, b);
    (at.get(f.from) ?? at.set(f.from, []).get(f.from)!).push(f);
    (at.get(b.from) ?? at.set(b.from, []).get(b.from)!).push(b);
  }
  for (const list of at.values()) list.sort((p, q) => p.angle - q.angle);

  const faces: Face[] = [];
  for (const start of all) {
    if (start.used) continue;
    const boundary: HE[] = [];
    let cur = start;
    let safety = all.length + 1;
    while (safety-- > 0) {
      cur.used = true;
      boundary.push(cur);
      const list = at.get(cur.to)!;
      const idx = list.indexOf(cur.twin!);
      cur = list[(idx - 1 + list.length) % list.length]!;
      if (cur === start) break;
    }
    if (boundary.length < 3) continue;
    const loop = boundary.map((he) => ({ x: xs[he.from]!, y: ys[he.from]! }));
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < loop.length; k++) {
      const p = loop[k]!;
      const q = loop[(k + 1) % loop.length]!;
      const cr = p.x * q.y - q.x * p.y;
      area += cr;
      cx += (p.x + q.x) * cr;
      cy += (p.y + q.y) * cr;
    }
    area /= 2;
    if (area <= 0) continue; // the unbounded outside of a connected piece — background, never a Space
    faces.push({ loop, area, centroid: { x: cx / (6 * area), y: cy / (6 * area) }, pieces: boundary.map((he) => ({ src: he.sub.src, forward: he.forward })) });
  }
  return faces;
}

function perimeter(loop: Vec2[]): number {
  let p = 0;
  for (let k = 0; k < loop.length; k++) p += Math.hypot(loop[(k + 1) % loop.length]!.x - loop[k]!.x, loop[(k + 1) % loop.length]!.y - loop[k]!.y);
  return p;
}

/** A point certainly inside `loop` (a counter-clockwise face): just inside its longest side. */
function interiorPoint(loop: Vec2[], width: number): Vec2 | null {
  const order = loop.map((_, k) => k).sort((p, q) => {
    const lp = Math.hypot(loop[(p + 1) % loop.length]!.x - loop[p]!.x, loop[(p + 1) % loop.length]!.y - loop[p]!.y);
    const lq = Math.hypot(loop[(q + 1) % loop.length]!.x - loop[q]!.x, loop[(q + 1) % loop.length]!.y - loop[q]!.y);
    return lq - lp;
  });
  for (const k of order.slice(0, 6)) {
    const a = loop[k]!;
    const b = loop[(k + 1) % loop.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-12) continue;
    const d = Math.min(len * 0.25, width * 0.3);
    const p = { x: (a.x + b.x) / 2 - ((b.y - a.y) / len) * d, y: (a.y + b.y) / 2 + ((b.x - a.x) / len) * d };
    if (pointInPolygon(loop, p)) return p;
  }
  return null;
}

/** Undo one copy's placement: world → the motif's own Construct coordinates. */
function toMotif(pivot: Vec2, pose: InstancePose, p: Vec2): Vec2 {
  const qx = p.x - pivot.x - pose.translate.x;
  const qy = p.y - pivot.y - pose.translate.y;
  const c = Math.cos(-pose.rotation);
  const s = Math.sin(-pose.rotation);
  const lx = qx * c - qy * s;
  let ly = qx * s + qy * c;
  if (pose.mirror) ly = -ly;
  return { x: lx + pivot.x, y: ly + pivot.y };
}

/** Whether the motif's Fair strokes map onto themselves under the rule's alternation (a half-turn
 * for Alternate, the mirror for Mirror) — then alternate copies are indistinguishable and the
 * pattern repeats with the full lattice after all. */
function motifInvariant(strokes: Stroke[], pivot: Vec2, rule: RepeatSystem['rule'], tol: number): boolean {
  const map = (p: Vec2): Vec2 => (rule.kind === 'alternate' ? { x: 2 * pivot.x - p.x, y: 2 * pivot.y - p.y } : { x: p.x, y: 2 * pivot.y - p.y });
  const segs: [Vec2, Vec2][] = [];
  for (const s of strokes) for (let k = 0; k + 1 < s.pts.length; k++) segs.push([s.pts[k]!, s.pts[k + 1]!]);
  if (segs.length === 0) return false;
  const cell = tol * 40;
  const grid = new Map<string, number[]>();
  segs.forEach(([a, b], idx) => {
    for (let x = Math.floor((Math.min(a.x, b.x) - tol) / cell); x <= Math.floor((Math.max(a.x, b.x) + tol) / cell); x++)
      for (let y = Math.floor((Math.min(a.y, b.y) - tol) / cell); y <= Math.floor((Math.max(a.y, b.y) + tol) / cell); y++) {
        const k = `${x},${y}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(idx);
      }
  });
  const near = (p: Vec2) =>
    (grid.get(`${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`) ?? []).some((idx) => {
      const [a, b] = segs[idx]!;
      const rx = b.x - a.x;
      const ry = b.y - a.y;
      const len2 = rx * rx + ry * ry;
      const t = len2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * rx + (p.y - a.y) * ry) / len2));
      return Math.hypot(a.x + rx * t - p.x, a.y + ry * t - p.y) < tol * 3;
    });
  return segs.every(([a, b]) => near(map(a)) && near(map(b)) && near(map({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })));
}

function build(doc: Doc, repeat: RepeatSystem, strokes: Stroke[]): SpaceTopology {
  const empty: SpaceTopology = { classes: [], groups: new Map() };
  const { a, b } = repeat;
  const det = a.x * b.y - a.y * b.x;
  if (strokes.length === 0 || Math.abs(det) < 1e-9) return empty;

  const R = motifRadius(doc);
  const tol = R * 0.003;
  const E = motifExtent(doc);
  const pivot = doc.frame.origin;
  const parity = usesParityPeriod(repeat.rule);
  const u = parity ? { x: a.x + b.x, y: a.y + b.y } : a;
  const v = parity ? { x: a.x - b.x, y: a.y - b.y } : b;

  // Every copy that could touch a face lying within `trust` of the reference.
  let trust = E + Math.hypot(u.x, u.y) + Math.hypot(v.x, v.y);
  const reachOut = trust + E * 1.05;
  const ki = Math.ceil((reachOut * Math.hypot(b.x, b.y)) / Math.abs(det)) + 1;
  const kj = Math.ceil((reachOut * Math.hypot(a.x, a.y)) / Math.abs(det)) + 1;
  let copies: InstancePose[] = [];
  for (let j = -kj; j <= kj; j++) for (let i = -ki; i <= ki; i++) copies.push(instancePose(repeat, i, j));
  const d = (pose: InstancePose) => Math.hypot(pose.translate.x, pose.translate.y);
  copies = copies.filter((pose) => d(pose) <= reachOut).sort((p, q) => d(p) - d(q));
  if (copies.length > MAX_COPIES) {
    trust = Math.min(trust, d(copies[MAX_COPIES]!) - E * 1.05);
    copies = copies.slice(0, MAX_COPIES);
  }
  if (trust <= 0) return empty;
  // Lexicographic (j, i) order, so "the first of two coincident pieces" is the same choice for
  // every member of a class.
  copies.sort((p, q) => p.j - q.j || p.i - q.i);

  const arr = new Arrangement(tol);
  const edges: { a: number; b: number; src: Source; copy: number }[] = [];
  copies.forEach((pose, copy) => {
    for (const s of strokes) {
      const src: Source = { i: pose.i, j: pose.j, entityId: s.entityId };
      let prev = arr.vertex(transformPoint(pivot, pose, s.pts[0]!));
      for (let k = 1; k < s.pts.length; k++) {
        const next = arr.vertex(transformPoint(pivot, pose, s.pts[k]!));
        if (next !== prev) edges.push({ a: prev, b: next, src, copy });
        prev = next;
      }
    }
  });
  const faces = traceFaces(arr, edges, tol, Math.max(E / 6, tol * 20));

  // Spaces: bounded faces outside every copy's own Fill regions, far enough in to be complete.
  const motifRegions = computeFairRegions(doc);
  const nearCopies = (p: Vec2) => copies.filter((pose) => Math.hypot(pivot.x + pose.translate.x - p.x, pivot.y + pose.translate.y - p.y) <= E * 1.05);
  const byKey = new Map<string, Face[]>();
  for (const f of faces) {
    const width = (2 * f.area) / perimeter(f.loop);
    if (width < R * 0.01) continue; // a sliver where two copies' strokes run side by side
    if (f.loop.some((p) => Math.hypot(p.x - pivot.x, p.y - pivot.y) > trust)) continue;
    const inside = interiorPoint(f.loop, width);
    if (!inside) continue;
    if (nearCopies(inside).some((pose) => motifRegions.some((r) => pointInPolygon(r.samplePoints, toMotif(pivot, pose, inside))))) continue;
    const key = `${repeat.family ?? 'square'}|${repeat.rule.kind}|${signature(f, parity)}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(f);
  }

  const classes: SpaceClass[] = [];
  for (const [key, members] of byKey) {
    const rep = members.reduce((best, f) => (Math.hypot(f.centroid.x - pivot.x, f.centroid.y - pivot.y) < Math.hypot(best.centroid.x - pivot.x, best.centroid.y - pivot.y) ? f : best));
    const reach = Math.max(...rep.loop.map((p) => Math.hypot(p.x - rep.centroid.x, p.y - rep.centroid.y)));
    classes.push({ key, group: key, loop: rep.loop, area: rep.area, centroid: rep.centroid, reach, u, v });
  }

  // Alternate/Mirror with a motif that looks the same either way: classes that are translates by
  // the full lattice are one Space after all — coloured together.
  if (parity && classes.length > 1 && motifInvariant(strokes, pivot, repeat.rule, tol)) {
    const parent = new Map(classes.map((c) => [c.key, c.key] as const));
    const find = (k: string): string => (parent.get(k) === k ? k : find(parent.get(k)!));
    for (let p = 0; p < classes.length; p++) {
      for (let q = p + 1; q < classes.length; q++) {
        if (isLatticeTranslate(classes[p]!, classes[q]!, a, b, det, tol)) {
          const rp = find(classes[p]!.key);
          const rq = find(classes[q]!.key);
          if (rp !== rq) parent.set(rp < rq ? rq : rp, rp < rq ? rp : rq);
        }
      }
    }
    for (const c of classes) c.group = find(c.key);
  }
  const groups = new Map<string, SpaceClass[]>();
  for (const c of classes) (groups.get(c.group) ?? groups.set(c.group, []).get(c.group)!).push(c);
  return { classes, groups };
}

/** True when `q`'s face is exactly `p`'s moved by a whole-lattice translation. (Both classes'
 * own periods are lattice vectors, so it's enough to compare the two representatives.) */
function isLatticeTranslate(p: SpaceClass, q: SpaceClass, a: Vec2, b: Vec2, det: number, tol: number): boolean {
  if (Math.abs(p.area - q.area) > Math.max(p.area, q.area) * 2e-3) return false;
  const d = { x: q.centroid.x - p.centroid.x, y: q.centroid.y - p.centroid.y };
  const fi = (d.x * b.y - d.y * b.x) / det;
  const fj = (a.x * d.y - a.y * d.x) / det;
  if (Math.abs(fi - Math.round(fi)) > 0.01 || Math.abs(fj - Math.round(fj)) > 0.01) return false;
  const t = { x: Math.round(fi) * a.x + Math.round(fj) * b.x, y: Math.round(fi) * a.y + Math.round(fj) * b.y };
  return p.loop.every((pt) => q.loop.some((qt) => Math.hypot(pt.x + t.x - qt.x, pt.y + t.y - qt.y) < tol * 3));
}

/** Which curves of which copies bound the face, in order round it, with copy offsets taken
 * relative to the face (shifted by a period translation only), so every member of a class reads
 * the same — and a face bounded differently never does. */
function signature(f: Face, parity: boolean): string {
  const pieces: { i: number; j: number; id: string }[] = [];
  for (const p of f.pieces) {
    const id = `${p.src.entityId}${p.forward ? '+' : '-'}`;
    const last = pieces[pieces.length - 1];
    if (last && last.i === p.src.i && last.j === p.src.j && last.id === id) continue;
    pieces.push({ i: p.src.i, j: p.src.j, id });
  }
  while (pieces.length > 1) {
    const first = pieces[0]!;
    const last = pieces[pieces.length - 1]!;
    if (first.i === last.i && first.j === last.j && first.id === last.id) pieces.pop();
    else break;
  }
  let min = pieces[0]!;
  for (const p of pieces) if (p.j < min.j || (p.j === min.j && p.i < min.i)) min = p;
  // Same: any lattice shift. Alternate/Mirror: only shifts with i + j even keep copies alike.
  let si = -min.i;
  let sj = -min.j;
  if (parity && (((si + sj) % 2) + 2) % 2 === 1) si += 1;
  const parts = pieces.map((p) => `${p.i + si},${p.j + sj},${p.id}`);
  let best = 0;
  for (let k = 1; k < parts.length; k++) {
    const rotated = [...parts.slice(k), ...parts.slice(0, k)].join('>');
    if (rotated < [...parts.slice(best), ...parts.slice(0, best)].join('>')) best = k;
  }
  return [...parts.slice(best), ...parts.slice(0, best)].join('>');
}

// ---- cache ----

const byDoc = new WeakMap<Doc, SpaceTopology>();
let last: { key: string; topology: SpaceTopology } | null = null;

function contentKey(doc: Doc, repeat: RepeatSystem, strokes: Stroke[]): string {
  const q = motifRadius(doc) * 1e-6;
  const r = (x: number) => Math.round(x / q);
  const parts: (string | number | undefined)[] = [repeat.family, repeat.rule.kind, r(repeat.a.x), r(repeat.a.y), r(repeat.b.x), r(repeat.b.y), Math.round(repeat.motif.rotation * 1e9), r(doc.frame.origin.x), r(doc.frame.origin.y), r(doc.frame.radius)];
  for (const s of strokes) parts.push(s.entityId, ...s.pts.flatMap((p) => [r(p.x), r(p.y)]));
  return parts.join(',');
}

/** The Space classes of the committed arrangement — rebuilt only when motif geometry or the repeat
 * arrangement changes (a new Doc from a colour change or pan/zoom reuses it). */
export function computeSpaces(doc: Doc): SpaceTopology {
  const hit = byDoc.get(doc);
  if (hit) return hit;
  const strokes = motifStrokes(doc, motifRadius(doc) * 0.003);
  const key = contentKey(doc, doc.repeat, strokes);
  const topology = last?.key === key ? last.topology : build(doc, doc.repeat, strokes);
  last = { key, topology };
  byDoc.set(doc, topology);
  return topology;
}

/** The Space under a world point, if any (smallest wins, though Spaces never overlap). */
export function spaceAt(topology: SpaceTopology, w: Vec2): SpaceClass | null {
  let found: SpaceClass | null = null;
  for (const c of topology.classes) {
    const det = c.u.x * c.v.y - c.u.y * c.v.x;
    const dx = w.x - c.centroid.x;
    const dy = w.y - c.centroid.y;
    const m0 = Math.round((dx * c.v.y - dy * c.v.x) / det);
    const n0 = Math.round((c.u.x * dy - c.u.y * dx) / det);
    for (let m = m0 - 1; m <= m0 + 1; m++) {
      for (let n = n0 - 1; n <= n0 + 1; n++) {
        const p = { x: w.x - m * c.u.x - n * c.v.x, y: w.y - m * c.u.y - n * c.v.y };
        if (pointInPolygon(c.loop, p) && (!found || c.area < found.area)) found = c;
      }
    }
  }
  return found;
}

/** Each translation m·u + n·v at which `c` appears within the world-space box. */
export function spaceTranslations(c: SpaceClass, box: { minX: number; minY: number; maxX: number; maxY: number }, cap = 3000): Vec2[] {
  const det = c.u.x * c.v.y - c.u.y * c.v.x;
  if (Math.abs(det) < 1e-12) return [];
  let mMin = Infinity;
  let mMax = -Infinity;
  let nMin = Infinity;
  let nMax = -Infinity;
  for (const [x, y] of [
    [box.minX - c.reach, box.minY - c.reach],
    [box.maxX + c.reach, box.minY - c.reach],
    [box.minX - c.reach, box.maxY + c.reach],
    [box.maxX + c.reach, box.maxY + c.reach],
  ] as const) {
    const dx = x - c.centroid.x;
    const dy = y - c.centroid.y;
    const m = (dx * c.v.y - dy * c.v.x) / det;
    const n = (c.u.x * dy - c.u.y * dx) / det;
    mMin = Math.min(mMin, m);
    mMax = Math.max(mMax, m);
    nMin = Math.min(nMin, n);
    nMax = Math.max(nMax, n);
  }
  const out: Vec2[] = [];
  for (let n = Math.floor(nMin); n <= Math.ceil(nMax); n++) {
    for (let m = Math.floor(mMin); m <= Math.ceil(mMax); m++) {
      const t = { x: m * c.u.x + n * c.v.x, y: m * c.u.y + n * c.v.y };
      const cx = c.centroid.x + t.x;
      const cy = c.centroid.y + t.y;
      if (cx < box.minX - c.reach || cx > box.maxX + c.reach || cy < box.minY - c.reach || cy > box.maxY + c.reach) continue;
      out.push(t);
      if (out.length >= cap) return out;
    }
  }
  return out;
}
