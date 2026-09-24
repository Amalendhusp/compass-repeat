// Arc tool — Phase 5.2 items 19/20, Phase 5.6 items 1–8: a digital compass, taught by the canvas
// itself — Measure → Carry → Trace.
// - Measure radius: tap A (highlighted), tap B. A–B shows as a temporary measuring line (never
//   geometry, never history) and the compass opens at A: its centre marked, its circle dotted.
// - Carry: tap any other point and the compass — same radius — moves there, as often as wanted.
// - Trace: touch the dotted circle where the arc should begin and drag round it; the direction
//   dragged is the direction swept, the distance dragged is how far; release draws it.
// Same radius opens the compass straight away at the tapped centre, with the remembered radius
// (shared with Circle). Arc ends snap to points already on that circle and to its crossings with
// existing curves. A tap in empty space, a tool switch or a pinch/pan clears the compass; the tool
// stays Arc.

import type { Doc, Entity, Vec2 } from '../../model/types.ts';
import type { AppController, ViewTransform } from '../../app/controller.ts';
import { screenToWorld, worldToScreen } from '../../app/controller.ts';
import { epsilon, intersectEntities, projectOntoEntity, resolvePoint } from '../../geometry/kernel.ts';
import { isParamTrimmed } from '../../geometry/segments.ts';
import { isPointOrphanedByTrim } from '../../geometry/usage.ts';
import { dist } from '../../geometry/vec.ts';
import { addArc } from '../../model/doc.ts';
import { pickPointTarget, type PointHit } from '../hittest.ts';
import { buildNodeInset } from '../nodeinset.ts';
import { materializeRef, refFromHit, refLocation, type PointRef } from '../pointref.ts';
import type { Gesture, ToolModule } from './types.ts';

const START_BAND_PX = 36; // how close to the compass circle a touch must land to begin a sweep
const SNAP_PX = 16; // arc ends snap to meaningful angles within this arc length on screen
const MIN_ARC_PX = 12; // shorter than this is a touch, not an arc

function wrapPi(a: number): number {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x <= -Math.PI) x += Math.PI * 2;
  return x;
}

/** Angles on the compass circle worth landing on: points already lying on it, and where it
 * would cross existing live curves. Computed once per sweep. */
function snapAngles(doc: Doc, centreRef: PointRef, centre: Vec2, radius: number): number[] {
  const out: number[] = [];
  const tol = epsilon(doc) * 50;
  for (const p of doc.points) {
    if ((p.kind === 'free' && p.hidden) || isPointOrphanedByTrim(doc, p.id)) continue;
    const at = resolvePoint(doc, p.id);
    if (Math.abs(dist(at, centre) - radius) < tol) out.push(Math.atan2(at.y - centre.y, at.x - centre.x));
  }
  // A stand-in circle in a throwaway view of the doc, so the kernel's exact intersection maths
  // can be reused without creating anything.
  const centreId = centreRef.kind === 'existing' ? centreRef.id : '__arc-centre';
  const probe: Doc = {
    ...doc,
    points: [
      ...doc.points,
      ...(centreRef.kind === 'existing' ? [] : [{ id: '__arc-centre', kind: 'free' as const, x: centre.x, y: centre.y, hidden: true }]),
      { id: '__arc-through', kind: 'free', x: centre.x + radius, y: centre.y, hidden: true },
    ],
  };
  const compass: Entity = { id: '__arc', kind: 'circle', centre: centreId, through: '__arc-through' };
  for (const e of doc.entities) {
    for (const loc of intersectEntities(probe, compass, e)) {
      const proj = projectOntoEntity(doc, e, loc);
      if (e.kind === 'line' && !e.extended && (proj.param < -1e-6 || proj.param > 1 + 1e-6)) continue;
      if (isParamTrimmed(doc, e, proj.param)) continue;
      out.push(Math.atan2(loc.y - centre.y, loc.x - centre.x));
    }
  }
  return out;
}

function nearestSnap(angles: number[], angle: number, radiusPx: number): number | null {
  let best: number | null = null;
  let bestPx = SNAP_PX;
  for (const a of angles) {
    const px = Math.abs(wrapPi(a - angle)) * radiusPx;
    if (px < bestPx) {
      bestPx = px;
      best = a;
    }
  }
  return best;
}

/** One point-choosing step (A, B or a centre): press on a target, slide to refine, release.
 * Releasing over nothing clears the whole pending compass (a tap in empty space). */
function pickStep(controller: AppController, view: ViewTransform, screenPos: Vec2, preview: (at: Vec2 | null) => void, onPicked: (hit: PointHit) => void): Gesture {
  const doc = controller.doc;
  let hit = pickPointTarget(doc, view, screenPos);
  preview(hit?.at ?? null);
  controller.notifyView();
  return {
    onMove(sp) {
      hit = pickPointTarget(doc, view, sp);
      controller.nodeInset = hit ? buildNodeInset(doc, view, sp, hit.at) : null;
      preview(hit ? hit.at : screenToWorld(view, sp));
      controller.notifyView();
    },
    onUp() {
      controller.nodeInset = null;
      if (hit) onPicked(hit);
      else controller.cancelPending();
      controller.notify();
    },
    onCancel() {
      controller.cancelPending();
    },
  };
}

type CompassStep = Extract<NonNullable<AppController['pending']>, { kind: 'arc'; stage: 'compass' }>;

const CAPTURED_CUE_MS = 1600;

/** The compass, open at `centre`: dotted circle and centre marker. */
function showCompass(controller: AppController, step: CompassStep): void {
  controller.pending = step;
  controller.preview = { kind: 'arc', centre: refLocation(controller.doc, step.centre), radius: step.radius };
}

