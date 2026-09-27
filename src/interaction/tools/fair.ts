// Fair tool — promotes existing Construction/Extension pieces to Fair (and back); it never creates
// geometry. Segment STATE STORAGE stays granular (one state per piece between intersections), so
// Fill and Repeat see exactly the same topology whichever way the pieces were chosen.
//
// Phase 5.9 — the finger says what it means:
// - Press, drag along the drawing, release (the primary interaction). The finger's path is
//   followed piece by piece: at every crossing the continuation lying closest to where the finger
//   actually goes is taken (straight on, when the finger goes straight on); moving toward another
//   branch steers onto it; moving back un-does the last piece. The followed path is highlighted
//   live, ordinary point markers are hidden, and release commits it as one undo step.
// - Tap (Phase 5.10): Fair / un-Fair ONE segment — the piece between the two intersections under
//   the finger, nothing beyond them. Pressing already shows that segment strongly, so what a tap
//   will do is visible before the finger lifts. Where several curves compete, a tap does nothing
//   but say "Trace the line you want".
// - Long-press (deliberate, advanced): the whole run — a straight line through its crossings, a
//   circle's arc between design junctions — previewed while held; lifting commits it, sliding
//   away cancels. Where curves compete, the long-press opens the "Which line?" chooser instead.

import type { Doc, Entity, PointId, SegmentKey, SegmentState, Vec2 } from '../../model/types.ts';
import type { AppController, FairRun, ViewTransform } from '../../app/controller.ts';
import { screenToWorld, worldToScreen } from '../../app/controller.ts';
import { resolveEntityGeom, resolvePoint } from '../../geometry/kernel.ts';
import { deriveSegments, deriveSelectableGroups, fairSegmentState, groupContainingParam, segmentKey, unfairedSegmentState, type DerivedSegment } from '../../geometry/segments.ts';
import { angleBetween, otherEndpoint, outgoingTangent, segmentsAtJunction } from '../../geometry/trace.ts';
import { dist } from '../../geometry/vec.ts';
import { curveCandidatesAt, curveDistanceAt, segmentContainingParam } from '../hittest.ts';
import { ensureCircleSegments, setSegmentFair } from '../../model/doc.ts';
import type { Gesture, ToolModule } from './types.ts';

function fairStateFor(controller: AppController, entity: Entity, seg: DerivedSegment): SegmentState {
  return fairSegmentState(controller.doc, entity, seg, controller.doc.fairDefaults);
}

/** Phase 3.4 item 1 / Phase 5.6: demote back to the role the piece had before it was Faired
 * (remembered on its Fair state — see segments.ts), null meaning "no entry: the default". */
function revertState(controller: AppController, entity: Entity, seg: DerivedSegment): SegmentState | null {
  return unfairedSegmentState(controller.doc, entity, seg);
}

// ---- Smart Fair: a tap on a straight line takes its whole continuous run ----


interface RunPiece {
  entity: Entity;
  seg: DerivedSegment;
}

const isFairKey = (doc: Doc, key: SegmentKey) => doc.segmentStates.get(key)?.state === 'fair';
const isTrimmedKey = (doc: Doc, key: SegmentKey) => doc.segmentStates.get(key)?.state === 'trimmed';

/** For an Extension line, a run stays on the side of the line it started on: its own a–b span, or
 * one of the tails beyond it — never spilling from the finite span out along the infinite line. */
function spanSide(entity: Entity, s: DerivedSegment): number {
  if (entity.kind !== 'line' || !entity.extended) return 0;
  const mid = (s.fromParam + s.toParam) / 2;
  return mid < -1e-9 ? -1 : mid > 1 + 1e-9 ? 1 : 0;
}

/**
 * The continuous straight run through `seed` on its line: neighbouring pieces are added through
 * every crossing — a crossing is not a change of direction — while they share the seed's Fair
 * status; it stops at a trimmed gap, a status change, or the end of the line's span. At the end of
 * the line it carries on along a collinear line meeting it there, but only when exactly one does
 * (more than one is an ambiguous branch, so it stops). Circles aren't runs: an arc is usually meant
 * to be only part of its circle, so a circle tap keeps its single piece.
 */
function straightRun(doc: Doc, entity: Entity, seed: DerivedSegment): RunPiece[] {
  if (entity.kind !== 'line') return [{ entity, seg: seed }];
  const wantFair = isFairKey(doc, seed.key);
  const out: RunPiece[] = [];
  const seen = new Set<SegmentKey>();

  const walk = (e: Entity, start: DerivedSegment, dir: 1 | -1, fromPoint: string | null): void => {
    const segs = deriveSegments(doc, e);
    let i = segs.findIndex((s) => s.key === start.key);
    const side = spanSide(e, start);
    let lastEnd = fromPoint;
    while (i >= 0 && i < segs.length) {
      const s = segs[i]!;
      if (seen.has(s.key) || isTrimmedKey(doc, s.key) || isFairKey(doc, s.key) !== wantFair || spanSide(e, s) !== side) break;
      seen.add(s.key);
      out.push({ entity: e, seg: s });
      lastEnd = dir === 1 ? s.to : s.from;
      i += dir;
    }
    if (i >= 0 && i < segs.length) return; // stopped by something on this line
    if (!lastEnd) return;
    // End of this line: one collinear line continuing from here? Then keep going along it.
    const g = resolveEntityGeom(doc, e);
    if (g.kind !== 'line') return;
    const next: { e: Entity; s: DerivedSegment; dir: 1 | -1 }[] = [];
    for (const other of doc.entities) {
      if (other.id === e.id || other.kind !== 'line') continue;
      const og = resolveEntityGeom(doc, other);
      if (og.kind !== 'line' || Math.abs(g.dir.x * og.dir.y - g.dir.y * og.dir.x) > 1e-6) continue;
      const osegs = deriveSegments(doc, other);
      const same = g.dir.x * og.dir.x + g.dir.y * og.dir.y > 0 ? dir : ((-dir) as 1 | -1);
      const cont = osegs.find((s) => (same === 1 ? s.from : s.to) === lastEnd);
      if (cont && !seen.has(cont.key)) next.push({ e: other, s: cont, dir: same });
    }
    if (next.length === 1) walk(next[0]!.e, next[0]!.s, next[0]!.dir, lastEnd);
  };

  walk(entity, seed, 1, null);
  seen.delete(seed.key); // let the backward walk start from the seed again…
  const before = out.length;
  walk(entity, seed, -1, null);
  out.splice(before, 1); // …without listing it twice
  return out;
}

