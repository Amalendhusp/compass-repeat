import type { Doc, Entity, Point, PointId, SegmentKey, SegmentState, Vec2 } from '../model/types.ts';
import type { AppController, SelectCandidate, ViewTransform } from '../app/controller.ts';
import { resolveEntityGeom, resolvePoint } from '../geometry/kernel.ts';
import { defaultSegmentKind, deriveSegments, segmentKey, type DerivedSegment } from '../geometry/segments.ts';
import { computeConstructionRegions, computeDirectHoles, computeFairRegions } from '../geometry/regions.ts';
import { isFramePoint, isPointOrphanedByTrim, isPointUsed } from '../geometry/usage.ts';
import { dist } from '../geometry/vec.ts';
import { refLocation } from '../interaction/pointref.ts';
import { color, font, stroke } from './tokens.ts';
import { worldToScreen } from '../app/controller.ts';
import { makePath } from './svgContext.ts';

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
  const draft = live ? controller.fairTrace?.draft : undefined;
  if (draft?.has(key)) return draft.get(key) ?? undefined;
  return controller.doc.segmentStates.get(key);
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
function drawEntities(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform, exp?: ArtworkExport): void {
  const doc = controller.doc;
  const showConstruction = !exp || exp.construction;
  const baseWidth = view.zoom < 0.6 ? 0.6 : stroke.construction;
  // Phase 4: this file's own §4.10 comment always intended Fill to fade construction the same
  // way Fair does — never wired up before because Fill didn't exist yet.
  const quiet = controller.tool === 'fair' || controller.tool === 'fill';
  const quietAlpha = controller.fairTrace ? TRACING_CONSTRUCTION_ALPHA : QUIET_CONSTRUCTION_ALPHA;
  for (const e of doc.entities) {
    const segs = deriveSegments(doc, e);
    if (segs.length === 0) {
      if (!showConstruction) continue;
      wholeEntityPath(ctx, doc, view, e);
      ctx.strokeStyle = color.construction;
      ctx.lineWidth = baseWidth;
      ctx.setLineDash([]);
      ctx.globalAlpha = quiet ? quietAlpha : 1;
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
        ctx.setLineDash(kind === 'extension' ? stroke.extensionDash : []);
        ctx.globalAlpha = quiet ? quietAlpha : 1;
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
        for (const seg of deriveSegments(doc, entity)) {
          if (!cand.keys.includes(seg.key)) continue;
          segmentPath(ctx, doc, view, entity, seg.fromParam, seg.toParam);
          ctx.stroke();
        }
        continue;
      }
      const segs = deriveSegments(doc, entity);
      if (segs.length === 0) {
        wholeEntityPath(ctx, doc, view, entity);
        ctx.stroke();
        continue;
      }
      for (const seg of segs) {
        if ((doc.segmentStates.get(seg.key)?.state ?? 'construction') === 'trimmed') continue;
        segmentPath(ctx, doc, view, entity, seg.fromParam, seg.toParam);
        ctx.stroke();
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

  ctx.restore(); // clip

  ctx.beginPath();
  ctx.arc(c.x, c.y, NODE_INSET_RADIUS, 0, Math.PI * 2);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color.ink;
  ctx.stroke();
  ctx.restore();
}

const PRECISION_LOUPE_RADIUS = 66;

/**
 * Phase 2H: the full precision loupe (§5.4 / §2's press-then-slide). Explicit candidates always
 * outrank implicit ones already (they're never mixed in by the caller when Point Lock is on —
 * see interaction/precision.ts), so this only has to draw whichever candidate set it was given,
 * magnified enough to sit ≥24pt apart, with a slow-tracking reticle over the active one.
 */
function drawPrecisionLoupe(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const s = controller.precision;
  if (!s || s.candidates.length === 0) return;
  const clusterScreen = worldToScreen(view, s.anchorWorld);
  const candidateScreens = s.candidates.map((c) => worldToScreen(view, c.at));

  let minPair = Infinity;
  for (let i = 0; i < candidateScreens.length; i++) {
    for (let j = i + 1; j < candidateScreens.length; j++) minPair = Math.min(minPair, dist(candidateScreens[i]!, candidateScreens[j]!));
  }
  if (!isFinite(minPair) || minPair < 1) minPair = 4;
  const magnification = Math.min(8, Math.max(4, 24 / minPair));
  const c = loupeCenter(s.anchorScreen, PRECISION_LOUPE_RADIUS, view);

  ctx.save();
  ctx.strokeStyle = color.hairline;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(s.anchorScreen.x, s.anchorScreen.y);
  ctx.lineTo(c.x, c.y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.shadowColor = 'rgba(30,42,54,0.28)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 5;
  ctx.beginPath();
  ctx.arc(c.x, c.y, PRECISION_LOUPE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = color.plaster;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  ctx.save();
  ctx.beginPath();
  ctx.arc(c.x, c.y, PRECISION_LOUPE_RADIUS - 2, 0, Math.PI * 2);
  ctx.clip();

  const toLocal = (real: Vec2): Vec2 => ({ x: c.x + (real.x - clusterScreen.x) * magnification, y: c.y + (real.y - clusterScreen.y) * magnification });

  s.candidates.forEach((_cand, i) => {
    const local = toLocal(candidateScreens[i]!);
    const active = i === s.activeIndex;
    ctx.beginPath();
    ctx.arc(local.x, local.y, active ? 11 : 8, 0, Math.PI * 2);
    ctx.fillStyle = active ? color.signal : color.paper;
    ctx.fill();
    ctx.strokeStyle = color.signal;
    ctx.lineWidth = active ? 2 : 1.4;
    ctx.stroke();
    ctx.fillStyle = active ? color.paper : color.ink;
    ctx.font = `600 11px ${font.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), local.x, local.y + 0.5);
  });

  // The reticle: a slow-tracking crosshair independent of the numbered candidates, so the
  // participant can see exactly how their finger's fine movement is being read.
  const reticleLocal = toLocal(worldToScreen(view, s.reticleWorld));
  ctx.strokeStyle = color.ink;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(reticleLocal.x - 11, reticleLocal.y);
  ctx.lineTo(reticleLocal.x - 4, reticleLocal.y);
  ctx.moveTo(reticleLocal.x + 4, reticleLocal.y);
  ctx.lineTo(reticleLocal.x + 11, reticleLocal.y);
  ctx.moveTo(reticleLocal.x, reticleLocal.y - 11);
  ctx.lineTo(reticleLocal.x, reticleLocal.y - 4);
  ctx.moveTo(reticleLocal.x, reticleLocal.y + 4);
  ctx.lineTo(reticleLocal.x, reticleLocal.y + 11);
  ctx.stroke();

  ctx.restore(); // clip

  ctx.beginPath();
  ctx.arc(c.x, c.y, PRECISION_LOUPE_RADIUS, 0, Math.PI * 2);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color.ink;
  ctx.stroke();
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
function drawPendingAnchor(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform): void {
  const pending = controller.pending;
  if (!pending) return;
  const doc = controller.doc;
  // Phase 5.6: Arc's A is highlighted while B is chosen; once the compass is open, its own centre
  // marker and the measuring line take over (drawArcCompass).
  const refs = pending.kind === 'circle' ? [pending.centre] : pending.kind === 'line' ? [pending.a] : pending.stage === 'measure-b' ? [pending.a] : [];

  refs.forEach((ref, i) => {
    const at = refLocation(doc, ref);
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
  const p = doc.points.find((pt) => pt.id === id);
  return p?.kind === 'free' && !!p.hidden;
}

function isPendingAnchorPoint(controller: AppController, pointId: PointId): boolean {
  const pending = controller.pending;
  if (!pending) return false;
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
  if (mode !== 'none' && doc.points.find((p) => p.id === pointId)?.kind === 'division') return true;

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
  drawEntities(ctx, controller, view, exp);
  if (exp) {
    ctx.restore();
    return;
  }
  drawSelectionHighlights(ctx, controller.doc, view, controller.selection);
  drawFairTracePreview(ctx, controller, view);
  drawArcMeasure(ctx, controller, view);
  drawPreview(ctx, controller, view);
  drawDividePreview(ctx, controller, view);
  drawSweep(ctx, controller);
  drawFillDiagnostic(ctx, controller, view);
  drawPointEdit(ctx, controller, view);
  drawPoints(ctx, controller, view);
  drawPendingAnchor(ctx, controller, view);
  drawNodeInset(ctx, controller, view);
  drawPrecisionLoupe(ctx, controller, view);
  ctx.restore();
}
