// Intersection's single always-on tool: every construction can be moved and turned on its own.
// Where the finger goes down decides what a drag does — never the direction it then moves:
// - on the selected construction's rotation handle (a 44 px target around the drawn knob): Rotate
//   only, about the construction's own centre, by as much as the finger goes round it, snapping to
//   the same nice fractions of a turn as Repeat. It never moves the construction.
// - anywhere else on a construction: Move only (and select it). It never turns it.
// Two fingers are pan/zoom, as everywhere (claimed upstream in PointerManager). Each completed move
// or turn is one Undo step. Moving is always free: nothing ever pulls a construction.
//
// What a tap takes is the whole instance (controller.intersectionPickKind 'instance', the default):
// tap one to select it, another to change, empty canvas to deselect. Lines, points and edges are
// taken only once an alignment has been started (Parallel · Join, Point Snap, Match Edge).
// Where instances overlap, the one whose drawn geometry is nearest the finger wins; the selected one
// wins a near-tie (so it stays put under repeated taps); a second tap at the same place moves on to
// the next instance there — so even one entirely covered by others can be reached.
//
// The bounding box (Stage 2b — render/copyBox.ts): a long-press on a copy (or a right-click, from
// main.ts) opens it on that copy — the selected one when the press is on it, else the nearest, as a
// tap would choose but never moving on to the next overlapping one. Its corner handles are answered
// first of all (they are drawn over everything); a tap or click outside the box closes it, and so
// does selecting another copy. Moving and turning work exactly as before while it is open.
//
// A tap (a press that never leaves the drag slop) picks geometry for an explicit Snap
// (geometry/intersectionSnap.ts): the line — or, with the Snap row's switch on Point, the point —
// under the finger. Choosing by kind rather than by distance matters: in a dense construction there
// is a crossing every pixel or two along every line. A tap inside a construction away from its
// lines selects the construction; a tap on empty canvas clears both.

import type { Vec2 } from '../../model/types.ts';
import type { AppController, ViewTransform } from '../../app/controller.ts';
import { screenToWorld, worldToScreen } from '../../app/controller.ts';
import { motifRadius, poseScale, snapRotation } from '../../geometry/lattice.ts';
import { dist } from '../../geometry/vec.ts';
import { copyScale, layoutOf, placedAt, referenceCurrent, shownCopies, withCopyScale, withLayout, withLock, withoutCopy, withReflection, type IntersectionCopy } from '../../geometry/intersection.ts';
import { instanceDistances } from '../../geometry/intersectionLink.ts';
import { showToast } from '../../ui/toast.ts';
import { canMoveAgainst, pickAtTap, pickCarrier, samePick, withEdgePick, withPick, type IntersectionPick } from '../../geometry/intersectionSnap.ts';
import { rotationHandle } from '../../render/intersectionRenderer.ts';
import { boxHandleAt, draggedScale, insideOpenBox, scaleLabel, type CopyBox } from '../../render/copyBox.ts';
import type { Gesture, ToolModule } from './types.ts';

/** The rotation handle answers within this of its centre (px) — a 44 px touch target. */
export const HANDLE_TOUCH_PX = 22;
const DRAG_SLOP_PX = 6; // as Repeat: a press that stays within this moves nothing — it's a tap
/** How close (px) a tap must be to pick a line or point. */
export const PICK_REACH_PX = 14;
/** A press this close (px) to an instance's drawn geometry is on that instance. */
const INSTANCE_REACH_PX = 16;
/** Another instance within this much (px) of the nearest is just as near. */
const OVERLAP_TIE_PX = 4;
/** A second tap this close (px) to the last one moves on to the next overlapping instance. */
const CYCLE_SLOP_PX = 10;

/** A press held this long without moving opens the copy's bounding box (as Select's long-press). */
export const BOX_HOLD_MS = 450;

/** The instances a press at `sp` could mean, best first: those whose drawn geometry is within reach
 * (nearest first), then those whose frame the finger is merely inside (nearest centre first). */