function selectableGroupHere(doc: Doc, entity: Entity, param: number) {
  const groups = deriveSelectableGroups(doc, entity);
  return groupContainingParam(groups, param, entity.kind === 'circle');
}

// ---- Tap runs, and the curves a tap could mean (Phase 5.8) ----

/** How much farther than the nearest curve another curve may be and still count as "could be
 * meant" — relative to how exactly the nearest was hit: a tap right on one line competes only with
 * curves within LINE_AMBIGUITY_MIN_PX; the window widens (up to LINE_AMBIGUITY_PX) as the tap
 * itself lands farther off, since then the finger evidently isn't that precise. */
const LINE_AMBIGUITY_PX = 3.5;
const LINE_AMBIGUITY_MIN_PX = 1.5;
const lineWindow = (d1: number) => Math.min(LINE_AMBIGUITY_PX, Math.max(LINE_AMBIGUITY_MIN_PX, 1.5 * d1));
/** Curves running alongside the nearest one (a tangent arc, a coincident or nearly coincident line)
 * get the full window — their runs can't be told apart by looking at a preview. A curve that
 * merely CROSSES the nearest one near the tap is obviously different in the preview itself (and
 * Preview → Confirm makes a wrong guess cost one Cancel), so it competes only when about as close. */
const ALONGSIDE_DEG = 20;

/** Unit tangent of a curve at a param (world space). */
function tangentAt(doc: Doc, entity: Entity, param: number): Vec2 {
  const g = resolveEntityGeom(doc, entity);
  if (g.kind === 'line') return g.dir;
  return { x: -Math.sin(param), y: Math.cos(param) };
}

function plausibleCurves(doc: Doc, all: CurveHit[]): CurveHit[] {
  const first = all[0]!;
  const t1 = tangentAt(doc, first.entity, first.param);
  return all.filter((c, i) => {
    if (i === 0) return true;
    const t = tangentAt(doc, c.entity, c.param);
    const angle = (Math.acos(Math.min(1, Math.abs(t1.x * t.x + t1.y * t.y))) * 180) / Math.PI;
    const window = angle <= ALONGSIDE_DEG ? lineWindow(first.d) : LINE_AMBIGUITY_MIN_PX;
    return c.d <= first.d + window;
  });
}
/** Runs whose every part lies within this of the other's are the same visible result. */
const SAME_RUN_PX = 1;
/** Where a "Which line?" badge sits along its run, measured from the tap. */
const BADGE_DISTANCE_PX = 40;

/** Point ids used by exactly one piece — the open ends of a run (none for a closed loop). */
function openEnds(pieces: [PointId, PointId][]): PointId[] {
  const count = new Map<PointId, number>();
  for (const [a, b] of pieces) {
    count.set(a, (count.get(a) ?? 0) + 1);
    count.set(b, (count.get(b) ?? 0) + 1);
  }
  return [...count].filter(([, n]) => n === 1).map(([id]) => id);
}

function describe(entity: Entity, hit: CurveHit, n: number, fairing: boolean, isTap: boolean): { label: string; detail: string } {
  let label: string;
  if (entity.kind === 'circle') label = isTap ? 'Circle arc' : 'Traced path';
  else if (!isTap) label = 'Traced path';
  else if (entity.extended) label = hit.param < -1e-9 || hit.param > 1 + 1e-9 ? 'Extension line (beyond its points)' : 'Extension line';
  else label = 'Straight line';
  const detail = `${n} piece${n === 1 ? '' : 's'}${fairing ? '' : ' · remove Fair'}`;
  return { label, detail };
}

/** A tap's run on one curve: the straight run through crossings for a line, the selectable group
 * for a circle, or the whole circle when it has no pieces yet. */
function tapRun(controller: AppController, view: ViewTransform, hit: CurveHit, tapScreen: Vec2): FairRun | null {
  const doc = controller.doc;
  const { entity } = hit;
  const segs = deriveSegments(doc, entity);
  if (segs.length === 0) {
    const g = resolveEntityGeom(doc, entity);
    const badge = g.kind === 'circle' ? { x: g.centre.x + Math.cos(hit.param) * g.radius, y: g.centre.y + Math.sin(hit.param) * g.radius } : g.a;
    return { label: 'Whole circle', detail: 'the whole curve', keys: [], draft: new Map(), fairing: true, whole: entity.id, ends: [], badgeAt: badge };
  }
  const seg = segmentContainingParam(segs, hit.param, entity.kind === 'circle');
  if (!seg) return null;
  const fairing = (doc.segmentStates.get(seg.key)?.state ?? 'construction') !== 'fair';
  const group = selectableGroupHere(doc, entity, hit.param);
  const pieces: RunPiece[] = entity.kind === 'line' ? straightRun(doc, entity, seg) : (group?.segments ?? [seg]).map((s) => ({ entity, seg: s }));
  const draft = new Map<SegmentKey, SegmentState | null>();
  for (const p of pieces) {
    const k = segmentKey(p.entity.id, p.seg.from, p.seg.to);
    draft.set(k, fairing ? fairStateFor(controller, p.entity, p.seg) : revertState(controller, p.entity, p.seg));
  }
  const ends = openEnds(pieces.map((p) => [p.seg.from, p.seg.to] as [PointId, PointId])).map((id) => resolvePoint(doc, id));
  return { ...describe(entity, hit, pieces.length, fairing, true), keys: [...draft.keys()], draft, fairing, whole: null, ends, badgeAt: badgePoint(doc, view, pieces, tapScreen) };
}

