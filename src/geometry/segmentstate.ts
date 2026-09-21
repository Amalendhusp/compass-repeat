// Segment state migration — Phase 2B: "when a segment is split, child segments inherit the
// previous segment's state." Entities stay single parametric curves (§3); segments are derived
// on demand (segments.ts), and `doc.segmentStates` is the only persisted, stable identity a
// piece of curve carries (e.g. 'trimmed'). Whenever a new point lands on an entity's curve, an
// old segment's span gets replaced by two or more new spans — this reassigns any state that old
// span had onto whichever new span(s) fall inside it, then drops the stale key.

import type { Doc, Entity, EntityId } from '../model/types.ts';
import { deriveSegments, paramInRange, type DerivedSegment } from './segments.ts';

/** Snapshot to diff against after the mutation — call before adding a point that might land on
 * `entity`'s curve. */
export function segmentsBefore(doc: Doc, entity: Entity): DerivedSegment[] {
  return deriveSegments(doc, entity);
}

function midParam(fromParam: number, toParam: number, isCircle: boolean): number {
  if (!isCircle) return (fromParam + toParam) / 2;
  let span = toParam - fromParam;
  if (span < 0) span += Math.PI * 2; // the segment wraps past 2π
  return fromParam + span / 2;
}

export function migrateSegmentStates(doc: Doc, entityId: EntityId, before: DerivedSegment[]): void {
  const entity = doc.entities.find((e) => e.id === entityId);
  if (!entity || before.length === 0) return;
  const after = deriveSegments(doc, entity);
  const isCircle = entity.kind === 'circle';
  for (const oldSeg of before) {
    const state = doc.segmentStates.get(oldSeg.key);
    if (!state) continue;
    doc.segmentStates.delete(oldSeg.key);
    for (const newSeg of after) {
      const probe = newSeg.key === oldSeg.key ? oldSeg.fromParam : midParam(newSeg.fromParam, newSeg.toParam, isCircle);
      if (paramInRange(probe, oldSeg.fromParam, oldSeg.toParam, isCircle)) {
        doc.segmentStates.set(newSeg.key, state);
      }
    }
  }
}

/** Runs `mutate`, migrating segment state for every entity that might have gained a new point
 * on its curve as a result (safe to pass entities that turn out unaffected — a no-op then). */
export function withSegmentMigration(doc: Doc, affectedEntityIds: EntityId[], mutate: () => void): void {
  const snapshots = affectedEntityIds.map((id) => {
    const entity = doc.entities.find((e) => e.id === id);
    return [id, entity ? segmentsBefore(doc, entity) : []] as const;
  });
  mutate();
  for (const [id, before] of snapshots) migrateSegmentStates(doc, id, before);
}