function instancesAt(controller: AppController, view: ViewTransform, sp: Vec2): { key: string; score: number }[] {
  const doc = controller.doc;
  const copies = shownCopies(doc);
  const near = instanceDistances(doc, copies, screenToWorld(view, sp), INSTANCE_REACH_PX / view.zoom);
  const inside = motifRadius(doc) * view.zoom;
  const out: { key: string; score: number }[] = [];
  for (const c of copies) {
    const g = near.get(c.key);
    const fromCentre = dist(sp, centreOf(controller, view, c));
    if (g !== undefined) out.push({ key: c.key, score: g * view.zoom });
    else if (fromCentre <= inside * poseScale(c.pose)) out.push({ key: c.key, score: 1000 + fromCentre });
  }
  return out.sort((a, b) => a.score - b.score);
}

let lastTap: { at: Vec2; key: string } | null = null;

/** A tap that selects an instance (see the top of this file). */
function selectAt(controller: AppController, view: ViewTransform, sp: Vec2): void {
  // A tap outside the open bounding box closes it (selecting another copy would too — copyBox.openBox).
  if (controller.intersectionBox && !insideOpenBox(controller, view, sp)) controller.intersectionBox = null;
  const cands = instancesAt(controller, view, sp);
  const selected = controller.intersectionSelected;
  if (cands.length === 0) {
    lastTap = null;
    controller.intersectionSelected = null;
    controller.intersectionPicks = [];
    controller.notify();
    return;
  }
  const top = cands[0]!;
  const tied = cands.filter((c) => c.score <= top.score + OVERLAP_TIE_PX);
  const at = cands.findIndex((c) => c.key === selected);
  let chosen: string;
  if (lastTap && dist(lastTap.at, sp) <= CYCLE_SLOP_PX && cands.length > 1 && at >= 0) chosen = cands[(at + 1) % cands.length]!.key;
  else if (at >= 0 && tied.some((c) => c.key === selected)) chosen = selected!;
  else chosen = top.key;
  // Only a genuine tie says so — instances overlapping elsewhere are not worth a word.
  if (tied.length > 1 && (!lastTap || dist(lastTap.at, sp) > CYCLE_SLOP_PX)) showToast('Overlapping · tap again to select the next');
  lastTap = { at: sp, key: chosen };
  controller.intersectionSelected = chosen;
  controller.notify();
}

function centreOf(controller: AppController, view: ViewTransform, copy: IntersectionCopy): Vec2 {
  const pivot = controller.doc.frame.origin;
  return worldToScreen(view, { x: pivot.x + copy.pose.translate.x, y: pivot.y + copy.pose.translate.y });
}

function commitPlacement(controller: AppController, key: string, at: Vec2, rotation: number): void {
  controller.commit((d) => {
    d.intersection = withLayout(d, placedAt(layoutOf(d), key, at, rotation));
  });
}

/** A press on a locked construction: a tap still does what a tap does (select, pick); a drag or a
 * turn moves nothing and says why, once. */
function lockedGesture(controller: AppController, copy: IntersectionCopy, down: Vec2, onTap: () => void): Gesture {
  let told = false;
  return {
    onMove(sp) {
      if (told || dist(sp, down) <= DRAG_SLOP_PX) return;
      told = true;
      controller.intersectionSelected = copy.key;
      showToast(`${copy.label} is locked · unlock it to move`, 2200, 'warning');
      controller.notify();
    },
    onUp() {
      if (!told) onTap();
    },
    onCancel() {},
  };
}

function moveGesture(controller: AppController, view: ViewTransform, copy: IntersectionCopy, down: Vec2, onTap: () => void): Gesture {
  if (copy.locked) return lockedGesture(controller, copy, down, onTap);
  const start = copy.pose.translate;
  let moving = false;
  return {
    onMove(sp) {
      if (!moving && dist(sp, down) <= DRAG_SLOP_PX) return;
      moving = true;
      controller.intersectionSelected = copy.key; // (moving another copy closes an open box — copyBox.openBox)
      controller.intersectionDrag = { key: copy.key, x: start.x + (sp.x - down.x) / view.zoom, y: start.y + (sp.y - down.y) / view.zoom, rotation: copy.pose.rotation, mode: 'move' };
      controller.notifyView();
    },
    onUp() {
      const drag = controller.intersectionDrag;
      controller.intersectionDrag = null;
      if (moving && drag) commitPlacement(controller, copy.key, { x: drag.x, y: drag.y }, drag.rotation);
      else onTap();
    },
    onCancel() {
      controller.intersectionDrag = null;
      controller.notify();
    },
  };
}

