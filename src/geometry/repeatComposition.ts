// Repeat's composition (Stage B / F0): WHAT stands at each lattice position, as a list of members —
// each a placement (pose about the frame centre) of geometry with an owner — and the composition's
// Fair geometry, placed member by member, with source identifiers.
//
// One place answers this for everything that repeats or measures the unit: the Repeat renderer and
// colouring (through repeatUnit), Close Gap, and — next — Intersect Form Development, which adds a
// member of its own ('developed': Intersect's independent Primary) and lets copies opt in.
//
// - Construct source: the motif itself — one member, 'motif', not moved.
// - Intersect source, legacy artwork (geometry/intersection.ts — formMode): every Intersect instance
//   where it has been placed and turned, all of them the one Construct motif — exactly as before.
// - Intersect source, Form Development: the Original (unless demoted) and each promoted Primary-copy,
//   where they stand, and the Developed Primary ('developed', owner 'developed') — Intersect's own
//   geometry, never moved (identity pose: it is stored where it stands).

import type { Doc } from '../model/types.ts';
import type { InstancePose } from './lattice.ts';
import { developedSegments, inComposition, intersectionCopies } from './intersection.ts';
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

/** The Developed Primary's member key. */
export const DEVELOPED = 'developed';

const IDENTITY: InstancePose = { i: 0, j: 0, translate: { x: 0, y: 0 }, rotation: 0, mirror: false };

const cache = new WeakMap<Doc, RepeatComposition>();

/** What Repeat repeats now, member by member. */
export function repeatComposition(doc: Doc): RepeatComposition {
  let comp = cache.get(doc);
  if (!comp) {
    if (repeatSourceOf(doc) !== 'intersect') comp = { source: 'motif', members: [{ key: 'motif', pose: IDENTITY, owner: 'construct' }] };
    else {
      const members: CompositionMember[] = intersectionCopies(doc)
        .filter((c) => inComposition(doc, c.key))
        .map((c) => ({ key: c.key, pose: c.pose, owner: 'construct' as const }));
      if (developedSegments(doc).length > 0) members.push({ key: DEVELOPED, pose: IDENTITY, owner: 'developed' });
      comp = { source: 'intersect', members };
    }
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
    m.owner === 'developed'
      ? developedFeatures(doc)
      : own.map((f) => ({
          id: `${m.key}|${f.id}`,
          prim: comp.source === 'motif' ? f.prim : placePrim(f.prim, pivot, m.pose),
          source: { owner: m.owner, member: m.key, entity: f.entity },
        })),
  );
}

/** The Developed Primary as features: each stored segment, exactly, where it stands. */
export function developedFeatures(doc: Doc): Feature[] {
  return developedSegments(doc).map((s) => ({
    id: `${DEVELOPED}|${s.id}`,
    prim: s.geom.kind === 'line' ? { k: 'seg', a: { ...s.geom.a }, b: { ...s.geom.b } } : { k: 'arc', c: { ...s.geom.c }, r: s.geom.r, a0: s.geom.a0, sw: s.geom.sw },
    source: { owner: 'developed', member: DEVELOPED, entity: s.origins[0]?.entity },
  }));
}
