// Phase 5: the Repeat workspace's own render path — deliberately separate from render/renderer.ts
// (Construct's). Draws Fair strokes + fills only (item 14: construction/extension never repeat),
// once per visible lattice instance, reusing Construct's already-cached segment/region derivation
// (item 19: never recompute motif topology per copy — only its placement changes per instance).

import type { Doc, Entity, SegmentState, Vec2 } from '../model/types.ts';
import type { AppController, ViewTransform } from '../app/controller.ts';
import { worldToScreen } from '../app/controller.ts';
import { resolveEntityGeom } from '../geometry/kernel.ts';
import { deriveSegments, type DerivedSegment } from '../geometry/segments.ts';
import { computeDirectHoles, computeFairRegions } from '../geometry/regions.ts';
import {
  classifyContact,
  fitInstances,
  instancePose,
  motifRadius,
  poseArcAngle,
  transformPoint,
  visibleInstances,
  type InstancePose,
} from '../geometry/lattice.ts';
import { color, stroke } from './tokens.ts';

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

/** A transformed arc/line stroke straight onto `ctx` — rigid transforms preserve circles exactly
 * (item 12), so this never approximates a curved Fair boundary as a chord. */
function strokeTransformedSegment(ctx: CanvasRenderingContext2D, view: ViewTransform, pivot: Vec2, pose: InstancePose, doc: Doc, entity: Entity, seg: DerivedSegment): void {
  const g = resolveEntityGeom(doc, entity);
  ctx.beginPath();
  if (g.kind === 'circle') {
    const centreS = worldToScreen(view, transformPoint(pivot, pose, g.centre));
    const r = g.radius * view.zoom;
    const a0 = poseArcAngle(pose, seg.fromParam);
    const a1 = poseArcAngle(pose, seg.toParam);
    ctx.arc(centreS.x, centreS.y, r, a0, a1, pose.mirror);
  } else {
    const a = { x: g.a.x + (g.b.x - g.a.x) * seg.fromParam, y: g.a.y + (g.b.y - g.a.y) * seg.fromParam };
    const b = { x: g.a.x + (g.b.x - g.a.x) * seg.toParam, y: g.a.y + (g.b.y - g.a.y) * seg.toParam };
    const sa = worldToScreen(view, transformPoint(pivot, pose, a));
    const sb = worldToScreen(view, transformPoint(pivot, pose, b));
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
  }
  ctx.stroke();
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

/** Phase 5 items 6/14: the two lattice-arm handles (always the PURE translation point — the
 * orientation rule styles a neighbour's own tile, never where its anchor sits) plus a compact
 * contact-state label, drawn only while Guide is on. */
function drawLatticeGuide(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const doc = controller.doc;
  const pivot = doc.frame.origin;

  for (const dir of ['a', 'b'] as const) {
    const vec = doc.repeat[dir];
    const anchorWorld = { x: pivot.x + vec.x, y: pivot.y + vec.y };
    const anchorScreen = worldToScreen(view, anchorWorld);
    const pivotScreen = worldToScreen(view, pivot);
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

    const active = controller.repeatDrag?.dir === dir;
    ctx.beginPath();
    ctx.arc(anchorScreen.x, anchorScreen.y, active ? 13 : 10, 0, Math.PI * 2);
    ctx.fillStyle = active ? color.signal : color.paper;
    ctx.fill();
    ctx.lineWidth = active ? 3 : 2;
    ctx.strokeStyle = color.signal;
    ctx.stroke();
  }

  // Reference frame outline — the one deliberately "heavy-ish" outline, distinguishing the
  // central motif without outlining every tile (item 15).
  drawFrameOutline(ctx, view, pivot, instancePose(doc.repeat, 0, 0), doc, 0.6);

  drawRotationRing(ctx, controller, view);
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

/** Phase 5 item 6: a compact contact-state readout next to whichever handle is being dragged —
 * only meaningful mid-drag, so it's owned by the caller (shell.ts) rather than always rendered
 * here; exported for that purpose. */
export function currentContactLabel(controller: AppController): string | null {
  const drag = controller.repeatDrag;
  if (!drag) return null;
  const state = classifyContact(controller.doc, drag.rawTranslate);
  switch (state) {
    case 'overlap':
      return 'Overlap';
    case 'edges-meet':
      return 'Edges meet';
    case 'tips-touch':
      return 'Tips touch';
    case 'gap':
      return 'Gap';
  }
}

export function renderRepeat(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform, opts: { forFit?: boolean } = {}): void {
  const doc = controller.doc;
  ctx.save();
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.fillStyle = color.plaster;
  ctx.fillRect(0, 0, view.w, view.h);

  const pivot = doc.frame.origin;
  const instances = opts.forFit ? fitInstances(doc) : visibleInstances(doc, view);
  const strokes = collectFairStrokes(doc);
  const regions = computeFairRegions(doc);
  const filledMap = doc.fills.get(doc.activeColourway);
  const holesOf = filledMap && filledMap.size > 0 ? computeDirectHoles(regions) : null;

  // Live drag draft (items 4/6/7): while dragging a lattice-arm handle or the rotation ring,
  // preview with the raw (un-snapped, un-committed) value so the field visibly follows the finger.
  const dragging = !!controller.repeatDrag || !!controller.repeatRotateDrag;
  let draftInstances = instances;
  if (dragging) {
    const draftRepeat = {
      ...doc.repeat,
      ...(controller.repeatDrag ? { [controller.repeatDrag.dir]: controller.repeatDrag.rawTranslate } : null),
      motif: controller.repeatRotateDrag ? { ...doc.repeat.motif, rotation: controller.repeatRotateDrag.rawRotation } : doc.repeat.motif,
    };
    const draftDoc = { ...doc, repeat: draftRepeat };
    draftInstances = opts.forFit ? fitInstances(draftDoc) : visibleInstances(draftDoc, view);
  }

  for (const pose of draftInstances) {
    if (holesOf) {
      for (const region of regions) {
        const colour = filledMap!.get(region.sig);
        if (!colour) continue;
        const path = new Path2D();
        appendTransformedLoop(path, view, pivot, pose, region.samplePoints);
        for (const hole of holesOf.get(region.sig) ?? []) appendTransformedLoop(path, view, pivot, pose, hole.samplePoints);
        ctx.fillStyle = colour;
        ctx.globalAlpha = 1;
        ctx.fill(path, 'evenodd');
      }
    }
    for (const { entity, seg, state } of strokes) {
      ctx.strokeStyle = state.stroke?.colour ?? color.ink;
      ctx.lineWidth = state.stroke?.width ?? stroke.fairDefault;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 1;
      strokeTransformedSegment(ctx, view, pivot, pose, doc, entity, seg);
    }
  }

  if (doc.repeatGuide && !opts.forFit) drawLatticeGuide(ctx, controller, view);

  ctx.restore();
}

export { motifRadius };
