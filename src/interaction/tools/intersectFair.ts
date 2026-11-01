// Fair in Intersect (Stage D): develops the Primary — Intersect's own geometry, independent of the
// Construct source. Unlike Line, Circle, Arc and Divide (which edit the Construct motif through the
// active instance, so every copy follows), Fair here never touches the Construct source: it shows
// every copy's Fair geometry, translucent, and the Developed Primary, opaque, over it.
//
// - Tap a segment (between two places where Fair meets Fair): it joins the Developed Primary; tap a
//   developed segment: it leaves. One Undo step each. Pressing already shows what the tap will do.
// - Where candidates crowd (a crossing, coincident strokes): a tap opens the "Which line?" chooser;
//   pressing and holding opens the precision loupe instead — slide to the one wanted, release.
// - Moving the finger away before release does nothing. Nothing is joined up or closed automatically.

import type { Vec2 } from '../../model/types.ts';
import type { AppController, ViewTransform } from '../../app/controller.ts';
import { screenToWorld, worldToScreen } from '../../app/controller.ts';
import { endsOf } from '../../geometry/fairGeometry.ts';
import { dist } from '../../geometry/vec.ts';
import { commitPick, describePick, formPicksAt, type FormPick, type FormPress } from '../formPick.ts';
import { loupeCentre, LOUPE_R, MARKER_GAP, spreadMarkers, SWITCH_PX } from '../precision.ts';
import type { Gesture, ToolModule } from './types.ts';

/** How far (screen px) from a segment a finger still reaches it. */
const REACH_PX = 16;
/** Candidates whose distances differ by less than this (screen px) can't be told apart by a tap. */
const CROWD_PX = 7;
/** How far (screen px) a candidate's marker sits from the finger, along it toward its middle. */
const MARKER_STEP_PX = 22;
const HOLD_MS = 380;
const MOVE_PX = 10;
const MAX_CANDIDATES = 4;

export const intersectFairTool: ToolModule = {
  id: 'fair',
  hint: () => 'Tap a Fair segment to add it to the Primary — tap again to remove it',
  beginGesture(controller, view, sp) {
    const doc = controller.doc;
    const picks = formPicksAt(doc, screenToWorld(view, sp), REACH_PX / view.zoom, MARKER_STEP_PX / view.zoom, controller.formLayer);
    if (picks.length === 0) return null;
    const crowded = picks.length > 1 && (picks[1]!.d - picks[0]!.d) * view.zoom < CROWD_PX;
    const press: FormPress = { picks: crowded ? picks.slice(0, MAX_CANDIDATES) : [picks[0]!], active: 0, anchorScreen: sp, loupe: null };
    controller.formPress = press;
    controller.notifyView();
    let timer: ReturnType<typeof setTimeout> | null = crowded
      ? setTimeout(() => {
          timer = null;
          if (controller.formPress === press) openLoupe(controller, view, press);
        }, HOLD_MS)
      : null;
    let abandoned = false;
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const gesture: Gesture = {
      onMove(p) {
        if (press.loupe) {
          moveLoupe(controller, press, p);
          return;
        }
        if (!abandoned && dist(p, sp) > MOVE_PX) {
          // Moving away: not a tap. Nothing happens.
          abandoned = true;
          stop();
          controller.formPress = null;
          controller.notifyView();
        }
      },
      onUp() {
        stop();
        if (controller.formPress !== press) return;
        controller.formPress = null;
        if (abandoned) {
          controller.notifyView();
          return;
        }
        if (press.loupe) commitPick(controller, press.picks[press.active]!);
        else if (press.picks.length > 1) openChooser(controller, sp, press.picks);
        else commitPick(controller, press.picks[0]!);
      },
      onCancel() {
        stop();
        if (controller.formPress === press) controller.formPress = null;
        controller.notifyView();
      },
    };
    return gesture;
  },
};

/** "Which line?" — the crowded candidates, numbered; choosing one adds or removes it. */
function openChooser(controller: AppController, anchorScreen: Vec2, picks: FormPick[]): void {
  const doc = controller.doc;
  controller.lineChoice = {
    anchorScreen,
    candidates: picks.map((p) => ({
      label: p.action === 'add' ? 'Add to Primary' : 'Remove from Primary',
      detail: describePick(doc, p),
      keys: [],
      draft: new Map(),
      fairing: p.action === 'add',
      whole: null,
      ends: endsOf(p.prim),
      badgeAt: p.marker,
      shape: p.prim,
    })),
    focus: null,
    resolve: (i) => {
      controller.lineChoice = null;
      if (i !== null && picks[i]) commitPick(controller, picks[i]!);
      else controller.notify();
    },
  };
  controller.notify();
}

/** The precision loupe over the crowded spot: each candidate's marker at its true (magnified) place,
 * spread apart where still too close; the finger's cursor moves 1:1 inside it. */
function openLoupe(controller: AppController, view: ViewTransform, press: FormPress): void {
  const screens = press.picks.map((p) => worldToScreen(view, p.marker));
  const centreScreen = { x: screens.reduce((s, p) => s + p.x, 0) / screens.length, y: screens.reduce((s, p) => s + p.y, 0) / screens.length };
  const spreadPx = Math.max(1, ...screens.map((s) => dist(s, centreScreen)));
  const mag = Math.min(14, Math.max(2.5, (LOUPE_R * 0.5) / spreadPx));
  const c = loupeCentre(press.anchorScreen, view);
  const local = screens.map((s) => ({ x: c.x + (s.x - centreScreen.x) * mag, y: c.y + (s.y - centreScreen.y) * mag }));
  const markers = spreadMarkers(local, c, MARKER_GAP, { c, r: LOUPE_R });
  press.active = 0;
  press.loupe = { x: c.x, y: c.y, r: LOUPE_R, mag, centreScreen, markers, cursor: { ...markers[0]! }, holdStart: press.anchorScreen, cursorStart: { ...markers[0]! } };
  if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8);
  controller.notifyView();
}

function moveLoupe(controller: AppController, press: FormPress, finger: Vec2): void {
  const l = press.loupe!;
  let cx = l.cursorStart.x + (finger.x - l.holdStart.x);
  let cy = l.cursorStart.y + (finger.y - l.holdStart.y);
  const d = Math.hypot(cx - l.x, cy - l.y);
  const max = l.r - 6;
  if (d > max) {
    cx = l.x + ((cx - l.x) / d) * max;
    cy = l.y + ((cy - l.y) / d) * max;
  }
  l.cursor = { x: cx, y: cy };
  let best = press.active;
  let bestD = dist(l.markers[press.active]!, l.cursor) - SWITCH_PX;
  l.markers.forEach((m, i) => {
    const dd = dist(m, l.cursor);
    if (dd < bestD) {
      bestD = dd;
      best = i;
    }
  });
  press.active = best;
  controller.notifyView();
}
