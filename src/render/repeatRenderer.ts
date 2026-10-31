// Phase 5: the Repeat workspace's own render path — deliberately separate from render/renderer.ts
// (Construct's). Draws the repeated design — Fair strokes + fills; construction is never drawn here
// (Repeat is about the repeated design, not its scaffolding) — once per visible lattice instance, reusing Construct's already-cached segment/region derivation
// (item 19: never recompute motif topology per copy — only its placement changes per instance).
// Phase 5.1: everything Appearance and Grid/Guides control is applied here at draw time only —
// nothing in doc.repeatDisplay ever writes back into Fair/fill state.
//
// Repeat's source (geometry/repeatUnit.ts): at each lattice position stands the motif — or, from
// Intersect, the whole arrangement as one unit: every instance drawn as the motif is, placed by its
// own placement and then the lattice's. Within a unit, a Fair piece lying exactly on one an earlier
// instance already draws (same place, same stroke) is drawn once (unitSkips) — decided here, at
// draw time; the construction is never touched.

import { drawArtworkLayer, type ScreenLayers } from './underlay.ts';
import type { Doc, Entity, RepeatDisplay, RepeatSystem, SegmentState, Vec2 } from '../model/types.ts';
import type { AppController, ViewTransform } from '../app/controller.ts';
import { screenToWorld, worldToScreen } from '../app/controller.ts';
import { computeSpaces, spaceTranslations } from '../geometry/spaces.ts';
import { resolveEntityGeom } from '../geometry/kernel.ts';
import { deriveSegments, type DerivedSegment } from '../geometry/segments.ts';
import { computeDirectHoles, computeFairRegions, type FairRegion } from '../geometry/regions.ts';
import { effectiveDpr } from './canvasSetup.ts';
import {
  composePose,
  instancePose,
  motifExtent,
  motifRadius,
  poseArcAngle,
  transformPoint,
  visibleInstances,
  visibleLatticeRange,
  type InstancePose,
} from '../geometry/lattice.ts';
import { repeatUnit, type RepeatUnit } from '../geometry/repeatUnit.ts';
import { colouringInUse, patternGroup, regionColour, regionKey } from '../geometry/repeatColour.ts';
import { drawnLayers, type DrawnLayer } from '../geometry/repeatStroke.ts';
import { latticeShape } from '../geometry/latticeSnap.ts';
import { compositionFeatures } from '../geometry/repeatComposition.ts';
import { copyFeatures } from '../geometry/closeGap.ts';
import { placePrim, type Feature } from '../geometry/fairGeometry.ts';
import { copyShift, type LocalGap } from '../interaction/closeGapMode.ts';
import type { FaceSig, RepeatColouring } from '../model/types.ts';
import { color, stroke } from './tokens.ts';
import { makePath } from './svgContext.ts';
import type { ArtworkExport } from './renderer.ts';

function appendTransformedLoop(path: Path2D, view: ViewTransform, pivot: Vec2, pose: InstancePose, worldPts: Vec2[]): void {
  if (worldPts.length === 0) return;
  const first = worldToScreen(view, transformPoint(pivot, pose, worldPts[0]!));
  path.moveTo(first.x, first.y);
  for (let i = 1; i < worldPts.length; i++) {
    const s = worldToScreen(view, transformPoint(pivot, pose, worldPts[i]!));
    path.lineTo(s.x, s.y);
  }
  path.closePath();
}

/** A transformed arc/line piece as a fresh path on `ctx` — rigid transforms preserve circles
 * exactly (item 12), so this never approximates a curved boundary as a chord. Params default to
 * the whole curve (an untouched circle with no derived segments yet). */
function pathTransformedPiece(ctx: CanvasRenderingContext2D, view: ViewTransform, pivot: Vec2, pose: InstancePose, doc: Doc, entity: Entity, fromParam?: number, toParam?: number): void {
  const g = resolveEntityGeom(doc, entity);
  ctx.beginPath();
  if (g.kind === 'circle') {
    const centreS = worldToScreen(view, transformPoint(pivot, pose, g.centre));
    const r = g.radius * view.zoom;
    if (fromParam === undefined || toParam === undefined) {
      ctx.arc(centreS.x, centreS.y, r, 0, Math.PI * 2);
      return;
    }
    ctx.arc(centreS.x, centreS.y, r, poseArcAngle(pose, fromParam), poseArcAngle(pose, toParam), pose.mirror);
  } else {
    const t0 = fromParam ?? 0;
    const t1 = toParam ?? 1;
    const a = { x: g.a.x + (g.b.x - g.a.x) * t0, y: g.a.y + (g.b.y - g.a.y) * t0 };
    const b = { x: g.a.x + (g.b.x - g.a.x) * t1, y: g.a.y + (g.b.y - g.a.y) * t1 };
    const sa = worldToScreen(view, transformPoint(pivot, pose, a));
    const sb = worldToScreen(view, transformPoint(pivot, pose, b));
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
  }
}