/** Phase 5.10: a tap's scope — just the segment under the finger (its selectable group: the piece
 * between the two split points around the tap), or a whole untouched circle. */
function segmentRun(controller: AppController, view: ViewTransform, hit: CurveHit, tapScreen: Vec2): FairRun | null {
  const doc = controller.doc;
  const { entity } = hit;
  const segs = deriveSegments(doc, entity);
  if (segs.length === 0) return tapRun(controller, view, hit, tapScreen);
  const seg = segmentContainingParam(segs, hit.param, entity.kind === 'circle');
  if (!seg) return null;
  const fairing = (doc.segmentStates.get(seg.key)?.state ?? 'construction') !== 'fair';
  const group = selectableGroupHere(doc, entity, hit.param);
  const pieces: RunPiece[] = (group?.segments ?? [seg]).map((s) => ({ entity, seg: s }));
  const draft = new Map<SegmentKey, SegmentState | null>();
  for (const p of pieces) draft.set(p.seg.key, fairing ? fairStateFor(controller, p.entity, p.seg) : revertState(controller, p.entity, p.seg));
  const ends = openEnds(pieces.map((p) => [p.seg.from, p.seg.to] as [PointId, PointId])).map((id) => resolvePoint(doc, id));
  return { label: fairing ? 'Segment' : 'Segment · remove Fair', detail: '1 segment', keys: [...draft.keys()], draft, fairing, whole: null, ends, badgeAt: badgePoint(doc, view, pieces, tapScreen) };
}

function paramAt(g: ReturnType<typeof resolveEntityGeom>, t: number): Vec2 {
  if (g.kind === 'circle') return { x: g.centre.x + Math.cos(t) * g.radius, y: g.centre.y + Math.sin(t) * g.radius };
  return { x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t };
}

/** Sample points along a piece (world), ends included. */
function pieceSamples(doc: Doc, entity: Entity, from: number, to: number, n = 6): Vec2[] {
  const g = resolveEntityGeom(doc, entity);
  let span = to - from;
  if (g.kind === 'circle' && span <= 0) span += Math.PI * 2;
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) out.push(paramAt(g, from + (span * i) / n));
  return out;
}

/** A point on the run about BADGE_DISTANCE_PX from the tap, so crossing runs' badges separate. */
function badgePoint(doc: Doc, view: ViewTransform, pieces: RunPiece[], tapScreen: Vec2): Vec2 {
  let best: Vec2 | null = null;
  let bestScore = Infinity;
  for (const p of pieces) {
    for (const w of pieceSamples(doc, p.entity, p.seg.fromParam, p.seg.toParam, 12)) {
      const s = worldToScreen(view, w);
      if (s.x < 16 || s.y < 16 || s.x > view.w - 16 || s.y > view.h - 16) continue;
      const score = Math.abs(dist(s, tapScreen) - BADGE_DISTANCE_PX);
      if (score < bestScore) {
        bestScore = score;
        best = w;
      }
    }
  }
  return best ?? resolvePoint(doc, pieces[0]!.seg.from);
}

/** Screen distance from `sp` to one drafted piece (by key). */
function keyDistancePx(doc: Doc, view: ViewTransform, key: SegmentKey, sp: Vec2): number {
  const entity = doc.entities.find((e) => key.startsWith(`${e.id}:`));
  if (!entity) return Infinity;
  const seg = deriveSegments(doc, entity).find((s) => s.key === key);
  if (!seg) return Infinity;
  const pts = pieceSamples(doc, entity, seg.fromParam, seg.toParam, entity.kind === 'circle' ? 24 : 1).map((w) => worldToScreen(view, w));
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((sp.x - a.x) * dx + (sp.y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(a.x + dx * t - sp.x, a.y + dy * t - sp.y));
  }
  return best;
}

function runSamples(doc: Doc, view: ViewTransform, run: FairRun): Vec2[] {
  if (run.whole) {
    const e = doc.entities.find((x) => x.id === run.whole);
    return e ? pieceSamples(doc, e, 0, Math.PI * 2, 24).map((w) => worldToScreen(view, w)) : [];
  }
  const out: Vec2[] = [];
  for (const k of run.keys) {
    const entity = doc.entities.find((e) => k.startsWith(`${e.id}:`));
    const seg = entity ? deriveSegments(doc, entity).find((s) => s.key === k) : undefined;
    if (entity && seg) out.push(...pieceSamples(doc, entity, seg.fromParam, seg.toParam, 4).map((w) => worldToScreen(view, w)));
  }
  return out;
}

function runDistancePx(doc: Doc, view: ViewTransform, run: FairRun, sp: Vec2): number {
  if (run.whole) {
    const e = doc.entities.find((x) => x.id === run.whole);
    return e ? curveDistanceAt(doc, view, e, sp).d : Infinity;
  }
  let best = Infinity;
  for (const k of run.keys) best = Math.min(best, keyDistancePx(doc, view, k, sp));
  return best;
}

/** Two candidate runs that would look exactly the same once Faired are one choice, not two. */
function sameVisibleRun(doc: Doc, view: ViewTransform, a: FairRun, b: FairRun): boolean {
  if (a.fairing !== b.fairing) return false;
  return runSamples(doc, view, a).every((s) => runDistancePx(doc, view, b, s) <= SAME_RUN_PX) && runSamples(doc, view, b).every((s) => runDistancePx(doc, view, a, s) <= SAME_RUN_PX);
}

