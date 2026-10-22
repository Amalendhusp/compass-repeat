// Repeat's source: what stands at each lattice position.
//
// - 'motif' (as ever): the construction itself.
// - 'intersect': the current Intersect arrangement as ONE unit — every instance, where it has been
//   placed and turned (Spread included), all of them the one construction with its Fair state and
//   fills. Repeat then carries that whole unit across its lattice, with its own spacing, rotation
//   and Same / Alternate / Mirror, exactly as it carries a single motif.
//
// Nothing is baked: the unit is only a list of placements, read from the Intersect arrangement
// each time. Edit the construction, its Fair state or the arrangement, and Repeat shows it. And only
// the arrangement defines the unit — never Intersect's contextual crossings, which are places to
// build from, not geometry.

import type { Doc } from '../model/types.ts';
import { motifExtent, type InstancePose } from './lattice.ts';
import { intersectionCopies } from './intersection.ts';
import { repeatSourceOf, type RepeatSourceKind } from './repeatSetup.ts';

export type RepeatSource = RepeatSourceKind;

export function repeatSource(doc: Doc): RepeatSource {
  return repeatSourceOf(doc);
}

export interface RepeatUnit {
  /** Each instance's placement, in the artwork's own coordinates (the Primary first). */
  members: InstancePose[];
  /** Each instance's key (its region colours are kept by it). */
  keys: string[];
  /** How far the unit's drawn artwork reaches from the lattice position (the frame centre). */
  extent: number;
  /** Changes whenever the placements do. */
  key: string;
}

const cache = new WeakMap<Doc, RepeatUnit>();

/** The Intersect arrangement as Repeat's unit — or null when Repeat repeats the motif itself. */
export function repeatUnit(doc: Doc): RepeatUnit | null {
  if (repeatSource(doc) !== 'intersect') return null;
  let unit = cache.get(doc);
  if (!unit) {
    const copies = intersectionCopies(doc);
    const members = copies.map((c) => c.pose);
    const reach = motifExtent(doc);
    unit = {
      members,
      keys: copies.map((c) => c.key),
      extent: Math.max(...members.map((m) => Math.hypot(m.translate.x, m.translate.y))) + reach,
      key: members.map((m) => `${m.translate.x},${m.translate.y},${m.rotation}`).join(';'),
    };
    cache.set(doc, unit);
  }
  return unit;
}
