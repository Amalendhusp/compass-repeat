// Phase 5: Repeat's single always-on manipulation tool — no dock, no tool switching. A
// single-finger touch drags a lattice-arm handle (redefining that translation), uses the bounding
// box (render/repeatBox.ts: a long-press or right-click on the central motif opens it; its corners
// Reset · Rotate · Reflect · Scale edit the transformation every copy shares), or does nothing (Repeat
// has no construction gestures — item 11: two-finger input is already claimed by pan/zoom upstream in
// PointerManager, so everything reaching here is genuinely single-finger). The A / B handles come
// first, then the box's corners, then the motif itself. (The rotation ring is gone: Rotate is the box's
// top-right corner.)

import type { Vec2 } from '../../model/types.ts';
import type { AppController, ViewTransform } from '../../app/controller.ts';
import { screenToWorld, worldToScreen } from '../../app/controller.ts';
import { poseScale, snapRotation } from '../../geometry/lattice.ts';
import { dist } from '../../geometry/vec.ts';
import { computeSpaces } from '../../geometry/spaces.ts';
import { fillOpeningsAt } from '../../geometry/repeatGaps.ts';
import { withAlpha } from '../../model/colour.ts';
import { fillTargetAt, patternGroup, toggleRegion } from '../../geometry/repeatColour.ts';
import { repeatSourceOf } from '../../geometry/repeatSetup.ts';
import { showToast } from '../../ui/toast.ts';
import { gapsAtTap } from '../closeGapMode.ts';
import { crossingNear, weaveNetwork } from '../../geometry/weave.ts';
import { withFlip } from '../../geometry/repeatStroke.ts';
import { insideRepeatBox, onCentralMotif, reflectedMotif, repeatBoxHandleAt, repeatBoxOpen, resetMotif, type RepeatBox } from '../../render/repeatBox.ts';
import { draggedScale, scaleLabel } from '../../render/copyBox.ts';
import { rotationFractionLabel } from '../../render/repeatRenderer.ts';
import type { Gesture, ToolModule } from './types.ts';

const HANDLE_HIT_RADIUS = 26; // px — generous, these are the only two draggable points
/** A press held this long without moving opens the box (as in Intersect). */
export const REPEAT_BOX_HOLD_MS = 450;

// vNext Phase 1: a press that stays within this of where it went down moves nothing — so a tap or
// a resting finger never nudges the lattice — and beyond it, whatever is shown is what is kept.
const DRAG_SLOP_PX = 6;
/** Close Gap: how near a tap must be to a gap (px) — a fingertip. */
const CLOSE_GAP_REACH_PX = 28;

/**
 * Phase 1.2: dragging a lattice handle moves its arm exactly with the finger — no snapping, no
 * attraction, nothing to pull free of. (Exact arrangements come from stored coordinates, Reset
 * lattice, and explicit operations.)
 */
function dragHandleGesture(controller: AppController, view: ViewTransform, dir: 'a' | 'b', downScreen: Vec2): Gesture {
  const pivot = controller.doc.frame.origin;
  const start = controller.doc.repeat[dir];
  // Keep the handle where it was relative to the finger rather than jumping it under the fingertip.
  const downWorld = screenToWorld(view, downScreen);
  const grab = { x: start.x - (downWorld.x - pivot.x), y: start.y - (downWorld.y - pivot.y) };
  const rawAt = (sp: Vec2): Vec2 => {
    const w = screenToWorld(view, sp);
    return { x: w.x - pivot.x + grab.x, y: w.y - pivot.y + grab.y };
  };
  let moving = false;

  return {
    onMove(sp) {
      if (!moving && dist(sp, downScreen) <= DRAG_SLOP_PX) return;
      moving = true;
      controller.repeatDrag = { dir, translate: rawAt(sp) };
      controller.notifyView();
    },
    onUp() {
      // vNext Phase 1: what was on screen when the finger lifted is exactly what's kept, never
      // recomputed from where the pointer came up; a press that never moved changes nothing.
      const shown = controller.repeatDrag?.translate;
      controller.repeatDrag = null;
      if (!shown || (shown.x === start.x && shown.y === start.y)) {
        controller.notify();
        return;
      }
      controller.commit((d) => {
        d.repeat[dir] = { x: shown.x, y: shown.y };
      });
    },
    onCancel() {
      controller.repeatDrag = null;
      controller.notify();
    },
  };
}

