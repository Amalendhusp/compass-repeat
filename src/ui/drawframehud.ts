// Minimal chrome for the draw-frame phase (Phase 1.1 item 1): reuses the same
// topbar/context-bar classes as the main shell for visual consistency, but with
// no dock (no tools apply until the frame — and so the doc — exists).
//
// The overlay reserves the SAME height as the main shell's util-row + dock (via
// invisible spacers, same gap structure) even though nothing is shown there yet.
// Canvas-wrap is flex:1, so a shorter overlay here would make this canvas taller
// than the one boot() creates right after — shifting the just-drawn frame the
// instant the real dock/context-bar appear. Matching heights keeps world (0,0)
// (screen-centered) at the same screen position across the handoff.

import { iconSvg } from './icons.ts';

const KIND_LABEL: Record<string, string> = {
  circle: 'Circle',
  hexagon: 'Hexagon',
  square: 'Square',
  triangle: 'Triangle',
};

export interface DrawFrameHud {
  canvas: HTMLCanvasElement;
  setHint: (hint: string) => void;
}

export function buildDrawFrameHud(root: HTMLElement, kind: string, onCancel: () => void): DrawFrameHud {
  root.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'app-shell';

  const topbar = document.createElement('div');
  topbar.className = 'topbar';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'icon-btn';
  cancelBtn.setAttribute('aria-label', 'Cancel');
  cancelBtn.innerHTML = iconSvg('close');
  cancelBtn.addEventListener('click', onCancel);
  const title = document.createElement('div');
  title.style.cssText = `font-family:${'var(--font-title)'};font-size:17px;font-weight:500;color:var(--ink);`;
  title.textContent = `${KIND_LABEL[kind] ?? kind} frame`;
  const spacer = document.createElement('div');
  spacer.className = 'topbar-side right';
  topbar.appendChild(cancelBtn);
  topbar.appendChild(title);
  topbar.appendChild(spacer);

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'stage';
  canvasWrap.appendChild(canvas);

  const overlay = document.createElement('div');
  overlay.className = 'canvas-overlay-bottom';

  const utilRowSpacer = document.createElement('div');
  utilRowSpacer.style.cssText = 'height:48px;visibility:hidden;';

  const hintBar = document.createElement('div');
  hintBar.className = 'context-bar';
  const label = document.createElement('div');
  label.className = 'label';
  label.innerHTML = `<span class="title">${KIND_LABEL[kind] ?? kind} frame</span><span class="hint"></span>`;
  hintBar.appendChild(label);

  const dockSpacer = document.createElement('div');
  dockSpacer.style.cssText = 'height:64px;visibility:hidden;';

  overlay.appendChild(utilRowSpacer);
  overlay.appendChild(hintBar);
  overlay.appendChild(dockSpacer);
  canvasWrap.appendChild(overlay);

  shell.appendChild(topbar);
  shell.appendChild(canvasWrap);
  root.appendChild(shell);

  const hintEl = label.querySelector('.hint') as HTMLSpanElement;
  return {
    canvas,
    setHint: (hint: string) => {
      hintEl.textContent = hint;
    },
  };
}
