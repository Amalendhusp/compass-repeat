// Intersect as a linked editing workspace. Every Intersect instance is the ONE construction, shown
// through a placement (a turn about the frame centre, then a shift) — so an instance is never a
// copy of the geometry, and there is nothing to keep in step.
//
// Editing through an instance: a placement followed by the workspace camera is itself just a camera
// (the same zoom, another pan, the two rotations added — instanceCamera). The Construct tools run
// through that camera for the active instance, unchanged: every tap lands in the construction's own
// coordinates exactly, and what they commit is an ordinary edit of the one construction — which
// every instance, Construct and Repeat then show.
//
// Contextual targets: where the instances lie over one another, new places appear that belong to
// the arrangement, not to the construction — another instance's points, and the crossings between
// two different instances' drawn geometry (line × line, line × circle/arc, circle × circle). They
// are worked out only around the finger, from the pieces near it, in the active instance's own
// frame; never stored. Used, such a place becomes an ordinary free point of the construction, at
// that position — not tied to the arrangement that produced it.

import type { Camera, Doc, Entity, Vec2 } from '../model/types.ts';
import { resolveEntityGeom } from './kernel.ts';
import { defaultSegmentKind, deriveSegments, paramInRange } from './segments.ts';
import type { InstancePose } from './lattice.ts';
import type { IntersectionCopy } from './intersection.ts';
import { localPoints, pointShown } from './intersectionSnap.ts';

const turn = (v: Vec2, a: number): Vec2 => {
  const c = Math.cos(a);
  const n = Math.sin(a);
  return { x: v.x * c - v.y * n, y: v.x * n + v.y * c };
};

/**
 * The camera through which an instance shows the construction: the workspace camera after the
 * instance's placement. With pose p ↦ turn(p − pivot) + pivot + t and camera
 * s = centre + turnCam((q + pan) × zoom): pan′ = turn⁻¹(pivot + t + pan) − pivot, and the rotations add.
 */
export function instanceCamera(camera: Camera, pivot: Vec2, pose: InstancePose): Camera {
  const r = turn({ x: pivot.x + pose.translate.x + camera.pan.x, y: pivot.y + pose.translate.y + camera.pan.y }, -pose.rotation);
  const rotation = (camera.rotation ?? 0) + pose.rotation;
  return { zoom: camera.zoom, pan: { x: r.x - pivot.x, y: r.y - pivot.y }, ...(rotation ? { rotation } : null) };
}

// ---- what a copy draws, as pieces (once per document) ----

type LocalPiece =
  | { kind: 'line'; a: Vec2; d: Vec2; t0: number; t1: number; ext: boolean; whole: boolean }
  | { kind: 'arc'; c: Vec2; r: number; from: number; to: number; full: boolean; ext: boolean };

const pieceCache = new WeakMap<Doc, LocalPiece[]>();

function pieceOf(entity: Entity, g: ReturnType<typeof resolveEntityGeom>, from: number | null, to: number | null, ext: boolean, whole: boolean): LocalPiece | null {
  if (g.kind === 'circle') {
    if (!(g.radius > 1e-9)) return null;
    return { kind: 'arc', c: g.centre, r: g.radius, from: from ?? 0, to: to ?? 0, full: from === null, ext };
  }
  if (entity.kind !== 'line') return null;
  const d = { x: g.b.x - g.a.x, y: g.b.y - g.a.y };
  if (Math.hypot(d.x, d.y) < 1e-9) return null;
  return { kind: 'line', a: g.a, d, t0: from ?? 0, t1: to ?? 1, ext, whole };
}

/** Every drawn piece of the construction (unplaced): Construction / Fair pieces, Extension pieces
 * (`ext`), and each extended line as the whole line (`whole`, an extension too). */
function localPieces(doc: Doc): LocalPiece[] {
  let out = pieceCache.get(doc);
  if (out) return out;
  out = [];
  for (const entity of doc.entities) {
    const g = resolveEntityGeom(doc, entity);
    if (entity.kind === 'line' && entity.extended) {
      const whole = pieceOf(entity, g, null, null, true, true);
      if (whole) out.push(whole);
    }
    const segs = deriveSegments(doc, entity);
    if (segs.length === 0) {
      const p = pieceOf(entity, g, null, null, false, false);
      if (p) out.push(p);
      continue;
    }
    for (const seg of segs) {
      const kind = doc.segmentStates.get(seg.key)?.state ?? defaultSegmentKind(entity, seg);
      if (kind === 'trimmed') continue;
      const p = pieceOf(entity, g, seg.fromParam, seg.toParam, kind === 'extension', false);
      if (p) out.push(p);
    }
  }
  pieceCache.set(doc, out);
  return out;
}

