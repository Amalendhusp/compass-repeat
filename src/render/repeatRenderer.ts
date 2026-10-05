// Phase 5: the Repeat workspace's own render path — deliberately separate from render/renderer.ts
// (Construct's). Draws Fair strokes + fills (item 14: construction never becomes repeated artwork —
// the Construction overlay below is a drawn guide only, never geometry),
// once per visible lattice instance, reusing Construct's already-cached segment/region derivation
// (item 19: never recompute motif topology per copy — only its placement changes per instance).
// Phase 5.1: everything Appearance and Grid/Guides control is applied here at draw time only —
// nothing in doc.repeatDisplay ever writes back into Fair/fill state.

import type { Doc, Entity, RepeatDisplay, RepeatSystem, SegmentState, Vec2 } from '../model/types.ts';
import type { AppController, ViewTransform } from '../app/controller.ts';
import { screenToWorld, worldToScreen } from '../app/controller.ts';
import { computeSpaces, spaceTranslations } from '../geometry/spaces.ts';
import type { ConstructionFace } from '../geometry/constructionSpace.ts';
import { withAlpha } from '../model/colour.ts';
import { resolveEntityGeom } from '../geometry/kernel.ts';
import { defaultSegmentKind, deriveSegments, type DerivedSegment } from '../geometry/segments.ts';
import { computeDirectHoles, computeFairRegions, type FairRegion } from '../geometry/regions.ts';
import { effectiveDpr } from './canvasSetup.ts';
import {
  instancePose,
  motifExtent,
  motifRadius,
  poseArcAngle,
  transformPoint,
  visibleInstances,
  visibleLatticeRange,
  type InstancePose,
} from '../geometry/lattice.ts';
import { color, stroke } from './tokens.ts';
import { makePath, SvgContext, SvgPath } from './svgContext.ts';
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

/** Phase 5.1 item 4: the construction used to develop the motif, around the reference copy only.
 * Thin, muted and translucent — always visibly subordinate to Fair strokes, and never artwork. Now
 * used only where the overlay stays reference-only (a Timelapse — see ArtworkExport). */
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

// ---- The Construction overlay across the pattern: the reference motif's scaffold, repeated ----
//
// A drawn guide for decoding a pattern, never geometry: nothing here touches the document, so it
// can't be selected, edited, Faired, filled, undone or recorded. Every copy's scaffold is drawn with
// exactly the pose its motif copy has (lattice, spacing, rotation, Same / Alternate / Mirror), from
// the same instancePose/transformPoint the copies themselves use.
//
// An extended line is drawn as what it is — an infinite line, dashed — not as pieces: the
// transformed line of each copy whose artwork is in view, clipped to the view. Where lines from
// neighbouring cells continue one another exactly they are the same line, drawn once, so a line that
// runs on across cell boundaries reads as one line.

type ScaffoldPiece =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'arc'; c: Vec2; r: number; from: number; to: number }
  | { kind: 'circle'; c: Vec2; r: number };

interface Scaffold {
  solid: ScaffoldPiece[];
  dashed: ScaffoldPiece[]; // Extension pieces of lines that aren't extended (rare)
  /** Extended lines, as infinite lines: a point on each and its unit direction. */
  infinite: { p: Vec2; u: Vec2 }[];
  /** How far the finite pieces reach from the pivot — for choosing which copies to draw. */
  reach: number;
  paths?: { solid: Path2D; dashed: Path2D };
}
const scaffoldCache = new WeakMap<Doc, Scaffold>();
const REFERENCE_CONSTRUCTION_ALPHA = 0.55; // as the overlay always was
const COPY_CONSTRUCTION_ALPHA = 0.3; // the copies: quieter
// Distinct infinite lines per frame, from the copies nearest the middle of the view outwards. Only
// reached zoomed out on a dense scaffold (Plate 113 at fit: ~1,650), where the lines are a hatch a
// pixel or two apart and the far ones add nothing readable — but cost a frame.
const MAX_INFINITE_LINES = 600;