/** The box's top-right corner: the shared turn, by as much as the finger goes round the centre,
 * snapping to the same fractions of a turn as before. Kept exactly as shown at release. */
function rotateGesture(controller: AppController, box: RepeatBox, down: Vec2): Gesture {
  const startRotation = controller.doc.repeat.motif.rotation;
  const angle = (sp: Vec2) => Math.atan2(sp.y - box.centre.y, sp.x - box.centre.x);
  const from = angle(down);
  let moving = false;
  return {
    onMove(sp) {
      if (!moving && dist(sp, down) <= DRAG_SLOP_PX) return;
      moving = true;
      let delta = angle(sp) - from;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      controller.repeatRotateDrag = { rawRotation: snapRotation(startRotation + delta) };
      controller.notifyView();
    },
    onUp() {
      const rotation = controller.repeatRotateDrag?.rawRotation;
      controller.repeatRotateDrag = null;
      if (rotation === undefined || rotation === startRotation) {
        if (!moving) showToast(`Drag round the centre to turn every copy · now ${rotationFractionLabel(startRotation) ?? `${Math.round((startRotation * 180) / Math.PI)}°`}`);
        controller.notify();
        return;
      }
      controller.commit((d) => {
        d.repeat.motif = { ...d.repeat.motif, rotation };
      });
    },
    onCancel() {
      controller.repeatRotateDrag = null;
      controller.notify();
    },
  };
}

/** The box's bottom-right corner: the shared scale, proportional to the finger's distance from the
 * centre (25–400 %, a light snap at 100 %). Line weight never changes. Kept exactly as shown. */
function scaleGesture(controller: AppController, box: RepeatBox, down: Vec2): Gesture {
  const start = poseScale(controller.doc.repeat.motif);
  const from = dist(down, box.centre);
  let moving = false;
  return {
    onMove(sp) {
      if (!moving && dist(sp, down) <= DRAG_SLOP_PX) return;
      moving = true;
      controller.repeatScaleDrag = { scale: draggedScale(start, from, dist(sp, box.centre)) };
      controller.notifyView();
    },
    onUp() {
      const scale = controller.repeatScaleDrag?.scale;
      controller.repeatScaleDrag = null;
      if (scale === undefined || scale === start) {
        if (!moving) showToast(`Drag to scale every copy · now ${scaleLabel(start)}`);
        controller.notify();
        return;
      }
      controller.commit((d) => {
        d.repeat.motif = { ...d.repeat.motif, scale };
      });
    },
    onCancel() {
      controller.repeatScaleDrag = null;
      controller.notify();
    },
  };
}

/** A press on one of the box's corners. Reset and Reflect act on a tap (a press that moves off does
 * nothing); Rotate and Scale are dragged. Each change is one Undo step. */
function boxHandleGesture(controller: AppController, box: RepeatBox, handle: RepeatBox['handles'][number], down: Vec2): Gesture {
  if (handle.id === 'rotate') return rotateGesture(controller, box, down);
  if (handle.id === 'scale') return scaleGesture(controller, box, down);
  return {
    onMove() {},
    onUp(sp) {
      if (dist(sp, down) > DRAG_SLOP_PX) return;
      if (!handle.enabled) {
        showToast('Already as drawn · no turn, 100 %, not reflected');
        return;
      }
      if (handle.id === 'reflect') {
        const was = !!controller.doc.repeat.motif.mirror;
        controller.commit((d) => {
          d.repeat.motif = reflectedMotif(d.repeat.motif);
        });
        showToast(was ? 'Reflection off' : 'Reflected · left and right swap in every copy');
      } else {
        controller.commit((d) => {
          d.repeat.motif = resetMotif(d.repeat.motif);
        });
        showToast('As drawn · no turn, 100 %, not reflected · A and B kept');
      }
    },
    onCancel() {},
  };
}

/** A press on the central motif: held still, it opens the box; a tap outside an open box closes it.
 * Otherwise nothing (Repeat has no other single-finger gesture there). */
