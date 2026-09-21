// Targeting per spec §5.1–5.3: explicit points first (22pt), then implicit
// on-curve projections (16pt), each group ordered by distance. Precision-mode
// disambiguation (§5.4) is deferred; ties currently resolve to the closest.

import type { Doc, Entity, EntityId, Point, PointId, SegmentKey, Vec2 } from '../model/types.ts';
import { projectOntoEntity, resolveEntityGeom, resolvePoint } from '../geometry/kernel.ts';
import { deriveSelectableGroups, groupContainingParam, isParamTrimmed, type DerivedSegment, type SelectableGroup } from '../geometry/segments.ts';
import { computeFairRegions, findRegionAt } from '../geometry/regions.ts';
import { isEditablePointKind, isPointOrphanedByTrim } from '../geometry/usage.ts';
import { dist, sub } from '../geometry/vec.ts';
import { type SelectCandidate, type SelectFilter, type ViewTransform, worldToScreen } from '../app/controller.ts';

export const POINT_HIT_RADIUS = 22;
const CURVE_HIT_RADIUS = 16;

export interface PointHit {
  /** Existing point id, or null for an implicit on-curve projection not yet materialized. */
  id: PointId | null;
  at: Vec2;
  screenD: number;
  implicit?: { host: EntityId; param: number };
}

/**
 * Phase 2.1 item 4 (true Trim): a param that falls inside a trimmed segment reads back as
 * infinitely far away — the one place this is enforced, so every caller (point/curve targeting,
 * Select's candidate list, Point Lock's "touched a curve" check) treats a trimmed span as
 * genuinely absent rather than merely invisible.
 */
function curveProjection(doc: Doc, entity: Entity, worldPos: Vec2): { point: Vec2; param: number; d: number } {
  const g = resolveEntityGeom(doc, entity);
  let result: { point: Vec2; param: number; d: number };
  if (g.kind === 'line' && entity.kind === 'line') {
    const ab = sub(g.b, g.a);
    const abLen2 = ab.x * ab.x + ab.y * ab.y;
    let t = abLen2 < 1e-12 ? 0 : ((worldPos.x - g.a.x) * ab.x + (worldPos.y - g.a.y) * ab.y) / abLen2;
    if (!entity.extended) t = Math.min(1, Math.max(0, t));
    const point = { x: g.a.x + ab.x * t, y: g.a.y + ab.y * t };
    result = { point, param: t, d: dist(point, worldPos) };
  } else {
    result = projectOntoEntity(doc, entity, worldPos);
  }
  if (isParamTrimmed(doc, entity, result.param)) return { ...result, d: Infinity };
  return result;
}

/**
 * Phase 3.4 items 5–7: the three Point Target categories, and which point kinds fall into each.
 * `free`-kind (hand-placed) points sit outside this scheme entirely — they're not a "geometric"
 * category the way intersections/midpoints are, so they stay unconditionally eligible, same as
 * before Point Targets existed. `on-curve` points (existing ones already materialized by a prior
 * Free-on-curve action, not just future ones) are governed by `free` too, since that toggle's name
 * — "Free on curve" — is about the point KIND, not only the act of creating a new one.
 */
function pointTargetRank(kind: Point['kind']): 0 | 1 | 2 {
  switch (kind) {
    case 'intersection':
    case 'centre':
    case 'frame-vertex':
    case 'free':
      return 0; // Primary (plus hand-placed points, always eligible, ranked alongside it)
    case 'midpoint':
    case 'division':
      return 1; // Derived
    case 'on-curve':
      return 2; // Free on curve
  }
}

function isPointTargetEligible(targets: Doc['pointTargets'], kind: Point['kind']): boolean {
  switch (kind) {
    case 'intersection':
    case 'centre':
    case 'frame-vertex':
      return targets.primary;
    case 'midpoint':
    case 'division':
      return targets.derived;
    case 'on-curve':
      return targets.free;
    case 'free':
      return true;
  }
}

