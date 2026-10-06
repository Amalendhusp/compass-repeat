// Phase 5: the Repeat lattice — pure math, no rendering or interaction state. A motif copy's
// "pose" is a rigid transform (translate + rotate + optional mirror) built from a lattice index
// (i, j) plus the current RepeatSystem — the SAME pose function drives rendering, hit-testing and
// contact-detent search, so nothing can disagree about where a given copy actually sits.

import type { Doc, FrameKind, RepeatSystem, Vec2 } from '../model/types.ts';
import type { ViewTransform } from '../app/controller.ts';
import { screenToWorld, worldToScreen } from '../app/controller.ts';
import { computeFairRegions } from './regions.ts';
import { resolveEntityGeom } from './kernel.ts';
import { deriveSegments } from './segments.ts';

/** Phase 5.1 item 10: Triangle and Hexagon are separate choices in the UI but share one 60°
 * lattice underneath — they differ only in how the grid presents that lattice (see
 * render/repeatRenderer.ts's drawLatticeGrid). */
export type LatticeFamily = 'square' | 'triangle' | 'hex';

export function isSixtyDegreeFamily(family: RepeatSystem['family']): boolean {
  return family === 'triangle' || family === 'hex';
}

/** Phase 5 item 2: the frame only ever suggests — never forces — an initial lattice family. */
export function suggestedFamily(frameKind: FrameKind): LatticeFamily {
  switch (frameKind) {
    case 'square':
      return 'square';
    case 'hexagon':
      return 'hex';
    case 'triangle':
      return 'triangle';
    case 'circle':
      return 'square'; // no strong preference — a neutral, still fully user-changeable default
  }
}

/** The frame's own circumradius — used throughout as "how big is one motif" for default
 * spacing, viewport margins and contact-detent geometry (spec item 1: "the frame may be used
 * internally to determine motif bounds"). */
export function motifRadius(doc: Doc): number {
  return Math.max(doc.frame.radius, 1e-6);
}

/** Phase 5 item 2: a first, comfortable, non-overlapping spacing — not a precise tangency, just
 * enough that "this is my motif, and I can see there's room for a neighbour" reads immediately.
 * The user drags from here; nothing about this needs to be exact. */
export function defaultLatticeVectors(doc: Doc, family: LatticeFamily): { a: Vec2; b: Vec2 } {
  const spacing = motifRadius(doc) * 2.25;
  if (family === 'square') {
    return { a: { x: spacing, y: 0 }, b: { x: 0, y: spacing } };
  }
  // triangle/hex: one shared 60° basis (spec item 2's note).
  const angle = Math.PI / 3;
  return { a: { x: spacing, y: 0 }, b: { x: spacing * Math.cos(angle), y: spacing * Math.sin(angle) } };
}

/** True once the participant has entered Repeat at least once for this document — `family`
 * starts `undefined` (types.ts) and is set the first time defaults are populated, so a frame
 * changed later never silently re-suggests over a choice already made. */
export function repeatIsConfigured(repeat: RepeatSystem): boolean {
  return repeat.family !== undefined;
}

/** Phase 5 item 2: populates a first-time-only suggested family + comfortable spacing, mutating
 * `doc` directly rather than through commit() — this is view/setup, not a content edit the
 * participant made (same reasoning as `view`'s own direct-mutation pattern), and it only ever
 * runs once (`repeatIsConfigured` guards it) so a frame change afterward never overwrites a
 * choice already made. Lives here (not model/doc.ts) to avoid a circular import: this module
 * already depends on app/controller.ts for ViewTransform, which itself depends on model/doc.ts. */
export function ensureRepeatDefaults(doc: Doc): void {
  if (repeatIsConfigured(doc.repeat)) return;
  const family = suggestedFamily(doc.frame.kind);
  const { a, b } = defaultLatticeVectors(doc, family);
  doc.repeat.family = family;
  doc.repeat.a = a;
  doc.repeat.b = b;
}

