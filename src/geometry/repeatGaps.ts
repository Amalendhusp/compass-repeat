// Final sprint, Stage 1.3: where is the region under a Fill tap open? Read-only — like Construct's
// openBoundary.ts it only points; nothing is drawn into the artwork, snapped or closed. (Repeat's
// Close Gap is a different thing: it moves a lattice arm.)
//
// What repeats (the motif, or the Intersect unit) is placed for the copies around the tap, exactly as
// Fill's region-finding sees it. Then:
// 1. Open ends: a curve end that touches nothing — no other curve of any copy passes through it (a gap
//    between copies narrower than spaces.ts GAP_FRACTION counts as closed, as it does for Fill) — and
//    that the tap can see (no line between them). These are where the region leaks.
// 2. Otherwise, a near miss: looking out from the tap all round, the directions that escape far past
//    the surrounding curves pass between two curves that do not meet; the narrowest place between those
//    two is marked (both sides), never an invented endpoint.
// If neither is found the region is simply not enclosed; nothing is marked.

import type { Doc, Vec2 } from '../model/types.ts';
import { instancePose, motifExtent, motifRadius, transformPoint } from './lattice.ts';
import { GAP_FRACTION, repeatStrokes } from './spaces.ts';
import { repeatUnit } from './repeatUnit.ts';

export interface GapMarks {
  /** Open curve ends the tap can see. */
  ends: Vec2[];
  /** Near misses: the two closest points of two curves that do not meet. */
  necks: { a: Vec2; b: Vec2 }[];
}

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  line: number;
  k: number;
}

const MAX_ENDS = 6;
const MAX_NECKS = 2;
const RAYS = 144;
/** Share of directions from the tap that must meet a curve nearby: three quarters of the turn — a
 * region nearly closed, not an open wedge (a wide opening is not a gap). */
const MIN_COVERAGE = 0.75;
/** The widest near miss marked, as a fraction of the motif radius. */
const MAX_NECK_FRACTION = 0.2;

function distToSeg(px: number, py: number, s: Seg): number {
  const rx = s.bx - s.ax;
  const ry = s.by - s.ay;
  const l2 = rx * rx + ry * ry;
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((px - s.ax) * rx + (py - s.ay) * ry) / l2));
  return Math.hypot(s.ax + rx * t - px, s.ay + ry * t - py);
}

/** Proper crossing of p→q with s (shared ends do not count). */
function crosses(px: number, py: number, qx: number, qy: number, s: Seg): boolean {
  const d1 = (qx - px) * (s.ay - py) - (qy - py) * (s.ax - px);
  const d2 = (qx - px) * (s.by - py) - (qy - py) * (s.bx - px);
  const d3 = (s.bx - s.ax) * (py - s.ay) - (s.by - s.ay) * (px - s.ax);
  const d4 = (s.bx - s.ax) * (qy - s.ay) - (s.by - s.ay) * (qx - s.ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Where along the ray from p (unit direction d) it first meets s, or Infinity. */
function rayHit(px: number, py: number, dx: number, dy: number, s: Seg): number {
  const sx = s.bx - s.ax;
  const sy = s.by - s.ay;
  const den = dx * sy - dy * sx;
  if (Math.abs(den) < 1e-15) return Infinity;
  const t = ((s.ax - px) * sy - (s.ay - py) * sx) / den;
  const u = ((s.ax - px) * dy - (s.ay - py) * dx) / den;
  return t > 0 && u >= 0 && u <= 1 ? t : Infinity;
}

/** The two closest points of segments s and t. */
function closestPair(s: Seg, t: Seg): { a: Vec2; b: Vec2; d: number } {
  const proj = (px: number, py: number, q: Seg): Vec2 => {
    const rx = q.bx - q.ax;
    const ry = q.by - q.ay;
    const l2 = rx * rx + ry * ry;
    const u = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((px - q.ax) * rx + (py - q.ay) * ry) / l2));
    return { x: q.ax + rx * u, y: q.ay + ry * u };
  };
  let best = { a: { x: s.ax, y: s.ay }, b: proj(s.ax, s.ay, t), d: Infinity };
  const consider = (a: Vec2, b: Vec2) => {
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < best.d) best = { a, b, d };
  };
  consider({ x: s.ax, y: s.ay }, proj(s.ax, s.ay, t));
  consider({ x: s.bx, y: s.by }, proj(s.bx, s.by, t));
  consider(proj(t.ax, t.ay, s), { x: t.ax, y: t.ay });
  consider(proj(t.bx, t.by, s), { x: t.bx, y: t.by });
  return best;
}

