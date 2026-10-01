import type { Doc, Entity, Point, PointId, SegmentKey, SegmentState, Vec2 } from '../model/types.ts';
import type { AppController, SelectCandidate, ViewTransform } from '../app/controller.ts';
import { resolveEntityGeom, resolvePoint } from '../geometry/kernel.ts';
import { defaultSegmentKind, deriveSegments, segmentKey, type DerivedSegment } from '../geometry/segments.ts';
import { computeConstructionRegions, computeDirectHoles, computeFairRegions } from '../geometry/regions.ts';
import { isFramePoint, isPointOrphanedByTrim, isPointUsed, pointById } from '../geometry/usage.ts';
import { dist } from '../geometry/vec.ts';
import { refLocation } from '../interaction/pointref.ts';
import { color, font, stroke } from './tokens.ts';
import { worldToScreen } from '../app/controller.ts';
import { makePath } from './svgContext.ts';
import { MARKER_R } from '../interaction/precision.ts';

// Phase 1.2 item 7 / Phase 3.3 item 3: the near-pointer field radius — a hard cutoff for whether
// an otherwise-hidden point is drawn at all (isPointVisible), and the same radius the continuous
// opacity/size falloff (proximityEase) fades across, so "visible" and "how strongly" agree.
const NEAR_FINGER_RADIUS = 60;
const FAR = 6000; // world units; long enough to reach canvas bounds at any sane zoom
const QUIET_CONSTRUCTION_ALPHA = 0.3; // spec §4.10: "Construction fades to 30% in Fair and Fill modes"
const TRACING_CONSTRUCTION_ALPHA = 0.15; // Phase 3.1 item 5: dimmer still while a trace is live

/** Phase 3C/3D: a segment's state as it should currently RENDER — the real doc state, unless an
 * in-progress Fair trace's draft overrides it (present-with-null means "show as reverted to
 * construction", present-with-a-state means "show as this"; absent from the draft falls through
 * to the real doc state untouched). Nothing but rendering ever reads the draft. */
function effectiveState(controller: AppController, key: SegmentKey, live = true): SegmentState | undefined {
  const draft = live ? activeFairDraft(controller) : undefined;
  if (draft?.has(key)) return draft.get(key) ?? undefined;
  return controller.doc.segmentStates.get(key);
}

/** Phase 5.8: the Fair run being shown — a live press/trace first, else a proposal awaiting ✓. */
function activeFairDraft(controller: AppController): Map<SegmentKey, SegmentState | null> | undefined {
  return controller.fairTrace?.draft;
}

/** Phase 5.8: while Fair is previewing or asking, everything that isn't the candidate recedes. */
function fairPreviewing(controller: AppController): boolean {
  return controller.tool === 'fair' && !!(controller.fairTrace || controller.lineChoice);
}

/** A piece of `entity`'s curve between two params, in screen space — shared by normal
 * rendering, trim ghosting and selection highlights so they all agree on geometry. */
function segmentPath(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, entity: Entity, fromParam: number, toParam: number): void {
  const g = resolveEntityGeom(doc, entity);
  ctx.beginPath();
  if (g.kind === 'circle') {
    const c = worldToScreen(view, g.centre);
    ctx.arc(c.x, c.y, g.radius * view.zoom, fromParam, toParam, false);
  } else {
    const a = { x: g.a.x + (g.b.x - g.a.x) * fromParam, y: g.a.y + (g.b.y - g.a.y) * fromParam };
    const b = { x: g.a.x + (g.b.x - g.a.x) * toParam, y: g.a.y + (g.b.y - g.a.y) * toParam };
    const sa = worldToScreen(view, a);
    const sb = worldToScreen(view, b);
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
  }
}

function wholeEntityPath(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, entity: Entity): void {
  const g = resolveEntityGeom(doc, entity);
  ctx.beginPath();
  if (g.kind === 'circle') {
    const c = worldToScreen(view, g.centre);
    ctx.arc(c.x, c.y, g.radius * view.zoom, 0, Math.PI * 2);
  } else {
    const sa = worldToScreen(view, g.a);
    const sb = worldToScreen(view, g.b);
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
  }
}

/** The dashed tails of an extended line beyond its outermost derived point — extension isn't a
 * segment of its own (spec keeps it on the entity), so it's drawn once per line, not per-piece. */
