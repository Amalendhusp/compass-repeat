// Lightweight segment derivation for Select (§3's full split-and-DCEL model is still deferred
// to the Divide/Fair/Fill pass — this covers just enough to let Select distinguish "a piece of
// this curve" from "the whole entity", per Phase 1.2 item 3).

import type { Doc, Entity, EntityId, PointId, Vec2 } from '../model/types.ts';
import { epsilon, projectOntoEntity, resolvePoint } from './kernel.ts';

export interface DerivedSegment {
  key: string; // `${entityId}:${fromId}:${toId}`
  entityId: EntityId;
  from: PointId;
  to: PointId;
  fromParam: number;
  toParam: number;
}

function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let x = a % twoPi;
  if (x < 0) x += twoPi;
  return x;
}

export function segmentKey(entityId: EntityId, from: PointId, to: PointId): string {
  return `${entityId}:${from}:${to}`;
}

/** True if `param` falls within [fromParam, toParam] — handling a circle's wraparound past 2π.
 * Used both to find the segment under a tap (hittest.ts) and to migrate segment state onto the
 * right child when a split occurs (§Phase 2 item 2B). */
export function paramInRange(param: number, fromParam: number, toParam: number, isCircle: boolean): boolean {
  const eps = 1e-6;
  if (!isCircle) return param >= fromParam - eps && param <= toParam + eps;
  const p = normalizeAngle(param);
  if (fromParam <= toParam) return p >= fromParam - eps && p <= toParam + eps;
  return p >= fromParam - eps || p <= toParam + eps; // wraps past 2π
}

/**
 * Phase 2.4: true if `pointId` (at world position `at`) is geometrically or definitionally
 * significant beyond just being `hostEntityId`'s own through-point — reused as another circle's
 * centre/through, a line's endpoint, referenced by a midpoint/division, OR simply because some
 * OTHER entity's curve also happens to pass through this exact location (the point-merge case:
 * a new intersection that lands on an existing through-point canonicalizes onto it via
 * mergeOrCreatePoint, keeping the through-point's original `kind` — so provenance/kind can't be
 * the test here, only "does anything else genuinely meet here"). A circle's through-point is a
 * pure internal radius handle only when NONE of this applies; the moment it's doing other active
 * work, by any of these routes, it's exactly as real a split point as an intersection.
 */
function isPointActiveBeyondThroughRole(doc: Doc, hostEntityId: EntityId, pointId: PointId, at: Vec2, eps: number): boolean {
  for (const e of doc.entities) {
    if (e.id === hostEntityId) continue;
    if (e.kind === 'circle' && (e.centre === pointId || e.through === pointId)) return true;
    if (e.kind === 'line' && (e.a === pointId || e.b === pointId)) return true;
    // Geometric coincidence: some other entity's curve genuinely meets this location, regardless
    // of whether that crossing ended up canonicalized onto this point or a distinct one.
    const proj = projectOntoEntity(doc, e, at);
    if (proj.d > eps) continue;
    if (e.kind === 'line' && !e.extended && (proj.param < -eps || proj.param > 1 + eps)) continue;
    return true;
  }
  for (const p of doc.points) {
    if (p.kind === 'midpoint' && (p.a === pointId || p.b === pointId)) return true;
    if (p.kind === 'division' && p.span && (p.span[0] === pointId || p.span[1] === pointId)) return true;
  }
  return false;
}

/** Points that lie on `entity`, sorted by parameter — excludes a circle's own through point
 * only while it's purely an internal radius handle (spec §3: it never splits its own circle on
 * its own), and excludes hidden housekeeping points. */
function pointsOnEntity(doc: Doc, entity: Entity): { id: PointId; param: number }[] {
  const eps = epsilon(doc);
  const found: { id: PointId; param: number }[] = [];
  const seen = new Set<PointId>();
  for (const p of doc.points) {
    if (
      entity.kind === 'circle' &&
      p.id === entity.through &&
      !isPointActiveBeyondThroughRole(doc, entity.id, p.id, resolvePoint(doc, p.id), eps)
    ) {
      continue;
    }
    if (p.kind === 'free' && p.hidden) continue;
    if (seen.has(p.id)) continue;
    const at = resolvePoint(doc, p.id);
    const proj = projectOntoEntity(doc, entity, at);
    if (proj.d > eps) continue;
    if (entity.kind === 'line' && !entity.extended && (proj.param < -eps || proj.param > 1 + eps)) continue;
    seen.add(p.id);
    found.push({ id: p.id, param: entity.kind === 'circle' ? normalizeAngle(proj.param) : proj.param });
  }
  found.sort((a, b) => a.param - b.param);
  return found;
}