/** The construction pieces of one document (a new Doc on every commit, so cached per Doc): every
 * non-Fair, non-trimmed piece, with consecutive pieces of the same kind merged into one line or arc
 * so a dense scaffold stays a few hundred strokes rather than thousands. */
function motifScaffold(doc: Doc): Scaffold {
  let sc = scaffoldCache.get(doc);
  if (sc) return sc;
  const solid: ScaffoldPiece[] = [];
  const dashed: ScaffoldPiece[] = [];
  const infinite: Scaffold['infinite'] = [];
  const pivot = doc.frame.origin;
  let reach = 0;
  const grow = (p: Vec2, extra = 0) => {
    reach = Math.max(reach, Math.hypot(p.x - pivot.x, p.y - pivot.y) + extra);
  };
  for (const entity of doc.entities) {
    const g = resolveEntityGeom(doc, entity);
    const extendedLine = g.kind === 'line' && entity.kind === 'line' && entity.extended;
    if (extendedLine) infinite.push({ p: g.a, u: g.dir });
    const segs = deriveSegments(doc, entity);
    if (segs.length === 0) {
      if (g.kind === 'circle') {
        solid.push({ kind: 'circle', c: g.centre, r: g.radius });
        grow(g.centre, g.radius);
      } else if (!extendedLine) {
        solid.push({ kind: 'line', a: g.a, b: g.b });
        grow(g.a);
        grow(g.b);
      }
      continue;
    }
    const sorted = [...segs].sort((p, q) => p.fromParam - q.fromParam);
    let run: { dashed: boolean; from: number; to: number } | null = null;
    const flush = () => {
      if (!run) return;
      const into = run.dashed ? dashed : solid;
      if (g.kind === 'circle') {
        into.push({ kind: 'arc', c: g.centre, r: g.radius, from: run.from, to: run.to });
        grow(g.centre, g.radius);
      } else {
        const at = (t: number) => ({ x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t });
        const a = at(run.from);
        const b = at(run.to);
        into.push({ kind: 'line', a, b });
        grow(a);
        grow(b);
      }
      run = null;
    };
    for (const seg of sorted) {
      const kind = doc.segmentStates.get(seg.key)?.state ?? defaultSegmentKind(entity, seg);
      // Fair is drawn as the artwork; trimmed is gone; an extended line's dashed parts are its
      // infinite line, drawn separately.
      if (kind === 'fair' || kind === 'trimmed' || (extendedLine && kind === 'extension')) {
        flush();
        continue;
      }
      const isDashed = kind === 'extension';
      if (run && run.dashed === isDashed && Math.abs(run.to - seg.fromParam) < 1e-9) run.to = seg.toParam;
      else {
        flush();
        run = { dashed: isDashed, from: seg.fromParam, to: seg.toParam };
      }
    }
    flush();
  }
  sc = { solid, dashed, infinite, reach };
  scaffoldCache.set(doc, sc);
  return sc;
}

/** The pieces as one path: in the motif's own (world) coordinates for a canvas (drawn per copy under
 * that copy's pose as a transform), or placed point by point for SVG. */
function appendPieces(path: Path2D | SvgPath, pieces: ScaffoldPiece[], map?: (p: Vec2) => Vec2, pose?: InstancePose, zoom = 1): void {
  for (const piece of pieces) {
    if (piece.kind === 'line') {
      const a = map ? map(piece.a) : piece.a;
      const b = map ? map(piece.b) : piece.b;
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
    } else {
      const c = map ? map(piece.c) : piece.c;
      const r = piece.r * zoom;
      const from = piece.kind === 'arc' ? (pose ? poseArcAngle(pose, piece.from) : piece.from) : 0;
      const to = piece.kind === 'arc' ? (pose ? poseArcAngle(pose, piece.to) : piece.to) : Math.PI * 2;
      path.moveTo(c.x + r * Math.cos(from), c.y + r * Math.sin(from));
      path.arc(c.x, c.y, r, from, to, piece.kind === 'arc' && !!pose?.mirror);
    }
  }
}

/** One infinite line clipped to the view, in screen px — or null if it misses the view. The start is
 * moved back to a whole dash period from the world origin's foot on the line, so the dashes stay put
 * on the line while the view pans. */