export interface InstancePose {
  i: number;
  j: number;
  translate: Vec2;
  rotation: number; // radians, base motif rotation + this instance's orientation-rule rotation
  mirror: boolean;
}

function parity(i: number, j: number): 0 | 1 {
  return (((i + j) % 2) + 2) % 2 === 0 ? 0 : 1;
}

/** Phase 5 item 8: the orientation rule is a property of the REPETITION, not something applied
 * tile-by-tile — every instance's extra rotation/mirror is a pure function of its own (i, j), so
 * the whole field stays mathematically consistent (and seamless under pan — item 9) with no
 * special-casing at any boundary. */
function ruleAdjustment(rule: RepeatSystem['rule'], i: number, j: number): { rotation: number; mirror: boolean } {
  if (i === 0 && j === 0) return { rotation: 0, mirror: false }; // the reference instance is always plain
  switch (rule.kind) {
    case 'alternate':
      return { rotation: parity(i, j) === 1 ? Math.PI : 0, mirror: false };
    case 'mirror':
      return { rotation: 0, mirror: parity(i, j) === 1 };
    case 'same':
    case 'around':
    default:
      return { rotation: 0, mirror: false };
  }
}

export function instancePose(repeat: RepeatSystem, i: number, j: number): InstancePose {
  const adj = ruleAdjustment(repeat.rule, i, j);
  return {
    i,
    j,
    translate: { x: repeat.a.x * i + repeat.b.x * j, y: repeat.a.y * i + repeat.b.y * j },
    rotation: repeat.motif.rotation + adj.rotation,
    mirror: adj.mirror,
  };
}

/** Maps a point in the ORIGINAL Construct-world onto where it sits for one repeat instance —
 * mirror (reflect across the pivot's local x-axis) applies before rotation, matching the angle
 * convention `poseArcAngles` below relies on. */
export function transformPoint(pivot: Vec2, pose: InstancePose, p: Vec2): Vec2 {
  let lx = p.x - pivot.x;
  let ly = p.y - pivot.y;
  if (pose.mirror) ly = -ly;
  const cos = Math.cos(pose.rotation);
  const sin = Math.sin(pose.rotation);
  const rx = lx * cos - ly * sin;
  const ry = lx * sin + ly * cos;
  return { x: rx + pivot.x + pose.translate.x, y: ry + pivot.y + pose.translate.y };
}

/** Phase 5 item 12/curved-boundary fidelity: rotation/mirror are rigid (angle-preserving up to
 * sign), so an arc's own start/end angle transforms directly — no re-sampling needed to draw a
 * transformed arc exactly. Mirroring reverses the sweep direction (spec: preserve continuity, not
 * approximate it), which is why the caller must pass `mirror` as Canvas's own anticlockwise flag.
 */
export function poseArcAngle(pose: InstancePose, worldAngle: number): number {
  return pose.mirror ? pose.rotation - worldAngle : pose.rotation + worldAngle;
}

const MAX_INSTANCES = 400; // a hard safety cap — never render/iterate more than this per frame

/** Phase 5 items 9/10: every (i, j) whose motif bound could touch the visible viewport (plus a
 * margin for the motif's own radius) — generated from the viewport itself, so pan/zoom reveals
 * more copies naturally and nothing needs to be pre-baked for "infinite" extent. */
export function visibleInstances(doc: Doc, view: ViewTransform): InstancePose[] {
  const reach = motifExtent(doc);
  const range = visibleLatticeRange(doc, view, reach);
  if (!range) return [instancePose(doc.repeat, 0, 0)]; // degenerate basis — just the reference
  const { i0, i1, j0, j1 } = range;
  const pivot = doc.frame.origin;
  const reachPx = reach * view.zoom;
  const out: InstancePose[] = [];
  // Phase 5.3: the (i, j) box of a skewed lattice is far larger than the screen it covers — keep
  // only copies whose drawn extent actually touches the viewport BEFORE the safety cap, so the
  // cap can never drop a copy that is really on screen (it used to, zoomed far out).
  outer: for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const pose = instancePose(doc.repeat, i, j);
      const s = worldToScreen(view, { x: pivot.x + pose.translate.x, y: pivot.y + pose.translate.y });
      if (s.x < -reachPx || s.x > view.w + reachPx || s.y < -reachPx || s.y > view.h + reachPx) continue;
      out.push(pose);
      if (out.length >= MAX_INSTANCES) break outer;
    }
  }
  return out;
}