/**
 * Finds the best point target for a point-taking tool (Circle/Line/Polygon). Explicit points
 * always outrank implicit curve projections (§5.3). Phase 3.4 items 5–7 replace the old binary
 * Point Lock: only point kinds whose category is enabled in `doc.pointTargets` compete at all
 * (a disabled category is never silently chosen, no matter how close), ranked Primary > Derived >
 * Free-on-curve first and by distance within a tier second; an implicit new on-curve projection
 * is offered only when nothing eligible already exists there AND Free-on-curve is enabled.
 */
export function pickPointTarget(
  doc: Doc,
  view: ViewTransform,
  screenPos: Vec2,
  opts: { explicitOnly?: boolean } = {},
): PointHit | null {
  let best: PointHit | null = null;
  let bestRank = Infinity;
  for (const p of doc.points) {
    if (p.kind === 'free' && p.hidden) continue;
    if (isPointOrphanedByTrim(doc, p.id)) continue;
    if (!isPointTargetEligible(doc.pointTargets, p.kind)) continue;
    const at = resolvePoint(doc, p.id);
    const d = dist(worldToScreen(view, at), screenPos);
    if (d > POINT_HIT_RADIUS) continue;
    const rank = pointTargetRank(p.kind);
    if (rank < bestRank || (rank === bestRank && d < (best?.screenD ?? Infinity))) {
      best = { id: p.id, at, screenD: d };
      bestRank = rank;
    }
  }
  if (best || opts.explicitOnly || !doc.pointTargets.free) return best;

  let bestImplicit: PointHit | null = null;
  const worldPos = { x: (screenPos.x - view.w / 2) / view.zoom - view.pan.x, y: (screenPos.y - view.h / 2) / view.zoom - view.pan.y };
  for (const e of doc.entities) {
    const proj = curveProjection(doc, e, worldPos);
    const screenD = proj.d * view.zoom;
    if (screenD <= CURVE_HIT_RADIUS && (!bestImplicit || screenD < bestImplicit.screenD)) {
      bestImplicit = { id: null, at: proj.point, screenD, implicit: { host: e.id, param: proj.param } };
    }
  }
  return bestImplicit;
}

/**
 * True if any visible curve passes within the curve hit-band of `screenPos`, regardless of
 * Point Lock. Used to tell "touched a locked-out curve" (no point at all, §Phase 1.2a) apart
 * from "touched genuinely empty space" (Circle's free-radius drop still applies there).
 */
export function isNearAnyCurve(doc: Doc, view: ViewTransform, screenPos: Vec2): boolean {
  const worldPos = { x: (screenPos.x - view.w / 2) / view.zoom - view.pan.x, y: (screenPos.y - view.h / 2) / view.zoom - view.pan.y };
  for (const e of doc.entities) {
    const proj = curveProjection(doc, e, worldPos);
    if (proj.d * view.zoom <= CURVE_HIT_RADIUS) return true;
  }
  return false;
}

/** Screen-space bounding box of an entity, for marquee containment (item 4). Extended lines
 * have no finite bounds and are excluded from marquee selection. */
export function entityScreenBounds(doc: Doc, view: ViewTransform, entity: Entity): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const g = resolveEntityGeom(doc, entity);
  if (g.kind === 'line') {
    if (entity.kind === 'line' && entity.extended) return null;
    const a = worldToScreen(view, g.a);
    const b = worldToScreen(view, g.b);
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  }
  const c = worldToScreen(view, g.centre);
  const r = g.radius * view.zoom;
  return { minX: c.x - r, minY: c.y - r, maxX: c.x + r, maxY: c.y + r };
}

function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let x = a % twoPi;
  if (x < 0) x += twoPi;
  return x;
}

/** The single granular DerivedSegment actually under `param` — Fair's own tap/trace mechanics
 * (Phase 3.6 item 4) need this raw, ungrouped piece for direction-detection and junction-walking
 * even though tap-targeting elsewhere now resolves to the coarser SelectableGroup. */