function clipToView(view: ViewTransform, p: Vec2, u: Vec2, dashPeriod: number): [Vec2, Vec2] | null {
  const s = worldToScreen(view, p);
  const d = { x: u.x, y: u.y }; // unit screen direction (uniform zoom, no rotation): t is in px
  let t0 = -Infinity;
  let t1 = Infinity;
  const pad = 4;
  for (const [o, dir, lo, hi] of [[s.x, d.x, -pad, view.w + pad], [s.y, d.y, -pad, view.h + pad]] as const) {
    if (Math.abs(dir) < 1e-12) {
      if (o < lo || o > hi) return null;
      continue;
    }
    const ta = (lo - o) / dir;
    const tb = (hi - o) / dir;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  if (t0 >= t1) return null;
  const origin = worldToScreen(view, { x: 0, y: 0 });
  const anchor = (origin.x - s.x) * d.x + (origin.y - s.y) * d.y;
  if (dashPeriod > 0) t0 = anchor + Math.floor((t0 - anchor) / dashPeriod) * dashPeriod;
  return [{ x: s.x + d.x * t0, y: s.y + d.y * t0 }, { x: s.x + d.x * t1, y: s.y + d.y * t1 }];
}

/** The scaffold of every copy that reaches the view — the reference a little stronger, as the
 * overlay always was. Extended lines come from the copies whose artwork is in view (`lineCopies`). */
function drawRepeatedConstruction(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, poses: InstancePose[], lineCopies: InstancePose[]): void {
  const sc = motifScaffold(doc);
  if (sc.solid.length === 0 && sc.dashed.length === 0 && sc.infinite.length === 0) return;
  const pivot = doc.frame.origin;
  const isReference = (pose: InstancePose) => pose.i === 0 && pose.j === 0;
  const svg = (ctx as unknown) instanceof SvgContext;
  ctx.save();
  ctx.strokeStyle = color.construction;
  ctx.lineCap = 'butt';

  // Finite construction, copy by copy.
  if (sc.solid.length || sc.dashed.length) {
    if (svg) {
      ctx.lineWidth = 0.9;
      for (const pose of poses) {
        ctx.globalAlpha = isReference(pose) ? REFERENCE_CONSTRUCTION_ALPHA : COPY_CONSTRUCTION_ALPHA;
        const map = (p: Vec2) => worldToScreen(view, transformPoint(pivot, pose, p));
        for (const [pieces, dash] of [[sc.solid, []], [sc.dashed, stroke.extensionDash]] as const) {
          if (pieces.length === 0) continue;
          const path = new SvgPath();
          appendPieces(path, pieces, map, pose, view.zoom);
          ctx.setLineDash([...dash]);
          (ctx as unknown as SvgContext).stroke(path);
        }
      }
    } else {
      if (!sc.paths) {
        const solid = new Path2D();
        const dashed = new Path2D();
        appendPieces(solid, sc.solid);
        appendPieces(dashed, sc.dashed);
        sc.paths = { solid, dashed };
      }
      const z = view.zoom;
      for (const pose of poses) {
        // screen = zoom · (R·M·(p − pivot) + pivot + T + pan) + centre — transformPoint, then worldToScreen.
        const cos = Math.cos(pose.rotation);
        const sin = Math.sin(pose.rotation);
        const m = pose.mirror ? -1 : 1;
        const ox = pivot.x + pose.translate.x - (cos * pivot.x - sin * m * pivot.y);
        const oy = pivot.y + pose.translate.y - (sin * pivot.x + cos * m * pivot.y);
        ctx.save();
        ctx.transform(z * cos, z * sin, -z * sin * m, z * cos * m, z * (ox + view.pan.x) + view.w / 2, z * (oy + view.pan.y) + view.h / 2);
        ctx.globalAlpha = isReference(pose) ? REFERENCE_CONSTRUCTION_ALPHA : COPY_CONSTRUCTION_ALPHA;
        ctx.lineWidth = 0.9 / z;
        if (sc.solid.length) {
          ctx.setLineDash([]);
          ctx.stroke(sc.paths.solid);
        }
        if (sc.dashed.length) {
          ctx.setLineDash(stroke.extensionDash.map((d) => d / z));
          ctx.stroke(sc.paths.dashed);
        }
        ctx.restore();
      }
    }
  }

  // Extended lines: each copy's line, exactly transformed; coincident lines drawn once.
  if (sc.infinite.length) {
    const lines = new Map<string, { p: Vec2; u: Vec2; reference: boolean }>();
    // Nearest the middle of the view first, so if the cap is reached it's the far lines that go.
    const centre = { x: -view.pan.x, y: -view.pan.y };
    const away = (pose: InstancePose) => Math.hypot(pivot.x + pose.translate.x - centre.x, pivot.y + pose.translate.y - centre.y);
    for (const pose of [...lineCopies].sort((p1, p2) => away(p1) - away(p2))) {
      for (const { p, u } of sc.infinite) {
        const a = transformPoint(pivot, pose, p);
        const b = transformPoint(pivot, pose, { x: p.x + u.x, y: p.y + u.y });
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        // One orientation per line, so the same line from two copies gets the same key.
        if (dx < -1e-12 || (Math.abs(dx) <= 1e-12 && dy < 0)) {
          dx = -dx;
          dy = -dy;
        }
        const offset = a.x * dy - a.y * dx;
        const key = `${Math.round(Math.atan2(dy, dx) * 1e7)}:${Math.round(offset * 1e4)}`;
        const reference = isReference(pose);
        const had = lines.get(key);
        if (had) had.reference ||= reference;
        else if (lines.size < MAX_INFINITE_LINES) lines.set(key, { p: a, u: { x: dx, y: dy }, reference });
      }
    }
    ctx.lineWidth = 0.9;
    ctx.setLineDash([...stroke.extensionDash]);
    const period = stroke.extensionDash.reduce((sum, v) => sum + v, 0);
    if (svg) {
      // SVG: one path per strength.
      for (const strength of [false, true]) {
        const path = new SvgPath();
        let any = false;
        for (const l of lines.values()) {
          const seg = l.reference === strength ? clipToView(view, l.p, l.u, period) : null;
          if (!seg) continue;
          path.moveTo(seg[0].x, seg[0].y);
          path.lineTo(seg[1].x, seg[1].y);
          any = true;
        }
        if (!any) continue;
        ctx.globalAlpha = strength ? REFERENCE_CONSTRUCTION_ALPHA : COPY_CONSTRUCTION_ALPHA;
        (ctx as unknown as SvgContext).stroke(path);
      }
    } else {
      // Canvas: a stroke per line. Hundreds of long lines crossing one another in a single path are
      // many times slower to rasterise (where the canvas isn't GPU-drawn) than the same lines apart.
      for (const l of lines.values()) {
        const seg = clipToView(view, l.p, l.u, period);
        if (!seg) continue;
        ctx.globalAlpha = l.reference ? REFERENCE_CONSTRUCTION_ALPHA : COPY_CONSTRUCTION_ALPHA;
        ctx.beginPath();
        ctx.moveTo(seg[0].x, seg[0].y);
        ctx.lineTo(seg[1].x, seg[1].y);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

/** Which copies' scaffolds to draw: the same lattice culling as the copies — with the finite
 * construction's own reach (it can extend past the artwork) — and, for extended lines, exactly the
 * copies in view. */
function drawConstructionAcross(ctx: CanvasRenderingContext2D, doc: Doc, draftDoc: Doc, view: ViewTransform, inView: InstancePose[]): void {
  const reach = Math.max(motifExtent(doc), motifScaffold(doc).reach);
  drawRepeatedConstruction(ctx, doc, view, visibleInstances(draftDoc, view, reach), inView);
}

/** The shown Construction Space regions, as one shape: each filled, and outlined only where it
 * doesn't meet another shown region (so eight wedges of a star read as the star). */
function drawConstructionSpace(ctx: CanvasRenderingContext2D, view: ViewTransform, faces: ConstructionFace[], tol: number): void {
  const key = (p: Vec2) => `${Math.round(p.x / tol)},${Math.round(p.y / tol)}`;
  const sides = new Map<string, number>();
  const sideKey = (p: Vec2, q: Vec2) => [key(p), key(q)].sort().join('|');
  const loopsOf = (f: ConstructionFace) => [f.loop, ...f.holes];
  for (const f of faces) for (const loop of loopsOf(f)) loop.forEach((p, k) => sides.set(sideKey(p, loop[(k + 1) % loop.length]!), (sides.get(sideKey(p, loop[(k + 1) % loop.length]!)) ?? 0) + 1));
  ctx.save();
  ctx.fillStyle = withAlpha(color.signal, 0.2);
  const outline = new Path2D();
  for (const f of faces) {
    const fill = new Path2D();
    for (const loop of loopsOf(f)) {
      loop.forEach((p, k) => {
        const s = worldToScreen(view, p);
        if (k === 0) fill.moveTo(s.x, s.y);
        else fill.lineTo(s.x, s.y);
        const q = loop[(k + 1) % loop.length]!;
        if (sides.get(sideKey(p, q)) === 1) {
          const e = worldToScreen(view, q);
          outline.moveTo(s.x, s.y);
          outline.lineTo(e.x, e.y);
        }
      });
      fill.closePath();
    }
    ctx.fill(fill, 'evenodd');
  }
  ctx.strokeStyle = color.signal;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  ctx.stroke(outline);
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
      holesOf: filled && filled.size > 0 ? computeDirectHoles(regions) : null,
      maxStroke: strokes.reduce((m, st) => Math.max(m, st.state.stroke?.width ?? stroke.fairDefault), 0),
    };
    flatCache.set(doc, f);
  }
  return f;
}

const IDENTITY: InstancePose = { i: 0, j: 0, translate: { x: 0, y: 0 }, rotation: 0, mirror: false };

/** One copy's fills and Fair strokes, exactly as the vector path draws them. `lineScale` converts
 * the on-screen stroke widths into this target's pixels (1 on screen; DPR × detail in a sprite). */
function drawCopy(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, pose: InstancePose, flat: FlatMotif, display: RepeatDisplay, showFills: boolean, showStrokes: boolean, lineScale: number, beforeStrokes?: () => void): void {
  const pivot = doc.frame.origin;
  const filledMap = doc.fills.get(doc.activeColourway);
  if (showFills && flat.holesOf && filledMap) {
    // Effective fill opacity = the region's own alpha (in its colour) × Repeat's Fill opacity.
    ctx.globalAlpha = display.fillOpacity;
    for (const region of flat.regions) {
      const colour = filledMap.get(region.sig);
      if (!colour) continue;
      const path = makePath(ctx);
      appendTransformedLoop(path, view, pivot, pose, region.samplePoints);
      for (const hole of flat.holesOf.get(region.sig) ?? []) appendTransformedLoop(path, view, pivot, pose, hole.samplePoints);
      ctx.fillStyle = colour;
      ctx.fill(path, 'evenodd');
    }
    ctx.globalAlpha = 1;
  }
  beforeStrokes?.();
  if (!showStrokes) return;
  for (const { entity, seg, state } of flat.strokes) {
    ctx.strokeStyle = state.stroke?.colour ?? color.ink;
    ctx.lineWidth = (state.stroke?.width ?? stroke.fairDefault) * lineScale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    pathTransformedPiece(ctx, view, pivot, pose, doc, entity, seg.fromParam, seg.toParam);
    ctx.stroke();
  }
}

interface Sprite {
  canvas: HTMLCanvasElement;
  doc: Doc;
  key: string;
  zoom: number; // the view zoom it was drawn for
  cssSize: number; // its size on screen at that zoom, in CSS px
}
let sprite: Sprite | null = null;
const MAX_SPRITE_PX = 2048;
/** Level of detail: with this many copies on screen, the shared bitmap is drawn at half resolution. */
const LOD_COPIES = 150;

/**
 * The motif as a bitmap for the current zoom — drawn once, then stamped for every copy (rotated or
 * mirrored per copy as its pose says). While fingers are pinching/panning, the last bitmap is simply
 * scaled (`allowStale`) and redrawn sharp on release. Null when it would be too large to be worth it.
 */
function motifSprite(doc: Doc, display: RepeatDisplay, zoom: number, detail: number, allowStale: boolean, showFills: boolean, showStrokes: boolean): Sprite | null {
  const key = `${display.artwork}|${display.fillOpacity}|${detail}`;
  if (sprite && sprite.doc === doc && (allowStale || (sprite.key === key && Math.abs(sprite.zoom / zoom - 1) < 0.005))) return sprite;
  const flat = flatMotif(doc);
  const half = motifExtent(doc) * zoom + flat.maxStroke + 2; // CSS px
  const scale = effectiveDpr() * detail;
  const px = Math.ceil(half * 2 * scale);
  if (px > MAX_SPRITE_PX || px < 4) return null;
  const canvas = sprite?.canvas ?? document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const sctx = canvas.getContext('2d');
  if (!sctx) return null;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, px, px);
  const pivot = doc.frame.origin;
  const local: ViewTransform = { zoom: zoom * scale, pan: { x: -pivot.x, y: -pivot.y }, w: px, h: px };
  drawCopy(sctx, doc, local, IDENTITY, flat, display, showFills, showStrokes, scale);
  sprite = { canvas, doc, key, zoom, cssSize: px / scale };
  return sprite;
}

/** On screen, `exp` is absent. With `exp` (Phase 5.3 export): the same field at the same zoom/pan,
 * in the current Artwork mode and effective fill opacity, background and construction overlay as
 * requested, the lattice guides only if asked — and never the handles or rotation ring. Exports are
 * always drawn as exact vectors; the screen stamps a cached bitmap per copy. Returns how many copies
 * were drawn (for the diagnostics overlay). */
export function renderRepeat(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform, exp?: ArtworkExport): number {
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
  const flat = flatMotif(doc);

  // Spaces sit on the background, under every motif. While a handle or the ring is being dragged
  // the arrangement is still changing, so they wait for release rather than show a stale shape.
  if (showFills && !drag && !rotating) drawSpaces(ctx, doc, view);

  const detail = instances.length > LOD_COPIES ? 0.5 : 1;
  const bitmap = exp ? null : motifSprite(doc, display, view.zoom, detail, controller.viewGesture, showFills, showStrokes);

  // A Timelapse keeps the overlay as it was: the reference copy's alone, under its Fair strokes.
  const referenceOnly = showConstruction && !!exp?.referenceConstructionOnly;
  for (const pose of instances) {
    const isReference = pose.i === 0 && pose.j === 0;
    const overlay = isReference && referenceOnly ? () => drawConstructionOverlay(ctx, view, pivot, pose, doc) : undefined;
    if (bitmap && !overlay) {
      const at = worldToScreen(view, { x: pivot.x + pose.translate.x, y: pivot.y + pose.translate.y });
      const size = bitmap.cssSize * (view.zoom / bitmap.zoom);
      ctx.save();
      ctx.translate(at.x, at.y);
      if (pose.rotation) ctx.rotate(pose.rotation);
      if (pose.mirror) ctx.scale(1, -1);
      ctx.drawImage(bitmap.canvas, -size / 2, -size / 2, size, size);
      ctx.restore();
    } else {
      drawCopy(ctx, doc, view, pose, flat, display, showFills, showStrokes, 1, overlay);
    }
  }

  // The Construction overlay across the pattern: every visible copy's scaffold, over the copies (so
  // no neighbour's fill hides a line that continues into it), following any live drag too.
  if (showConstruction && !referenceOnly) drawConstructionAcross(ctx, doc, draftDoc, view, instances);

  // Construction Space: a temporary highlight on screen only (never exported, thumbnailed or saved),
  // shown only for the exact document it was found in — any change at all and it is gone.
  const found = controller.constructionSpace;
  if (!exp && found && found.doc === doc && !drag && !rotating && controller.spaceMode && controller.spaceBoundary === 'construction' && display.constructionOverlay) {
    drawConstructionSpace(ctx, view, found.faces, motifRadius(doc) * 0.003);
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
  return instances.length;
}

export { motifRadius };
