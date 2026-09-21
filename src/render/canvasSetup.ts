/** Keeps a canvas's backing store matched to its CSS size × devicePixelRatio. Shared by the
 * draw-frame phase and the main boot flow so both resize identically (Phase 1.1 item 2). */
export function setupCanvasDPR(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, onResize?: () => void): () => void {
  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
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