function turnGesture(controller: AppController, view: ViewTransform, copy: IntersectionCopy, down: Vec2): Gesture {
  if (copy.locked) return lockedGesture(controller, copy, down, () => selectAt(controller, view, down));
  const centre = centreOf(controller, view, copy);
  const angleAt = (sp: Vec2) => Math.atan2(sp.y - centre.y, sp.x - centre.x);
  let moving = false;
  // How far the finger has gone round the centre since it went down — the short way each step, so
  // passing straight up or down never jumps a whole turn.
  let last = angleAt(down);
  let turned = 0;
  return {
    onMove(sp) {
      if (!moving && dist(sp, down) <= DRAG_SLOP_PX) return;
      moving = true;
      const now = angleAt(sp);
      turned += Math.atan2(Math.sin(now - last), Math.cos(now - last));
      last = now;
      controller.intersectionDrag = { key: copy.key, x: copy.pose.translate.x, y: copy.pose.translate.y, rotation: snapRotation(copy.pose.rotation + turned), mode: 'turn' };
      controller.notifyView();
    },
    onUp() {
      // As Repeat's ring: keep the rotation shown at release, never one recomputed from pointerup.
      const drag = controller.intersectionDrag;
      controller.intersectionDrag = null;
      if (moving && drag && drag.rotation !== copy.pose.rotation) commitPlacement(controller, copy.key, copy.pose.translate, drag.rotation);
      else {
        // A tap on the handle without turning: what is under it — an instance, or (while an
        // alignment is being set up) a line, point or edge.
        if (!moving) {
          if (controller.intersectionPickKind === 'instance') selectAt(controller, view, down);
          else pickAt(controller, view, down);
        }
        controller.notify();
      }
    },
    onCancel() {
      controller.intersectionDrag = null;
      controller.notify();
    },
  };
}

/**
 * Opens the bounding box on the copy under `sp` (a long-press, or a right-click): the selected copy
 * when the press is on it, else the nearest — never the next of several overlapping (a tap moves on
 * to that). False when no copy is there (and any open box closes).
 */
export function openBoxAt(controller: AppController, view: ViewTransform, sp: Vec2): boolean {
  const cands = instancesAt(controller, view, sp);
  if (cands.length === 0) {
    if (controller.intersectionBox) {
      controller.intersectionBox = null;
      controller.notify();
    }
    return false;
  }
  const top = cands[0]!;
  const tied = cands.filter((c) => c.score <= top.score + OVERLAP_TIE_PX);
  const selected = controller.intersectionSelected;
  const key = selected && tied.some((c) => c.key === selected) ? selected : top.key;
  if (tied.length > 1) showToast('Overlapping · tap to choose another copy, then hold');
  lastTap = null;
  controller.intersectionSelected = key;
  controller.intersectionBox = key;
  controller.notify();
  return true;
}

/** A press held still for BOX_HOLD_MS opens the bounding box instead of doing what `inner` would. */
function holdForBox(controller: AppController, view: ViewTransform, down: Vec2, inner: Gesture): Gesture {
  let held = false;
  let moved = false;
  const timer = setTimeout(() => {
    if (moved) return;
    held = true;
    inner.onCancel();
    openBoxAt(controller, view, down);
  }, BOX_HOLD_MS);
  return {
    onMove(sp) {
      if (held) return;
      if (!moved && dist(sp, down) > DRAG_SLOP_PX) {
        moved = true;
        clearTimeout(timer);
      }
      inner.onMove(sp);
    },
    onUp(sp, wasDrag) {
      clearTimeout(timer);
      if (!held) inner.onUp(sp, wasDrag);
    },
    onCancel() {
      clearTimeout(timer);
      if (!held) inner.onCancel();
    },
  };
}

