// Intersection: explicit, deliberate Snap — never magnetic. The participant picks two features of
// two different constructions, the first as the reference (it stays put) and the second as the
// moving one; one precise operation then moves only the second one's construction, as one step:
//
// - two lines → Parallel: turns the moving construction about its own centre by the smallest angle
//   that makes its line parallel to the reference line. Never moves it.
// - two parallel lines → Join: slides the moving construction straight across (perpendicular to the
//   lines) until its line lies on the reference line. Never turns it.
// - two points → Snap: slides the moving construction until its point lies on the reference point.
//   Never turns it.
// - Match Edge (the Edge switch) picks in the other order — the edge that moves first, then the edge
//   it goes onto — and makes the two edges coincide in one exact rigid move: it turns the moving
//   construction until the edges run the same way (the smaller of the two turns that do), then
//   slides it until their middles meet, so equal edges end exactly end to end.
//
// What can be picked — of each construction as shown:
// - a line: any straight line with something visible — its Construction / Fair pieces always; its
//   extensions only while that copy's Extensions switch is on (an extended line is then the whole
//   infinite line). A copy whose Extensions are off offers nothing it doesn't draw.
// - a point: any of the construction's own points that is part of what it shows — on a piece that
//   is drawn, or the centre of a drawn circle (vertices, centres, the crossings Construct made,
//   circle crossings included) — or a crossing of two straight lines as shown (of one copy, or of
//   two different copies — the latter is a meeting of two constructions, so it can only ever be a
//   reference: no single construction carries it).
//
// A pick is never a coordinate. It is the geometry's identity — the copy and the line, the copy and
// the point, or the two lines that cross — and its position is worked out again from the copies as
// they are now, every time it's drawn or used. A pick that no longer exists (a copy removed, its
// Extensions switched off, two lines that no longer cross within what is shown) resolves to
// nothing, and is dropped rather than remembered at an old position.

import type { Doc, Entity, EntityId, PointId, Vec2 } from '../model/types.ts';
import { epsilon, findPoint, projectOntoEntity, resolveEntityGeom, resolvePoint } from './kernel.ts';
import { defaultSegmentKind, deriveSegments, paramInRange } from './segments.ts';
import { transformPoint } from './lattice.ts';
import type { IntersectionCopy } from './intersection.ts';

/** One straight line of one construction, in world space, as shown. */
export interface ShownLine {
  copyKey: string;
  entityId: EntityId;
  /** A point on it and its unit direction. */
  p: Vec2;
  u: Vec2;
  /** Its visible extent along u from p (world units) — null when shown as the whole line. */
  extent: [number, number] | null;
}

export type IntersectionPick = (
  | { kind: 'line'; copy: string; entity: EntityId }
  | { kind: 'point'; copy: string; point: PointId }
  /** Where two shown straight lines cross (ordered, so the same crossing is always the same pick). */
  | { kind: 'crossing'; a: { copy: string; entity: EntityId }; b: { copy: string; entity: EntityId } }
) & {
  /** Where the finger was, in the unplaced construction of the pick's first copy (so it moves with
   * it) — only to turn a picked line into the point there, or back; never a position used to Snap. */
  tap?: Vec2;
};

/** Which kind of geometry a tap picks — set by the Snap row's Line | Point | Edge switch. Edge picks
 * lines too, but for Match Edge: the moving edge first, then the target edge. */
export type PickKind = 'line' | 'point' | 'edge';

// ---- the construction's own lines and points, once per document ----

interface LocalLine {
  entityId: EntityId;
  a: Vec2;
  dir: Vec2;
  extended: boolean;
  /** Extents along dir from a (world units): the always-visible pieces, and Extension pieces. */
  solid: [number, number] | null;
  ext: [number, number] | null;
}
const lineCache = new WeakMap<Doc, LocalLine[]>();

