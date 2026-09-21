import type { Vec2 } from '../../model/types.ts';
import type { AppController, ToolId, ViewTransform } from '../../app/controller.ts';

export interface Gesture {
  onMove(screenPos: Vec2): void;
  onUp(screenPos: Vec2, wasDrag: boolean): void;
  onCancel(): void;
}

export interface ToolModule {
  id: ToolId;
  /** Context-bar hint for the current armed/pending state. */
  hint(controller: AppController): string;
  /**
   * Starts a single-pointer gesture at `screenPos`, or returns null if the tap
   * found nothing of the tool's target class (§1.1: "does nothing").
   */
  beginGesture(controller: AppController, view: ViewTransform, screenPos: Vec2): Gesture | null;
}