function motifPressGesture(controller: AppController, view: ViewTransform, down: Vec2, onMotif: boolean): Gesture {
  let held = false;
  let moved = false;
  const timer = onMotif
    ? setTimeout(() => {
        if (moved) return;
        held = true;
        controller.repeatBox = true;
        controller.notify();
      }, REPEAT_BOX_HOLD_MS)
    : null;
  return {
    onMove(sp) {
      if (!moved && dist(sp, down) > DRAG_SLOP_PX) {
        moved = true;
        if (timer) clearTimeout(timer);
      }
    },
    onUp(sp, wasDrag) {
      if (timer) clearTimeout(timer);
      if (held || moved || wasDrag) return;
      // A tap outside the open box closes it.
      if (controller.repeatBox && !insideRepeatBox(controller, view, sp)) {
        controller.repeatBox = false;
        controller.notify();
      }
    },
    onCancel() {
      if (timer) clearTimeout(timer);
    },
  };
}

/** A right-click (or Control-click) in Repeat: on the central motif it opens the box; anywhere else it
 * closes it. True when it was taken. */
export function openRepeatBoxAt(controller: AppController, view: ViewTransform, sp: Vec2): boolean {
  if (controller.doc.view.workspace !== 'repeat' || !controller.doc.repeatDisplay.handles) return false;
  if (controller.repeatColourMode || controller.spaceMode || controller.weaveEdit || controller.closeGap) return false;
  const on = onCentralMotif(controller, view, sp) || insideRepeatBox(controller, view, sp);
  controller.repeatBox = on;
  controller.notify();
  return true;
}

/** The colour Repeat Fill applies next, #rrggbb (null = unfilled). */
export const REPEAT_PAINT_DEFAULT = '#1E3A6E';
export function repeatPaint(controller: AppController): string | null {
  const p = controller.doc.repeatPaint;
  return p ? p.colour : REPEAT_PAINT_DEFAULT;
}
/** The Fill opacity applied next (0–1). */
export function repeatPaintOpacity(controller: AppController): number {
  return controller.doc.repeatPaint?.opacity ?? 1;
}
/** The fill a tap applies next: the colour carrying its opacity (#rrggbbaa below 100%), or null. */
export function repeatFill(controller: AppController): string | null {
  const c = repeatPaint(controller);
  return c ? withAlpha(c, repeatPaintOpacity(controller)) : null;
}

/** Final sprint, Stage 1 — one Fill: a tap fills whatever enclosed region is under it, and the app
 * decides what kind it is (repeatColour.ts `fillTargetAt`): a region of the design — the motif's, or
 * the Intersect unit's, bounded by any of its members and the Developed Primary together — in every
 * copy (or, in Pattern, in every copy of the tapped copy's group); or an enclosed space between copies,
 * with every space like it. A region that already has exactly this colour returns to as designed (a
 * space: unfilled). One Undo step; never the construction, its fills or the lattice. A tap in no
 * enclosed region marks where it is open (repeatGaps.ts), changing nothing. */
function fillTapGesture(controller: AppController, view: ViewTransform): Gesture {
  return {
    onMove() {},
    onUp(sp, wasDrag) {
      if (wasDrag) return;
      const doc = controller.doc;
      controller.repeatGapMarks = null;
      const target = fillTargetAt(doc, view, sp);
      if (!target) {
        const marks = fillOpeningsAt(doc, screenToWorld(view, sp));
        if (marks) {
          controller.repeatGapMarks = { ...marks, doc };
          showToast(marks.ends.length ? 'Not closed · its open ends are marked' : 'Not closed · the lines miss where marked', 2600, 'warning');
        } else showToast('Not an enclosed region', 2200, 'warning');
        controller.notifyView();
        return;
      }
      const paint = repeatFill(controller);
      if (target.kind === 'space') {
        const hit = target.space;
        const keys = (computeSpaces(doc).groups.get(hit.group) ?? [hit]).map((c) => c.key);
        const now = doc.repeat.gapFills.get(hit.key);
        if (!now && !paint) return; // "No fill" on an empty space: nothing to clear
        const clear = !paint || now === paint;
        controller.commit((d) => {
          for (const k of keys) {
            if (clear) d.repeat.gapFills.delete(k);
            else d.repeat.gapFills.set(k, paint!);
          }
        });
        // A space closed only across a hair-line gap: said once, plainly, so it is never a surprise.
        if (!clear && hit.gap > 0) showToast(`Filled · its copies miss by ${Number(hit.gap.toFixed(2))} — under the line`, 2600);
        return;
      }
      const colour = doc.repeatSetup?.colour;
      const group = controller.repeatColourMode === 'pattern' ? patternGroup(colour, target.i, target.j) : 0;
      controller.commit((d) => {
        d.repeatSetup = { ...(d.repeatSetup ?? { source: repeatSourceOf(d) }), colour: toggleRegion(d.repeatSetup?.colour, target.key, paint, group) };
      });
      // Overlapping copies are not regions of their own: say plainly which one was coloured.
      if (target.overlapped) showToast('Overlap · the region on top was coloured');
    },
    onCancel() {},
  };
}

