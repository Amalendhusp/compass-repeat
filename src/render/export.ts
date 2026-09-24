// Phase 5.3 items 7–19: Visible View export — exactly the current artwork viewport (zoom, pan,
// size, background, artwork mode, opacity), never re-fitted, never the app UI. PNG and SVG both
// come from the SAME renderer call as the screen, in its artwork-only mode (see renderer.ts's
// ArtworkExport): PNG onto an offscreen canvas at 1×/2×/4× pixel density (the composition and
// every stroke's proportion unchanged — only resolution rises), SVG through SvgContext.

import type { AppController, ViewTransform } from '../app/controller.ts';
import { render, type ArtworkExport } from './renderer.ts';
import { renderRepeat } from './repeatRenderer.ts';
import { SvgContext } from './svgContext.ts';

export interface ExportSettings {
  format: 'png' | 'svg';
  scale: 1 | 2 | 4;
  transparent: boolean;
  construction: boolean;
  guides: boolean;
}

function drawArtwork(ctx: CanvasRenderingContext2D, controller: AppController, view: ViewTransform, s: ExportSettings): void {
  const exp: ArtworkExport = { background: !s.transparent, construction: s.construction, guides: s.guides };
  if (controller.doc.view.workspace === 'repeat') renderRepeat(ctx, controller, view, exp);
  else render(ctx, controller, view, exp);
}

export function exportPng(controller: AppController, view: ViewTransform, s: ExportSettings): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(view.w * s.scale);
  canvas.height = Math.round(view.h * s.scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('2d context unavailable'));
  // Scaling the whole drawing (not the view) is what keeps a 4× export the same picture: every
  // coordinate AND every line width grows together, so nothing looks thinner or re-cropped.
  ctx.setTransform(s.scale, 0, 0, s.scale, 0, 0);
  drawArtwork(ctx, controller, view, s);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
}

export function exportSvg(controller: AppController, view: ViewTransform, s: ExportSettings): string {
  const svg = new SvgContext(view.w, view.h);
  drawArtwork(svg as unknown as CanvasRenderingContext2D, controller, view, s);
  return svg.toSvg();
}

// ---- Phase 5.5 items 10–13: filenames and delivery ----

const USED_KEY = 'construct-repeat.sharedFilenames';

function usedFilenames(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(USED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** Remembers a filename once a file has actually gone out, so the next one never reuses it. */
export function markFilenameUsed(filename: string): void {
  try {
    const used = [...usedFilenames(), filename].slice(-300);
    localStorage.setItem(USED_KEY, JSON.stringify(used));
  } catch {
    // Storage unavailable (private mode) — names just won't be de-duplicated across files.
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateStamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStamp = (d: Date) => `${pad(d.getHours())}${pad(d.getMinutes())}`;

/** "Blue Star Study" → "Blue-Star-Study": letters and digits of any script kept, every run of
 * anything else (spaces, slashes, punctuation) becomes one hyphen. */
export function filenameStem(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/** The artwork's own name (or Construct-Repeat-<date> while it has none); a name already handed
 * out gains the date and time, e.g. Eight-Point-Star_2026-09-24_0148.png. */
export function shareFilename(doc: { name: string; named: boolean }, ext: 'png' | 'svg', now = new Date()): string {
  const stem = (doc.named && filenameStem(doc.name)) || `Construct-Repeat-${dateStamp(now)}`;
  const used = usedFilenames();
  const candidates = doc.named && filenameStem(doc.name)
    ? [stem, `${stem}_${dateStamp(now)}_${timeStamp(now)}`]
    : [stem, `${stem}_${timeStamp(now)}`];
  for (const c of candidates) if (!used.has(`${c}.${ext}`)) return `${c}.${ext}`;
  const last = candidates[candidates.length - 1]!;
  for (let n = 2; ; n++) if (!used.has(`${last}-${n}.${ext}`)) return `${last}-${n}.${ext}`;
}

export async function exportVisibleView(controller: AppController, view: ViewTransform, s: ExportSettings): Promise<{ blob: Blob; filename: string }> {
  const filename = shareFilename(controller.doc, s.format);
  if (s.format === 'svg') {
    return { blob: new Blob([exportSvg(controller, view, s)], { type: 'image/svg+xml' }), filename };
  }
  return { blob: await exportPng(controller, view, s), filename };
}

export interface FileShareSupport {
  /** True only when this page can hand an image file to the system share sheet. */
  files: boolean;
  secureContext: boolean;
  webShare: boolean;
  canShareFiles: boolean;
}

let supportCache: FileShareSupport | null = null;

/** Item 11: Web Share with files needs a secure context (HTTPS or localhost), navigator.share,
 * and canShare() accepting an image file. A phone opening the dev server at http://192.168.x.x is
 * NOT a secure context, so there the answer is honestly "no" even on a phone that would share the
 * very same file from the HTTPS deployment. */
export function fileShareSupport(): FileShareSupport {
  if (supportCache) return supportCache;
  const secureContext = window.isSecureContext === true;
  const webShare = typeof navigator.share === 'function';
  let canShareFiles = false;
  try {
    const probe = new File([new Uint8Array([137, 80, 78, 71])], 'probe.png', { type: 'image/png' });
    canShareFiles = typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] });
  } catch {
    canShareFiles = false;
  }
  supportCache = { files: secureContext && webShare && canShareFiles, secureContext, webShare, canShareFiles };
  return supportCache;
}

export type DeliveryResult = 'shared' | 'saved' | 'cancelled';

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Where file sharing is genuinely available, the operating system's own share sheet (Save,
 * Files, AirDrop/Nearby Share, WhatsApp, Mail… — whatever it offers); otherwise a plain download.
 * Call it straight from the tap: `navigator.share` is reached synchronously here, before any
 * await. The result says which actually happened, so the app never claims a sheet it didn't open. */
export async function deliverFile(blob: Blob, filename: string): Promise<DeliveryResult> {
  const file = new File([blob], filename, { type: blob.type });
  if (fileShareSupport().files && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      markFilenameUsed(filename);
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled'; // the sheet was closed
      // e.g. NotAllowedError when the sheet can't open after all — fall through to a download.
    }
  }
  download(blob, filename);
  markFilenameUsed(filename);
  return 'saved';
}
