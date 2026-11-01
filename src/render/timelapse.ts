// vNext Phase 4B: Timelapse — the artwork's recorded process history played back as a video.
//
// Not a screen recording: every frame is a recorded artwork state (see persist/processState.ts),
// rebuilt from the history and drawn by the same export-mode renderers PNG and SVG use, onto a
// private off-screen canvas. The live canvas, document, history and Undo are never touched.
//
// Each moment is shown in the workspace it happened in, framed steadily for the whole video:
// - Construct and Intersect moments are framed to fit the artwork — everything any of their
//   moments draws (for Intersect, every instance as placed and turned), with Fit's usual margin —
//   so nothing the process ever made is cropped by where the camera happened to be at the end.
// - Repeat moments keep the Repeat view chosen live: the pattern is unbounded, and that view is its
//   composition (as a PNG export of Repeat frames it).
// - Moments made in Intersect are drawn as the arrangement: every instance placed and turned, in
//   its own colour, Construction light and Fair strong — never handles, rings, picks or the dock.
// - From Repeat: moments made in Construct are Construct (construction included — the building
//   phase); the rest are the pattern once Repeat is set up (the repeated design only, with Share's
//   Grid setting). Moments recorded before the workspace was kept follow the old rule: Construct
//   until Repeat was set up, the pattern after.
// - From Construct: Construct and Intersect moments as such; changes that only affect Repeat look
//   identical in Construct, so they're skipped instead of shown as frozen frames.
// So a process that went Construct → Intersect → Repeat plays back that way.
// Changes are cuts, never animated: each recorded state is simply shown, for a time that adapts to
// how many there are.
//
// Encoding is the browser's own: canvas.captureStream() + MediaRecorder, which runs in real time,
// in the best type the browser says it supports — MP4/H.264 first (plays everywhere, iPhone
// included), then WebM.

import { AppController, type ViewTransform } from '../app/controller.ts';
import type { Doc, Vec2, Workspace } from '../model/types.ts';
import { render, type ArtworkExport } from './renderer.ts';
import { renderRepeat } from './repeatRenderer.ts';
import { renderIntersection } from './intersectionRenderer.ts';
import { shareFilename } from './export.ts';
import { attributionOf, drawAttribution } from './attribution.ts';
import { color } from './tokens.ts';
import { loadEvents, loadMeta, type ProcessEvent } from '../persist/processStore.ts';
import { walkProcess } from '../persist/processReplay.ts';
import { captureState, stateHash, stateToDoc, type ArtworkState } from '../persist/processState.ts';
import { drawnShapes } from '../geometry/bounds.ts';
import { developedSegments, intersectionCopies } from '../geometry/intersection.ts';
import { transformPoint, type InstancePose } from '../geometry/lattice.ts';

const MAX_SIDE = 1080; // px, the video's longest side
const FPS = 30;
const BITS_PER_SECOND = 6_000_000;
export const START_HOLD = 750; // ms on the first state
export const END_HOLD = 1750; // ms on the finished artwork
/** Release R5: extra time on the final frame when it carries an attribution, so it can be read. */
export const CREDIT_HOLD = 1250;
/** Each change: 24 s shared between them, but never shorter than 60 ms or longer than 250 ms. */
export const stepMs = (changes: number): number => Math.min(250, Math.max(60, 24_000 / Math.max(changes, 1)));

const TYPES: { mime: string; ext: 'mp4' | 'webm' }[] = [
  { mime: 'video/mp4;codecs=avc1.42E01E', ext: 'mp4' },
  { mime: 'video/mp4;codecs=avc1', ext: 'mp4' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8', ext: 'webm' },
  { mime: 'video/webm', ext: 'webm' },
];

/** The best video type this browser can record a canvas into, or null if it can't. */
export function videoType(): { mime: string; ext: 'mp4' | 'webm' } | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return null;
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t.mime)) ?? null;
}

