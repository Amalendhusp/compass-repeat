// Precise lattice relations for Repeat's handles — what the Square / Triangle / Hexagon presets used
// to give, now found by hand. While one lattice arm is dragged, it is drawn gently into an exact
// relation with the other arm:
// - its angle to the other arm: exactly 90°, 60° or 120° (at whatever length — copies may be apart);
// - its length: exactly the other arm's ("Equal arms");
// - both at once: a regular lattice — square (90°) or 60° (triangle / hexagon).
// It takes hold only near the relation (in screen px, so the same at every zoom) and lets go once the
// finger moves on well past it, so nothing is forced: any lattice can still be made. Contact with
// the neighbouring motif (repeatTool's detents and contour) keeps priority over these.

import type { Vec2 } from '../model/types.ts';

export type RelationKind = 'regular' | 'angle' | 'equal';

export interface Relation {
  /** Identity, for holding on to it between samples. */
  key: string;
  kind: RelationKind;
  /** The arm exactly in this relation (artwork units). */
  at: Vec2;
  label: string;
}

/** A relation takes hold within this (px) — a regular lattice a little sooner. */
const ENTER_PX = 10;
const ENTER_REGULAR_PX = 12;
/** …and lets go once the finger is this far (px) from it. */
const RELEASE_PX = 26;

const ANGLES = [90, 60, 120] as const;

const turn = (v: Vec2, deg: number): Vec2 => {
  const a = (deg * Math.PI) / 180;
  return { x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) };
};

/** Every exact relation the dragged arm (`raw`) could take with the `other` arm. */
export function relations(other: Vec2, raw: Vec2): Relation[] {
  const len = Math.hypot(other.x, other.y);
  if (!(len > 1e-9)) return [];
  const unit = { x: other.x / len, y: other.y / len };
  const out: Relation[] = [];
  for (const deg of ANGLES) {
    for (const side of [1, -1]) {
      const u = turn(unit, side * deg);
      const along = raw.x * u.x + raw.y * u.y;
      if (along > 0) out.push({ key: `angle:${deg}:${side}`, kind: 'angle', at: { x: u.x * along, y: u.y * along }, label: `${deg}°` });
      out.push({ key: `regular:${deg}:${side}`, kind: 'regular', at: { x: u.x * len, y: u.y * len }, label: deg === 90 ? 'Square lattice' : '60° lattice' });
    }
  }
  const r = Math.hypot(raw.x, raw.y);
  if (r > 1e-9) out.push({ key: 'equal', kind: 'equal', at: { x: (raw.x / r) * len, y: (raw.y / r) * len }, label: 'Equal arms' });
  return out;
}

/**
 * One drag sample: the relation holding the arm (kept until the finger is RELEASE_PX from it; a
 * regular lattice nearby takes over from an angle or a length alone), or the one it comes near, or
 * none. `zoom` converts artwork units to screen px.
 */
export function stepRelation(other: Vec2, raw: Vec2, prev: Relation | null, zoom: number): Relation | null {
  const all = relations(other, raw);
  const px = (r: Relation) => Math.hypot(r.at.x - raw.x, r.at.y - raw.y) * zoom;
  const regular = all.filter((r) => r.kind === 'regular' && px(r) <= ENTER_REGULAR_PX).sort((p, q) => px(p) - px(q))[0];
  if (prev) {
    const held = all.find((r) => r.key === prev.key);
    if (held && px(held) <= RELEASE_PX) return held.kind !== 'regular' && regular ? regular : held;
  }
  if (regular) return regular;
  return all.filter((r) => r.kind !== 'regular' && px(r) <= ENTER_PX).sort((p, q) => px(p) - px(q))[0] ?? null;
}

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