// ---- pieces in the active instance's own frame ----

type Placed = { copy: string } & ({ kind: 'line'; a: Vec2; d: Vec2; t0: number; t1: number; whole: boolean } | { kind: 'arc'; c: Vec2; r: number; from: number; to: number; full: boolean });

/** How instance `b` lies in instance `a`'s own frame: p ↦ turn(p − pivot, by) + pivot + shift. */
function relativePose(a: InstancePose, b: InstancePose): { by: number; shift: Vec2 } {
  return { by: b.rotation - a.rotation, shift: turn({ x: b.translate.x - a.translate.x, y: b.translate.y - a.translate.y }, -a.rotation) };
}

const TOL = 1e-7;
/** An angle in [0, 2π) — how arc ranges are kept (paramInRange). */
const norm = (a: number) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

function distToPiece(p: LocalPiece, m: Vec2): number {
  if (p.kind === 'arc') {
    const dx = m.x - p.c.x;
    const dy = m.y - p.c.y;
    return Math.abs(Math.hypot(dx, dy) - p.r); // the range is checked on what crosses, not here
  }
  const len2 = p.d.x * p.d.x + p.d.y * p.d.y;
  let t = ((m.x - p.a.x) * p.d.x + (m.y - p.a.y) * p.d.y) / len2;
  if (!p.whole) t = Math.min(p.t1, Math.max(p.t0, t));
  return Math.hypot(m.x - (p.a.x + p.d.x * t), m.y - (p.a.y + p.d.y * t));
}

const onLine = (l: Extract<Placed, { kind: 'line' }>, t: number) => l.whole || (t >= l.t0 - TOL && t <= l.t1 + TOL);
const onArc = (a: Extract<Placed, { kind: 'arc' }>, at: Vec2) => a.full || paramInRange(Math.atan2(at.y - a.c.y, at.x - a.c.x), a.from, a.to, true);

/** Where two placed pieces cross, within what each draws. */
function crossings(p: Placed, q: Placed): Vec2[] {
  if (p.kind === 'line' && q.kind === 'line') {
    const den = p.d.x * q.d.y - p.d.y * q.d.x;
    if (Math.abs(den) < 1e-12) return [];
    const wx = q.a.x - p.a.x;
    const wy = q.a.y - p.a.y;
    const t = (wx * q.d.y - wy * q.d.x) / den;
    const s = (wx * p.d.y - wy * p.d.x) / den;
    return onLine(p, t) && onLine(q, s) ? [{ x: p.a.x + p.d.x * t, y: p.a.y + p.d.y * t }] : [];
  }
  if (p.kind === 'arc' && q.kind === 'line') return crossings(q, p);
  if (p.kind === 'line' && q.kind === 'arc') {
    // |a + t d − c|² = r²
    const fx = p.a.x - q.c.x;
    const fy = p.a.y - q.c.y;
    const A = p.d.x * p.d.x + p.d.y * p.d.y;
    const B = 2 * (fx * p.d.x + fy * p.d.y);
    const C = fx * fx + fy * fy - q.r * q.r;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return [];
    const root = Math.sqrt(disc);
    const out: Vec2[] = [];
    for (const t of disc < 1e-18 ? [-B / (2 * A)] : [(-B - root) / (2 * A), (-B + root) / (2 * A)]) {
      const at = { x: p.a.x + p.d.x * t, y: p.a.y + p.d.y * t };
      if (onLine(p, t) && onArc(q, at)) out.push(at);
    }
    return out;
  }
  if (p.kind === 'arc' && q.kind === 'arc') {
    const dx = q.c.x - p.c.x;
    const dy = q.c.y - p.c.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-9 || d > p.r + q.r || d < Math.abs(p.r - q.r)) return [];
    const along = (d * d + p.r * p.r - q.r * q.r) / (2 * d);
    const h2 = p.r * p.r - along * along;
    const h = h2 > 0 ? Math.sqrt(h2) : 0;
    const mx = p.c.x + (dx * along) / d;
    const my = p.c.y + (dy * along) / d;
    const pts = h < 1e-9 ? [{ x: mx, y: my }] : [
      { x: mx - (dy * h) / d, y: my + (dx * h) / d },
      { x: mx + (dy * h) / d, y: my - (dx * h) / d },
    ];
    return pts.filter((at) => onArc(p, at) && onArc(q, at));
  }
  return [];
}

