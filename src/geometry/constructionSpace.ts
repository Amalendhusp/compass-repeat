// Construction Space: in Repeat, with the Construction overlay on, the enclosed region of the
// repeated construction scaffold under a tap — a temporary analysis, never artwork. Nothing here is
// saved, coloured, undone or recorded; the caller only ever shows the face it returns.
//
// Unlike Design Space (spaces.ts), which classifies the gaps between copies' Fair strokes once for
// the whole periodic pattern, this works locally and only on demand: the construction of the copies
// that reach a box around the tap — lines, circles and arcs (Fair pieces included: they are still
// construction lines; trimmed pieces are gone), each placed with its copy's exact Repeat pose —
// plus each extended line of those copies as a true infinite line clipped to the box. Coincident
// pieces are kept once, everything is split where it crosses (within one copy too: an extended line
// is one long chord here), and open ends are pruned away, so a face that survives is closed by real
// construction on every side. The smallest such face around the tap is the answer.
//
// Which copies take part is local by definition: an extended line at an angle no lattice vector
// shares passes every cell eventually, so "every copy's lines" would cut any region ever finer.
// The copies counted are those whose construction reaches about one lattice step around the region
// — the cells it sits among and their neighbours — found once around the tap, then once more
// around the region itself, so the same region comes back wherever in it the tap fell.

import type { Doc, Vec2 } from '../model/types.ts';
import { resolveEntityGeom } from './kernel.ts';
import { deriveSegments } from './segments.ts';
import { pointInPolygon } from './regions.ts';
import { instancePose, motifExtent, motifRadius, transformPoint } from './lattice.ts';
import { Arrangement } from './spaces.ts';

// Finer than Design Space (R·0.003): construction regions can be far smaller than the gaps
// between Fair strokes (Plate 113's are ~1% of the motif across), so vertices snap closer and arcs
// are sampled to within a quarter of that.
const TOLERANCE = 0.0005;

export interface ConstructionFace {
  loop: Vec2[];
  /** Separate construction lying wholly inside the face (not part of it). */
  holes: Vec2[][];
  area: number;
}

export interface ConstructionSpaceResult {
  face: ConstructionFace | null;
  /** Why there is no face: nothing closed around the tap, or the region outgrew the search box. */
  reason?: 'open' | 'too-large' | 'empty';
  copies: number;
  edges: number;
  ms: number;
}

interface Scaffold {
  /** Finite pieces as polylines (arcs sampled), motif coordinates. */
  strokes: Vec2[][];
  /** Extended lines: a point and unit direction. */
  infinite: { p: Vec2; u: Vec2 }[];
  /** How far the finite pieces reach from the pivot. */
  reach: number;
}

const scaffoldCache = new WeakMap<Doc, Scaffold>();

