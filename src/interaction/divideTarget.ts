// Divide's targets — which span of a line, arc or circle a division covers, and where its points
// would go. Shared by the Divide tool (a tap) and by selection first (a Select selection, then Divide:
// selectionFirst.ts), so both reach exactly the same target. Geometry only: nothing here changes the
// artwork.

import type { Doc, Entity, Vec2 } from '../model/types.ts';
import type { DivideTarget } from '../app/controller.ts';
import { deriveSegments } from '../geometry/segments.ts';
import { circleDivisionPositions, segmentDivisionPositions } from '../geometry/divide.ts';

/** The live (untrimmed) span of a circle when it is an Arc — one contiguous run of segments. */
function arcSpan(doc: Doc, entity: Entity): { from: string; to: string; fromParam: number; toParam: number } | null {
  const segs = deriveSegments(doc, entity);
  const live = segs.map((s) => (doc.segmentStates.get(s.key)?.state ?? 'construction') !== 'trimmed');
  if (live.every(Boolean) || !live.some(Boolean)) return null;
  const n = segs.length;
  const startIdx = live.findIndex((l, i) => l && !live[(i - 1 + n) % n]);
  let endIdx = startIdx;
  while (live[(endIdx + 1) % n] && (endIdx + 1) % n !== startIdx) endIdx = (endIdx + 1) % n;
  const first = segs[startIdx]!;
  const last = segs[endIdx]!;
  return { from: first.from, to: last.to, fromParam: first.fromParam, toParam: last.toParam };
}

export function parentTarget(doc: Doc, entity: Entity): DivideTarget | null {
  if (entity.kind === 'line') {
    return { label: 'Line', scope: 'parent', entityId: entity.id, kind: 'segment', from: entity.a, to: entity.b, fromParam: 0, toParam: 1 };
  }
  const span = arcSpan(doc, entity);
  if (span) return { label: 'Arc', scope: 'parent', entityId: entity.id, kind: 'segment', ...span };
  const hasTrim = deriveSegments(doc, entity).some((s) => doc.segmentStates.get(s.key)?.state === 'trimmed');
  return hasTrim ? null : { label: 'Circle', scope: 'parent', entityId: entity.id, kind: 'circle-whole' };
}

/** Where Apply would put points: `angle` is where a whole circle's first one goes (ignored for a span). */
export function dividePreviewPoints(doc: Doc, target: DivideTarget, n: number, angle: number): Vec2[] {
  const entity = doc.entities.find((e) => e.id === target.entityId);
  if (!entity) return [];
  if (target.kind === 'circle-whole') return circleDivisionPositions(doc, entity, n, angle);
  return segmentDivisionPositions(doc, entity, target, n);
}