const extentCache = new WeakMap<Doc, number>();

/** How far the motif's drawn artwork actually reaches from its pivot — Fair strokes and fills can
 * extend well past the frame (a petal circle centred on the frame's rim reaches twice its radius).
 * Never less than the frame itself. Cached per Doc (a new Doc on every commit). */
export function motifExtent(doc: Doc): number {
  const cached = extentCache.get(doc);
  if (cached !== undefined) return cached;
  const pivot = doc.frame.origin;
  let reach = motifRadius(doc);
  const far = (p: Vec2) => (reach = Math.max(reach, Math.hypot(p.x - pivot.x, p.y - pivot.y)));
  for (const e of doc.entities) {
    const fair = deriveSegments(doc, e).some((seg) => doc.segmentStates.get(seg.key)?.state === 'fair');
    if (!fair) continue;
    const g = resolveEntityGeom(doc, e);
    if (g.kind === 'circle') reach = Math.max(reach, Math.hypot(g.centre.x - pivot.x, g.centre.y - pivot.y) + g.radius);
    else {
      far(g.a);
      far(g.b);
    }
  }
  for (const r of computeFairRegions(doc)) for (const p of r.samplePoints) far(p);
  extentCache.set(doc, reach * 1.02);
  return reach * 1.02;
}

export interface LatticeRange {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

/** The integer (i, j) box whose lattice points cover the viewport plus `marginWorld` — shared by
 * instancing and the Grid overlay so both always agree on the same translations. Null for a
 * degenerate (collinear) basis. */
export function visibleLatticeRange(doc: Doc, view: ViewTransform, marginWorld: number): LatticeRange | null {
  const { a, b } = doc.repeat;
  const det = a.x * b.y - a.y * b.x;
  if (Math.abs(det) < 1e-9) return null;

  const pivot = doc.frame.origin;
  const margin = marginWorld * view.zoom; // screen px
  const corners: Vec2[] = [
    screenToWorld(view, { x: -margin, y: -margin }),
    screenToWorld(view, { x: view.w + margin, y: -margin }),
    screenToWorld(view, { x: -margin, y: view.h + margin }),
    screenToWorld(view, { x: view.w + margin, y: view.h + margin }),
  ];

  let iMin = Infinity;
  let iMax = -Infinity;
  let jMin = Infinity;
  let jMax = -Infinity;
  for (const c of corners) {
    const dx = c.x - pivot.x;
    const dy = c.y - pivot.y;
    const i = (dx * b.y - dy * b.x) / det;
    const j = (a.x * dy - a.y * dx) / det;
    iMin = Math.min(iMin, i);
    iMax = Math.max(iMax, i);
    jMin = Math.min(jMin, j);
    jMax = Math.max(jMax, j);
  }
  const pad = 1; // one extra ring so a motif's own extent past its lattice point is still covered
  return {
    i0: Math.floor(iMin) - pad,
    i1: Math.ceil(iMax) + pad,
    j0: Math.floor(jMin) - pad,
    j1: Math.ceil(jMax) + pad,
  };
}

/** Phase 5 item 13: Fit should read as a tessellation, not one tiny motif — a fixed small
 * neighbourhood (3×3: the reference plus its ring of immediate neighbours) regardless of
 * viewport size, and never based on the lattice's own (unbounded) extent. */
export function fitInstances(doc: Doc): InstancePose[] {
  const out: InstancePose[] = [];
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) out.push(instancePose(doc.repeat, i, j));
  return out;
}