function localLines(doc: Doc): LocalLine[] {
  let lines = lineCache.get(doc);
  if (lines) return lines;
  lines = [];
  const grow = (r: [number, number] | null, t0: number, t1: number): [number, number] => (r ? [Math.min(r[0], t0, t1), Math.max(r[1], t0, t1)] : [Math.min(t0, t1), Math.max(t0, t1)]);
  for (const entity of doc.entities) {
    if (entity.kind !== 'line') continue;
    const g = resolveEntityGeom(doc, entity);
    if (g.kind !== 'line') continue;
    const len = Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y);
    if (len < 1e-9) continue;
    let solid: [number, number] | null = null;
    let ext: [number, number] | null = null;
    const segs = deriveSegments(doc, entity);
    if (segs.length === 0) solid = [0, len];
    for (const seg of segs) {
      const kind = doc.segmentStates.get(seg.key)?.state ?? defaultSegmentKind(entity, seg);
      if (kind === 'trimmed') continue;
      if (kind === 'extension') ext = grow(ext, seg.fromParam * len, seg.toParam * len);
      else solid = grow(solid, seg.fromParam * len, seg.toParam * len);
    }
    lines.push({ entityId: entity.id, a: g.a, dir: g.dir, extended: !!entity.extended, solid, ext });
  }
  lineCache.set(doc, lines);
  return lines;
}

const pointCache = new WeakMap<Doc, { id: PointId; at: Vec2 }[]>();

/** The construction's own points (unplaced) — every point but the hidden internal ones. */
export function localPoints(doc: Doc): { id: PointId; at: Vec2 }[] {
  let pts = pointCache.get(doc);
  if (pts) return pts;
  pts = [];
  const cache = new Map<PointId, Vec2>();
  for (const p of doc.points) {
    if (p.kind === 'free' && p.hidden) continue;
    try {
      const at = resolvePoint(doc, p.id, cache);
      if (Number.isFinite(at.x) && Number.isFinite(at.y)) pts.push({ id: p.id, at });
    } catch {
      // a point that can't be resolved (degenerate construction) simply can't be picked
    }
  }
  pointCache.set(doc, pts);
  return pts;
}

/** Each entity's drawn pieces (param ranges), by kind — what a copy shows of it. */
interface DrawnEntity {
  entity: Entity;
  /** Construction / Fair pieces — always drawn; null range = the whole entity. */
  solid: [number, number][];
  /** Extension pieces — drawn only while a copy's Extensions are on. */
  ext: [number, number][];
  whole: boolean;
}
const drawnCache = new WeakMap<Doc, Map<EntityId, DrawnEntity>>();

function drawnEntities(doc: Doc): Map<EntityId, DrawnEntity> {
  let out = drawnCache.get(doc);
  if (out) return out;
  out = new Map();
  for (const entity of doc.entities) {
    const segs = deriveSegments(doc, entity);
    const d: DrawnEntity = { entity, solid: [], ext: [], whole: segs.length === 0 };
    for (const seg of segs) {
      const kind = doc.segmentStates.get(seg.key)?.state ?? defaultSegmentKind(entity, seg);
      if (kind === 'trimmed') continue;
      (kind === 'extension' ? d.ext : d.solid).push([seg.fromParam, seg.toParam]);
    }
    out.set(entity.id, d);
  }
  drawnCache.set(doc, out);
  return out;
}

/** Whether entity `id` is drawn anywhere (`at` undefined), or through `at`, by a copy. */
function drawnAt(doc: Doc, id: EntityId, extensions: boolean, at?: Vec2): boolean {
  const d = drawnEntities(doc).get(id);
  if (!d) return false;
  const wholeLine = extensions && d.entity.kind === 'line' && d.entity.extended;
  const ranges = extensions ? [...d.solid, ...d.ext] : d.solid;
  if (!at) return d.whole || wholeLine || ranges.length > 0;
  const pr = projectOntoEntity(doc, d.entity, at);
  if (pr.d > epsilon(doc)) return false;
  return d.whole || wholeLine || ranges.some(([from, to]) => paramInRange(pr.param, from, to, d.entity.kind === 'circle'));
}

/** Whether one of the construction's own points (at `at`, unplaced) reads as a point in what a
 * copy shows — a crossing of two drawn pieces, a drawn line's end or corner, an arc's end, or the
 * centre of a drawn circle. Not the many points that only mark a place on a line (divisions,
 * midpoints, points on a curve), and never anything on trimmed or hidden geometry. */
export function pointShown(doc: Doc, id: PointId, at: Vec2, extensions: boolean): boolean {
  const point = findPoint(doc, id);
  if (!point) return false;
  if (point.kind === 'centre') return drawnAt(doc, point.entity, extensions);
  if (point.kind === 'intersection') return drawnAt(doc, point.entities[0], extensions, at) && drawnAt(doc, point.entities[1], extensions, at);
  if (point.kind === 'on-curve' && point.arcEnd) return drawnAt(doc, point.host, extensions, at);
  return doc.entities.some((e) => e.kind === 'line' && (e.a === id || e.b === id) && drawnAt(doc, e.id, extensions, at));
}