/** Why a handle can't be used now. */
function handleRefusal(copy: IntersectionCopy, id: CopyBox['handles'][number]['id']): string {
  if (copy.locked) return `${copy.label} is locked · unlock it to ${id === 'reflect' ? 'reflect' : 'scale'} it`;
  return 'The Original stays as constructed';
}

/** A press on one of the open box's corner handles. Reflect, Delete and Lock act on a tap (a press
 * that moves off does nothing); Scale is dragged. Each change is one Undo step. */
function boxHandleGesture(controller: AppController, box: CopyBox, handle: CopyBox['handles'][number], down: Vec2): Gesture {
  const copy = box.copy;
  if (handle.id === 'scale' && handle.enabled) {
    const start = copyScale(controller.doc, copy.key);
    const from = dist(down, box.centre);
    let moving = false;
    return {
      onMove(sp) {
        if (!moving && dist(sp, down) <= DRAG_SLOP_PX) return;
        moving = true;
        controller.intersectionDrag = { key: copy.key, x: copy.pose.translate.x, y: copy.pose.translate.y, rotation: copy.pose.rotation, mode: 'scale', scale: draggedScale(start, from, dist(sp, box.centre)) };
        controller.notifyView();
      },
      onUp() {
        // Keep exactly the scale shown at release.
        const drag = controller.intersectionDrag;
        controller.intersectionDrag = null;
        const scale = drag?.mode === 'scale' ? drag.scale ?? 1 : start;
        if (moving && scale !== start) {
          const next = withCopyScale(controller.doc, copy.key, scale);
          if (next) {
            controller.commit((d) => {
              d.intersection = next;
            });
          }
        } else {
          if (!moving) showToast(`Drag to scale ${copy.label} · now ${scaleLabel(start)}`);
          controller.notify();
        }
      },
      onCancel() {
        controller.intersectionDrag = null;
        controller.notify();
      },
    };
  }
  return {
    onMove() {},
    onUp(sp) {
      if (dist(sp, down) > DRAG_SLOP_PX) return;
      if (!handle.enabled) {
        showToast(handleRefusal(copy, handle.id), 2200, 'warning');
        return;
      }
      const doc = controller.doc;
      if (handle.id === 'reflect') {
        const next = withReflection(doc, copy.key, 'h');
        if (next) controller.commit((d) => {
          d.intersection = next;
        });
      } else if (handle.id === 'lock') {
        const next = withLock(doc, copy.key, !copy.locked);
        controller.commit((d) => {
          d.intersection = next;
        });
        showToast(copy.locked ? `${copy.label} unlocked` : `${copy.label} locked · it stays where it is, and can still be snapped to`);
      } else if (handle.id === 'delete') {
        const wasCurrent = referenceCurrent(layoutOf(doc));
        const next = withoutCopy(doc, copy.key);
        if (!next) return;
        controller.intersectionBox = null;
        controller.intersectionSelected = null;
        controller.intersectionPicks = [];
        controller.commit((d) => {
          d.intersection = next;
        });
        showToast(wasCurrent && !referenceCurrent(layoutOf(controller.doc)) ? `${copy.label} deleted · Undo brings it back · set a new Reference to use Spread` : `${copy.label} deleted · Undo brings it back`);
      }
      controller.notify();
    },
    onCancel() {},
  };
}

