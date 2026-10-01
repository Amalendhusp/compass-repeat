// Precision loupe — press, hold, slide, release. Phase 2H introduced it for Select; Phase 5.9 makes
// it THE way to choose between crowded points in every point-taking tool (Circle, Line, Arc and
// Select), replacing any list-style "which point?" question.
//
// When the finger rests on a spot where several distinct points sit close together, holding it
// opens a magnified loupe away from the fingertip. Inside it the candidates are shown where they
// really are, magnified, and — where even that would leave them too close for a finger — spread
// apart with a short leader line back to the true position. The finger then slides (1:1, in the
// loupe's own space) toward the point it wants; the nearest spread marker lights up, and the real
// point is ringed on the drawing. Releasing takes it. Nothing to read, nothing to tap twice.

import type { Doc, Vec2 } from '../model/types.ts';
import type { AppController, PrecisionCandidate, ViewTransform } from '../app/controller.ts';
import { worldToScreen } from '../app/controller.ts';
import { resolvePoint } from '../geometry/kernel.ts';
import { isPointOrphanedByTrim } from '../geometry/usage.ts';
import { dist } from '../geometry/vec.ts';
import { POINT_HIT_RADIUS } from './hittest.ts';
import { clusterByLocation } from './snap.ts';

/** Candidates within this screen distance of EACH OTHER can't be told apart by a fingertip. */
const CLUSTER_SCREEN_GAP = 26;
const LOUPE_R = 62;
const LOUPE_OFFSET = 96; // loupe centre above (or below) the finger
const LOUPE_MARGIN = 8;
export const MARKER_R = 10;
const MARKER_GAP = 28; // spread markers at least this far apart — a comfortable finger step
const SWITCH_PX = 5; // hysteresis: another marker must be this much nearer before the choice moves
const MAX_CANDIDATES = 7;

/** Select's cluster test — explicit points only, merged by location. Null when the press is clear. */
export function ambiguousCandidates(doc: Doc, view: ViewTransform, screenPos: Vec2): PrecisionCandidate[] | null {
  const raw = doc.points
    .filter((p) => !(p.kind === 'free' && p.hidden) && !isPointOrphanedByTrim(doc, p.id))
    .map((p) => {
      const at = resolvePoint(doc, p.id);
      const screen = worldToScreen(view, at);
      return { p, at, screen, d: dist(screen, screenPos) };
    })
    .filter((p) => p.d <= POINT_HIT_RADIUS);
  const locs = clusterByLocation(raw);
  if (locs.length < 2) return null;
  let minPair = Infinity;
  for (let i = 0; i < locs.length; i++) for (let j = i + 1; j < locs.length; j++) minPair = Math.min(minPair, dist(locs[i]!.screen, locs[j]!.screen));
  if (minPair > CLUSTER_SCREEN_GAP) return null;
  return locs.slice(0, MAX_CANDIDATES).map((l) => ({ ref: { kind: 'existing', id: l.id }, at: l.at, label: l.label }));
}

/** Pushes marker positions apart until none overlap, keeping them inside the loupe. */
export function spreadMarkers(points: Vec2[], centre: Vec2, minGap: number, bound: { c: Vec2; r: number } | null): Vec2[] {
  const n = points.length;
  const pos = points.map((p, i) => {
    if (dist(p, centre) > 0.5) return { ...p };
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1);
    return { x: p.x + Math.cos(a), y: p.y + Math.sin(a) };
  });
  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos[i]!;
        const b = pos[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= minGap) continue;
        if (d < 0.01) {
          dx = Math.cos(i + j);
          dy = Math.sin(i + j);
          d = 1;
        }
        const push = (minGap - d) / 2;
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
        moved = true;
      }
    }
    if (bound) {
      for (const p of pos) {
        const dx = p.x - bound.c.x;
        const dy = p.y - bound.c.y;
        const d = Math.hypot(dx, dy);
        const max = bound.r - MARKER_R - 4;
        if (d > max) {
          p.x = bound.c.x + (dx / d) * max;
          p.y = bound.c.y + (dy / d) * max;
        }
      }
    }
    if (!moved) break;
  }
  return pos;
}

