// Phase 5: Repeat's single always-on manipulation tool — no dock, no tool switching. A
// single-finger touch either drags a lattice-arm handle (redefining that translation), drags the
// rotation ring (redefining the motif's base rotation), or does nothing (Repeat has no
// construction gestures — item 11: two-finger input is already claimed by pan/zoom upstream in
// PointerManager, so everything reaching here is genuinely single-finger).

import type { Vec2 } from '../../model/types.ts';
import type { AppController, ViewTransform } from '../../app/controller.ts';
import { screenToWorld, worldToScreen } from '../../app/controller.ts';
import { contactModel, motifRadius, snapRotation, type ContactModel } from '../../geometry/lattice.ts';
import { dist } from '../../geometry/vec.ts';
import { computeSpaces, spaceAt } from '../../geometry/spaces.ts';
import { withAlpha } from '../../model/colour.ts';
import { showToast } from '../../ui/toast.ts';
import type { Gesture, ToolModule } from './types.ts';

const HANDLE_HIT_RADIUS = 26; // px — generous, these are the only two draggable points
const RING_HIT_BAND = 22; // px either side of the ring's own radius

// Phase 5.1 item 1: contact hysteresis, in screen px so it feels the same at any zoom. Entering a
// snap needs the finger close; leaving needs a deliberate pull well past that, so finger jitter
// inside the band can never flip snapped → free → snapped.
const DETENT_ENTER = 12;
const DETENT_RELEASE = 32;
const CONTOUR_ENTER = 9;
const CONTOUR_RELEASE = 28;
const ATTRACT_RADIUS = 36; // magnetic approach begins here…
const ATTRACT_MAX = 0.55; // …pulling at most this fraction of the way toward the detent before it snaps

type Snap = { kind: 'detent'; index: number } | { kind: 'contour' } | null;

function sameSnap(a: Snap, b: Snap): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'detent' && b.kind === 'detent') return a.index === b.index;
  return a.kind === b.kind;
}

function attraction(distPx: number, enterPx: number): number {
  if (distPx >= ATTRACT_RADIUS) return 0;
  const t = (ATTRACT_RADIUS - distPx) / (ATTRACT_RADIUS - enterPx);
  return Math.min(1, t) ** 2 * ATTRACT_MAX;
}

interface SnapResult {
  snap: Snap;
  shown: Vec2;
}

/**
 * One step of the free → magnetic approach → snapped → deliberate pull-away → free machine.
 * Detents (exact edge-to-edge / corner-to-corner placements) outrank the contact contour (any
 * touching position along the current drag direction); while on the contour, sliding toward a
 * detent is what captures it, so the neighbour can glide round the reference into alignment.
 */
function stepSnap(model: ContactModel, prev: Snap, raw: Vec2, zoom: number, lastUnit: Vec2): SnapResult & { unit: Vec2 } {
  const len = Math.hypot(raw.x, raw.y);
  const unit = len > 1e-9 ? { x: raw.x / len, y: raw.y / len } : lastUnit;
  const contactLen = model.contactDistance(unit);
  const contourPos = { x: unit.x * contactLen, y: unit.y * contactLen };
  const radialPx = Math.abs(len - contactLen) * zoom;
  // Measured along the contact (not straight from the finger) once the neighbour is touching, so
  // gliding round the reference reaches — and leaves — a detent by sliding. Entering uses the
  // tight contour band, releasing the loose one: the same asymmetry as everything else here.
  const onContour = prev?.kind === 'contour' || radialPx <= CONTOUR_ENTER;
  const enterProbe = onContour ? contourPos : raw;
  const releaseProbe = radialPx <= CONTOUR_RELEASE ? contourPos : raw;

  let nearest = -1;
  let nearestPx = Infinity;
  model.detents.forEach((d, i) => {
    const px = dist(enterProbe, d.translate) * zoom;
    if (px < nearestPx) {
      nearestPx = px;
      nearest = i;
    }
  });

  let snap: Snap = prev;
  if (snap?.kind === 'detent' && dist(releaseProbe, model.detents[snap.index]!.translate) * zoom > DETENT_RELEASE) snap = null;
  if (snap?.kind === 'contour' && radialPx > CONTOUR_RELEASE) snap = null;
  if (snap?.kind !== 'detent' && nearest >= 0 && nearestPx <= DETENT_ENTER) snap = { kind: 'detent', index: nearest };
  if (!snap && radialPx <= CONTOUR_ENTER) snap = { kind: 'contour' };

  if (snap?.kind === 'detent') return { snap, shown: model.detents[snap.index]!.translate, unit };
  if (snap?.kind === 'contour') return { snap, shown: contourPos, unit };

  // Free: a soft pull toward whichever detent/contour is closest, never all the way.
  const wDetent = nearest >= 0 ? attraction(dist(raw, model.detents[nearest]!.translate) * zoom, DETENT_ENTER) : 0;
  const wContour = attraction(radialPx, CONTOUR_ENTER);
  const target = wDetent >= wContour && nearest >= 0 ? model.detents[nearest]!.translate : contourPos;
  const w = Math.max(wDetent, wContour);
  return { snap: null, shown: { x: raw.x + (target.x - raw.x) * w, y: raw.y + (target.y - raw.y) * w }, unit };
}

