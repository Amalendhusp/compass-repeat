// Phase 3.1 item 2: builds the node-inset state a point-taking tool publishes on every onMove —
// the active (chosen) candidate plus any other real points nearby, so the renderer can show
// enough local context to tell which junction is about to be committed, not just that *something*
// snapped. Pure data assembly; interaction/hittest.ts still owns the actual targeting decision.

import type { Doc, Point, Vec2 } from '../model/types.ts';
import type { NodeInsetState, ViewTransform } from '../app/controller.ts';
import { worldToScreen } from '../app/controller.ts';
import { resolvePoint } from '../geometry/kernel.ts';
import { isPointOrphanedByTrim } from '../geometry/usage.ts';
import { dist } from '../geometry/vec.ts';
import { POINT_HIT_RADIUS } from './hittest.ts';
import { clusterByLocation, COINCIDENT_PX, type SnapTracker } from './snap.ts';

/** Slightly wider than the hit radius — this is "what else is worth showing you," not "what
 * would also have been picked," so near-misses that could plausibly confuse the eye count too. */
const NEARBY_RADIUS = POINT_HIT_RADIUS * 1.4;

export function buildNodeInset(doc: Doc, view: ViewTransform, anchorScreen: Vec2, activeAt: Vec2, tracker?: SnapTracker): NodeInsetState {
  const activeScreen = worldToScreen(view, activeAt);
  const raw: { p: Point; at: Vec2; screen: Vec2; d: number }[] = [];
  for (const p of doc.points) {
    if (p.kind === 'free' && p.hidden) continue;
    if (isPointOrphanedByTrim(doc, p.id)) continue;
    const at = resolvePoint(doc, p.id);
    const screen = worldToScreen(view, at);
    const d = dist(screen, activeScreen);
    if (d > NEARBY_RADIUS) continue;
    raw.push({ p, at, screen, d });
  }
  // Phase 5.8: one visible location = one entry — coincident points are merged (and say so in
  // their label), so the loupe never shows a stack of indistinguishable rings.
  const locations = clusterByLocation(raw);
  const candidates: Vec2[] = [];
  const labels: NonNullable<NodeInsetState['labels']> = [];
  for (const loc of locations) {
    const isActive = dist(loc.screen, activeScreen) <= COINCIDENT_PX;
    if (tracker) labels.push({ at: loc.at, label: loc.label, active: isActive });
    if (!isActive) candidates.push(loc.at);
  }
  labels.sort((a, b) => Number(b.active) - Number(a.active));
  return { anchorScreen, activeAt, candidates, labels: tracker ? labels : undefined, ambiguous: tracker ? !!tracker.ambiguous() : undefined };
}