function candidateRuns(controller: AppController, view: ViewTransform, hits: CurveHit[], tapScreen: Vec2): FairRun[] {
  const runs: FairRun[] = [];
  for (const h of hits) {
    const r = tapRun(controller, view, h, tapScreen);
    if (!r) continue;
    if (runs.some((x) => sameVisibleRun(controller.doc, view, x, r))) continue;
    runs.push(r);
  }
  // Coincident lines with different extents read as "longer"/"shorter" — the shape tells them apart.
  const lens = runs.map((r) => runSamples(controller.doc, view, r).length);
  if (runs.length === 2 && runs.every((r) => r.label === runs[0]!.label)) {
    const longer = lens[0]! >= lens[1]! ? 0 : 1;
    runs[longer]!.detail += ' · longer';
    runs[1 - longer]!.detail += ' · shorter';
  }
  return runs;
}


// ---- Phase 5.9: the path follower ----

type CurveHit = { entity: Entity; param: number; d: number };

const TRACE_START_PX = 9; // finger travel before a press becomes a trace
const RESTART_WITHIN_PX = 150; // while the trace is this young, its starting curve can still be re-decided
const RESTART_MARGIN_PX = 1.5;
const ADVANCE_PX = 8; // finger this far past a junction before its next piece is decided
const STEER_PX = 4; // another branch must be this much closer before the path switches to it
const DETOUR_MAX_PIECES = 6; // a corner-cutting detour this short…
const DETOUR_MAX_PX = 50; // …is straightened to the real corner on release
const RECOVER_LINKS = 16; // how far back along the path a wrong turn can still be undone by moving away from it
const HEADING_SPAN_PX = 30; // the finger's recent direction is read over this much of its path
const HEADING_MIN_PX = 16;
const HEADING_WEIGHT_PX = 14; // a branch at 90° to the finger's direction counts this much further away
const STEER_MIN_OFF_PX = 7; // …and the finger at least this far off the straight line
const STRAIGHT_BIAS_PX = 6; // straight on through a crossing wins unless another branch is this much nearer
const BACK_PX = 6;
const LONG_PRESS_MS = 520;
const CUE_MS = 1900;
const LONG_CUE_MS = 6000;
const LONG_CANCEL_PX = 16; // after a long-press, sliding this far away cancels the whole-run preview

/** One piece in screen space, oriented from seg.from to seg.to. */
type PieceGeom = { kind: 'line'; a: Vec2; b: Vec2 } | { kind: 'arc'; c: Vec2; r: number; from: number; span: number };

function pieceGeom(doc: Doc, view: ViewTransform, entity: Entity, seg: DerivedSegment): PieceGeom {
  const g = resolveEntityGeom(doc, entity);
  if (g.kind === 'circle') {
    let span = seg.toParam - seg.fromParam;
    if (span <= 0) span += Math.PI * 2;
    return { kind: 'arc', c: worldToScreen(view, g.centre), r: g.radius * view.zoom, from: seg.fromParam, span };
  }
  return { kind: 'line', a: worldToScreen(view, resolvePoint(doc, seg.from)), b: worldToScreen(view, resolvePoint(doc, seg.to)) };
}

/** Where `p` falls along a piece (0 = seg.from, 1 = seg.to, clamped) and how far off it is. */
function project(g: PieceGeom, p: Vec2): { u: number; d: number } {
  if (g.kind === 'line') {
    const dx = g.b.x - g.a.x;
    const dy = g.b.y - g.a.y;
    const len2 = dx * dx + dy * dy;
    const u = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - g.a.x) * dx + (p.y - g.a.y) * dy) / len2));
    return { u, d: Math.hypot(g.a.x + dx * u - p.x, g.a.y + dy * u - p.y) };
  }
  const TWO_PI = Math.PI * 2;
  let rel = Math.atan2(p.y - g.c.y, p.x - g.c.x) - g.from;
  rel = ((rel % TWO_PI) + TWO_PI) % TWO_PI;
  if (rel <= g.span) return { u: rel / g.span, d: Math.abs(Math.hypot(p.x - g.c.x, p.y - g.c.y) - g.r) };
  const pastEnd = rel - g.span;
  const beforeStart = TWO_PI - rel;
  const u = pastEnd < beforeStart ? 1 : 0;
  const t = g.from + g.span * u;
  return { u, d: Math.hypot(g.c.x + Math.cos(t) * g.r - p.x, g.c.y + Math.sin(t) * g.r - p.y) };
}

/**
 * How far `p` is from where a piece is HEADING when entered at its `fromStart` end: the piece and
 * its continuation beyond the far end (a line's ray, an arc's circle for another quarter turn). A
 * fast finger can pass several short pieces in one sample — the one it is travelling along must
 * still read as close, not as far as its (already passed) far end.
 */
function reach(g: PieceGeom, p: Vec2, fromStart: boolean): number {
  if (g.kind === 'line') {
    const E = fromStart ? g.a : g.b;
    const X = fromStart ? g.b : g.a;
    const dx = X.x - E.x;
    const dy = X.y - E.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 < 1e-9 ? 0 : ((p.x - E.x) * dx + (p.y - E.y) * dy) / len2;
    if (t <= 0) return Math.hypot(p.x - E.x, p.y - E.y);
    return Math.abs((p.x - E.x) * dy - (p.y - E.y) * dx) / Math.sqrt(len2);
  }
  const TWO_PI = Math.PI * 2;
  const ang = Math.atan2(p.y - g.c.y, p.x - g.c.x);
  // angle travelled from the entry end, in the direction of travel
  let rel = fromStart ? ang - g.from : g.from + g.span - ang;
  rel = ((rel % TWO_PI) + TWO_PI) % TWO_PI;
  if (rel <= g.span + Math.PI / 2) return Math.abs(Math.hypot(p.x - g.c.x, p.y - g.c.y) - g.r);
  const t = fromStart ? g.from : g.from + g.span;
  return Math.hypot(g.c.x + Math.cos(t) * g.r - p.x, g.c.y + Math.sin(t) * g.r - p.y);
}

