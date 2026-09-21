// A reference to a point that may not exist yet — an implicit on-curve
// projection or a free-drag release (§5.3, §3 radius model). Kept unmaterialized
// until the whole tool step commits, so a cancelled step leaves no orphan point
// and a multi-step commit (e.g. a circle whose centre is a fresh on-curve point)
// is still one undo entry (§8).

import type { Doc, EntityId, PointId, Vec2 } from '../model/types.ts';
import { addFreePoint, addOnCurvePoint } from '../model/doc.ts';
import { resolvePoint } from '../geometry/kernel.ts';
import type { PointHit } from './hittest.ts';

export type PointRef =
  | { kind: 'existing'; id: PointId }
  | { kind: 'implicit'; host: EntityId; param: number; at: Vec2 }
  | { kind: 'free'; at: Vec2 };

export function refFromHit(hit: PointHit): PointRef {
  if (hit.id) return { kind: 'existing', id: hit.id };
  return { kind: 'implicit', host: hit.implicit!.host, param: hit.implicit!.param, at: hit.at };
}

export function refAt(at: Vec2): PointRef {
  return { kind: 'free', at };
}

export function refLocation(doc: Doc, ref: PointRef): Vec2 {
  if (ref.kind === 'existing') return resolvePoint(doc, ref.id);
  return ref.at;
}

export function materializeRef(doc: Doc, ref: PointRef): PointId {
  switch (ref.kind) {
    case 'existing':
      return ref.id;
    case 'implicit':
      return addOnCurvePoint(doc, ref.host, ref.param, ref.at);
    case 'free':
      return addFreePoint(doc, ref.at.x, ref.at.y);
  }
}