/** Phase 5 item 2: the FIRST-entry view — deliberately tighter than Fit's own 3×3 tessellation
 * sample (fitBounds, below). This is "here is my motif, with room to see a neighbour," not "here
 * is the pattern" — showing only the reference plus a comfortable margin so the lattice-arm
 * handles have room to be dragged, never flooding the screen with a full field on first look. */
export function firstEntryBounds(doc: Doc): { minX: number; minY: number; maxX: number; maxY: number } {
  const pivot = doc.frame.origin;
  const r = motifRadius(doc) * 1.8; // the reference motif plus a peek of the handle direction — not a whole neighbour ring
  return { minX: pivot.x - r, maxX: pivot.x + r, minY: pivot.y - r, maxY: pivot.y + r };
}

/** Phase 5 item 13: the world-space bounds of the Fit sample (item 13's 3×3 field) — every
 * instance's own frame extent, transformed. Used by main.ts's fitRepeatView the same way
 * geometry/bounds.ts's computeVisibleBounds feeds Construct's Fit. */
export function fitBounds(doc: Doc): { minX: number; minY: number; maxX: number; maxY: number } {
  const pivot = doc.frame.origin;
  const r = motifRadius(doc);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pose of fitInstances(doc)) {
    const cx = pivot.x + pose.translate.x;
    const cy = pivot.y + pose.translate.y;
    minX = Math.min(minX, cx - r);
    maxX = Math.max(maxX, cx + r);
    minY = Math.min(minY, cy - r);
    maxY = Math.max(maxY, cy + r);
  }
  return { minX, minY, maxX, maxY };
}

// ---- Contact detents (item 6): computed from the frame's own real shape where possible ----

export type ContactState = 'overlap' | 'edges-meet' | 'tips-touch' | 'gap';

/** Which lattice neighbour a handle drags: `a` moves instance (1, 0), `b` moves (0, 1). */
function neighbourPose(repeat: RepeatSystem, dir: 'a' | 'b'): InstancePose {
  return dir === 'a' ? instancePose(repeat, 1, 0) : instancePose(repeat, 0, 1);
}

/** The frame polygon exactly as drawn for `pose` (motif rotation and orientation rule applied),
 * relative to the pivot with the pose's own translation left out. Phase 5.1: Phase 5 used the
 * unrotated frame here, so a rotated motif (or an Alternate/Mirror neighbour) was tested against
 * a boundary that no longer matched the one on screen. */
function posedPolygon(doc: Doc, pose: InstancePose): Vec2[] {
  const pivot = doc.frame.origin;
  const orientOnly: InstancePose = { ...pose, translate: { x: 0, y: 0 } };
  const n = doc.frame.kind === 'square' ? 4 : doc.frame.kind === 'hexagon' ? 6 : 3;
  const pts: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const angle = doc.frame.rotation + (k / n) * Math.PI * 2;
    const local = { x: pivot.x + doc.frame.radius * Math.cos(angle), y: pivot.y + doc.frame.radius * Math.sin(angle) };
    const p = transformPoint(pivot, orientOnly, local);
    pts.push({ x: p.x - pivot.x, y: p.y - pivot.y });
  }
  return pts;
}

function segPointDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Unit normals of a convex polygon's edges — the candidate separating axes. */
function axesOf(poly: Vec2[]): Vec2[] {
  const axes: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > 1e-12) axes.push({ x: -(b.y - a.y) / len, y: (b.x - a.x) / len });
  }
  return axes;
}

function projectOnto(poly: Vec2[], n: Vec2): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of poly) {
    const d = p.x * n.x + p.y * n.y;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}

/** vNext Phase 1: how deeply two convex polygons overlap (separating-axis theorem) — the smallest
 * overlap of their projections over every edge normal: positive = overlapping by that much, zero =
 * exactly touching, negative = apart. Exact for touching shapes, where the old point-in-polygon
 * test was ambiguous (and contact had to be faked a hair outside). Repeat frames — triangle, square,
 * hexagon, rotated or mirrored — are always convex. */
