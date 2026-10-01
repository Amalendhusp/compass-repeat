/** Mobile performance: phones report DPR 3 (even 3.5); drawing at 2 looks the same at arm's
 * length and fills 44% fewer pixels every frame. */
export const MAX_DPR = 2;

export function effectiveDpr(): number {
  return Math.min(window.devicePixelRatio || 1, MAX_DPR);
}

/** Keeps a canvas's backing store matched to its CSS size × devicePixelRatio (capped). Shared by the
 * draw-frame phase and the main boot flow so both resize identically (Phase 1.1 item 2). */
export function setupCanvasDPR(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, onResize?: () => void): () => void {
  function resize(): void {
    const dpr = effectiveDpr();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    onResize?.();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  return () => ro.disconnect();
}