/** Carry: the same radius, lifted to another point. The circle follows the finger while choosing. */
function carryGesture(controller: AppController, view: ViewTransform, screenPos: Vec2, step: CompassStep): Gesture {
  return pickStep(
    controller,
    view,
    screenPos,
    (at) => (controller.preview = { kind: 'arc', centre: at ?? refLocation(controller.doc, step.centre), radius: step.radius }),
    (hit) => showCompass(controller, { ...step, centre: refFromHit(hit) }),
  );
}

/** Trace: a touch on the dotted circle starts the arc there; dragging sweeps it. A touch that never
 * sweeps is a tap — on a point, that carries the compass there instead (a point can lie on the
 * circle itself, e.g. B), otherwise the compass simply stays ready. */
function traceGesture(controller: AppController, view: ViewTransform, screenPos: Vec2, step: CompassStep): Gesture {
  const doc = controller.doc;
  const { radius, centre: centreRef } = step;
  const centre = refLocation(doc, centreRef);
  const radiusPx = radius * view.zoom;
  const idle = { kind: 'arc' as const, centre, radius };
  const tapHit = pickPointTarget(doc, view, screenPos);

  const angles = snapAngles(doc, centreRef, centre, radius);
  const angleAt = (sp: Vec2) => {
    const w = screenToWorld(view, sp);
    return Math.atan2(w.y - centre.y, w.x - centre.x);
  };
  const touched = angleAt(screenPos);
  const start = nearestSnap(angles, touched, radiusPx) ?? touched;
  let last = touched;
  let sweep = 0;
  let shown = 0;

  const publish = () => {
    controller.preview = { ...idle, start, sweep: shown };
    controller.notifyView();
  };
  publish();

  return {
    onMove(sp) {
      const a = angleAt(sp);
      sweep = Math.max(-Math.PI * 2, Math.min(Math.PI * 2, sweep + wrapPi(a - last)));
      last = a;
      const end = start + sweep;
      const snap = nearestSnap(angles, end, radiusPx);
      shown = snap === null ? sweep : sweep + wrapPi(snap - end);
      if (Math.abs(Math.abs(shown) - Math.PI * 2) * radiusPx < SNAP_PX) shown = Math.sign(shown) * Math.PI * 2;
      publish();
    },
    onUp(_sp, wasDrag) {
      controller.nodeInset = null;
      if (Math.abs(shown) * radiusPx < MIN_ARC_PX) {
        const carryTo = !wasDrag && tapHit && !(tapHit.id && centreRef.kind === 'existing' && tapHit.id === centreRef.id) ? tapHit : null;
        showCompass(controller, carryTo ? { ...step, centre: refFromHit(carryTo) } : step);
        controller.notify();
        return;
      }
      const sweepFinal = shown;
      controller.commit((d) => {
        addArc(d, materializeRef(d, centreRef), radius, start, sweepFinal);
      });
      // Measuring line, dotted circle and centre marker all go; the radius stays remembered.
      controller.pending = null;
      controller.preview = null;
      controller.notify();
    },
    onCancel() {
      controller.cancelPending();
    },
  };
}

export const arcTool: ToolModule = {
  id: 'arc',
  hint() {
    return '';
  },
  beginGesture(controller, view, screenPos): Gesture | null {
    const doc = controller.doc;
    const prefs = doc.toolPrefs;
    const pending = controller.pending?.kind === 'arc' ? controller.pending : null;

    if (!pending) {
      if (prefs.arcMode === 'same') {
        const radius = prefs.lastRadius;
        if (!radius || !pickPointTarget(doc, view, screenPos)) return null;
        // Same radius: the compass opens right where the centre is chosen.
        return pickStep(
          controller,
          view,
          screenPos,
          (at) => (controller.preview = at ? { kind: 'arc', centre: at, radius } : null),
          (hit) => showCompass(controller, { kind: 'arc', stage: 'compass', radius, centre: refFromHit(hit) }),
        );
      }
      if (!pickPointTarget(doc, view, screenPos)) return null;
      return pickStep(
        controller,
        view,
        screenPos,
        () => (controller.preview = null),
        (hit) => {
          controller.pending = { kind: 'arc', stage: 'measure-b', a: refFromHit(hit) };
        },
      );
    }

    if (pending.stage === 'measure-b') {
      const aRef = pending.a;
      const a = refLocation(doc, aRef);
      return pickStep(
        controller,
        view,
        screenPos,
        (at) => (controller.preview = at ? { kind: 'measure', a, b: at } : null),
        (hit) => {
          const radius = dist(a, hit.at);
          if (radius < epsilon(doc) * 10) {
            controller.cancelPending();
            return;
          }
          doc.toolPrefs.lastRadius = radius;
          showCompass(controller, { kind: 'arc', stage: 'compass', radius, centre: aRef, measure: { a, b: hit.at }, capturedAt: Date.now() });
          // Let the brief "Radius captured" cue give way on its own.
          setTimeout(() => controller.notify(), CAPTURED_CUE_MS + 50);
        },
      );
    }

    // The compass is open: on its circle → trace; on another point → carry; elsewhere → clear.
    const centreScreen = worldToScreen(view, refLocation(doc, pending.centre));
    if (Math.abs(dist(centreScreen, screenPos) - pending.radius * view.zoom) <= START_BAND_PX) return traceGesture(controller, view, screenPos, pending);
    return carryGesture(controller, view, screenPos, pending);
  },
};

export { CAPTURED_CUE_MS };
