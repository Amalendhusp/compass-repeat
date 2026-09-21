// Phase 3.1 item 2: builds the node-inset state a point-taking tool publishes on every onMove —
// the active (chosen) candidate plus any other real points nearby, so the renderer can show
// enough local context to tell which junction is about to be committed, not just that *something*
// snapped. Pure data assembly; interaction/hittest.ts still owns the actual targeting decision.

import type { Doc, Vec2 } from '../model/types.ts';
import type { NodeInsetState, ViewTransform } from '../app/controller.ts';
import { worldToScreen } from '../app/controller.ts';
import { resolvePoint } from '../geometry/kernel.ts';
import { isPointOrphanedByTrim } from '../geometry/usage.ts';
import { dist } from '../geometry/vec.ts';
import { POINT_HIT_RADIUS } from './hittest.ts';

/** Slightly wider than the hit radius — this is "what else is worth showing you," not "what
 * would also have been picked," so near-misses that could plausibly confuse the eye count too. */
const NEARBY_RADIUS = POINT_HIT_RADIUS * 1.4;

export function buildNodeInset(doc: Doc, view: ViewTransform, anchorScreen: Vec2, activeAt: Vec2): NodeInsetState {
  const activeScreen = worldToScreen(view, activeAt);
  const candidates: Vec2[] = [];
  for (const p of doc.points) {
    if (p.kind === 'free' && p.hidden) continue;
    if (isPointOrphanedByTrim(doc, p.id)) continue;
    const at = resolvePoint(doc, p.id);
    if (dist(at, activeAt) < 1e-9) continue; // the active candidate itself
    const screen = worldToScreen(view, at);
    if (dist(screen, activeScreen) > NEARBY_RADIUS) continue;
    candidates.push(at);
  }
  return { anchorScreen, activeAt, candidates };
}
