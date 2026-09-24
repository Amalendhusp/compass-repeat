// Geometry kernel: analytic intersections and point resolution.
// Per spec §12.1: double-precision analytic intersections, fixed relative
// epsilon, near-tangent circle pairs merge to one point.

import type { Doc, Entity, EntityId, Point, PointId, Vec2 } from '../model/types.ts';
import { dist, len, normalize, sub } from './vec.ts';

export interface CircleGeom {
  kind: 'circle';
  centre: Vec2;
  radius: number;
}
export interface LineGeom {
  kind: 'line';
  a: Vec2;
  b: Vec2;
  dir: Vec2; // unit vector a -> b
}
export type EntityGeom = CircleGeom | LineGeom;

/** World-space epsilon, approximated from the frame's scale (spec §3: ε = 1e-6 × drawing extent). */
export function epsilon(doc: Doc): number {
  return Math.max(1e-6 * doc.frame.radius * 8, 1e-9);
}

export function findPoint(doc: Doc, id: PointId): Point | undefined {
  return doc.points.find((p) => p.id === id);
}

export function frameVertexCount(kind: Doc['frame']['kind']): number {
  switch (kind) {
    case 'square':
      return 4;
    case 'hexagon':
      return 6;
    case 'triangle':
      return 3;
    case 'circle':
      return 0;
  }
}

// Per-doc cache (Phase 1.1 item 2): Doc objects are only replaced wholesale by cloneDoc() on
// commit/undo/redo; pan/zoom mutate `doc.view` on the SAME object. Keying by the Doc reference
// means resolution is reused across every render frame during a pinch/pan, and is naturally
// invalidated the instant a real geometry commit produces a new Doc — no manual bookkeeping.
const perDocCache = new WeakMap<Doc, Map<PointId, Vec2>>();

/** Phase 5.2: moving a point or rebinding an endpoint changes geometry WITHIN one commit without
 * replacing the Doc — anything resolved before that change must be forgotten. */
export function invalidateResolveCache(doc: Doc): void {
  perDocCache.delete(doc);
}

export function resolvePoint(doc: Doc, id: PointId, cache?: Map<PointId, Vec2>): Vec2 {
  if (!cache) {
    let c = perDocCache.get(doc);
    if (!c) {
      c = new Map();
      perDocCache.set(doc, c);
    }
    cache = c;
  }
  const cached = cache.get(id);
  if (cached) return cached;
  const p = findPoint(doc, id);
  if (!p) throw new Error(`Unknown point ${id}`);
  let out: Vec2;
  switch (p.kind) {
    case 'free':
      out = { x: p.x, y: p.y };
      break;
    case 'centre':
      out = doc.frame.origin;
      break;
    case 'frame-vertex': {
      const n = frameVertexCount(doc.frame.kind);
      const angle = doc.frame.rotation + (p.index / n) * Math.PI * 2;
      out = {
        x: doc.frame.origin.x + doc.frame.radius * Math.cos(angle),
        y: doc.frame.origin.y + doc.frame.radius * Math.sin(angle),
      };
      break;
    }
    case 'midpoint': {
      const a = resolvePoint(doc, p.a, cache);
      const b = resolvePoint(doc, p.b, cache);
      out = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      break;
    }
    case 'on-curve': {
      const host = doc.entities.find((e) => e.id === p.host);
      if (!host) throw new Error(`Unknown host entity ${p.host}`);
      out = pointAtParam(doc, host, p.param, cache);
      break;
    }
    case 'division': {
      const host = doc.entities.find((e) => e.id === p.host);
      if (!host) throw new Error(`Unknown host entity ${p.host}`);
      out = divisionPoint(doc, host, p, cache);
      break;
    }
    case 'intersection': {
      const [e1, e2] = p.entities.map((eid) => doc.entities.find((e) => e.id === eid)!);
      const pts = intersectEntities(doc, e1, e2, cache);
      out = pts[p.branch] ?? pts[0] ?? doc.frame.origin;
      break;
    }
  }
  cache.set(id, out);
  return out;
}

export function resolveEntityGeom(doc: Doc, entity: Entity, cache?: Map<PointId, Vec2>): EntityGeom {
  if (entity.kind === 'circle') {
    const centre = resolvePoint(doc, entity.centre, cache);
    const through = resolvePoint(doc, entity.through, cache);
    return { kind: 'circle', centre, radius: dist(centre, through) };
  }
  const a = resolvePoint(doc, entity.a, cache);
  const b = resolvePoint(doc, entity.b, cache);
  return { kind: 'line', a, b, dir: normalize(sub(b, a)) };
}

function pointAtParam(doc: Doc, host: Entity, param: number, cache?: Map<PointId, Vec2>): Vec2 {
  const g = resolveEntityGeom(doc, host, cache);
  if (g.kind === 'circle') {
    return { x: g.centre.x + g.radius * Math.cos(param), y: g.centre.y + g.radius * Math.sin(param) };
  }
  return { x: g.a.x + (g.b.x - g.a.x) * param, y: g.a.y + (g.b.y - g.a.y) * param };
}