export function segmentContainingParam(segs: DerivedSegment[], param: number, isCircle: boolean): DerivedSegment | undefined {
  if (!isCircle) return segs.find((s) => param >= s.fromParam - 1e-6 && param <= s.toParam + 1e-6);
  const p = normalizeAngle(param);
  return segs.find((s) => {
    if (s.fromParam <= s.toParam) return p >= s.fromParam - 1e-6 && p <= s.toParam + 1e-6;
    return p >= s.fromParam - 1e-6 || p <= s.toParam + 1e-6; // wraps past 2π
  });
}

/** The nearest entity+param under `screenPos`, within the curve hit band — the same curve-ranking
 * `pickSelectCandidates` uses for its segment/entity tiers, exposed standalone for tools (Fair)
 * that need the raw hit before deciding how to interpret it. */
export function pickCurveHit(doc: Doc, view: ViewTransform, screenPos: Vec2): { entity: Entity; param: number } | null {
  const worldPos = { x: (screenPos.x - view.w / 2) / view.zoom - view.pan.x, y: (screenPos.y - view.h / 2) / view.zoom - view.pan.y };
  let best: { entity: Entity; param: number; d: number } | null = null;
  for (const e of doc.entities) {
    const proj = curveProjection(doc, e, worldPos);
    const d = proj.d * view.zoom;
    if (d <= CURVE_HIT_RADIUS && (!best || d < best.d)) best = { entity: e, param: proj.param, d };
  }
  return best ? { entity: best.entity, param: best.param } : null;
}

/** Phase 3.7 item 4: the Fair/Construction split — a group of granular keys is "Fair" only when
 * EVERY key in it is state 'fair' (a mixed group is neither uniformly Fair nor uniformly
 * Construction, so it matches neither of those two filters, only 'all'). */
function keysAreUniformlyFair(doc: Doc, keys: SegmentKey[]): boolean {
  return keys.length > 0 && keys.every((k) => doc.segmentStates.get(k)?.state === 'fair');
}

/** True when `keys` (whatever granular segments back one candidate) satisfies `filter`. */
function keysMatchFilter(doc: Doc, keys: SegmentKey[], filter: SelectFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'points':
      return false;
    case 'fair':
      return keysAreUniformlyFair(doc, keys);
    case 'construction':
      return !keysAreUniformlyFair(doc, keys);
  }
}

export function groupMatchesFilter(doc: Doc, group: SelectableGroup, filter: SelectFilter): boolean {
  return keysMatchFilter(
    doc,
    group.segments.map((s) => s.key),
    filter,
  );
}

/** The "whole entity" tier's own keys — every group's segments combined, so a circle/line only
 * reads as uniformly Fair/Construction when ALL of its (non-trimmed) pieces agree; a mixed one
 * matches neither, and is reachable only through its individual SelectableGroups (item 3: "one
 * closed Fair/design loop where determinable"). */
function entityKeys(doc: Doc, entity: Entity): SegmentKey[] {
  return deriveSelectableGroups(doc, entity).flatMap((g) => g.segments.map((s) => s.key));
}

export function entityMatchesFilter(doc: Doc, entity: Entity, filter: SelectFilter): boolean {
  return keysMatchFilter(doc, entityKeys(doc, entity), filter);
}

function polygonMatchesFilter(doc: Doc, entityIds: EntityId[], filter: SelectFilter): boolean {
  const keys = entityIds.flatMap((id) => {
    const e = doc.entities.find((x) => x.id === id);
    return e ? entityKeys(doc, e) : [];
  });
  return keysMatchFilter(doc, keys, filter);
}

/** Phase 3.7 item 4: which point kinds are reachable under each filter — 'all' keeps today's
 * unfiltered inspection-of-anything behaviour; 'points' narrows to eligible manual points only
 * (Delete/Merge cleanup targets); 'fair'/'construction' exclude points outright (those two are
 * about segment/entity state, not points). */
