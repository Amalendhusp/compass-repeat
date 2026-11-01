// Sprint S3 — Interlaced strokes: where the repeated design's lines genuinely cross, one band passes over
// and the other under, as in Alhambra strapwork. Purely a way of drawing: no Fair path is cut, moved or
// deleted; the crossings and their over/under are derived here and drawn over the flat bands
// (render/repeatRenderer.ts).
//
// The network. What repeats (the Construct motif, or the Intersect unit with the Developed Primary) is
// placed for the copies around the reference and turned into one planar arrangement — the same splitting
// Fill and Space use (spaces.ts planarSubs: split where copies cross, where a point lies on a piece,
// coincident pieces kept once). At each vertex:
// - two pieces: the band simply runs on (a corner or a curve);
// - four pieces forming two straight-through strands that alternate round the vertex: a CROSSING;
// - anything else (an end, a T, three lines through one point, two corners touching): a junction —
//   drawn flat, no over/under.
// Identity. A crossing is known by which pieces cross there, each with its copy offset taken relative to
// the crossing (a shift by the pattern's period only — as Space classes are), so every copy of the same
// crossing is one CLASS with one id: spacing changes that keep the arrangement keep it, and a reversal
// survives save/reopen. Two classes reading the same get `#n` by their place in the copy.
// Automatic weave. Along every strand the bands alternate over, under, over… Each class has one unknown
// (which strand is over); each pair of consecutive crossings along a strand says the strand changes
// there. Solved as a two-colouring with parity (union–find). Where a cycle cannot alternate (an odd loop,
// or a period that forces it), the constraint is not forced: those crossings are reported as conflicts,
// and the designer may reverse any crossing by hand (`flips`).
//
// Computed once per change of geometry or arrangement (cached); never while a handle is being dragged.

import type { Doc, RepeatSystem, Vec2 } from '../model/types.ts';
import { Arrangement, patternPeriod, planarSubs, repeatStrokes, type Edge, type Source, type Sub } from './spaces.ts';
import { instancePose, motifExtent, motifRadius, transformPoint } from './lattice.ts';
import { repeatUnit } from './repeatUnit.ts';

/** One strand through a crossing: the points leaving it each way (crossing point excluded) and how far
 * a band piece may run that way before the next crossing's own piece (or a junction / end). */
export interface WeaveStrand {
  back: Vec2[];
  fwd: Vec2[];
  backRoom: number;
  fwdRoom: number;
}

export interface WeaveCrossing {
  key: string;
  /** The representative instance (the one nearest the reference), world units. */
  at: Vec2;
  strands: [WeaveStrand, WeaveStrand];
  /** |sin| of the angle between the two strands. */
  sin: number;
  /** Automatic weave: which of `strands` passes over (before any reversal). */
  over: 0 | 1;
  /** Part of a cycle that cannot alternate. */
  conflict: boolean;
}

export interface WeaveNetwork {
  crossings: WeaveCrossing[];
  /** The pattern's period: every crossing appears at `at` + m·u + n·v. */
  u: Vec2;
  v: Vec2;
  /** Crossing classes whose alternation could not be kept. */
  conflicts: number;
  /** Vertices where lines meet but do not simply cross (drawn flat). */
  junctions: number;
}

const EMPTY: WeaveNetwork = { crossings: [], u: { x: 0, y: 0 }, v: { x: 0, y: 0 }, conflicts: 0, junctions: 0 };
const MAX_COPIES = 160;
/** How far from straight a strand may turn at a crossing and still read as passing through (radians). */
const STRAIGHT_TOL = (50 * Math.PI) / 180;

interface Half {
  sub: number;
  to: number;
  angle: number;
}

/** The crossing network of the committed arrangement (cached). */
export function weaveNetwork(doc: Doc): WeaveNetwork {
  const hit = byDoc.get(doc);
  if (hit) return hit;
  const strokes = repeatStrokes(doc);
  const key = contentKey(doc, strokes);
  const net = last?.key === key ? last.net : build(doc, strokes);
  last = { key, net };
  byDoc.set(doc, net);
  return net;
}

