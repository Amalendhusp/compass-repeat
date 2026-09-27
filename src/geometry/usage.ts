// Point-usage queries for the point-visibility model (Phase 1.2 item 7) and Select.

import type { Doc, Entity, EntityId, Point, PointId } from '../model/types.ts';
import { deriveSegments, lonePointOn } from './segments.ts';

/** Phase 3.7 item 7: the point kinds a participant can directly act on (Delete/Merge) — every
 * other kind is mathematically derived and stays protected. Free (hand-placed) and on-curve
 * (Free-on-curve) points are the only "manual" ones. */
export function isEditablePointKind(kind: Point['kind']): boolean {
  return kind === 'free' || kind === 'on-curve';
}

// ---- Phase 5.11: point facts derived once per document state ----
//
// The renderer, snapping, hit-testing, the loupe and the node inset each ask "is this point used /
// a frame point / orphaned by Trim?" of EVERY point — on every frame, every pointer move. Each
// answer used to be its own linear scan (points.find, entities.find, a host's segment list), so a
// dense drawing (Plate 113: 3,779 points) paid O(points × (points + segments)) per frame, ~50 ms.
// The answers only change when the document does, so they are derived together in one
// O(points + segments) pass and kept per Doc, like deriveSegments' own cache (segments.ts): keyed
// on the Doc, guarded by point/entity counts and the segmentStates map, and dropped by
// invalidateGeometryCaches() and at the end of every commit (AppController.commit), since a commit
// may change a segment's state in place without changing any count.
interface PointFacts {
  pointCount: number;
  entityCount: number;
  states: Doc['segmentStates'];
  stateCount: number;
  /** First point with each id — what `doc.points.find` returns. */
  byId: Map<PointId, Point>;
  used: Set<PointId>;
  orphaned: Set<PointId>;
  /** How many different curves are really drawn through each point (see isCrossingPoint). */
  support: Map<PointId, number>;
}

const perDocPointFacts = new WeakMap<Doc, PointFacts>();

function pointFacts(doc: Doc): PointFacts {
  const cached = perDocPointFacts.get(doc);
  if (
    cached &&
    cached.pointCount === doc.points.length &&
    cached.entityCount === doc.entities.length &&
    cached.states === doc.segmentStates &&
    cached.stateCount === doc.segmentStates.size
  ) {
    return cached;
  }
  const facts = computePointFacts(doc);
  perDocPointFacts.set(doc, facts);
  return facts;
}

/** Forget `doc`'s point facts — see invalidateGeometryCaches (model/doc.ts) and AppController.commit. */
export function invalidatePointFacts(doc: Doc): void {
  perDocPointFacts.delete(doc);
}

function computePointFacts(doc: Doc): PointFacts {
  const byId = new Map<PointId, Point>();
  for (const p of doc.points) if (!byId.has(p.id)) byId.set(p.id, p);

  const used = new Set<PointId>();
  const entityById = new Map<EntityId, Entity>();
  for (const e of doc.entities) {
    if (!entityById.has(e.id)) entityById.set(e.id, e);
    if (e.kind === 'circle') {
      used.add(e.centre);
      used.add(e.through);
    } else {
      used.add(e.a);
      used.add(e.b);
    }
  }

  // Phase 5.12f: per point, how many different curves are really drawn through it — an end of one
  // of the curve's live (untrimmed) segments, or the single point on a whole circle that has no
  // segments yet. Geometry, not provenance: one point stands for everything that meets at its
  // place (mergeOrCreatePoint reuses whatever point is already there), so what it was first
  // created as — an on-curve point, a division, the crossing of two lines since trimmed away —
  // says nothing about which curves still pass through it.
  const support = new Map<PointId, number>();
  for (const entity of entityById.values()) {
    const live = new Set<PointId>();
    const segs = deriveSegments(doc, entity);
    for (const s of segs) {
      if ((doc.segmentStates.get(s.key)?.state ?? 'construction') === 'trimmed') continue;
      live.add(s.from);
      live.add(s.to);
    }
    if (segs.length === 0) {
      const lone = lonePointOn(doc, entity);
      if (lone) live.add(lone);
    }
    for (const id of live) support.set(id, (support.get(id) ?? 0) + 1);
  }

  // A derived point is orphaned once no drawn curve passes through it any more.
  const orphaned = new Set<PointId>();
  for (const p of byId.values()) {
    if (p.kind !== 'on-curve' && p.kind !== 'division' && p.kind !== 'intersection') continue;
    if (!support.has(p.id)) orphaned.add(p.id);
  }

  return {
    pointCount: doc.points.length,
    entityCount: doc.entities.length,
    states: doc.segmentStates,
    stateCount: doc.segmentStates.size,
    byId,
    used,
    orphaned,
    support,
  };
}

/** The point with this id (the first, as `doc.points.find` would give), without a linear scan. */
export function pointById(doc: Doc, pointId: PointId): Point | undefined {
  return pointFacts(doc).byId.get(pointId);
}

/** A point is "used" once at least one entity is defined through it. */
export function isPointUsed(doc: Doc, pointId: PointId): boolean {
  return pointFacts(doc).used.has(pointId);
}

/** The frame's own centre and vertices — "required frame feedback" always shows these. */
export function isFramePoint(doc: Doc, pointId: PointId): boolean {
  if (doc.frame.centreId === pointId) return true;
  return pointFacts(doc).byId.get(pointId)?.kind === 'frame-vertex';
}

/**
 * Phase 2.1 item 4: true once Trim has removed every piece of curve that passed through this
 * derived (on-curve / division / intersection) point. A derived check, not stored state: Undo (a
 * whole-Doc snapshot) and any future un-trim both un-orphan a point automatically, with no extra
 * bookkeeping. Free/centre/frame-vertex/midpoint points never depend on a segment this way and
 * are never orphaned. Phase 5.12f: ANY drawn curve through the point supports it — not only the
 * ones it was first created from — so a place where a circle and a line still visibly cross is
 * never hidden because the two lines it was first made from have been trimmed there.
 */
export function isPointOrphanedByTrim(doc: Doc, pointId: PointId): boolean {
  return pointFacts(doc).orphaned.has(pointId);
}

/**
 * Phase 5.12f: at least two different curves are really drawn through this point — a genuine
 * crossing (or touching) of visible construction geometry, whatever kind of point happens to
 * stand for that place. Such a point is always a Primary target (hittest.ts isPointTargetEligibleIn).
 */
export function isCrossingPoint(doc: Doc, pointId: PointId): boolean {
  return (pointFacts(doc).support.get(pointId) ?? 0) >= 2;
}
