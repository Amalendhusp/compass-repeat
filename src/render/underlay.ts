// The reference underlay on screen: one image, fixed in the artwork's own coordinates
// (Doc.underlay), drawn just above the background and below the artwork in every workspace — at
// that workspace's own placement of it, looked at through that workspace's own camera, so it never
// moves when a camera does, nor with Intersection's copies or Repeat's tiles.
//
// Placements per workspace: one image, one refId, and in each of Construct, Intersection and Repeat
// its own centre, width and turn. A workspace that has none yet takes the most recently established
// one the first time it shows the reference, and from then on keeps its own (settleUnderlay) —
// never following another workspace again. An artwork from before placements were per workspace
// gives all three its one shared placement. And the viewing balance (Doc.underlayView, per
// workspace): how strongly the reference shows, and how strongly the artwork shows over it.
//
// Artwork opacity is a view only: the artwork part of a frame is drawn exactly as always, onto a
// layer of its own, and that whole layer is shown fainter — so nothing about the artwork's own
// styling changes, overlaps don't darken, and the interaction aids drawn after it (selection, snap
// feedback, handles, rings) keep full strength. Exports, thumbnails and Timelapse never come here.

import type { Doc, Underlay, UnderlayPlacement, UnderlayView, Workspace } from '../model/types.ts';
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
export function initialUnderlay(doc: Doc, ref: Pick<ReferenceRecord, 'id' | 'sourceWidth' | 'sourceHeight'>, ws: Workspace): Underlay {
  const aspect = ref.sourceWidth / ref.sourceHeight;
  const shorter = 4 * doc.frame.radius;
  const p: UnderlayPlacement = { centre: { ...doc.frame.origin }, width: aspect >= 1 ? shorter * aspect : shorter, rotation: 0 };
  // The workspace it is chosen in has it from the start; the others take it when first shown.
  return { refId: ref.id, aspect, ...p, placements: { [ws]: { ...p, centre: { ...p.centre } } } };
}

const WORKSPACES: Workspace[] = ['construct', 'intersection', 'repeat'];
const placementCopy = (p: UnderlayPlacement): UnderlayPlacement => ({ centre: { ...p.centre }, width: p.width, rotation: p.rotation });

/** A workspace's placement of the reference — its own, or (until it has one) the most recently
 * established. */
export function placementOf(u: Underlay, ws: Workspace): UnderlayPlacement {
  return u.placements?.[ws] ?? u;
}

/** The reference as a workspace shows it: the image, at that workspace's placement. */
export function underlayIn(u: Underlay, ws: Workspace): Underlay {
  return { ...u, ...placementCopy(placementOf(u, ws)) };
}

/** The underlay with one workspace's placement set — which becomes the most recently established. */
export function withPlacement(u: Underlay, ws: Workspace, p: UnderlayPlacement): Underlay {
  return { ...u, ...placementCopy(p), placements: { ...u.placements, [ws]: placementCopy(p) } };
}

/**
 * Gives the workspace now showing the reference its own placement, if it has none yet: from the
 * most recently established placement, at this moment — after which it never follows another
 * workspace. An artwork from before placements were per workspace gives all three its one shared
 * placement, so it looks exactly as it did. A view matter like the cameras: written into the
 * current artwork state in place (never an Undo step, never a recorded change). True if it wrote.
 */
export function settleUnderlay(doc: Doc, ws: Workspace): boolean {
  const u = doc.underlay;
  if (!u || u.placements?.[ws]) return false;
  const placements = u.placements ? { ...u.placements, [ws]: placementCopy(u) } : Object.fromEntries(WORKSPACES.map((w) => [w, placementCopy(u)]));
  doc.underlay = { ...u, placements };
  return true;
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

/** What a workspace's screen frame draws beyond the artwork itself — the reference where it is, or
 * where a Transform touch is moving it (`draft`). While the reference isn't showing (none chosen,
 * hidden, or missing) the artwork is always shown at full strength. */
export function screenLayers(doc: Doc, ws: Workspace, draft?: Underlay | null): ScreenLayers {
  const v = underlayViewOf(doc, ws);
  const showing = underlayShowing(doc, ws);
  return { underlay: (ctx, view) => drawUnderlay(ctx, doc, view, ws, draft), artworkOpacity: showing ? v.artworkOpacity : 1 };
}

export function drawUnderlay(ctx: CanvasRenderingContext2D, doc: Doc, view: ViewTransform, ws: Workspace, draft?: Underlay | null): void {
  const u = draft ?? (doc.underlay && underlayIn(doc.underlay, ws));
  if (!u) return;
  const v = underlayViewOf(doc, ws);
  if (!v.visible || v.referenceOpacity <= 0) return;
  const img = underlayImage(u.refId);
  if (img.state !== 'ready') return;
  const w = u.width * view.zoom;
  const h = (u.width / u.aspect) * view.zoom;
  // The smallest level that is still at least as wide as it is drawn (in device pixels).
  const m = ctx.getTransform();
  const device = w * Math.hypot(m.a, m.b); // the canvas's scale, whether or not the camera is turned
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

/** While Transform is on: the reference's bounds, quietly outlined over everything (so it can be
 * found even faint or covered), with a small mark at its centre. */
export function drawUnderlayOutline(ctx: CanvasRenderingContext2D, u: Underlay, view: ViewTransform): void {
  const w = u.width * view.zoom;
  const h = (u.width / u.aspect) * view.zoom;
  const c = worldToScreen(view, u.centre);
  ctx.save();
  ctx.translate(c.x, c.y);
  if (u.rotation) ctx.rotate(u.rotation);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(251, 249, 245, 0.8)';
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.lineWidth = 1.2;
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = 'rgba(30, 42, 54, 0.75)';
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(-7, 0);
  ctx.lineTo(7, 0);
  ctx.moveTo(0, -7);
  ctx.lineTo(0, 7);
  ctx.stroke();
  ctx.restore();
}

/** A reference just removed from the library: shown as missing from now on. */
export function forgetUnderlayImage(refId: string): void {
  const e = images.get(refId);
  if (e?.state === 'ready') for (const l of e.levels) if (l.source instanceof ImageBitmap) l.source.close();
  images.set(refId, { state: 'missing' });
  for (const fn of listeners) fn();
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