function turn(v: Vec2, rotation: number): Vec2 {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** One line of one construction as shown, or null if nothing of it is shown. */
function shownLine(doc: Doc, copy: IntersectionCopy, l: LocalLine): ShownLine | null {
  let extent: [number, number] | null;
  if (copy.extensions && l.extended) extent = null;
  else {
    const parts = [l.solid, copy.extensions ? l.ext : null].filter((r): r is [number, number] => !!r);
    if (parts.length === 0) return null;
    extent = [Math.min(...parts.map((r) => r[0])), Math.max(...parts.map((r) => r[1]))];
  }
  return { copyKey: copy.key, entityId: l.entityId, p: transformPoint(doc.frame.origin, copy.pose, l.a), u: turn(l.dir, copy.pose.rotation), extent };
}

/** Every line of one construction that is shown, placed by its pose. */
export function shownLinesOf(doc: Doc, copy: IntersectionCopy): ShownLine[] {
  const out: ShownLine[] = [];
  for (const l of localLines(doc)) {
    const s = shownLine(doc, copy, l);
    if (s) out.push(s);
  }
  return out;
}

const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });

/** Where two shown lines cross within what is shown of both (a hair of tolerance at the ends, so a
 * crossing exactly at a segment's end counts) — or null. */
export function crossingOf(m: ShownLine, n: ShownLine, tolerance: number): Vec2 | null {
  const den = cross(m.u, n.u);
  if (Math.abs(den) < 1e-9) return null;
  const d = sub(n.p, m.p);
  const t = cross(d, n.u) / den;
  const s = cross(d, m.u) / den;
  if (m.extent && (t < m.extent[0] - tolerance || t > m.extent[1] + tolerance)) return null;
  if (n.extent && (s < n.extent[0] - tolerance || s > n.extent[1] + tolerance)) return null;
  return { x: m.p.x + m.u.x * t, y: m.p.y + m.u.y * t };
}

/** A tolerance (world units) for "within what is shown" — tiny: only rounding at a segment's end. */
const END_TOLERANCE = 1e-6;

// ---- resolving a pick against the copies as they are now ----

export type ResolvedPick = { kind: 'line'; line: ShownLine } | { kind: 'point'; at: Vec2; carrier: string | null };

function findLine(doc: Doc, copies: IntersectionCopy[], copyKey: string, entity: EntityId): ShownLine | null {
  const copy = copies.find((c) => c.key === copyKey);
  const l = copy && localLines(doc).find((x) => x.entityId === entity);
  return copy && l ? shownLine(doc, copy, l) : null;
}

/** A pick, worked out from the copies as shown now — or null if it no longer exists. A point's
 * `carrier` is the one construction it moves with (null for a crossing of two constructions). */
export function resolvePick(doc: Doc, copies: IntersectionCopy[], pick: IntersectionPick): ResolvedPick | null {
  if (pick.kind === 'line') {
    const line = findLine(doc, copies, pick.copy, pick.entity);
    return line ? { kind: 'line', line } : null;
  }
  if (pick.kind === 'point') {
    const copy = copies.find((c) => c.key === pick.copy);
    const local = copy && localPoints(doc).find((p) => p.id === pick.point);
    return copy && local && pointShown(doc, local.id, local.at, copy.extensions) ? { kind: 'point', at: transformPoint(doc.frame.origin, copy.pose, local.at), carrier: copy.key } : null;
  }
  const m = findLine(doc, copies, pick.a.copy, pick.a.entity);
  const n = findLine(doc, copies, pick.b.copy, pick.b.entity);
  const at = m && n ? crossingOf(m, n, END_TOLERANCE) : null;
  return at ? { kind: 'point', at, carrier: pick.a.copy === pick.b.copy ? pick.a.copy : null } : null;
}

/** The constructions a pick depends on. */
export function pickCopies(pick: IntersectionPick): string[] {
  return pick.kind === 'crossing' ? [...new Set([pick.a.copy, pick.b.copy])] : [pick.copy];
}