export interface ContextPoint {
  /** In the active instance's own (construction) coordinates. */
  at: Vec2;
  /** Its distance from the finger, in the same units. */
  d: number;
  label: string;
}

/** Each copy's pieces near `m` (a position in the ACTIVE instance's frame, within `reach`), placed
 * in that frame. A copy whose Extensions are off offers none of its extension geometry. */
function placedNear(doc: Doc, copies: IntersectionCopy[], active: IntersectionCopy, m: Vec2, reach: number): Placed[] {
  const pivot = doc.frame.origin;
  const out: Placed[] = [];
  for (const copy of copies) {
    const rel = relativePose(active.pose, copy.pose);
    // The finger, in this copy's own frame — so its pieces are tested where they are stored.
    const back = turn({ x: m.x - pivot.x - rel.shift.x, y: m.y - pivot.y - rel.shift.y }, -rel.by);
    const local = { x: back.x + pivot.x, y: back.y + pivot.y };
    const place = (p: Vec2): Vec2 => {
      const r = turn({ x: p.x - pivot.x, y: p.y - pivot.y }, rel.by);
      return { x: r.x + pivot.x + rel.shift.x, y: r.y + pivot.y + rel.shift.y };
    };
    for (const p of localPieces(doc)) {
      if (p.ext && !copy.extensions) continue;
      if (distToPiece(p, local) > reach) continue;
      if (p.kind === 'line') out.push({ copy: copy.key, kind: 'line', a: place(p.a), d: turn(p.d, rel.by), t0: p.t0, t1: p.t1, whole: p.whole });
      else out.push({ copy: copy.key, kind: 'arc', c: place(p.c), r: p.r, from: norm(p.from + rel.by), to: norm(p.to + rel.by), full: p.full });
    }
  }
  return out;
}

/**
 * The contextual place nearest `m` (a position in the active instance's frame), within `reach`:
 * a crossing between two different instances' drawn geometry, or another instance's own point.
 * Null when there is none there.
 */
export function contextPointNear(doc: Doc, copies: IntersectionCopy[], activeKey: string, m: Vec2, reach: number): ContextPoint | null {
  const active = copies.find((c) => c.key === activeKey);
  if (!active || copies.length < 2) return null;
  const pivot = doc.frame.origin;
  let best: ContextPoint | null = null;
  const consider = (at: Vec2, label: string) => {
    const d = Math.hypot(at.x - m.x, at.y - m.y);
    if (d <= reach && (!best || d < best.d - 1e-12)) best = { at, d, label };
  };
  // Other instances' own points (those that read as points in what they draw).
  for (const copy of copies) {
    if (copy.key === activeKey) continue;
    const rel = relativePose(active.pose, copy.pose);
    for (const p of localPoints(doc)) {
      const r = turn({ x: p.at.x - pivot.x, y: p.at.y - pivot.y }, rel.by);
      const at = { x: r.x + pivot.x + rel.shift.x, y: r.y + pivot.y + rel.shift.y };
      if (Math.abs(at.x - m.x) > reach || Math.abs(at.y - m.y) > reach) continue;
      if (pointShown(doc, p.id, p.at, copy.extensions)) consider(at, `Point · ${copy.label}`);
    }
  }
  // Crossings between two different instances' pieces.
  const near = placedNear(doc, copies, active, m, reach);
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      if (near[i]!.copy === near[j]!.copy) continue;
      for (const at of crossings(near[i]!, near[j]!)) consider(at, 'Crossing');
    }
  }
  return best;
}

/** Every straight line of ANOTHER instance within `reach` of `m` (active frame) — as the two ends
 * of what it draws there, and how far it is — nearest first: for a Parallel / Perpendicular reference. */
