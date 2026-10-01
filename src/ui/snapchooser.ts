// Smart Fair's "Which line?" chooser — Phase 5.9: an ADVANCED fallback only (a long-press on the
// Fair tool where several curves compete); the normal way to choose is to trace the line. Every
// option carries the circled number the canvas draws on its run; pressing an option shows only
// that run; releasing on it chooses. The panel is laid out clear of the press point and of every
// numbered badge. A tap anywhere else dismisses it without acting on the drawing.
//
// Also here: the small "No point here yet" bubble, with its optional "Divide in 2" shortcut.

import type { AppController } from '../app/controller.ts';
import { worldToScreen } from '../app/controller.ts';
import type { Vec2 } from '../model/types.ts';
import { addSegmentDivisionPoints } from '../model/doc.ts';
import { lineChoiceBadges } from '../render/renderer.ts';
import { onTap } from './tap.ts';
import { showToast } from './toast.ts';

interface Area {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Circle {
  x: number;
  y: number;
  r: number;
}

const RUN_COLOURS = ['#2F5BEA', '#8C5E1C', '#2E8B57', '#8A4FD1'];
const EDGE = 6;
const ANCHOR_KEEPOUT = 30;

/** The part of the viewport where the canvas is actually visible (client coordinates). */
function visibleArea(canvas: HTMLCanvasElement): Area {
  const r = canvas.getBoundingClientRect();
  let bottom = Math.min(r.bottom, window.innerHeight);
  for (const el of document.querySelectorAll<HTMLElement>('.context-bar, .dock')) {
    const b = el.getBoundingClientRect();
    if (b.height > 0 && b.top > r.top + 40 && b.top < bottom) bottom = b.top;
  }
  return { left: Math.max(r.left, 0), top: Math.max(r.top, 0), right: Math.min(r.right, window.innerWidth), bottom };
}

function rectHitsCircle(x: number, y: number, w: number, h: number, c: Circle): boolean {
  const nx = Math.max(x, Math.min(c.x, x + w));
  const ny = Math.max(y, Math.min(c.y, y + h));
  return Math.hypot(nx - c.x, ny - c.y) < c.r;
}

function overlapScore(x: number, y: number, w: number, h: number, area: Area, keepOut: Circle[]): number {
  let score = 0;
  score += Math.max(0, area.left + EDGE - x) + Math.max(0, x + w - (area.right - EDGE));
  score += Math.max(0, area.top + EDGE - y) + Math.max(0, y + h - (area.bottom - EDGE));
  for (const c of keepOut) if (rectHitsCircle(x, y, w, h, c)) score += 1000;
  return score;
}

/** First position (client) for a w×h panel that fits and avoids every keep-out — or the least bad. */
function placePanel(w: number, h: number, area: Area, keepOut: Circle[], preferred: Vec2[]): Vec2 {
  const corners: Vec2[] = [
    { x: area.right - EDGE - w, y: area.top + EDGE },
    { x: area.left + EDGE, y: area.top + EDGE },
    { x: area.right - EDGE - w, y: area.bottom - EDGE - h },
    { x: area.left + EDGE, y: area.bottom - EDGE - h },
    { x: (area.left + area.right - w) / 2, y: area.top + EDGE },
    { x: (area.left + area.right - w) / 2, y: area.bottom - EDGE - h },
  ];
  let best = corners[0]!;
  let bestScore = Infinity;
  for (const p of [...preferred, ...corners]) {
    const s = overlapScore(p.x, p.y, w, h, area, keepOut);
    if (s === 0) return p;
    if (s < bestScore) {
      bestScore = s;
      best = p;
    }
  }
  // Nothing fits the free canvas: never off-screen — it may overlap the ribbon instead.
  return {
    x: Math.min(Math.max(best.x, EDGE), window.innerWidth - w - EDGE),
    y: Math.min(Math.max(best.y, EDGE), window.innerHeight - h - EDGE),
  };
}

interface Model {
  key: object;
  title: string;
  options: { label: string; detail?: string; colour: string }[];
  setFocus(i: number | null): void;
  resolve(i: number | null): void;
}

let mounted: { key: object; el: HTMLElement; off: () => void } | null = null;

function unmount(): void {
  mounted?.off();
  mounted?.el.remove();
  mounted = null;
}

function modelFor(controller: AppController): Model | null {
  const lc = controller.lineChoice;
  if (lc) {
    return {
      key: lc,
      title: 'Which line?',
      options: lc.candidates.map((c, i) => ({ label: c.label, detail: c.detail, colour: RUN_COLOURS[i % RUN_COLOURS.length]! })),
      setFocus: (i) => {
        lc.focus = i;
        controller.notifyView();
      },
      resolve: (i) => lc.resolve(i),
    };
  }
  return null;
}

export function syncSnapChooser(controller: AppController, canvas: HTMLCanvasElement, view?: () => { zoom: number; pan: Vec2; w: number; h: number } | null): void {
  syncNoPoint(controller, canvas);
  const model = modelFor(controller);
  if (mounted && model && mounted.key === model.key) return;
  unmount();
  if (!model) return;

  const el = document.createElement('div');
  el.className = 'snap-chooser';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', model.title);
  const title = document.createElement('div');
  title.className = 'snap-chooser-title';
  title.textContent = model.title;
  el.appendChild(title);
  model.options.forEach((o, i) => {
    const b = document.createElement('button');
    b.className = 'snap-chooser-option';
    const num = document.createElement('span');
    num.className = 'snap-chooser-num';
    num.textContent = String(i + 1);
    num.style.borderColor = o.colour;
    num.style.color = o.colour;
    b.appendChild(num);
    const text = document.createElement('span');
    text.className = 'snap-chooser-text';
    text.textContent = o.label;
    if (o.detail) {
      const d = document.createElement('span');
      d.className = 'snap-chooser-detail';
      d.textContent = o.detail;
      text.appendChild(d);
    }
    b.appendChild(text);
    // Pressing (or hovering with a mouse) shows which candidate this is before choosing it.
    const on = () => {
      b.classList.add('focus');
      num.style.background = o.colour;
      num.style.color = '#fff';
      model.setFocus(i);
    };
    const off = () => {
      b.classList.remove('focus');
      num.style.background = '';
      num.style.color = o.colour;
      model.setFocus(null);
    };
    b.addEventListener('pointerdown', on);
    b.addEventListener('pointerenter', on);
    b.addEventListener('pointerleave', off);
    b.addEventListener('pointercancel', off);
    onTap(b, () => model.resolve(i));
    el.appendChild(b);
  });
  document.body.appendChild(el);
  // Small screens: two columns rather than a tall panel over the canvas.
  const area0 = visibleArea(canvas);
  if (model.options.length > 2 && el.offsetHeight > area0.bottom - area0.top - 2 * EDGE) el.classList.add('two-col');

  // Layout: loupe (points) first, then the panel clear of the tap, the loupe and every marker.
  const r = canvas.getBoundingClientRect();
  const area = visibleArea(canvas);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const keepOut: Circle[] = [];
  const preferred: Vec2[] = [];
  const lc = controller.lineChoice;
  if (lc) {
    const anchor = { x: r.left + lc.anchorScreen.x, y: r.top + lc.anchorScreen.y };
    keepOut.push({ x: anchor.x, y: anchor.y, r: ANCHOR_KEEPOUT + 6 });
    const v = view?.();
    if (v) {
      for (const b of lineChoiceBadges(controller, v)) keepOut.push({ x: r.left + b.x, y: r.top + b.y, r: 18 });
      // keep the candidates' own nearby stretch clear too, where it can be seen
      for (const c of lc.candidates) {
        const s = worldToScreen(v, c.badgeAt);
        keepOut.push({ x: r.left + s.x, y: r.top + s.y, r: 16 });
      }
    }
    preferred.push({ x: anchor.x + 60, y: anchor.y - h / 2 }, { x: anchor.x - 60 - w, y: anchor.y - h / 2 });
  }
  const at = placePanel(w, h, area, keepOut, preferred);
  el.style.left = `${Math.round(at.x)}px`;
  el.style.top = `${Math.round(at.y)}px`;

  const onOutside = (e: PointerEvent) => {
    if (el.contains(e.target as Node)) return;
    if (e.target instanceof HTMLCanvasElement) e.stopPropagation(); // dismissing never also draws
    model.resolve(null);
  };
  const t = setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  mounted = {
    key: model.key,
    el,
    off: () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', onOutside, true);
    },
  };
}