/** The openings of the region a Fill tap at `w` failed to find (world units), or null. */
export function fillOpeningsAt(doc: Doc, w: Vec2): GapMarks | null {
  const strokes = repeatStrokes(doc);
  if (!strokes.length) return null;
  const R = motifRadius(doc);
  const tol = R * 0.003;
  const bridge = R * GAP_FRACTION;
  const E = repeatUnit(doc)?.extent ?? motifExtent(doc);
  const reach = E * 1.25;
  const pivot = doc.frame.origin;
  const { a, b } = doc.repeat;
  const det = a.x * b.y - a.y * b.x;
  if (Math.abs(det) < 1e-9) return null;

  // The copies whose drawing reaches the search disc.
  const dx = w.x - pivot.x;
  const dy = w.y - pivot.y;
  const fi = (dx * b.y - dy * b.x) / det;
  const fj = (a.x * dy - a.y * dx) / det;
  const span = reach + E;
  const ki = Math.ceil((span * Math.hypot(b.x, b.y)) / Math.abs(det)) + 1;
  const kj = Math.ceil((span * Math.hypot(a.x, a.y)) / Math.abs(det)) + 1;
  const lines: { pts: Vec2[]; lat: number }[] = [];
  let lat = 0;
  for (let j = Math.floor(fj) - kj; j <= Math.ceil(fj) + kj; j++) {
    for (let i = Math.floor(fi) - ki; i <= Math.ceil(fi) + ki; i++) {
      const pose = instancePose(doc.repeat, i, j);
      if (Math.hypot(pivot.x + pose.translate.x - w.x, pivot.y + pose.translate.y - w.y) > span) continue;
      for (const s of strokes) lines.push({ pts: s.pts.map((p) => transformPoint(pivot, pose, p)), lat });
      lat++;
      if (lat > 80) break;
    }
  }
  const segs: Seg[] = [];
  lines.forEach((l, line) => {
    for (let k = 0; k + 1 < l.pts.length; k++) {
      const p = l.pts[k]!;
      const q = l.pts[k + 1]!;
      if (distToSeg(w.x, w.y, { ax: p.x, ay: p.y, bx: q.x, by: q.y, line, k }) > reach * 1.6) continue;
      segs.push({ ax: p.x, ay: p.y, bx: q.x, by: q.y, line, k });
    }
  });
  if (!segs.length) return null;

  // A grid over the pieces, for the local questions below (dense artworks have many thousands).
  const cell = Math.max(reach / 6, tol * 50);
  const grid = new Map<string, number[]>();
  segs.forEach((sg, idx) => {
    for (let x = Math.floor(Math.min(sg.ax, sg.bx) / cell); x <= Math.floor(Math.max(sg.ax, sg.bx) / cell); x++)
      for (let y = Math.floor(Math.min(sg.ay, sg.by) / cell); y <= Math.floor(Math.max(sg.ay, sg.by) / cell); y++) {
        const key = `${x},${y}`;
        (grid.get(key) ?? grid.set(key, []).get(key)!).push(idx);
      }
  });
  const within = (x0: number, y0: number, x1: number, y1: number): Seg[] => {
    const out = new Set<number>();
    for (let x = Math.floor(Math.min(x0, x1) / cell); x <= Math.floor(Math.max(x0, x1) / cell); x++)
      for (let y = Math.floor(Math.min(y0, y1) / cell); y <= Math.floor(Math.max(y0, y1) / cell); y++) for (const idx of grid.get(`${x},${y}`) ?? []) out.add(idx);
    return [...out].map((idx) => segs[idx]!);
  };

  // Rays from the tap, all round: how much of the turn the curves cover, and where they escape. Each
  // piece is tested only against the rays within the angle it covers as seen from the tap.
  const step = (Math.PI * 2) / RAYS;
  const cosR = Array.from({ length: RAYS }, (_, n) => Math.cos(n * step));
  const sinR = Array.from({ length: RAYS }, (_, n) => Math.sin(n * step));
  const hits: ({ d: number; seg: Seg } | null)[] = new Array(RAYS).fill(null);
  for (const sg of segs) {
    const a1 = Math.atan2(sg.ay - w.y, sg.ax - w.x);
    let sweep = Math.atan2(sg.by - w.y, sg.bx - w.x) - a1;
    if (sweep > Math.PI) sweep -= Math.PI * 2;
    if (sweep < -Math.PI) sweep += Math.PI * 2;
    const lo = sweep >= 0 ? a1 : a1 + sweep;
    for (let n = Math.ceil(lo / step); n <= Math.floor((lo + Math.abs(sweep)) / step); n++) {
      const k = ((n % RAYS) + RAYS) % RAYS;
      const t = rayHit(w.x, w.y, cosR[k]!, sinR[k]!, sg);
      if (t < (hits[k]?.d ?? reach * 1.6)) hits[k] = { d: t, seg: sg };
    }
  }
  // Only where curves nearly surround the tap is there a region to be open (as in Construct's
  // openBoundary.ts): a tap beside a crossing or in open ground marks nothing.
  const covered = hits.filter((h) => h && h.d <= reach).length / RAYS;
  if (covered < MIN_COVERAGE) return null;

  // 1. Open ends the tap can see.
  const ends: { p: Vec2; d: number }[] = [];
  lines.forEach((l, line) => {
    const last = l.pts.length - 2;
    for (const [p, k] of [
      [l.pts[0]!, 0],
      [l.pts[l.pts.length - 1]!, last],
    ] as const) {
      const d = Math.hypot(p.x - w.x, p.y - w.y);
      if (d > reach) continue;
      const lim = Math.max(tol * 1.5, bridge);
      const touched = within(p.x - lim, p.y - lim, p.x + lim, p.y + lim).some((s) => {
        if (s.line === line && s.k === k) return false; // the end's own piece
        const limit = lines[s.line]!.lat !== l.lat ? Math.max(tol * 1.5, bridge) : tol * 1.5;
        return distToSeg(p.x, p.y, s) <= limit;
      });
      if (touched) continue;
      // Seen from the tap: stop just short of the end so its own curve is not counted.
      const back = Math.max(tol * 2, 1e-9);
      const qx = p.x + ((w.x - p.x) / Math.max(d, 1e-12)) * back;
      const qy = p.y + ((w.y - p.y) / Math.max(d, 1e-12)) * back;
      if (within(w.x, w.y, qx, qy).some((s) => crosses(w.x, w.y, qx, qy, s))) continue;
      if (ends.some((e) => Math.hypot(e.p.x - p.x, e.p.y - p.y) < tol * 3)) continue;
      ends.push({ p: { ...p }, d });
    }
  });
  if (ends.length) return { ends: ends.sort((p, q) => p.d - q.d).slice(0, MAX_ENDS).map((e) => e.p), necks: [] };

  const ds = hits.filter((h): h is { d: number; seg: Seg } => !!h).map((h) => h.d).sort((p, q) => p - q);
  // 2. Near misses: the rays escaping well past the rest pass between two curves that do not meet.
  const median = ds[Math.floor(ds.length / 2)]!;
  const escapes = hits.map((h) => !h || h.d > median * 3);
  if (!escapes.some(Boolean) || escapes.every(Boolean)) return null;
  const necks: { a: Vec2; b: Vec2; d: number }[] = [];
  const start = escapes.findIndex((e) => !e);
  for (let n = 0; n < RAYS; n++) {
    const k = (start + n) % RAYS;
    if (!escapes[(k + 1) % RAYS] || escapes[k]) continue; // k: last near ray before an escaping run
    let m = (k + 1) % RAYS;
    while (escapes[m]) m = (m + 1) % RAYS;
    const before = hits[k]!.seg;
    const after = hits[m]!.seg;
    if (before.line === after.line) continue;
    // The narrowest place between the two curves, near where the run escapes.
    const near = (line: number) => segs.filter((s) => s.line === line);
    let best: { a: Vec2; b: Vec2; d: number } | null = null;
    for (const s of near(before.line)) for (const t of near(after.line)) {
      const c = closestPair(s, t);
      if (!best || c.d < best.d) best = c;
    }
    // Small misses only: a wide opening is open ground, not a gap.
    if (!best || best.d <= tol * 1.5 || best.d > Math.min(median * 0.5, R * MAX_NECK_FRACTION)) continue;
    if (necks.some((x) => Math.hypot(x.a.x - best!.a.x, x.a.y - best!.a.y) < tol * 5)) continue;
    necks.push(best);
  }
  if (!necks.length) return null;
  return { ends: [], necks: necks.sort((p, q) => p.d - q.d).slice(0, MAX_NECKS).map(({ a, b }) => ({ a, b })) };
}
