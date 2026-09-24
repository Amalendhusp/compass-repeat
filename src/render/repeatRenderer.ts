// Phase 5: the Repeat workspace's own render path — deliberately separate from render/renderer.ts
// (Construct's). Draws Fair strokes + fills only (item 14: construction/extension never repeat),
// once per visible lattice instance, reusing Construct's already-cached segment/region derivation
// (item 19: never recompute motif topology per copy — only its placement changes per instance).
// Phase 5.1: everything Appearance and Grid/Guides control is applied here at draw time only —
// nothing in doc.repeatDisplay ever writes back into Fair/fill state.

import type { Doc, Entity, RepeatSystem, SegmentState, Vec2 } from '../model/types.ts';
import type { AppController, ViewTransform } from '../app/controller.ts';
import { screenToWorld, worldToScreen } from '../app/controller.ts';
import { computeSpaces, spaceTranslations } from '../geometry/spaces.ts';
import { resolveEntityGeom } from '../geometry/kernel.ts';
import { defaultSegmentKind, deriveSegments, type DerivedSegment } from '../geometry/segments.ts';
import { computeDirectHoles, computeFairRegions } from '../geometry/regions.ts';
import {
  instancePose,
  motifRadius,
  poseArcAngle,
  transformPoint,
  visibleInstances,
  visibleLatticeRange,
  type InstancePose,
} from '../geometry/lattice.ts';
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

/** Phase 5.1 item 4: the construction used to develop the motif, around the reference copy only
 * (repeating it across every tile is exactly the clutter Construct already has to fade). Thin,
 * muted and translucent — always visibly subordinate to Fair strokes, and never artwork. */
function drawConstructionOverlay(ctx: CanvasRenderingContext2D, view: ViewTransform, pivot: Vec2, pose: InstancePose, doc: Doc): void {
  ctx.save();
  ctx.strokeStyle = color.construction;
  ctx.lineWidth = 0.9;
  ctx.globalAlpha = 0.55;
  ctx.lineCap = 'butt';
  for (const entity of doc.entities) {
    const segs = deriveSegments(doc, entity);
    if (segs.length === 0) {
      ctx.setLineDash([]);
      pathTransformedPiece(ctx, view, pivot, pose, doc, entity);
      ctx.stroke();
      continue;
    }
    for (const seg of segs) {
      const kind = doc.segmentStates.get(seg.key)?.state ?? defaultSegmentKind(entity, seg);
      if (kind === 'fair' || kind === 'trimmed') continue;
      ctx.setLineDash(kind === 'extension' ? stroke.extensionDash : []);
      pathTransformedPiece(ctx, view, pivot, pose, doc, entity, seg.fromParam, seg.toParam);
      ctx.stroke();
    }
  }
  ctx.restore();
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
 * mid-drag too), never a decorative grid, and motif rotation never touches it (item 9).
 * - Square: the parallelogram cell each motif sits in (cells centred on the motif).
 * - Triangle: the triangulation joining motif centres along a, b and b − a.
 * - Hexagon: that same triangulation's dual — the honeycomb cell around each motif, its corners
 *   at each triangle's centroid. For a true 60° basis that's the regular hexagon; for a dragged,
 *   skewed basis it stays an exact affine honeycomb, so it always tiles.
 */