function loupeCentre(anchor: Vec2, view: ViewTransform): Vec2 {
  let y = anchor.y - LOUPE_OFFSET;
  if (y - LOUPE_R < LOUPE_MARGIN) y = anchor.y + LOUPE_OFFSET;
  const x = Math.min(Math.max(anchor.x, LOUPE_R + LOUPE_MARGIN), view.w - LOUPE_R - LOUPE_MARGIN);
  return { x, y };
}

/**
 * Opens the loupe for `candidates` (already distinct locations). The magnification spreads the
 * cluster over about half the loupe; markers still closer than a finger step are fanned apart.
 * The marker nearest the finger's press starts out active.
 */
export function openPrecision(controller: AppController, view: ViewTransform, candidates: PrecisionCandidate[], anchorScreen: Vec2): void {
  const list = candidates.slice(0, MAX_CANDIDATES);
  const screens = list.map((c) => worldToScreen(view, c.at));
  const centreScreen = { x: screens.reduce((s, p) => s + p.x, 0) / screens.length, y: screens.reduce((s, p) => s + p.y, 0) / screens.length };
  const spreadPx = Math.max(1, ...screens.map((s) => dist(s, centreScreen)));
  const mag = Math.min(14, Math.max(2.5, (LOUPE_R * 0.5) / spreadPx));
  const c = loupeCentre(anchorScreen, view);
  const local = screens.map((s) => ({ x: c.x + (s.x - centreScreen.x) * mag, y: c.y + (s.y - centreScreen.y) * mag }));
  const markers = spreadMarkers(local, c, MARKER_GAP, { c, r: LOUPE_R });
  let start = 0;
  let best = Infinity;
  screens.forEach((s, i) => {
    const d = dist(s, anchorScreen);
    if (d < best) {
      best = d;
      start = i;
    }
  });
  const cx = list.reduce((s, p) => s + p.at.x, 0) / list.length;
  const cy = list.reduce((s, p) => s + p.at.y, 0) / list.length;
  controller.precision = {
    candidates: list,
    activeIndex: start,
    anchorWorld: { x: cx, y: cy },
    anchorScreen,
    reticleWorld: { x: cx, y: cy },
    lastFingerScreen: anchorScreen,
    loupe: { x: c.x, y: c.y, r: LOUPE_R, mag, centreScreen },
    markers,
    cursor: { ...markers[start]! },
    holdStart: anchorScreen,
    cursorStart: { ...markers[start]! },
  };
  controller.nodeInset = null;
  if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8);
  controller.notify();
}

/** One finger sample: the cursor moves 1:1 inside the loupe; the nearest marker becomes active. */
export function movePrecision(controller: AppController, _view: ViewTransform, fingerScreen: Vec2): void {
  const s = controller.precision;
  if (!s) return;
  s.lastFingerScreen = fingerScreen;
  const { loupe } = s;
  let cx = s.cursorStart.x + (fingerScreen.x - s.holdStart.x);
  let cy = s.cursorStart.y + (fingerScreen.y - s.holdStart.y);
  const d = Math.hypot(cx - loupe.x, cy - loupe.y);
  const max = loupe.r - 6;
  if (d > max) {
    cx = loupe.x + ((cx - loupe.x) / d) * max;
    cy = loupe.y + ((cy - loupe.y) / d) * max;
  }
  s.cursor = { x: cx, y: cy };
  let bestI = s.activeIndex;
  let bestD = dist(s.markers[s.activeIndex]!, s.cursor) - SWITCH_PX;
  s.markers.forEach((m, i) => {
    const dd = dist(m, s.cursor);
    if (dd < bestD) {
      bestD = dd;
      bestI = i;
    }
  });
  s.activeIndex = bestI;
  controller.notifyView();
}

/** Release: the active candidate, or nothing when `commitChoice` is false (a second finger). */
export function closePrecision(controller: AppController, commitChoice: boolean): PrecisionCandidate | null {
  const s = controller.precision;
  controller.precision = null;
  controller.notify();
  if (!s || !commitChoice) return null;
  return s.candidates[s.activeIndex] ?? null;
}
