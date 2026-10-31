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

import type { Doc, Vec2 } from '../model/types.ts';
import { motifExtent, type InstancePose } from './lattice.ts';
import { developedFeatures, repeatComposition, type CompositionMember } from './repeatComposition.ts';
import { closestOn, endsOf, len, motifRuns, placePrim, sub, type Prim } from './fairGeometry.ts';
import { developedSegments } from './intersection.ts';
import { formEps, midOf } from './formSegments.ts';
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
  /** Stage D: the Developed Primary as Repeat draws it — exact lines and arcs in the artwork's own
   * coordinates (it stands where it was developed, about the lattice position), leaving out any that a
   * Primary-copy already draws there (no doubled strokes, D6). Empty for a legacy artwork. */
  developed: Prim[];
}

const cache = new WeakMap<Doc, RepeatUnit>();

/** The Intersect arrangement as Repeat's unit — or null when Repeat repeats the motif itself. */
export function repeatUnit(doc: Doc): RepeatUnit | null {
  if (repeatSource(doc) !== 'intersect') return null;
  let unit = cache.get(doc);
  if (!unit) {
    // Stage B: the members come from the one composition service (repeatComposition.ts): the
    // instances that show the Construct motif (every one, for a legacy artwork; the Original and the
    // Primary-copies otherwise) — and, Stage D, the Developed Primary.
    const all = repeatComposition(doc).members;
    const comp = all.filter((m) => m.owner === 'construct');
    const members = comp.map((m) => m.pose);
    const developed = all.some((m) => m.owner === 'developed') ? notDrawnBy(doc, developedFeatures(doc).map((f) => f.prim), comp) : [];
    const reaches = [
      ...members.map((m) => Math.hypot(m.translate.x, m.translate.y) + motifExtent(doc)),
      ...developed.map((p) => reachOf(doc.frame.origin, p)),
    ];
    const devIds = developed.length ? `|dev:${developedSegments(doc).map((s) => s.id).join(',')}` : '';
    unit = {
      members,
      keys: comp.map((m) => m.key),
      // Nothing to repeat (an empty composition): one motif's reach, so nothing downstream divides by zero.
      extent: reaches.length ? Math.max(...reaches) : motifExtent(doc),
      key: members.map((m) => `${m.translate.x},${m.translate.y},${m.rotation}`).join(';') + devIds,
      developed,
    };
    cache.set(doc, unit);
  }
  return unit;
}

/** How far a primitive reaches from `pivot`. */
function reachOf(pivot: Vec2, p: Prim): number {
  if (p.k === 'seg') return Math.max(len(sub(p.a, pivot)), len(sub(p.b, pivot)));
  return len(sub(p.c, pivot)) + p.r;
}

/** The developed segments a Primary-copy does not already draw: one lying along a member's own Fair
 * run (ends and middle on it, same line or circle) is drawn by that member. */
function notDrawnBy(doc: Doc, developed: Prim[], members: CompositionMember[]): Prim[] {
  if (!members.length) return developed;
  const pivot = doc.frame.origin;
  const runs = motifRuns(doc);
  const placed = members.flatMap((m) => runs.map((r) => placePrim(r.prim, pivot, m.pose)));
  const tol = formEps(doc) * 10;
  const along = (p: Prim, q: Prim): boolean => {
    if (p.k !== q.k) return false;
    if (p.k === 'arc' && q.k === 'arc' && (Math.abs(p.r - q.r) > tol || len(sub(p.c, q.c)) > tol)) return false;
    return [...endsOf(p), midOf(p)].every((pt) => closestOn(pt, q).d <= tol);
  };
  return developed.filter((p) => !placed.some((q) => along(p, q)));
}