interface Link {
  entity: Entity;
  seg: DerivedSegment;
  /** The junction the path entered this piece by (null for the piece it started on). */
  entry: PointId | null;
  exit: PointId;
}

/**
 * Follows the finger along the drawing. Pure bookkeeping over existing pieces — which ones the
 * path has taken, in order — recomputed from every finger sample, never guessing ahead: the next
 * piece is only chosen once the finger is past the junction and one continuation is clearly the
 * one it is travelling along.
 */
class PathFollower {
  links: Link[] = [];
  waiting: { leader: SegmentKey; runnerUp: SegmentKey | null } | null = null;
  private readonly geomCache = new Map<SegmentKey, PieceGeom>();

  private readonly doc: Doc;
  private readonly view: ViewTransform;
  readonly fairing: boolean;

  constructor(doc: Doc, view: ViewTransform, fairing: boolean, start: { entity: Entity; seg: DerivedSegment }, towards: Vec2, press: Vec2) {
    this.doc = doc;
    this.view = view;
    this.fairing = fairing;
    const g = this.geom(start.entity, start.seg);
    const uPress = project(g, press).u;
    const uNow = project(g, towards).u;
    const forward = Math.abs(uNow - uPress) > 1e-3 ? uNow > uPress : dist(towards, this.pointScreen(start.seg.to)) < dist(towards, this.pointScreen(start.seg.from));
    this.links.push({ entity: start.entity, seg: start.seg, entry: null, exit: forward ? start.seg.to : start.seg.from });
  }

  private geom(entity: Entity, seg: DerivedSegment): PieceGeom {
    let g = this.geomCache.get(seg.key);
    if (!g) {
      g = pieceGeom(this.doc, this.view, entity, seg);
      this.geomCache.set(seg.key, g);
    }
    return g;
  }

  private pointScreen(id: PointId): Vec2 {
    return worldToScreen(this.view, resolvePoint(this.doc, id));
  }

  /** Oriented progress along a link (0 at its entry side, 1 at its exit) and distance off it. */
  private along(l: Link, p: Vec2): { u: number; d: number } {
    const r = project(this.geom(l.entity, l.seg), p);
    return { u: l.exit === l.seg.to ? r.u : 1 - r.u, d: r.d };
  }

  /** The direction of travel leaving a link at its exit (screen = world directions here). */
  private headingAt(l: Link): Vec2 {
    const t = outgoingTangent(this.doc, l.entity, l.seg, l.exit);
    return { x: -t.x, y: -t.y };
  }

  /** The pieces the path could take from junction `at` — a Fair removal only follows Fair pieces. */
  private branches(at: PointId, exclude: Set<SegmentKey>): { entity: Entity; seg: DerivedSegment }[] {
    return segmentsAtJunction(this.doc, at, null).filter((c) => !exclude.has(c.seg.key) && (this.fairing || this.doc.segmentStates.get(c.seg.key)?.state === 'fair'));
  }

  /** The finger's recent direction (its last ~30 px), or null while too short to trust. */
  private trail: Vec2[] = [];
  private heading(): Vec2 | null {
    const t = this.trail;
    if (t.length < 2) return null;
    const h = { x: t[t.length - 1]!.x - t[0]!.x, y: t[t.length - 1]!.y - t[0]!.y };
    return Math.hypot(h.x, h.y) >= HEADING_MIN_PX ? h : null;
  }

  /** A branch's distance from the finger, plus a penalty for leaving the way the finger is going:
   * a finger drifting a few px beside its line is still travelling ALONG it, not onto a branch. */
  private score(d: number, dir: Vec2): number {
    const h = this.heading();
    if (!h) return d;
    const a = angleBetween(dir, h);
    return d + HEADING_WEIGHT_PX * (a >= 90 ? 1 : Math.sin((a * Math.PI) / 180));
  }