function scaffold(doc: Doc, tol: number): Scaffold {
  const hit = scaffoldCache.get(doc);
  if (hit) return hit;
  const pivot = doc.frame.origin;
  const strokes: Vec2[][] = [];
  const infinite: Scaffold['infinite'] = [];
  const arc = (c: Vec2, r: number, a0: number, a1: number): Vec2[] => {
    if (a1 <= a0) a1 += Math.PI * 2;
    const sweep = a1 - a0;
    const step = 2 * Math.acos(Math.max(-1, 1 - tol / (4 * r))); // chord within tol/4 of the arc
    const n = Math.max(1, Math.min(Math.ceil(sweep / step), Math.floor((sweep * r) / (4 * tol))));
    const pts: Vec2[] = [];
    for (let k = 0; k <= n; k++) {
      const t = a0 + (sweep * k) / n;
      pts.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
    }
    return pts;
  };
  for (const e of doc.entities) {
    const g = resolveEntityGeom(doc, e);
    if (g.kind === 'line' && e.kind === 'line' && e.extended) {
      infinite.push({ p: g.a, u: g.dir }); // its finite pieces all lie on it
      continue;
    }
    const segs = deriveSegments(doc, e);
    if (segs.length === 0) {
      strokes.push(g.kind === 'circle' ? arc(g.centre, g.radius, 0, Math.PI * 2) : [g.a, g.b]);
      continue;
    }
    for (const seg of segs) {
      if (doc.segmentStates.get(seg.key)?.state === 'trimmed') continue;
      if (g.kind === 'circle') strokes.push(arc(g.centre, g.radius, seg.fromParam, seg.toParam));
      else {
        const at = (t: number) => ({ x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t });
        strokes.push([at(seg.fromParam), at(seg.toParam)]);
      }
    }
  }
  let reach = 0;
  for (const s of strokes) for (const p of s) reach = Math.max(reach, Math.hypot(p.x - pivot.x, p.y - pivot.y));
  const sc = { strokes, infinite, reach };
  scaffoldCache.set(doc, sc);
  return sc;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** An infinite line clipped to the box, or null. */
function clipLine(p: Vec2, u: Vec2, box: Box): [Vec2, Vec2] | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (const [o, d, lo, hi] of [[p.x, u.x, box.minX, box.maxX], [p.y, u.y, box.minY, box.maxY]] as const) {
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return null;
      continue;
    }
    const ta = (lo - o) / d;
    const tb = (hi - o) / d;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  if (t0 >= t1) return null;
  return [{ x: p.x + u.x * t0, y: p.y + u.y * t0 }, { x: p.x + u.x * t1, y: p.y + u.y * t1 }];
}

/** The grid cells a segment passes through (Amanatides–Woo), so a long line is indexed only where
 * it actually runs — not across its whole bounding box. */
function cellsAlong(ax: number, ay: number, bx: number, by: number, cell: number, visit: (x: number, y: number) => void): void {
  let x = Math.floor(ax / cell);
  let y = Math.floor(ay / cell);
  const xe = Math.floor(bx / cell);
  const ye = Math.floor(by / cell);
  const dx = bx - ax;
  const dy = by - ay;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  let tMaxX = dx !== 0 ? ((sx > 0 ? (x + 1) * cell : x * cell) - ax) / dx : Infinity;
  let tMaxY = dy !== 0 ? ((sy > 0 ? (y + 1) * cell : y * cell) - ay) / dy : Infinity;
  const tDx = dx !== 0 ? cell / Math.abs(dx) : Infinity;
  const tDy = dy !== 0 ? cell / Math.abs(dy) : Infinity;
  visit(x, y);
  let guard = Math.abs(xe - x) + Math.abs(ye - y) + 2;
  while ((x !== xe || y !== ye) && guard-- > 0) {
    if (tMaxX < tMaxY) {
      x += sx;
      tMaxX += tDx;
    } else {
      y += sy;
      tMaxY += tDy;
    }
    visit(x, y);
  }
}

/** Whether `w` lies in the face (inside its boundary, not in a hole). */
export function faceContains(face: ConstructionFace, w: Vec2): boolean {
  return pointInPolygon(face.loop, w) && !face.holes.some((h) => pointInPolygon(h, w));
}

