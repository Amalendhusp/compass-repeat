// Intersection: a few copies of the construction, each where it has been placed and turned
// (geometry/intersection.ts) — each drawn entirely in its own analysis colour (never the Construct
// stroke colours), so where lines cross it is plain which copy each one belongs to. The selected
// construction shows a rotation ring about its own centre, in Repeat's rotation-ring style.
//
// Drawn: every copy's bounded construction, always — every piece that isn't trimmed or Extension —
// and, where that copy's Extensions switch is on, its extension geometry: each extended line as the
// whole line through the view, and any piece set to Extension. No fills, no points.
//
// Scaffold and design read apart at a glance, in the instance's own colour throughout: Extension
// thin, dashed and light; Construction thin and light; Fair solid, heavy and at full strength.
// (Weight and strength never mark the active instance — that is the ring's job.)
//
// Picks for Snap (geometry/intersectionSnap.ts), kept quiet in a dense drawing: a picked line is
// redrawn a little heavier over everything, the reference on a soft ink halo (or as an ink ring about
// its point) — fixed; the moving one on a halo of its own construction's colour, with that
// construction's rotation ring showing which construction would move.

import { drawArtworkLayer, type ScreenLayers } from './underlay.ts';
import type { Doc, Entity, Vec2 } from '../model/types.ts';
import type { AppController, ViewTransform } from '../app/controller.ts';
import { worldToScreen } from '../app/controller.ts';
import { resolveEntityGeom } from '../geometry/kernel.ts';
import { defaultSegmentKind, deriveSegments } from '../geometry/segments.ts';
import { motifRadius, poseArcAngle, transformPoint, type InstancePose } from '../geometry/lattice.ts';
import { intersectionBounds, intersectionCopies, type IntersectionCopy } from '../geometry/intersection.ts';
import { pickedEdge, planMatchEdge, resolvePick, type IntersectionPick, type ResolvedPick, type ShownLine } from '../geometry/intersectionSnap.ts';
import { color, stroke } from './tokens.ts';

type Piece = { entity: Entity; kind: 'construction' | 'extension' | 'fair'; from?: number; to?: number };

interface Scaffold {
  pieces: Piece[];
  /** Extended lines: drawn whole (dashed) beneath their own pieces. */
  extended: Entity[];
}
const scaffoldCache = new WeakMap<Doc, Scaffold>();

/** The construction to draw, gathered once per document (a new Doc on every commit). */
function scaffold(doc: Doc): Scaffold {
  let sc = scaffoldCache.get(doc);
  if (sc) return sc;
  const pieces: Piece[] = [];
  const extended: Entity[] = [];
  for (const entity of doc.entities) {
    if (entity.kind === 'line' && entity.extended) extended.push(entity);
    const segs = deriveSegments(doc, entity);
    if (segs.length === 0) {
      pieces.push({ entity, kind: 'construction' });
      continue;
    }
    for (const seg of segs) {
      const kind = doc.segmentStates.get(seg.key)?.state ?? defaultSegmentKind(entity, seg);
      if (kind === 'trimmed') continue;
      pieces.push({ entity, kind, from: seg.fromParam, to: seg.toParam });
    }
  }
  sc = { pieces, extended };
  scaffoldCache.set(doc, sc);
  return sc;
}

/** One piece, placed for `pose`, appended to `path` in screen space. Rigid transforms keep circles
 * circles, so arcs stay exact arcs (as Repeat draws them). */
function appendPiece(path: Path2D, doc: Doc, view: ViewTransform, pose: InstancePose, piece: Piece): void {
  const pivot = doc.frame.origin;
  const g = resolveEntityGeom(doc, piece.entity);
  if (g.kind === 'circle') {
    const c = worldToScreen(view, transformPoint(pivot, pose, g.centre));
    const r = g.radius * view.zoom;
    const from = piece.from === undefined ? 0 : poseArcAngle(pose, piece.from);
    const to = piece.to === undefined ? Math.PI * 2 : poseArcAngle(pose, piece.to);
    path.moveTo(c.x + r * Math.cos(from), c.y + r * Math.sin(from));
    path.arc(c.x, c.y, r, from, to, piece.from !== undefined && pose.mirror);
    return;
  }
  const t0 = piece.from ?? 0;
  const t1 = piece.to ?? 1;
  const at = (t: number): Vec2 => ({ x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t });
  const a = worldToScreen(view, transformPoint(pivot, pose, at(t0)));
  const b = worldToScreen(view, transformPoint(pivot, pose, at(t1)));
  path.moveTo(a.x, a.y);
  path.lineTo(b.x, b.y);
}