function contactLabel(model: ContactModel, t: Vec2): string | null {
  const state = model.classify(t);
  return state === 'edges-meet' ? 'Edges meet' : state === 'tips-touch' ? 'Tips touch' : null;
}

function dragHandleGesture(controller: AppController, view: ViewTransform, dir: 'a' | 'b', downScreen: Vec2): Gesture {
  const pivot = controller.doc.frame.origin;
  const start = controller.doc.repeat[dir];
  const model = contactModel(controller.doc, dir);
  // Keep the handle where it was relative to the finger rather than jumping it under the fingertip.
  const downWorld = screenToWorld(view, downScreen);
  const grab = { x: start.x - (downWorld.x - pivot.x), y: start.y - (downWorld.y - pivot.y) };
  const rawAt = (sp: Vec2): Vec2 => {
    const w = screenToWorld(view, sp);
    return { x: w.x - pivot.x + grab.x, y: w.y - pivot.y + grab.y };
  };

  // A neighbour already resting on a detent starts snapped, so picking it up doesn't re-announce it.
  const initial = stepSnap(model, null, start, view.zoom, { x: 1, y: 0 });
  let snap: Snap = initial.snap;
  let lastUnit = initial.unit;

  return {
    onMove(sp) {
      const step = stepSnap(model, snap, rawAt(sp), view.zoom, lastUnit);
      lastUnit = step.unit;
      if (step.snap && !sameSnap(step.snap, snap)) {
        const label = contactLabel(model, step.shown);
        if (label && (snap === null || step.snap.kind === 'detent')) {
          controller.flashRepeatContact(label);
          // A tactile tick where supported (Android); iOS Safari has no vibrate API at all.
          if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8);
        }
      }
      snap = step.snap;
      controller.repeatDrag = { dir, translate: step.shown, snapped: snap !== null };
      controller.notifyView();
    },
    onUp(_sp, wasDrag) {
      const shown = controller.repeatDrag?.translate;
      controller.repeatDrag = null;
      if (!wasDrag || !shown) {
        controller.notify();
        return;
      }
      // What was on screen at release is exactly what's kept — no second, different snap.
      controller.commit((d) => {
        d.repeat[dir] = shown;
      });
    },
    onCancel() {
      controller.repeatDrag = null;
      controller.notify();
    },
  };
}

function rotateRingGesture(controller: AppController, view: ViewTransform): Gesture {
  const pivot = controller.doc.frame.origin;
  function angleAt(sp: Vec2): number {
    const centre = worldToScreen(view, pivot);
    return Math.atan2(sp.y - centre.y, sp.x - centre.x) + Math.PI / 2;
  }
  return {
    onMove(sp) {
      controller.repeatRotateDrag = { rawRotation: snapRotation(angleAt(sp)) };
      controller.notifyView();
    },
    onUp(sp, wasDrag) {
      controller.repeatRotateDrag = null;
      if (!wasDrag) {
        controller.notify();
        return;
      }
      const rotation = snapRotation(angleAt(sp));
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

/** Phase 5.6 items 19–23: with Space on, a tap colours the enclosed gap under it — and with it
 * every equivalent gap across the tessellation (its whole class) — or, if already coloured, clears
 * that class. Only `repeat.gapFills` changes: never Construct geometry, its fills, or the lattice. */
function spaceTapGesture(controller: AppController, view: ViewTransform): Gesture {
  return {
    onMove() {},
    onUp(sp, wasDrag) {
      if (wasDrag) return;
      const doc = controller.doc;
      const topology = computeSpaces(doc);
      const hit = spaceAt(topology, screenToWorld(view, sp));
      if (!hit) {
        showToast(topology.classes.length > 0 ? 'Not an enclosed space' : 'No enclosed spaces yet');
        return;
      }
      const keys = (topology.groups.get(hit.group) ?? [hit]).map((c) => c.key);
      const coloured = doc.repeat.gapFills.has(hit.key);
      const pref = doc.spaceDefaults;
      if (!coloured && !pref.colour) return; // "No fill" only ever clears
      controller.commit((d) => {
        for (const k of keys) {
          if (coloured) d.repeat.gapFills.delete(k);
          else d.repeat.gapFills.set(k, withAlpha(pref.colour!, pref.opacity));
        }
      });
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
    if (controller.spaceMode) return spaceTapGesture(controller, view);
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
    if (Math.abs(dist(screenPos, centreScreen) - ringRadius) <= RING_HIT_BAND) return rotateRingGesture(controller, view);

    return null;
  },
};