/** The closed construction region around world point `w`, for the document's current Repeat. */
export function constructionSpaceAt(doc: Doc, w: Vec2): ConstructionSpaceResult {
  const t0 = performance.now();
  const R = motifRadius(doc);
  const tol = R * TOLERANCE;
  const sc = scaffold(doc, tol);
  const done = (r: Omit<ConstructionSpaceResult, 'ms'>): ConstructionSpaceResult => ({ ...r, ms: performance.now() - t0 });
  if (sc.strokes.length === 0 && sc.infinite.length === 0) return done({ face: null, reason: 'empty', copies: 0, edges: 0 });
  const { a, b } = doc.repeat;
  const det = a.x * b.y - a.y * b.x;
  if (Math.abs(det) < 1e-9) return done({ face: null, reason: 'empty', copies: 0, edges: 0 });
  const lattice = Math.max(Math.hypot(a.x, a.y), Math.hypot(b.x, b.y));
  // The copies taking part are those whose construction reaches a box about one lattice step either
  // side of `anchor`. Their pieces are looked at only within a smaller box first — most regions are
  // small, and a dense scaffold has thousands of pieces — which grows while the region found runs
  // out of it. Only a region larger than the whole neighbourhood widens the copies too.
  const base = Math.max(lattice, R);
  const search = (anchor: Vec2) => {
    let last: Omit<ConstructionSpaceResult, 'ms'> | null = null;
    for (const half of [base * 0.2, base * 0.4, base * 0.8, base * 1.25, base * 2.5]) {
      last = faceInBox(doc, sc, w, anchor, half, Math.max(half, base * 1.25), tol, det);
      if (last.reason !== 'too-large') break;
    }
    return last!;
  };
  let found = search(w);
  if (found.face) {
    // Once more with the neighbourhood centred on the region found rather than on where in it the
    // tap fell, so a region doesn't depend on which part of it was tapped.
    const loop = found.face.loop;
    const centre = { x: loop.reduce((s, p) => s + p.x, 0) / loop.length, y: loop.reduce((s, p) => s + p.y, 0) / loop.length };
    const again = search(centre);
    if (again.face && faceContains(again.face, w)) found = again;
  }
  return done(found);
}

