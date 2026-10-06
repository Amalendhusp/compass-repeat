// Intersection (V0): a small local group of construction copies, placed by Repeat's own lattice —
// the same doc.repeat (a, b, motif rotation, Same / Alternate / Mirror) and the same instancePose —
// so the placement chosen here is the placement Repeat shows, and vice versa. Only which copies are
// shown differs: never a field, just the primary and its immediate lattice neighbours.

import type { Doc, RepeatSystem, Vec2 } from '../model/types.ts';
import { instancePose, isSixtyDegreeFamily, motifRadius, type InstancePose } from './lattice.ts';

/** Analysis colours, by lattice offset — so a copy keeps its colour when the family changes
 * (the (1,0) copy is the same red in Square and Hexagon). Each set shown is all different. */
const DEFAULT_COLOURS: Record<string, string> = {
  '0,0': '#1E2A36', // the primary: ink
  '1,0': '#C6402C', // red
  '0,1': '#2F6FB0', // blue
  '1,1': '#3F8B5E', // green (Square's diagonal; a Hexagon's when its third pair is ±(a+b))
  '-1,0': '#C98A2C', // ochre
  '0,-1': '#8B3A62', // plum
  '1,-1': '#2AA3A3', // teal
  '-1,1': '#3F8B5E', // green
  '-1,-1': '#2AA3A3', // teal
};

export interface IntersectionCopy {
  key: string;
  i: number;
  j: number;
  label: string;
  colour: string;
  visible: boolean;
  pose: InstancePose;
}

/**
 * The lattice offsets shown, from the lattice itself:
 * - Square: the primary and the three other corners of its lattice cell — (1,0), (0,1), (1,1),
 *   i.e. a, b and a + b: 4 constructions.
 * - Triangle / Hexagon: the primary and its six nearest lattice neighbours — ±a, ±b and whichever
 *   of ±(a − b) or ±(a + b) is shorter (a − b for the 60° basis Repeat starts from; a + b if the
 *   arms have been opened past 90°): 7 constructions.
 * The ring is ordered by direction, starting from a.
 */
export function intersectionOffsets(repeat: RepeatSystem): { i: number; j: number }[] {
  if (!isSixtyDegreeFamily(repeat.family)) return [{ i: 0, j: 0 }, { i: 1, j: 0 }, { i: 0, j: 1 }, { i: 1, j: 1 }];
  const { a, b } = repeat;
  const diff = Math.hypot(a.x - b.x, a.y - b.y);
  const sum = Math.hypot(a.x + b.x, a.y + b.y);
  const third = diff <= sum ? [{ i: 1, j: -1 }, { i: -1, j: 1 }] : [{ i: 1, j: 1 }, { i: -1, j: -1 }];
  const ring = [{ i: 1, j: 0 }, { i: 0, j: 1 }, { i: -1, j: 0 }, { i: 0, j: -1 }, ...third];
  const at = (o: { i: number; j: number }) => Math.atan2(a.y * o.i + b.y * o.j, a.x * o.i + b.x * o.j);
  const start = Math.atan2(a.y, a.x);
  const turn = (o: { i: number; j: number }) => (((at(o) - start) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  ring.sort((p, q) => turn(p) - turn(q));
  return [{ i: 0, j: 0 }, ...ring];
}

/** Every copy shown in Intersection for `repeat` (the live draft while a handle is dragged), each
 * placed by Repeat's own instancePose — rule rotation/mirror included — with its colour and
 * visibility from the artwork (or the defaults). */
export function intersectionCopies(doc: Doc, repeat: RepeatSystem = doc.repeat): IntersectionCopy[] {
  const saved = doc.intersection?.copies ?? {};
  return intersectionOffsets(repeat).map(({ i, j }, n) => {
    const key = `${i},${j}`;
    return {
      key,
      i,
      j,
      label: n === 0 ? 'Primary' : `Copy ${n}`,
      colour: saved[key]?.colour ?? DEFAULT_COLOURS[key] ?? '#1E2A36',
      visible: saved[key]?.visible ?? true,
      pose: instancePose(repeat, i, j),
    };
  });
}

/** The world-space bounds of the copies shown (each frame's extent around its own centre) — what
 * Intersection's Fit frames. Hidden copies still count, so hiding one never re-frames the view. */
export function intersectionBounds(doc: Doc): { minX: number; minY: number; maxX: number; maxY: number } {
  const pivot: Vec2 = doc.frame.origin;
  const r = motifRadius(doc);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { pose } of intersectionCopies(doc)) {
    const cx = pivot.x + pose.translate.x;
    const cy = pivot.y + pose.translate.y;
    minX = Math.min(minX, cx - r);
    maxX = Math.max(maxX, cx + r);
    minY = Math.min(minY, cy - r);
    maxY = Math.max(maxY, cy + r);
  }
  return { minX, minY, maxX, maxY };
}

/** The artwork's Intersection settings with one copy's colour or visibility changed. */
export function withCopySetting(doc: Doc, key: string, patch: { colour?: string; visible?: boolean }): NonNullable<Doc['intersection']> {
  const copies = { ...(doc.intersection?.copies ?? {}) };
  copies[key] = { ...copies[key], ...patch };
  return { copies };
}
