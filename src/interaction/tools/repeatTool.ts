// Phase 5: Repeat's single always-on manipulation tool — no dock, no tool switching. A
// single-finger touch either drags a lattice-arm handle (redefining that translation), drags the
// rotation ring (redefining the motif's base rotation), or does nothing (Repeat has no
// construction gestures — item 11: two-finger input is already claimed by pan/zoom upstream in
// PointerManager, so everything reaching here is genuinely single-finger).

import type { Vec2 } from '../../model/types.ts';
import type { AppController, ViewTransform } from '../../app/controller.ts';
import { screenToWorld, worldToScreen } from '../../app/controller.ts';
import { motifRadius, snapRotation } from '../../geometry/lattice.ts';
import { dist } from '../../geometry/vec.ts';
import { computeSpaces, spaceAt } from '../../geometry/spaces.ts';
import { withAlpha } from '../../model/colour.ts';
import { patternGroup, regionAtInRepeat, toggleRegion } from '../../geometry/repeatColour.ts';
import { repeatSourceOf } from '../../geometry/repeatSetup.ts';
import { showToast } from '../../ui/toast.ts';
import { gapsAtTap } from '../closeGapMode.ts';
import type { Gesture, ToolModule } from './types.ts';

const HANDLE_HIT_RADIUS = 26; // px — generous, these are the only two draggable points
const RING_HIT_BAND = 22; // px either side of the ring's own radius

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

function rotateRingGesture(controller: AppController, view: ViewTransform, downScreen: Vec2): Gesture {
  const pivot = controller.doc.frame.origin;
  const startRotation = controller.doc.repeat.motif.rotation;
  function angleAt(sp: Vec2): number {
    const centre = worldToScreen(view, pivot);
    return Math.atan2(sp.y - centre.y, sp.x - centre.x) + Math.PI / 2;
  }
  let moving = false;
  return {
    onMove(sp) {
      if (!moving && dist(sp, downScreen) <= DRAG_SLOP_PX) return;
      moving = true;
      controller.repeatRotateDrag = { rawRotation: snapRotation(angleAt(sp)) };
      controller.notifyView();
    },
    onUp() {
      // vNext Phase 1: as for the handles — keep the rotation shown at release (snapped or not),
      // never one recomputed from the pointerup position.
      const rotation = controller.repeatRotateDrag?.rawRotation;
      controller.repeatRotateDrag = null;
      if (rotation === undefined || rotation === startRotation) {
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

/** Fill · Space: a tap fills the enclosed space under it — and with it every equivalent space across
 * the tessellation (its whole class) — with the Fill colour; tapping a space that already has exactly
 * that colour (or with "No fill") clears it. Only `repeat.gapFills` changes: never Construct geometry,
 * its fills, or the lattice. A tap inside a motif says so instead. */
function spaceTapGesture(controller: AppController, view: ViewTransform): Gesture {
  return {
    onMove() {},
    onUp(sp, wasDrag) {
      if (wasDrag) return;
      const doc = controller.doc;
      const topology = computeSpaces(doc);
      const hit = spaceAt(topology, screenToWorld(view, sp));
      if (!hit) {
        if (regionAtInRepeat(doc, view, sp)) showToast('That’s inside a motif · choose Motif to fill it', 2400, 'warning');
        else showToast(topology.classes.length > 0 ? 'Not an enclosed space' : 'No enclosed spaces · the copies don’t meet', 2400, 'warning');
        return;
      }
      const keys = (topology.groups.get(hit.group) ?? [hit]).map((c) => c.key);
      const paint = repeatFill(controller);
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
    },
    onCancel() {},
  };
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

/** Fill · Motif / Pattern: a tap colours the region under it — in every copy (Motif), or, in
 * Pattern, in every copy of the group the tapped copy belongs to — or, if that region already has
 * exactly this colour there, returns it to as designed. One Undo step; only Repeat's own colouring
 * changes, never the construction or its fills. A tap in a space between copies says so instead. */
function colourTapGesture(controller: AppController, view: ViewTransform): Gesture {
  return {
    onMove() {},
    onUp(sp, wasDrag) {
      if (wasDrag) return;
      const doc = controller.doc;
      const hit = regionAtInRepeat(doc, view, sp);
      if (!hit) {
        if (spaceAt(computeSpaces(doc), screenToWorld(view, sp))) showToast('That’s a space between motifs · choose Space to fill it', 2400, 'warning');
        else showToast('Not a closed region of the design', 2200, 'warning');
        return;
      }
      const colour = doc.repeatSetup?.colour;
      const group = controller.repeatColourMode === 'pattern' ? patternGroup(colour, hit.i, hit.j) : 0;
      const paint = repeatFill(controller);
      controller.commit((d) => {
        d.repeatSetup = { ...(d.repeatSetup ?? { source: repeatSourceOf(d) }), colour: toggleRegion(d.repeatSetup?.colour, hit.key, paint, group) };
      });
      // Overlaps are not regions of their own: say plainly which one was coloured.
      if (hit.overlapped) showToast('Overlap · the region on top was coloured');
    },
    onCancel() {},
  };
}

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
    return 'Drag a neighbour to set spacing, or the ring to rotate';
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
    if (controller.spaceMode) return spaceTapGesture(controller, view);
    if (controller.repeatColourMode) return colourTapGesture(controller, view);
    if (!controller.doc.repeatDisplay.handles) return null; // hidden handles are not interactive
    const doc = controller.doc;
    const pivot = doc.frame.origin;

    for (const dir of ['a', 'b'] as const) {
      const vec = doc.repeat[dir];
      const anchorScreen = worldToScreen(view, { x: pivot.x + vec.x, y: pivot.y + vec.y });
      if (dist(screenPos, anchorScreen) <= HANDLE_HIT_RADIUS) return dragHandleGesture(controller, view, dir, screenPos);
    }

    const centreScreen = worldToScreen(view, pivot);
    const ringRadius = motifRadius(doc) * view.zoom + 26;
    if (Math.abs(dist(screenPos, centreScreen) - ringRadius) <= RING_HIT_BAND) return rotateRingGesture(controller, view, screenPos);

    return null;
  },
};
