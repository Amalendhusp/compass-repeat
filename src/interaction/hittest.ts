// Targeting per spec §5.1–5.3: explicit points first (22pt), then implicit
// on-curve projections (16pt), each group ordered by distance. Precision-mode
// disambiguation (§5.4) is deferred; ties currently resolve to the closest.

import type { Doc, Entity, EntityId, Point, PointId, SegmentKey, Vec2 } from '../model/types.ts';
import { projectOntoEntity, resolveEntityGeom, resolvePoint } from '../geometry/kernel.ts';
import { deriveSelectableGroups, groupContainingParam, isParamTrimmed, type DerivedSegment } from '../geometry/segments.ts';
import { computeConstructionRegions, computeFairRegions, findRegionAt } from '../geometry/regions.ts';
import { isPointOrphanedByTrim } from '../geometry/usage.ts';
import { dist, sub } from '../geometry/vec.ts';
import { screenToWorld, type SelectCandidate, type ViewTransform, worldToScreen } from '../app/controller.ts';

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
function pointTargetRank(p: Point): 0 | 1 | 2 {
  if (p.kind === 'on-curve' && p.arcEnd) return 0; // Phase 5.2: an Arc's ends are real nodes
  switch (p.kind) {
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

function isPointTargetEligible(targets: Doc['pointTargets'], p: Point): boolean {
  if (p.kind === 'on-curve' && p.arcEnd) return targets.primary;
  switch (p.kind) {
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
  opts: { explicitOnly?: boolean; exclude?: ReadonlySet<PointId> } = {},
): PointHit | null {
  let best: PointHit | null = null;
  let bestRank = Infinity;
  for (const p of doc.points) {
    if (p.kind === 'free' && p.hidden) continue;
    if (opts.exclude?.has(p.id)) continue;
    if (isPointOrphanedByTrim(doc, p.id)) continue;
    if (!isPointTargetEligible(doc.pointTargets, p)) continue;
    const at = resolvePoint(doc, p.id);
    const d = dist(worldToScreen(view, at), screenPos);
    if (d > POINT_HIT_RADIUS) continue;
    const rank = pointTargetRank(p);
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

/** A run of granular keys reads as "Fair" only when EVERY key in it is Fair — anything else
 * (Construction, Extension, or a mix) is treated as Construction for Select's purposes. */
export function isUniformlyFair(doc: Doc, keys: SegmentKey[]): boolean {
  return keys.length > 0 && keys.every((k) => doc.segmentStates.get(k)?.state === 'fair');
}

/** Every live granular key of an entity (all of its groups combined). */
export function entityKeys(doc: Doc, entity: Entity): SegmentKey[] {
  return deriveSelectableGroups(doc, entity).flatMap((g) => g.segments.map((s) => s.key));
}

/**
 * Select's candidates at a tap (§5.4, extended with an "entity" tier per Phase 1.2 item 3):
 * explicit points, then — per curve within range, nearest first — its segment (the coarser
 * SelectableGroup under the tap) followed by the whole entity, or, for a legacy Polygon edge, its
 * group. Closed regions are picked separately (pickRegionAt) — only a tap that hits nothing else.
 */
export function pickSelectCandidates(doc: Doc, view: ViewTransform, screenPos: Vec2): SelectCandidate[] {
  const candidates: SelectCandidate[] = [];

  const points = doc.points
    .filter((p) => !(p.kind === 'free' && p.hidden) && !isPointOrphanedByTrim(doc, p.id))
    .map((p) => ({ id: p.id, d: dist(worldToScreen(view, resolvePoint(doc, p.id)), screenPos) }))
    .filter((p) => p.d <= POINT_HIT_RADIUS)
    .sort((a, b) => a.d - b.d);
  for (const p of points) candidates.push({ kind: 'point', id: p.id });

  const worldPos = screenToWorld(view, screenPos);
  const entities = doc.entities
    .map((e) => {
      const proj = curveProjection(doc, e, worldPos);
      return { entity: e, param: proj.param, d: proj.d * view.zoom };
    })
    .filter((e) => e.d <= CURVE_HIT_RADIUS)
    .sort((a, b) => a.d - b.d);

  for (const { entity, param } of entities) {
    const group = groupContainingParam(deriveSelectableGroups(doc, entity), param, entity.kind === 'circle');
    if (group) {
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
      candidates.push({ kind: 'group', groupId: entity.groupId, entityIds });
    } else {
      candidates.push({ kind: 'entity', entityId: entity.id });
    }
  }
  return candidates;
}

function regionCandidate(region: { sig: string; keys: Set<SegmentKey> }, fair: boolean): Extract<SelectCandidate, { kind: 'region' }> {
  return { kind: 'region', sig: region.sig, fair, keys: [...region.keys] };
}

/** Phase 5.2 item 9: the closed region a tap lands inside — a Fair (design) region first, since
 * that is what the participant is shaping; only where no Fair region encloses the tap, the
 * innermost closed Construction region. `onlyFair` narrows to one type (multi-region collecting). */
export function pickRegionAt(doc: Doc, worldPos: Vec2, onlyFair?: boolean): Extract<SelectCandidate, { kind: 'region' }> | null {
  if (onlyFair !== false) {
    const fair = findRegionAt(computeFairRegions(doc), worldPos);
    if (fair) return regionCandidate(fair, true);
    if (onlyFair === true) return null;
  }
  const construction = findRegionAt(computeConstructionRegions(doc), worldPos);
  return construction ? regionCandidate(construction, false) : null;
}