function drawLatticeGrid(ctx: CanvasRenderingContext2D, doc: Doc, repeat: RepeatSystem, view: ViewTransform, strong: boolean, ink: string): void {
  const range = visibleLatticeRange({ ...doc, repeat }, view, motifRadius(doc) * 1.2);
  if (!range) return;
  const { i0, i1, j0, j1 } = range;
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_GRID_CELLS) return; // too dense to read — nothing useful to show
  const { a, b } = repeat;
  const pivot = doc.frame.origin;
  const at = (i: number, j: number): Vec2 => worldToScreen(view, { x: pivot.x + a.x * i + b.x * j, y: pivot.y + a.y * i + b.y * j });

  const path = makePath(ctx);
  const segment = (p: Vec2, q: Vec2) => {
    path.moveTo(p.x, p.y);
    path.lineTo(q.x, q.y);
  };

  if (repeat.family === 'hex') {
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
  } else if (repeat.family === 'triangle') {
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
 * orientation rule styles a neighbour's own tile, never where its anchor sits). Phase 5.1: a
 * snapped handle shows it, so the settled state is legible without a permanent label. */
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
    if (drag?.snapped) {
      ctx.beginPath();
      ctx.arc(anchorScreen.x, anchorScreen.y, 19, 0, Math.PI * 2);
      ctx.fillStyle = color.signalLight;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
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

/** On screen, `exp` is absent. With `exp` (Phase 5.3 export): the same field at the same zoom/pan,
 * in the current Artwork mode and effective fill opacity, background and construction overlay as
 * requested, the lattice guides only if asked — and never the handles or rotation ring. */
export function renderRepeat(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform, exp?: ArtworkExport): void {
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
  const repeat: RepeatSystem = {
    ...doc.repeat,
    ...(drag ? { [drag.dir]: drag.translate } : null),
    motif: rotating ? { ...doc.repeat.motif, rotation: rotating.rawRotation } : doc.repeat.motif,
  };
  const draftDoc = drag || rotating ? { ...doc, repeat } : doc;

  const pivot = doc.frame.origin;
  const instances = visibleInstances(draftDoc, view);
  const showFills = display.artwork !== 'stroke';
  const showStrokes = display.artwork !== 'fill';
  const showConstruction = exp ? exp.construction : display.constructionOverlay;
  const strokes = showStrokes ? collectFairStrokes(doc) : [];
  const regions = showFills ? computeFairRegions(doc) : [];
  const filledMap = doc.fills.get(doc.activeColourway);
  const holesOf = showFills && filledMap && filledMap.size > 0 ? computeDirectHoles(regions) : null;

  // Spaces sit on the background, under every motif. While a handle or the ring is being dragged
  // the arrangement is still changing, so they wait for release rather than show a stale shape.
  if (showFills && !drag && !rotating) drawSpaces(ctx, doc, view);

  for (const pose of instances) {
    if (holesOf) {
      // Effective fill opacity = the region's own alpha (in its colour) × Repeat's Fill opacity.
      ctx.globalAlpha = display.fillOpacity;
      for (const region of regions) {
        const colour = filledMap!.get(region.sig);
        if (!colour) continue;
        const path = makePath(ctx);
        appendTransformedLoop(path, view, pivot, pose, region.samplePoints);
        for (const hole of holesOf.get(region.sig) ?? []) appendTransformedLoop(path, view, pivot, pose, hole.samplePoints);
        ctx.fillStyle = colour;
        ctx.fill(path, 'evenodd');
      }
      ctx.globalAlpha = 1;
    }
    const isReference = pose.i === 0 && pose.j === 0;
    if (isReference && showConstruction) drawConstructionOverlay(ctx, view, pivot, pose, doc);
    for (const { entity, seg, state } of strokes) {
      ctx.strokeStyle = state.stroke?.colour ?? color.ink;
      ctx.lineWidth = state.stroke?.width ?? stroke.fairDefault;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      pathTransformedPiece(ctx, view, pivot, pose, doc, entity, seg.fromParam, seg.toParam);
      ctx.stroke();
    }
  }

  const showGuides = !exp || exp.guides;
  if (showGuides) {
    const guideInk = lightness(display.background) < 0.45 ? color.paper : color.ink;
    if (display.grid) {
      drawLatticeGrid(ctx, doc, repeat, view, !!drag, guideInk);
      if (!display.handles) drawBasisArrows(ctx, doc, repeat, view, guideInk);
    }
    if (display.motifBoundary) drawFrameOutline(ctx, view, pivot, instancePose(repeat, 0, 0), doc, 0.6);
  }
  if (!exp && display.handles && !controller.spaceMode) {
    drawLatticeHandles(ctx, controller, repeat, view);
    drawRotationRing(ctx, controller, view);
  }

  ctx.restore();
}

export { motifRadius };
