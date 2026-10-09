// The reference underlay on screen: one image, fixed in the artwork's own coordinates
// (Doc.underlay), drawn just above the background and below the artwork in every workspace —
// each workspace only looks at it through its own camera, so it never moves when a camera does,
// nor with Intersection's copies or Repeat's tiles. And the viewing balance (Doc.underlayView, per
// workspace): how strongly the reference shows, and how strongly the artwork shows over it.
//
// Artwork opacity is a view only: the artwork part of a frame is drawn exactly as always, onto a
// layer of its own, and that whole layer is shown fainter — so nothing about the artwork's own
// styling changes, overlaps don't darken, and the interaction aids drawn after it (selection, snap
// feedback, handles, rings) keep full strength. Exports, thumbnails and Timelapse never come here.

import type { Doc, Underlay, UnderlayView, Workspace } from '../model/types.ts';
import type { ViewTransform } from '../app/controller.ts';
import { worldToScreen } from '../app/controller.ts';
import type { ReferenceRecord } from '../persist/referenceStore.ts';
import { getReferenceImage } from '../persist/referenceStore.ts';
import { reduceTo } from '../reference/importReference.ts';

export const DEFAULT_UNDERLAY_VIEW: UnderlayView = { visible: true, referenceOpacity: 0.5, artworkOpacity: 1 };

/** A workspace's viewing balance (the defaults until it is first changed). */
export function underlayViewOf(doc: Doc, ws: Workspace): UnderlayView {
  return { ...DEFAULT_UNDERLAY_VIEW, ...doc.underlayView?.[ws] };
}

/** The document's viewing balances with one workspace's changed. */
export function withUnderlayView(doc: Doc, ws: Workspace, patch: Partial<UnderlayView>): NonNullable<Doc['underlayView']> {
  return { ...doc.underlayView, [ws]: { ...underlayViewOf(doc, ws), ...patch } };
}

/**
 * Where a newly chosen reference is first placed — the same whichever workspace or camera it is
 * chosen from: centred on the frame's centre, unturned, its shorter side twice the frame's
 * diameter (4 × the frame radius), its proportions exactly its own.
 */
export function initialUnderlay(doc: Doc, ref: Pick<ReferenceRecord, 'id' | 'sourceWidth' | 'sourceHeight'>): Underlay {
  const aspect = ref.sourceWidth / ref.sourceHeight;
  const shorter = 4 * doc.frame.radius;
  return { refId: ref.id, centre: { ...doc.frame.origin }, width: aspect >= 1 ? shorter * aspect : shorter, rotation: 0, aspect };
}

// ---- the images themselves, decoded only when shown ----

type Entry = { state: 'loading' } | { state: 'missing' } | { state: 'ready'; levels: { source: CanvasImageSource; width: number }[] };
const images = new Map<string, Entry>();
/** Decoded references kept at once (a 4096 px image is tens of MB once decoded). */
const KEEP = 2;
const listeners = new Set<() => void>();

/** `fn` is called whenever an image finishes loading (or turns out to be missing) — to redraw, or
 * refresh what the Reference panel says. Returns its removal. */