export function pointMatchesFilter(doc: Doc, pointId: PointId, filter: SelectFilter): boolean {
  if (filter === 'all') return true;
  if (filter !== 'points') return false;
  const p = doc.points.find((pt) => pt.id === pointId);
  return !!p && isEditablePointKind(p.kind);
}

/**
 * Select's full candidate list at a tap (§5.4, extended with an "entity" tier per Phase 1.2
 * item 3): explicit points, then — per curve within range, nearest first — its segment (if the
 * tap lands on one) followed by the whole entity. Repeated taps cycle through this list. Phase
 * 2A: a line that belongs to a completed Polygon reports its group instead of just itself for
 * that last tier, so cycling reaches "the whole shape", not one arbitrary edge of it. Phase 3.7
 * item 4: `filter` narrows every tier to Select's own current filter — Divide and Fair never
 * pass one, so they keep seeing everything ('all'), completely independent of Select's state.
 */
export function pickSelectCandidates(doc: Doc, view: ViewTransform, screenPos: Vec2, filter: SelectFilter = 'all'): SelectCandidate[] {
  const candidates: SelectCandidate[] = [];

  const points = doc.points
    .filter((p) => !(p.kind === 'free' && p.hidden) && !isPointOrphanedByTrim(doc, p.id) && pointMatchesFilter(doc, p.id, filter))
    .map((p) => ({ id: p.id, d: dist(worldToScreen(view, resolvePoint(doc, p.id)), screenPos) }))
    .filter((p) => p.d <= POINT_HIT_RADIUS)
    .sort((a, b) => a.d - b.d);
  for (const p of points) candidates.push({ kind: 'point', id: p.id });

  if (filter === 'points') return candidates; // segment/entity/group tiers never apply here

  const worldPos = { x: (screenPos.x - view.w / 2) / view.zoom - view.pan.x, y: (screenPos.y - view.h / 2) / view.zoom - view.pan.y };
  const entities = doc.entities
    .map((e) => {
      const proj = curveProjection(doc, e, worldPos);
      return { entity: e, param: proj.param, d: proj.d * view.zoom };
    })
    .filter((e) => e.d <= CURVE_HIT_RADIUS)
    .sort((a, b) => a.d - b.d);

  for (const { entity, param } of entities) {
    // Phase 3.6 item 4: the segment tier resolves to the coarser SelectableGroup, not the raw
    // granular DerivedSegment — with Derived targets off, a run between two Primary points acts
    // as ONE tappable/Fair-able unit instead of fragmenting into every midpoint/division piece.
    const groups = deriveSelectableGroups(doc, entity);
    const group = groupContainingParam(groups, param, entity.kind === 'circle');
    if (group && groupMatchesFilter(doc, group, filter)) {
      candidates.push({
        kind: 'segment',
        entityId: group.entityId,
        from: group.from,
        to: group.to,
        fromParam: group.fromParam,
        toParam: group.toParam,
        keys: group.segments.map((s) => s.key),
      });
    }
    if (entity.kind === 'line' && entity.groupId) {
      const entityIds = doc.entities.filter((e) => e.kind === 'line' && e.groupId === entity.groupId).map((e) => e.id);
      if (polygonMatchesFilter(doc, entityIds, filter)) candidates.push({ kind: 'group', groupId: entity.groupId, entityIds });
    } else if (entityMatchesFilter(doc, entity, filter)) {
      candidates.push({ kind: 'entity', entityId: entity.id });
    }
  }

  // Phase 4 item 8: an already-filled region — lowest priority, only reached when nothing else
  // close matched (a deep-interior tap, well away from any boundary curve/point). Fill regions
  // read as Fair/design work, so they're never offered under the Construction/Points filters.
  if (filter === 'all' || filter === 'fair') {
    const filled = doc.fills.get(doc.activeColourway);
    if (filled && filled.size > 0) {
      const region = findRegionAt(computeFairRegions(doc), worldPos);
      if (region && filled.has(region.sig)) candidates.push({ kind: 'fill', sig: region.sig });
    }
  }

  return candidates;
}
