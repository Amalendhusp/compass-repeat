// Gesture arbitration, spec §2. Single-finger gestures delegate to the active
// tool; two-or-more fingers are always a view gesture (pinch/pan) and never
// edit the doc; a short low-travel 2-finger touch is undo, 3-finger is redo.
// Precision mode (press ≥350ms then slide) is deferred — see project notes.

import type { Vec2 } from '../model/types.ts';
import type { AppController, ViewTransform } from '../app/controller.ts';
import type { Gesture, ToolModule } from './tools/types.ts';

const TAP_MOVE_THRESHOLD = 8; // px
const MULTI_TAP_MAX_TRAVEL = 10; // pt, §2
const MULTI_TAP_MAX_MS = 250; // §2
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 8;

interface PointerRecord {
  x: number;
  y: number;
  startX: number;
  startY: number;
  maxTravel: number;
}

interface Session {
  startTime: number;
  maxTravel: number;
  maxConcurrent: number;
}

export class PointerManager {
  private canvas: HTMLCanvasElement;
  private controller: AppController;
  private getView: () => ViewTransform;
  /** Phase 5: which single-finger gesture is active — a plain lookup for Construct's tool dock,
   * or Repeat's own always-on manipulate tool. Caller-supplied so this class stays workspace-
   * agnostic (item 11: two-finger input is always view navigation in either workspace). */
  private getTool: () => ToolModule | null;
  /** Phase 5 item 12: the mutable `{zoom, pan}` pinch/pan actually writes into — Construct's
   * `doc.view` or Repeat's own `doc.repeatView`, chosen by the caller per current workspace, so
   * navigating one workspace's canvas never moves the other's. */
  private getViewState: () => { zoom: number; pan: Vec2 };

  private active = new Map<number, PointerRecord>();
  private mode: 'idle' | 'single' | 'multi' = 'idle';
  private gesture: Gesture | null = null;
  private session: Session | null = null;
  private lastCentroid: Vec2 | null = null;
  private lastPinchDist = 0;

  constructor(
    canvas: HTMLCanvasElement,
    controller: AppController,
    getView: () => ViewTransform,
    getTool: () => ToolModule | null,
    getViewState: () => { zoom: number; pan: Vec2 },
  ) {
    this.canvas = canvas;
    this.controller = controller;
    this.getView = getView;
    this.getTool = getTool;
    this.getViewState = getViewState;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
  }

  private toLocal(e: PointerEvent): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private centroid(): Vec2 {
    let x = 0;
    let y = 0;
    for (const r of this.active.values()) {
      x += r.x;
      y += r.y;
    }
    const n = Math.max(this.active.size, 1);
    return { x: x / n, y: y / n };
  }

  private pinchDistance(): number {
    const pts = [...this.active.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
  }

  private onDown = (e: PointerEvent): void => {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // No native pointer session for this id (e.g. a race with pointercancel). Continue
      // tracking it ourselves; capture is a delivery guarantee, not a precondition.
    }
    const { x, y } = this.toLocal(e);
    this.active.set(e.pointerId, { x, y, startX: x, startY: y, maxTravel: 0 });

    if (this.active.size === 1) {
      this.session = { startTime: performance.now(), maxTravel: 0, maxConcurrent: 1 };
      this.mode = 'single';
      // Item 7: the "near finger" reveal radius follows the actual touch point, independent
      // of whichever tool is active.
      this.controller.pointerScreenPos = { x, y };
      const tool = this.getTool();
      this.gesture = tool ? tool.beginGesture(this.controller, this.getView(), { x, y }) : null;
      this.controller.notifyView();
    } else {
      if (this.gesture) {
        this.gesture.onCancel();
        this.gesture = null;
      }
      this.mode = 'multi';
      this.controller.pointerScreenPos = null;
      if (this.session) this.session.maxConcurrent = Math.max(this.session.maxConcurrent, this.active.size);
      this.lastCentroid = this.centroid();
      this.lastPinchDist = this.pinchDistance();
      this.controller.notifyView();
    }
  };

  private onMove = (e: PointerEvent): void => {
    const rec = this.active.get(e.pointerId);
    if (!rec) return;
    const { x, y } = this.toLocal(e);
    rec.x = x;
    rec.y = y;
    rec.maxTravel = Math.max(rec.maxTravel, Math.hypot(x - rec.startX, y - rec.startY));
    if (this.session) this.session.maxTravel = Math.max(this.session.maxTravel, rec.maxTravel);

    if (this.mode === 'single') {
      this.controller.pointerScreenPos = { x, y };
      this.gesture?.onMove({ x, y });
      this.controller.notifyView();
    } else if (this.mode === 'multi') {
      this.applyPinchPan();
    }
  };

  /**
   * Phase 1.1 item 2: one coherent update per sample — the world point that was under the
   * PREVIOUS centroid is anchored to the NEW centroid, with zoom scaled by the distance ratio.
   * This is the standard combined pinch formula (translate + scale in a single step, not two
   * sequential adjustments), so geometry stays visually attached to the fingers with no
   * compounding drift across a long, high-frequency real-touch sample stream. Uses notifyView()
   * — the cheap channel — so this never rebuilds the dock/context-bar DOM per sample; see
   * AppController.notifyView().
   */
  private applyPinchPan(): void {
    const view = this.getView();
    const centroid = this.centroid();
    const dist = this.pinchDistance();
    const viewState = this.getViewState();

    if (this.lastCentroid && this.lastPinchDist > 0 && dist > 0) {
      const oldZoom = viewState.zoom;
      const oldPan = viewState.pan;
      const worldAnchor = {
        x: (this.lastCentroid.x - view.w / 2) / oldZoom - oldPan.x,
        y: (this.lastCentroid.y - view.h / 2) / oldZoom - oldPan.y,
      };
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * (dist / this.lastPinchDist)));
      viewState.zoom = newZoom;
      viewState.pan = {
        x: (centroid.x - view.w / 2) / newZoom - worldAnchor.x,
        y: (centroid.y - view.h / 2) / newZoom - worldAnchor.y,
      };
    }
    this.lastCentroid = centroid;
    this.lastPinchDist = dist;
    this.controller.notifyView();
  }

  private onUp = (e: PointerEvent): void => {
    const rec = this.active.get(e.pointerId);
    if (!rec) return;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Already released or never captured; nothing to clean up.
    }
    this.active.delete(e.pointerId);
    const { x, y } = this.toLocal(e);

    if (this.mode === 'single') {
      const wasDrag = rec.maxTravel > TAP_MOVE_THRESHOLD;
      this.gesture?.onUp({ x, y }, wasDrag);
      this.gesture = null;
      this.mode = 'idle';
      this.session = null;
      this.controller.pointerScreenPos = null;
      this.controller.notifyView();
      return;
    }

    if (this.mode === 'multi' && this.active.size === 0) {
      const s = this.session;
      if (s && s.maxTravel <= MULTI_TAP_MAX_TRAVEL && performance.now() - s.startTime <= MULTI_TAP_MAX_MS) {
        if (s.maxConcurrent === 2) this.controller.undo();
        else if (s.maxConcurrent >= 3) this.controller.redo();
      }
      this.mode = 'idle';
      this.session = null;
      this.lastCentroid = null;
      this.lastPinchDist = 0;
    }
  };
}