  update(p: Vec2): void {
    this.waiting = null;
    this.trail.push(p);
    while (this.trail.length > 2) {
      let len = 0;
      for (let i = 2; i < this.trail.length; i++) len += dist(this.trail[i - 1]!, this.trail[i]!);
      if (len < HEADING_SPAN_PX) break;
      this.trail.shift();
    }
    for (let guard = 0; guard < 80; guard++) {
      const L = this.links[this.links.length - 1]!;
      const here = this.along(L, p);

      // Back along the path: the finger has returned past this piece's entry — retract to the
      // earlier piece of the path it is now on (pieces can be tiny, so look back several).
      if (this.links.length >= 2 && here.u <= 1e-3 && L.entry && dist(p, this.pointScreen(L.entry)) >= BACK_PX) {
        let bestJ = -1;
        let bestD = here.d - 1;
        for (let j = this.links.length - 2; j >= Math.max(0, this.links.length - 1 - RECOVER_LINKS); j--) {
          const dj = this.along(this.links[j]!, p).d;
          if (dj < bestD) {
            bestD = dj;
            bestJ = j;
          }
        }
        if (bestJ >= 0) {
          this.links.length = bestJ + 1;
          continue;
        }
      }
      // The very first piece: the finger went back past where it pressed, and on beyond — turn round.
      if (this.links.length === 1 && here.u <= 1e-3) {
        const back = otherEndpoint(L.seg, L.exit);
        if (dist(p, this.pointScreen(back)) >= ADVANCE_PX) {
          L.exit = back;
          continue;
        }
      }
      // Steering and recovery: the finger has clearly left the path, and a branch at one of the
      // last few junctions is where it actually is — rewind to that junction and take that branch.
      // (Just after a crossing this is "steering onto another branch by moving toward it"; further
      // on it undoes a wrong turn the finger has already walked away from.)
      if (this.links.length >= 2) {
        const from = Math.max(1, this.links.length - RECOVER_LINKS);
        let dPath = Infinity;
        for (let j = from; j < this.links.length; j++) dPath = Math.min(dPath, this.along(this.links[j]!, p).d);
        // …and not merely ahead of the path's end, on the way along one of its continuations.
        if (dPath >= STEER_MIN_OFF_PX) {
          for (const a of this.branches(L.exit, new Set(this.links.map((l) => l.seg.key)))) dPath = Math.min(dPath, reach(this.geom(a.entity, a.seg), p, a.seg.from === L.exit));
        }
        if (dPath >= STEER_MIN_OFF_PX) {
          let alt: { j: number; entity: Entity; seg: DerivedSegment; d: number } | null = null;
          for (let j = this.links.length - 1; j >= from; j--) {
            const lj = this.links[j]!;
            if (!lj.entry) continue;
            const exclude = new Set(this.links.slice(0, j + 1).map((l) => l.seg.key));
            for (const a of this.branches(lj.entry, exclude)) {
              const raw = reach(this.geom(a.entity, a.seg), p, a.seg.from === lj.entry);
              const d = this.score(raw, outgoingTangent(this.doc, a.entity, a.seg, lj.entry));
              if (!alt || d < alt.d) alt = { j, entity: a.entity, seg: a.seg, d };
            }
          }
          const good = (d: number) => d + STEER_PX < dPath && d <= Math.max(3, 0.4 * dPath);
          if (alt && good(alt.d)) {
            const entry = this.links[alt.j]!.entry!;
            this.links.length = alt.j;
            this.links.push({ entity: alt.entity, seg: alt.seg, entry, exit: otherEndpoint(alt.seg, entry) });
            continue;
          }
        }
      }
      // Forward: past the exit junction — take the continuation the finger is actually on.
      if (here.u >= 0.999) {
        const J = this.pointScreen(L.exit);
        const dJ = dist(p, J);
        if (dJ < ADVANCE_PX) break;
        const choice = this.choose(L, p);
        if (!choice) break;
        const { best, second, gap } = choice;
        const clear = best.d <= Math.max(2.5, 0.3 * dJ) && gap >= 2.5;
        // …or clearly the one: every other branch at least twice as far from the finger.
        const dominant = dJ >= 10 && best.d <= 0.6 * dJ && (!second || second.d >= 2 * best.d + 2);
        if (clear || dominant) {
          this.links.push({ entity: best.entity, seg: best.seg, entry: L.exit, exit: otherEndpoint(best.seg, L.exit) });
          continue;
        }
        this.waiting = { leader: best.seg.key, runnerUp: second && gap < 6 ? second.seg.key : null };
      }
      break;
    }
  }

  /**
   * The continuation from `L`'s exit the finger is on: straight on by default (the line being
   * followed, or one lying along it), unless another branch is clearly nearer; branches lying on
   * top of each other count as one. `second` is the nearest genuinely different branch.
   */
  private choose(L: Link, p: Vec2) {
    const cands = this.branches(L.exit, new Set(this.links.map((l) => l.seg.key)))
      .map((c) => {
        const dir = outgoingTangent(this.doc, c.entity, c.seg, L.exit);
        return { ...c, d: this.score(reach(this.geom(c.entity, c.seg), p, c.seg.from === L.exit), dir), dir };
      })
      .sort((a, b) => a.d - b.d);
    let best = cands[0];
    if (!best) return null;
    const inDir = this.headingAt(L);
    const straight = cands.find((c) => c.entity.id === L.entity.id || angleBetween(c.dir, inDir) < 4);
    if (straight && straight.d <= best.d + STRAIGHT_BIAS_PX) best = straight;
    const b0 = best;
    const same = cands.filter((c) => c.d <= b0.d + 2.5 && angleBetween(c.dir, b0.dir) < 4);
    best = same.find((c) => c.entity.id === L.entity.id) ?? best;
    const second = cands.filter((c) => !same.includes(c) && c !== best)[0];
    return { best, second, gap: second ? second.d - best.d : Infinity };
  }

  /** Release: if the finger has already moved on past the last junction and is plainly on one
   * continuation, that piece — the one under the lifted finger — belongs to the path too. */
  finish(p: Vec2): void {
    this.update(p);
    this.straighten();
    const L = this.links[this.links.length - 1]!;
    if (this.along(L, p).u < 0.999) return;
    const J = this.pointScreen(L.exit);
    if (dist(p, J) < 5) return;
    const choice = this.choose(L, p);
    if (!choice || choice.best.d > 7) return;
    const { best, second } = choice;
    if (second && second.d < 2 * best.d + 2) return;
    this.links.push({ entity: best.entity, seg: best.seg, entry: L.exit, exit: otherEndpoint(best.seg, L.exit) });
  }

  /** The next piece of `entity` beyond point `at`, leaving the piece `from` (null at its end or a gap). */
  private nextOnEntity(entity: Entity, at: PointId, from: SegmentKey): DerivedSegment | null {
    for (const sg of deriveSegments(this.doc, entity)) {
      if (sg.key === from || (sg.from !== at && sg.to !== at)) continue;
      if (this.doc.segmentStates.get(sg.key)?.state === 'trimmed') continue;
      if (!this.fairing && this.doc.segmentStates.get(sg.key)?.state !== 'fair') continue;
      return sg;
    }
    return null;
  }

  /** Walks along `entity` from `at` (leaving piece `from`) until `stop(point)`, at most `max` pieces. */
  private walk(entity: Entity, at: PointId, from: SegmentKey, stop: (id: PointId) => boolean, max: number): Link[] | null {
    const out: Link[] = [];
    let cur = at;
    let prev = from;
    for (let k = 0; k < max; k++) {
      const sg = this.nextOnEntity(entity, cur, prev);
      if (!sg) return null;
      const exit = otherEndpoint(sg, cur);
      out.push({ entity, seg: sg, entry: cur, exit });
      if (stop(exit)) return out;
      cur = exit;
      prev = sg.key;
    }
    return null;
  }