/** An extended line, placed for `pose`, as the whole line through the view. */
function appendWholeLine(path: Path2D, doc: Doc, view: ViewTransform, pose: InstancePose, entity: Entity): void {
  const g = resolveEntityGeom(doc, entity);
  if (g.kind !== 'line') return;
  const pivot = doc.frame.origin;
  const far = (Math.hypot(view.w, view.h) / view.zoom) * 2 + motifRadius(doc) * 4;
  const a = worldToScreen(view, transformPoint(pivot, pose, { x: g.a.x - g.dir.x * far, y: g.a.y - g.dir.y * far }));
  const b = worldToScreen(view, transformPoint(pivot, pose, { x: g.a.x + g.dir.x * far, y: g.a.y + g.dir.y * far }));
  path.moveTo(a.x, a.y);
  path.lineTo(b.x, b.y);
}

/** Draws Intersection; returns how many copies are shown (for the diagnostics overlay). */
export function renderIntersection(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform, layers?: ScreenLayers): number {
  const doc = controller.doc;
  ctx.save();
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.fillStyle = color.plaster;
  ctx.fillRect(0, 0, view.w, view.h);
  // On screen only: the reference just above the background (underlay.ts).
  layers?.underlay(ctx, view);

  const sc = scaffold(doc);
  const copies = intersectionCopies(doc, { drag: controller.intersectionDrag, spread: controller.intersectionSpreadDraft });
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Picks, worked out from the copies as shown right now (so they follow a live move or Spread).
  // Match Edge marks just the two edges (moving, then target), and previews the move.
  const edgeMode = controller.intersectionPickKind === 'edge';
  const rawPicks: IntersectionPick[] = controller.intersectionPicks ?? [];
  const picks = edgeMode ? [] : rawPicks.map((pick) => resolvePick(doc, copies, pick));
  const edges = edgeMode ? rawPicks.map((pick) => (resolvePick(doc, copies, pick) ? edgeShown(doc, copies, pick) : null)) : [];
  const edgePlan = edgeMode && rawPicks.length === 2 ? planMatchEdge(doc, copies, rawPicks[0]!, rawPicks[1]!) : null;
  const colourOf = (key: string) => copies.find((c) => c.key === key)?.colour ?? color.ink;
  picks.forEach((r, n) => {
    if (r?.kind === 'line') drawLineHalo(ctx, view, r.line, n === 0 ? color.ink : colourOf(r.line.copyKey), n === 0 ? 0.16 : 0.24, 9);
  });
  for (const e of edges) if (e) drawLineHalo(ctx, view, e, colourOf(e.copyKey), 0.24, 11);
  // The constructions at their viewing strength over the reference; the picks' marks and the
  // rotation ring, drawn after, stay full.
  // While Fair is the tool, the scaffold steps back so the Fair strokes read clearly (as Construct).
  const fairing = controller.tool === 'fair';
  const quiet = fairing ? (controller.fairTrace || controller.lineChoice ? QUIET_TRACING : QUIET) : null;
  drawArtworkLayer(ctx, layers, (ctx) => drawCopies(ctx, doc, view, sc, copies, quiet));
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  // Match Edge's preview: the moving construction, faint, where Match Edge would put it.
  if (edgePlan?.kind === 'edge' && !edgePlan.matched) {
    const moving = copies.find((c) => c.key === edgePlan.moving);
    if (moving) drawCopies(ctx, doc, view, sc, [{ ...moving, pose: { ...moving.pose, translate: edgePlan.translate, rotation: edgePlan.rotation } }], null, 0.5);
  }
  for (const e of edges) if (e) drawLineHalo(ctx, view, e, colourOf(e.copyKey), 1, 2.6);
  picks.forEach((r, n) => {
    // The picked line itself, crisp over everything else; a point's mark.
    if (r?.kind === 'line') drawLineHalo(ctx, view, r.line, colourOf(r.line.copyKey), 1, 2.2);
    if (r?.kind === 'point') drawPointMark(ctx, view, r, n === 0 ? color.ink : colourOf(r.carrier ?? ''), n === 0);
  });

  // Select arranges: the selected construction shows its rotation ring. A construction tool builds
  // on the ACTIVE instance (the selected one — the Primary until another is): only a quiet ring.
  const building = !!controller.tool && controller.tool !== 'select';
  const selected = copies.find((c) => c.key === controller.intersectionSelected) ?? (building ? copies[0] : undefined);
  if (selected) drawRotationRing(ctx, doc, view, selected, controller.intersectionDrag?.key === selected.key && controller.intersectionDrag.mode === 'turn', !building);
  ctx.restore();
  return copies.length;
}

