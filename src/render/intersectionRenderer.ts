// Intersection (V0): the construction of a small local group of copies — the primary and its
// immediate lattice neighbours (geometry/intersection.ts) — each copy drawn entirely in its own
// analysis colour (never the Construct stroke colours), so where lines cross it is plain which
// copy each one belongs to. Placement is Repeat's: the same lattice, live drag draft, handles,
// rotation ring and guides (repeatRenderer's draftRepeat / drawPlacementControls).
//
// Drawn: every piece that isn't trimmed — Construction solid, Extension dashed, Fair a little
// heavier — and each extended line as the whole line through the view. No fills, no points.

import type { Doc, Entity, Vec2 } from '../model/types.ts';
import type { AppController, ViewTransform } from '../app/controller.ts';
import { worldToScreen } from '../app/controller.ts';
import { resolveEntityGeom } from '../geometry/kernel.ts';
import { defaultSegmentKind, deriveSegments } from '../geometry/segments.ts';
import { motifRadius, poseArcAngle, transformPoint, type InstancePose } from '../geometry/lattice.ts';
import { intersectionCopies } from '../geometry/intersection.ts';
import { color, stroke } from './tokens.ts';
import { draftRepeat, drawPlacementControls } from './repeatRenderer.ts';

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
export function renderIntersection(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): number {
  const doc = controller.doc;
  ctx.save();
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.fillStyle = color.plaster;
  ctx.fillRect(0, 0, view.w, view.h);

  const repeat = draftRepeat(controller);
  const sc = scaffold(doc);
  const shown = intersectionCopies(doc, repeat).filter((c) => c.visible);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const copy of shown) {
    const dashed = new Path2D();
    const solid = new Path2D();
    const fair = new Path2D();
    for (const entity of sc.extended) appendWholeLine(dashed, doc, view, copy.pose, entity);
    for (const piece of sc.pieces) appendPiece(piece.kind === 'fair' ? fair : piece.kind === 'extension' ? dashed : solid, doc, view, copy.pose, piece);
    ctx.strokeStyle = copy.colour;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.1;
    ctx.setLineDash([...stroke.extensionDash]);
    ctx.stroke(dashed);
    ctx.setLineDash([]);
    ctx.lineWidth = 1.3;
    ctx.stroke(solid);
    ctx.lineWidth = 2.2;
    ctx.stroke(fair);
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  drawPlacementControls(ctx, controller, view, repeat, color.plaster, { guides: true, handles: true, dragging: !!controller.repeatDrag });
  ctx.restore();
  return shown.length;
}
