// Phase 5.7: the guided-tour engine behind the Beginner Guide (and, later, "Circle Pattern").
//
// A guide plays over the REAL app: the live interface stays underneath, everything irrelevant is
// dimmed, the control being demonstrated keeps full brightness with a soft halo, and an animated
// fingertip performs the step using the app's own controls — its taps and drags are delivered to
// the real buttons and canvas, so snapping, previews, node insets and panels all appear exactly as
// they would for a student. Nothing is pre-rendered.
//
// Each step is Watch → understand → Next: it starts from a known state, plays its demonstration,
// holds the result, and quietly loops until Next / Back / Close. Next never waits for the
// animation: the step is replayed instantly from its start state (the same actions, no pointer,
// no delays), and whatever the app then shows becomes the next step's start state. So the steps
// are ordinary scripts over the live app, and Back is simply "restore that step's start".
//
// Isolation: the host (main.ts) runs every guide artwork as a throwaway demonstration — never
// autosaved or listed — and reopens the student's own artwork, untouched, when the guide closes.
// The engine itself only ever talks to the app through that host and through the live DOM.

import type { AppController, PointVisibility, ToolId, ViewTransform } from '../app/controller.ts';
import { worldToScreen } from '../app/controller.ts';
import type { Doc, Vec2 } from '../model/types.ts';

export type GuideState =
  | { kind: 'picker' }
  | { kind: 'artwork'; doc: Doc; tool: ToolId; lineMode: AppController['lineMode']; pointVisibility: PointVisibility };

export interface GuideHost {
  root: HTMLElement;
  /** Save and remember whatever is open; demonstrations from here on are never saved. */
  enter(): void;
  /** Close the demonstration and reopen what was open before. */
  exit(opts: { tryItYourself: boolean }): Promise<void>;
  capture(): GuideState;
  restore(state: GuideState): void;
  controller(): AppController | null;
  view(): ViewTransform | null;
}

export interface GuideStep {
  title: string;
  text: string;
  /** Short supporting lines, revealed by the step's own script (ctx.reveal) as it reaches them. */
  micro?: string[];
  /** Controls this step is about: always bright, with a halo. Re-read every frame (the UI moves). */
  controls?: (ctx: GuideContext) => (Element | null | undefined)[];
  /** Areas that must stay bright but need no halo — the canvas, an open panel, the ribbon. */
  areas?: (ctx: GuideContext) => (Element | null | undefined)[];
  run(ctx: GuideContext): Promise<void>;
}

export interface Guide {
  id: string;
  title: string;
  steps: GuideStep[];
  finale: { title: string; text: string };
}

class Cancelled extends Error {}

const POINTER_ID = 4077; // the guide's own finger — never a real pointer's id
const DIM = 'rgba(22, 30, 40, 0.48)';

// ---------------------------------------------------------------------------------------------

export interface GuideContext {
  readonly animate: boolean;
  readonly host: GuideHost;
  controller(): AppController;
  /** The live drawing canvas (the frame HUD's while a frame is being drawn). */
  canvas(): HTMLCanvasElement;
  /** Canvas-local screen position of a world point in the current view. */
  toScreen(p: Vec2): Vec2;
  wait(ms: number): Promise<void>;
  /** Taps a real control. */
  press(el: Element | null | undefined, opts?: { hold?: number }): Promise<void>;
  /** Taps the canvas at a canvas-local position. */
  tap(p: Vec2, opts?: { fast?: boolean }): Promise<void>;
  /** Drags on the canvas through canvas-local positions. */
  drag(path: Vec2[], opts?: { duration?: number }): Promise<void>;
  /** Highlights the step's micro-copy line `index` (it stays shown for the rest of the step). */
  reveal(index: number): void;
  /** Extra bright/haloed elements for the moment (cleared by the next call, or the next step). */
  spot(els: (Element | null | undefined)[]): void;
  find(selector: string, text?: string): HTMLElement | null;
}