const EXTENSION_ALPHA = 0.36;
const CONSTRUCTION_ALPHA = 0.45;
const FAIR_WIDTH = 2.8;
/** Construction and Extension while Fair is the tool — and fainter still while a trace is live. */
const QUIET = { construction: 0.2, extension: 0.14 };
const QUIET_TRACING = { construction: 0.12, extension: 0.08 };

/** Every construction, each in its own colour (the artwork part of the frame). */
/** A Match Edge pick's edge as shown now (world) — the segment itself, not its whole line. */
function edgeShown(doc: Doc, copies: IntersectionCopy[], pick: IntersectionPick): ShownLine | null {
  const edge = pickedEdge(doc, pick);
  const copy = pick.kind === 'line' ? copies.find((c) => c.key === pick.copy) : undefined;
  if (!edge || !copy || pick.kind !== 'line') return null;
  const a = transformPoint(doc.frame.origin, copy.pose, edge.a);
  const b = transformPoint(doc.frame.origin, copy.pose, edge.b);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-12) return null;
  return { copyKey: copy.key, entityId: pick.entity, p: a, u: { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, extent: [0, len] };
}

function drawCopies(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, sc: Scaffold, copies: IntersectionCopy[], quiet: { construction: number; extension: number } | null = null, fade = 1): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const copy of copies) {
    const dashed = new Path2D();
    const solid = new Path2D();
    const fair = new Path2D();
    if (copy.extensions) for (const entity of sc.extended) appendWholeLine(dashed, doc, view, copy.pose, entity);
    for (const piece of sc.pieces) {
      if (piece.kind === 'extension' && !copy.extensions) continue;
      appendPiece(piece.kind === 'fair' ? fair : piece.kind === 'extension' ? dashed : solid, doc, view, copy.pose, piece);
    }
    // Scaffold and design, at a glance — in the instance's own colour throughout: Extension thin,
    // dashed and light; Construction thin and light; Fair solid, heavy and at full strength.
    ctx.strokeStyle = copy.colour;
    ctx.globalAlpha = fade * (quiet?.extension ?? EXTENSION_ALPHA);
    ctx.lineWidth = 0.9;
    ctx.setLineDash([...stroke.extensionDash]);
    ctx.stroke(dashed);
    ctx.setLineDash([]);
    ctx.globalAlpha = fade * (quiet?.construction ?? CONSTRUCTION_ALPHA);
    ctx.lineWidth = 1;
    ctx.stroke(solid);
    ctx.globalAlpha = fade;
    ctx.lineWidth = FAIR_WIDTH;
    ctx.stroke(fair);
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}

/** A picked line's halo — its shown extent (or the whole line through the view), wide and faint —
 * or, at full strength and narrow, the line itself redrawn over the rest. */
