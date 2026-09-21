// Phase 2H: the precision loupe (§5.4 / §2's press-then-slide). A gesture that finds candidates
// too close together for reliable finger selection hands off here instead of guessing: hold to
// open the loupe, slide to drift a slowed reticle over the magnified cluster, release to commit.

import type { Doc, Vec2 } from '../model/types.ts';
import type { AppController, PrecisionCandidate, ViewTransform } from '../app/controller.ts';
import { screenToWorld, worldToScreen } from '../app/controller.ts';
import { resolvePoint } from '../geometry/kernel.ts';
import { isPointOrphanedByTrim } from '../geometry/usage.ts';
import { dist } from '../geometry/vec.ts';
import { POINT_HIT_RADIUS } from './hittest.ts';

/** Candidates within this screen distance of EACH OTHER can't be told apart by a fingertip —
 * that's what makes a location "ambiguous" rather than merely "has more than one point nearby"
 * (Select's ordinary tap-to-cycle already handles the latter fine). */
const CLUSTER_SCREEN_GAP = 26;

/**
 * Explicit points only (§5.4: "explicit points always outrank implicit projections" — Select
 * never offers implicit ones at all, so there's nothing to gate on Point Lock here). Returns
 * null when the tap is unambiguous — a single clear target, or nothing nearby.
 */
export function ambiguousCandidates(doc: Doc, view: ViewTransform, screenPos: Vec2): PrecisionCandidate[] | null {
  const nearby = doc.points
    .filter((p) => !(p.kind === 'free' && p.hidden) && !isPointOrphanedByTrim(doc, p.id))
    .map((p) => {
      const at = resolvePoint(doc, p.id);
      return { id: p.id, at, screen: worldToScreen(view, at) };
    })
    .map((p) => ({ ...p, d: dist(p.screen, screenPos) }))
    .filter((p) => p.d <= POINT_HIT_RADIUS)
    .sort((a, b) => a.d - b.d);

  if (nearby.length < 2) return null;
  let minPair = Infinity;
  for (let i = 0; i < nearby.length; i++) {
    for (let j = i + 1; j < nearby.length; j++) minPair = Math.min(minPair, dist(nearby[i]!.screen, nearby[j]!.screen));
  }
  if (minPair > CLUSTER_SCREEN_GAP) return null;

  return nearby.slice(0, 6).map((p) => ({ ref: { kind: 'existing', id: p.id }, at: p.at }));
}

/** Opens a session anchored at the candidate cluster's centroid — the loupe's magnification
 * centre — with the reticle starting there too. */
export function openPrecision(controller: AppController, candidates: PrecisionCandidate[], anchorScreen: Vec2): void {
  const cx = candidates.reduce((s, c) => s + c.at.x, 0) / candidates.length;
  const cy = candidates.reduce((s, c) => s + c.at.y, 0) / candidates.length;
  controller.precision = {
    candidates,
    activeIndex: 0,
    anchorWorld: { x: cx, y: cy },
    anchorScreen,
    reticleWorld: { x: cx, y: cy },
    lastFingerScreen: anchorScreen,
  };
  controller.notify();
}

/** Feeds one finger-move sample in: the reticle drifts at 1/4 the finger's screen-space delta
 * (§5.4's "slowed reticle"), tracked in world space so it stays put across any concurrent
 * zoom/pan, then locks onto whichever candidate it now sits nearest. */
export function movePrecision(controller: AppController, view: ViewTransform, fingerScreen: Vec2): void {
  const s = controller.precision;
  if (!s) return;
  const dx = fingerScreen.x - s.lastFingerScreen.x;
  const dy = fingerScreen.y - s.lastFingerScreen.y;
  s.lastFingerScreen = fingerScreen;
  const reticleScreen = worldToScreen(view, s.reticleWorld);
  const nextScreen = { x: reticleScreen.x + dx / 4, y: reticleScreen.y + dy / 4 };
  s.reticleWorld = screenToWorld(view, nextScreen);

  let bestI = 0;
  let bestD = Infinity;
  s.candidates.forEach((c, i) => {
    const d = dist(worldToScreen(view, c.at), nextScreen);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  });
  s.activeIndex = bestI;
  controller.notifyView();
}

/** Release: commits to whichever candidate the reticle is nearest, or aborts with no result
 * when `commitChoice` is false (§5.4: "allow cancel" — a second finger arriving mid-hold). */
export function closePrecision(controller: AppController, commitChoice: boolean): PrecisionCandidate | null {
  const s = controller.precision;
  controller.precision = null;
  controller.notify();
  if (!s || !commitChoice) return null;
  return s.candidates[s.activeIndex] ?? null;
}
