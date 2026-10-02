// vNext Phase 3: the Beginner Guide's engine — a coach, not a demonstration. The learner works the
// real app on a throwaway practice artwork while one compact strip says what to do next; the real
// control it means gets a restrained outline, and points on the canvas worth trying get a ring.
// Nothing covers or intercepts the app: no dimming layer, no fake controls, no synthetic input.
//
// A step moves on when the app's own state shows the learner did it — a committed line, a new
// division point, a closed Fair region — read straight off the document after real commits, never
// by re-running geometry of its own. Only where nothing can be observed (reading about export
// formats) does the strip offer Continue.
//
// Isolation lives in the host (main.ts): the practice artwork is never autosaved, listed or made
// the "last open" artwork, and Exit/Finish reopen whatever was open before, untouched.

import type { AppController, ToolId, ViewTransform } from '../app/controller.ts';
import { worldToScreen } from '../app/controller.ts';
import type { Doc, Vec2 } from '../model/types.ts';
import { onTap } from '../ui/tap.ts';

/** Everything Back needs to put a step's starting point back exactly. */
export interface PracticeState {
  doc: Doc;
  undo: Doc[];
  redo: Doc[];
  tool: ToolId;
}

export interface CoachHost {
  /** Saves and remembers whatever is open, then opens `doc` as the practice artwork. */
  begin(doc: Doc): void;
  /** Fits the practice artwork into the canvas left clear of the strip. */
  fit(): void;
  capture(): PracticeState | null;
  restore(state: PracticeState): void;
  /** Leaves the practice artwork and reopens what was open before (or the Start screen). */
  exit(): Promise<void>;
  controller(): AppController | null;
  view(): ViewTransform | null;
}

export interface StepView {
  text: string;
  /** Real controls to outline — re-read every frame, since the UI rebuilds itself. */
  targets?: (Element | null | undefined)[];
  /** Places on the drawing worth trying, in world coordinates. */
  spots?: Vec2[];
}

export interface StepContext {
  controller: AppController;
  /** The document as it stood when this step began — what "new" is measured against. */
  start: Doc;
  /** Per-visit scratch space for a step's own observations. */
  memo: Record<string, unknown>;
  /** True once the learner has pressed Continue on this step. */
  continued: boolean;
  find(selector: string, text?: string): HTMLElement | null;
}

export interface CoachStep {
  /** Shown in small capitals beside the progress, e.g. "CIRCLE". */
  label: string;
  /** What the strip says once the step is done, briefly, before the next one begins. */
  success: string;
  begin?(ctx: StepContext): void;
  view(ctx: StepContext): StepView;
  done(ctx: StepContext): boolean;
  /** A Continue button, for a step whose outcome can't be observed. */
  continueLabel?(ctx: StepContext): string | null;
}

export interface Guide {
  title: string;
  practice(): Doc;
  steps: CoachStep[];
  finale: string;
}

const SUCCESS_MS = 1100;

export function find(selector: string, text?: string): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => el.isConnected && el.getClientRects().length > 0);
  if (text === undefined) return all[0] ?? null;
  return all.find((el) => el.textContent?.trim() === text || el.getAttribute('aria-label') === text) ?? null;
}

