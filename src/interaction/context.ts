// Contextual targets: places and lines that exist only because of where something else has been
// laid over the construction — in Intersect, the other instances (geometry/intersectionLink.ts).
// The point-taking tools ask here through the ordinary targeting (hittest.ts, snap.ts); with no
// provider set — always, in Construct — there are none and targeting is exactly as it has been.
//
// A contextual point is never stored. Taken, it becomes an ordinary free point of the construction
// at that position (pointref.ts), with no tie to what produced it.

import type { Vec2 } from '../model/types.ts';
import type { ViewTransform } from '../app/controller.ts';

/** How close (screen px) the finger must be to a contextual point — a little tighter than a
 * point of the construction itself (22), which also wins a near-tie (snap.ts). */
export const CONTEXT_HIT_RADIUS = 16;

export interface ContextHit {
  /** In the construction's own coordinates (as `view` shows them). */
  at: Vec2;
  /** Screen distance from the finger. */
  screenD: number;
  label: string;
}

export interface ContextProvider {
  point(view: ViewTransform, screenPos: Vec2, radiusPx: number): ContextHit | null;
  /** A straight line under the finger that is not the construction's own: its two ends. */
  line(view: ViewTransform, screenPos: Vec2, radiusPx: number): { a: Vec2; b: Vec2 } | null;
  /** Whether anything drawn that is not the construction's own lies within reach of the finger. */
  near(view: ViewTransform, screenPos: Vec2, radiusPx: number): boolean;
}

let provider: ContextProvider | null = null;

export function setContextProvider(p: ContextProvider | null): void {
  provider = p;
}

export function contextPointAt(view: ViewTransform, screenPos: Vec2): ContextHit | null {
  return provider ? provider.point(view, screenPos, CONTEXT_HIT_RADIUS) : null;
}

export function contextLineAt(view: ViewTransform, screenPos: Vec2, radiusPx: number): { a: Vec2; b: Vec2 } | null {
  return provider ? provider.line(view, screenPos, radiusPx) : null;
}

export function contextNear(view: ViewTransform, screenPos: Vec2, radiusPx: number): boolean {
  return provider ? provider.near(view, screenPos, radiusPx) : false;
}
