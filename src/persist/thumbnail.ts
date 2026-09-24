// Phase 5.5 item 3: a small picture of an artwork for My Artworks — the Construct design fitted to
// its own bounds, drawn by the same artwork-only renderer Share uses (no points, no selection).

import type { Doc } from '../model/types.ts';
import type { AppController, ViewTransform } from '../app/controller.ts';
import { render } from '../render/renderer.ts';
import { computeVisibleBounds } from '../geometry/bounds.ts';

const SIZE = 120; // CSS px; drawn at 2× for sharp phone screens

export function makeThumbnail(doc: Doc): string {
  const r = Math.max(doc.frame.radius, 1);
  const b = computeVisibleBounds(doc) ?? { minX: doc.frame.origin.x - r, maxX: doc.frame.origin.x + r, minY: doc.frame.origin.y - r, maxY: doc.frame.origin.y + r };
  const bw = Math.max(b.maxX - b.minX, 1e-6);
  const bh = Math.max(b.maxY - b.minY, 1e-6);
  const zoom = Math.min(SIZE / bw, SIZE / bh) * 0.88;
  const view: ViewTransform = { zoom, pan: { x: -(b.minX + b.maxX) / 2, y: -(b.minY + b.maxY) / 2 }, w: SIZE, h: SIZE };
  const canvas = document.createElement('canvas');
  canvas.width = SIZE * 2;
  canvas.height = SIZE * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  // The artwork-only render path reads just these from the controller.
  const artworkOnly = { doc, tool: 'select', fairTrace: null, fillPreview: null } as unknown as AppController;
  render(ctx, artworkOnly, view, { background: true, construction: true, guides: false });
  return canvas.toDataURL('image/png');
}
