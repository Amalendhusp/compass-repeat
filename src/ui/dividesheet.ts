// Divide's compact live control (Phase 2.1 item 1) — replaces the old button-grid picker.
// "Divide arc" / a minimal ± stepper and slider (integers only, 2–64, common values as subtle
// detents rather than a matrix of buttons) / a live preview of the division points on the actual
// selected geometry as N changes / Cancel discards, Apply/Done commits. Closed circles alone get
// a compact secondary "Connect None | k-step" toggle instead of another button grid.

import type { Doc, Vec2 } from '../model/types.ts';
import type { AppController, DivideTarget } from '../app/controller.ts';
import { findSelectableGroup } from '../geometry/segments.ts';
import { circleDivisionPositions, segmentDivisionPositions, starChordPairs } from '../geometry/divide.ts';

const MIN_N = 2;
const MAX_N = 64;
const DETENTS = [3, 4, 5, 6, 8, 10, 12, 16];

export interface DivideChoice {
  of: number;
  starK?: number;
}

function computePreview(doc: Doc, target: DivideTarget, of: number, starK: number | null): { points: Vec2[]; chords: [Vec2, Vec2][] } {
  const entity = doc.entities.find((e) => e.id === target.entityId);
  if (!entity) return { points: [], chords: [] };
  if (target.kind === 'circle-whole') {
    const points = circleDivisionPositions(doc, entity, of, doc.frame.rotation);
    return { points, chords: starK ? starChordPairs(points, starK) : [] };
  }
  const group = findSelectableGroup(doc, entity, target.from, target.to);
  if (!group) return { points: [], chords: [] };
  return { points: segmentDivisionPositions(doc, entity, group, of), chords: [] };
}

export function openDivideSheet(
  root: HTMLElement,
  controller: AppController,
  target: DivideTarget,
  opts: { title: string; allowStar: boolean; initial?: number; onApply: (choice: DivideChoice) => void },
): void {
  let of = Math.min(MAX_N, Math.max(MIN_N, opts.initial ?? 6));
  let starK: number | null = null;

  const refreshPreview = () => {
    controller.dividePreview = { target, ...computePreview(controller.doc, target, of, starK) };
    controller.notifyView();
  };

  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  const sheet = document.createElement('div');
  sheet.className = 'sheet compact divide-compact';

  const close = () => {
    scrim.remove();
    sheet.remove();
    controller.dividePreview = null;
    controller.notifyView();
  };
  scrim.addEventListener('click', close);

  // Phase 3.7 item 9: no explanatory sub-text — the title plus the live preview on the actual
  // geometry already say what's being divided.
  const head = document.createElement('div');
  head.className = 'sheet-head';
  head.innerHTML = `<h2>${opts.title}</h2>`;

  const liveRow = document.createElement('div');
  liveRow.className = 'divide-live-row';
  const minusBtn = document.createElement('button');
  minusBtn.className = 'divide-step-btn';
  minusBtn.textContent = '−';
  minusBtn.setAttribute('aria-label', 'Fewer parts');
  const countEl = document.createElement('span');
  countEl.className = 'divide-count';
  const plusBtn = document.createElement('button');
  plusBtn.className = 'divide-step-btn';
  plusBtn.textContent = '+';
  plusBtn.setAttribute('aria-label', 'More parts');
  liveRow.appendChild(minusBtn);
  liveRow.appendChild(countEl);
  liveRow.appendChild(plusBtn);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'divide-slider';
  slider.min = String(MIN_N);
  slider.max = String(MAX_N);
  slider.step = '1';
  slider.setAttribute('list', 'divide-detents');
  slider.setAttribute('aria-label', 'Number of parts');

  const detentList = document.createElement('datalist');
  detentList.id = 'divide-detents';
  for (const n of DETENTS) {
    const opt = document.createElement('option');
    opt.value = String(n);
    detentList.appendChild(opt);
  }

  const connectWrap = document.createElement('div');
  connectWrap.className = 'divide-connect-row';
  const connectLabel = document.createElement('span');
  connectLabel.className = 'divide-connect-label';
  connectLabel.textContent = 'Connect';
  const connectSeg = document.createElement('div');
  connectSeg.className = 'segmented-mini';
  const noneBtn = document.createElement('button');
  noneBtn.textContent = 'None';
  const stepBtn = document.createElement('button');
  connectSeg.appendChild(noneBtn);
  connectSeg.appendChild(stepBtn);
  connectWrap.appendChild(connectLabel);
  connectWrap.appendChild(connectSeg);

  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', close);
  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn-primary';
  applyBtn.addEventListener('click', () => {
    const choice: DivideChoice = starK ? { of, starK } : { of };
    controller.dividePreview = null;
    controller.notifyView();
    scrim.remove();
    sheet.remove();
    opts.onApply(choice);
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(applyBtn);

  function maxK(): number {
    return Math.floor(of / 2);
  }

  function refresh(): void {
    countEl.textContent = `${of} parts`;
    minusBtn.disabled = of <= MIN_N;
    plusBtn.disabled = of >= MAX_N;
    slider.value = String(of);
    applyBtn.textContent = starK ? `Apply · ${of}/${starK} star` : 'Apply';

    if (opts.allowStar) {
      connectWrap.style.display = '';
      const mk = maxK();
      if (starK !== null && starK > mk) starK = mk >= 2 ? mk : null;
      noneBtn.classList.toggle('active', starK === null);
      stepBtn.classList.toggle('active', starK !== null);
      stepBtn.disabled = mk < 2;
      stepBtn.textContent = starK !== null ? `${starK}-step` : `${mk >= 2 ? 2 : '—'}-step`;
    } else {
      connectWrap.style.display = 'none';
    }
    refreshPreview();
  }

  minusBtn.addEventListener('click', () => {
    of = Math.max(MIN_N, of - 1);
    refresh();
  });
  plusBtn.addEventListener('click', () => {
    of = Math.min(MAX_N, of + 1);
    refresh();
  });
  slider.addEventListener('input', () => {
    of = Math.min(MAX_N, Math.max(MIN_N, Math.round(Number(slider.value))));
    refresh();
  });
  noneBtn.addEventListener('click', () => {
    starK = null;
    refresh();
  });
  stepBtn.addEventListener('click', () => {
    const mk = maxK();
    if (mk < 2) return;
    starK = starK === null ? 2 : starK + 1 > mk ? null : starK + 1;
    refresh();
  });

  refresh();

  const handle = document.createElement('div');
  handle.className = 'handle';
  sheet.appendChild(handle);
  sheet.appendChild(head);
  sheet.appendChild(liveRow);
  sheet.appendChild(slider);
  sheet.appendChild(detentList);
  sheet.appendChild(connectWrap);
  sheet.appendChild(actions);

  root.appendChild(scrim);
  root.appendChild(sheet);
}
