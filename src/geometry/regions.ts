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
import { epsilon, resolveEntityGeom, resolvePoint } from './kernel.ts';
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
  legacySig: FaceSig;
}

interface HalfEdge {
  seg: DerivedSegment;
  entity: Entity;
  forward: boolean; // true: seg.from -> seg.to; false: seg.to -> seg.from
  from: PointId;
  to: PointId;
  angle: number; // outgoing tangent angle AT `from`
  /** Signed curvature as it leaves `from` (+ turning towards increasing angle, − the other way, 0
   * for a line) — only consulted to order two edges that leave a vertex in the same direction. */
  curvature: number;
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

function rotateToMin(parts: string[]): string[] {
  let minIdx = 0;
  for (let i = 1; i < parts.length; i++) if (parts[i]! < parts[minIdx]!) minIdx = i;
  return [...parts.slice(minIdx), ...parts.slice(0, minIdx)];
}

/**
 * Phase 5.4 items 9–12: a region's identity is its CORNERS and the curves running between them —
 * not every point that happens to lie along those curves. A boundary vertex is a corner only
 * where the boundary changes curve (a different entity, or the same one traversed the other way).
 * So a new intersection, midpoint or division point landing on an unchanged Fair curve is not a
 * corner and leaves the identity — and its Fill — untouched, while a genuine change (a new Fair
 * edge splitting the region, a boundary opening, a different curve) changes it, and the old Fill
 * is conservatively left behind rather than guessed onto a new region. Corner + (curve, direction)
 * pins down one face exactly: between two corners, a given curve traversed a given way is one
 * specific arc or line piece. A boundary that is one closed curve (a whole Fair circle) has no
 * corners and is identified by that curve alone.
 */
function computeFaceSig(boundary: HalfEdge[]): FaceSig {
  const side = (he: HalfEdge) => `${he.entity.id}${he.forward ? '+' : '-'}`;
  const n = boundary.length;
  const corners: string[] = [];
  for (let i = 0; i < n; i++) {
    const prev = boundary[(i - 1 + n) % n]!;
    const cur = boundary[i]!;
    if (side(prev) !== side(cur)) corners.push(`${cur.from}~${side(cur)}`);
  }
  if (corners.length === 0) return `loop~${side(boundary[0]!)}`;
  return rotateToMin(corners).join('>');
}

/** The signature Fills were keyed by before Phase 5.4 (every boundary vertex) — kept only so a
 * document saved earlier can have its Fills re-keyed on load (migrateLegacyFillKeys). */
function legacyFaceSig(boundary: HalfEdge[]): FaceSig {
  return rotateToMin(boundary.map((he) => he.from)).join('>');
}

type SegmentStateKind = 'construction' | 'extension' | 'fair' | 'trimmed';

/** Phase 5.2 item 9: the same face trace over whichever segment states count as boundary —
 * Fair only for Fill (Phase 4, unchanged), Construction/Extension only for selecting a closed
 * Construction region by tapping inside it. */
// Tangent points come from intersections computed to a small epsilon, so two genuinely tangent
// directions can differ by rounding noise; nothing distinct is ever this close.
const ANGLE_TIE = 1e-6;

/** A tangent angle in [−π, π), so an edge pointing exactly "west" can't appear at both ends of
 * the sorted list depending on rounding. */
function canonicalAngle(v: Vec2): number {
  const a = Math.atan2(v.y, v.x);
  return a >= Math.PI - ANGLE_TIE ? -Math.PI : a;
}

/** Around a vertex, in increasing angle; two edges leaving in the same direction (tangent curves)
 * are ordered by how they bend away — the one curving towards increasing angle comes later —
 * rather than by chance, which could trace a face straight through its neighbour. */
function compareAroundVertex(a: HalfEdge, b: HalfEdge): number {
  const d = a.angle - b.angle;
  if (Math.abs(d) > ANGLE_TIE) return d;
  return a.curvature - b.curvature;
}

function buildRegions(doc: Doc, isBoundary: (state: SegmentStateKind) => boolean): FairRegion[] {
  const halfEdgesAtVertex = new Map<PointId, HalfEdge[]>();
  const allHalfEdges: HalfEdge[] = [];
  // Phase 5.5 item 1: the same edge drawn twice (a Line over an existing line, the same circle
  // placed twice, or collinear lines overlapping — each is split where the other's end lies on
  // it) must count once. Two copies leave every shared vertex at exactly the same angle, and the
  // trace then ran through the doubled edge and merged the faces on either side into one region —
  // filling one filled its neighbour too. The first copy (in entity order, so stable) is kept.
  const geomTol = epsilon(doc) * 1000;
  const q = (v: number) => Math.round(v / geomTol);
  const seenEdges = new Set<string>();

  for (const entity of doc.entities) {
    const g = resolveEntityGeom(doc, entity);
    for (const seg of deriveSegments(doc, entity)) {
      if (!isBoundary(doc.segmentStates.get(seg.key)?.state ?? 'construction')) continue;
      const edgeId =
        g.kind === 'line'
          ? `L:${[seg.from, seg.to].sort().join('|')}`
          : `C:${seg.from}|${seg.to}|${q(g.centre.x)}|${q(g.centre.y)}|${q(g.radius)}`; // from→to is always counter-clockwise on its circle
      if (seenEdges.has(edgeId)) continue;
      seenEdges.add(edgeId);
      const k = g.kind === 'circle' ? 1 / Math.max(g.radius, 1e-12) : 0;
      const heF: HalfEdge = { seg, entity, forward: true, from: seg.from, to: seg.to, angle: 0, curvature: k, twin: null, used: false };
      const heB: HalfEdge = { seg, entity, forward: false, from: seg.to, to: seg.from, angle: 0, curvature: -k, twin: null, used: false };
      heF.twin = heB;
      heB.twin = heF;
      heF.angle = canonicalAngle(outgoingTangent(doc, entity, seg, seg.from));
      heB.angle = canonicalAngle(outgoingTangent(doc, entity, seg, seg.to));
      allHalfEdges.push(heF, heB);
      (halfEdgesAtVertex.get(heF.from) ?? halfEdgesAtVertex.set(heF.from, []).get(heF.from)!).push(heF);
      (halfEdgesAtVertex.get(heB.from) ?? halfEdgesAtVertex.set(heB.from, []).get(heB.from)!).push(heB);
    }
  }
  for (const list of halfEdgesAtVertex.values()) list.sort(compareAroundVertex);

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
    regions.push({ sig: computeFaceSig(boundary), legacySig: legacyFaceSig(boundary), keys, samplePoints: pts, areaWorld: area, centroid: polygonCentroid(pts, area) });
  }
  return regions;
}