function computeDerivedSegments(doc: Doc, entity: Entity): DerivedSegment[] {
  const pts = pointsOnEntity(doc, entity);
  if (pts.length < 2) return [];
  const segs: DerivedSegment[] = [];
  const count = entity.kind === 'circle' ? pts.length : pts.length - 1;
  for (let i = 0; i < count; i++) {
    const from = pts[i]!;
    const to = pts[(i + 1) % pts.length]!;
    segs.push({ key: `${entity.id}:${from.id}:${to.id}`, entityId: entity.id, from: from.id, to: to.id, fromParam: from.param, toParam: to.param });
  }
  return segs;
}

// Phase 3.1 item 7: `pointsOnEntity` is O(points on doc) per entity (each point is projected
// onto the curve to test membership), so deriving every entity's segments once is already
// O(entities × points) — and the renderer, the node inset and Fair's junction scoring each used
// to call this per entity independently, multiplying that cost several times over within a
// single render or a single pointer-move.
//
// Unlike the kernel's resolvePoint cache, this can't be keyed on Doc identity alone: a Doc
// object is only ever *observed* as immutable from outside commit(), but DURING a commit's
// mutate callback the same object is built up incrementally (addEntity/mergeOrCreatePoint push
// points and entities one at a time as intersections are materialized) — deriving an entity's
// segments early in that process and reusing the result after a later point has landed on the
// same curve would silently serve a stale split. Guarding on points/entities length catches
// every such growth (or Trim/Delete's shrink) and invalidates the whole per-doc cache, while
// still reusing freely across every render frame and pointer-move once a Doc has settled as
// `controller.doc` between commits — which is the case this was actually written to help.
const perDocSegmentCache = new WeakMap<Doc, { pointCount: number; entityCount: number; byEntity: Map<EntityId, DerivedSegment[]> }>();

/** The segments `entity` is currently split into. Empty for an as-yet-untouched circle
 * (spec §4.5: "if the circle has none"); a line always has at least one (its own endpoints). */
export function deriveSegments(doc: Doc, entity: Entity): DerivedSegment[] {
  let record = perDocSegmentCache.get(doc);
  if (!record || record.pointCount !== doc.points.length || record.entityCount !== doc.entities.length) {
    record = { pointCount: doc.points.length, entityCount: doc.entities.length, byEntity: new Map() };
    perDocSegmentCache.set(doc, record);
  }
  const cached = record.byEntity.get(entity.id);
  if (cached) return cached;
  const segs = computeDerivedSegments(doc, entity);
  record.byEntity.set(entity.id, segs);
  return segs;
}

/**
 * Phase 2.1 item 4: true Trim — a param genuinely inside a trimmed segment reads as trimmed
 * regardless of what's asking (rendering, hit-testing, or a new entity's intersection
 * materialization), so "removed from the active arrangement" is one fact, not several places
 * that have to agree. False for a param not yet covered by any derived segment (nothing to
 * trim there).
 */
export function isParamTrimmed(doc: Doc, entity: Entity, param: number): boolean {
  const segs = deriveSegments(doc, entity);
  const isCircle = entity.kind === 'circle';
  for (const s of segs) {
    if (paramInRange(param, s.fromParam, s.toParam, isCircle)) {
      return (doc.segmentStates.get(s.key)?.state ?? 'construction') === 'trimmed';
    }
  }
  return false;
}

/**
 * Phase 3.6 item 4: a run of one or more consecutive granular segments that currently act as ONE
 * selectable/Fair-able unit — geometry and segment STATE storage both stay exactly as granular
 * as ever (this never changes `doc.segmentStates`' keys, only how taps/Fair group them). Primary
 * point kinds (intersection/centre/frame-vertex, plus hand-placed free/on-curve points) always
 * split a group; Derived kinds (midpoint/division) only split one while `doc.pointTargets.derived`
 * is on — off, they're invisible to grouping (still real, still recoverable) without needing new
 * points, migrated state, or any other change to the underlying model. A trimmed granular segment
 * is always its own boundary (and excluded) — grouping across a genuinely removed span isn't "one
 * piece of curve" by any reading.
 */