function penetration(polyA: Vec2[], polyB: Vec2[]): number {
  let depth = Infinity;
  for (const n of [...axesOf(polyA), ...axesOf(polyB)]) {
    const [a0, a1] = projectOnto(polyA, n);
    const [b0, b1] = projectOnto(polyB, n);
    depth = Math.min(depth, Math.min(a1, b1) - Math.max(a0, b0));
  }
  return depth;
}

/** Minimum distance between two convex polygon boundaries (0 or negative-equivalent handled by
 * the overlap check first), plus how many near-coincident vertex pairs sit at that minimum — two
 * or more means a shared edge (`edges-meet`); exactly one means a single corner (`tips-touch`). */
function polygonContactAnalysis(polyA: Vec2[], polyB: Vec2[]): { distance: number; sharedVertexPairs: number } {
  let min = Infinity;
  for (const p of polyA) for (const q of polyB) min = Math.min(min, Math.hypot(p.x - q.x, p.y - q.y));
  for (let i = 0; i < polyA.length; i++) {
    const a1 = polyA[i]!;
    const a2 = polyA[(i + 1) % polyA.length]!;
    for (const q of polyB) min = Math.min(min, segPointDistance(q, a1, a2));
  }
  for (let j = 0; j < polyB.length; j++) {
    const b1 = polyB[j]!;
    const b2 = polyB[(j + 1) % polyB.length]!;
    for (const p of polyA) min = Math.min(min, segPointDistance(p, b1, b2));
  }
  let sharedVertexPairs = 0;
  const nearEps = Math.max(min * 4, motifRadiusEpsilonFallback);
  for (const p of polyA) for (const q of polyB) if (Math.hypot(p.x - q.x, p.y - q.y) <= Math.max(min + nearEps, nearEps)) sharedVertexPairs++;
  return { distance: min, sharedVertexPairs };
}
const motifRadiusEpsilonFallback = 1e-3;

export interface ContactDetent {
  translate: Vec2;
  state: 'edges-meet' | 'tips-touch';
}

/**
 * Phase 5.1: everything a neighbour-drag needs about contact, prepared once when the drag begins
 * (the poses can't change mid-drag — only the translation does).
 * - `classify` is Phase 5's contact classification, unchanged apart from using posed polygons.
 * - `contactDistance(unit)` is how far along a direction the neighbour first stops overlapping
 *   the reference: the "touching" contour a drag can slide along.
 * - `detents` are the exact placements worth landing on: whole edges coinciding (edges meet) and
 *   corner-to-corner touches (tips touch). A circle frame has only its tangency contour.
 */
export interface ContactModel {
  classify(translate: Vec2): ContactState;
  contactDistance(unit: Vec2): number;
  detents: ContactDetent[];
}