// ---- "No point here yet" ----

let hint: { key: object; el: HTMLElement } | null = null;

function syncNoPoint(controller: AppController, canvas: HTMLCanvasElement): void {
  const np = controller.noPoint;
  if (hint && hint.key === np) return;
  hint?.el.remove();
  hint = null;
  if (!np) return;
  const el = document.createElement('div');
  el.className = 'no-point-hint';
  el.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = 'No point here yet';
  el.appendChild(text);
  if (np.divide) {
    const b = document.createElement('button');
    b.className = 'no-point-divide';
    b.textContent = 'Divide in 2';
    const target = np.divide;
    onTap(b, () => {
      let created: string[] = [];
      controller.commit((d) => {
        created = addSegmentDivisionPoints(d, target, 2);
      });
      controller.noPoint = null;
      if (created.length) controller.setRecentPoints(created);
      showToast('Midpoint added — tap it');
      controller.notify();
    });
    el.appendChild(b);
  }
  document.body.appendChild(el);
  const r = canvas.getBoundingClientRect();
  const area = visibleArea(canvas);
  const anchor = { x: r.left + np.anchorScreen.x, y: r.top + np.anchorScreen.y };
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const keepOut: Circle[] = [{ x: anchor.x, y: anchor.y, r: 24 }];
  const at = placePanel(w, h, area, keepOut, [
    { x: anchor.x - w / 2, y: anchor.y - 28 - h },
    { x: anchor.x - w / 2, y: anchor.y + 28 },
    { x: anchor.x + 30, y: anchor.y - h / 2 },
    { x: anchor.x - 30 - w, y: anchor.y - h / 2 },
  ]);
  el.style.left = `${Math.round(at.x)}px`;
  el.style.top = `${Math.round(at.y)}px`;
  hint = { key: np, el };
}
