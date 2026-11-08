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

import type { Doc, Vec2 } from '../../model/types.ts';
import { closestOn, motifRuns, placePrim, type Prim } from '../../geometry/fairGeometry.ts';
import { inComposition, shownCopies, withPrimaryCopy } from '../../geometry/intersection.ts';
import { showToast } from '../../ui/toast.ts';
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

/** The shown copies whose Fair motif passes within `reach` of `w`, nearest first, each with the piece
 * of it nearest the finger (what the chooser marks). */
function motifsAt(doc: Doc, w: Vec2, reach: number): { key: string; label: string; colour: string; d: number; prim: Prim; at: Vec2 }[] {
  const pivot = doc.frame.origin;
  const runs = motifRuns(doc);
  const out: { key: string; label: string; colour: string; d: number; prim: Prim; at: Vec2 }[] = [];
  for (const copy of shownCopies(doc)) {
    let best: { d: number; prim: Prim; at: Vec2 } | null = null;
    for (const r of runs) {
      const prim = placePrim(r.prim, pivot, copy.pose);
      const c = closestOn(w, prim);
      if (c.d <= reach && (!best || c.d < best.d)) best = { d: c.d, prim, at: c.q };
    }
    if (best) out.push({ key: copy.key, label: copy.label, colour: copy.colour, ...best });
  }
  return out.sort((a, b) => a.d - b.d);
}

/** Includes or excludes copy `key`'s whole Fair motif in the design — one Undo step. */
function toggleWhole(controller: AppController, key: string, label: string): void {
  const on = !inComposition(controller.doc, key);
  controller.commit((d) => {
    d.intersection = withPrimaryCopy(d, key, on);
  });
  showToast(on ? `${label}’s whole motif is in the design` : `${label}’s whole motif is out of the design`, 1800);
}

/** Whole motif: a tap on a copy's Fair motif includes or excludes all of it. Where motifs crowd, a
 * chooser names each (and marks it); moving away before release does nothing. */
function beginWholeGesture(controller: AppController, view: ViewTransform, sp: Vec2): Gesture | null {
  const cands = motifsAt(controller.doc, screenToWorld(view, sp), REACH_PX / view.zoom);
  if (cands.length === 0) return null;
  let moved = false;
  return {
    onMove(p) {
      if (dist(p, sp) > MOVE_PX) moved = true;
    },
    onUp() {
      if (moved) return;
      const crowded = cands.length > 1 && (cands[1]!.d - cands[0]!.d) * view.zoom < CROWD_PX;
      if (!crowded) return toggleWhole(controller, cands[0]!.key, cands[0]!.label);
      const shown = cands.slice(0, MAX_CANDIDATES);
      controller.lineChoice = {
        title: 'Which copy?',
        anchorScreen: sp,
        candidates: shown.map((m, i) => ({
          label: `${inComposition(controller.doc, m.key) ? 'Take out' : 'Include'} ${m.label}’s whole motif`,
          detail: inComposition(controller.doc, m.key) ? 'In the design now' : 'Not in the design now',
          keys: [],
          draft: new Map(),
          fairing: !inComposition(controller.doc, m.key),
          whole: null,
          ends: endsOf(m.prim),
          badgeAt: { x: m.at.x + ((i - (shown.length - 1) / 2) * MARKER_STEP_PX) / view.zoom, y: m.at.y },
          shape: m.prim,
        })),
        focus: null,
        resolve: (i) => {
          controller.lineChoice = null;
          if (i !== null && shown[i]) toggleWhole(controller, shown[i]!.key, shown[i]!.label);
          else controller.notify();
        },
      };
      controller.notify();
    },
    onCancel() {},
  };
}

export const intersectFairTool: ToolModule = {
  id: 'fair',
  hint: (c) => (c.formWhole ? 'Tap a copy to include or exclude its whole Fair motif' : 'Tap a Fair segment to add it to the Primary — tap again to remove it'),
  beginGesture(controller, view, sp) {
    if (controller.formWhole) return beginWholeGesture(controller, view, sp);
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
