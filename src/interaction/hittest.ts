// Targeting per spec §5.1–5.3: explicit points first (22pt), then implicit
// on-curve projections (16pt), each group ordered by distance. Precision-mode
// disambiguation (§5.4) is deferred; ties currently resolve to the closest.

import type { Doc, Entity, EntityId, Point, PointId, SegmentKey, Vec2 } from '../model/types.ts';
import { projectOntoEntity, resolveEntityGeom, resolvePoint } from '../geometry/kernel.ts';
import { deriveSelectableGroups, groupContainingParam, isParamTrimmed, type DerivedSegment } from '../geometry/segments.ts';
import { computeConstructionRegions, computeFairRegions, findRegionAt } from '../geometry/regions.ts';
import { isCrossingPoint, isPointOrphanedByTrim } from '../geometry/usage.ts';
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

/** Phase 3.4 items 5–7: which point kinds each Point Target category governs. `free`-kind
 * (hand-placed) points sit outside the scheme and stay eligible; existing `on-curve` points follow
 * "Free on curve" (except an Arc's own ends, which are real nodes — Phase 5.2). */
export function isPointTargetEligible(targets: Doc['pointTargets'], p: Point): boolean {
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
 * Phase 5.12f: eligibility in a document — by kind (above), and also for ANY point where two or
 * more drawn curves cross or touch: a crossing is a Primary target however its point was first
 * created (an on-curve point a line was later drawn from, the incircle's own radius point at a
 * tangency, a division point another curve passes through…). Primary off still means off.
 */
export function isPointTargetEligibleIn(doc: Doc, p: Point): boolean {
  if (isPointTargetEligible(doc.pointTargets, p)) return true;
  return doc.pointTargets.primary && isCrossingPoint(doc, p.id);
}

/**
 * Finds the best point target for a point-taking tool (Circle/Line/Polygon). Explicit points
 * always outrank implicit curve projections (§5.3). Phase 3.4 items 5–7 replace the old binary
 * Point Lock: only point kinds whose category is enabled in `doc.pointTargets` compete at all
 * (a disabled category is never silently chosen, no matter how close). Smart Snap: among those,
 * the NEAREST ON SCREEN wins — category no longer outranks distance, so a Division point under
 * the finger is never silently replaced by a Centre a little further off (see interaction/snap.ts
 * for the gesture-level hysteresis and ambiguity handling built on top of this). An implicit new
 * on-curve projection is offered only when nothing eligible already exists there AND Free-on-curve
 * is enabled.
 */
export function pickPointTarget(
  doc: Doc,
  view: ViewTransform,
  screenPos: Vec2,
  opts: { explicitOnly?: boolean; exclude?: ReadonlySet<PointId> } = {},
): PointHit | null {
  let best: PointHit | null = null;
  for (const p of doc.points) {
    if (p.kind === 'free' && p.hidden) continue;
    if (opts.exclude?.has(p.id)) continue;
    if (isPointOrphanedByTrim(doc, p.id)) continue;
    if (!isPointTargetEligibleIn(doc, p)) continue;
    const at = resolvePoint(doc, p.id);
    const d = dist(worldToScreen(view, at), screenPos);
    if (d > POINT_HIT_RADIUS) continue;
    if (d < (best?.screenD ?? Infinity)) best = { id: p.id, at, screenD: d };
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
 * that need the raw hit before deciding how to interpret it. `d` is the screen distance. */
export function pickCurveHit(doc: Doc, view: ViewTransform, screenPos: Vec2): { entity: Entity; param: number; d: number } | null {
  return curveCandidatesAt(doc, view, screenPos)[0] ?? null;
}

/** Phase 5.8: every curve within the hit band under `screenPos`, nearest first — Fair's "Which
 * line?" and Smart Snap's "No point here yet" both need more than the single nearest curve. */
export function curveCandidatesAt(doc: Doc, view: ViewTransform, screenPos: Vec2, radius = CURVE_HIT_RADIUS): { entity: Entity; param: number; d: number }[] {
  const worldPos = { x: (screenPos.x - view.w / 2) / view.zoom - view.pan.x, y: (screenPos.y - view.h / 2) / view.zoom - view.pan.y };
  const out: { entity: Entity; param: number; d: number }[] = [];
  for (const e of doc.entities) {
    const proj = curveProjection(doc, e, worldPos);
    const d = proj.d * view.zoom;
    if (d <= radius) out.push({ entity: e, param: proj.param, d });
  }
  return out.sort((a, b) => a.d - b.d);
}

/** Phase 5.8: where `screenPos` projects onto one particular curve, and how far off it is (screen px). */
export function curveDistanceAt(doc: Doc, view: ViewTransform, entity: Entity, screenPos: Vec2): { param: number; d: number; point: Vec2 } {
  const proj = curveProjection(doc, entity, screenToWorld(view, screenPos));
  return { param: proj.param, d: proj.d * view.zoom, point: proj.point };
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
