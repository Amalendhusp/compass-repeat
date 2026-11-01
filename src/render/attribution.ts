// Release R5 — export attribution: a short line such as "Created by P07", only when the participant has
// chosen it (off by default), and never their email or phone. Drawn small in the bottom-right corner of
// the exported image (PNG, SVG) and the Timelapse's final frame: text with a thin halo in the opposite
// tone, so it reads on light or dark grounds without an opaque box (a transparent export stays
// transparent).

import type { Doc } from '../model/types.ts';
import { SvgContext } from './svgContext.ts';
import { color } from './tokens.ts';

/** The attribution to draw, or null (off, or empty). */
export function attributionOf(doc: Doc): string | null {
  const a = doc.participant?.attribution;
  const text = a?.on ? a.text.trim() : '';
  return text ? text.slice(0, 80) : null;
}

/** Perceived lightness 0–1 of a #rrggbb colour (null: unknown — treated as light). */
function lightness(hex: string | null): number {
  const m = hex ? /^#?([0-9a-f]{6})/i.exec(hex) : null;
  if (!m) return 1;
  const v = parseInt(m[1]!, 16);
  return (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
}

/**
 * Draws `text` in the bottom-right corner of a `w`×`h` picture (in the context's current units).
 * `background`: the export's ground colour, or null for a transparent export.
 */
export function drawAttribution(ctx: CanvasRenderingContext2D, w: number, h: number, text: string, background: string | null): void {
  const size = Math.max(9, Math.min(15, Math.min(w, h) * 0.022));
  const margin = Math.max(6, size * 0.9);
  const dark = lightness(background) < 0.45;
  const fill = dark ? 'rgba(251,249,245,0.82)' : 'rgba(30,42,54,0.72)';
  const haloHex = dark ? color.ink : color.paper;
  const haloWidth = size * 0.32;
  const x = w - margin;
  const y = h - margin;
  if ((ctx as unknown) instanceof SvgContext) {
    (ctx as unknown as SvgContext).text(x, y, text, { size, anchor: 'end', fill: dark ? '#FBF9F5D1' : '#1E2A36B8', halo: `${haloHex}99`, haloWidth });
    return;
  }
  ctx.save();
  ctx.font = `500 ${size}px -apple-system, system-ui, Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineWidth = haloWidth;
  ctx.strokeStyle = haloHex;
  ctx.globalAlpha = 0.6;
  ctx.strokeText(text, x, y);
  ctx.globalAlpha = 1;
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** The ground an artwork is exported on, by workspace (null: transparent). */
export function exportBackground(doc: Doc, transparent: boolean, workspace = doc.view.workspace): string | null {
  if (transparent) return null;
  return workspace === 'repeat' ? doc.repeatDisplay.background : color.plaster;
}