export function onUnderlayImage(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function load(refId: string): Promise<void> {
  try {
    const blob = await getReferenceImage(refId);
    if (!blob) throw new Error('missing');
    const bitmap = await createImageBitmap(blob);
    // Halved copies for drawing it small (zoomed out) without aliasing, down to a few hundred px.
    const levels: { source: CanvasImageSource; width: number }[] = [{ source: bitmap, width: bitmap.width }];
    let w = bitmap.width;
    let h = bitmap.height;
    while (w > 512) {
      const prev = levels[levels.length - 1]!;
      const nw = Math.max(1, Math.round(w / 2));
      const nh = Math.max(1, Math.round(h / 2));
      levels.push({ source: reduceTo(prev.source, w, h, nw, nh), width: nw });
      w = nw;
      h = nh;
    }
    images.set(refId, { state: 'ready', levels });
  } catch {
    images.set(refId, { state: 'missing' });
  }
  // Keep only the most recently used few decoded.
  const ready = [...images.entries()].filter(([, e]) => e.state === 'ready');
  for (const [id, e] of ready.slice(0, Math.max(0, ready.length - KEEP))) {
    if (e.state === 'ready') for (const l of e.levels) if (l.source instanceof ImageBitmap) l.source.close();
    images.delete(id);
  }
  for (const fn of listeners) fn();
}

/** A reference's image: 'ready' once decoded, 'loading' meanwhile, 'missing' if the library has
 * no such image (or it can't be read). Asking starts the loading. */
export function underlayImage(refId: string): Entry {
  const e = images.get(refId);
  if (e) {
    if (e.state === 'ready') {
      images.delete(refId); // most recently used last
      images.set(refId, e);
    }
    return e;
  }
  images.set(refId, { state: 'loading' });
  void load(refId);
  return { state: 'loading' };
}

/** Whether the reference shows in this workspace right now (chosen, visible, and its image here). */
export function underlayShowing(doc: Doc, ws: Workspace): boolean {
  if (!doc.underlay) return false;
  const v = underlayViewOf(doc, ws);
  return v.visible && underlayImage(doc.underlay.refId).state === 'ready';
}

// ---- drawing ----

export interface ScreenLayers {
  /** Draws the reference (if any) — called right after the background. */
  underlay: (ctx: CanvasRenderingContext2D, view: ViewTransform) => void;
  /** How strongly the artwork shows (1 = exactly as always). */
  artworkOpacity: number;
}

/** What a workspace's screen frame draws beyond the artwork itself. While the reference isn't
 * showing (none chosen, hidden, or missing) the artwork is always shown at full strength. */
export function screenLayers(doc: Doc, ws: Workspace): ScreenLayers {
  const v = underlayViewOf(doc, ws);
  const showing = underlayShowing(doc, ws);
  return { underlay: (ctx, view) => drawUnderlay(ctx, doc, view, ws), artworkOpacity: showing ? v.artworkOpacity : 1 };
}

export function drawUnderlay(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, ws: Workspace): void {
  const u = doc.underlay;
  if (!u) return;
  const v = underlayViewOf(doc, ws);
  if (!v.visible || v.referenceOpacity <= 0) return;
  const img = underlayImage(u.refId);
  if (img.state !== 'ready') return;
  const w = u.width * view.zoom;
  const h = (u.width / u.aspect) * view.zoom;
  // The smallest level that is still at least as wide as it is drawn (in device pixels).
  const device = w * Math.abs(ctx.getTransform().a);
  const level = [...img.levels].reverse().find((l) => l.width >= device) ?? img.levels[0]!;
  const c = worldToScreen(view, u.centre);
  ctx.save();
  ctx.globalAlpha = v.referenceOpacity;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(c.x, c.y);
  if (u.rotation) ctx.rotate(u.rotation);
  ctx.drawImage(level.source, -w / 2, -h / 2, w, h);
  ctx.restore();
}

let layer: HTMLCanvasElement | null = null;

/**
 * Draws the artwork part of a frame (`draw`) — straight onto `ctx` when it shows at full strength
 * (exactly as before), otherwise onto a layer of its own, which is then shown at the artwork
 * opacity as a whole.
 */
export function drawArtworkLayer(ctx: CanvasRenderingContext2D, layers: ScreenLayers | undefined, draw: (c: CanvasRenderingContext2D) => void): void {
  if (!layers || layers.artworkOpacity >= 1) {
    draw(ctx);
    return;
  }
  if (layers.artworkOpacity <= 0) return;
  layer ??= document.createElement('canvas');
  if (layer.width !== ctx.canvas.width || layer.height !== ctx.canvas.height) {
    layer.width = ctx.canvas.width;
    layer.height = ctx.canvas.height;
  }
  const lctx = layer.getContext('2d');
  if (!lctx) {
    draw(ctx);
    return;
  }
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.clearRect(0, 0, layer.width, layer.height);
  lctx.setTransform(ctx.getTransform());
  lctx.save();
  draw(lctx);
  lctx.restore();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = layers.artworkOpacity;
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}
