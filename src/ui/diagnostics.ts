// Development-only render diagnostics: a small overlay with DPR, backing-store size, render time
// and model counts, for checking dense constructions and Repeat fields on real phones. Shown only
// in dev builds, and only when asked for with `?diag` in the URL (or localStorage cr.diag = 1).

import type { AppController } from '../app/controller.ts';
import type { Doc } from '../model/types.ts';
import { deriveSegments } from '../geometry/segments.ts';
import { effectiveDpr } from '../render/canvasSetup.ts';

export interface DiagnosticsHandle {
  record(ms: number, repeatInstances: number | null): void;
  detach(): void;
}

function wanted(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return new URLSearchParams(location.search).has('diag') || localStorage.getItem('cr.diag') === '1';
  } catch {
    return false;
  }
}

const countsCache = new WeakMap<Doc, { entities: number; derived: number; fair: number }>();

function counts(doc: Doc): { entities: number; derived: number; fair: number } {
  let c = countsCache.get(doc);
  if (!c) {
    let derived = 0;
    let fair = 0;
    for (const e of doc.entities) {
      for (const s of deriveSegments(doc, e)) {
        derived++;
        if (doc.segmentStates.get(s.key)?.state === 'fair') fair++;
      }
    }
    c = { entities: doc.entities.length, derived, fair };
    countsCache.set(doc, c);
  }
  return c;
}

export function attachDiagnostics(controller: AppController, canvas: HTMLCanvasElement): DiagnosticsHandle | null {
  if (!wanted()) return null;
  const el = document.createElement('pre');
  el.className = 'diag-overlay';
  document.body.appendChild(el);
  const times: number[] = [];
  let frames = 0;
  return {
    record(ms, repeatInstances) {
      frames++;
      times.push(ms);
      if (times.length > 30) times.shift();
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const c = counts(controller.doc);
      el.textContent = [
        `DPR ${effectiveDpr()} (device ${window.devicePixelRatio})`,
        `backing ${canvas.width}×${canvas.height}`,
        `render ${ms.toFixed(1)} ms · avg ${avg.toFixed(1)}`,
        `frames ${frames}${controller.viewGesture ? ' · gesture' : ''}`,
        `entities ${c.entities}`,
        `segments ${c.derived} · fair ${c.fair}`,
        `repeat copies ${repeatInstances ?? '–'}`,
      ].join('\n');
    },
    detach() {
      el.remove();
    },
  };
}