export function contactModel(doc: Doc, dir: 'a' | 'b'): ContactModel {
  const R = motifRadius(doc);
  const snapEps = R * 0.03;

  if (doc.frame.kind === 'circle') {
    const twoR = doc.frame.radius * 2;
    return {
      classify(t) {
        const d = Math.hypot(t.x, t.y);
        if (d < twoR - snapEps) return 'overlap';
        if (Math.abs(d - twoR) <= snapEps) return 'tips-touch'; // two circles touch at one point
        return 'gap';
      },
      contactDistance: () => twoR,
      detents: [],
    };
  }

  const polyA = posedPolygon(doc, instancePose(doc.repeat, 0, 0));
  const baseB = posedPolygon(doc, neighbourPose(doc.repeat, dir));

  // Overlapping by more than rounding: a real overlap. Exactly touching is contact.
  const overlapEps = R * 1e-9;
  const classify = (t: Vec2): ContactState => {
    const polyB = baseB.map((p) => ({ x: p.x + t.x, y: p.y + t.y }));
    if (penetration(polyA, polyB) > overlapEps) return 'overlap';
    const { distance, sharedVertexPairs } = polygonContactAnalysis(polyA, polyB);
    if (distance > snapEps) return 'gap';
    return sharedVertexPairs >= 2 ? 'edges-meet' : 'tips-touch';
  };

  // Exactly where, along a direction, the neighbour stops overlapping the reference: for each
  // separating axis, the distance at which the two projections stop overlapping; convex shapes
  // are apart as soon as any one axis separates them, so contact is the smallest of these.
  const axes = [...axesOf(polyA), ...axesOf(baseB)];
  const contactDistance = (unit: Vec2): number => {
    let best = Infinity;
    for (const n of axes) {
      const k = unit.x * n.x + unit.y * n.y;
      if (Math.abs(k) < 1e-12) continue;
      const [a0, a1] = projectOnto(polyA, n);
      const [b0, b1] = projectOnto(baseB, n);
      const s = k > 0 ? (a1 - b0) / k : (a0 - b1) / k;
      if (s > 0 && s < best) best = s;
    }
    return Number.isFinite(best) ? best : R * 2;
  };

  const detents: ContactDetent[] = [];
  const nA = polyA.length;
  const nB = baseB.length;
  for (let i = 0; i < nA; i++) {
    const p1 = polyA[i]!;
    const p2 = polyA[(i + 1) % nA]!;
    for (let j = 0; j < nB; j++) {
      const q1 = baseB[j]!;
      const q2 = baseB[(j + 1) % nB]!;
      // Antiparallel, equal-length edges can lie exactly along one another.
      if (Math.hypot(p2.x - p1.x + (q2.x - q1.x), p2.y - p1.y + (q2.y - q1.y)) > R * 1e-3) continue;
      const t = { x: p1.x - q2.x, y: p1.y - q2.y };
      if (classify(t) === 'edges-meet') detents.push({ translate: t, state: 'edges-meet' });
    }
  }
  for (const p of polyA) {
    for (const q of baseB) {
      const t = { x: p.x - q.x, y: p.y - q.y };
      if (detents.some((d) => Math.hypot(d.translate.x - t.x, d.translate.y - t.y) < R * 0.01)) continue;
      if (classify(t) === 'tips-touch') detents.push({ translate: t, state: 'tips-touch' });
    }
  }

  return { classify, contactDistance, detents };
}

/** Phase 5 item 6: classifies the translation between the reference motif and one neighbour —
 * real frame geometry (circle tangency, or polygon edge/vertex proximity). */
export function classifyContact(doc: Doc, translate: Vec2, dir: 'a' | 'b' = 'a'): ContactState {
  return contactModel(doc, dir).classify(translate);
}

// ---- Rotation (item 7) ----

const ROTATION_SNAP_FRACTIONS = [2, 3, 4, 6, 8, 12];
const ROTATION_SNAP_THRESHOLD = (3.5 * Math.PI) / 180; // ~3.5°, generous enough to find on a phone

/** Phase 5 item 7: snaps to the nearest offered fraction of a full turn only when already close
 * — free rotation stays free everywhere else. Returns the angle unchanged (not merely un-snapped
 * but literally untouched) when no fraction is close, so a continuous drag never jumps. */
export function snapRotation(angle: number): number {
  const twoPi = Math.PI * 2;
  const norm = ((angle % twoPi) + twoPi) % twoPi;
  let best: number | null = null;
  let bestDelta = Infinity;
  for (const n of ROTATION_SNAP_FRACTIONS) {
    for (let k = 0; k < n; k++) {
      const target = (k / n) * twoPi;
      const delta = Math.min(Math.abs(norm - target), twoPi - Math.abs(norm - target));
      if (delta < bestDelta) {
        bestDelta = delta;
        best = target;
      }
    }
  }
  if (best === null || bestDelta > ROTATION_SNAP_THRESHOLD) return angle;
  // Preserve how many full turns the drag has already wound past, so snapping never jumps
  // backwards across a wrap boundary mid-gesture.
  return angle - norm + best;
}