export const intersectionTool: ToolModule = {
  id: 'select', // never looked up by id — main.ts routes to this tool directly for Intersection
  hint() {
    return 'Drag a construction to move it, or its handle to turn it';
  },
  beginGesture(controller, view, sp): Gesture | null {
    const copies = shownCopies(controller.doc);
    // The open bounding box's corner handles first of all (drawn over everything).
    const onBox = boxHandleAt(controller, view, sp);
    if (onBox) return boxHandleGesture(controller, onBox.box, onBox.handle, sp);
    // The selected construction's rotation handle next: Rotate only.
    const selected = copies.find((c) => c.key === controller.intersectionSelected);
    if (selected && !selected.locked && dist(sp, rotationHandle(controller.doc, view, selected)) <= HANDLE_TOUCH_PX) {
      return turnGesture(controller, view, selected, sp);
    }
    // Instance-first (the default): the selected instance when the press is on it — it is the one
    // being arranged — else the instance the press is nearest; a tap selects (selectAt).
    if (controller.intersectionPickKind === 'instance') {
      const cands = instancesAt(controller, view, sp);
      const key = cands.some((c) => c.key === controller.intersectionSelected) ? controller.intersectionSelected : cands[0]?.key;
      const body = copies.find((c) => c.key === key);
      // Held still: the bounding box (holdForBox); else a move, or a tap that selects.
      if (body) return holdForBox(controller, view, sp, moveGesture(controller, view, body, sp, () => selectAt(controller, view, sp)));
      return {
        onMove() {},
        onUp(_sp, wasDrag) {
          if (!wasDrag) selectAt(controller, view, sp);
        },
        onCancel() {},
      };
    }
    // While an alignment is being set up: the construction whose centre is nearest, among those
    // whose frame the finger is on (a tap there picks its line, point or edge).
    const reach = motifRadius(controller.doc) * view.zoom;
    let hit: IntersectionCopy | null = null;
    let best = Infinity;
    for (const c of copies) {
      const d = dist(sp, centreOf(controller, view, c));
      if (d <= reach * poseScale(c.pose) && d < best) {
        best = d;
        hit = c;
      }
    }
    if (hit) {
      const body = hit;
      return moveGesture(controller, view, body, sp, () => {
        // A tap on a construction: its line or point if the finger is on one, else the construction.
        if (!pickAt(controller, view, sp)) controller.intersectionSelected = body.key;
        controller.notify();
      });
    }
    // Outside every construction: a tap picks an extension line or a crossing out there, or —
    // on empty canvas — clears the picks and the selection.
    return {
      onMove() {},
      onUp(_sp, wasDrag) {
        if (wasDrag) return;
        if (!pickAt(controller, view, sp)) {
          if (!controller.intersectionSelected && controller.intersectionPicks.length === 0) return;
          controller.intersectionSelected = null;
          controller.intersectionPicks = [];
        }
        controller.notify();
      },
      onCancel() {},
    };
  },
};

/** The line or point under a tap at `sp`, if any — once there is a reference, one that can move
 * against it first (or the picks themselves, to un-pick them). */
function pickUnder(controller: AppController, view: ViewTransform, sp: Vec2): IntersectionPick | null {
  const [reference, moving] = controller.intersectionPicks;
  const edge = controller.intersectionPickKind === 'edge';
  // Match Edge: [moving edge, target edge]; a target is an edge of another construction.
  const accept = (p: IntersectionPick) =>
    !reference || samePick(reference, p) || (!!moving && samePick(moving, p)) || (edge ? p.kind === 'line' && reference.kind === 'line' && p.copy !== reference.copy : canMoveAgainst(reference, p));
  return pickAtTap(controller.doc, shownCopies(controller.doc), screenToWorld(view, sp), PICK_REACH_PX / view.zoom, controller.intersectionPickKind, accept);
}

/** Picks what is under a tap (see withPick); the construction that would move — else the one
 * picked — becomes the selected one, so its ring shows which it is. False if nothing is there. */
function pickAt(controller: AppController, view: ViewTransform, sp: Vec2): boolean {
  const pick = pickUnder(controller, view, sp);
  if (!pick) return false;
  if (controller.intersectionPickKind === 'edge') {
    // The construction that moves is the first edge's: it is the selected one.
    controller.intersectionPicks = withEdgePick(controller.intersectionPicks, pick);
    const first = controller.intersectionPicks[0];
    controller.intersectionSelected = first ? pickCarrier(first) : null;
    return true;
  }
  controller.intersectionPicks = withPick(controller.intersectionPicks, pick);
  const [reference, moving] = controller.intersectionPicks;
  const owner = moving ?? reference;
  controller.intersectionSelected = owner ? pickCarrier(owner) : null;
  return true;
}