export interface TimelapseInfo {
  /** There is something to show: recorded changes beyond the starting point. */
  available: boolean;
  /** The history starts from an artwork that existed before recording began. */
  partial: boolean;
}

export async function timelapseInfo(docId: string): Promise<TimelapseInfo> {
  const meta = await loadMeta(docId);
  return { available: !!meta && meta.events > 1, partial: meta?.origin === 'existing' };
}

const REPEAT_ONLY = (t: string) => t.startsWith('repeat-') || t === 'appearance';

export interface TimelapseResult {
  blob: Blob;
  filename: string;
  mime: string;
  durationMs: number;
  frames: number;
}

/** What the video will show, and for how long — decided before any drawing. */
export interface TimelapsePlan {
  events: ProcessEvent[];
  /** Whether a recorded moment gets its own frame. */
  keep: (e: ProcessEvent) => boolean;
  /** The current artwork, appended as a closing cut when the history's end doesn't show it. */
  appendCurrent: ArtworkState | null;
  changes: number;
  stepMs: number;
  totalMs: number;
  asRepeat: boolean;
  /** Everything the Construct and the Intersect moments draw (world coordinates), for framing. */
  extent: { construct: Box | null; intersect: Box | null };
  /** The finished design in each (its last moment's Fair pieces; else all it draws): what the
   * frame centres where it has room to spare. */
  focus: { construct: Box | null; intersect: Box | null };
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
const grow = (b: Box | null, x: number, y: number): Box => (b ? { minX: Math.min(b.minX, x), minY: Math.min(b.minY, y), maxX: Math.max(b.maxX, x), maxY: Math.max(b.maxY, y) } : { minX: x, minY: y, maxX: x, maxY: y });

/** How a moment is shown: in the workspace it happened in (see the top of this file). */
function modeFor(asRepeat: boolean, state: ArtworkState, workspace?: Workspace): 'construct' | 'intersect' | 'repeat' {
  if (workspace === 'intersection') return 'intersect';
  if (!asRepeat || workspace === 'construct') return 'construct';
  return state.repeat.family !== undefined ? 'repeat' : 'construct';
}

/**
 * Phase 1.1: the box of what one moment draws in its workspace — exactly the pieces its frame
 * draws (bounds.ts drawnShapes: no points, no trimmed pieces, no Extension tails), with
 * Construction only when the frame shows it (`construction`), or Fair alone (`fairOnly`). In
 * Intersect each piece is placed and turned with each instance itself (turning a box's corners
 * instead made the extent reach well past the drawing on the side of turned instances).
 */
function drawnBox(mode: 'construct' | 'intersect', state: ArtworkState, liveDoc: Doc, construction: boolean): Box | null {
  const doc = stateToDoc(state, liveDoc);
  const { points, discs } = drawnShapes(doc, construction);
  let box: Box | null = null;
  const place = (p: Vec2, pose: InstancePose | null) => (pose ? transformPoint(doc.frame.origin, pose, p) : p);
  for (const pose of mode === 'construct' ? [null] : intersectionCopies(doc).map((c) => c.pose)) {
    for (const p of points) {
      const q = place(p, pose);
      box = grow(box, q.x, q.y);
    }
    // A circle turns into itself: its centre placed, its radius either side.
    for (const d of discs) {
      const q = place(d, pose);
      box = grow(grow(box, q.x - d.r, q.y - d.r), q.x + d.r, q.y + d.r);
    }
  }
  // Stage D: the Developed Primary stands where it was developed (copies may have moved since).
  if (mode === 'intersect')
    for (const s of developedSegments(doc)) {
      const g = s.geom;
      if (g.kind === 'line') box = grow(grow(box, g.a.x, g.a.y), g.b.x, g.b.y);
      else box = grow(grow(box, g.c.x - g.r, g.c.y - g.r), g.c.x + g.r, g.c.y + g.r);
    }
  return box;
}
const union = (a: Box | null, b: Box | null): Box | null => (!a ? b : !b ? a : grow(grow(a, b.minX, b.minY), b.maxX, b.maxY));

/** Fit's margin around the framed artwork. */
const FIT_PADDING = 0.86;

/**
 * A view of w × h framing `box` with Fit's margin (or null if there is nothing to frame). Phase
 * 1.1: the zoom always fits the whole of `box` (nothing is cropped); where the frame has room to
 * spare along an axis, it is spent centring `focus` (the finished design) as nearly as the whole of
 * `box` still allows — rather than centring everything ever drawn, which can leave the design itself
 * off to one side.
 */
function fittedView(box: Box | null, w: number, h: number, focus: Box | null = null): ViewTransform | null {
  if (!box) return null;
  const bw = Math.max(box.maxX - box.minX, 1e-6);
  const bh = Math.max(box.maxY - box.minY, 1e-6);
  const zoom = Math.min(w / bw, h / bh) * FIT_PADDING;
  // Where the view's centre may go with all of `box` inside the frame's padded area.
  const centreWithin = (lo: number, hi: number, half: number, want: number): number => {
    const inner = half * FIT_PADDING;
    const from = hi - inner;
    const to = lo + inner;
    return from >= to ? (lo + hi) / 2 : Math.min(to, Math.max(from, want));
  };
  const cx = centreWithin(box.minX, box.maxX, w / (2 * zoom), focus ? (focus.minX + focus.maxX) / 2 : (box.minX + box.maxX) / 2);
  const cy = centreWithin(box.minY, box.maxY, h / (2 * zoom), focus ? (focus.minY + focus.maxY) / 2 : (box.minY + box.maxY) / 2);
  return { zoom, pan: { x: -cx, y: -cy }, w, h };
}

/** `construction`: whether Construct frames show the construction (an export setting; a timelapse
 * made from Repeat always shows it while the pattern is being built). */
export async function planTimelapse(liveDoc: Doc, { construction = true }: { construction?: boolean } = {}): Promise<TimelapsePlan> {
  const asRepeat = liveDoc.view.workspace === 'repeat';
  const events: ProcessEvent[] = await loadEvents(liveDoc.id);
  if (events.length < 2) throw new Error('No recorded changes yet');
  // Kept as patches until each is drawn, so even a long history of a large artwork never holds
  // more than one full state at a time.
  const keep = (e: ProcessEvent) => e.source === 'baseline' || e.source === 'resync' || asRepeat || e.tags.length === 0 || !e.tags.every(REPEAT_ONLY);
  const shown = events.filter(keep).length;
  // An artwork changed outside the recorder (and not edited since) ends on what it is now: one
  // cut, never invented steps in between.
  const current = captureState(liveDoc);
  let last: ArtworkState | null = null;
  // One walk through the history: where it ends, and how far the shown moments reach (framing).
  const extent: TimelapsePlan['extent'] = { construct: null, intersect: null };
  const lastIn: { construct: ArtworkState | null; intersect: ArtworkState | null } = { construct: null, intersect: null };
  const showsConstruction = { construct: construction || asRepeat, intersect: true };
  const add = (state: ArtworkState, workspace?: Workspace) => {
    const mode = modeFor(asRepeat, state, workspace);
    if (mode === 'repeat') return;
    extent[mode] = union(extent[mode], drawnBox(mode, state, liveDoc, showsConstruction[mode]));
    lastIn[mode] = state;
  };
  let first = true;
  for (const { event, state } of walkProcess(events)) {
    last = state;
    if (first || keep(event)) add(state, event.workspace);
    first = false;
  }
  const appendCurrent = stateHash(last!) !== stateHash(current) ? current : null;
  if (appendCurrent) add(appendCurrent, liveDoc.view.workspace);
  // The finished design in each workspace: its last moment's Fair pieces (or, before anything is
  // Fair, everything that moment draws).
  const focus: TimelapsePlan['focus'] = { construct: null, intersect: null };
  for (const mode of ['construct', 'intersect'] as const) {
    const s = lastIn[mode];
    if (s) focus[mode] = drawnBox(mode, s, liveDoc, false) ?? drawnBox(mode, s, liveDoc, showsConstruction[mode]);
  }
  const changes = shown - 1 + (appendCurrent ? 1 : 0);
  const step = stepMs(changes);
  return { events, keep, appendCurrent, changes, stepMs: step, totalMs: START_HOLD + changes * step + END_HOLD, asRepeat, extent, focus };
}

/** Draws recorded states exactly as the video frames show them: the export-mode renderers at the
 * video's size — Construct and Intersect fitted to `extent` (the whole process), Repeat in its live
 * view. Without `extent`, every workspace in its live view. */
export function frameRenderer(liveDoc: Doc, view: ViewTransform, settings: { construction: boolean; guides: boolean }, asRepeat: boolean, extent?: TimelapsePlan['extent'], focus?: TimelapsePlan['focus']) {
  const scale = MAX_SIDE / Math.max(view.w, view.h);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const W = even(view.w * scale);
  const H = even(view.h * scale);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const exp: ArtworkExport = { background: true, construction: settings.construction, guides: settings.guides };
  // Made from Repeat, the states before the pattern existed are the construction being built:
  // they show it, whatever the pattern's own Construction setting is.
  const building: ArtworkExport = asRepeat ? { ...exp, construction: true } : exp;
  const constructView: ViewTransform = fittedView(extent?.construct ?? null, view.w, view.h, focus?.construct ?? null) ?? { zoom: liveDoc.view.zoom, pan: { ...liveDoc.view.pan }, w: view.w, h: view.h };
  const repeatView: ViewTransform = { zoom: liveDoc.repeatView.zoom, pan: { ...liveDoc.repeatView.pan }, w: view.w, h: view.h };
  const ix = liveDoc.intersectionView ?? liveDoc.view;
  const intersectView: ViewTransform = fittedView(extent?.intersect ?? null, view.w, view.h, focus?.intersect ?? null) ?? { zoom: ix.zoom, pan: { ...ix.pan }, w: view.w, h: view.h };
  const drawer = new AppController(liveDoc); // private: only ever handed rebuilt states
  // Intersect's renderer reads its transient state off a controller: here, none at all — no tool,
  // no selection, no picks, no drag — so it draws the arrangement alone.
  const still = { doc: liveDoc, tool: null, fairTrace: null, lineChoice: null, intersectionDrag: null, intersectionSpreadDraft: null, intersectionSelected: null, intersectionPicks: [], intersectionPickKind: 'line' };
  return {
    canvas,
    W,
    H,
    /** The view each workspace's frames use. */
    views: { construct: constructView, intersect: intersectView, repeat: repeatView },
    /** How a moment is shown: in the workspace it happened in (see the top of this file). */
    modeOf(state: ArtworkState, workspace?: Workspace): 'construct' | 'intersect' | 'repeat' {
      return modeFor(asRepeat, state, workspace);
    },
    /** Release R5: the participant's attribution over the frame as drawn (the final one). */
    attribution(text: string, mode: 'construct' | 'intersect' | 'repeat'): void {
      ctx.setTransform(W / view.w, 0, 0, H / view.h, 0, 0);
      drawAttribution(ctx, view.w, view.h, text, mode === 'repeat' ? liveDoc.repeatDisplay.background : color.plaster);
    },
    draw(state: ArtworkState, workspace?: Workspace): void {
      drawer.doc = stateToDoc(state, liveDoc);
      ctx.setTransform(W / view.w, 0, 0, H / view.h, 0, 0);
      const mode = this.modeOf(state, workspace);
      if (mode === 'intersect') {
        still.doc = drawer.doc;
        renderIntersection(ctx, still as unknown as AppController, intersectView);
      } else if (mode === 'repeat') renderRepeat(ctx, drawer, repeatView, exp);
      else render(ctx, drawer, constructView, building);
    },
  };
}

/**
 * Plays the open artwork's history into a video. `live` is only read: its document supplies the
 * views and anything that isn't artwork. `cancelled()` is polled throughout. Real-time recording
 * needs the page in front: if it goes to the background, the timelapse stops ('hidden').
 */
export async function createTimelapse(
  live: AppController,
  view: ViewTransform,
  settings: { construction: boolean; guides: boolean },
  onProgress: (fraction: number) => void,
  cancelled: () => boolean,
): Promise<TimelapseResult | null> {
  const type = videoType();
  if (!type) throw new Error('This browser can’t record video');
  const liveDoc = live.doc;
  const plan = await planTimelapse(liveDoc, { construction: settings.construction });
  const frames = frameRenderer(liveDoc, view, settings, plan.asRepeat, plan.extent, plan.focus);
  const out = document.createElement('canvas'); // the frame is copied here 30 times a second
  out.width = frames.W;
  out.height = frames.H;
  const octx = out.getContext('2d')!;

  const stream = out.captureStream(FPS);
  const recorder = new MediaRecorder(stream, { mimeType: type.mime, videoBitsPerSecond: BITS_PER_SECOND });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  const copy = () => octx.drawImage(frames.canvas, 0, 0);
  const sleepUntil = (t: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, t - performance.now())));
  let wentHidden = false;
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') wentHidden = true;
  };
  const stop = () => {
    if (wentHidden) throw new Error('hidden');
    return cancelled();
  };

  let ticker: ReturnType<typeof setInterval> | null = null;
  const finish = () => {
    if (ticker) clearInterval(ticker);
    ticker = null;
    document.removeEventListener('visibilitychange', onVisibility);
    if (recorder.state !== 'inactive') recorder.stop();
    stream.getTracks().forEach((t) => t.stop());
  };

  try {
    document.addEventListener('visibilitychange', onVisibility);
    const walk = walkProcess(plan.events);
    const first = walk.next().value!;
    frames.draw(first.state, first.event.workspace);
    copy();
    recorder.start(1000);
    const t0 = performance.now();
    ticker = setInterval(() => {
      copy();
      onProgress(Math.min(1, (performance.now() - t0) / plan.totalMs));
    }, 1000 / FPS);

    let due = t0 + START_HOLD;
    let lastMode = frames.modeOf(first.state, first.event.workspace);
    for (const { event, state } of walk) {
      if (!plan.keep(event)) continue;
      await sleepUntil(due);
      if (stop()) return null;
      frames.draw(state, event.workspace);
      lastMode = frames.modeOf(state, event.workspace);
      copy();
      due += plan.stepMs;
    }
    if (plan.appendCurrent) {
      await sleepUntil(due);
      if (stop()) return null;
      frames.draw(plan.appendCurrent, liveDoc.view.workspace);
      copy();
      due += plan.stepMs;
    }
    // Release R5: the attribution, if chosen, on the finished artwork only — held a little longer to read.
    const credit = attributionOf(liveDoc);
    if (credit) {
      await sleepUntil(due);
      if (stop()) return null;
      const lastState = plan.appendCurrent ?? null;
      frames.attribution(credit, lastState ? frames.modeOf(lastState, liveDoc.view.workspace) : lastMode);
      copy();
    }
    await sleepUntil(due + END_HOLD + (credit ? CREDIT_HOLD : 0));
    if (stop()) return null;
    onProgress(1);
    const durationMs = performance.now() - t0;
    finish();
    await stopped;
    const blob = new Blob(chunks, { type: type.mime.split(';')[0] });
    return { blob, filename: shareFilename(liveDoc, type.ext, new Date(), '-Timelapse'), mime: recorder.mimeType || type.mime, durationMs, frames: plan.changes + 1 };
  } finally {
    finish();
  }
}
