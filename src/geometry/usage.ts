// Point-usage queries for the point-visibility model (Phase 1.2 item 7) and marquee/select.

import type { Doc, Point, PointId } from '../model/types.ts';
import { deriveSegments } from './segments.ts';

/** Phase 3.7 item 7: the point kinds a participant can directly act on (Delete/Merge) — every
 * other kind is mathematically derived and stays protected. Free (hand-placed) and on-curve
 * (Free-on-curve) points are the only "manual" ones. */
export function isEditablePointKind(kind: Point['kind']): boolean {
  return kind === 'free' || kind === 'on-curve';
}

/** A point is "used" once at least one entity is defined through it. */
export function isPointUsed(doc: Doc, pointId: PointId): boolean {
  for (const e of doc.entities) {
    if (e.kind === 'circle') {
      if (e.centre === pointId || e.through === pointId) return true;
    } else if (e.a === pointId || e.b === pointId) {
      return true;
    }
  }
  return false;
}

/** The frame's own centre and vertices — "required frame feedback" always shows these. */
export function isFramePoint(doc: Doc, pointId: PointId): boolean {
  if (doc.frame.centreId === pointId) return true;
  const p = doc.points.find((pt) => pt.id === pointId);
  return p?.kind === 'frame-vertex';
}

/**
 * Phase 2.1 item 4: true once every entity this point depends on (its on-curve/division host, or
 * an intersection's two entities) can only still reach it through a trimmed segment — i.e. Trim
 * removed the only geometric support the point had. A derived check, not stored state: Undo (a
 * whole-Doc snapshot) and any future un-trim both un-orphan a point automatically, with no extra
 * bookkeeping. Free/centre/frame-vertex/midpoint points never depend on a segment this way and
 * are never orphaned.
 */
export function isPointOrphanedByTrim(doc: Doc, pointId: PointId): boolean {
  const p = doc.points.find((pt) => pt.id === pointId);
  if (!p) return false;
  const hostEntityIds: string[] =
    p.kind === 'on-curve' || p.kind === 'division' ? [p.host] : p.kind === 'intersection' ? p.entities : [];
  if (hostEntityIds.length === 0) return false;
  for (const eid of hostEntityIds) {
    const entity = doc.entities.find((e) => e.id === eid);
    if (!entity) continue;
    const segs = deriveSegments(doc, entity);
    const boundary = segs.filter((s) => s.from === pointId || s.to === pointId);
    if (boundary.length === 0) continue;
    const hasLiveBoundary = boundary.some((s) => (doc.segmentStates.get(s.key)?.state ?? 'construction') !== 'trimmed');
    if (hasLiveBoundary) return false;
  }
  return true;
}
