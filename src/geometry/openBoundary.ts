// Phase 5.4 items 5–8: why did Fill say "Open boundary", and where is the opening? Read-only —
// this never draws, snaps, closes or otherwise changes anything; it only points at the problem.
//
// The Fair network is split into connected pieces. What "almost surrounds" the tap is found by
// angular coverage: seen from the tap, how much of the full turn the curves span. A chain that
// would enclose the tap if its gap were closed covers nearly all of it; unrelated geometry off to
// one side covers little. The dangling ends (points where exactly one Fair piece stops) of the
// surrounding chain(s) are where the opening is. Construction-only crossings along the way (dense
// unrelated intersections) just subdivide Fair curves and never read as dangling.

import type { Doc, PointId, SegmentKey, Vec2 } from '../model/types.ts';
import { resolveEntityGeom, resolvePoint } from './kernel.ts';
import { deriveSegments } from './segments.ts';

export interface OpenBoundaryDiagnosis {
  /** The Fair chain around the tap that fails to close. */
  keys: SegmentKey[];
  /** Its likely open ends — two when there is one clear gap, otherwise the nearest few. */
  endpoints: PointId[];
}

const MIN_COVERAGE = Math.PI * 1.1; // must wrap more than about half-way round the tap
const MAX_ENDPOINTS = 6;
const MAX_CHAINS = 4;
const NEARLY_ALL_ROUND = Math.PI * 1.9;
const MIN_ADDED_COVERAGE = (5 * Math.PI) / 180;
const ARC_STEP = Math.PI / 24;

interface FairEdge {
  key: SegmentKey;
  from: PointId;
  to: PointId;
  samples: Vec2[];
}

function fairEdges(doc: Doc): FairEdge[] {
  const out: FairEdge[] = [];
  for (const e of doc.entities) {
    const g = resolveEntityGeom(doc, e);
    for (const seg of deriveSegments(doc, e)) {
      if (doc.segmentStates.get(seg.key)?.state !== 'fair') continue;
      const samples: Vec2[] = [];
      if (g.kind === 'circle') {
        let span = seg.toParam - seg.fromParam;
        if (span <= 0) span += Math.PI * 2;
        const steps = Math.max(2, Math.ceil(span / ARC_STEP));
        for (let i = 0; i <= steps; i++) {
          const t = seg.fromParam + (span * i) / steps;
          samples.push({ x: g.centre.x + g.radius * Math.cos(t), y: g.centre.y + g.radius * Math.sin(t) });
        }
      } else {
        const a = resolvePoint(doc, seg.from);
        const b = resolvePoint(doc, seg.to);
        for (let i = 0; i <= 6; i++) samples.push({ x: a.x + ((b.x - a.x) * i) / 6, y: a.y + ((b.y - a.y) * i) / 6 });
      }
      out.push({ key: seg.key, from: seg.from, to: seg.to, samples });
    }
  }
  return out;
}

/** How much of the full turn around `at` the given samples span (2π minus the largest empty gap). */
function angularCoverage(samples: Vec2[], at: Vec2): number {
  if (samples.length < 2) return 0;
  const angles = samples.map((p) => Math.atan2(p.y - at.y, p.x - at.x)).sort((a, b) => a - b);
  let largestGap = angles[0]! + Math.PI * 2 - angles[angles.length - 1]!;
  for (let i = 1; i < angles.length; i++) largestGap = Math.max(largestGap, angles[i]! - angles[i - 1]!);
  return Math.PI * 2 - largestGap;
}

export function diagnoseOpenBoundary(doc: Doc, at: Vec2, nearbyWorld: number): OpenBoundaryDiagnosis | null {
  const edges = fairEdges(doc);
  if (edges.length === 0) return null;

  const degree = new Map<PointId, number>();
  const parent = new Map<PointId, PointId>();
  const find = (p: PointId): PointId => {
    let r = p;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(p, r);
    return r;
  };
  for (const e of edges) {
    for (const p of [e.from, e.to]) {
      degree.set(p, (degree.get(p) ?? 0) + 1);
      if (!parent.has(p)) parent.set(p, p);
    }
    parent.set(find(e.from), find(e.to));
  }
  const dangling = [...degree].filter(([, d]) => d === 1).map(([p]) => p);
  if (dangling.length === 0) return null;

  const byDistance = (ids: PointId[]) => {
    const d = (id: PointId) => {
      const p = resolvePoint(doc, id);
      return Math.hypot(p.x - at.x, p.y - at.y);
    };
    return [...ids].sort((a, b) => d(a) - d(b));
  };

  // The open piece(s) that surround the tap. Several gaps break one boundary into several chains
  // (each ending at two different gaps), so chains are combined — widest first, each only if it
  // covers directions the others don't — until together they nearly wrap round the tap; every
  // loose end among them is then a candidate opening.
  const components = new Map<PointId, FairEdge[]>();
  for (const e of edges) {
    const root = find(e.from);
    (components.get(root) ?? components.set(root, []).get(root)!).push(e);
  }
  const open = [...components]
    .filter(([root]) => dangling.some((p) => find(p) === root))
    .map(([root, compEdges]) => {
      const samples = compEdges.flatMap((e) => e.samples);
      return { root, samples, coverage: angularCoverage(samples, at) };
    })
    .filter((c) => c.coverage > 0)
    .sort((a, b) => b.coverage - a.coverage);
  const chosen: PointId[] = [];
  let pooled: Vec2[] = [];
  let pooledCoverage = 0;
  for (const c of open) {
    if (chosen.length >= MAX_CHAINS || pooledCoverage >= NEARLY_ALL_ROUND) break;
    const next = [...pooled, ...c.samples];
    const nextCoverage = angularCoverage(next, at);
    if (chosen.length > 0 && nextCoverage - pooledCoverage < MIN_ADDED_COVERAGE) continue; // adds no new direction
    chosen.push(c.root);
    pooled = next;
    pooledCoverage = nextCoverage;
  }
  if (pooledCoverage >= MIN_COVERAGE) {
    const roots = new Set(chosen);
    return {
      keys: edges.filter((e) => roots.has(find(e.from))).map((e) => e.key),
      endpoints: byDistance(dangling.filter((p) => roots.has(find(p)))).slice(0, MAX_ENDPOINTS),
    };
  }

  // Nothing clearly surrounds the tap: point at the loose Fair ends closest to it, if any.
  const near = byDistance(dangling).filter((id) => {
    const p = resolvePoint(doc, id);
    return Math.hypot(p.x - at.x, p.y - at.y) <= nearbyWorld;
  });
  if (near.length === 0) return null;
  const roots = new Set(near.slice(0, MAX_ENDPOINTS).map(find));
  return { keys: edges.filter((e) => roots.has(find(e.from))).map((e) => e.key), endpoints: near.slice(0, MAX_ENDPOINTS) };
}