export interface SelectableGroup {
  entityId: EntityId;
  segments: DerivedSegment[]; // 1+, in curve order
  from: PointId;
  to: PointId;
  fromParam: number;
  toParam: number;
}

function isTopologySplitPoint(doc: Doc, pointId: PointId): boolean {
  const p = doc.points.find((pt) => pt.id === pointId);
  if (!p) return true; // safe default — unknown point, don't silently merge across it
  if (p.kind === 'midpoint' || p.kind === 'division') return doc.pointTargets.derived;
  return true; // Primary kinds, plus free/on-curve (outside the Primary/Derived/Free scheme — Phase 3.4)
}

function computeSelectableGroups(doc: Doc, entity: Entity): SelectableGroup[] {
  const segs = deriveSegments(doc, entity);
  if (segs.length === 0) return [];
  const isCircle = entity.kind === 'circle';

  // Rotate the (already-cyclic-ordered, for a circle) segment list to start right after a real
  // split boundary, so the single forward walk below never needs separate wraparound handling —
  // a line needs no rotation (nothing before its own first segment to consider).
  let startIdx = 0;
  if (isCircle) {
    const found = segs.findIndex((s) => isTopologySplitPoint(doc, s.from));
    if (found > 0) startIdx = found;
  }
  const ordered = startIdx === 0 ? segs : [...segs.slice(startIdx), ...segs.slice(0, startIdx)];

  const groups: DerivedSegment[][] = [];
  let current: DerivedSegment[] = [];
  for (const seg of ordered) {
    const state = doc.segmentStates.get(seg.key)?.state ?? 'construction';
    if (state === 'trimmed') {
      if (current.length > 0) groups.push(current);
      current = [];
      continue;
    }
    if (current.length > 0 && !isTopologySplitPoint(doc, seg.from)) {
      current.push(seg);
    } else {
      if (current.length > 0) groups.push(current);
      current = [seg];
    }
  }
  if (current.length > 0) groups.push(current);

  return groups.map((groupSegs) => ({
    entityId: entity.id,
    segments: groupSegs,
    from: groupSegs[0]!.from,
    to: groupSegs[groupSegs.length - 1]!.to,
    fromParam: groupSegs[0]!.fromParam,
    toParam: groupSegs[groupSegs.length - 1]!.toParam,
  }));
}

// Same invalidation strategy as deriveSegments' own cache (Phase 3.1 item 7), plus `derived`:
// toggling doc.pointTargets.derived changes grouping without changing the Doc reference or its
// points/entities counts at all (it's a plain preference mutation, not a commit), so it has to be
// part of the cache key too — this is the literal mechanism behind item 4's "recompute derived
// selectable segments when the target-category settings change."
const perDocGroupCache = new WeakMap<Doc, { pointCount: number; entityCount: number; derived: boolean; byEntity: Map<EntityId, SelectableGroup[]> }>();

export function deriveSelectableGroups(doc: Doc, entity: Entity): SelectableGroup[] {
  const derived = doc.pointTargets.derived;
  let record = perDocGroupCache.get(doc);
  if (!record || record.pointCount !== doc.points.length || record.entityCount !== doc.entities.length || record.derived !== derived) {
    record = { pointCount: doc.points.length, entityCount: doc.entities.length, derived, byEntity: new Map() };
    perDocGroupCache.set(doc, record);
  }
  const cached = record.byEntity.get(entity.id);
  if (cached) return cached;
  const groups = computeSelectableGroups(doc, entity);
  record.byEntity.set(entity.id, groups);
  return groups;
}

/** The group whose span exactly matches `(from, to)` — how a SelectCandidate/DivideTarget's own
 * boundary points are turned back into the full group (and its constituent segment keys) at
 * action time, without needing to carry the whole group through serialization-adjacent state. */
export function findSelectableGroup(doc: Doc, entity: Entity, from: PointId, to: PointId): SelectableGroup | undefined {
  return deriveSelectableGroups(doc, entity).find((g) => g.from === from && g.to === to);
}

/** The group containing `param` on `entity`'s curve — groups.ts's answer to
 * segmentContainingParam, for hit-testing against the coarser (possibly-merged) topology. */
export function groupContainingParam(groups: SelectableGroup[], param: number, isCircle: boolean): SelectableGroup | undefined {
  return groups.find((g) => paramInRange(param, g.fromParam, g.toParam, isCircle));
}