const byDoc = new WeakMap<Doc, WeaveNetwork>();
let last: { key: string; net: WeaveNetwork } | null = null;

function contentKey(doc: Doc, strokes: { id: string; pts: Vec2[] }[]): string {
  const q = motifRadius(doc) * 1e-6;
  const r = (x: number) => Math.round(x / q);
  const rep = doc.repeat;
  const parts: (string | number | undefined)[] = ['weave', rep.family, rep.rule.kind, r(rep.a.x), r(rep.a.y), r(rep.b.x), r(rep.b.y), Math.round(rep.motif.rotation * 1e9), r(doc.frame.origin.x), r(doc.frame.origin.y), r(doc.frame.radius)];
  for (const s of strokes) parts.push(s.id, ...s.pts.flatMap((p) => [r(p.x), r(p.y)]));
  return parts.join(',');
}

function build(doc: Doc, strokes: { id: string; pts: Vec2[]; member: number }[]): WeaveNetwork {
  const repeat: RepeatSystem = doc.repeat;
  const { a, b } = repeat;
  const det = a.x * b.y - a.y * b.x;
  if (!strokes.length || Math.abs(det) < 1e-9) return EMPTY;
  const R = motifRadius(doc);
  const tol = R * 0.003;
  const E = repeatUnit(doc)?.extent ?? motifExtent(doc);
  const pivot = doc.frame.origin;
  const { u, v, parity } = patternPeriod(repeat);

  // The copies around the reference: enough that every crossing class appears complete near it.
  const reach = 2 * E + Math.hypot(u.x, u.y) + Math.hypot(v.x, v.y);
  const ki = Math.ceil((reach * Math.hypot(b.x, b.y)) / Math.abs(det)) + 1;
  const kj = Math.ceil((reach * Math.hypot(a.x, a.y)) / Math.abs(det)) + 1;
  let poses = [];
  for (let j = -kj; j <= kj; j++) for (let i = -ki; i <= ki; i++) poses.push(instancePose(repeat, i, j));
  const dist = (p: { translate: Vec2 }) => Math.hypot(p.translate.x, p.translate.y);
  poses = poses.filter((p) => dist(p) <= reach).sort((p, q) => dist(p) - dist(q)).slice(0, MAX_COPIES);
  poses.sort((p, q) => p.j - q.j || p.i - q.i);

  const members = Math.max(1, ...strokes.map((s) => s.member + 1));
  const arr = new Arrangement(tol);
  const edges: Edge[] = [];
  poses.forEach((pose, lat) => {
    for (const s of strokes) {
      const src: Source = { i: pose.i, j: pose.j, entityId: s.id };
      let prev = arr.vertex(transformPoint(pivot, pose, s.pts[0]!));
      for (let k = 1; k < s.pts.length; k++) {
        const next = arr.vertex(transformPoint(pivot, pose, s.pts[k]!));
        if (next !== prev) edges.push({ a: prev, b: next, src, copy: lat * members + s.member, lat });
        prev = next;
      }
    }
  });
  const cell = Math.max(E / 6, tol * 20);
  const subs: Sub[] = planarSubs(arr, edges, tol, cell, 0);
  const { xs, ys } = arr;
  const P = (n: number): Vec2 => ({ x: xs[n]!, y: ys[n]! });

  // The pieces at each vertex, round it.
  const at = new Map<number, Half[]>();
  subs.forEach((sb, idx) => {
    const add = (from: number, to: number) => (at.get(from) ?? at.set(from, []).get(from)!).push({ sub: idx, to, angle: Math.atan2(ys[to]! - ys[from]!, xs[to]! - xs[from]!) });
    add(sb.from, sb.to);
    add(sb.to, sb.from);
  });
  for (const list of at.values()) list.sort((p, q) => p.angle - q.angle);
  const straight = (p: Half, q: Half) => {
    let d = Math.abs(p.angle - q.angle) % (Math.PI * 2);
    if (d > Math.PI) d = Math.PI * 2 - d;
    return Math.PI - d <= STRAIGHT_TOL;
  };
  const crossingAt = new Map<number, [Half, Half, Half, Half]>(); // strands (0,2) and (1,3)
  let junctions = 0;
  for (const [vtx, list] of at) {
    if (list.length === 2 || list.length === 1) continue;
    if (list.length === 4 && straight(list[0]!, list[2]!) && straight(list[1]!, list[3]!)) crossingAt.set(vtx, list as [Half, Half, Half, Half]);
    else junctions++;
  }
  if (!crossingAt.size) return { ...EMPTY, u, v, junctions };

  // Walk along a strand from `vtx` leaving by `h`: through bends, until the next crossing (then also which
  // strand of it), a junction or an end. Only the first `cap` of the way is kept as points (all a band
  // piece over a crossing can ever need).
  const cap = R * 0.75;
  interface Walk {
    pts: Vec2[];
    length: number;
    next: { vtx: number; strand: 0 | 1 } | null;
    ended: boolean;
  }
  const walk = (vtx: number, h: Half): Walk => {
    const pts: Vec2[] = [];
    let length = 0;
    let from = vtx;
    let cur = h;
    for (let guard = 0; guard < 100000; guard++) {
      const to = cur.to;
      if (length <= cap) pts.push(P(to));
      length += Math.hypot(xs[to]! - xs[from]!, ys[to]! - ys[from]!);
      const c = crossingAt.get(to);
      if (c) {
        const k = c.findIndex((x) => x.sub === cur.sub);
        return { pts, length, next: { vtx: to, strand: (k % 2) as 0 | 1 }, ended: false };
      }
      const list = at.get(to)!;
      if (list.length !== 2) return { pts, length, next: null, ended: true };
      const on = list[0]!.sub === cur.sub ? list[1]! : list[0]!;
      from = to;
      cur = on;
    }
    return { pts, length, next: null, ended: true };
  };

  // Identity: each crossing's pieces, relative to the crossing's own copies.
  const crossings = [...crossingAt.entries()];
  const info = new Map<number, { base: string; canon: 0 | 1; local: Vec2 }>();
  for (const [vtx, hs] of crossings) {
    const srcs = hs.map((h) => subs[h.sub]!.src);
    let min = srcs[0]!;
    for (const s of srcs) if (s.j < min.j || (s.j === min.j && s.i < min.i)) min = s;
    let si = -min.i;
    let sj = -min.j;
    if (parity && (((si + sj) % 2) + 2) % 2 === 1) si += 1;
    const str = (s: Source) => `${s.i + si},${s.j + sj},${s.entityId}`;
    const strand = (p: Source, q: Source) => [str(p), str(q)].sort().join('~');
    const s0 = strand(srcs[0]!, srcs[2]!);
    const s1 = strand(srcs[1]!, srcs[3]!);
    const base = s0 <= s1 ? `${s0}×${s1}` : `${s1}×${s0}`;
    const frame = instancePose(repeat, -si, -sj).translate;
    info.set(vtx, { base, canon: s0 <= s1 ? 0 : 1, local: { x: xs[vtx]! - pivot.x - frame.x, y: ys[vtx]! - pivot.y - frame.y } });
  }
  // Classes: the same pieces crossing at the same place in the copy.
  const groups = new Map<string, { local: Vec2; members: number[] }[]>();
  for (const [vtx] of crossings) {
    const inf = info.get(vtx)!;
    const list = groups.get(inf.base) ?? groups.set(inf.base, []).get(inf.base)!;
    const g = list.find((x) => Math.hypot(x.local.x - inf.local.x, x.local.y - inf.local.y) < tol * 10);
    if (g) g.members.push(vtx);
    else list.push({ local: inf.local, members: [vtx] });
  }
  const classOf = new Map<number, string>();
  for (const [base, list] of groups) {
    list.sort((p, q) => Math.round(p.local.y / tol) - Math.round(q.local.y / tol) || p.local.x - q.local.x);
    list.forEach((g, n) => {
      const key = list.length > 1 ? `${base}#${n + 1}` : base;
      for (const vtx of g.members) classOf.set(vtx, key);
    });
  }

  // Alternation along every strand, as parity constraints between classes.
  const keys = [...new Set(classOf.values())].sort();
  const index = new Map(keys.map((k, n) => [k, n] as const));
  const parent = keys.map((_, n) => n);
  const par = keys.map(() => 0);
  const find = (x: number): [number, number] => {
    let p = 0;
    let r = x;
    while (parent[r] !== r) {
      p ^= par[r]!;
      r = parent[r]!;
    }
    // Path compression (parities recomputed on the way).
    let y = x;
    let py = p;
    while (parent[y] !== y) {
      const nxt = parent[y]!;
      const pn = py ^ par[y]!;
      parent[y] = r;
      par[y] = py;
      y = nxt;
      py = pn;
    }
    return [r, p];
  };
  const conflict = new Set<string>();
  const walks = new Map<number, Walk[]>(); // per crossing: strand 0 back, strand 0 fwd, strand 1 back, strand 1 fwd
  for (const [vtx, hs] of crossings) {
    const w = [walk(vtx, hs[0]), walk(vtx, hs[2]), walk(vtx, hs[1]), walk(vtx, hs[3])];
    walks.set(vtx, w);
    const me = classOf.get(vtx)!;
    const canon = info.get(vtx)!.canon;
    w.forEach((wk, n) => {
      if (!wk.next) return;
      const k = (n < 2 ? 0 : 1) as 0 | 1;
      const other = classOf.get(wk.next.vtx)!;
      const otherCanon = info.get(wk.next.vtx)!.canon;
      // over(c,k) ⇔ X_c = k ⊕ canon_c ; the strand alternates: over(c,k) ≠ over(c',k').
      const need = 1 ^ k ^ canon ^ wk.next.strand ^ otherCanon;
      const [ra, pa] = find(index.get(me)!);
      const [rb, pb] = find(index.get(other)!);
      if (ra === rb) {
        if ((pa ^ pb) !== need) {
          conflict.add(me);
          conflict.add(other);
        }
      } else if (ra < rb) {
        parent[rb] = ra;
        par[rb] = pa ^ pb ^ need;
      } else {
        parent[ra] = rb;
        par[ra] = pa ^ pb ^ need;
      }
    });
  }

  // One representative per class (nearest the reference), with its strands' band room.
  const reps = new Map<string, number>();
  const d2 = (vtx: number) => (xs[vtx]! - pivot.x) ** 2 + (ys[vtx]! - pivot.y) ** 2;
  for (const [vtx] of crossings) {
    const k = classOf.get(vtx)!;
    const was = reps.get(k);
    if (was === undefined || d2(vtx) < d2(was)) reps.set(k, vtx);
  }
  const room = (wk: Walk) => (wk.next ? wk.length / 2 : wk.length);
  const out: WeaveCrossing[] = [];
  for (const key of keys) {
    const vtx = reps.get(key)!;
    const hs = crossingAt.get(vtx)!;
    const w = walks.get(vtx)!;
    const canon = info.get(vtx)!.canon;
    const X = find(index.get(key)!)[1]; // canonical over strand
    const d0 = { x: Math.cos(hs[0].angle), y: Math.sin(hs[0].angle) };
    const d1 = { x: Math.cos(hs[1].angle), y: Math.sin(hs[1].angle) };
    out.push({
      key,
      at: P(vtx),
      strands: [
        { back: w[0]!.pts, fwd: w[1]!.pts, backRoom: room(w[0]!), fwdRoom: room(w[1]!) },
        { back: w[2]!.pts, fwd: w[3]!.pts, backRoom: room(w[2]!), fwdRoom: room(w[3]!) },
      ],
      sin: Math.abs(d0.x * d1.y - d0.y * d1.x),
      over: (X ^ canon) as 0 | 1,
      conflict: conflict.has(key),
    });
  }
  return { crossings: out, u, v, conflicts: conflict.size, junctions };
}