  /**
   * A finger rounding a corner cuts across whatever tiny triangle of other lines sits inside it.
   * When the path leaves line A for a short detour and then continues along line B, and A and B
   * themselves meet just there, the path is straightened to that real corner: A to the crossing,
   * then B — which is what the eye (and the finger) meant.
   */
  private straighten(): void {
    for (let i = 0; i + 2 < this.links.length; i++) {
      const a = this.links[i]!;
      if (this.links[i + 1]!.entity.id === a.entity.id) continue;
      let len = 0;
      for (let j = i + 1; j < this.links.length && j <= i + 1 + DETOUR_MAX_PIECES; j++) {
        const lj = this.links[j]!;
        if (lj.entity.id === a.entity.id) break;
        const inDetour = j > i + 1 ? this.links.slice(i + 1, j) : [];
        if (inDetour.length && lj.entity.id !== inDetour[inDetour.length - 1]!.entity.id && lj.entry) {
          const B = lj.entity;
          const toCorner = this.walk(a.entity, a.exit, a.seg.key, (id) => deriveSegments(this.doc, B).some((sg) => sg.from === id || sg.to === id), 6);
          if (toCorner) {
            const corner = toCorner[toCorner.length - 1]!.exit;
            const firstB = deriveSegments(this.doc, B).find((sg) => (sg.from === corner || sg.to === corner) && sg.key !== lj.seg.key);
            const alongB = firstB ? this.walk(B, corner, '', (id) => id === lj.entry, 6) : null;
            const alongB2 = alongB ?? this.walk(B, corner, firstB?.key ?? '', (id) => id === lj.entry, 6);
            const route = lj.entry === corner ? [] : alongB2;
            if (route) {
              this.links.splice(i + 1, j - (i + 1), ...toCorner, ...route);
              break;
            }
          }
        }
        len += dist(this.pointScreen(lj.seg.from), this.pointScreen(lj.seg.to));
        if (len > DETOUR_MAX_PX) break;
      }
    }
  }

  draft(controller: AppController): Map<SegmentKey, SegmentState | null> {
    const out = new Map<SegmentKey, SegmentState | null>();
    for (const l of this.links) out.set(l.seg.key, this.fairing ? fairStateFor(controller, l.entity, l.seg) : revertState(controller, l.entity, l.seg));
    return out;
  }
}

/** Screen distance from `sp` to a curve's whole support — a line's infinite line, a circle's full
 * circle: which curve a young trace follows is about direction, not about where each one ends. */
function supportDistance(doc: Doc, view: ViewTransform, entity: Entity, sp: Vec2): number {
  const g = resolveEntityGeom(doc, entity);
  const w = screenToWorld(view, sp);
  if (g.kind === 'circle') return Math.abs(Math.hypot(w.x - g.centre.x, w.y - g.centre.y) - g.radius) * view.zoom;
  return Math.abs((w.x - g.a.x) * g.dir.y - (w.y - g.a.y) * g.dir.x) * view.zoom;
}

/** The piece of `entity` the trace starts on: the one under the press — or, when the press sat
 * right on a junction, the one on the side the finger went. */
function startPiece(doc: Doc, view: ViewTransform, entity: Entity, press: Vec2, now: Vec2): DerivedSegment | null {
  const segs = deriveSegments(doc, entity);
  const isCircle = entity.kind === 'circle';
  const atPress = segmentContainingParam(segs, curveDistanceAt(doc, view, entity, press).param, isCircle);
  const atNow = segmentContainingParam(segs, curveDistanceAt(doc, view, entity, now).param, isCircle);
  if (!atPress) return atNow ?? null;
  if (atNow && atNow.key !== atPress.key) {
    const shared = [atPress.from, atPress.to].find((id) => id === atNow.from || id === atNow.to);
    if (shared && dist(worldToScreen(view, resolvePoint(doc, shared)), press) <= 4) return atNow;
  }
  return atPress;
}

/** Writes a run (tap, or a "Which line?" choice) as one undo step. */
function commitRun(controller: AppController, run: FairRun): void {
  if (run.whole) {
    const id = run.whole;
    controller.commit((d) => {
      ensureCircleSegments(d, id);
      const fresh = d.entities.find((e) => e.id === id);
      if (fresh) for (const s of deriveSegments(d, fresh)) setSegmentFair(d, s.key, true);
    });
    return;
  }
  commitDraft(controller, run.draft);
}

function commitDraft(controller: AppController, draft: Map<SegmentKey, SegmentState | null>): void {
  const doc = controller.doc;
  const changed = [...draft].filter(([k, v]) => JSON.stringify(doc.segmentStates.get(k) ?? null) !== JSON.stringify(v));
  if (changed.length === 0) {
    controller.notify();
    return;
  }
  controller.commit((d) => {
    for (const [k, v] of changed) {
      if (v === null) d.segmentStates.delete(k);
      else d.segmentStates.set(k, v);
    }
  });
}

export function showCue(controller: AppController, at: Vec2, text: string, ms = CUE_MS): void {
  const record = { at, text, until: performance.now() + ms };
  controller.cue = record;
  controller.notifyView();
  setTimeout(() => {
    if (controller.cue === record) {
      controller.cue = null;
      controller.notifyView();
    }
  }, ms + 20);
}

function openLineChoice(controller: AppController, tapScreen: Vec2, runs: FairRun[]): void {
  controller.lineChoice = {
    anchorScreen: tapScreen,
    candidates: runs.slice(0, 4),
    focus: null,
    resolve: (i) => {
      controller.lineChoice = null;
      if (i !== null && runs[i]) commitRun(controller, runs[i]!);
      else controller.notify();
    },
  };
  controller.notify();
}