function divisionPoint(
  doc: Doc,
  host: Entity,
  p: Extract<Point, { kind: 'division' }>,
  cache?: Map<PointId, Vec2>,
): Vec2 {
  const g = resolveEntityGeom(doc, host, cache);
  if (p.span) {
    if (g.kind === 'circle' && p.arcSpan !== undefined) {
      // Arc-segment division: angular interpolation along the specific arc the segment
      // represented, not a straight chord cut across it.
      const angle = (p.rotationOffset ?? 0) + p.arcSpan * (p.index / p.of);
      return { x: g.centre.x + g.radius * Math.cos(angle), y: g.centre.y + g.radius * Math.sin(angle) };
    }
    const [sa, sb] = p.span;
    const a = resolvePoint(doc, sa, cache);
    const b = resolvePoint(doc, sb, cache);
    const t = p.index / p.of;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  if (g.kind === 'circle') {
    const angle = (p.rotationOffset ?? 0) + (p.index / p.of) * Math.PI * 2;
    return { x: g.centre.x + g.radius * Math.cos(angle), y: g.centre.y + g.radius * Math.sin(angle) };
  }
  const t = p.index / p.of;
  return { x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t };
}

/** Ordered so branch index is stable across recomputation regardless of call order. */
function canonicalOrder(pts: Vec2[]): Vec2[] {
  return [...pts].sort((p, q) => (p.y - q.y) || (p.x - q.x));
}

export function intersectEntities(doc: Doc, e1: Entity, e2: Entity, cache?: Map<PointId, Vec2>): Vec2[] {
  const g1 = resolveEntityGeom(doc, e1, cache);
  const g2 = resolveEntityGeom(doc, e2, cache);
  const eps = epsilon(doc);
  if (g1.kind === 'line' && g2.kind === 'line') return canonicalOrder(lineLine(g1, g2, eps));
  if (g1.kind === 'circle' && g2.kind === 'circle') return canonicalOrder(circleCircle(g1, g2, eps));
  const line = g1.kind === 'line' ? g1 : (g2 as LineGeom);
  const circle = g1.kind === 'circle' ? g1 : (g2 as CircleGeom);
  return canonicalOrder(lineCircle(line, circle, eps));
}

function lineLine(l1: LineGeom, l2: LineGeom, eps: number): Vec2[] {
  const d1 = sub(l1.b, l1.a);
  const d2 = sub(l2.b, l2.a);
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < eps) return [];
  const dx = l2.a.x - l1.a.x;
  const dy = l2.a.y - l1.a.y;
  const t = (dx * d2.y - dy * d2.x) / denom;
  return [{ x: l1.a.x + d1.x * t, y: l1.a.y + d1.y * t }];
}

function lineCircle(l: LineGeom, c: CircleGeom, eps: number): Vec2[] {
  // Solve |a + t*d - centre|^2 = r^2 for t, with d normalized.
  const fx = l.a.x - c.centre.x;
  const fy = l.a.y - c.centre.y;
  const b = fx * l.dir.x + fy * l.dir.y;
  const cc = fx * fx + fy * fy - c.radius * c.radius;
  const disc = b * b - cc;
  if (disc < -eps) return [];
  if (disc < eps) {
    const t = -b;
    return [{ x: l.a.x + l.dir.x * t, y: l.a.y + l.dir.y * t }];
  }
  const s = Math.sqrt(disc);
  const t1 = -b - s;
  const t2 = -b + s;
  return [
    { x: l.a.x + l.dir.x * t1, y: l.a.y + l.dir.y * t1 },
    { x: l.a.x + l.dir.x * t2, y: l.a.y + l.dir.y * t2 },
  ];
}

function circleCircle(c1: CircleGeom, c2: CircleGeom, eps: number): Vec2[] {
  const d = dist(c1.centre, c2.centre);
  if (d < eps) return []; // concentric
  if (d > c1.radius + c2.radius + eps) return [];
  if (d < Math.abs(c1.radius - c2.radius) - eps) return [];
  const a = (c1.radius * c1.radius - c2.radius * c2.radius + d * d) / (2 * d);
  const h2 = c1.radius * c1.radius - a * a;
  const ux = (c2.centre.x - c1.centre.x) / d;
  const uy = (c2.centre.y - c1.centre.y) / d;
  const mx = c1.centre.x + a * ux;
  const my = c1.centre.y + a * uy;
  if (h2 < eps) return [{ x: mx, y: my }]; // tangent, merged
  const h = Math.sqrt(Math.max(h2, 0));
  return [
    { x: mx + h * -uy, y: my + h * ux },
    { x: mx - h * -uy, y: my - h * ux },
  ];
}

/** Nearest point on an entity's curve to `p`, with its param. */
export function projectOntoEntity(doc: Doc, entity: Entity, p: Vec2, cache?: Map<PointId, Vec2>): { point: Vec2; param: number; d: number } {
  const g = resolveEntityGeom(doc, entity, cache);
  if (g.kind === 'circle') {
    const dir = normalize(sub(p, g.centre));
    const angle = Math.atan2(dir.y, dir.x);
    const point = { x: g.centre.x + g.radius * Math.cos(angle), y: g.centre.y + g.radius * Math.sin(angle) };
    return { point, param: angle, d: dist(p, point) };
  }
  const ab = sub(g.b, g.a);
  const abLen = len(ab);
  const t = abLen < 1e-9 ? 0 : ((p.x - g.a.x) * ab.x + (p.y - g.a.y) * ab.y) / (abLen * abLen);
  const point = { x: g.a.x + ab.x * t, y: g.a.y + ab.y * t };
  return { point, param: t, d: dist(p, point) };
}

export function allEntityPairs(entities: Entity[]): [Entity, Entity][] {
  const pairs: [Entity, Entity][] = [];
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      pairs.push([entities[i]!, entities[j]!]);
    }
  }
  return pairs;
}

export function pairKey(a: EntityId, b: EntityId): [EntityId, EntityId] {
  return a < b ? [a, b] : [b, a];
}