interface FairStroke {
  entity: Entity;
  seg: DerivedSegment;
  state: SegmentState;
}

function collectFairStrokes(doc: Doc): FairStroke[] {
  const out: FairStroke[] = [];
  for (const entity of doc.entities) {
    for (const seg of deriveSegments(doc, entity)) {
      const state = doc.segmentStates.get(seg.key);
      if (state?.state === 'fair') out.push({ entity, seg, state });
    }
  }
  return out;
}

function drawFrameOutline(ctx: CanvasRenderingContext2D, view: ViewTransform, pivot: Vec2, pose: InstancePose, doc: Doc, alpha: number): void {
  ctx.save();
  ctx.strokeStyle = color.muted;
  ctx.lineWidth = 1.2;
  ctx.setLineDash([3, 3]);
  ctx.globalAlpha = alpha;
  if (doc.frame.kind === 'circle') {
    const c = worldToScreen(view, transformPoint(pivot, pose, pivot));
    ctx.beginPath();
    ctx.arc(c.x, c.y, doc.frame.radius * view.zoom, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    const n = doc.frame.kind === 'square' ? 4 : doc.frame.kind === 'hexagon' ? 6 : 3;
    ctx.beginPath();
    for (let k = 0; k <= n; k++) {
      const angle = doc.frame.rotation + ((k % n) / n) * Math.PI * 2;
      const p = { x: pivot.x + doc.frame.radius * Math.cos(angle), y: pivot.y + doc.frame.radius * Math.sin(angle) };
      const s = worldToScreen(view, transformPoint(pivot, pose, p));
      if (k === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Phase 5.6 items 26–28: coloured negative-space classes — every copy of each coloured class in
 * view, beneath the motifs. Their own colour carries their own opacity (never flattened), so PNG,
 * transparent PNG and SVG all keep it. */
function drawSpaces(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform): void {
  const fills = doc.repeat.gapFills;
  if (fills.size === 0) return;
  const topology = computeSpaces(doc);
  const tl = screenToWorld(view, { x: 0, y: 0 });
  const br = screenToWorld(view, { x: view.w, y: view.h });
  const box = { minX: Math.min(tl.x, br.x), maxX: Math.max(tl.x, br.x), minY: Math.min(tl.y, br.y), maxY: Math.max(tl.y, br.y) };
  for (const c of topology.classes) {
    const colour = fills.get(c.key);
    if (!colour) continue;
    const path = makePath(ctx);
    for (const t of spaceTranslations(c, box)) {
      c.loop.forEach((p, k) => {
        const s = worldToScreen(view, { x: p.x + t.x, y: p.y + t.y });
        if (k === 0) path.moveTo(s.x, s.y);
        else path.lineTo(s.x, s.y);
      });
      path.closePath();
    }
    ctx.fillStyle = colour;
    ctx.fill(path);
  }
}

/** Perceived lightness 0..1 of a #rrggbb colour — decides whether guides draw dark or light. */
function lightness(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 1;
  const n = parseInt(m[1]!, 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

const MAX_GRID_CELLS = 3000;

/**
 * Phase 5.1 item 8: the real lattice — every line comes from the current `a`/`b` basis (live
 * mid-drag too), never a decorative grid, and motif rotation never touches it (item 9). What is
 * drawn is read off the arms themselves (geometry/latticeSnap.ts — latticeShape), never a label:
 * - Any lattice (square, rectangular, skewed): the parallelogram cell each motif sits in (cells
 *   centred on the motif) — exact for every lattice, so never a misleading regular grid.
 * - A regular 60° lattice (equal arms at 60° or 120°): the triangulation joining motif centres —
 *   or, for a hexagon frame (or an artwork that chose Hexagon), its dual, the honeycomb cell around
 *   each motif, its corners at each triangle's centroid.
 */
function drawLatticeGrid(ctx: CanvasRenderingContext2D, doc: Doc, repeat: RepeatSystem, view: ViewTransform, strong: boolean, ink: string): void {
  const shape = latticeShape(repeat.a, repeat.b);
  const style = shape.kind === 'cells' ? 'cells' : repeat.family === 'hex' || doc.frame.kind === 'hexagon' ? 'hex' : 'triangle';
  // A 120° pair is drawn as its 60° pair (the same lattice).
  const basis: RepeatSystem = shape.kind === 'sixty' ? { ...repeat, b: shape.b60 } : repeat;
  const range = visibleLatticeRange({ ...doc, repeat: basis }, view, motifRadius(doc) * 1.2);
  if (!range) return;
  const { i0, i1, j0, j1 } = range;
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_GRID_CELLS) return; // too dense to read — nothing useful to show
  const { a, b } = basis;
  const pivot = doc.frame.origin;
  const at = (i: number, j: number): Vec2 => worldToScreen(view, { x: pivot.x + a.x * i + b.x * j, y: pivot.y + a.y * i + b.y * j });

  const path = makePath(ctx);
  const segment = (p: Vec2, q: Vec2) => {
    path.moveTo(p.x, p.y);
    path.lineTo(q.x, q.y);
  };

  if (style === 'hex') {
    const ring = [a, b, { x: b.x - a.x, y: b.y - a.y }, { x: -a.x, y: -a.y }, { x: -b.x, y: -b.y }, { x: a.x - b.x, y: a.y - b.y }];
    const corners = ring.map((u, k) => {
      const v = ring[(k + 1) % 6]!;
      return { x: (u.x + v.x) / 3, y: (u.y + v.y) / 3 };
    });
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cx = pivot.x + a.x * i + b.x * j;
        const cy = pivot.y + a.y * i + b.y * j;
        corners.forEach((c, k) => {
          const s = worldToScreen(view, { x: cx + c.x, y: cy + c.y });
          if (k === 0) path.moveTo(s.x, s.y);
          else path.lineTo(s.x, s.y);
        });
        path.closePath();
      }
    }
  } else if (style === 'triangle') {
    for (let j = j0; j <= j1; j++) segment(at(i0, j), at(i1, j));
    for (let i = i0; i <= i1; i++) segment(at(i, j0), at(i, j1));
    // b − a direction: points with i + j = k lie on one line.
    for (let k = i0 + j0; k <= i1 + j1; k++) {
      const tLo = Math.max(j0, k - i1);
      const tHi = Math.min(j1, k - i0);
      if (tLo < tHi) segment(at(k - tLo, tLo), at(k - tHi, tHi));
    }
  } else {
    // Square: cell edges halfway between motifs, so each motif sits centred in its own cell.
    for (let j = j0; j <= j1 + 1; j++) segment(at(i0 - 0.5, j - 0.5), at(i1 + 0.5, j - 0.5));
    for (let i = i0; i <= i1 + 1; i++) segment(at(i - 0.5, j0 - 0.5), at(i - 0.5, j1 + 0.5));
  }

  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.globalAlpha = strong ? 0.32 : 0.14;
  ctx.stroke(path);
  ctx.restore();
}

/** The two basis directions themselves, from the reference motif — shown with the grid when the
 * handles (whose own arms already draw them) are hidden. */
function drawBasisArrows(ctx: CanvasRenderingContext2D, doc: Doc, repeat: RepeatSystem, view: ViewTransform, ink: string): void {
  const pivot = doc.frame.origin;
  const from = worldToScreen(view, pivot);
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1.4;
  for (const v of [repeat.a, repeat.b]) {
    const to = worldToScreen(view, { x: pivot.x + v.x, y: pivot.y + v.y });
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - 9 * Math.cos(ang - 0.4), to.y - 9 * Math.sin(ang - 0.4));
    ctx.lineTo(to.x - 9 * Math.cos(ang + 0.4), to.y - 9 * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Phase 5 items 6/14: the two lattice-arm handles — always the PURE translation point (the
 * orientation rule styles a neighbour's own tile, never where its anchor sits). The one being
 * dragged is drawn larger and filled. */
function drawLatticeHandles(ctx: CanvasRenderingContext2D, controller: AppController, repeat: RepeatSystem, view: ViewTransform): void {
  const pivot = controller.doc.frame.origin;
  const pivotScreen = worldToScreen(view, pivot);
  for (const dir of ['a', 'b'] as const) {
    const vec = repeat[dir];
    const anchorScreen = worldToScreen(view, { x: pivot.x + vec.x, y: pivot.y + vec.y });
    ctx.save();
    ctx.strokeStyle = color.signal;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 4]);
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(pivotScreen.x, pivotScreen.y);
    ctx.lineTo(anchorScreen.x, anchorScreen.y);
    ctx.stroke();
    ctx.restore();

    const drag = controller.repeatDrag?.dir === dir ? controller.repeatDrag : null;
    ctx.beginPath();
    ctx.arc(anchorScreen.x, anchorScreen.y, drag ? 13 : 10, 0, Math.PI * 2);
    ctx.fillStyle = drag ? color.signal : color.paper;
    ctx.fill();
    ctx.lineWidth = drag ? 3 : 2;
    ctx.strokeStyle = color.signal;
    ctx.stroke();
  }
}

/** Phase 5 item 7: a circular drag handle around the reference motif — the whole ring is the
 * rotate gesture's target; the marker shows the current angle (live rotation while dragging). */
function drawRotationRing(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const doc = controller.doc;
  const pivot = doc.frame.origin;
  const centre = worldToScreen(view, pivot);
  const r = motifRadius(doc) * view.zoom + 26;
  const rotation = controller.repeatRotateDrag?.rawRotation ?? doc.repeat.motif.rotation;

  ctx.save();
  ctx.strokeStyle = color.hairline;
  ctx.lineWidth = 1.4;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  const handleAngle = -Math.PI / 2 + rotation; // marker starts "up" at zero rotation
  const hx = centre.x + r * Math.cos(handleAngle);
  const hy = centre.y + r * Math.sin(handleAngle);
  const active = !!controller.repeatRotateDrag;
  ctx.beginPath();
  ctx.arc(hx, hy, active ? 12 : 9, 0, Math.PI * 2);
  ctx.fillStyle = active ? color.brass : color.paper;
  ctx.fill();
  ctx.lineWidth = active ? 3 : 2;
  ctx.strokeStyle = color.brass;
  ctx.stroke();
}

/** Phase 5 item 7: "1/6 turn" rather than degrees — null when the current rotation isn't at (or
 * near, mid-drag) one of the offered fractions. */
export function rotationFractionLabel(rotation: number): string | null {
  const twoPi = Math.PI * 2;
  const norm = ((rotation % twoPi) + twoPi) % twoPi;
  const fractions = [2, 3, 4, 6, 8, 12];
  for (const n of fractions) {
    for (let k = 0; k < n; k++) {
      const target = (k / n) * twoPi;
      if (Math.abs(norm - target) < 1e-6 || Math.abs(norm - target - twoPi) < 1e-6) {
        if (k === 0) return '0 turn';
        const g = gcd(k, n);
        return `${k / g}/${n / g} turn`;
      }
    }
  }
  return null;
}
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

// ---- Mobile performance: the motif flattened once per document, and drawn as a cached bitmap ----

interface FlatMotif {
  strokes: FairStroke[];
  regions: FairRegion[];
  holesOf: Map<string, FairRegion[]> | null;
  maxStroke: number;
}
const flatCache = new WeakMap<Doc, FlatMotif>();

/** Everything a copy draws, gathered once per document (a new Doc on every edit) rather than
 * re-derived every frame. */
function flatMotif(doc: Doc): FlatMotif {
  let f = flatCache.get(doc);
  if (!f) {
    const strokes = collectFairStrokes(doc);
    const regions = computeFairRegions(doc);
    const filled = doc.fills.get(doc.activeColourway);
    f = {
      strokes,
      regions,
      holesOf: (filled && filled.size > 0) || colouringInUse(doc.repeatSetup?.colour) ? computeDirectHoles(regions) : null,
      maxStroke: strokes.reduce((m, st) => Math.max(m, st.state.stroke?.width ?? stroke.fairDefault), 0),
    };
    flatCache.set(doc, f);
  }
  return f;
}

const IDENTITY: InstancePose = { i: 0, j: 0, translate: { x: 0, y: 0 }, rotation: 0, mirror: false };

/** Repeat's own colour for a region of this copy (undefined: as designed) — see repeatColour.ts. */
type RegionPaint = (sig: FaceSig) => string | null | undefined;

/** The paint for one instance (null: the motif itself) of a copy in `group`, or null if Repeat
 * colours nothing. */
function paintFor(colour: RepeatColouring | undefined, instanceKey: string | null, group: 0 | 1): RegionPaint | null {
  if (!colouringInUse(colour)) return null;
  return (sig) => regionColour(colour, regionKey(instanceKey, sig), group);
}

/** One copy's fills and Fair strokes, exactly as the vector path draws them.
 * `paint`: Repeat's own region colours over the design's fills (Repeat Colouring).
 *
 * Stroke widths are the design's: a width w is w units of the artwork's own coordinates (w px at
 * 100% zoom), so lines scale with the pattern exactly as its geometry does — on screen, while a
 * pinch stretches the cached bitmap, in exports and in Timelapse alike, and the layers of a Double
 * or Triple keep their proportions at every zoom. (Guides, handles and rings stay screen-sized.) */
function drawCopy(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, pose: InstancePose, flat: FlatMotif, display: RepeatDisplay, showFills: boolean, showStrokes: boolean, skip?: ReadonlySet<number> | null, paint?: RegionPaint | null, layer?: DrawnLayer): void {
  const pivot = doc.frame.origin;
  const filledMap = doc.fills.get(doc.activeColourway);
  if (showFills && flat.holesOf && (filledMap || paint)) {
    // Effective fill opacity = the region's own alpha (in its colour) × Repeat's Fill opacity.
    ctx.globalAlpha = display.fillOpacity;
    for (const region of flat.regions) {
      const own = paint?.(region.sig);
      const colour = own === undefined ? filledMap?.get(region.sig) : own;
      if (!colour) continue;
      const path = makePath(ctx);
      appendTransformedLoop(path, view, pivot, pose, region.samplePoints);
      for (const hole of flat.holesOf.get(region.sig) ?? []) appendTransformedLoop(path, view, pivot, pose, hole.samplePoints);
      ctx.fillStyle = colour;
      ctx.fill(path, 'evenodd');
    }
    ctx.globalAlpha = 1;
  }
  // Repeat's Stroke style (this layer of it), if set, replaces every piece's own colour/width
  // (0 = no outlines).
  const colourOverride = layer ? layer.colour : (display.strokeColour ?? null);
  const widthOverride = layer ? layer.width : (display.strokeWidth ?? null);
  if (!showStrokes || widthOverride === 0) return;
  for (let n = 0; n < flat.strokes.length; n++) {
    if (skip?.has(n)) continue; // already drawn, exactly here, by an earlier instance of the unit
    const { entity, seg, state } = flat.strokes[n]!;
    ctx.strokeStyle = colourOverride ?? state.stroke?.colour ?? color.ink;
    ctx.lineWidth = (widthOverride ?? state.stroke?.width ?? stroke.fairDefault) * view.zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    pathTransformedPiece(ctx, view, pivot, pose, doc, entity, seg.fromParam, seg.toParam);
    ctx.stroke();
  }
}

// ---- Repeat from an Intersect arrangement: the unit ----

const skipCache = new WeakMap<Doc, { key: string; skips: (Set<number> | null)[] }>();

/**
 * For each instance of the unit, the Fair pieces it must not draw again: those lying exactly on a
 * piece an earlier instance draws — same ends, same middle (so the same line piece, or the same
 * arc), same stroke. Compared as placed, on a grid a millionth of the frame fine.
 */
function unitSkips(doc: Doc, flat: FlatMotif, unit: RepeatUnit): (Set<number> | null)[] {
  const cached = skipCache.get(doc);
  if (cached && cached.key === unit.key) return cached.skips;
  const pivot = doc.frame.origin;
  const q = Math.max(doc.frame.radius, 1e-6) * 1e-6;
  const cell = (p: Vec2) => `${Math.round(p.x / q)},${Math.round(p.y / q)}`;
  const seen = new Set<string>();
  const skips: (Set<number> | null)[] = [];
  for (const member of unit.members) {
    let skip: Set<number> | null = null;
    flat.strokes.forEach(({ entity, seg, state }, n) => {
      const g = resolveEntityGeom(doc, entity);
      let ends: [Vec2, Vec2];
      let mid: Vec2;
      if (g.kind === 'circle') {
        let span = seg.toParam - seg.fromParam;
        if (span <= 0) span += Math.PI * 2;
        const at = (a: number): Vec2 => ({ x: g.centre.x + g.radius * Math.cos(a), y: g.centre.y + g.radius * Math.sin(a) });
        ends = [at(seg.fromParam), at(seg.toParam)];
        mid = at(seg.fromParam + span / 2);
      } else {
        const at = (t: number): Vec2 => ({ x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t });
        ends = [at(seg.fromParam), at(seg.toParam)];
        mid = at((seg.fromParam + seg.toParam) / 2);
      }
      const [e0, e1] = ends.map((p) => cell(transformPoint(pivot, member, p))).sort() as [string, string];
      const key = `${g.kind}|${e0}|${e1}|${cell(transformPoint(pivot, member, mid))}|${state.stroke?.colour ?? ''}|${state.stroke?.width ?? ''}`;
      if (seen.has(key)) (skip ??= new Set()).add(n);
      else seen.add(key);
    });
    skips.push(skip);
  }
  skipCache.set(doc, { key: unit.key, skips });
  return skips;
}

/** A whole unit at one lattice placement: each instance as the motif is drawn, placed by its own
 * placement and then the lattice's. */
function drawUnit(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, pose: InstancePose, unit: RepeatUnit, flat: FlatMotif, display: RepeatDisplay, showFills: boolean, showStrokes: boolean, group: 0 | 1, layer?: DrawnLayer): void {
  const skips = unitSkips(doc, flat, unit);
  const colour = doc.repeatSetup?.colour;
  unit.members.forEach((member, k) => drawCopy(ctx, doc, view, composePose(pose, member), flat, display, showFills, showStrokes, skips[k], paintFor(colour, unit.keys[k]!, group), layer));
  if (showStrokes && unit.developed.length) drawDeveloped(ctx, doc, view, pose, unit, display, layer);
}

/** The Developed Primary at one lattice placement, in its one Primary style — ink at the Fair default
 * width (design units, so it scales with the pattern) — or Repeat's Stroke style, like every line. */
function drawDeveloped(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, pose: InstancePose, unit: RepeatUnit, display: RepeatDisplay, layer?: DrawnLayer): void {
  const colourOverride = layer ? layer.colour : (display.strokeColour ?? null);
  const widthOverride = layer ? layer.width : (display.strokeWidth ?? null);
  if (widthOverride === 0) return;
  const pivot = doc.frame.origin;
  const path = makePath(ctx);
  for (const prim of unit.developed) {
    const p = placePrim(prim, pivot, pose);
    if (p.k === 'seg') {
      const a = worldToScreen(view, p.a);
      const b = worldToScreen(view, p.b);
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
    } else {
      const c = worldToScreen(view, p.c);
      const r = p.r * view.zoom;
      path.moveTo(c.x + r * Math.cos(p.a0), c.y + r * Math.sin(p.a0));
      path.arc(c.x, c.y, r, p.a0, p.a0 + p.sw);
    }
  }
  ctx.strokeStyle = colourOverride ?? color.ink;
  ctx.lineWidth = (widthOverride ?? stroke.fairDefault) * view.zoom;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(path);
}

/**
 * What one stamp of the design draws. Normally everything at once ('all': fills, then the lines in
 * one style). With a Double or Triple outline the whole visible pattern is drawn pass by pass —
 * every fill, then every outer stroke, then every inner one, then every centre — so that wherever
 * lines cross, meet or run on into a neighbouring copy, the bands run on unbroken rather than one
 * line's outer stroke covering another's inner band.
 */
interface StampPass {
  key: string;
  fills: boolean;
  strokes: boolean;
  layer: DrawnLayer;
}

interface Sprite {
  canvas: HTMLCanvasElement;
  doc: Doc;
  key: string;
  zoom: number; // the view zoom it was drawn for
  cssSize: number; // its size on screen at that zoom, in CSS px
}
/** One bitmap per Pattern Colouring group (only the first while copies all look alike). */
/** One bitmap per Pattern Colouring group and per pass (only the first while copies look alike). */
const sprites = new Map<string, Sprite>();
const MAX_SPRITE_PX = 2048;
/** With a layered outline there is one bitmap per pass: each is kept smaller (memory on a phone). */
const MAX_LAYERED_SPRITE_PX = 1024;
/** Level of detail: with this many copies on screen, the shared bitmap is drawn at half resolution. */
const LOD_COPIES = 150;

/**
 * The motif as a bitmap for the current zoom — drawn once, then stamped for every copy (rotated or
 * mirrored per copy as its pose says). While fingers are pinching/panning, the last bitmap is simply
 * scaled (`allowStale`) and redrawn sharp on release. Null when it would be too large to be worth it.
 */
function motifSprite(doc: Doc, display: RepeatDisplay, zoom: number, detail: number, allowStale: boolean, unit: RepeatUnit | null, group: 0 | 1, pass: StampPass, layered: boolean): Sprite | null {
  // With a unit (Repeat from Intersect) the bitmap is the whole unit, about the lattice position.
  const key = `${display.artwork}|${display.fillOpacity}|${pass.key}:${pass.fills ? 'f' : ''}${pass.strokes ? 's' : ''}:${pass.layer.colour ?? ''}/${pass.layer.width ?? ''}|${detail}${unit ? `|unit:${unit.key}` : ''}`;
  const slot = `${group}|${pass.key}`;
  const sprite = sprites.get(slot) ?? null;
  const sameKind = !!sprite && sprite.key.includes('|unit:') === !!unit;
  if (sprite && sprite.doc === doc && ((allowStale && sameKind) || (sprite.key === key && Math.abs(sprite.zoom / zoom - 1) < 0.005))) return sprite;
  const flat = flatMotif(doc);
  const half = ((unit ? unit.extent : motifExtent(doc)) + (pass.layer.width ?? flat.maxStroke)) * zoom + 2; // CSS px
  const scale = effectiveDpr() * detail;
  const px = Math.ceil(half * 2 * scale);
  if (px > (layered ? MAX_LAYERED_SPRITE_PX : MAX_SPRITE_PX) || px < 4) return null;
  const canvas = sprite?.canvas ?? document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const sctx = canvas.getContext('2d');
  if (!sctx) return null;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, px, px);
  const pivot = doc.frame.origin;
  const local: ViewTransform = { zoom: zoom * scale, pan: { x: -pivot.x, y: -pivot.y }, w: px, h: px };
  if (unit) drawUnit(sctx, doc, local, IDENTITY, unit, flat, display, pass.fills, pass.strokes, group, pass.layer);
  else drawCopy(sctx, doc, local, IDENTITY, flat, display, pass.fills, pass.strokes, null, paintFor(doc.repeatSetup?.colour, null, group), pass.layer);
  const made: Sprite = { canvas, doc, key, zoom, cssSize: px / scale };
  sprites.set(slot, made);
  return made;
}

/** On screen, `exp` is absent. With `exp` (Phase 5.3 export): the same field at the same zoom/pan,
 * with the same appearance (stroke style, fill opacity) and background as requested, the lattice
 * guides only if asked — and never the handles or rotation ring. Exports are
 * always drawn as exact vectors; the screen stamps a cached bitmap per copy. Returns how many copies
 * were drawn (for the diagnostics overlay). */
export function renderRepeat(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform, exp?: ArtworkExport, layers?: ScreenLayers): number {
  const doc = controller.doc;
  const display = doc.repeatDisplay;
  ctx.save();
  ctx.clearRect(0, 0, view.w, view.h);
  if (!exp || exp.background) {
    ctx.fillStyle = display.background;
    ctx.fillRect(0, 0, view.w, view.h);
  }

  // Live drag draft (items 4/6/7): while dragging a lattice-arm handle or the rotation ring,
  // preview the shown (un-committed) value so the field — and the grid — follow the finger.
  const drag = exp ? null : controller.repeatDrag;
  const rotating = exp ? null : controller.repeatRotateDrag;
  // Close Gap's preview (Stage C): the corrected arm, drawn but never stored.
  const gap = !exp && controller.closeGap?.phase === 'preview' ? controller.closeGap.local[controller.closeGap.index] ?? null : null;
  const repeat: RepeatSystem = {
    ...doc.repeat,
    ...(gap ? { [gap.cand.arm]: gap.repeat[gap.cand.arm] } : null),
    ...(drag ? { [drag.dir]: drag.translate } : null),
    motif: rotating ? { ...doc.repeat.motif, rotation: rotating.rawRotation } : doc.repeat.motif,
  };
  const draftDoc = drag || rotating || gap ? { ...doc, repeat } : doc;

  const pivot = doc.frame.origin;
  // What stands at each lattice position: the motif, or the Intersect arrangement as one unit.
  const unit = repeatUnit(doc);
  const instances = visibleInstances(draftDoc, view, unit?.extent);
  // Repeat now always shows the whole design. A state recorded in the old Stroke-only or Fill-only
  // view (a Timelapse replays these) is still drawn as it looked then.
  const showFills = display.artwork !== 'stroke';
  const showStrokes = display.artwork !== 'fill';
  const flat = flatMotif(doc);

  // On screen only: the reference just above the background (underlay.ts) — and the field (Spaces
  // and every motif) drawn at its viewing strength over it; the guides and handles stay full.
  layers?.underlay(ctx, view);

  const detail = instances.length > LOD_COPIES ? 0.5 : 1;
  // Pattern Colouring: copies of the second group are drawn with their own colours.
  const colour = doc.repeatSetup?.colour;
  const grouped = !!colour?.pattern && colour.pattern.by !== 'none' && (colouringInUse(colour) || controller.repeatColourMode === 'pattern');
  const groupOf = (pose: InstancePose): 0 | 1 => (grouped ? patternGroup(colour, pose.i, pose.j) : 0);
  // The outline style: one pass for a single style (or as designed), or one per layer.
  const style = drawnLayers(doc, exp ? null : controller.repeatStrokeDraft);
  const layered = style.length > 1;
  const passes: StampPass[] = layered
    ? [{ key: 'fill', fills: showFills, strokes: false, layer: style[0]! }, ...style.map((layer, k) => ({ key: `L${k}`, fills: false, strokes: showStrokes, layer }))]
    : [{ key: 'all', fills: showFills, strokes: showStrokes, layer: style[0]! }];
  const used = new Set<string>();
  const bitmapFor = (group: 0 | 1, pass: StampPass): Sprite | null => {
    if (exp) return null;
    used.add(`${group}|${pass.key}`);
    return motifSprite(doc, display, view.zoom, detail, controller.viewGesture, unit, group, pass, layered);
  };

  drawArtworkLayer(ctx, layers, (ctx) => {
    // Spaces sit on the background, under every motif. While a handle or the ring is being dragged
    // the arrangement is still changing, so they wait for release rather than show a stale shape.
    // (Spaces are worked out for whatever repeats — the motif, or the Intersect unit: spaces.ts.)
    if (showFills && !drag && !rotating) drawSpaces(ctx, doc, view);

    for (const pass of passes) for (const pose of instances) {
      const group = groupOf(pose);
      const bitmap = bitmapFor(group, pass);
      if (bitmap) {
        const at = worldToScreen(view, { x: pivot.x + pose.translate.x, y: pivot.y + pose.translate.y });
        const size = bitmap.cssSize * (view.zoom / bitmap.zoom);
        ctx.save();
        ctx.translate(at.x, at.y);
        if (pose.rotation) ctx.rotate(pose.rotation);
        if (pose.mirror) ctx.scale(1, -1);
        ctx.drawImage(bitmap.canvas, -size / 2, -size / 2, size, size);
        ctx.restore();
      } else if (unit) {
        drawUnit(ctx, doc, view, pose, unit, flat, display, pass.fills, pass.strokes, group, pass.layer);
      } else {
        drawCopy(ctx, doc, view, pose, flat, display, pass.fills, pass.strokes, null, paintFor(colour, null, group), pass.layer);
      }
    }
  });
  // Bitmaps no longer drawn (another style, group or pass) are let go at once.
  if (!exp) for (const slot of [...sprites.keys()]) if (!used.has(slot)) sprites.delete(slot);

  const showGuides = !exp || exp.guides;
  if (showGuides) {
    const guideInk = lightness(display.background) < 0.45 ? color.paper : color.ink;
    if (display.grid) {
      drawLatticeGrid(ctx, doc, repeat, view, !!drag, guideInk);
      if (!display.handles) drawBasisArrows(ctx, doc, repeat, view, guideInk);
    }
    if (display.motifBoundary) {
      const reference = instancePose(repeat, 0, 0);
      if (unit) for (const member of unit.members) drawFrameOutline(ctx, view, pivot, composePose(reference, member), doc, 0.6);
      else drawFrameOutline(ctx, view, pivot, reference, doc, 0.6);
    }
  }
  // Pattern Colouring, while colouring: a quiet mark on each copy of the second group (screen only).
  if (!exp && controller.repeatColourMode === 'pattern' && grouped) {
    const ink = lightness(display.background) < 0.45 ? color.paper : color.ink;
    for (const pose of instances) {
      if (groupOf(pose) !== 1) continue;
      const at = worldToScreen(view, { x: pivot.x + pose.translate.x, y: pivot.y + pose.translate.y });
      ctx.beginPath();
      ctx.arc(at.x, at.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.75;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeStyle = display.background;
      ctx.stroke();
    }
  }
  if (!exp && display.handles && !controller.spaceMode && !controller.repeatColourMode) {
    drawLatticeHandles(ctx, controller, repeat, view);
    if (!controller.closeGap) drawRotationRing(ctx, controller, view);
  }
  if (gap) drawCloseGapInset(ctx, doc, view, gap);

  ctx.restore();
  return instances.length;
}

const gapFeatureCache = new WeakMap<Doc, Feature[]>();

/**
 * Close Gap's magnified view: the tapped gap, held where the tapped copy is, so its neighbour is seen
 * closing it — the current arrangement dashed grey, the proposed one solid; a brass dot where the two
 * features will meet; above it, which arm moves and by how much. Screen only (never exported).
 */
function drawCloseGapInset(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, gap: LocalGap): void {
  let feats = gapFeatureCache.get(doc);
  if (!feats) gapFeatureCache.set(doc, (feats = compositionFeatures(doc, 'runs')));
  const shift = copyShift(gap);
  // Where the gap is now on screen in the corrected field (the tapped copy moves with its arm).
  const gs = worldToScreen(view, { x: gap.at.x + shift.x, y: gap.at.y + shift.y });
  const R = Math.min(88, view.w * 0.24);
  const above = gs.y - R - 46 > R + 8;
  const c = { x: Math.min(Math.max(gs.x, R + 8), view.w - R - 8), y: above ? gs.y - R - 46 : Math.min(gs.y + R + 46, view.h - R - 8) };
  const tol = Math.max(gap.cand.distance * 5, 1e-6);
  const s = R / Math.max(tol, gap.cand.distance * 5);
  const toInset = (p: Vec2): Vec2 => ({ x: c.x + (p.x - gap.at.x) * s, y: c.y + (p.y - gap.at.y) * s });

  ctx.save();
  // a light thread from the inset to the gap in the field
  ctx.strokeStyle = color.brass;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(c.x, c.y + (above ? R : -R));
  ctx.lineTo(gs.x, gs.y);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(gs.x, gs.y, 9, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
  ctx.fillStyle = color.paper;
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = 10;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.clip();
  const [ci, cj] = gap.copy;
  const draw = (repeat: RepeatSystem, offset: Vec2) => {
    for (let i = ci - 1; i <= ci + 2; i++)
      for (let j = cj - 1; j <= cj + 2; j++)
        for (const f of copyFeatures(doc, i, j, repeat, feats)) {
          const p = f.prim;
          ctx.beginPath();
          if (p.k === 'seg') {
            const a = toInset({ x: p.a.x - offset.x, y: p.a.y - offset.y });
            const b = toInset({ x: p.b.x - offset.x, y: p.b.y - offset.y });
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
          } else {
            const cc = toInset({ x: p.c.x - offset.x, y: p.c.y - offset.y });
            ctx.arc(cc.x, cc.y, p.r * s, p.a0, p.a0 + p.sw, false);
          }
          ctx.stroke();
        }
  };
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#9aa0a6';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([5, 4]);
  draw(doc.repeat, { x: 0, y: 0 });
  ctx.setLineDash([]);
  ctx.strokeStyle = color.ink;
  ctx.lineWidth = 1.8;
  draw(gap.repeat, shift);
  const meet = toInset(gap.p);
  ctx.beginPath();
  ctx.arc(meet.x, meet.y, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = color.brass;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
  ctx.strokeStyle = color.brass;
  ctx.lineWidth = 2;
  ctx.stroke();

  // which arm moves, and how far
  const label = `${gap.cand.arm.toUpperCase()} moves ${Math.hypot(gap.cand.delta.x, gap.cand.delta.y).toFixed(2)}`;
  ctx.save();
  ctx.font = '600 12.5px system-ui, -apple-system, sans-serif';
  const w = ctx.measureText(label).width + 16;
  const ly = above ? c.y - R - 16 : c.y + R + 16;
  ctx.fillStyle = color.ink;
  ctx.beginPath();
  ctx.roundRect(c.x - w / 2, ly - 11, w, 22, 11);
  ctx.fill();
  ctx.fillStyle = color.paper;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, c.x, ly + 0.5);
  ctx.restore();
}

export { motifRadius };