export function samePick(p: IntersectionPick, q: IntersectionPick): boolean {
  if (p.kind !== q.kind) return false;
  if (p.kind === 'line' && q.kind === 'line') return p.copy === q.copy && p.entity === q.entity;
  if (p.kind === 'point' && q.kind === 'point') return p.copy === q.copy && p.point === q.point;
  if (p.kind === 'crossing' && q.kind === 'crossing') return p.a.copy === q.a.copy && p.a.entity === q.a.entity && p.b.copy === q.b.copy && p.b.entity === q.b.entity;
  return false;
}

export const isPointPick = (p: IntersectionPick) => p.kind !== 'line';

/** The one construction a pick moves with — null for a crossing of two constructions. */
export function pickCarrier(pick: IntersectionPick): string | null {
  if (pick.kind !== 'crossing') return pick.copy;
  return pick.a.copy === pick.b.copy ? pick.a.copy : null;
}

/** Whether `pick` can be the moving pick against `reference`: the same kind (line or point), carried
 * by one construction, and that construction not one the reference depends on. */
export function canMoveAgainst(reference: IntersectionPick, pick: IntersectionPick): boolean {
  const carrier = pickCarrier(pick);
  return isPointPick(reference) === isPointPick(pick) && carrier !== null && !pickCopies(reference).includes(carrier);
}

/**
 * The picks after a tap on `pick`. Tapping the reference clears the selection; tapping the moving
 * pick un-picks it. Otherwise a pick that can move against the reference becomes (or replaces) the
 * moving pick; anything else starts afresh as the new reference.
 */
export function withPick(picks: IntersectionPick[], pick: IntersectionPick): IntersectionPick[] {
  const [reference, moving] = picks;
  if (!reference) return [pick];
  if (samePick(reference, pick)) return [];
  if (moving && samePick(moving, pick)) return [reference];
  return canMoveAgainst(reference, pick) ? [reference, pick] : [pick];
}

// ---- finding what is under a tap ----

/** The copy a pick's tap is kept relative to. */
const hostOf = (pick: IntersectionPick) => (pick.kind === 'crossing' ? pick.a.copy : pick.copy);

/** A world position placed in (or back out of) a copy's unplaced construction — the inverse pose. */
function toLocal(doc: Doc, copy: IntersectionCopy, w: Vec2): Vec2 {
  const pivot = doc.frame.origin;
  const r = turn({ x: w.x - pivot.x - copy.pose.translate.x, y: w.y - pivot.y - copy.pose.translate.y }, -copy.pose.rotation);
  return { x: r.x + pivot.x, y: r.y + pivot.y };
}

/** The pick with where the finger was, kept relative to its own construction. */
export function withTap(doc: Doc, copies: IntersectionCopy[], pick: IntersectionPick, w: Vec2): IntersectionPick {
  const host = copies.find((c) => c.key === hostOf(pick));
  return host ? { ...pick, tap: toLocal(doc, host, w) } : pick;
}

function tapOf(doc: Doc, copies: IntersectionCopy[], pick: IntersectionPick): Vec2 | null {
  const host = copies.find((c) => c.key === hostOf(pick));
  return host && pick.tap ? transformPoint(doc.frame.origin, host.pose, pick.tap) : null;
}

interface Candidate {
  pick: IntersectionPick;
  at: Vec2;
}

const lineId = (l: ShownLine) => ({ copy: l.copyKey, entity: l.entityId });
const ordered = (m: ShownLine, n: ShownLine) => [lineId(m), lineId(n)].sort((x, y) => (`${x.copy}/${x.entity}` < `${y.copy}/${y.entity}` ? -1 : 1)) as [{ copy: string; entity: EntityId }, { copy: string; entity: EntityId }];

/** Distance from `w` to a shown line (within what is shown of it). */
function distToLine(l: ShownLine, w: Vec2): number {
  const rel = sub(w, l.p);
  const along = dot(rel, l.u);
  const t = l.extent ? Math.min(l.extent[1], Math.max(l.extent[0], along)) : along;
  return Math.hypot(rel.x - l.u.x * t, rel.y - l.u.y * t);
}

/** The points within `reach` of `w`: each copy's own shown points, and the crossings of shown
 * straight lines near it. `onLine` limits them to points on that one line. */
