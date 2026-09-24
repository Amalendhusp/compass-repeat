// A small reusable confirm sheet — used by Clear drawing (Phase 1.2 item 2) and Delete. Phase 5.2
// item 28: every control reacts to a genuine tap on itself (ui/tap.ts), so a stray synthetic click
// left over from the tap that opened the sheet can't dismiss it before it's been seen.

import { onTap } from './tap.ts';

export function openConfirmSheet(
  root: HTMLElement,
  opts: { title: string; body: string; confirmLabel: string; onConfirm: () => void; onCancel?: () => void },
): void {
  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';

  const sheet = document.createElement('div');
  sheet.className = 'sheet compact';

  const close = () => {
    scrim.remove();
    sheet.remove();
  };

  onTap(scrim, () => {
    close();
    opts.onCancel?.();
  });

  const head = document.createElement('div');
  head.className = 'sheet-head';
  // Plain text only: titles can carry an artwork's own name (Phase 5.6).
  const h2 = document.createElement('h2');
  h2.textContent = opts.title;
  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent = opts.body;
  head.appendChild(h2);
  head.appendChild(sub);

  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'Cancel';
  onTap(cancelBtn, () => {
    close();
    opts.onCancel?.();
  });
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn-primary';
  confirmBtn.textContent = opts.confirmLabel;
  onTap(confirmBtn, () => {
    close();
    opts.onConfirm();
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);

  const handle = document.createElement('div');
  handle.className = 'handle';

  sheet.appendChild(handle);
  sheet.appendChild(head);
  sheet.appendChild(actions);

  root.appendChild(scrim);
  root.appendChild(sheet);
}
