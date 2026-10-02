// The four frames' small preview drawings, order and names — spec §4.1. vNext Phase 2: the
// separate frame-picker sheet is gone; these now furnish the Start screen's "Choose a frame"
// (ui/startscreen.ts).

import type { FrameKind } from '../model/types.ts';

export const FRAME_PREVIEWS: Record<FrameKind, string> = {
  circle:
    '<svg width="52" height="52" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="26" stroke="#1E2A36" stroke-width="1.6" fill="none"/><circle cx="40" cy="40" r="2.4" fill="#1E2A36"/></svg>',
  triangle:
    '<svg width="52" height="52" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="30" stroke="#8E98A3" stroke-width="0.9" fill="none" stroke-dasharray="2 3"/><path d="M40 10 L66 55 L14 55 Z" fill="none" stroke="#1E2A36" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  square:
    '<svg width="52" height="52" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="28" stroke="#8E98A3" stroke-width="0.9" fill="none" stroke-dasharray="2 3"/><path d="M59.8 20.2 L59.8 59.8 L20.2 59.8 L20.2 20.2 Z" fill="none" stroke="#1E2A36" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  hexagon:
    '<svg width="52" height="52" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="28" stroke="#8E98A3" stroke-width="0.9" fill="none" stroke-dasharray="2 3"/><path d="M40 12 L64.2 26 L64.2 54 L40 68 L15.8 54 L15.8 26 Z" fill="none" stroke="#1E2A36" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};

export const FRAME_ORDER: FrameKind[] = ['circle', 'triangle', 'square', 'hexagon'];
export const FRAME_LABELS: Record<FrameKind, string> = { circle: 'Circle', triangle: 'Triangle', square: 'Square', hexagon: 'Hexagon' };