function pointsNear(doc: Doc, copies: IntersectionCopy[], w: Vec2, reach: number, onLine?: ShownLine): Candidate[] {
  const pivot = doc.frame.origin;
  const out: Candidate[] = [];
  const lines = copies.flatMap((c) => shownLinesOf(doc, c));
  const eps = epsilon(doc);
  for (const c of copies) {
    if (onLine && c.key !== onLine.copyKey) continue;
    for (const p of localPoints(doc)) {
      const at = transformPoint(pivot, c.pose, p.at);
      if (Math.hypot(at.x - w.x, at.y - w.y) > reach) continue;
      if (onLine && distToLine(onLine, at) > eps) continue;
      if (pointShown(doc, p.id, p.at, c.extensions)) out.push({ pick: { kind: 'point', copy: c.key, point: p.id }, at });
    }
  }
  const near = lines.filter((l) => distToLine(l, w) <= reach);
  const firsts = onLine ? lines.filter((l) => l.copyKey === onLine.copyKey && l.entityId === onLine.entityId) : near;
  for (const m of firsts) {
    for (const n of near) {
      if (n === m || (!onLine && near.indexOf(n) <= near.indexOf(m))) continue;
      const at = crossingOf(m, n, END_TOLERANCE);
      if (!at || Math.hypot(at.x - w.x, at.y - w.y) > reach) continue;
      const [a, b] = ordered(m, n);
      out.push({ pick: { kind: 'crossing', a, b }, at });
    }
  }
  return out;
}

const nearest = (cs: Candidate[], w: Vec2) => cs.reduce<Candidate | null>((best, c) => (!best || Math.hypot(c.at.x - w.x, c.at.y - w.y) < Math.hypot(best.at.x - w.x, best.at.y - w.y) - 1e-9 ? c : best), null);

/**
 * What a tap at world position `w` picks, of `kind` (within `reach` world units): the nearest line
 * — or, if no line is that near, the nearest point — or for points, the nearest point. Among them,
 * those `accept` allows come first (so a second pick is the one that can move, wherever two
 * constructions overlap); only if there are none is anything else picked.
 */
export function pickAtTap(doc: Doc, copies: IntersectionCopy[], w: Vec2, reach: number, kind: PickKind, accept: (p: IntersectionPick) => boolean = () => true): IntersectionPick | null {
  const lines: Candidate[] = [];
  for (const c of copies) {
    for (const l of shownLinesOf(doc, c)) {
      const d = distToLine(l, w);
      if (d <= reach) {
        const rel = sub(w, l.p);
        const along = dot(rel, l.u);
        const t = l.extent ? Math.min(l.extent[1], Math.max(l.extent[0], along)) : along;
        lines.push({ pick: { kind: 'line', copy: l.copyKey, entity: l.entityId }, at: { x: l.p.x + l.u.x * t, y: l.p.y + l.u.y * t } });
      }
    }
  }
  const points = pointsNear(doc, copies, w, reach);
  const order = kind === 'line' ? [lines, points] : kind === 'edge' ? [lines] : [points];
  for (const only of [true, false]) {
    for (const set of order) {
      const c = nearest(only ? set.filter((x) => accept(x.pick)) : set, w);
      if (c) return withTap(doc, copies, c.pick, w);
    }
  }
  return null;
}

/**
 * A pick turned into the other kind, at the place it was tapped: a line into the point on that line
 * nearest the tap (its own points on it, or where another line crosses it); a point into the line
 * through it nearest the tap. Null if there is none (within `reach` of the tap, for a point).
 */
export function convertPick(doc: Doc, copies: IntersectionCopy[], pick: IntersectionPick, kind: PickKind, reach: number, accept: (p: IntersectionPick) => boolean = () => true): IntersectionPick | null {
  if ((kind === 'point') === isPointPick(pick)) return pick;
  const r = resolvePick(doc, copies, pick);
  if (!r) return null;
  const w = tapOf(doc, copies, pick) ?? (r.kind === 'point' ? r.at : r.line.p);
  if (r.kind === 'line') {
    const c = nearest(pointsNear(doc, copies, w, reach, r.line).filter((x) => accept(x.pick)), w);
    return c ? withTap(doc, copies, c.pick, w) : null;
  }
  // A point: the lines through it — its own copy's (for one of its points), or the two that cross.
  const eps = epsilon(doc);
  const through =
    pick.kind === 'crossing'
      ? [pick.a, pick.b].map((x) => findLine(doc, copies, x.copy, x.entity)).filter((l): l is ShownLine => !!l)
      : pick.kind === 'point'
        ? shownLinesOf(doc, copies.find((c) => c.key === pick.copy)!).filter((l) => distToLine(l, r.at) <= eps)
        : [];
  const cs = through.map((l) => ({ pick: { kind: 'line', copy: l.copyKey, entity: l.entityId } as IntersectionPick, d: distToLine(l, w) })).filter((x) => accept(x.pick));
  cs.sort((x, y) => x.d - y.d);
  return cs[0] ? withTap(doc, copies, cs[0].pick, w) : null;
}

