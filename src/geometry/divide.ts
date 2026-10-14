// Pure position math for Divide (§2C, Phase 2.1 item 1): shared by the mutating commit path in
// model/doc.ts and the live preview drawn while the compact slider is still being dragged, so
// the preview can never drift from what Apply actually creates.

import type { Doc, Entity, EntityId, PointId, Vec2 } from '../model/types.ts';
import { resolveEntityGeom, resolvePoint, type CircleGeom } from './kernel.ts';

/** Phase 3.6 item 4: the only shape this (and addSegmentDivisionPoints) actually needs — matches
 * both a raw DerivedSegment and a (possibly Derived-target-merged) SelectableGroup, so Divide
 * works the same whether it's dividing one granular piece or a whole grouped span. */
export interface SegmentSpan {
  entityId: EntityId;
  from: PointId;
  to: PointId;
  fromParam: number;
  toParam: number;
}

/** Interior division points for one line/arc segment (or grouped span), `of` equal parts between
 * its own endpoints — angular interpolation for an arc, linear for a line. */
export function segmentDivisionPositions(doc: Doc, host: Entity, seg: SegmentSpan, of: number): Vec2[] {
  const positions: Vec2[] = [];
  if (host.kind === 'circle') {
    const g = resolveEntityGeom(doc, host) as CircleGeom;
    let arcSpan = seg.toParam - seg.fromParam;
    if (arcSpan < 0) arcSpan += Math.PI * 2;
    for (let i = 1; i < of; i++) {
      const angle = seg.fromParam + arcSpan * (i / of);
      positions.push({ x: g.centre.x + g.radius * Math.cos(angle), y: g.centre.y + g.radius * Math.sin(angle) });
    }
  } else {
    const a = resolvePoint(doc, seg.from);
    const b = resolvePoint(doc, seg.to);
    for (let i = 1; i < of; i++) {
      const t = i / of;
      positions.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return positions;
}

/** All `of` points around a whole closed circle, the first at `anchorAngle` (0 = its rightmost
 * point) and the rest at exactly equal steps from it. */
export function circleDivisionPositions(doc: Doc, host: Entity, of: number, anchorAngle: number): Vec2[] {
  const g = resolveEntityGeom(doc, host) as CircleGeom;
  const positions: Vec2[] = [];
  for (let i = 0; i < of; i++) {
    const angle = anchorAngle + (i / of) * Math.PI * 2;
    positions.push({ x: g.centre.x + g.radius * Math.cos(angle), y: g.centre.y + g.radius * Math.sin(angle) });
  }
  return positions;
}

/** An angle as 0 ≤ a < 2π. */
export function wholeAngle(a: number): number {
  const t = a % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
}

/** Turning a whole-circle division by hand: if one of its `of` points is within `reach` (radians)
 * of one of `candidates` (angles on the circle that already mean something — its existing points),
 * the whole set turns that last little way so the two coincide exactly. `met` is every candidate a
 * point of the set then sits on. */
export function snapDivisionAngle(angle: number, of: number, candidates: number[], reach: number): { angle: number; met: number[] } {
  const step = (Math.PI * 2) / of;
  /** How far the set would have to turn for one of its points to be at `c`. */
  const offset = (c: number, from: number): number => {
    let off = (c - from) % step;
    if (off > step / 2) off -= step;
    else if (off <= -step / 2) off += step;
    return off;
  };
  let best: number | null = null;
  for (const c of candidates) {
    const off = offset(c, angle);
    if (Math.abs(off) <= reach && (best === null || Math.abs(off) < Math.abs(best))) best = off;
  }
  if (best === null) return { angle: wholeAngle(angle), met: [] };
  const snapped = wholeAngle(angle + best);
  return { angle: snapped, met: candidates.filter((c) => Math.abs(offset(c, snapped)) < 1e-9) };
}
