// A small reusable confirm sheet — used by Clear drawing (Phase 1.2 item 2); general enough for
// any other destructive action that needs a confirmation step later.

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

  scrim.addEventListener('click', () => {
    close();
    opts.onCancel?.();
  });

  const head = document.createElement('div');
  head.className = 'sheet-head';
  head.innerHTML = `<h2>${opts.title}</h2><p class="sub">${opts.body}</p>`;

  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    close();
    opts.onCancel?.();
  });
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn-primary';
  confirmBtn.textContent = opts.confirmLabel;
  confirmBtn.addEventListener('click', () => {
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