/** The face around `w`, from the construction of the copies near `anchor`, within a box about it. */
function faceInBox(doc: Doc, sc: Scaffold, w: Vec2, anchor: Vec2, half: number, copyHalf: number, tol: number, det: number): Omit<ConstructionSpaceResult, 'ms'> {
  const box: Box = { minX: anchor.x - half, minY: anchor.y - half, maxX: anchor.x + half, maxY: anchor.y + half };
  const near: Box = { minX: anchor.x - copyHalf, minY: anchor.y - copyHalf, maxX: anchor.x + copyHalf, maxY: anchor.y + copyHalf };
  const pivot = doc.frame.origin;
  const { a, b } = doc.repeat;
  // Copies whose construction reaches the neighbourhood.
  const radius = Math.max(sc.reach, motifExtent(doc));
  const ox = anchor.x - pivot.x;
  const oy = anchor.y - pivot.y;
  const fi = (ox * b.y - oy * b.x) / det;
  const fj = (a.x * oy - a.y * ox) / det;
  const span = copyHalf * Math.SQRT2 + radius;
  const ki = Math.ceil((span * Math.hypot(b.x, b.y)) / Math.abs(det)) + 1;
  const kj = Math.ceil((span * Math.hypot(a.x, a.y)) / Math.abs(det)) + 1;
  const poses = [];
  for (let j = Math.round(fj) - kj; j <= Math.round(fj) + kj; j++) {
    for (let i = Math.round(fi) - ki; i <= Math.round(fi) + ki; i++) {
      const pose = instancePose(doc.repeat, i, j);
      const cx = pivot.x + pose.translate.x;
      const cy = pivot.y + pose.translate.y;
      const nx = Math.max(near.minX, Math.min(near.maxX, cx));
      const ny = Math.max(near.minY, Math.min(near.maxY, cy));
      if (Math.hypot(cx - nx, cy - ny) <= radius) poses.push(pose);
    }
  }

  const arr = new Arrangement(tol);
  const edges: { a: number; b: number }[] = [];
  const inBox = (p: Vec2, q: Vec2) => Math.max(p.x, q.x) >= box.minX && Math.min(p.x, q.x) <= box.maxX && Math.max(p.y, q.y) >= box.minY && Math.min(p.y, q.y) <= box.maxY;
  const lines = new Set<string>();
  for (const pose of poses) {
    for (const s of sc.strokes) {
      let prevP = transformPoint(pivot, pose, s[0]!);
      let prev = -1;
      for (let k = 1; k < s.length; k++) {
        const nextP = transformPoint(pivot, pose, s[k]!);
        if (inBox(prevP, nextP)) {
          if (prev < 0) prev = arr.vertex(prevP);
          const next = arr.vertex(nextP);
          if (next !== prev) edges.push({ a: prev, b: next });
          prev = next;
        } else prev = -1;
        prevP = nextP;
      }
    }
    for (const { p, u } of sc.infinite) {
      const pa = transformPoint(pivot, pose, p);
      const pb = transformPoint(pivot, pose, { x: p.x + u.x, y: p.y + u.y });
      let dx = pb.x - pa.x;
      let dy = pb.y - pa.y;
      if (dx < -1e-12 || (Math.abs(dx) <= 1e-12 && dy < 0)) {
        dx = -dx;
        dy = -dy;
      }
      const key = `${Math.round(Math.atan2(dy, dx) * 1e7)}:${Math.round((pa.x * dy - pa.y * dx) / (tol * 0.25))}`;
      if (lines.has(key)) continue; // the same line from another copy
      lines.add(key);
      const seg = clipLine(pa, { x: dx, y: dy }, box);
      if (!seg) continue;
      const va = arr.vertex(seg[0]);
      const vb = arr.vertex(seg[1]);
      if (va !== vb) edges.push({ a: va, b: vb });
    }
  }
  const counts = { copies: poses.length, edges: edges.length };

  // ---- split everything where it crosses or touches ----
  const { xs, ys } = arr;
  const cell = Math.max(half / 12, tol * 20);
  const grid = new Map<string, number[]>();
  edges.forEach((e, idx) => {
    cellsAlong(xs[e.a]!, ys[e.a]!, xs[e.b]!, ys[e.b]!, cell, (cx, cy) => {
      const k = `${cx},${cy}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(idx);
    });
  });
  const splits: { t: number; v: number }[][] = edges.map(() => []);
  for (const list of grid.values()) {
    for (let p = 0; p < list.length; p++) {
      const A = edges[list[p]!]!;
      const ax = xs[A.a]!, ay = ys[A.a]!;
      const rX = xs[A.b]! - ax, rY = ys[A.b]! - ay;
      for (let q = p + 1; q < list.length; q++) {
        const B = edges[list[q]!]!;
        if (A.a === B.a || A.a === B.b || A.b === B.a || A.b === B.b) continue; // already meet at a vertex
        const cx = xs[B.a]!, cy = ys[B.a]!;
        const sX = xs[B.b]! - cx, sY = ys[B.b]! - cy;
        const denom = rX * sY - rY * sX;
        if (Math.abs(denom) < 1e-12 * (Math.abs(rX) + Math.abs(rY)) * (Math.abs(sX) + Math.abs(sY))) continue; // parallel: overlaps split below
        const t = ((cx - ax) * sY - (cy - ay) * sX) / denom;
        const u = ((cx - ax) * rY - (cy - ay) * rX) / denom;
        if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) continue;
        const v = arr.vertex({ x: ax + rX * t, y: ay + rY * t });
        splits[list[p]!]!.push({ t, v });
        splits[list[q]!]!.push({ t: u, v });
      }
    }
  }
  // A vertex lying on a piece (a T-junction, or coincident pieces overlapping) splits it too.
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
  // Pieces between consecutive split points, each kept once however many copies drew it.
  const subs: [number, number][] = [];
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
      subs.push([from, to]);
    }
  });

  // ---- prune open ends: only what closes a region remains ----
  const degree = new Map<number, number>();
  const bump = (v: number, d: number) => degree.set(v, (degree.get(v) ?? 0) + d);
  for (const [p, q] of subs) {
    bump(p, 1);
    bump(q, 1);
  }
  const incident = new Map<number, number[]>();
  subs.forEach(([p, q], idx) => {
    (incident.get(p) ?? incident.set(p, []).get(p)!).push(idx);
    (incident.get(q) ?? incident.set(q, []).get(q)!).push(idx);
  });
  const alive = subs.map(() => true);
  const queue = [...degree].filter(([, d]) => d === 1).map(([v]) => v);
  while (queue.length) {
    const v = queue.pop()!;
    if ((degree.get(v) ?? 0) !== 1) continue;
    const idx = incident.get(v)!.find((k) => alive[k]);
    if (idx === undefined) continue;
    alive[idx] = false;
    const [p, q] = subs[idx]!;
    const other = p === v ? q : p;
    bump(v, -1);
    bump(other, -1);
    if (degree.get(other) === 1) queue.push(other);
  }

  // ---- faces (as Design Space traces them) ----
  interface HE {
    from: number;
    to: number;
    angle: number;
    twin: HE | null;
    used: boolean;
  }
  const at = new Map<number, HE[]>();
  const all: HE[] = [];
  subs.forEach(([p, q], idx) => {
    if (!alive[idx]) return;
    const f: HE = { from: p, to: q, angle: Math.atan2(ys[q]! - ys[p]!, xs[q]! - xs[p]!), twin: null, used: false };
    const r: HE = { from: q, to: p, angle: Math.atan2(ys[p]! - ys[q]!, xs[p]! - xs[q]!), twin: f, used: false };
    f.twin = r;
    all.push(f, r);
    (at.get(p) ?? at.set(p, []).get(p)!).push(f);
    (at.get(q) ?? at.set(q, []).get(q)!).push(r);
  });
  for (const list of at.values()) list.sort((p, q) => p.angle - q.angle);
  const cycles: { loop: Vec2[]; area: number }[] = [];
  for (const start of all) {
    if (start.used) continue;
    const loop: Vec2[] = [];
    let cur = start;
    let safety = all.length + 1;
    while (safety-- > 0) {
      cur.used = true;
      loop.push({ x: xs[cur.from]!, y: ys[cur.from]! });
      const list = at.get(cur.to)!;
      cur = list[(list.indexOf(cur.twin!) - 1 + list.length) % list.length]!;
      if (cur === start) break;
    }
    if (loop.length < 3) continue;
    let area = 0;
    for (let k = 0; k < loop.length; k++) {
      const p = loop[k]!;
      const q = loop[(k + 1) % loop.length]!;
      area += p.x * q.y - q.x * p.y;
    }
    cycles.push({ loop, area: area / 2 });
  }

  // The smallest closed face around the tap; a sliver (two near-coincident lines) is not a region.
  let best: { loop: Vec2[]; area: number } | null = null;
  for (const c of cycles) {
    if (c.area <= 0 || (best && c.area >= best.area)) continue;
    if (pointInPolygon(c.loop, w)) best = c;
  }
  if (!best) return { face: null, reason: 'open', ...counts };
  let perim = 0;
  for (let k = 0; k < best.loop.length; k++) perim += Math.hypot(best.loop[(k + 1) % best.loop.length]!.x - best.loop[k]!.x, best.loop[(k + 1) % best.loop.length]!.y - best.loop[k]!.y);
  if ((2 * best.area) / perim < tol * 4) return { face: null, reason: 'open', ...counts }; // a sliver between two near-coincident lines
  // Reaching the edge of the box means lines beyond it were never counted: not yet trustworthy.
  const margin = tol * 2;
  if (best.loop.some((p) => p.x < box.minX + margin || p.x > box.maxX - margin || p.y < box.minY + margin || p.y > box.maxY - margin)) {
    return { face: null, reason: 'too-large', ...counts };
  }
  // Holes: other construction wholly inside (each separate piece's outer boundary), outermost only.
  const inner = cycles.filter((c) => c.area < 0 && Math.abs(c.area) < best!.area * (1 - 1e-9) && pointInPolygon(best!.loop, c.loop[0]!));
  const holes = inner.filter((h) => !inner.some((o) => o !== h && Math.abs(o.area) > Math.abs(h.area) && pointInPolygon(o.loop, h.loop[0]!))).map((h) => h.loop);
  return { face: { loop: best.loop, holes, area: best.area }, ...counts };
}