function beginFairGesture(controller: AppController, view: ViewTransform, press: Vec2): Gesture | null {
  const doc = controller.doc;
  const near = curveCandidatesAt(doc, view, press);
  if (near.length === 0) return null;
  const plausible = plausibleCurves(doc, near);
  // A tap acts on ONE segment; segments on curves that would look identical once Faired are one.
  const segRuns: FairRun[] = [];
  for (const h of plausible) {
    const r = segmentRun(controller, view, h, press);
    if (r && !segRuns.some((x) => sameVisibleRun(doc, view, x, r))) segRuns.push(r);
  }
  const segment = segRuns.length === 1 ? segRuns[0]! : null;
  // The long-press's scope: the whole run(s).
  const runs = candidateRuns(controller, view, plausible, press);

  // Pressing shows, strongly, exactly the segment a tap would change — with the point cloud hidden.
  controller.fairTrace = { draft: segment ? new Map(segment.draft) : new Map(), preview: null, relevantPoints: new Set(), whole: segment?.whole ?? null };
  controller.notifyView();

  let follower: PathFollower | null = null;
  const samples: Vec2[] = [press];
  let wholeOnly: Entity | null = null;
  let travel = 0;
  let longPressed = false;
  // Long-press: the whole run, previewed while held (lift commits, sliding away cancels).
  let longRun: FairRun | null = null;
  let longCancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    if (follower || runs.length === 0) return;
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(10);
    if (runs.length >= 2) {
      longPressed = true;
      controller.fairTrace = null;
      openLineChoice(controller, press, runs);
      return;
    }
    longRun = runs[0]!;
    controller.fairTrace = { draft: new Map(longRun.draft), preview: null, relevantPoints: new Set(), whole: longRun.whole };
    showCue(controller, screenToWorld(view, press), longRun.fairing ? 'Whole run · lift to Fair, slide away to cancel' : 'Whole run · lift to remove Fair, slide away to cancel', LONG_CUE_MS);
    controller.notify();
  }, LONG_PRESS_MS);
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const publish = () => {
    if (!follower) return;
    controller.fairTrace = {
      draft: follower.draft(controller),
      preview: follower.waiting ? { leaderKey: follower.waiting.leader, runnerUpKey: follower.waiting.runnerUp } : null,
      relevantPoints: new Set(),
      whole: null,
    };
    controller.notifyView();
  };

  return {
    onMove(sp) {
      if (longPressed || wholeOnly) return;
      travel = Math.max(travel, dist(sp, press));
      if (longRun) {
        if (!longCancelled && travel > LONG_CANCEL_PX) {
          longCancelled = true;
          controller.fairTrace = null;
          controller.cue = null;
          controller.notifyView();
        }
        return;
      }
      if (travel <= RESTART_WITHIN_PX) samples.push(sp);
      // Which curve is the finger following? The one near the press that the finger's path so far
      // has stayed closest to on average (one wobbly sample must not decide it) — re-decided while
      // the trace is young, so a wrong first guess is corrected by simply carrying on.
      // Samples far from the press tell curves apart best (two curves meeting at the press agree
      // there), so each counts in proportion to how far it is from where the finger went down.
      const weightedDistance = (entity: Entity): number => {
        let sum = 0;
        let wsum = 0;
        for (const q of samples) {
          const w = 1 + dist(q, press);
          sum += w * supportDistance(doc, view, entity, q);
          wsum += w;
        }
        return sum / wsum;
      };
      const choose = () => {
        let best = near[0]!;
        let bestD = Infinity;
        for (const c of near) {
          const d = weightedDistance(c.entity);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
        return { best, bestD };
      };
      const begin = (entity: Entity): boolean => {
        const seg = startPiece(doc, view, entity, press, sp);
        if (!seg) return false;
        const fairing = doc.segmentStates.get(seg.key)?.state !== 'fair';
        follower = new PathFollower(doc, view, fairing, { entity, seg }, sp, press);
        for (const q of samples.slice(1)) follower.update(q);
        return true;
      };
      if (!follower) {
        if (travel < TRACE_START_PX) return;
        clearTimer();
        const { best } = choose();
        if (deriveSegments(doc, best.entity).length === 0) {
          wholeOnly = best.entity; // an untouched circle has no pieces to follow — it goes whole
          return;
        }
        if (!begin(best.entity)) return;
      } else if (travel <= RESTART_WITHIN_PX) {
        const { best, bestD } = choose();
        const current = follower.links[0]!.entity;
        if (best.entity.id !== current.id && deriveSegments(doc, best.entity).length > 0) {
          if (bestD + RESTART_MARGIN_PX < weightedDistance(current)) begin(best.entity);
        }
      }
      if (!follower) return;
      follower.update(sp);
      publish();
    },
    onUp(sp) {
      clearTimer();
      controller.fairTrace = null;
      if (longPressed) return; // "Which line?" is open
      if (longRun) {
        controller.cue = null;
        if (!longCancelled) commitRun(controller, longRun);
        else controller.notify();
        return;
      }
      if (follower) {
        follower.finish(sp);
        commitDraft(controller, follower.draft(controller));
        return;
      }
      if (wholeOnly) {
        const run = tapRun(controller, view, { entity: wholeOnly, param: 0, d: 0 }, sp);
        if (run) commitRun(controller, run);
        return;
      }
      if (segment) {
        commitRun(controller, segment);
        return;
      }
      showCue(controller, screenToWorld(view, press), 'Trace the line you want');
      controller.notify();
    },
    onCancel() {
      clearTimer();
      controller.fairTrace = null;
      controller.notify();
    },
  };
}

export const fairTool: ToolModule = {
  id: 'fair',
  hint(controller) {
    if (controller.lineChoice) return 'Which line? Choose the numbered run you meant';
    return 'Tap a segment to Fair it · drag to trace · hold for the whole run';
  },
  beginGesture(controller, view, screenPos): Gesture | null {
    return beginFairGesture(controller, view, screenPos);
  },
};