// ---- the operations ----

/** Directions this close (radians) count as parallel — numerical equality, not a visual tolerance. */
const PARALLEL_EPS = 1e-7;
/** Distances this small (world units) count as already joined / already snapped. */
const COINCIDENT_EPS = 1e-6;

/** The smallest signed turn that makes direction `m` parallel to direction `r` (either sense). */
export function parallelTurn(r: Vec2, m: Vec2): number {
  let delta = Math.atan2(cross(m, r), dot(m, r)); // m → r, in (−π, π]
  if (delta > Math.PI / 2) delta -= Math.PI;
  else if (delta <= -Math.PI / 2) delta += Math.PI;
  return delta;
}

export function areParallel(r: ShownLine, m: ShownLine): boolean {
  return Math.abs(parallelTurn(r.u, m.u)) < PARALLEL_EPS;
}

/** The straight move across the lines that puts parallel line m on line r. */
export function joinShift(r: ShownLine, m: ShownLine): Vec2 {
  const n = { x: -r.u.y, y: r.u.x };
  const d = dot(sub(m.p, r.p), n);
  return { x: -n.x * d, y: -n.y * d };
}

export type SnapPlan =
  | { kind: 'none'; note: string }
  | {
      kind: 'lines';
      moving: string;
      /** The turn Parallel would make (0 when already parallel). */
      turn: number;
      /** The move Join would make — only when already parallel (null otherwise). */
      shift: Vec2 | null;
      parallel: boolean;
      joined: boolean;
    }
  | { kind: 'points'; moving: string; shift: Vec2; snapped: boolean };

/**
 * What the two picks allow, worked out from the copies as shown now. The first pick is the
 * reference; the second's construction is the one that would move.
 */
export function planSnap(doc: Doc, copies: IntersectionCopy[], reference: IntersectionPick, moving: IntersectionPick): SnapPlan {
  const r = resolvePick(doc, copies, reference);
  const m = resolvePick(doc, copies, moving);
  if (!r || !m) return { kind: 'none', note: 'That selection no longer exists' };
  if (r.kind === 'line' && m.kind === 'line') {
    if (r.line.copyKey === m.line.copyKey) return { kind: 'none', note: 'Pick the second line on another construction' };
    const parallel = areParallel(r.line, m.line);
    const shift = parallel ? joinShift(r.line, m.line) : null;
    return { kind: 'lines', moving: m.line.copyKey, turn: parallel ? 0 : parallelTurn(r.line.u, m.line.u), shift, parallel, joined: !!shift && Math.hypot(shift.x, shift.y) < COINCIDENT_EPS };
  }
  if (r.kind === 'point' && m.kind === 'point') {
    if (!m.carrier) return { kind: 'none', note: 'A crossing of two constructions can only be the reference' };
    if (pickCopies(reference).includes(m.carrier)) return { kind: 'none', note: 'Pick the second point on another construction' };
    const shift = sub(r.at, m.at);
    return { kind: 'points', moving: m.carrier, shift, snapped: Math.hypot(shift.x, shift.y) < COINCIDENT_EPS };
  }
  return { kind: 'none', note: 'Pick two lines, or two points' };
}