type RegionCache = WeakMap<Doc, { pointCount: number; entityCount: number; regions: FairRegion[] }>;
const perDocRegionCache: RegionCache = new WeakMap();
const perDocConstructionRegionCache: RegionCache = new WeakMap();

function cachedRegions(cache: RegionCache, doc: Doc, isBoundary: (state: SegmentStateKind) => boolean): FairRegion[] {
  let rec = cache.get(doc);
  if (!rec || rec.pointCount !== doc.points.length || rec.entityCount !== doc.entities.length) {
    rec = { pointCount: doc.points.length, entityCount: doc.entities.length, regions: buildRegions(doc, isBoundary) };
    cache.set(doc, rec);
  }
  return rec.regions;
}

/** Phase 5.2: see kernel.ts's invalidateResolveCache. */
export function invalidateRegionCaches(doc: Doc): void {
  perDocRegionCache.delete(doc);
  perDocConstructionRegionCache.delete(doc);
}

/** Phase 4 item 15: Doc objects are only replaced wholesale by cloneDoc() on commit/undo/redo
 * (Fair promotion/Trim/Delete all go through commit()) — pan/zoom, Point Targets and Select's
 * filter mutate other fields directly on the SAME Doc, so they never invalidate this cache (item
 * 13: switching Primary/Derived must not alter an existing region). Region topology is computed
 * once per real geometry commit, not once per render frame or pointer move. */
export function computeFairRegions(doc: Doc): FairRegion[] {
  return cachedRegions(perDocRegionCache, doc, (state) => state === 'fair');
}

/** Phase 5.2 item 9: closed faces bounded by Construction/Extension geometry. Same caveat as Fair
 * regions about state-only changes: Fair promotion/Trim always arrive via commit (a new Doc). */
export function computeConstructionRegions(doc: Doc): FairRegion[] {
  return cachedRegions(perDocConstructionRegionCache, doc, (state) => state === 'construction' || state === 'extension');
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

/** Phase 5.4: Fills saved under the pre-5.4 signature are re-keyed to the region's current
 * signature. Only keys that match no current region but do match one region's old-style
 * signature move — anything else is left exactly as it was. Returns true if anything changed. */
export function migrateLegacyFillKeys(doc: Doc): boolean {
  const regions = computeFairRegions(doc);
  const current = new Set(regions.map((r) => r.sig));
  const byLegacy = new Map(regions.map((r) => [r.legacySig, r.sig] as const));
  let changed = false;
  for (const fills of doc.fills.values()) {
    for (const [key, colour] of [...fills]) {
      const next = byLegacy.get(key);
      if (current.has(key) || !next || fills.has(next)) continue;
      fills.delete(key);
      fills.set(next, colour);
      changed = true;
    }
  }
  return changed;
}
