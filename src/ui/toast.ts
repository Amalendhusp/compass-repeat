let el: HTMLDivElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

export function initToast(root: HTMLElement): void {
  el = document.createElement('div');
  el.className = 'toast';
  root.appendChild(el);
}

export function showToast(message: string, ms = 2200): void {
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => el?.classList.remove('show'), ms);
}
