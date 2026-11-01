// Importing a reference image from the device into the Reference Library: decoded with its
// orientation applied, reduced (never enlarged) to a working copy of at most 4096 px on its long
// side — its proportions exactly kept — plus a small thumbnail for the library. The original
// full-resolution file is not kept.
//
// Reduction is by successive halving with high-quality smoothing, then one last step to the exact
// size: a single large jump would alias fine linework.

import { addReference, type ReferenceRecord } from '../persist/referenceStore.ts';

/** The working copy's long side, at most. 4096² is also the largest canvas Safari will draw. */
export const WORKING_MAX = 4096;
const THUMB_MAX = 256;
/** Safari's canvas area limit — no intermediate canvas may be larger. */
const MAX_CANVAS_AREA = 16_777_216;

export class ReferenceImportError extends Error {
  readonly reason: 'decode' | 'storage' | 'other';
  constructor(reason: 'decode' | 'storage' | 'other', message: string) {
    super(message);
    this.reason = reason;
  }
}

function canvasOf(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ReferenceImportError('other', 'No canvas available');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

/** The image source reduced to exactly w × h (by halving while that is still more than twice it). */
export function reduceTo(source: CanvasImageSource, sw: number, sh: number, w: number, h: number, background?: string): HTMLCanvasElement {
  let src: CanvasImageSource = source;
  let cw = sw;
  let ch = sh;
  while (cw / 2 >= w && ch / 2 >= h) {
    let nw = Math.round(cw / 2);
    let nh = Math.round(ch / 2);
    // A first halving of a very large photo could still exceed the canvas limit: jump further.
    if (nw * nh > MAX_CANVAS_AREA) {
      const k = Math.sqrt(MAX_CANVAS_AREA / (nw * nh));
      nw = Math.floor(nw * k);
      nh = Math.floor(nh * k);
    }
    const { canvas, ctx } = canvasOf(nw, nh);
    ctx.drawImage(src, 0, 0, cw, ch, 0, 0, nw, nh);
    src = canvas;
    cw = nw;
    ch = nh;
  }
  const { canvas, ctx } = canvasOf(w, h);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(src, 0, 0, cw, ch, 0, 0, w, h);
  return canvas;
}

/** Long side `max` at most (never enlarged), proportions kept as exactly as whole pixels allow. */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new ReferenceImportError('other', 'Could not encode the image'))), type, quality));
}

async function decode(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    // An <img> applies the photo's own orientation (EXIF), so naturalWidth/Height are as seen.
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty');
    return img;
  } catch {
    throw new ReferenceImportError('decode', 'This image can’t be read on this device');
  } finally {
    // The decoded image stays usable after its URL is revoked.
    URL.revokeObjectURL(url);
  }
}

const newId = () => `ref_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Imports one image file into the library; returns its record. */
/** Imports an image — into the library, or (`scope` 'artwork') for one artwork only. */
export async function importReference(file: File, scope?: 'artwork'): Promise<ReferenceRecord> {
  const img = await decode(file);
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  const work = fitWithin(sw, sh, WORKING_MAX);
  const thumbSize = fitWithin(sw, sh, THUMB_MAX);
  // Drawings and diagrams (PNG) stay lossless; photographs are kept as high-quality JPEG.
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const working = reduceTo(img, sw, sh, work.w, work.h, type === 'image/jpeg' ? '#ffffff' : undefined);
  const image = await toBlob(working, type, 0.9);
  const thumb = await toBlob(reduceTo(working, work.w, work.h, thumbSize.w, thumbSize.h, '#fbf9f5'), 'image/jpeg', 0.82);
  // Let the large canvases go at once (iOS counts canvas memory per page).
  working.width = working.height = 0;
  const record: ReferenceRecord = {
    id: newId(),
    name: file.name || 'Reference',
    addedAt: Date.now(),
    sourceWidth: sw,
    sourceHeight: sh,
    width: work.w,
    height: work.h,
    type,
    bytes: image.size,
    thumb,
    ...(scope ? { scope } : {}),
  };
  try {
    await addReference(record, image);
  } catch (e) {
    const name = (e as DOMException | null)?.name;
    throw new ReferenceImportError(name === 'QuotaExceededError' ? 'storage' : 'other', name === 'QuotaExceededError' ? 'Not enough storage for this image' : 'Couldn’t save the image');
  }
  return record;
}