const BACK_ICON = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M11 3.5 L5.5 9 L11 14.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Starts a guide over the live app. */
export function openGuide(guide: Guide, host: CoachHost): void {
  const strip = document.createElement('div');
  strip.className = 'coach-strip at-top';
  strip.setAttribute('role', 'region');
  strip.setAttribute('aria-label', guide.title);
  const main = document.createElement('div');
  main.className = 'coach-main';
  const meta = document.createElement('div');
  meta.className = 'coach-meta';
  const count = document.createElement('span');
  count.className = 'coach-count';
  const label = document.createElement('span');
  label.className = 'coach-label';
  meta.append(count, label);
  const text = document.createElement('div');
  text.className = 'coach-text';
  text.setAttribute('aria-live', 'polite');
  main.append(meta, text);
  const buttons = document.createElement('div');
  buttons.className = 'coach-buttons';
  const back = document.createElement('button');
  back.className = 'coach-btn coach-back';
  back.setAttribute('aria-label', 'Back');
  back.innerHTML = BACK_ICON;
  const exit = document.createElement('button');
  exit.className = 'coach-btn coach-exit';
  exit.textContent = 'Exit';
  buttons.append(back, exit);
  const proceed = document.createElement('button');
  proceed.className = 'coach-btn coach-continue';
  strip.append(main, buttons, proceed);
  document.body.appendChild(strip);

  const halos: HTMLDivElement[] = [];
  const rings: HTMLDivElement[] = [];

  const steps = guide.steps;
  let index = 0; // steps.length = the finale
  let ctx: StepContext | null = null;
  let starts: (PracticeState | null)[] = [];
  let succeededAt: number | null = null;
  let closed = false;
  let raf = 0;

  function enter(i: number): void {
    index = i;
    succeededAt = null;
    starts[i] = host.capture();
    const controller = host.controller();
    ctx = controller && i < steps.length ? { controller, start: controller.doc, memo: {}, continued: false, find } : null;
    if (ctx) steps[i]!.begin?.(ctx);
  }

  function shut(): void {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    strip.remove();
    for (const el of [...halos, ...rings]) el.remove();
    void host.exit();
  }

  onTap(exit, shut);
  onTap(back, () => {
    if (index === 0 || closed) return;
    const target = index - 1;
    const state = starts[target];
    if (state) host.restore(state);
    enter(target);
  });
  onTap(proceed, () => {
    if (index >= steps.length) return shut();
    if (ctx) ctx.continued = true;
  });

  function place<T extends HTMLDivElement>(pool: T[], cls: string, rects: { left: number; top: number; width: number; height: number }[], pad: number): void {
    while (pool.length < rects.length) {
      const el = document.createElement('div') as T;
      el.className = cls;
      document.body.appendChild(el);
      pool.push(el);
    }
    pool.forEach((el, k) => {
      const r = rects[k];
      el.style.display = r ? 'block' : 'none';
      if (!r) return;
      el.style.left = `${r.left - pad}px`;
      el.style.top = `${r.top - pad}px`;
      el.style.width = `${r.width + pad * 2}px`;
      el.style.height = `${r.height + pad * 2}px`;
    });
  }

  /** Under the top bar, unless an open panel needs that space — then just above the bottom
   * controls. Never over the control the step is about. */
  function position(): void {
    const topbar = document.querySelector('.topbar')?.getBoundingClientRect();
    const bottomUi = document.querySelector('.canvas-overlay-bottom')?.getBoundingClientRect();
    const h = strip.offsetHeight;
    const topY = (topbar?.bottom ?? 0) + 8;
    const { left, right } = strip.getBoundingClientRect();
    const panels = [...document.querySelectorAll('.popover-menu')].map((p) => p.getBoundingClientRect());
    const clash = panels.some((r) => r.top < topY + h && r.bottom > topY && r.left < right && r.right > left);
    const bottomEdge = bottomUi && bottomUi.height > 0 ? bottomUi.top : window.innerHeight;
    const atTop = !clash;
    strip.classList.toggle('at-top', atTop);
    strip.classList.toggle('at-bottom', !atTop);
    strip.style.top = `${atTop ? topY : Math.max(topY, bottomEdge - 8 - h)}px`;
  }

  function render(view: StepView | null): void {
    const finale = index >= steps.length;
    const success = succeededAt !== null;
    count.textContent = finale ? 'Done' : `${index + 1} of ${steps.length}`;
    label.textContent = finale ? '' : steps[index]!.label;
    const message = finale ? guide.finale : success ? steps[index]!.success : (view?.text ?? '');
    if (text.textContent !== message) text.textContent = message;
    strip.classList.toggle('success', success || finale);
    back.disabled = index === 0;
    back.style.visibility = index === 0 ? 'hidden' : '';
    exit.hidden = finale; // Finish does the same
    const proceedLabel = finale ? 'Finish' : !success && ctx ? (steps[index]!.continueLabel?.(ctx) ?? null) : null;
    proceed.hidden = proceedLabel === null;
    if (proceedLabel !== null && proceed.textContent !== proceedLabel) proceed.textContent = proceedLabel;
    proceed.classList.toggle('primary', finale || proceedLabel !== null);
  }

  function tick(): void {
    raf = requestAnimationFrame(tick);
    update();
  }

  function update(): void {
    const controller = host.controller();
    const vt = host.view();
    // A Back (or anything else that reopens the practice artwork) brings a new controller.
    if (ctx && controller && ctx.controller !== controller) ctx = { ...ctx, controller };
    if (succeededAt !== null && performance.now() - succeededAt > SUCCESS_MS) enter(index + 1);
    let view: StepView | null = null;
    if (ctx && index < steps.length && succeededAt === null) {
      try {
        view = steps[index]!.view(ctx);
        // A step with nothing to celebrate (Continue) moves straight on.
        if (steps[index]!.done(ctx)) succeededAt = steps[index]!.success ? performance.now() : -Infinity;
      } catch (e) {
        console.warn('guide step', index + 1, e);
      }
    }
    render(view);
    position();
    const targets = (view?.targets ?? []).filter((el): el is Element => !!el && el.isConnected).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0);
    place(halos, 'coach-halo', targets, 4);
    const canvas = document.querySelector('canvas.stage')?.getBoundingClientRect();
    const spots = vt && canvas ? (view?.spots ?? []).slice(0, 12).map((p) => worldToScreen(vt, p)).map((s) => ({ left: canvas.left + s.x - 14, top: canvas.top + s.y - 14, width: 28, height: 28 })) : [];
    place(rings, 'coach-spot', spots.filter((r) => r.top + 14 > (canvas?.top ?? 0) && r.top + 14 < (canvas?.bottom ?? 0)), 0);
  }

  host.begin(guide.practice());
  enter(0);
  update();
  host.fit();
  starts = [host.capture()];
  raf = requestAnimationFrame(tick);
}
