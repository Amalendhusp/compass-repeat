// Repeat Colouring (types.ts — RepeatColouring): Repeat's own colours for the repeated design.
// Never the construction's fills — Construct keeps those exactly — and never the negative space
// between copies (Space, repeat.gapFills) or the background (Appearance).
//
// - Motif Colouring: a region of the source, coloured in every copy. Regions are the
//   construction's own faces, known by their signature (regions.ts — the same identity Fill uses),
//   never by where they happen to be on screen. With an Intersect arrangement as the source, the
//   same face of different instances is a different region ("instanceKey|signature").
// - Pattern Colouring: copies fall into two groups by their place in the lattice — alternate
//   copies (i + j odd), rows (j odd) or columns (i odd) — and the second group may have its own
//   region colours, over Motif Colouring's. The groups come from the lattice indices, so they
//   stay the same however the view is panned, zoomed, exported or reopened. (On the 60° lattices
//   two groups cannot keep every pair of neighbours apart: "copies" alternates along each row.)
//
// A tap finds the copy drawn on top at that spot (the order Repeat draws them in) and the
// smallest region of the source containing it there — where copies or Intersect instances overlap,
// the one on top is coloured.

import type { Doc, FaceSig, RepeatColouring, Vec2 } from '../model/types.ts';
import { screenToWorld, type ViewTransform } from '../app/controller.ts';
import { computeFairRegions, findRegionAt } from './regions.ts';
import { composePose, visibleInstances, type InstancePose } from './lattice.ts';
import { repeatUnit } from './repeatUnit.ts';
import { computeSpaces, spaceAt, unitRegionAt, unitRegions, type SpaceClass } from './spaces.ts';
import { repeatSourceOf } from './repeatSetup.ts';

export type PatternBy = NonNullable<RepeatColouring['pattern']>['by'];

const odd = (n: number) => ((n % 2) + 2) % 2 === 1;

/** Which group a copy at (i, j) is in: 1 = the second group, coloured by Pattern Colouring. */
export function patternGroup(colour: RepeatColouring | undefined, i: number, j: number): 0 | 1 {
  switch (colour?.pattern?.by) {
    case 'copies':
      return odd(i + j) ? 1 : 0;
    case 'rows':
      return odd(j) ? 1 : 0;
    case 'columns':
      return odd(i) ? 1 : 0;
    default:
      return 0;
  }
}

export function regionKey(instanceKey: string | null, sig: FaceSig): string {
  return instanceKey ? `${instanceKey}|${sig}` : sig;
}

/** Repeat's colour for a region in a copy of `group`: a colour, null (unfilled), or undefined (as
 * designed — the construction's own fill). */
export function regionColour(colour: RepeatColouring | undefined, key: string, group: 0 | 1): string | null | undefined {
  if (!colour) return undefined;
  if (group === 1 && colour.pattern && colour.pattern.by !== 'none' && key in colour.pattern.regions) return colour.pattern.regions[key];
  if (colour.regions && key in colour.regions) return colour.regions[key];
  return undefined;
}

/** Whether Repeat colours anything itself. */
export function colouringInUse(colour: RepeatColouring | undefined): boolean {
  if (!colour) return false;
  if (colour.regions && Object.keys(colour.regions).length > 0) return true;
  return !!colour.pattern && colour.pattern.by !== 'none' && Object.keys(colour.pattern.regions).length > 0;
}

/** A point of a copy back in the construction's own coordinates (transformPoint, undone). */
export function intoMotif(pivot: Vec2, pose: InstancePose, w: Vec2): Vec2 {
  const dx = w.x - pivot.x - pose.translate.x;
  const dy = w.y - pivot.y - pose.translate.y;
  const c = Math.cos(-pose.rotation);
  const s = Math.sin(-pose.rotation);
  const x = dx * c - dy * s;
  let y = dx * s + dy * c;
  if (pose.mirror) y = -y;
  return { x: x + pivot.x, y: y + pivot.y };
}

export interface RegionHit {
  key: string;
  sig: FaceSig;
  instanceKey: string | null;
  i: number;
  j: number;
  /** Another copy or instance has a region under the same spot too: an overlap, which is not a
   * region of its own (only the source's own faces are) — the one on top was found. */
  overlapped: boolean;
  /** The region's area (artwork units²). */
  area: number;
}

