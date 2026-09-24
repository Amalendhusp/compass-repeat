// Phase 5.2 item 28: a tap that counts only when the press AND the release both land on this
// element, read from Pointer Events. Android browsers can deliver a stray synthetic `click` to
// whatever appears under the finger after a menu item opens a sheet — with plain `click`
// handlers that stray click hit the new sheet's scrim and closed it at once, so Menu → Clear
// "did nothing". A press that began elsewhere can never trigger this handler. Keyboard
// activation (a click with no pointer behind it) still works.

const TAP_SLOP_PX = 12;

export function onTap(el: HTMLElement, handler: (e: Event) => void): void {
  let down: { id: number; x: number; y: number } | null = null;
  el.addEventListener('pointerdown', (e) => {
    down = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  el.addEventListener('pointercancel', () => {
    down = null;
  });
  el.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP_PX) return;
    if (e.target instanceof Node && !el.contains(e.target)) return;
    e.stopPropagation();
    handler(e);
  });
  el.addEventListener('click', (e) => {
    if (e.detail === 0) handler(e); // keyboard / assistive activation only
  });
}
