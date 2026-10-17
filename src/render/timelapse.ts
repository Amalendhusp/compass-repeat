// vNext Phase 4B: Timelapse — the artwork's recorded process history played back as a video.
//
// Not a screen recording: every frame is a recorded artwork state (see persist/processState.ts),
// rebuilt from the history and drawn by the same export-mode renderers PNG and SVG use, onto a
// private off-screen canvas. The live canvas, document, history and Undo are never touched.
//
// Each moment is shown in the workspace it happened in, framed as that workspace's view (held
// steady for the whole video, as a PNG export would frame it):
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
import type { Doc, Workspace } from '../model/types.ts';
import { render, type ArtworkExport } from './renderer.ts';
import { renderRepeat } from './repeatRenderer.ts';
import { renderIntersection } from './intersectionRenderer.ts';
import { shareFilename } from './export.ts';
import { loadEvents, loadMeta, type ProcessEvent } from '../persist/processStore.ts';
import { walkProcess } from '../persist/processReplay.ts';
import { captureState, stateHash, stateToDoc, type ArtworkState } from '../persist/processState.ts';

const MAX_SIDE = 1080; // px, the video's longest side
const FPS = 30;
const BITS_PER_SECOND = 6_000_000;
export const START_HOLD = 750; // ms on the first state
export const END_HOLD = 1750; // ms on the finished artwork
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
}

export async function planTimelapse(liveDoc: Doc): Promise<TimelapsePlan> {
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
  for (const { state } of walkProcess(events)) last = state;
  const appendCurrent = stateHash(last!) !== stateHash(current) ? current : null;
  const changes = shown - 1 + (appendCurrent ? 1 : 0);
  const step = stepMs(changes);
  return { events, keep, appendCurrent, changes, stepMs: step, totalMs: START_HOLD + changes * step + END_HOLD, asRepeat };
}

/** Draws recorded states exactly as the video frames show them: the export-mode renderers, the
 * live views, at the video's size. */
export function frameRenderer(liveDoc: Doc, view: ViewTransform, settings: { construction: boolean; guides: boolean }, asRepeat: boolean) {
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
  const constructView: ViewTransform = { zoom: liveDoc.view.zoom, pan: { ...liveDoc.view.pan }, w: view.w, h: view.h };
  const repeatView: ViewTransform = { zoom: liveDoc.repeatView.zoom, pan: { ...liveDoc.repeatView.pan }, w: view.w, h: view.h };
  const ix = liveDoc.intersectionView ?? liveDoc.view;
  const intersectView: ViewTransform = { zoom: ix.zoom, pan: { ...ix.pan }, w: view.w, h: view.h };
  const drawer = new AppController(liveDoc); // private: only ever handed rebuilt states
  // Intersect's renderer reads its transient state off a controller: here, none at all — no tool,
  // no selection, no picks, no drag — so it draws the arrangement alone.
  const still = { doc: liveDoc, tool: null, fairTrace: null, lineChoice: null, intersectionDrag: null, intersectionSpreadDraft: null, intersectionSelected: null, intersectionPicks: [], intersectionPickKind: 'line' };
  return {
    canvas,
    W,
    H,
    /** How a moment is shown: in the workspace it happened in (see the top of this file). */
    modeOf(state: ArtworkState, workspace?: Workspace): 'construct' | 'intersect' | 'repeat' {
      if (workspace === 'intersection') return 'intersect';
      if (!asRepeat || workspace === 'construct') return 'construct';
      return state.repeat.family !== undefined ? 'repeat' : 'construct';
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
  const plan = await planTimelapse(liveDoc);
  const frames = frameRenderer(liveDoc, view, settings, plan.asRepeat);
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
    for (const { event, state } of walk) {
      if (!plan.keep(event)) continue;
      await sleepUntil(due);
      if (stop()) return null;
      frames.draw(state, event.workspace);
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
    await sleepUntil(due + END_HOLD);
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
