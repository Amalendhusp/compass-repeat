// The app's one status line: a short message in a compact strip just above the canvas's own
// controls (Undo/Redo on the left, the canvas buttons on the right) — never over the drawing where
// the finger is. One at a time: a new message replaces the one showing. It wraps rather than run
// off a narrow screen. Restrained colours say what kind it is: information, a warning (something
// was not done, and why), or an error.

let el: HTMLDivElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

export type StatusKind = 'info' | 'warning' | 'error';

/** Mounts the status line in `host` — the canvas's control row once there is one. */
export function initToast(host: HTMLElement): void {
  el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  host.appendChild(el);
}

export function showToast(message: string, ms = 2200, kind: StatusKind = 'info'): void {
  // Before any artwork is open (the first-launch frame picker) there's no shell yet — attach here.
  if (!el || !el.isConnected) initToast(document.getElementById('app') ?? document.body);
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('show');
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => el?.classList.remove('show'), ms);
}
