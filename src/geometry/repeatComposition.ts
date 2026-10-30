// Repeat's composition (Stage B / F0): WHAT stands at each lattice position, as a list of members —
// each a placement (pose about the frame centre) of geometry with an owner — and the composition's
// Fair geometry, placed member by member, with source identifiers.
//
// One place answers this for everything that repeats or measures the unit: the Repeat renderer and
// colouring (through repeatUnit), Close Gap, and — next — Intersect Form Development, which adds a
// member of its own ('developed': Intersect's independent Primary) and lets copies opt in.
//
// Today:
// - Construct source: the motif itself — one member, 'motif', not moved.
// - Intersect source: every Intersect instance (the Original and every copy) where it has been placed
//   and turned, all of them the one Construct motif.

import type { Doc } from '../model/types.ts';
import type { InstancePose } from './lattice.ts';
import { intersectionCopies } from './intersection.ts';
import { repeatSourceOf, type RepeatSourceKind } from './repeatSetup.ts';
import { motifPieces, motifRuns, placePrim, type Feature, type FeatureSource, type MotifFeature } from './fairGeometry.ts';

export interface CompositionMember {
  /** 'motif' for the Construct source; an Intersect instance key otherwise ('0,0' = the Original). */
  key: string;
  /** Where the member stands relative to the lattice position (about the frame centre). */
  pose: InstancePose;
  /** Whose geometry it shows. */
  owner: FeatureSource['owner'];
}

export interface RepeatComposition {
  source: RepeatSourceKind;
  members: CompositionMember[];
}

const IDENTITY: InstancePose = { i: 0, j: 0, translate: { x: 0, y: 0 }, rotation: 0, mirror: false };

const cache = new WeakMap<Doc, RepeatComposition>();

/** What Repeat repeats now, member by member. */
export function repeatComposition(doc: Doc): RepeatComposition {
  let comp = cache.get(doc);
  if (!comp) {
    if (repeatSourceOf(doc) !== 'intersect') comp = { source: 'motif', members: [{ key: 'motif', pose: IDENTITY, owner: 'construct' }] };
    else comp = { source: 'intersect', members: intersectionCopies(doc).map((c) => ({ key: c.key, pose: c.pose, owner: 'construct' as const })) };
    cache.set(doc, comp);
  }
  return comp;
}

/**
 * The composition's Fair geometry as ONE unit, in the artwork's own coordinates: each member's
 * pieces (or runs) placed as that member stands, with ids `${member}|${motif id}` and their source.
 * The Construct source is the motif as drawn (no placement).
 */
export function compositionFeatures(doc: Doc, kind: 'pieces' | 'runs'): Feature[] {
  const own: MotifFeature[] = kind === 'runs' ? motifRuns(doc) : motifPieces(doc);
  const comp = repeatComposition(doc);
  const pivot = doc.frame.origin;
  return comp.members.flatMap((m) =>
    own.map((f) => ({
      id: `${m.key}|${f.id}`,
      prim: comp.source === 'motif' ? f.prim : placePrim(f.prim, pivot, m.pose),
      source: { owner: m.owner, member: m.key, entity: f.entity },
    })),
  );
}
