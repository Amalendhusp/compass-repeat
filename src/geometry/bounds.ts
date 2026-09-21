// Phase 3.2 item 3: the world-space bounding box Fit fits into the usable canvas rectangle —
// pure geometry, no view/DOM concerns (those live in main.ts's fitView).

import type { Doc, Point } from '../model/types.ts';
import { epsilon, projectOntoEntity, resolveEntityGeom, resolvePoint } from './kernel.ts';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function expand(b: Bounds | null, x: number, y: number): Bounds {
  if (!b) return { minX: x, maxX: x, minY: y, maxY: y };
  return { minX: Math.min(b.minX, x), maxX: Math.max(b.maxX, x), minY: Math.min(b.minY, y), maxY: Math.max(b.maxY, y) };
}

const PARAM_EPS = 1e-6;

/**
 * Phase 3.6 item 1: true for every point EXCEPT one that only exists out along an Extension
 * line's infinite reach — a circle has no infinite extent at all (always finite), and any point
 * kind other than 'intersection'/'on-curve' isn't parametrized against a specific curve's own
 * extent to begin with (midpoint/division/free/centre/frame-vertex are all finite by construction).
 * An intersection or explicitly-placed on-curve point is finite only if its param, re-derived by
 * projecting its resolved position back onto the host, falls within the host's own literal A→B
 * span — regardless of whether that line happens to be `extended`.
 */
function isPointWithinFiniteSpan(doc: Doc, point: Point): boolean {
  if (point.kind !== 'intersection' && point.kind !== 'on-curve') return true;
  const hostIds = point.kind === 'intersection' ? point.entities : [point.host];
  const worldPos = resolvePoint(doc, point.id);
  const eps = epsilon(doc);
  for (const id of hostIds) {
    const e = doc.entities.find((x) => x.id === id);
    if (!e) continue;
    if (e.kind === 'circle') return true; // circles are always fully finite
    const proj = projectOntoEntity(doc, e, worldPos);
    if (proj.d <= eps && proj.param >= -PARAM_EPS && proj.param <= 1 + PARAM_EPS) return true;
  }
  return false;
}

/**
 * World-space bounds of "active visible geometry" (spec): every non-hidden point that lies
 * within some entity's own finite span (Phase 3.6 item 1: a point materialized only out along an
 * Extension line's infinite reach is excluded, so it can't pull the design off-centre or shrink
 * it), plus each circle's full centre±radius extent — the one shape whose meaningful bounds
 * aren't already implied by its points, and each line's own literal endpoints regardless of
 * `extended` (belt-and-braces alongside the point filter above, in case an extended line has no
 * materialized point anywhere near one of its own ends). Null for a doc with nothing beyond a
 * still-hidden frame internals (fitView falls back to the frame radius in that case).
 */
export function computeVisibleBounds(doc: Doc): Bounds | null {
  let b: Bounds | null = null;
  for (const p of doc.points) {
    if (p.kind === 'free' && p.hidden) continue;
    if (!isPointWithinFiniteSpan(doc, p)) continue;
    const at = resolvePoint(doc, p.id);
    b = expand(b, at.x, at.y);
  }
  for (const e of doc.entities) {
    const g = resolveEntityGeom(doc, e);
    if (g.kind === 'circle') {
      b = expand(b, g.centre.x - g.radius, g.centre.y - g.radius);
      b = expand(b, g.centre.x + g.radius, g.centre.y + g.radius);
    } else {
      b = expand(b, g.a.x, g.a.y);
      b = expand(b, g.b.x, g.b.y);
    }
  }
  return b;
}