/** The part of a strand drawn over the crossing: `len` each way (limited by its room), through `at`. */
export function strandPiece(at: Vec2, s: WeaveStrand, len: number): Vec2[] {
  const trim = (pts: Vec2[], L: number): Vec2[] => {
    const out: Vec2[] = [];
    let prev = at;
    let run = 0;
    for (const p of pts) {
      const d = Math.hypot(p.x - prev.x, p.y - prev.y);
      if (run + d >= L) {
        const t = d > 0 ? (L - run) / d : 0;
        out.push({ x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t });
        return out;
      }
      out.push(p);
      run += d;
      prev = p;
    }
    return out;
  };
  return [...trim(s.back, Math.min(len, s.backRoom)).reverse(), at, ...trim(s.fwd, Math.min(len, s.fwdRoom))];
}

/** Which strand passes over at a crossing, with the designer's reversals. */
export function overStrand(c: WeaveCrossing, flips: ReadonlySet<string>): 0 | 1 {
  return (flips.has(c.key) ? 1 - c.over : c.over) as 0 | 1;
}

/** Each translation of the period at which a point (± `reach`) shows within the box. */
export function periodTranslations(at: Vec2, u: Vec2, v: Vec2, box: { minX: number; minY: number; maxX: number; maxY: number }, reach: number, cap = 6000): Vec2[] {
  const det = u.x * v.y - u.y * v.x;
  if (Math.abs(det) < 1e-12) return [];
  let mMin = Infinity;
  let mMax = -Infinity;
  let nMin = Infinity;
  let nMax = -Infinity;
  for (const [x, y] of [
    [box.minX - reach, box.minY - reach],
    [box.maxX + reach, box.minY - reach],
    [box.minX - reach, box.maxY + reach],
    [box.maxX + reach, box.maxY + reach],
  ] as const) {
    const dx = x - at.x;
    const dy = y - at.y;
    const m = (dx * v.y - dy * v.x) / det;
    const n = (u.x * dy - u.y * dx) / det;
    mMin = Math.min(mMin, m);
    mMax = Math.max(mMax, m);
    nMin = Math.min(nMin, n);
    nMax = Math.max(nMax, n);
  }
  const out: Vec2[] = [];
  for (let n = Math.floor(nMin); n <= Math.ceil(nMax); n++) {
    for (let m = Math.floor(mMin); m <= Math.ceil(mMax); m++) {
      const t = { x: m * u.x + n * v.x, y: m * u.y + n * v.y };
      const x = at.x + t.x;
      const y = at.y + t.y;
      if (x < box.minX - reach || x > box.maxX + reach || y < box.minY - reach || y > box.maxY + reach) continue;
      out.push(t);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** The crossing instance nearest a world point (within `reach`), for reversing it by a tap. */
export function crossingNear(net: WeaveNetwork, w: Vec2, reach: number): { crossing: WeaveCrossing; at: Vec2 } | null {
  const det = net.u.x * net.v.y - net.u.y * net.v.x;
  if (Math.abs(det) < 1e-12) return null;
  let best: { crossing: WeaveCrossing; at: Vec2; d: number } | null = null;
  for (const c of net.crossings) {
    const dx = w.x - c.at.x;
    const dy = w.y - c.at.y;
    const m0 = Math.round((dx * net.v.y - dy * net.v.x) / det);
    const n0 = Math.round((net.u.x * dy - net.u.y * dx) / det);
    for (let m = m0 - 1; m <= m0 + 1; m++)
      for (let n = n0 - 1; n <= n0 + 1; n++) {
        const p = { x: c.at.x + m * net.u.x + n * net.v.x, y: c.at.y + m * net.u.y + n * net.v.y };
        const d = Math.hypot(p.x - w.x, p.y - w.y);
        if (d <= reach && (!best || d < best.d)) best = { crossing: c, at: p, d };
      }
  }
  return best ? { crossing: best.crossing, at: best.at } : null;
}