class Overlay {
  layer = document.createElement('div');
  private svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private mask = document.createElementNS('http://www.w3.org/2000/svg', 'mask');
  private halos: HTMLDivElement[] = [];
  finger = document.createElement('div');
  card = document.createElement('div');
  private raf = 0;
  holes: () => { bright: Element[]; haloed: Element[]; anchors: Element[] } = () => ({ bright: [], haloed: [], anchors: [] });

  constructor() {
    this.layer.className = 'guide-layer';
    const maskId = `guide-mask-${Math.random().toString(36).slice(2, 8)}`;
    this.mask.setAttribute('id', maskId);
    this.svg.setAttribute('class', 'guide-dim');
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.appendChild(this.mask);
    const shade = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    shade.setAttribute('width', '100%');
    shade.setAttribute('height', '100%');
    shade.setAttribute('fill', DIM);
    shade.setAttribute('mask', `url(#${maskId})`);
    this.svg.appendChild(defs);
    this.svg.appendChild(shade);
    this.layer.appendChild(this.svg);
    this.finger.className = 'guide-finger';
    this.layer.appendChild(this.finger);
    this.card.className = 'guide-card';
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-live', 'polite');
    this.layer.appendChild(this.card);
    document.body.appendChild(this.layer);
    const tick = () => {
      this.update();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private update(): void {
    const { bright, haloed, anchors } = this.holes();
    const rects = [...new Set([...bright, ...haloed])].filter((el) => el.isConnected).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    let html = '<rect width="100%" height="100%" fill="white"/>';
    for (const r of rects) html += `<rect x="${r.left - 4}" y="${r.top - 4}" width="${r.width + 8}" height="${r.height + 8}" rx="12" fill="black"/>`;
    if (this.mask.innerHTML !== html) this.mask.innerHTML = html;
    const haloRects = haloed.filter((el) => el.isConnected).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0);
    while (this.halos.length < haloRects.length) {
      const h = document.createElement('div');
      h.className = 'guide-halo';
      this.layer.insertBefore(h, this.finger);
      this.halos.push(h);
    }
    this.halos.forEach((h, i) => {
      const r = haloRects[i];
      h.style.display = r ? 'block' : 'none';
      if (!r) return;
      h.style.left = `${r.left - 5}px`;
      h.style.top = `${r.top - 5}px`;
      h.style.width = `${r.width + 10}px`;
      h.style.height = `${r.height + 10}px`;
    });
    this.placeCard(anchors.filter((el) => el.isConnected).map((el) => el.getBoundingClientRect()));
  }

  /** The card sits wherever it doesn't cover the step's own control: top if that control is low on
   * the screen, bottom if it's high. Steps about the canvas alone keep it at the top, clear of the
   * bottom controls. Decided by the step's controls only, so it never jumps mid-demonstration. */
  private placeCard(rects: DOMRect[]): void {
    const focus = rects.length > 0 ? rects.reduce((s, r) => s + r.top + r.height / 2, 0) / rects.length : window.innerHeight;
    const low = focus > window.innerHeight * 0.5;
    this.card.classList.toggle('at-top', low);
    this.card.classList.toggle('at-bottom', !low);
  }

  ring(x: number, y: number): void {
    const ring = document.createElement('div');
    ring.className = 'guide-ring';
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    this.layer.insertBefore(ring, this.card);
    setTimeout(() => ring.remove(), 700);
  }

  trail(x: number, y: number): void {
    const dot = document.createElement('div');
    dot.className = 'guide-trail';
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
    this.layer.insertBefore(dot, this.finger);
    setTimeout(() => dot.remove(), 450);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.layer.remove();
  }
}

// ---------------------------------------------------------------------------------------------

function centreOf(el: Element): Vec2 {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function firePointer(el: Element, type: string, at: Vec2): void {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: POINTER_ID,
      isPrimary: true,
      pointerType: 'touch',
      clientX: at.x,
      clientY: at.y,
      button: 0,
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    }),
  );
}

