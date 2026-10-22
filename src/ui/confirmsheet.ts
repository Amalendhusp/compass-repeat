// A small reusable confirmation — used by Clear drawing (Phase 1.2 item 2) and every Delete. Phase 5.2
// item 28: every control reacts to a genuine tap on itself (ui/tap.ts), so a stray synthetic click
// left over from the tap that opened it can't dismiss it before it's been seen.
//
// It is a compact card in its own layer on the page itself, above every panel: a confirmation asked
// for from inside a panel (the Reference Library's Delete) must never open behind it. Only one is
// ever open — a repeated tap on the control that asked for it adds nothing (no second card, no
// second, darker backdrop). The panel it came from stays open beneath, to show the outcome.

import { onTap } from './tap.ts';

let current: HTMLElement | null = null;

/** True while a confirmation is showing — a panel's outside-tap dismissal ignores taps on it. */
export function isInConfirmLayer(target: EventTarget | null): boolean {
  return !!current && target instanceof Node && current.contains(target);
}

export function openConfirmSheet(opts: { title: string; body: string; confirmLabel: string; onConfirm: () => void; onCancel?: () => void }): void {
  if (current?.isConnected) return;

  const layer = document.createElement('div');
  layer.className = 'confirm-layer';
  const scrim = document.createElement('div');
  scrim.className = 'confirm-scrim';

  const card = document.createElement('div');
  card.className = 'confirm-card';
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');

  const close = () => {
    layer.remove();
    document.removeEventListener('keydown', onKey, true);
    if (current === layer) current = null;
  };
  const cancel = () => {
    close();
    opts.onCancel?.();
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  onTap(scrim, cancel);

  // Plain text only: titles can carry an artwork's own name (Phase 5.6).
  const h2 = document.createElement('h2');
  h2.id = `confirm-title-${Date.now()}`;
  h2.textContent = opts.title;
  card.setAttribute('aria-labelledby', h2.id);
  const sub = document.createElement('p');
  sub.textContent = opts.body;

  const actions = document.createElement('div');
  actions.className = 'confirm-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'Cancel';
  onTap(cancelBtn, cancel);
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn-primary';
  confirmBtn.textContent = opts.confirmLabel;
  onTap(confirmBtn, () => {
    close();
    opts.onConfirm();
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);

  card.appendChild(h2);
  card.appendChild(sub);
  card.appendChild(actions);
  layer.appendChild(scrim);
  layer.appendChild(card);
  document.body.appendChild(layer);
  current = layer;
  document.addEventListener('keydown', onKey, true);
  cancelBtn.focus({ preventScroll: true });
}
