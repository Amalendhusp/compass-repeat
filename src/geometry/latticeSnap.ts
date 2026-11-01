// The shape of a Repeat lattice, read off its two arms — used to draw the grid guide.

import type { Vec2 } from '../model/types.ts';

/** How a lattice is shaped, read off its arms: a regular 60° lattice, or anything else (drawn as
 * the parallelograms its arms make, which is exact for every lattice). `b60` is the second arm at
 * 60° to the first (for a 120° pair, a + b). */
export function latticeShape(a: Vec2, b: Vec2): { kind: 'sixty'; b60: Vec2 } | { kind: 'cells' } {
  const la = Math.hypot(a.x, a.y);
  const lb = Math.hypot(b.x, b.y);
  if (!(la > 1e-9) || Math.abs(la - lb) > la * 1e-6) return { kind: 'cells' };
  const cos = (a.x * b.x + a.y * b.y) / (la * lb);
  if (Math.abs(cos - 0.5) < 1e-6) return { kind: 'sixty', b60: b };
  if (Math.abs(cos + 0.5) < 1e-6) return { kind: 'sixty', b60: { x: a.x + b.x, y: a.y + b.y } };
  return { kind: 'cells' };
}