function drawLineHalo(ctx: CanvasRenderingContext2D, view: ViewTransform, line: ShownLine, colour: string, alpha: number, width: number): void {
  // A whole line: as far either way as the view reaches, about the point on it nearest the view's centre.
  const far = Math.hypot(view.w, view.h) / view.zoom;
  const mid = (-view.pan.x - line.p.x) * line.u.x + (-view.pan.y - line.p.y) * line.u.y;
  const [t0, t1] = line.extent ?? [mid - far, mid + far];
  const a = worldToScreen(view, { x: line.p.x + line.u.x * t0, y: line.p.y + line.u.y * t0 });
  const b = worldToScreen(view, { x: line.p.x + line.u.x * t1, y: line.p.y + line.u.y * t1 });
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

/** A picked point: the reference as a small ink ring with a solid centre (fixed); the moving one as
 * a ring in its construction's colour around a paper centre. */
function drawPointMark(ctx: CanvasRenderingContext2D, view: ViewTransform, r: Extract<ResolvedPick, { kind: 'point' }>, colour: string, reference: boolean): void {
  const p = worldToScreen(view, r.at);
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = reference ? color.ink : color.paper;
  ctx.globalAlpha = reference ? 0.12 : 0.85;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = colour;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.restore();
}

/** The radius (screen px) of a construction's rotation ring — just outside its frame, as Repeat's. */
export function ringRadius(doc: Doc, view: ViewTransform): number {
  return motifRadius(doc) * view.zoom + 26;
}

/** Where a construction's rotation handle sits on its ring (screen) — "up" at zero rotation. */
export function rotationHandle(doc: Doc, view: ViewTransform, copy: IntersectionCopy): Vec2 {
  const pivot = doc.frame.origin;
  const centre = worldToScreen(view, { x: pivot.x + copy.pose.translate.x, y: pivot.y + copy.pose.translate.y });
  const r = ringRadius(doc, view);
  const a = -Math.PI / 2 + copy.pose.rotation;
  return { x: centre.x + r * Math.cos(a), y: centre.y + r * Math.sin(a) };
}

/** The selected construction's rotation ring about its own centre, its marker at its rotation. */
function drawRotationRing(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, copy: IntersectionCopy, active: boolean, handle = true): void {
  const pivot = doc.frame.origin;
  const centre = worldToScreen(view, { x: pivot.x + copy.pose.translate.x, y: pivot.y + copy.pose.translate.y });
  const r = ringRadius(doc, view);
  ctx.save();
  ctx.strokeStyle = copy.colour;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1.4;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  if (!handle) return; // the active instance while building: no handle, nothing to grab
  const { x: hx, y: hy } = rotationHandle(doc, view, copy);
  ctx.save();
  ctx.beginPath();
  ctx.arc(hx, hy, active ? 12 : 10, 0, Math.PI * 2);
  ctx.fillStyle = active ? copy.colour : color.paper;
  ctx.fill();
  ctx.lineWidth = active ? 3 : 2;
  ctx.strokeStyle = copy.colour;
  ctx.stroke();
  // The centre it turns about.
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = copy.colour;
  ctx.fill();
  ctx.restore();
}

/** A small picture of the arrangement as committed (for a Snapshot): every construction fitted in,
 * nothing selected — or undefined if no canvas could be made. */
export function intersectionThumbnail(doc: Doc, size = 64): string | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = size * 2;
  canvas.height = size * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  const b = intersectionBounds(doc);
  const zoom = Math.min(size / Math.max(b.maxX - b.minX, 1e-6), size / Math.max(b.maxY - b.minY, 1e-6)) * 0.92;
  const view: ViewTransform = { zoom, pan: { x: -(b.minX + b.maxX) / 2, y: -(b.minY + b.maxY) / 2 }, w: size, h: size };
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  const still = { doc, intersectionDrag: null, intersectionSpreadDraft: null, intersectionSelected: null, intersectionPicks: [] } as unknown as AppController;
  renderIntersection(ctx, still, view);
  // A small JPEG: it's saved with the artwork, so it is kept to a few kilobytes.
  return canvas.toDataURL('image/jpeg', 0.72);
}