// ---- Match Edge: one exact rigid move that makes two edges coincide ----

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** The edge a line pick means, unplaced (in the construction's own coordinates): the piece of its
 * line between the two points either side of where it was tapped — or, with no tap there, the
 * line's own span. Worked out from the geometry itself, never from the screen. */
export function pickedEdge(doc: Doc, pick: IntersectionPick): { a: Vec2; b: Vec2 } | null {
  if (pick.kind !== 'line') return null;
  const entity = doc.entities.find((e) => e.id === pick.entity);
  if (!entity || entity.kind !== 'line') return null;
  const g = resolveEntityGeom(doc, entity);
  if (g.kind !== 'line') return null;
  if (pick.tap) {
    const at = projectOntoEntity(doc, entity, pick.tap).param;
    const seg = deriveSegments(doc, entity).find((s) => at >= s.fromParam - 1e-9 && at <= s.toParam + 1e-9 && doc.segmentStates.get(s.key)?.state !== 'trimmed');
    if (seg) return { a: resolvePoint(doc, seg.from), b: resolvePoint(doc, seg.to) };
  }
  return { a: g.a, b: g.b };
}

export type EdgePlan =
  | { kind: 'none'; note: string }
  | {
      kind: 'edge';
      moving: string;
      target: string;
      /** The moving construction's pose after Match Edge: its rotation and (shown) translation. */
      rotation: number;
      translate: Vec2;
      /** How far that turns and slides it from where it is. */
      turn: number;
      shift: Vec2;
      /** Already coincident. */
      matched: boolean;
      /** The two edges as shown now (world): moving, then target. */
      edges: [[Vec2, Vec2], [Vec2, Vec2]];
    };

/** The picks after a tap, for Match Edge: the moving edge first, then a target edge on another
 * construction. Tapping the moving edge again clears both; tapping the target again un-picks it;
 * another edge of the moving construction becomes the moving edge instead. */
export function withEdgePick(picks: IntersectionPick[], pick: IntersectionPick): IntersectionPick[] {
  const [moving, target] = picks;
  if (!moving) return [pick];
  if (samePick(moving, pick)) return [];
  if (target && samePick(target, pick)) return [moving];
  return pick.kind === 'line' && moving.kind === 'line' && pick.copy !== moving.copy ? [moving, pick] : [pick];
}

/**
 * Match Edge, worked out exactly from the master geometry and the instances' poses: the rotation and
 * translation that put the moving edge onto the target edge. The turn is the smaller of the two that
 * make the edges run the same way (either end to either end); then the edges' middles are made to
 * meet — so equal edges coincide end point for end point.
 */
export function planMatchEdge(doc: Doc, copies: IntersectionCopy[], moving: IntersectionPick, target: IntersectionPick): EdgePlan {
  if (moving.kind !== 'line' || target.kind !== 'line') return { kind: 'none', note: 'Pick two edges' };
  if (moving.copy === target.copy) return { kind: 'none', note: 'Pick the target edge on another construction' };
  const mc = copies.find((c) => c.key === moving.copy);
  const tc = copies.find((c) => c.key === target.copy);
  const me = pickedEdge(doc, moving);
  const te = pickedEdge(doc, target);
  if (!mc || !tc || !me || !te || !resolvePick(doc, copies, moving) || !resolvePick(doc, copies, target)) return { kind: 'none', note: 'That selection no longer exists' };
  const pivot = doc.frame.origin;
  const w1 = transformPoint(pivot, mc.pose, me.a);
  const w2 = transformPoint(pivot, mc.pose, me.b);
  const v1 = transformPoint(pivot, tc.pose, te.a);
  const v2 = transformPoint(pivot, tc.pose, te.b);
  const dw = sub(w2, w1);
  const dv = sub(v2, v1);
  if (Math.hypot(dw.x, dw.y) < COINCIDENT_EPS || Math.hypot(dv.x, dv.y) < COINCIDENT_EPS) return { kind: 'none', note: 'That edge has no length' };
  const same = wrapAngle(Math.atan2(dv.y, dv.x) - Math.atan2(dw.y, dw.x)); // its a end onto the target's a end
  const flipped = wrapAngle(same + Math.PI); // …or onto the target's b end
  const turnBy = Math.abs(flipped) < Math.abs(same) ? flipped : same;
  const rotation = wrapAngle(mc.pose.rotation + turnBy);
  const mid = { x: (me.a.x + me.b.x) / 2, y: (me.a.y + me.b.y) / 2 };
  const goal = { x: (v1.x + v2.x) / 2, y: (v1.y + v2.y) / 2 };
  const r = turn(sub(mid, pivot), rotation);
  const translate = { x: goal.x - pivot.x - r.x, y: goal.y - pivot.y - r.y };
  const shift = sub(translate, mc.pose.translate);
  return {
    kind: 'edge',
    moving: mc.key,
    target: tc.key,
    rotation,
    translate,
    turn: turnBy,
    shift,
    matched: Math.abs(turnBy) < PARALLEL_EPS && Math.hypot(shift.x, shift.y) < COINCIDENT_EPS,
    edges: [
      [w1, w2],
      [v1, v2],
    ],
  };
}
