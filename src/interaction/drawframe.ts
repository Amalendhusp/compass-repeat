// Phase 1.1 item 1: the frame is drawn by the participant, not auto-placed. Runs
// before any Doc exists — the drawn origin/radius/rotation feed model/doc.ts's
// placeFrame(), which then builds the same locked-frame geometry as before (§4.1).

import type { FrameKind, Vec2 } from '../model/types.ts';
import { frameVertexCount } from '../geometry/kernel.ts';
import { setupCanvasDPR } from '../render/canvasSetup.ts';
import { color, stroke } from '../render/tokens.ts';

export interface DrawFrameResult {
  origin: Vec2;
  radius: number;
  rotation: number;
}

const MIN_RADIUS = 24; // px — below this a release is treated as an accidental tap, not a commit

type Phase = 'waiting-centre' | 'dragging';

export function attachDrawFrame(
  canvas: HTMLCanvasElement,
  kind: FrameKind,
  onComplete: (result: DrawFrameResult) => void,
  onHintChange: (hint: string) => void,
): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');

  let phase: Phase = 'waiting-centre';
  let centre: Vec2 | null = null;
  let current: Vec2 | null = null;
  let dirty = true;
  let raf = 0;
  let activePointerId: number | null = null;

  const baseHint = kind === 'circle' ? 'Touch to place the centre, drag to set the radius' : `Touch to place the centre, drag toward a vertex`;
  onHintChange(baseHint);

  function toLocal(e: PointerEvent): Vec2 {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function draw(): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx!.save();
    ctx!.clearRect(0, 0, w, h);
    ctx!.fillStyle = color.plaster;
    ctx!.fillRect(0, 0, w, h);

    if (centre && current) {
      const radius = Math.hypot(current.x - centre.x, current.y - centre.y);
      const angle = Math.atan2(current.y - centre.y, current.x - centre.x);

      ctx!.strokeStyle = color.construction;
      ctx!.lineWidth = 0.9;
      ctx!.setLineDash(stroke.extensionDash);
      ctx!.beginPath();
      ctx!.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
      ctx!.stroke();
      ctx!.setLineDash([]);

      ctx!.strokeStyle = color.signal;
      ctx!.lineWidth = 1.6;
      ctx!.setLineDash(stroke.previewDash);
      if (kind === 'circle') {
        ctx!.beginPath();
        ctx!.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
        ctx!.stroke();
      } else {
        const n = frameVertexCount(kind);
        ctx!.beginPath();
        for (let i = 0; i <= n; i++) {
          const a = angle + (i / n) * Math.PI * 2;
          const p = { x: centre.x + radius * Math.cos(a), y: centre.y + radius * Math.sin(a) };
          if (i === 0) ctx!.moveTo(p.x, p.y);
          else ctx!.lineTo(p.x, p.y);
        }
        ctx!.stroke();
      }
      ctx!.setLineDash([]);

      // centre marker
      ctx!.fillStyle = color.signal;
      ctx!.beginPath();
      ctx!.arc(centre.x, centre.y, 4, 0, Math.PI * 2);
      ctx!.fill();

      // drag-tip marker
      ctx!.strokeStyle = color.signal;
      ctx!.lineWidth = 1.4;
      ctx!.beginPath();
      ctx!.arc(current.x, current.y, 9, 0, Math.PI * 2);
      ctx!.stroke();
    }
    ctx!.restore();
  }

  function loop(): void {
    if (dirty) {
      dirty = false;
      draw();
    }
    raf = requestAnimationFrame(loop);
  }

  const detachDPR = setupCanvasDPR(canvas, ctx, () => {
    dirty = true;
  });

  function onDown(e: PointerEvent): void {
    if (activePointerId !== null) return; // single-finger only for frame drawing
    activePointerId = e.pointerId;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // no native pointer session for synthetic/edge-case events; continue tracking manually
    }
    centre = toLocal(e);
    current = centre;
    phase = 'dragging';
    dirty = true;
    onHintChange(kind === 'circle' ? 'Drag to set the radius, release to place' : 'Drag toward a vertex, release to place');
  }

  function onMove(e: PointerEvent): void {
    if (e.pointerId !== activePointerId || phase !== 'dragging') return;
    current = toLocal(e);
    dirty = true;
  }

  function onUp(e: PointerEvent): void {
    if (e.pointerId !== activePointerId) return;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // already released or never captured
    }
    activePointerId = null;
    if (phase === 'dragging' && centre && current) {
      const radius = Math.hypot(current.x - centre.x, current.y - centre.y);
      if (radius >= MIN_RADIUS) {
        const rotation = Math.atan2(current.y - centre.y, current.x - centre.x);
        // worldToScreen centers world (0,0) on the canvas (screen = world + w/2), so the
        // drawn centre — a local, top-left-origin canvas pixel — must be re-expressed
        // relative to the canvas centre to land at the same screen spot once boot() renders
        // it through that convention (radius/rotation are differences, so translation-invariant).
        const origin = { x: centre.x - canvas.clientWidth / 2, y: centre.y - canvas.clientHeight / 2 };
        cleanup();
        onComplete({ origin, radius, rotation });
        return;
      }
    }
    // Too small a drag (or a plain tap): treat as not-yet-started and wait for a fresh centre.
    phase = 'waiting-centre';
    centre = null;
    current = null;
    dirty = true;
    onHintChange(baseHint);
  }

  function onCancelPointer(e: PointerEvent): void {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    phase = 'waiting-centre';
    centre = null;
    current = null;
    dirty = true;
    onHintChange(baseHint);
  }

  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancelPointer);
  raf = requestAnimationFrame(loop);

  function cleanup(): void {
    cancelAnimationFrame(raf);
    detachDPR();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancelPointer);
  }

  return cleanup;
}