function drawExtensionTails(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, entity: Entity, segs: DerivedSegment[]): void {
  const g = resolveEntityGeom(doc, entity);
  if (g.kind !== 'line' || segs.length === 0) return;
  const minParam = Math.min(...segs.map((s) => s.fromParam));
  const maxParam = Math.max(...segs.map((s) => s.toParam));
  const start = { x: g.a.x + (g.b.x - g.a.x) * minParam, y: g.a.y + (g.b.y - g.a.y) * minParam };
  const end = { x: g.a.x + (g.b.x - g.a.x) * maxParam, y: g.a.y + (g.b.y - g.a.y) * maxParam };
  const farStart = { x: start.x - g.dir.x * FAR, y: start.y - g.dir.y * FAR };
  const farEnd = { x: end.x + g.dir.x * FAR, y: end.y + g.dir.y * FAR };
  ctx.strokeStyle = color.construction;
  ctx.lineWidth = view.zoom < 0.6 ? 0.6 : stroke.construction;
  ctx.setLineDash(stroke.extensionDash);
  ctx.beginPath();
  const s1 = worldToScreen(view, farStart);
  const s2 = worldToScreen(view, start);
  ctx.moveTo(s1.x, s1.y);
  ctx.lineTo(s2.x, s2.y);
  const s3 = worldToScreen(view, end);
  const s4 = worldToScreen(view, farEnd);
  ctx.moveTo(s3.x, s3.y);
  ctx.lineTo(s4.x, s4.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * Phase 2B / Phase 2.1 item 4 / Phase 3B: every entity stays one parametric curve — this just
 * draws it piece by piece according to each derived segment's effective state (real, or a
 * Fair-trace draft override). True Trim means a trimmed segment is never drawn, in any mode — no
 * ghost (Phase 2.1). Fair geometry emerges with a stronger ink stroke (§11 default 2.5px, round
 * caps/joins, or the segment's own custom stroke); ordinary construction and extension both stay
 * thin and quiet, fading further to 30% while Fair mode is active so the emerging design reads
 * clearly (§4.10's "Quiet construction" concept, extended to Fair per Phase 3B). Phase 3.1 item 5:
 * fades further still (15%) while a trace is actively in progress — "highlight only the current
 * path and immediate candidate continuation; dim unrelated construction more strongly." An entity
 * with no derived segments yet (an untouched circle — §4.5) falls back to drawing the whole curve.
 */
// ---- Focus construction: construction near the work stays clear, the rest fades right back ----

const FOCUS_NEAR_PX = 90;
const FOCUS_FAR_PX = 200;
const FOCUS_FAINT = 0.1;

/** Where the work is: the finger (last touch), and any pending anchor (Line's A, Circle's centre,
 * Arc's compass). World space, so panning never moves it. */
function focusSources(controller: AppController): Vec2[] {
  const out: Vec2[] = [];
  if (controller.focusWorld) out.push(controller.focusWorld);
  const p = controller.pending;
  if (p?.kind === 'line') out.push(refLocation(controller.doc, p.a));
  else if (p?.kind === 'circle') out.push(refLocation(controller.doc, p.centre));
  else if (p?.kind === 'arc') out.push(refLocation(controller.doc, p.stage === 'measure-b' ? p.a : p.centre));
  return out;
}

/** Screen distance from `f` to one piece of curve. */
function pieceDistancePx(g: ReturnType<typeof resolveEntityGeom>, from: number, to: number, f: Vec2, zoom: number): number {
  if (g.kind === 'line') {
    const a = paramPoint(g, from);
    const b = paramPoint(g, to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((f.x - a.x) * dx + (f.y - a.y) * dy) / len2));
    return Math.hypot(a.x + dx * t - f.x, a.y + dy * t - f.y) * zoom;
  }
  let span = to - from;
  if (span <= 0) span += Math.PI * 2;
  let ang = Math.atan2(f.y - g.centre.y, f.x - g.centre.x) - from;
  ang = ((ang % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (ang <= span) return Math.abs(Math.hypot(f.x - g.centre.x, f.y - g.centre.y) - g.radius) * zoom;
  return Math.min(dist(paramPoint(g, from), f), dist(paramPoint(g, to), f)) * zoom;
}

function focusAlpha(sources: Vec2[], g: ReturnType<typeof resolveEntityGeom>, from: number, to: number, zoom: number): number {
  if (sources.length === 0) return 0.35;
  let d = Infinity;
  for (const f of sources) d = Math.min(d, pieceDistancePx(g, from, to, f, zoom));
  if (d <= FOCUS_NEAR_PX) return 1;
  if (d >= FOCUS_FAR_PX) return FOCUS_FAINT;
  return 1 - (1 - FOCUS_FAINT) * ((d - FOCUS_NEAR_PX) / (FOCUS_FAR_PX - FOCUS_NEAR_PX));
}

function drawEntities(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform, exp?: ArtworkExport): void {
  const doc = controller.doc;
  const showConstruction = !exp || exp.construction;
  const baseWidth = view.zoom < 0.6 ? 0.6 : stroke.construction;
  // Phase 4: this file's own §4.10 comment always intended Fill to fade construction the same
  // way Fair does — never wired up before because Fill didn't exist yet.
  const quiet = controller.tool === 'fair' || controller.tool === 'fill';
  const quietAlpha = controller.fairTrace || controller.lineChoice ? TRACING_CONSTRUCTION_ALPHA : QUIET_CONSTRUCTION_ALPHA;
  // Mobile performance: while two fingers pan/zoom, construction is drawn without dash patterns
  // (the costliest part of a dense drawing); full quality returns on release.
  const light = !exp && controller.viewGesture;
  const focus = !exp && controller.focusConstruction ? focusSources(controller) : null;
  for (const e of doc.entities) {
    const segs = deriveSegments(doc, e);
    const g = focus ? resolveEntityGeom(doc, e) : null;
    if (segs.length === 0) {
      if (!showConstruction) continue;
      wholeEntityPath(ctx, doc, view, e);
      ctx.strokeStyle = color.construction;
      ctx.lineWidth = baseWidth;
      ctx.setLineDash([]);
      ctx.globalAlpha = (quiet ? quietAlpha : 1) * (focus && g ? focusAlpha(focus, g, 0, g.kind === 'circle' ? Math.PI * 2 : 1, view.zoom) : 1);
      ctx.stroke();
      ctx.globalAlpha = 1;
      continue;
    }
    for (const seg of segs) {
      const st = effectiveState(controller, seg.key, !exp);
      // Phase 5.6: an extended line's pieces beyond its own span default to dashed Extension.
      const kind = st?.state ?? defaultSegmentKind(e, seg);
      if (kind === 'trimmed' || (kind !== 'fair' && !showConstruction)) continue;
      segmentPath(ctx, doc, view, e, seg.fromParam, seg.toParam);
      if (kind === 'fair') {
        ctx.strokeStyle = st?.stroke?.colour ?? color.ink;
        ctx.lineWidth = st?.stroke?.width ?? stroke.fairDefault;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = color.construction;
        ctx.lineWidth = baseWidth;
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';
        ctx.setLineDash(kind === 'extension' && !light ? stroke.extensionDash : []);
        ctx.globalAlpha = (quiet ? quietAlpha : 1) * (focus && g ? focusAlpha(focus, g, seg.fromParam, seg.toParam, view.zoom) : 1);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
    }
    if (e.kind === 'line' && e.extended && showConstruction) drawExtensionTails(ctx, doc, view, e, segs);
  }
}

/** One region's boundary (or hole) as a closed screen-space subpath, appended to `path`. */
function appendRegionLoop(path: Path2D, view: ViewTransform, worldPts: Vec2[]): void {
  if (worldPts.length === 0) return;
  const first = worldToScreen(view, worldPts[0]!);
  path.moveTo(first.x, first.y);
  for (let i = 1; i < worldPts.length; i++) {
    const s = worldToScreen(view, worldPts[i]!);
    path.lineTo(s.x, s.y);
  }
  path.closePath();
}

/** Phase 4 items 6/7/10: region fills sit directly above the background and below every entity
 * stroke (construction, extension and Fair alike stay crisp above them) — drawn largest-first so
 * an outer region's own fill never overpaints a smaller nested region's independent state, using
 * `evenodd` so each region's DIRECT holes (Phase 4 item 10 — an immediately-nested region, not
 * every descendant) punch through to whatever is beneath, without needing true polygon-boolean
 * subtraction. The tap/hold preview renders last, translucent, on top of any committed fills. */
function drawFills(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform, live = true): void {
  const doc = controller.doc;
  const regions = computeFairRegions(doc);
  if (regions.length === 0) return;
  const filledMap = doc.fills.get(doc.activeColourway);
  const preview = live ? controller.fillPreview : null;
  if ((!filledMap || filledMap.size === 0) && !preview) return;
  const holesOf = computeDirectHoles(regions);
  const sorted = [...regions].sort((a, b) => b.areaWorld - a.areaWorld);

  for (const region of sorted) {
    const colour = filledMap?.get(region.sig);
    if (!colour) continue;
    const path = makePath(ctx);
    appendRegionLoop(path, view, region.samplePoints);
    for (const hole of holesOf.get(region.sig) ?? []) appendRegionLoop(path, view, hole.samplePoints);
    ctx.fillStyle = colour;
    ctx.globalAlpha = 1;
    ctx.fill(path, 'evenodd');
  }

  if (preview) {
    const region = regions.find((r) => r.sig === preview.sig);
    if (region) {
      const path = makePath(ctx);
      appendRegionLoop(path, view, region.samplePoints);
      for (const hole of holesOf.get(region.sig) ?? []) appendRegionLoop(path, view, hole.samplePoints);
      ctx.fillStyle = preview.colour;
      ctx.globalAlpha = 0.5;
      ctx.fill(path, 'evenodd');
      ctx.globalAlpha = 1;
    }
  }
}

/** Phase 1.2 item 3 / Phase 2A: a bold signal overlay for the segment/entity/group a Select
 * candidate refers to — a 'group' (Polygon) highlights every edge that shares its groupId.
 * Phase 2.1 item 4: a whole-entity/group highlight is drawn live-segment-by-live-segment too, so
 * a trimmed arc never shows a floating Signal highlight where nothing is actually drawn. */
function drawSelectionHighlights(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, selection: SelectCandidate[]): void {
  ctx.strokeStyle = color.signal;
  ctx.lineWidth = 3;
  ctx.setLineDash([]);
  for (const cand of selection) {
    if (cand.kind === 'point') continue;
    if (cand.kind === 'region') {
      // Phase 5.2 item 9: a region stands for its whole boundary — outline every boundary piece,
      // with a light tint inside so "the region" reads as selected, not just some edges.
      const region = (cand.fair ? computeFairRegions(doc) : computeConstructionRegions(doc)).find((r) => r.sig === cand.sig);
      if (!region) {
        // Just promoted/demoted: the face now lives in the other region set — its pieces still
        // exist, so outline those.
        for (const key of cand.keys) {
          const entity = doc.entities.find((e) => e.id === key.split(':')[0]);
          const seg = entity ? deriveSegments(doc, entity).find((s) => s.key === key) : undefined;
          if (!entity || !seg) continue;
          segmentPath(ctx, doc, view, entity, seg.fromParam, seg.toParam);
          ctx.stroke();
        }
        continue;
      }
      if (region.samplePoints.length > 0) {
        const path = new Path2D();
        appendRegionLoop(path, view, region.samplePoints);
        ctx.fillStyle = color.signalLight;
        ctx.globalAlpha = 0.35;
        ctx.fill(path);
        ctx.globalAlpha = 1;
        ctx.stroke(path);
      }
      continue;
    }
    const entityIds = cand.kind === 'group' ? cand.entityIds : [cand.kind === 'segment' || cand.kind === 'entity' ? cand.entityId : ''];
    for (const entityId of entityIds) {
      const entity = doc.entities.find((e) => e.id === entityId);
      if (!entity) continue;
      if (cand.kind === 'segment') {
        // Phase 3.6 item 4: `cand` is a SelectableGroup — draw every granular piece it spans
        // (`cand.keys`), not a single derived segment matched by the group's own outer from/to
        // (no raw DerivedSegment has those exact endpoints once a group spans more than one).
        // Phase 5.10: each scope looks different — a segment is a bold stroke between two ringed
        // ends; a run adds a soft halo along its length; the whole shape (below) is halo only.
        const isRun = cand.scope === 'run';
        const pieces = deriveSegments(doc, entity).filter((seg) => cand.keys.includes(seg.key));
        ctx.save();
        if (isRun) {
          ctx.strokeStyle = color.signalLight;
          ctx.lineWidth = 11;
          ctx.lineCap = 'round';
          for (const seg of pieces) {
            segmentPath(ctx, doc, view, entity, seg.fromParam, seg.toParam);
            ctx.stroke();
          }
        }
        ctx.strokeStyle = color.signal;
        ctx.lineWidth = isRun ? 3.5 : 5;
        ctx.lineCap = 'round';
        for (const seg of pieces) {
          segmentPath(ctx, doc, view, entity, seg.fromParam, seg.toParam);
          ctx.stroke();
        }
        for (const id of [cand.from, cand.to]) {
          const e = worldToScreen(view, resolvePoint(doc, id));
          ctx.beginPath();
          ctx.arc(e.x, e.y, 5.5, 0, Math.PI * 2);
          ctx.fillStyle = color.paper;
          ctx.fill();
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
        ctx.restore();
        continue;
      }
      const segs = deriveSegments(doc, entity);
      if (segs.length === 0) {
        wholeEntityPath(ctx, doc, view, entity);
        ctx.stroke();
        continue;
      }
      // Phase 5.10: the whole shape — a wide soft halo over its full length, then the stroke.
      for (const pass of [0, 1]) {
        ctx.save();
        ctx.strokeStyle = pass === 0 ? color.signalLight : color.signal;
        ctx.lineWidth = pass === 0 ? 13 : 3;
        ctx.lineCap = 'round';
        for (const seg of segs) {
          if ((doc.segmentStates.get(seg.key)?.state ?? 'construction') === 'trimmed') continue;
          segmentPath(ctx, doc, view, entity, seg.fromParam, seg.toParam);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }
}

function drawSnapMarker(ctx: CanvasRenderingContext2D, s: Vec2, scale = 1): void {
  ctx.strokeStyle = color.signal;
  ctx.fillStyle = color.signal;
  ctx.lineWidth = 1.4 * scale;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 9 * scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(s.x, s.y, 3 * scale, 0, Math.PI * 2);
  ctx.fill();
  const ticks: [number, number, number, number][] = [
    [-14, 0, -7, 0],
    [7, 0, 14, 0],
    [0, -14, 0, -7],
    [0, 7, 0, 14],
  ];
  for (const [x1, y1, x2, y2] of ticks) {
    ctx.beginPath();
    ctx.moveTo(s.x + x1 * scale, s.y + y1 * scale);
    ctx.lineTo(s.x + x2 * scale, s.y + y2 * scale);
    ctx.stroke();
  }
}

const LOUPE_OFFSET = 86; // px above (or below) the target
const LOUPE_MARGIN = 56; // keep clear of the top bar / canvas edges

function loupeCenter(anchorScreen: Vec2, radius: number, view: ViewTransform): Vec2 {
  let cy = anchorScreen.y - LOUPE_OFFSET;
  if (cy - radius < LOUPE_MARGIN) cy = anchorScreen.y + LOUPE_OFFSET;
  const cx = Math.min(Math.max(anchorScreen.x, LOUPE_MARGIN), view.w - LOUPE_MARGIN);
  return { x: cx, y: cy };
}

const NODE_INSET_RADIUS = 46;
const NODE_INSET_LOCAL_RADIUS = 30; // screen px: curve endpoints this close to the candidate count as "meeting here"

function paramPoint(g: ReturnType<typeof resolveEntityGeom>, t: number): Vec2 {
  if (g.kind === 'circle') return { x: g.centre.x + Math.cos(t) * g.radius, y: g.centre.y + Math.sin(t) * g.radius };
  return { x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t };
}

/**
 * Phase 3.1 item 2: the node inset — replaces the old single-marker snap loupe with a true
 * magnified view of the local geometry around the candidate junction, away from the fingertip
 * occluding it. Shows: the lines/arcs that actually meet at the candidate (drawn in the same
 * visual language as the main canvas, so it reads as "this drawing, zoomed," not a diagram);
 * the candidate itself, centred and Signal-highlighted; and any other real points close enough
 * on screen to be mistaken for it, so a dense junction is legible before commit rather than just
 * flagged as "something snapped." Reuses loupeCenter()'s placement and the background/shadow/clip
 * styling established by drawPrecisionLoupe; unlike that loupe (a fixed candidate list), the
 * content here is assembled fresh from the doc around the single active target.
 */
function drawNodeInset(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const target = controller.nodeInset;
  if (!target || controller.precision) return; // the full precision loupe takes over when open
  const doc = controller.doc;
  const activeScreen = worldToScreen(view, target.activeAt);
  const c = loupeCenter(target.anchorScreen, NODE_INSET_RADIUS, view);

  const otherScreens = target.candidates.map((p) => worldToScreen(view, p));
  let minPair = Infinity;
  for (const s of otherScreens) minPair = Math.min(minPair, dist(s, activeScreen));
  if (!isFinite(minPair) || minPair < 1) minPair = 18;
  const magnification = Math.min(6, Math.max(2.4, 20 / minPair));

  ctx.save();
  ctx.strokeStyle = color.hairline;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(target.anchorScreen.x, target.anchorScreen.y);
  ctx.lineTo(c.x, c.y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.shadowColor = 'rgba(30,42,54,0.24)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.arc(c.x, c.y, NODE_INSET_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = color.paper;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  ctx.save();
  ctx.beginPath();
  ctx.arc(c.x, c.y, NODE_INSET_RADIUS - 2, 0, Math.PI * 2);
  ctx.clip();

  const toLocal = (real: Vec2): Vec2 => ({ x: c.x + (real.x - activeScreen.x) * magnification, y: c.y + (real.y - activeScreen.y) * magnification });

  for (const e of doc.entities) {
    const segs = deriveSegments(doc, e);
    if (segs.length === 0) continue;
    const g = resolveEntityGeom(doc, e);
    for (const seg of segs) {
      const st = effectiveState(controller, seg.key);
      if (st?.state === 'trimmed') continue;
      const fromScreen = worldToScreen(view, paramPoint(g, seg.fromParam));
      const toScreen = worldToScreen(view, paramPoint(g, seg.toParam));
      if (dist(fromScreen, activeScreen) > NODE_INSET_LOCAL_RADIUS && dist(toScreen, activeScreen) > NODE_INSET_LOCAL_RADIUS) continue;
      const lf = toLocal(fromScreen);
      const isFair = st?.state === 'fair';
      ctx.beginPath();
      if (g.kind === 'circle') {
        const centreLocal = toLocal(worldToScreen(view, g.centre));
        ctx.arc(centreLocal.x, centreLocal.y, dist(centreLocal, lf), seg.fromParam, seg.toParam, false);
      } else {
        const lt = toLocal(toScreen);
        ctx.moveTo(lf.x, lf.y);
        ctx.lineTo(lt.x, lt.y);
      }
      ctx.strokeStyle = isFair ? (st?.stroke?.colour ?? color.ink) : color.construction;
      ctx.lineWidth = isFair ? 2 : 1.2;
      ctx.globalAlpha = isFair ? 1 : 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // Phase 3.1 item 6: at an undecided Fair junction, the leader/runner-up branches the trace is
  // weighing — same brass dashed language as drawFairTracePreview's main-canvas overlay, drawn
  // here too since the inset is exactly where the finger has hidden the junction it applies to.
  const tracePreview = controller.fairTrace?.preview;
  if (tracePreview) {
    const drawPreviewBranch = (segKey: SegmentKey, alpha: number) => {
      const entityId = segKey.split(':')[0];
      const branchEntity = doc.entities.find((e) => e.id === entityId);
      if (!branchEntity) return;
      const branchSeg = deriveSegments(doc, branchEntity).find((s) => segmentKey(branchEntity.id, s.from, s.to) === segKey);
      if (!branchSeg) return;
      const bg = resolveEntityGeom(doc, branchEntity);
      const bFrom = toLocal(worldToScreen(view, paramPoint(bg, branchSeg.fromParam)));
      ctx.beginPath();
      if (bg.kind === 'circle') {
        const bCentre = toLocal(worldToScreen(view, bg.centre));
        ctx.arc(bCentre.x, bCentre.y, dist(bCentre, bFrom), branchSeg.fromParam, branchSeg.toParam, false);
      } else {
        const bTo = toLocal(worldToScreen(view, paramPoint(bg, branchSeg.toParam)));
        ctx.moveTo(bFrom.x, bFrom.y);
        ctx.lineTo(bTo.x, bTo.y);
      }
      ctx.strokeStyle = color.brass;
      ctx.lineWidth = 2.6;
      ctx.setLineDash([5, 4]);
      ctx.globalAlpha = alpha;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    };
    drawPreviewBranch(tracePreview.leaderKey, 1);
    if (tracePreview.runnerUpKey) drawPreviewBranch(tracePreview.runnerUpKey, 0.45);
  }

  // Other real points close enough to matter — dim and unlabelled, just enough to show there is
  // competition at this junction, without drawing focus away from the chosen candidate.
  for (const s of otherScreens) {
    const local = toLocal(s);
    ctx.beginPath();
    ctx.arc(local.x, local.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = color.paper;
    ctx.fill();
    ctx.strokeStyle = color.hairline;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  // The chosen candidate — centred, Signal-highlighted, unmistakably "this one."
  ctx.beginPath();
  ctx.arc(c.x, c.y, 9, 0, Math.PI * 2);
  ctx.fillStyle = color.signal;
  ctx.fill();
  ctx.strokeStyle = color.paper;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Smart Snap: points about as close as the chosen one get a dashed Signal ring — this is a
  // choice the finger is still making, not a settled one.
  if (target.ambiguous && target.labels) {
    for (const l of target.labels) {
      if (l.active) continue;
      const local = toLocal(worldToScreen(view, l.at));
      if (dist(local, c) > NODE_INSET_RADIUS * 0.8) continue;
      ctx.beginPath();
      ctx.arc(local.x, local.y, 9, 0, Math.PI * 2);
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = color.signal;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  ctx.restore(); // clip

  ctx.beginPath();
  ctx.arc(c.x, c.y, NODE_INSET_RADIUS, 0, Math.PI * 2);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color.ink;
  ctx.stroke();

  // Smart Snap: what the chosen point is — and, when it's too close to call, what else it could be.
  const active = target.labels?.find((l) => l.active);
  if (active) {
    const others = target.ambiguous ? [...new Set(target.labels!.filter((l) => !l.active).map((l) => l.label))] : [];
    const lines = [active.label, ...(others.length ? [`or ${others.slice(0, 2).join(' / ')} · slide to choose`] : [])];
    drawLabelPill(ctx, { x: c.x, y: c.y + NODE_INSET_RADIUS + 14 }, lines, view);
  }
  ctx.restore();
}

/** A small rounded label, centred on `at` and kept on screen. First line Signal, the rest muted. */
function drawLabelPill(ctx: CanvasRenderingContext2D, at: Vec2, lines: string[], view: ViewTransform, alpha = 1): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `600 11px ${font.ui}`;
  const widths = lines.map((l, i) => {
    ctx.font = `${i === 0 ? 600 : 500} ${i === 0 ? 11 : 10}px ${font.ui}`;
    return ctx.measureText(l).width;
  });
  const w = Math.max(...widths) + 16;
  const h = 8 + lines.length * 14;
  const x = Math.min(Math.max(at.x - w / 2, 4), view.w - w - 4);
  const y = Math.min(Math.max(at.y - h / 2, 4), view.h - h - 4);
  ctx.shadowColor = 'rgba(30,42,54,0.18)';
  ctx.shadowBlur = 8;
  ctx.fillStyle = color.paper;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 8);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = color.hairline;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    ctx.font = `${i === 0 ? 600 : 500} ${i === 0 ? 11 : 10}px ${font.ui}`;
    ctx.fillStyle = i === 0 ? color.signal : color.muted;
    ctx.fillText(l, x + w / 2, y + 11 + i * 14);
  });
  ctx.restore();
}

/** Smart Snap: the point just used says what it was, briefly (Phase 5.9: with a hint line after a
 * crowded tap); and any brief canvas cue ("Trace the line you want"). */
function drawSnapFeedback(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const conf = controller.snapConfirm;
  if (conf && performance.now() < conf.until) {
    const s = worldToScreen(view, conf.at);
    ctx.save();
    ctx.beginPath();
    ctx.arc(s.x, s.y, 11, 0, Math.PI * 2);
    ctx.strokeStyle = color.signal;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    drawLabelPill(ctx, { x: s.x, y: s.y - (conf.hint ? 34 : 26) }, conf.hint ? [conf.label, conf.hint] : [conf.label], view, 0.95);
  }
  const cue = controller.cue;
  if (cue && performance.now() < cue.until) {
    const s = worldToScreen(view, cue.at);
    drawLabelPill(ctx, { x: s.x, y: s.y - 44 }, [cue.text], view, 0.97);
  }
  drawNoPoint(ctx, controller, view);
}

// ---- Phase 5.8/5.9: magnified local views, spread markers ----

const CHOICE_MARKER_R = 11;

/** Circled-number markers placed beside each candidate, pushed apart until none overlap. */
function fanMarkers(points: Vec2[], centre: Vec2, spread: number, bound: { c: Vec2; r: number } | null): Vec2[] {
  const n = points.length;
  const pos = points.map((p, i) => {
    let dx = p.x - centre.x;
    let dy = p.y - centre.y;
    let len = Math.hypot(dx, dy);
    if (len < 1) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1);
      dx = Math.cos(a);
      dy = Math.sin(a);
      len = 1;
    }
    return { x: p.x + (dx / len) * spread, y: p.y + (dy / len) * spread };
  });
  const minGap = CHOICE_MARKER_R * 2 + 4;
  for (let iter = 0; iter < 40; iter++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos[i]!;
        const b = pos[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= minGap) continue;
        if (d < 0.01) {
          dx = 1;
          dy = 0;
          d = 1;
        }
        const push = (minGap - d) / 2;
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
      }
    }
    if (bound) {
      for (const p of pos) {
        const dx = p.x - bound.c.x;
        const dy = p.y - bound.c.y;
        const d = Math.hypot(dx, dy);
        const max = bound.r - CHOICE_MARKER_R - 3;
        if (d > max) {
          p.x = bound.c.x + (dx / d) * max;
          p.y = bound.c.y + (dy / d) * max;
        }
      }
    }
  }
  return pos;
}

function drawNumberBadge(ctx: CanvasRenderingContext2D, at: Vec2, n: number, fill: string, strong: boolean, alpha: number): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(at.x, at.y, CHOICE_MARKER_R, 0, Math.PI * 2);
  ctx.fillStyle = strong ? fill : color.paper;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = fill;
  ctx.stroke();
  ctx.fillStyle = strong ? color.paper : fill;
  ctx.font = `700 12px ${font.ui}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), at.x, at.y + 0.5);
  ctx.restore();
}

/** The drawing around `centreScreen`, magnified `mag`× into a circle at `c` (clipped). */
function drawMagnified(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform, centreScreen: Vec2, c: Vec2, r: number, mag: number): (s: Vec2) => Vec2 {
  const doc = controller.doc;
  const toLocal = (s: Vec2): Vec2 => ({ x: c.x + (s.x - centreScreen.x) * mag, y: c.y + (s.y - centreScreen.y) * mag });
  const reachPx = r / mag + 2;
  const centreWorld = { x: (centreScreen.x - view.w / 2) / view.zoom - view.pan.x, y: (centreScreen.y - view.h / 2) / view.zoom - view.pan.y };
  for (const e of doc.entities) {
    const g = resolveEntityGeom(doc, e);
    const segs = deriveSegments(doc, e);
    const pieces = segs.length ? segs.map((sg) => ({ from: sg.fromParam, to: sg.toParam, key: sg.key as SegmentKey | null })) : [{ from: 0, to: g.kind === 'circle' ? Math.PI * 2 : 1, key: null }];
    for (const pc of pieces) {
      const st = pc.key ? effectiveState(controller, pc.key) : undefined;
      if (st?.state === 'trimmed') continue;
      if (pieceDistancePx(g, pc.from, pc.to, centreWorld, view.zoom) > reachPx) continue;
      ctx.beginPath();
      if (g.kind === 'circle') {
        const cl = toLocal(worldToScreen(view, g.centre));
        ctx.arc(cl.x, cl.y, g.radius * view.zoom * mag, pc.from, pc.to, false);
      } else {
        const a = toLocal(worldToScreen(view, paramPoint(g, pc.from)));
        const b = toLocal(worldToScreen(view, paramPoint(g, pc.to)));
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      const isFair = st?.state === 'fair';
      ctx.strokeStyle = isFair ? (st?.stroke?.colour ?? color.ink) : color.construction;
      ctx.lineWidth = isFair ? 2.2 : 1.2;
      ctx.globalAlpha = isFair ? 1 : 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  return toLocal;
}

/** "No point here yet": a dashed ring where the tap met the curve; with the Divide ÷2 offer, a
 * ghost of the midpoint that Divide would create. */
function drawNoPoint(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const np = controller.noPoint;
  if (!np || performance.now() > np.until) return;
  const s = worldToScreen(view, np.at);
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = color.alert;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(s.x - 5, s.y + 5);
  ctx.lineTo(s.x + 5, s.y - 5);
  ctx.stroke();
  if (np.midAt) {
    const m = worldToScreen(view, np.midAt);
    ctx.beginPath();
    ctx.arc(m.x, m.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = color.signalLight;
    ctx.fill();
    ctx.strokeStyle = color.signal;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([2, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

// ---- Phase 5.8: Fair Preview → Confirm, and "Which line?" ----

const RUN_COLOURS = [color.signal, color.brass, '#2E8B57', '#8A4FD1'];
const RUN_DASHES: number[][] = [[], [10, 5], [2, 5], [12, 4, 2, 4]];

function keyPiece(doc: Doc, key: SegmentKey): { entity: Entity; seg: DerivedSegment } | null {
  const entity = doc.entities.find((e) => key.startsWith(`${e.id}:`));
  if (!entity) return null;
  const seg = deriveSegments(doc, entity).find((sg) => sg.key === key);
  return seg ? { entity, seg } : null;
}

/** Strokes a whole run as ONE path — so a translucent halo has no darker blobs where pieces meet. */
function strokeRun(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, keys: Iterable<SegmentKey>, whole: string | null): void {
  if (whole) {
    const e = doc.entities.find((x) => x.id === whole);
    if (e) {
      wholeEntityPath(ctx, doc, view, e);
      ctx.stroke();
    }
    return;
  }
  const path = new Path2D();
  for (const k of keys) {
    const pc = keyPiece(doc, k);
    if (!pc) continue;
    const g = resolveEntityGeom(doc, pc.entity);
    if (g.kind === 'circle') {
      const c = worldToScreen(view, g.centre);
      const start = paramPoint(g, pc.seg.fromParam);
      const s0 = worldToScreen(view, start);
      path.moveTo(s0.x, s0.y);
      path.arc(c.x, c.y, g.radius * view.zoom, pc.seg.fromParam, pc.seg.toParam, false);
    } else {
      const a = worldToScreen(view, paramPoint(g, pc.seg.fromParam));
      const b = worldToScreen(view, paramPoint(g, pc.seg.toParam));
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
    }
  }
  ctx.stroke(path);
}

/** Open ends of a set of drafted pieces (world). */
function draftEnds(doc: Doc, keys: Iterable<SegmentKey>): Vec2[] {
  const count = new Map<PointId, number>();
  for (const k of keys) {
    const pc = keyPiece(doc, k);
    if (!pc) continue;
    for (const id of [pc.seg.from, pc.seg.to]) count.set(id, (count.get(id) ?? 0) + 1);
  }
  return [...count].filter(([, n]) => n === 1).map(([id]) => resolvePoint(doc, id));
}

/** Under the run: a broad halo, Signal for "will be Fair", amber dashes for "will stop being Fair". */
function drawFairRunHalo(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  if (controller.tool !== 'fair') return;
  const doc = controller.doc;
  const draft = activeFairDraft(controller);
  const whole = controller.fairTrace?.whole ?? null;
  if ((!draft || draft.size === 0) && !whole) return;
  const removing = !!draft && draft.size > 0 && [...draft.values()].every((v) => v?.state !== 'fair');
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = removing ? color.alert : color.signal;
  ctx.globalAlpha = removing ? 0.55 : 0.28;
  ctx.lineWidth = stroke.fairDefault + 9;
  if (removing) ctx.setLineDash([6, 5]);
  strokeRun(ctx, doc, view, draft?.keys() ?? [], whole);
  ctx.restore();
}

/** Over the run: an untouched circle's whole-curve preview, and small rings at the run's two ends
 * — where it will stop — so the ends are never lost under the finger or among other points. */
function drawFairRunMarkers(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  if (controller.tool !== 'fair') return;
  const doc = controller.doc;
  const whole = controller.fairTrace?.whole ?? null;
  if (whole) {
    ctx.save();
    ctx.strokeStyle = color.ink;
    ctx.lineWidth = stroke.fairDefault;
    strokeRun(ctx, doc, view, [], whole);
    ctx.restore();
  }
  const draft = controller.fairTrace?.draft;
  const ends = draft && draft.size ? draftEnds(doc, draft.keys()) : [];
  ctx.save();
  for (const e of ends) {
    const s = worldToScreen(view, e);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = color.paper;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color.signal;
    ctx.stroke();
  }
  ctx.restore();
}

/** "Which line?": every candidate run drawn complete, each in its own colour and dash, with its
 * number beside it; pressing a chooser button shows only that run. */
function drawLineChoice(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const choice = controller.lineChoice;
  if (!choice) return;
  const doc = controller.doc;
  const focus = choice.focus;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Longest first, so a shorter candidate lying along a longer one is drawn on top of it, never hidden.
  const runLength = (run: (typeof choice.candidates)[number]): number => {
    if (run.whole) return Infinity;
    let len = 0;
    for (const k of run.keys) {
      const pc = keyPiece(doc, k);
      if (pc) len += dist(worldToScreen(view, paramPoint(resolveEntityGeom(doc, pc.entity), pc.seg.fromParam)), worldToScreen(view, paramPoint(resolveEntityGeom(doc, pc.entity), pc.seg.toParam)));
    }
    return len;
  };
  const order = choice.candidates.map((_r, i) => i).sort((a, b) => runLength(choice.candidates[b]!) - runLength(choice.candidates[a]!));
  for (const i of order) {
    const run = choice.candidates[i]!;
    if (focus !== null && focus !== i) continue;
    const colour = RUN_COLOURS[i % RUN_COLOURS.length]!;
    // a paper casing, so the candidate reads clearly even over black Fair lines
    ctx.strokeStyle = color.paper;
    ctx.setLineDash([]);
    ctx.lineWidth = focus === i ? 11 : 9;
    ctx.globalAlpha = 0.9;
    strokeRun(ctx, doc, view, run.keys, run.whole);
    ctx.strokeStyle = colour;
    ctx.setLineDash(RUN_DASHES[i % RUN_DASHES.length]!);
    ctx.lineWidth = focus === i ? 6 : 5;
    ctx.globalAlpha = 1;
    strokeRun(ctx, doc, view, run.keys, run.whole);
    // where this candidate starts and stops — the part of the choice a label can't convey
    ctx.setLineDash([]);
    for (const e of run.ends) {
      const s = worldToScreen(view, e);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = color.paper;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = colour;
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  const anchors = choice.candidates.map((r) => worldToScreen(view, r.badgeAt));
  const badges = fanMarkers(anchors, choice.anchorScreen, CHOICE_MARKER_R + 6, null);
  choice.candidates.forEach((_r, i) => {
    const colour = RUN_COLOURS[i % RUN_COLOURS.length]!;
    const on = focus === null || focus === i;
    ctx.globalAlpha = on ? 1 : 0.3;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(anchors[i]!.x, anchors[i]!.y);
    ctx.lineTo(badges[i]!.x, badges[i]!.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    drawNumberBadge(ctx, badges[i]!, i + 1, colour, focus === i, on ? 1 : 0.3);
  });
  ctx.restore();
}

/** Phase 5.10: Select — the segment under a finger that is still down. */
function drawPressHighlight(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const keys = controller.pressHighlight;
  if (!keys || keys.length === 0 || controller.tool !== 'select') return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = color.signal;
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 12;
  strokeRun(ctx, controller.doc, view, keys, null);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 4;
  strokeRun(ctx, controller.doc, view, keys, null);
  ctx.restore();
}

/** Where "Which line?" badges sit on screen — the chooser's layout keeps its panel clear of them. */
export function lineChoiceBadges(controller: AppController, view: ViewTransform): Vec2[] {
  const choice = controller.lineChoice;
  if (!choice) return [];
  const anchors = choice.candidates.map((r) => worldToScreen(view, r.badgeAt));
  return fanMarkers(anchors, choice.anchorScreen, CHOICE_MARKER_R + 6, null);
}

/**
 * The precision loupe (Phase 5.9): the drawing around the crowded spot, magnified, away from the
 * fingertip. Each nearby point is shown at its true (magnified) place; where points would still
 * be too close for a finger, a marker is spread out with a thin leader back to it. The finger's
 * cursor moves 1:1 in here; the marker nearest it is the choice — filled, named, and ringed on the
 * drawing itself. Release takes it.
 */
function drawPrecisionLoupe(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const s = controller.precision;
  if (!s || s.candidates.length === 0) return;
  const { loupe } = s;
  const c = { x: loupe.x, y: loupe.y };
  const r = loupe.r;

  ctx.save();
  ctx.strokeStyle = color.hairline;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(loupe.centreScreen.x, loupe.centreScreen.y);
  ctx.lineTo(c.x, c.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowColor = 'rgba(30,42,54,0.28)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 5;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fillStyle = color.paper;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  ctx.save();
  ctx.beginPath();
  ctx.arc(c.x, c.y, r - 2, 0, Math.PI * 2);
  ctx.clip();
  const toLocal = drawMagnified(ctx, controller, view, loupe.centreScreen, c, r, loupe.mag);
  s.candidates.forEach((cand, i) => {
    const truePos = toLocal(worldToScreen(view, cand.at));
    const m = s.markers[i]!;
    const active = i === s.activeIndex;
    if (dist(truePos, m) > 2) {
      ctx.strokeStyle = active ? color.signal : color.muted;
      ctx.globalAlpha = active ? 1 : 0.6;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(truePos.x, truePos.y);
      ctx.lineTo(m.x, m.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(truePos.x, truePos.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color.ink;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(m.x, m.y, active ? MARKER_R + 1 : MARKER_R - 2, 0, Math.PI * 2);
    ctx.fillStyle = active ? color.signal : color.paper;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color.signal;
    ctx.stroke();
  });
  // the finger's cursor
  ctx.strokeStyle = color.ink;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(s.cursor.x, s.cursor.y, 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore(); // clip

  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color.ink;
  ctx.stroke();

  // On the drawing itself: the real point that release would take.
  const act = s.candidates[s.activeIndex];
  if (act) {
    const t = worldToScreen(view, act.at);
    ctx.beginPath();
    ctx.arc(t.x, t.y, 9, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = color.signal;
    ctx.stroke();
    const above = c.y < t.y;
    drawLabelPill(ctx, { x: c.x, y: above ? c.y - r - 14 : c.y + r + 14 }, [act.label ?? 'Point', 'Slide · release to choose'], view);
  }
  ctx.restore();
}

/** Phase 5.6 item 4: where the compass needle sits — a small ringed point with short ticks, so it
 * reads as "the centre" without a label, and stays distinct from snap markers. */
function drawCompassCentre(ctx: CanvasRenderingContext2D, c: Vec2): void {
  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = color.signal;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(c.x, c.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = color.paper;
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    ctx.moveTo(c.x + dx * 9, c.y + dy * 9);
    ctx.lineTo(c.x + dx * 13, c.y + dy * 13);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(c.x, c.y, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = color.signal;
  ctx.fill();
  ctx.restore();
}

/** Phase 5.6 item 3: the length picked up — A and B marked, the A–B measuring line between them.
 * Shown until the arc is drawn (or the compass is cleared); never geometry. */
function drawArcMeasure(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const pending = controller.pending;
  if (pending?.kind !== 'arc' || pending.stage !== 'compass' || !pending.measure) return;
  const a = worldToScreen(view, pending.measure.a);
  const b = worldToScreen(view, pending.measure.b);
  ctx.save();
  ctx.strokeStyle = color.signal;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.globalAlpha = 1;
  for (const [p, label] of [[a, 'A'], [b, 'B']] as const) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = color.signal;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color.paper;
    ctx.stroke();
    ctx.fillStyle = color.signal;
    ctx.font = `600 11px ${font.ui}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, p.x, p.y - 15);
  }
  ctx.restore();
}

function drawPreview(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const preview = controller.preview;
  if (!preview) return;
  ctx.strokeStyle = color.signal;
  ctx.lineWidth = 1.6;
  ctx.setLineDash(stroke.previewDash);
  if (preview.kind === 'circle') {
    const c = worldToScreen(view, preview.centre);
    const r = Math.hypot(preview.through.x - preview.centre.x, preview.through.y - preview.centre.y) * view.zoom;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = color.plaster;
    ctx.fill();
    ctx.stroke();
    drawSnapMarker(ctx, worldToScreen(view, preview.through));
  } else if (preview.kind === 'line') {
    const a = worldToScreen(view, preview.a);
    const b = worldToScreen(view, preview.b);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawSnapMarker(ctx, b);
  } else if (preview.kind === 'measure') {
    // Arc's Measure radius: the distance being taken, like opening compass legs from A to B.
    const a = worldToScreen(view, preview.a);
    const b = worldToScreen(view, preview.b);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawSnapMarker(ctx, b);
  } else {
    // Arc: the dashed compass circle, and — once a sweep has begun — the arc itself, solid.
    const c = worldToScreen(view, preview.centre);
    const r = preview.radius * view.zoom;
    ctx.globalAlpha = preview.sweep !== undefined ? 0.45 : 1;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    drawCompassCentre(ctx, c);
    if (preview.start !== undefined && preview.sweep !== undefined) {
      const a0 = preview.start;
      const a1 = preview.start + preview.sweep;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, a0, a1, preview.sweep < 0);
      ctx.stroke();
      drawSnapMarker(ctx, { x: c.x + r * Math.cos(a1), y: c.y + r * Math.sin(a1) });
    }
  }
  ctx.setLineDash([]);
}

/** Phase 1.2 item 5 / Phase 2A: every committed multi-step anchor (Line's A, Circle's centre,
 * Arc's chosen centre) stays strongly highlighted — independent of the live
 * preview — and survives pinch/pan untouched, since it reads straight from controller.pending
 * rather than any gesture-local state. */
/** Phase 5.12b/c → 5.13c: Circle → Between edges, shown so the construction reads by itself (no
 * labels). Each chosen edge: its whole supporting line as a light dashed Signal line right across the
 * view, with the piece actually tapped solid. The chain's corners so far are marked. Whenever the
 * chosen lines close validly — as a preview before the closing tap, and for real during it — the
 * polygon they imply is outlined and faintly tinted with its corners, and, when it has one exact
 * circle, the circle (a stronger dashed stroke over a pale halo, so it reads over dense construction
 * yet never looks committed), its centre and every tangency point. A circle too small to see at
 * this zoom gets a locator ring. None of this is geometry: nothing is created until release. */
function drawIncircle(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const st = controller.incircle;
  if (controller.tool !== 'circle' || controller.circleVariant !== 'three-lines' || !st) return;
  ctx.save();
  const c = st.result;
  const corner = (v: Vec2) => {
    const s = worldToScreen(view, v);
    ctx.beginPath();
    ctx.rect(s.x - 3.5, s.y - 3.5, 7, 7);
    ctx.fillStyle = color.paper;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color.signal;
    ctx.stroke();
  };
  // Supporting lines, right across the view (light, dashed).
  const reach = Math.hypot(view.w, view.h) * 2;
  ctx.lineCap = 'butt';
  st.supports.forEach((l, i) => {
    const piece = st.lines[i];
    const a = worldToScreen(view, l.a);
    const b = worldToScreen(view, l.b);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const mid = piece ? worldToScreen(view, piece.tap) : a;
    ctx.beginPath();
    ctx.moveTo(mid.x - u.x * reach, mid.y - u.y * reach);
    ctx.lineTo(mid.x + u.x * reach, mid.y + u.y * reach);
    ctx.strokeStyle = color.signal;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  });
  // The implied polygon (preview or closing).
  if (st.polygon && st.polygon.length >= 3) {
    const pts = st.polygon.map((v) => worldToScreen(view, v));
    const poly = new Path2D();
    pts.forEach((p, i) => (i === 0 ? poly.moveTo(p.x, p.y) : poly.lineTo(p.x, p.y)));
    poly.closePath();
    if (c) {
      ctx.fillStyle = color.signalLight;
      ctx.globalAlpha = 0.45;
      ctx.fill(poly);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = c ? color.signal : color.muted;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke(poly);
  }
  // The pieces actually tapped (solid).
  st.lines.forEach((line) => {
    const a = worldToScreen(view, line.a);
    const b = worldToScreen(view, line.b);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = color.signal;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.stroke();
  });
  // Corners: the closed polygon's, or the chain's so far.
  for (const v of st.polygon ?? st.corners) corner(v);
  if (c) {
    const centre = worldToScreen(view, c.centre);
    const r = c.radius * view.zoom;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color.paper;
    ctx.lineWidth = 5;
    ctx.globalAlpha = 0.8;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color.signal;
    ctx.lineWidth = 2.25;
    ctx.setLineDash([9, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (r < 10) {
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, 16, 0, Math.PI * 2);
      ctx.strokeStyle = color.signal;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color.paper;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = color.signal;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(centre.x - 7, centre.y);
    ctx.lineTo(centre.x + 7, centre.y);
    ctx.moveTo(centre.x, centre.y - 7);
    ctx.lineTo(centre.x, centre.y + 7);
    ctx.lineWidth = 1;
    ctx.stroke();
    for (const f of c.feet) {
      const s = worldToScreen(view, f);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = color.signal;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color.paper;
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Phase 5.12d/5.13: Circle → Copy circle. The whole source circle (every part of it, even trimmed
 * ones — it is the circle's radius being copied) flashes strongly when chosen, then stays quietly
 * marked; while a finger places the copy, the ghost circle of exactly that radius follows it. */
function drawCopyRadius(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const st = controller.copyRadius;
  if (controller.tool !== 'circle' || controller.circleVariant !== 'copy-radius' || !st || st.radius === null) return;
  const doc = controller.doc;
  ctx.save();
  const source = st.sourceId ? doc.entities.find((e) => e.id === st.sourceId) : undefined;
  if (source && source.kind === 'circle') {
    const g = resolveEntityGeom(doc, source);
    if (g.kind === 'circle') {
      const c = worldToScreen(view, g.centre);
      const strong = performance.now() < st.flashUntil;
      ctx.beginPath();
      ctx.arc(c.x, c.y, g.radius * view.zoom, 0, Math.PI * 2);
      ctx.strokeStyle = color.signal;
      ctx.lineWidth = strong ? 4 : 2;
      ctx.globalAlpha = strong ? 1 : 0.4;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  if (st.centreAt) {
    const c = worldToScreen(view, st.centreAt);
    const r = st.radius * view.zoom;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color.paper;
    ctx.lineWidth = 5;
    ctx.globalAlpha = 0.8;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color.signal;
    ctx.lineWidth = 2.25;
    ctx.setLineDash([9, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = color.plaster;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  ctx.restore();
}

function drawPendingAnchor(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const pending = controller.pending;
  if (!pending) return;
  const doc = controller.doc;
  // Phase 5.6: Arc's A is highlighted while B is chosen; once the compass is open, its own centre
  // marker and the measuring line take over (drawArcCompass).
  const refs = pending.kind === 'circle' ? [pending.centre] : pending.kind === 'line' ? [pending.a] : pending.stage === 'measure-b' ? [pending.a] : [];

  refs.forEach((ref, i) => {
    const at = refLocation(doc, ref);
    // While the precision loupe is still choosing this anchor, it isn't chosen yet — don't mark it.
    if (controller.precision) return;
    const s = worldToScreen(view, at);

    ctx.beginPath();
    ctx.arc(s.x, s.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = color.signalLight;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s.x, s.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = color.paper;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = color.signal;
    ctx.stroke();

    if (pending.kind === 'line' && i === 0) {
      ctx.fillStyle = color.signal;
      ctx.font = `600 12px ${font.ui}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('A', s.x, s.y - 22);
    }
  });
}

/** Phase 5.4 items 6/7: where an "Open boundary" Fill tap failed — the Fair chain that doesn't
 * close, as a dashed amber overlay (never the design's own colour), and rings on its loose ends.
 * Fades out; drawn on screen only, never exported. */
function drawFillDiagnostic(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const diag = controller.fillDiagnostic;
  if (!diag) return;
  const remaining = diag.until - Date.now();
  if (remaining <= 0) return;
  const fade = Math.min(1, remaining / 450);
  const doc = controller.doc;
  ctx.save();
  ctx.strokeStyle = color.alert;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.setLineDash([6, 6]);
  ctx.globalAlpha = 0.6 * fade;
  for (const key of diag.keys) {
    const entity = doc.entities.find((e) => e.id === key.split(':')[0]);
    const seg = entity ? deriveSegments(doc, entity).find((s) => s.key === key) : undefined;
    if (!entity || !seg) continue;
    segmentPath(ctx, doc, view, entity, seg.fromParam, seg.toParam);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const id of diag.endpoints) {
    if (!doc.points.some((p) => p.id === id)) continue;
    const s = worldToScreen(view, resolvePoint(doc, id));
    ctx.globalAlpha = 0.9 * fade;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = color.paper;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color.alert;
    ctx.fill();
  }
  ctx.restore();
}

/** Phase 5.2 item 12: a faint trail of the finger's path while a drag collects segments. */
function drawSweep(ctx: CanvasRenderingContext2D, controller: AppController): void {
  const path = controller.sweep;
  if (!path || path.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color.signal;
  ctx.globalAlpha = 0.28;
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(path[0]!.x, path[0]!.y);
  for (const p of path.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.stroke();
  ctx.restore();
}

/** Phase 5.2 items 14/15: while a point is being edited — the constructions that could be
 * re-anchored (all of them until one is chosen), and a live preview of the edit under the finger. */
function drawPointEdit(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const edit = controller.pointEdit;
  if (!edit) return;
  const doc = controller.doc;
  const shown = edit.mode === 'rebind' && edit.chosen ? [edit.chosen] : edit.dependents;
  ctx.save();
  ctx.strokeStyle = color.signal;
  ctx.lineWidth = 3;
  ctx.globalAlpha = edit.chosen || edit.mode !== 'rebind' ? 0.35 : 0.8;
  for (const dep of shown) {
    const e = doc.entities.find((x) => x.id === dep.entityId);
    if (!e) continue;
    for (const seg of deriveSegments(doc, e)) {
      if ((doc.segmentStates.get(seg.key)?.state ?? 'construction') === 'trimmed') continue;
      segmentPath(ctx, doc, view, e, seg.fromParam, seg.toParam);
      ctx.stroke();
    }
    if (deriveSegments(doc, e).length === 0) {
      wholeEntityPath(ctx, doc, view, e);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  const drag = edit.drag;
  if (drag) {
    const to = worldToScreen(view, drag.at);
    const from = resolvePoint(doc, edit.pointId);
    const moving = edit.mode === 'rebind' ? (edit.chosen ? [edit.chosen] : []) : edit.dependents;
    ctx.setLineDash(stroke.previewDash);
    ctx.lineWidth = 1.6;
    for (const dep of moving) {
      const e = doc.entities.find((x) => x.id === dep.entityId);
      if (!e) continue;
      const g = resolveEntityGeom(doc, e);
      ctx.beginPath();
      if (e.kind === 'line' && g.kind === 'line') {
        const other = worldToScreen(view, dep.role === 'a' ? g.b : g.a);
        ctx.moveTo(other.x, other.y);
        ctx.lineTo(to.x, to.y);
      } else if (e.kind === 'circle' && g.kind === 'circle') {
        // Moving the centre keeps a remembered radius, or stretches to a visible radius point.
        const centre = dep.role === 'centre' ? drag.at : g.centre;
        const radius = dep.role === 'through' ? dist(g.centre, drag.at) : isHiddenPoint(doc, e.through) ? g.radius : dist(drag.at, resolvePoint(doc, e.through));
        const c = worldToScreen(view, centre);
        ctx.arc(c.x, c.y, radius * view.zoom, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (dist(worldToScreen(view, from), to) > 1) {
      if (drag.snapped) drawSnapMarker(ctx, to);
      else {
        ctx.beginPath();
        ctx.arc(to.x, to.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = color.paper;
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function isHiddenPoint(doc: Doc, id: PointId): boolean {
  const p = pointById(doc, id);
  return p?.kind === 'free' && !!p.hidden;
}

function isPendingAnchorPoint(controller: AppController, pointId: PointId): boolean {
  const pending = controller.pending;
  if (!pending || controller.precision) return false;
  const refs = pending.kind === 'circle' ? [pending.centre] : pending.kind === 'line' ? [pending.a] : pending.stage === 'measure-b' ? [pending.a] : [pending.centre];
  return refs.some((ref) => ref.kind === 'existing' && ref.id === pointId);
}

/**
 * Phase 1.2 item 7: All ⊃ Near-finger ⊃ Used ⊃ None, each mode dropping one more category of
 * "ordinary" points. Selected points, the pending construction anchor and frame points always
 * show — geometry/snapping still consider every point regardless of what's drawn here. Division
 * points (§2I) are ordinary points here too — no special always-on treatment. Phase 2.1 item 2:
 * `recentIds` (freshly-created Divide points) also always show, on top of whatever the current
 * rule would otherwise say — a temporary override, not a change to the preference itself.
 *
 * Phase 3.1 item 1: Fair mode overrides whatever the global Points preference says — a temporary
 * presentation rule, not a change to `controller.pointVisibility` itself (restored the instant
 * the tool changes). "Used" points no longer show unconditionally in Fair, since a dense
 * construction can have hundreds of them; only the active trace's own start/current junction and
 * continuation candidates (`fairTrace.relevantPoints`), points near the finger, and explicitly
 * selected/frame/anchor points do.
 */
function isPointVisible(
  doc: Doc,
  controller: AppController,
  view: ViewTransform,
  pointId: PointId,
  selectedIds: Set<PointId>,
  recentIds: Set<PointId>,
): boolean {
  if (selectedIds.has(pointId)) return true;
  if (recentIds.has(pointId)) return true;
  if (isPendingAnchorPoint(controller, pointId)) return true;
  if (isFramePoint(doc, pointId)) return true;

  // Phase 5.2 item 16: committed division points are real, persistent points — visible whenever
  // points are shown at all, in every tool, never on a timer.
  const mode = controller.pointVisibility;
  if (mode !== 'none' && pointById(doc, pointId)?.kind === 'division') return true;

  if (controller.tool === 'fair') {
    if (controller.fairTrace?.relevantPoints.has(pointId)) return true;
    if (!controller.pointerScreenPos) return false;
    const s = worldToScreen(view, resolvePoint(doc, pointId));
    return dist(s, controller.pointerScreenPos) <= NEAR_FINGER_RADIUS;
  }

  if (mode === 'all') return true;
  const used = isPointUsed(doc, pointId);
  if (mode === 'used') return used;
  if (mode === 'none') return false;
  // near-finger (default)
  if (used) return true;
  if (!controller.pointerScreenPos) return false;
  const s = worldToScreen(view, resolvePoint(doc, pointId));
  return dist(s, controller.pointerScreenPos) <= NEAR_FINGER_RADIUS;
}

function selectedPointIds(selection: SelectCandidate[]): Set<PointId> {
  const set = new Set<PointId>();
  for (const c of selection) if (c.kind === 'point') set.add(c.id);
  return set;
}

/** Phase 3.3 item 3: 0 at/beyond PROXIMITY_RADIUS, 1 exactly at the pointer, eased so a point
 * stays subdued through most of the field and only gathers real strength close in — "emerge
 * gradually," not pop in at a threshold. The single nearest point to the pointer necessarily
 * gets the highest value here, which is what makes it read as the strongest candidate (item 3's
 * "strongest current candidate → strongest neutral point") without any separate bookkeeping. */
function proximityEase(controller: AppController, s: Vec2): number {
  if (!controller.pointerScreenPos) return 0;
  const t = Math.max(0, 1 - dist(s, controller.pointerScreenPos) / NEAR_FINGER_RADIUS);
  return t * t;
}

/**
 * Phase 3.3 items 3/4/6: one neutral proximity-dot language for every ordinary point regardless
 * of kind (intersection, division, midpoint, centre, on-curve, free…) — no outlines/rings, no
 * per-kind colour, opacity and size only. `base` is a point's presence with the pointer nowhere
 * near it: 0 for an unused point under Near Finger (spec: "essentially invisible" until
 * approached), a quiet-but-real baseline for anything structurally "used" (so the construction's
 * own skeleton stays legible) or explicitly shown by "All"/Fair's relevant-points override, never
 * a full identity — this is an orientation field ("useful nodes around here"), not the candidate
 * list. Precision selection stays the node inset's job (item 5), not these marks'.
 */
function drawOrdinaryPoint(ctx: CanvasRenderingContext2D, controller: AppController, doc: Doc, p: Point, s: Vec2): void {
  const eased = proximityEase(controller, s);
  const used = isFramePoint(doc, p.id) || isPointUsed(doc, p.id) || p.kind === 'division';
  let base = 0;
  if (controller.tool === 'fair') {
    base = controller.fairTrace?.relevantPoints.has(p.id) ? 0.55 : p.kind === 'division' ? 0.35 : 0;
  } else if (controller.pointVisibility === 'all') {
    base = used ? 0.45 : 0.2;
  } else if (used) {
    base = 0.45;
  }
  const opacity = Math.min(1, base + eased * (1 - base));
  if (opacity < 0.02) return;
  const radius = (base > 0 ? 2.1 : 1.5) + eased * 2.6;

  ctx.globalAlpha = opacity;
  ctx.beginPath();
  ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color.ink;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawPoints(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  // Phase 5.8/5.9: no point cloud over a Fair trace (it hid the run's end and its junctions), nor
  // while the precision loupe is choosing (the loupe shows the only points that matter).
  if (fairPreviewing(controller) || controller.precision) return;
  const doc = controller.doc;
  const selectedIds = selectedPointIds(controller.selection);
  const recentIds = controller.recentPoints?.ids ?? new Set<PointId>();
  for (const p of doc.points) {
    if (p.kind === 'free' && p.hidden) continue;
    if (isPointOrphanedByTrim(doc, p.id)) continue;
    if (!isPointVisible(doc, controller, view, p.id, selectedIds, recentIds)) continue;
    const at = resolvePoint(doc, p.id);
    const s = worldToScreen(view, at);

    // Phase 3.3 item 6: the deliberate exceptions to the one neutral dot language — a selected
    // point or a tool's committed anchor (Signal ring), and Divide's just-created flash (solid
    // Signal) — both pre-existing, unchanged interaction states, not point-kind styling.
    if (selectedIds.has(p.id) || isPendingAnchorPoint(controller, p.id)) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = color.paper;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
      ctx.strokeStyle = color.signal;
      ctx.lineWidth = 3;
      ctx.stroke();
      continue;
    }
    if (recentIds.has(p.id)) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = color.signal;
      ctx.fill();
      ctx.strokeStyle = color.paper;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      continue;
    }

    drawOrdinaryPoint(ctx, controller, doc, p, s);
  }
}

/** Phase 3D: while a Fair trace is deciding at a junction, the leading candidate draws as a
 * brass dashed segment ahead of the finger (§4.7 step 5); the runner-up shows faintly too when
 * it's still close enough in angle to matter. */
function drawFairTracePreview(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const preview = controller.fairTrace?.preview;
  if (!preview) return;
  const doc = controller.doc;

  function drawKey(key: SegmentKey, alpha: number): void {
    const entityId = key.split(':')[0];
    const entity = doc.entities.find((e) => e.id === entityId);
    if (!entity) return;
    const seg = deriveSegments(doc, entity).find((s) => segmentKey(entity.id, s.from, s.to) === key);
    if (!seg) return;
    segmentPath(ctx, doc, view, entity, seg.fromParam, seg.toParam);
    ctx.strokeStyle = color.brass;
    ctx.lineWidth = 2.4;
    ctx.setLineDash([5, 4]);
    ctx.globalAlpha = alpha;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }

  drawKey(preview.leaderKey, 1);
  if (preview.runnerUpKey) drawKey(preview.runnerUpKey, 0.4);
}

/** Phase 2.1 item 1: Divide's live preview — small Signal markers where Apply would create points. */
function drawDividePreview(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const preview = controller.dividePreview;
  if (!preview) return;
  for (const at of preview.points) {
    const s = worldToScreen(view, at);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color.signal;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color.paper;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

/** Phase 5.3: what an export asks the renderers for — artwork layers only, never app UI. */
export interface ArtworkExport {
  background: boolean;
  construction: boolean;
  /** Repeat only: the lattice grid, basis directions and motif boundary, as currently shown. */
  guides: boolean;
}

/** On screen, `exp` is absent and everything draws. With `exp` (Phase 5.3 export), only the
 * artwork at the current zoom/pan: background (optional), fills, Fair strokes, and — when
 * included — Construction/Extension at exactly their on-screen grade. No selection, previews,
 * points, node inset or any other interaction feedback. */
export function render(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform, exp?: ArtworkExport): void {
  ctx.save();
  ctx.clearRect(0, 0, view.w, view.h);
  if (!exp || exp.background) {
    ctx.fillStyle = color.plaster;
    ctx.fillRect(0, 0, view.w, view.h);
  }
  drawFills(ctx, controller, view, !exp);
  if (!exp) drawFairRunHalo(ctx, controller, view);
  drawEntities(ctx, controller, view, exp);
  if (exp) {
    ctx.restore();
    return;
  }
  drawSelectionHighlights(ctx, controller.doc, view, controller.selection);
  drawPressHighlight(ctx, controller, view);
  drawIncircle(ctx, controller, view);
  drawCopyRadius(ctx, controller, view);
  drawFairTracePreview(ctx, controller, view);
  drawArcMeasure(ctx, controller, view);
  drawPreview(ctx, controller, view);
  drawDividePreview(ctx, controller, view);
  drawSweep(ctx, controller);
  drawFillDiagnostic(ctx, controller, view);
  drawPointEdit(ctx, controller, view);
  if (!controller.viewGesture) drawPoints(ctx, controller, view);
  drawPendingAnchor(ctx, controller, view);
  drawFairRunMarkers(ctx, controller, view);
  drawLineChoice(ctx, controller, view);
  drawSnapFeedback(ctx, controller, view);
  drawNodeInset(ctx, controller, view);
  drawPrecisionLoupe(ctx, controller, view);
  ctx.restore();
}