/** Opens a guide over the live app. Returns once the overlay is up. */
export function openGuide(guide: Guide, host: GuideHost): void {
  host.enter();
  const overlay = new Overlay();
  const starts: (GuideState | undefined)[] = [];
  starts[0] = { kind: 'picker' };
  let index = 0;
  let token = { cancelled: false };
  let fingerAt: Vec2 = { x: window.innerWidth / 2, y: window.innerHeight * 0.75 };
  let spotted: Element[] = [];
  let revealed = new Set<number>();
  let busy = false; // a transition (instant replay) is under way
  let closed = false;

  const fingerShow = (on: boolean) => overlay.finger.classList.toggle('show', on);
  const fingerMove = (p: Vec2) => {
    fingerAt = p;
    overlay.finger.style.transform = `translate(${p.x}px, ${p.y}px)`;
  };

  function makeContext(animate: boolean, t: { cancelled: boolean }): GuideContext {
    const check = () => {
      if (t.cancelled) throw new Cancelled();
    };
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    const wait = async (ms: number) => {
      check();
      if (!animate) return;
      await sleep(ms);
      check();
    };
    const glide = async (to: Vec2, ms: number) => {
      if (!animate) return;
      fingerShow(true);
      const from = fingerAt;
      const t0 = performance.now();
      await new Promise<void>((resolve) => {
        const step = () => {
          if (t.cancelled) return resolve();
          const k = Math.min(1, (performance.now() - t0) / ms);
          const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
          fingerMove({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
          if (k < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      check();
    };
    const canvas = (): HTMLCanvasElement => {
      const c = host.root.querySelector<HTMLCanvasElement>('canvas.stage');
      if (!c) throw new Error('guide: no canvas');
      return c;
    };
    const toClient = (p: Vec2): Vec2 => {
      const r = canvas().getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    };

    return {
      animate,
      host,
      controller() {
        const c = host.controller();
        if (!c) throw new Error('guide: no artwork open');
        return c;
      },
      canvas,
      toScreen(p) {
        const view = host.view();
        if (!view) throw new Error('guide: no view');
        return worldToScreen(view, p);
      },
      wait,
      async press(el, opts = {}) {
        check();
        if (!el) throw new Error('guide: control not found');
        const at = centreOf(el);
        if (animate) {
          spotted = [...spotted, el];
          await glide(at, 520);
          overlay.finger.classList.add('down');
          overlay.ring(at.x, at.y);
          await sleep(opts.hold ?? 140);
          check();
        }
        firePointer(el, 'pointerdown', at);
        firePointer(el, 'pointerup', at);
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: at.x, clientY: at.y }));
        if (animate) {
          overlay.finger.classList.remove('down');
          await sleep(260);
          check();
        }
      },
      async tap(p, opts = {}) {
        check();
        const cv = canvas();
        const at = toClient(p);
        if (animate) {
          await glide(at, opts.fast ? 300 : 520);
          overlay.finger.classList.add('down');
          overlay.ring(at.x, at.y);
          await sleep(opts.fast ? 90 : 150);
          check();
        }
        firePointer(cv, 'pointerdown', at);
        firePointer(cv, 'pointerup', at);
        if (animate) {
          overlay.finger.classList.remove('down');
          await sleep(opts.fast ? 110 : 280);
          check();
        }
      },
      async drag(path, opts = {}) {
        check();
        const cv = canvas();
        const pts = path.map(toClient);
        if (animate) {
          await glide(pts[0]!, 520);
          overlay.finger.classList.add('down');
          overlay.ring(pts[0]!.x, pts[0]!.y);
          await sleep(160);
          check();
        }
        firePointer(cv, 'pointerdown', pts[0]!);
        // Walk the path in small steps so the app sees an ordinary finger drag.
        const total = pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y), 0);
        const samples = Math.max(8, Math.round(total / (animate ? 4 : 10)));
        const duration = opts.duration ?? Math.min(1400, 350 + total * 3);
        const at = (u: number): Vec2 => {
          let d = u * total;
          for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1]!;
            const b = pts[i]!;
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            if (d <= len || i === pts.length - 1) {
              const k = len > 0 ? Math.min(1, d / len) : 1;
              return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
            }
            d -= len;
          }
          return pts[pts.length - 1]!;
        };
        for (let s = 1; s <= samples; s++) {
          const p = at(s / samples);
          firePointer(cv, 'pointermove', p);
          if (animate) {
            fingerMove(p);
            if (s % 3 === 0) overlay.trail(p.x, p.y);
            await sleep(duration / samples);
            if (t.cancelled) {
              firePointer(cv, 'pointercancel', p);
              throw new Cancelled();
            }
          }
        }
        const end = pts[pts.length - 1]!;
        firePointer(cv, 'pointerup', end);
        if (animate) {
          overlay.finger.classList.remove('down');
          await sleep(260);
          check();
        }
      },
      reveal(i) {
        revealed.add(i);
        renderCard();
      },
      spot(els) {
        spotted = els.filter((e): e is Element => !!e);
      },
      find(selector, text) {
        const all = [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => el.isConnected && el.getClientRects().length > 0);
        if (text === undefined) return all[0] ?? null;
        return all.find((el) => el.textContent?.trim() === text || el.getAttribute('aria-label') === text) ?? null;
      },
    };
  }

  const liveContext = () => makeContext(false, token);
  overlay.holes = () => {
    const step = guide.steps[index];
    if (!step || index >= guide.steps.length) {
      // The finale shows the finished artwork itself — nothing dimmed over it.
      const canvas = host.root.querySelector('canvas.stage');
      return { bright: canvas ? [canvas] : [], haloed: [], anchors: [] };
    }
    const ctx = liveContext();
    let controls: Element[] = [];
    let areas: Element[] = [];
    try {
      controls = (step.controls?.(ctx) ?? []).filter((e): e is Element => !!e);
      areas = (step.areas?.(ctx) ?? []).filter((e): e is Element => !!e);
    } catch {
      // The live UI may be between states for a frame (e.g. mid reboot).
    }
    // Any open panel or sheet the demonstration opened is always part of what's being shown.
    const panels = [...document.querySelectorAll('.popover-menu, .sheet')].filter((el) => !overlay.layer.contains(el));
    return { bright: [...areas, ...panels], haloed: [...controls, ...spotted], anchors: controls };
  };

  // ---- the card ----

  function renderCard(): void {
    const card = overlay.card;
    card.innerHTML = '';
    const finale = index >= guide.steps.length;
    const head = document.createElement('div');
    head.className = 'guide-head';
    const progress = document.createElement('div');
    progress.className = 'guide-progress';
    const label = document.createElement('span');
    label.textContent = finale ? guide.title : `Step ${index + 1} of ${guide.steps.length}`;
    progress.appendChild(label);
    const dots = document.createElement('span');
    dots.className = 'guide-dots';
    dots.setAttribute('aria-hidden', 'true');
    guide.steps.forEach((_, i) => {
      const d = document.createElement('i');
      if (i === index || finale) d.className = i === index ? 'on' : 'done';
      else if (i < index) d.className = 'done';
      dots.appendChild(d);
    });
    progress.appendChild(dots);
    head.appendChild(progress);
    const close = document.createElement('button');
    close.className = 'guide-close';
    close.setAttribute('aria-label', 'Close guide');
    close.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    close.addEventListener('click', () => void shut(false));
    head.appendChild(close);
    card.appendChild(head);

    const h = document.createElement('h3');
    const p = document.createElement('p');
    if (finale) {
      h.textContent = guide.finale.title;
      p.textContent = guide.finale.text;
    } else {
      h.textContent = guide.steps[index]!.title;
      p.textContent = guide.steps[index]!.text;
    }
    card.appendChild(h);
    card.appendChild(p);

    const micro = finale ? [] : (guide.steps[index]!.micro ?? []);
    if (micro.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'guide-micro';
      micro.forEach((m, i) => {
        const li = document.createElement('li');
        li.textContent = m;
        if (revealed.has(i)) li.className = 'on';
        ul.appendChild(li);
      });
      card.appendChild(ul);
    }

    const actions = document.createElement('div');
    actions.className = 'guide-actions';
    if (finale) {
      const again = document.createElement('button');
      again.className = 'guide-btn';
      again.textContent = 'Close guide';
      again.addEventListener('click', () => void shut(false));
      const tryIt = document.createElement('button');
      tryIt.className = 'guide-btn primary';
      tryIt.textContent = 'Try it yourself';
      tryIt.addEventListener('click', () => void shut(true));
      actions.appendChild(again);
      actions.appendChild(tryIt);
    } else {
      const back = document.createElement('button');
      back.className = 'guide-btn';
      back.textContent = 'Back';
      back.disabled = index === 0 || busy;
      back.addEventListener('click', () => void go(index - 1));
      const next = document.createElement('button');
      next.className = 'guide-btn primary';
      next.textContent = index === guide.steps.length - 1 ? 'Finish' : 'Next';
      next.disabled = busy;
      next.addEventListener('click', () => void go(index + 1));
      actions.appendChild(back);
      actions.appendChild(next);
    }
    card.appendChild(actions);
  }

  // ---- stepping ----

  async function playLoop(t: { cancelled: boolean }): Promise<void> {
    const step = guide.steps[index]!;
    const start = starts[index]!;
    while (!t.cancelled) {
      try {
        const ctx = makeContext(true, t);
        await ctx.wait(450);
        await step.run(ctx);
        fingerShow(false);
        await ctx.wait(1800); // hold the result
      } catch (e) {
        if (!(e instanceof Cancelled)) console.warn('guide step', index + 1, e);
        if (t.cancelled) return;
        await new Promise((r) => setTimeout(r, 1200));
      }
      if (t.cancelled) return;
      fingerShow(false);
      spotted = [];
      revealed = new Set();
      renderCard();
      host.restore(start);
    }
  }

  /** Replays step `i` instantly from its start state, so its end state is known. */
  async function fastForward(i: number): Promise<void> {
    host.restore(starts[i]!);
    try {
      await guide.steps[i]!.run(makeContext(false, { cancelled: false }));
    } catch (e) {
      console.warn('guide step (instant)', i + 1, e);
    }
    // Let anything the step scheduled for "right after" (ribbons, toasts) settle.
    await new Promise((r) => setTimeout(r, 30));
    starts[i + 1] = host.capture();
  }

  async function go(target: number): Promise<void> {
    if (busy || closed || target < 0) return;
    token.cancelled = true;
    token = { cancelled: false };
    fingerShow(false);
    busy = true;
    renderCard();
    // Each step's end is its successor's start — computed on demand, in order.
    for (let i = 0; i < target && i < guide.steps.length; i++) if (!starts[i + 1]) await fastForward(i);
    if (closed) return;
    busy = false;
    index = Math.min(target, guide.steps.length);
    spotted = [];
    revealed = new Set();
    host.restore(starts[index]!);
    renderCard();
    if (index < guide.steps.length) void playLoop(token);
  }

  async function shut(tryItYourself: boolean): Promise<void> {
    if (closed) return;
    closed = true;
    token.cancelled = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.destroy();
    await host.exit({ tryItYourself });
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') void shut(false);
    else if (e.key === 'ArrowRight') void go(index + 1);
    else if (e.key === 'ArrowLeft') void go(index - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  document.addEventListener('keydown', onKey, true);

  // The student watches; the guide acts. Touches on the dimmed app never reach it.
  for (const type of ['pointerdown', 'pointerup', 'pointermove', 'click', 'wheel', 'touchstart'] as const) {
    overlay.layer.addEventListener(type, (e) => {
      if (overlay.card.contains(e.target as Node)) return;
      e.stopPropagation();
      if (type === 'wheel' || type === 'touchstart') return;
      e.preventDefault();
    });
  }

  void go(0);
}
