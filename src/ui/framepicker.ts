// Frame picker, spec §4.1 / §9 ("New" opens the frame sheet) — Phase 1.2 item 1: reusable and
// compact. A tap acts immediately (no separate confirm step), so it works equally well as the
// first-launch sheet and as the quick picker from the menu or Circle's long-press.

import type { FrameKind } from '../model/types.ts';
import { showToast } from './toast.ts';

const PREVIEWS: Record<FrameKind, string> = {
  circle:
    '<svg width="52" height="52" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="26" stroke="#1E2A36" stroke-width="1.6" fill="none"/><circle cx="40" cy="40" r="2.4" fill="#1E2A36"/></svg>',
  triangle:
    '<svg width="52" height="52" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="30" stroke="#8E98A3" stroke-width="0.9" fill="none" stroke-dasharray="2 3"/><path d="M40 10 L66 55 L14 55 Z" fill="none" stroke="#1E2A36" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  square:
    '<svg width="52" height="52" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="28" stroke="#8E98A3" stroke-width="0.9" fill="none" stroke-dasharray="2 3"/><path d="M59.8 20.2 L59.8 59.8 L20.2 59.8 L20.2 20.2 Z" fill="none" stroke="#1E2A36" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  hexagon:
    '<svg width="52" height="52" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="28" stroke="#8E98A3" stroke-width="0.9" fill="none" stroke-dasharray="2 3"/><path d="M40 12 L64.2 26 L64.2 54 L40 68 L15.8 54 L15.8 26 Z" fill="none" stroke="#1E2A36" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};

const ORDER: FrameKind[] = ['circle', 'triangle', 'square', 'hexagon'];
const LABELS: Record<FrameKind, string> = { circle: 'Circle', triangle: 'Triangle', square: 'Square', hexagon: 'Hexagon' };

export function openFramePicker(root: HTMLElement, opts: { dismissible: boolean; onChoose: (kind: FrameKind) => void; onCancel?: () => void }): void {
  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';

  const sheet = document.createElement('div');
  sheet.className = 'sheet compact';

  const close = () => {
    scrim.remove();
    sheet.remove();
  };

  if (opts.dismissible) {
    scrim.addEventListener('click', () => {
      close();
      opts.onCancel?.();
    });
  }

  const head = document.createElement('div');
  head.className = 'sheet-head';
  head.innerHTML = `<h2>Choose a frame</h2><p class="sub">Draw its centre, vertices and edges — they become your first points.</p>`;

  const grid = document.createElement('div');
  grid.className = 'frame-grid compact';
  for (const kind of ORDER) {
    const btn = document.createElement('button');
    btn.className = 'frame-option compact';
    btn.innerHTML = `${PREVIEWS[kind]}<span class="frame-name">${LABELS[kind]}</span>`;
    btn.addEventListener('click', () => {
      close();
      opts.onChoose(kind);
    });
    grid.appendChild(btn);
  }

  const recentBtn = document.createElement('button');
  recentBtn.className = 'btn-secondary compact';
  recentBtn.textContent = 'Open recent';
  recentBtn.addEventListener('click', () => showToast('No saved documents yet'));

  const handle = document.createElement('div');
  handle.className = 'handle';

  sheet.appendChild(handle);
  sheet.appendChild(head);
  sheet.appendChild(grid);
  sheet.appendChild(recentBtn);

  root.appendChild(scrim);
  root.appendChild(sheet);
}
