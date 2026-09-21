// Phase 4: planar face detection over Fair/design geometry only — Fill's whole topology model.
// Construction/Extension segments never contribute edges here (spec item 1: they "remain guides
// only" and must not subdivide a Fair region unless promoted). This is a standard planar
// straight-line-graph face trace (the same algorithm CAD/GIS "polygonize" operations use): every
// Fair granular segment becomes two directed half-edges; at each vertex, the half-edges are
// angle-sorted by their outgoing tangent; tracing "the next half-edge immediately before this
// edge's twin, in angle order" around a graph walks out one closed face at a time. Faces traced
// with negative signed area are the unbounded/outer side of each connected Fair sub-graph and are
// discarded; the rest are genuine fillable regions — including correctly-nested ones, since a
// disjoint inner boundary's own outer trace is simply its own separate positive-area face (see
// findRegionAt's smallest-first containment pick, and computeDirectHoles for rendering).

import type { Doc, Entity, FaceSig, PointId, SegmentKey, Vec2 } from '../model/types.ts';
import { resolveEntityGeom, resolvePoint } from './kernel.ts';
import { deriveSegments, type DerivedSegment } from './segments.ts';
import { outgoingTangent } from './trace.ts';

export interface FairRegion {
  sig: FaceSig;
  /** Every granular Fair segment key forming this region's boundary — used only to check "does
   * this region's boundary still exist" when a fill's target segment is trimmed/demoted. */
  keys: Set<SegmentKey>;
  /** World-space, densely sampled (arcs included), closed loop — first point not repeated. The
   * one shape used for area/centroid, point-in-region hit-testing, hole containment, AND
   * rendering (Phase 4 item 12: sampled finely enough that curved boundaries stay geometrically
   * faithful, not chord-approximated away). */
  samplePoints: Vec2[];
  areaWorld: number;
  centroid: Vec2;
}

interface HalfEdge {
  seg: DerivedSegment;
  entity: Entity;
  forward: boolean; // true: seg.from -> seg.to; false: seg.to -> seg.from
  from: PointId;
  to: PointId;
  angle: number; // outgoing tangent angle AT `from`
  twin: HalfEdge | null;
  used: boolean;
}

const ARC_STEP_RAD = Math.PI / 48; // ~3.75°/sample — chord-vs-arc area error stays well under 0.1%

/** One half-edge's polyline in world space, in its own direction of travel. `includeStart`
 * controls whether `from`'s own point is included (false when it's already the previous edge's
 * endpoint in an assembled loop, to avoid a duplicate vertex). */
function sampleHalfEdge(doc: Doc, he: HalfEdge, includeStart: boolean): Vec2[] {
  const g = resolveEntityGeom(doc, he.entity);
  const pts: Vec2[] = [];
  if (g.kind === 'circle') {
    let a0 = he.seg.fromParam;
    let a1 = he.seg.toParam;
    if (a1 < a0) a1 += Math.PI * 2; // the DerivedSegment's own span always sweeps CCW a0->a1
    const steps = Math.max(1, Math.ceil((a1 - a0) / ARC_STEP_RAD));
    for (let i = includeStart ? 0 : 1; i <= steps; i++) {
      const t = he.forward ? a0 + (a1 - a0) * (i / steps) : a1 - (a1 - a0) * (i / steps);
      pts.push({ x: g.centre.x + g.radius * Math.cos(t), y: g.centre.y + g.radius * Math.sin(t) });
    }
  } else {
    const a = resolvePoint(doc, he.seg.from);
    const b = resolvePoint(doc, he.seg.to);
    const p0 = he.forward ? a : b;
    const p1 = he.forward ? b : a;
    if (includeStart) pts.push(p0);
    pts.push(p1);
  }
  return pts;
}

function polygonArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function polygonCentroid(pts: Vec2[], area: number): Vec2 {
  if (Math.abs(area) < 1e-12) {
    const n = Math.max(pts.length, 1);
    const sum = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: sum.x / n, y: sum.y / n };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    const cr = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * cr;
    cy += (p.y + q.y) * cr;
  }
  const k = 1 / (6 * area);
  return { x: cx * k, y: cy * k };
}

/** Standard ray-casting point-in-polygon — correct for any simple (possibly non-convex) closed
 * polyline, which is exactly what a densely-sampled curved region boundary is. */