/** Sprint S3 — Interlaced: a tap on a crossing swaps which band passes over there (in every copy of it),
 * one Undo step; the construction is never touched. */
function weaveTapGesture(controller: AppController, view: ViewTransform): Gesture {
  return {
    onMove() {},
    onUp(sp, wasDrag) {
      if (wasDrag) return;
      const doc = controller.doc;
      const stroke = doc.repeatSetup?.stroke;
      if (!stroke) return;
      const hit = crossingNear(weaveNetwork(doc), screenToWorld(view, sp), CROSSING_REACH_PX / view.zoom);
      if (!hit) {
        showToast('No crossing here · tap where two bands cross', 2200);
        return;
      }
      controller.commit((d) => {
        d.repeatSetup = { ...d.repeatSetup!, stroke: withFlip(d.repeatSetup!.stroke!, hit.crossing.key) };
      });
    },
    onCancel() {},
  };
}
/** How near a tap must be to a crossing (px). */
const CROSSING_REACH_PX = 24;

/** Close Gap's tap (interaction/closeGapMode.ts): the valid gaps near the tap — the nearest previewed
 * at once, up to two more offered — or, if none, a plain word on why. Never changes the artwork. */
function closeGapTapGesture(controller: AppController, view: ViewTransform): Gesture {
  return {
    onMove() {},
    onUp(sp, wasDrag) {
      if (wasDrag) return;
      const { local, rejected } = gapsAtTap(controller.doc, screenToWorld(view, sp), CLOSE_GAP_REACH_PX / view.zoom);
      if (local.length > 0) {
        controller.closeGap = { phase: 'preview', local, index: 0 };
      } else {
        controller.closeGap = { phase: 'pick' };
        if (rejected.length > 0) showToast(`Can't close this gap · ${rejected[0]}`, 3400, 'warning');
        else showToast('No small gap here · tap right beside one', 2400);
      }
      controller.notify();
    },
    onCancel() {},
  };
}

export const repeatTool: ToolModule = {
  id: 'select', // never looked up by id — main.ts routes to this tool directly for the Repeat workspace
  hint() {
    return 'Drag a neighbour to set spacing · hold the motif to turn, reflect or scale it';
  },
  beginGesture(controller, view, screenPos): Gesture | null {
    if (controller.closeGap) {
      // The lattice handles stay completely free: dragging one leaves any preview and goes on picking.
      if (controller.doc.repeatDisplay.handles) {
        const pivot = controller.doc.frame.origin;
        for (const dir of ['a', 'b'] as const) {
          const vec = controller.doc.repeat[dir];
          if (dist(screenPos, worldToScreen(view, { x: pivot.x + vec.x, y: pivot.y + vec.y })) <= HANDLE_HIT_RADIUS) {
            controller.closeGap = { phase: 'pick' };
            return dragHandleGesture(controller, view, dir, screenPos);
          }
        }
      }
      return closeGapTapGesture(controller, view);
    }
    if (controller.repeatColourMode || controller.spaceMode) return fillTapGesture(controller, view);
    if (controller.weaveEdit) return weaveTapGesture(controller, view);
    if (!controller.doc.repeatDisplay.handles) return null; // hidden handles are not interactive
    const doc = controller.doc;
    const pivot = doc.frame.origin;

    for (const dir of ['a', 'b'] as const) {
      const vec = doc.repeat[dir];
      const anchorScreen = worldToScreen(view, { x: pivot.x + vec.x, y: pivot.y + vec.y });
      if (dist(screenPos, anchorScreen) <= HANDLE_HIT_RADIUS) return dragHandleGesture(controller, view, dir, screenPos);
    }

    // Then the open box's corners (A and B stay draggable while it is open), then the motif itself.
    const corner = repeatBoxHandleAt(controller, view, screenPos);
    if (corner) return boxHandleGesture(controller, corner.box, corner.handle, screenPos);
    const onMotif = onCentralMotif(controller, view, screenPos);
    if (onMotif || repeatBoxOpen(controller)) return motifPressGesture(controller, view, screenPos, onMotif);
    return null;
  },
};