export function contextLinesNear(doc: Doc, copies: IntersectionCopy[], activeKey: string, m: Vec2, reach: number): { a: Vec2; b: Vec2; d: number }[] {
  const active = copies.find((c) => c.key === activeKey);
  if (!active) return [];
  const out: { a: Vec2; b: Vec2; d: number }[] = [];
  for (const p of placedNear(doc, copies, active, m, reach)) {
    if (p.kind !== 'line' || p.copy === activeKey) continue;
    const len2 = p.d.x * p.d.x + p.d.y * p.d.y;
    let t = ((m.x - p.a.x) * p.d.x + (m.y - p.a.y) * p.d.y) / len2;
    if (!p.whole) t = Math.min(p.t1, Math.max(p.t0, t));
    const d = Math.hypot(m.x - (p.a.x + p.d.x * t), m.y - (p.a.y + p.d.y * t));
    out.push({ a: p.a, b: { x: p.a.x + p.d.x, y: p.a.y + p.d.y }, d });
  }
  return out.sort((x, y) => x.d - y.d);
}

/** The nearest of those lines (contextLinesNear), or null. */
export function contextLineNear(doc: Doc, copies: IntersectionCopy[], activeKey: string, m: Vec2, reach: number): { a: Vec2; b: Vec2 } | null {
  const best = contextLinesNear(doc, copies, activeKey, m, reach)[0];
  return best ? { a: best.a, b: best.b } : null;
}

/** The other instance (if any) with drawn geometry — a line, an arc or one of its points — nearest
 * `m` (a position in the frame of the instance `fromKey`), and how far off that is: for a tap that is
 * on another instance, not the active one. */
export function instanceUnder(doc: Doc, copies: IntersectionCopy[], fromKey: string, m: Vec2, reach: number): { key: string; d: number } | null {
  const from = copies.find((c) => c.key === fromKey);
  if (!from) return null;
  const pivot = doc.frame.origin;
  let best: { key: string; d: number } | null = null;
  for (const copy of copies) {
    if (copy.key === fromKey) continue;
    const rel = relativePose(from.pose, copy.pose);
    const back = turn({ x: m.x - pivot.x - rel.shift.x, y: m.y - pivot.y - rel.shift.y }, -rel.by);
    const local = { x: back.x + pivot.x, y: back.y + pivot.y };
    for (const p of localPieces(doc)) {
      if (p.ext && !copy.extensions) continue;
      if (p.kind === 'arc' && !p.full && !paramInRange(Math.atan2(local.y - p.c.y, local.x - p.c.x), p.from, p.to, true)) continue;
      const d = distToPiece(p, local);
      if (d <= reach && (!best || d < best.d)) best = { key: copy.key, d };
    }
    for (const p of localPoints(doc)) {
      const d = Math.hypot(local.x - p.at.x, local.y - p.at.y);
      if (d <= reach && (!best || d < best.d) && pointShown(doc, p.id, p.at, copy.extensions)) best = { key: copy.key, d };
    }
  }
  return best;
}

/** How far each instance's drawn geometry (its shown lines and arcs, and its shown points) is from
 * the world position `w` — for every instance whose geometry comes within `reach` (world units).
 * Unlike instanceUnder, this is measured in world space for all instances, the active one included:
 * for Intersect's own instance selection. */
export function instanceDistances(doc: Doc, copies: IntersectionCopy[], w: Vec2, reach: number): Map<string, number> {
  const pivot = doc.frame.origin;
  const out = new Map<string, number>();
  for (const copy of copies) {
    const back = turn({ x: w.x - pivot.x - copy.pose.translate.x, y: w.y - pivot.y - copy.pose.translate.y }, -copy.pose.rotation);
    const local = { x: back.x + pivot.x, y: back.y + pivot.y };
    let best = Infinity;
    for (const p of localPieces(doc)) {
      if (p.ext && !copy.extensions) continue;
      if (p.kind === 'arc' && !p.full && !paramInRange(Math.atan2(local.y - p.c.y, local.x - p.c.x), p.from, p.to, true)) continue;
      best = Math.min(best, distToPiece(p, local));
    }
    for (const p of localPoints(doc)) {
      const d = Math.hypot(local.x - p.at.x, local.y - p.at.y);
      if (d < best && pointShown(doc, p.id, p.at, copy.extensions)) best = d;
    }
    if (best <= reach) out.set(copy.key, best);
  }
  return out;
}
