// Fair trace geometry — Phase 3D (spec §4.7): the direction-based junction continuation that
// tells a genuine "keep going the way the finger is going" from "just any connected segment."
// Pure functions only; interaction/tools/fair.ts owns the gesture/timing state machine.

import type { Doc, Entity, PointId, Vec2 } from '../model/types.ts';
import { resolveEntityGeom, resolvePoint } from './kernel.ts';
import { deriveSegments, type DerivedSegment } from './segments.ts';
import { normalize, sub } from './vec.ts';

export interface JunctionCandidate {
  entity: Entity;
  seg: DerivedSegment;
}

/** Every live segment (not trimmed; frame segments only when `allowFrame`) incident on
 * `pointId`, across every entity in the doc, excluding the one the trace just came from. */
export function segmentsAtJunction(doc: Doc, pointId: PointId, excludeKey: string | null, allowFrame: boolean): JunctionCandidate[] {
  const out: JunctionCandidate[] = [];
  for (const e of doc.entities) {
    if (e.locked && !allowFrame) continue;
    for (const seg of deriveSegments(doc, e)) {
      if (seg.key === excludeKey) continue;
      if (seg.from !== pointId && seg.to !== pointId) continue;
      const state = doc.segmentStates.get(seg.key)?.state ?? 'construction';
      if (state === 'trimmed') continue;
      out.push({ entity: e, seg });
    }
  }
  return out;
}

/** World-space unit tangent at `atPointId` (which must be `seg.from` or `seg.to`), pointing in
 * the direction of travel INTO the segment from that endpoint — the CCW arc tangent when
 * entering at `from`, its reverse when entering at `to` (arcs are stored from → to
 * counter-clockwise); the endpoint-to-endpoint direction for a line. */
export function outgoingTangent(doc: Doc, entity: Entity, seg: DerivedSegment, atPointId: PointId): Vec2 {
  const g = resolveEntityGeom(doc, entity);
  const atFrom = atPointId === seg.from;
  if (g.kind === 'circle') {
    const theta = atFrom ? seg.fromParam : seg.toParam;
    const ccw = { x: -Math.sin(theta), y: Math.cos(theta) };
    return atFrom ? ccw : { x: -ccw.x, y: -ccw.y };
  }
  const a = resolvePoint(doc, seg.from);
  const b = resolvePoint(doc, seg.to);
  const dir = normalize(sub(b, a));
  return atFrom ? dir : { x: -dir.x, y: -dir.y };
}

export function otherEndpoint(seg: DerivedSegment, pointId: PointId): PointId {
  return seg.from === pointId ? seg.to : seg.from;
}

/** Angle between two vectors in degrees, 0–180. Either vector may be un-normalized (or even a
 * raw un-normalized heading EMA); a near-zero vector reads as maximally different (180°) rather
 * than throwing or returning NaN. */
export function angleBetween(a: Vec2, b: Vec2): number {
  const la = Math.hypot(a.x, a.y);
  const lb = Math.hypot(b.x, b.y);
  if (la < 1e-9 || lb < 1e-9) return 180;
  const cos = (a.x * b.x + a.y * b.y) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, cos))) * (180 / Math.PI);
}