export function pointInPolygon(poly: Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    const intersect = pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function computeFaceSig(boundary: HalfEdge[]): FaceSig {
  const ids = boundary.map((he) => he.from);
  let minIdx = 0;
  for (let i = 1; i < ids.length; i++) if (ids[i]! < ids[minIdx]!) minIdx = i;
  return [...ids.slice(minIdx), ...ids.slice(0, minIdx)].join('>');
}

function buildFairRegions(doc: Doc): FairRegion[] {
  const halfEdgesAtVertex = new Map<PointId, HalfEdge[]>();
  const allHalfEdges: HalfEdge[] = [];

  for (const entity of doc.entities) {
    for (const seg of deriveSegments(doc, entity)) {
      if ((doc.segmentStates.get(seg.key)?.state ?? 'construction') !== 'fair') continue;
      const heF: HalfEdge = { seg, entity, forward: true, from: seg.from, to: seg.to, angle: 0, twin: null, used: false };
      const heB: HalfEdge = { seg, entity, forward: false, from: seg.to, to: seg.from, angle: 0, twin: null, used: false };
      heF.twin = heB;
      heB.twin = heF;
      const tF = outgoingTangent(doc, entity, seg, seg.from);
      const tB = outgoingTangent(doc, entity, seg, seg.to);
      heF.angle = Math.atan2(tF.y, tF.x);
      heB.angle = Math.atan2(tB.y, tB.x);
      allHalfEdges.push(heF, heB);
      (halfEdgesAtVertex.get(heF.from) ?? halfEdgesAtVertex.set(heF.from, []).get(heF.from)!).push(heF);
      (halfEdgesAtVertex.get(heB.from) ?? halfEdgesAtVertex.set(heB.from, []).get(heB.from)!).push(heB);
    }
  }
  for (const list of halfEdgesAtVertex.values()) list.sort((a, b) => a.angle - b.angle);

  const regions: FairRegion[] = [];
  for (const start of allHalfEdges) {
    if (start.used) continue;
    const boundary: HalfEdge[] = [];
    let cur = start;
    let safety = allHalfEdges.length + 1;
    while (safety-- > 0) {
      cur.used = true;
      boundary.push(cur);
      const twin = cur.twin!;
      const list = halfEdgesAtVertex.get(cur.to)!;
      const idx = list.indexOf(twin);
      cur = list[(idx - 1 + list.length) % list.length]!;
      if (cur === start) break;
    }
    if (boundary.length < 2) continue; // a lone dangling edge's back-and-forth "face" — not a region

    const pts: Vec2[] = [];
    boundary.forEach((he, i) => pts.push(...sampleHalfEdge(doc, he, i === 0)));
    const area = polygonArea(pts);
    if (area <= 1e-9) continue; // the outer/unbounded trace of this Fair sub-graph — discard

    const keys = new Set<SegmentKey>(boundary.map((he) => he.seg.key));
    regions.push({ sig: computeFaceSig(boundary), keys, samplePoints: pts, areaWorld: area, centroid: polygonCentroid(pts, area) });
  }
  return regions;
}

const perDocRegionCache = new WeakMap<Doc, { pointCount: number; entityCount: number; regions: FairRegion[] }>();

/** Phase 4 item 15: Doc objects are only replaced wholesale by cloneDoc() on commit/undo/redo
 * (Fair promotion/Trim/Delete all go through commit()) — pan/zoom, Point Targets and Select's
 * filter mutate other fields directly on the SAME Doc, so they never invalidate this cache (item
 * 13: switching Primary/Derived must not alter an existing region). Region topology is computed
 * once per real geometry commit, not once per render frame or pointer move. */
export function computeFairRegions(doc: Doc): FairRegion[] {
  let rec = perDocRegionCache.get(doc);
  if (!rec || rec.pointCount !== doc.points.length || rec.entityCount !== doc.entities.length) {
    rec = { pointCount: doc.points.length, entityCount: doc.entities.length, regions: buildFairRegions(doc) };
    perDocRegionCache.set(doc, rec);
  }
  return rec.regions;
}

/** Phase 4 item 2/10: the smallest region whose boundary contains `worldPoint` — smallest-first
 * naturally resolves nested boundaries to the innermost enclosing region (an annulus tap never
 * matches the inner shape; an inner-shape tap matches it before ever considering the outer one). */
export function findRegionAt(regions: FairRegion[], worldPoint: Vec2): FairRegion | null {
  const sorted = [...regions].sort((a, b) => a.areaWorld - b.areaWorld);
  for (const r of sorted) {
    if (pointInPolygon(r.samplePoints, worldPoint)) return r;
  }
  return null;
}

/** Phase 4 item 10: each region's DIRECT hole regions only (a region nested two levels deep is
 * the hole of its immediate parent, not of that parent's own parent) — for rendering an outer
 * region's fill with its immediate children's areas correctly punched out (evenodd Path2D). */
export function computeDirectHoles(regions: FairRegion[]): Map<FaceSig, FairRegion[]> {
  const sorted = [...regions].sort((a, b) => a.areaWorld - b.areaWorld);
  const holesOf = new Map<FaceSig, FairRegion[]>();
  for (const outer of sorted) {
    const contained = sorted.filter((inner) => inner !== outer && inner.areaWorld < outer.areaWorld && pointInPolygon(outer.samplePoints, inner.centroid));
    const direct = contained.filter((inner) => !contained.some((mid) => mid !== inner && pointInPolygon(mid.samplePoints, inner.centroid)));
    holesOf.set(outer.sig, direct);
  }
  return holesOf;
}