/** The region under a canvas point in Repeat (paper px): the copy drawn on top there, and its
 * smallest region containing the point. */
export function regionAtInRepeat(doc: Doc, view: ViewTransform, paper: Vec2): RegionHit | null {
  const regions = computeFairRegions(doc);
  if (regions.length === 0) return null;
  const w = screenToWorld(view, paper);
  const pivot = doc.frame.origin;
  const unit = repeatUnit(doc);
  const poses = visibleInstances(doc, view, unit?.extent);
  let found: RegionHit | null = null;
  for (let n = poses.length - 1; n >= 0; n--) {
    const pose = poses[n]!;
    const members: { key: string | null; pose: InstancePose }[] = unit ? unit.members.map((m, k) => ({ key: unit.keys[k]!, pose: composePose(pose, m) })) : [{ key: null, pose }];
    for (let k = members.length - 1; k >= 0; k--) {
      const m = members[k]!;
      const r = findRegionAt(regions, intoMotif(pivot, m.pose, w));
      if (!r) continue;
      if (found) {
        found.overlapped = true;
        return found;
      }
      found = { key: regionKey(m.key, r.sig), sig: r.sig, instanceKey: m.key, i: pose.i, j: pose.j, overlapped: false, area: r.areaWorld };
    }
  }
  return found;
}

/**
 * Colours (or, if it already has exactly this colour, returns to as designed) one region — in
 * every copy (`group` 0: Motif Colouring), or in every copy of the second group (Pattern
 * Colouring). Returns the colouring after it.
 */
export function toggleRegion(colour: RepeatColouring | undefined, key: string, paint: string | null, group: 0 | 1): RepeatColouring {
  const next: RepeatColouring = structuredClone(colour ?? {});
  if (group === 1 && next.pattern) {
    const regions = next.pattern.regions;
    if (key in regions && regions[key] === paint) delete regions[key];
    else regions[key] = paint;
  } else {
    const regions = (next.regions ??= {});
    if (key in regions && regions[key] === paint) delete regions[key];
    else regions[key] = paint;
  }
  return next;
}

/**
 * Final sprint, Stage 1 — one Fill: what a tap in Repeat fills, decided here rather than by the
 * designer. The region of the design under the tap (in the copy drawn on top), else the enclosed space
 * between copies, else nothing (then the caller looks for the opening).
 *
 * - Construct source: the motif's own region (as Motif fill always did), else a Space.
 * - Intersect source: the unit's own region under the tap (spaces.ts `unitRegions`: bounded by any
 *   members and the Developed Primary together). When that region is exactly one member's own face, it
 *   keeps that face's existing key (`instance|signature`), so fills made before keep working and stay
 *   tied to the construction; otherwise it is known by its `face:` key. Else a Space.
 */
export type FillTarget =
  | { kind: 'region'; key: string; i: number; j: number; overlapped: boolean }
  | { kind: 'space'; space: SpaceClass };

export function fillTargetAt(doc: Doc, view: ViewTransform, paper: Vec2): FillTarget | null {
  const w = screenToWorld(view, paper);
  if (repeatSourceOf(doc) === 'intersect') {
    const regions = unitRegions(doc);
    if (regions.length) {
      const pivot = doc.frame.origin;
      const unit = repeatUnit(doc);
      const poses = visibleInstances(doc, view, unit?.extent);
      for (let n = poses.length - 1; n >= 0; n--) {
        const pose = poses[n]!;
        const r = unitRegionAt(regions, intoMotif(pivot, pose, w));
        if (!r) continue;
        const member = regionAtInRepeat(doc, view, paper);
        if (member && member.i === pose.i && member.j === pose.j && Math.abs(member.area - r.area) <= r.area * 5e-3) return { kind: 'region', key: member.key, i: pose.i, j: pose.j, overlapped: false };
        return { kind: 'region', key: r.key, i: pose.i, j: pose.j, overlapped: false };
      }
    }
  } else {
    const hit = regionAtInRepeat(doc, view, paper);
    if (hit) return { kind: 'region', key: hit.key, i: hit.i, j: hit.j, overlapped: hit.overlapped };
  }
  const space = spaceAt(computeSpaces(doc), w);
  return space ? { kind: 'space', space } : null;
}
