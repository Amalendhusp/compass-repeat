// Repeat's source and each source's own configuration (types.ts — RepeatSetup).
//
// - Choosing a source is one Undo step. What the source being left had — its lattice (spacing,
//   family, rule, rotation, Space colours), its appearance and its colouring — is kept with it, and
//   restored when it is chosen again; nothing the participant adjusted is reset.
// - The first time a source is chosen, its spacing is suggested for what it repeats: for the motif,
//   Repeat's usual comfortable spacing; for an Intersect arrangement, one worked out from the
//   arrangement's actual extent — every instance where it is placed and turned. The suggestion keeps
//   the lattice's shape and only scales it, so that the arrangement's bounding boxes just clear one
//   another (plus a little room). It is a starting point, not a claim that the copies tessellate or
//   never touch: their actual shapes may still overlap or leave gaps, and the participant is free to
//   bring them closer, overlap them or spread them out.
// - While the spacing is still exactly as suggested it follows the arrangement: change the Intersect
//   arrangement and, next time Repeat is shown, the suggestion is worked out again. Once the
//   participant adjusts the spacing it is theirs, and is never replaced.

import type { AppController } from '../app/controller.ts';
import type { Doc, RepeatAppearance, RepeatConfig, RepeatSetup, RepeatSourceKind, RepeatSystem, Vec2 } from '../model/types.ts';
import { resolveEntityGeom } from './kernel.ts';
import { deriveSegments } from './segments.ts';
import { computeFairRegions } from './regions.ts';
import { defaultLatticeVectors, instancePose, transformPoint, type InstancePose, type LatticeFamily } from './lattice.ts';
import { intersectionCopies } from './intersection.ts';

export type { RepeatSourceKind };

/** What Repeat repeats now. */
export function repeatSourceOf(doc: Doc): RepeatSourceKind {
  const s = doc.repeatSetup?.source ?? doc.repeatDisplay?.source;
  return s === 'intersect' ? 'intersect' : 'motif';
}

/** Repeat's appearance as the display holds it. */
export function appearanceOf(d: Doc['repeatDisplay']): RepeatAppearance {
  return {
    background: d.background,
    fillOpacity: d.fillOpacity,
    ...(d.strokeColour != null ? { strokeColour: d.strokeColour } : null),
    ...(d.strokeWidth != null ? { strokeWidth: d.strokeWidth } : null),
  };
}

/** The display with `a` as its appearance (and no legacy source field). */
export function withAppearance(d: Doc['repeatDisplay'], a: RepeatAppearance): Doc['repeatDisplay'] {
  const { source: _legacy, ...rest } = d;
  return { ...rest, background: a.background, fillOpacity: a.fillOpacity, strokeColour: a.strokeColour ?? null, strokeWidth: a.strokeWidth ?? null };
}

/** The active source's whole configuration, as plain data. */
export function activeConfig(doc: Doc): RepeatConfig {
  const { gapFills, ...rest } = doc.repeat;
  const setup = doc.repeatSetup;
  return {
    repeat: { ...structuredClone(rest), gapFills: [...gapFills] },
    appearance: appearanceOf(doc.repeatDisplay),
    ...(setup?.colour ? { colour: structuredClone(setup.colour) } : null),
    ...(setup?.auto ? { auto: structuredClone(setup.auto) } : null),
  };
}

function repeatFrom(c: RepeatConfig): RepeatSystem {
  return { ...structuredClone(c.repeat), gapFills: new Map(c.repeat.gapFills) };
}

const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) <= 1e-9 * Math.max(1, Math.hypot(q.x, q.y));

/** Whether the active source's spacing is still exactly as Repeat suggested it. */
export function spacingIsSuggested(doc: Doc): boolean {
  const auto = doc.repeatSetup?.auto;
  return !!auto && near(doc.repeat.a, auto.a) && near(doc.repeat.b, auto.b);
}

// ---- the suggestion ----

/** The points that bound one instance of the construction as Repeat draws it: its Fair pieces and
 * filled regions, and its frame (Repeat's usual measure of one motif). */
function motifOutline(doc: Doc): Vec2[] {
  const out: Vec2[] = [];
  const frame = new Set(doc.frame.entityIds);
  for (const e of doc.entities) {
    if (!frame.has(e.id) && !deriveSegments(doc, e).some((seg) => doc.segmentStates.get(seg.key)?.state === 'fair')) continue;
    const g = resolveEntityGeom(doc, e);
    if (g.kind === 'circle') for (let k = 0; k < 32; k++) out.push({ x: g.centre.x + g.radius * Math.cos((k * Math.PI) / 16), y: g.centre.y + g.radius * Math.sin((k * Math.PI) / 16) });
    else out.push(g.a, g.b);
  }
  for (const r of computeFairRegions(doc)) out.push(...r.samplePoints);
  return out;
}

/** The arrangement's axis-aligned extent about the lattice position, as each copy may show it (the
 * lattice's own rotation and Alternate/Mirror turns included). */
function arrangementBox(doc: Doc, repeat: RepeatSystem): { w: number; h: number } {
  const pivot = doc.frame.origin;
  const outline = motifOutline(doc);
  const members: InstancePose[] = intersectionCopies(doc).map((c) => c.pose);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
    const at = instancePose(repeat, i, j);
    const lattice: InstancePose = { ...at, translate: { x: 0, y: 0 } };
    for (const m of members) {
      for (const p of outline) {
        const q = transformPoint(pivot, lattice, transformPoint(pivot, m, p));
        minX = Math.min(minX, q.x);
        maxX = Math.max(maxX, q.x);
        minY = Math.min(minY, q.y);
        maxY = Math.max(maxY, q.y);
      }
    }
  }
  return { w: maxX - minX, h: maxY - minY };
}

/** A little room between the suggested neighbours' boxes. */
const ROOM = 1.05;

/** The lattice vectors Repeat suggests for a source and family. */
export function suggestedLattice(doc: Doc, family: LatticeFamily, source: RepeatSourceKind): { a: Vec2; b: Vec2 } {
  const base = defaultLatticeVectors(doc, family);
  if (source === 'motif') return base;
  // Keep the family's shape (and the motif's usual direction); scale it until no neighbour's
  // bounding box overlaps another's.
  const len = Math.hypot(base.a.x, base.a.y);
  const e1 = { x: base.a.x / len, y: base.a.y / len };
  const e2 = { x: base.b.x / len, y: base.b.y / len };
  const { w, h } = arrangementBox(doc, { ...doc.repeat, family, a: base.a, b: base.b });
  let scale = 0;
  for (let i = -3; i <= 3; i++) {
    for (let j = -3; j <= 3; j++) {
      if (i === 0 && j === 0) continue;
      const v = { x: i * e1.x + j * e2.x, y: i * e1.y + j * e2.y };
      const sx = Math.abs(v.x) > 1e-9 ? w / Math.abs(v.x) : Infinity;
      const sy = Math.abs(v.y) > 1e-9 ? h / Math.abs(v.y) : Infinity;
      scale = Math.max(scale, Math.min(sx, sy));
    }
  }
  if (!Number.isFinite(scale) || scale <= 0) return base;
  scale *= ROOM;
  return { a: { x: e1.x * scale, y: e1.y * scale }, b: { x: e2.x * scale, y: e2.y * scale } };
}

// ---- choosing a source ----

/** Chooses what Repeat repeats — one Undo step. The source being left keeps its configuration. */
export function switchRepeatSource(controller: AppController, to: RepeatSourceKind): void {
  const from = repeatSourceOf(controller.doc);
  if (from === to) return;
  controller.commit((d) => {
    const before: RepeatSetup = d.repeatSetup ?? { source: from };
    const saved = before.saved?.[to];
    const kept: RepeatSetup['saved'] = { ...before.saved, [from]: activeConfig(d) };
    delete kept[to];
    const setup: RepeatSetup = { source: to, saved: kept };
    if (saved) {
      d.repeat = repeatFrom(saved);
      d.repeatDisplay = withAppearance(d.repeatDisplay, saved.appearance);
      if (saved.colour) setup.colour = structuredClone(saved.colour);
      if (saved.auto) setup.auto = structuredClone(saved.auto);
    } else {
      // First time: the lattice's family, rule and rotation carry over; the spacing is suggested for
      // this source; Space colours belong to the motif's own repeat. The appearance carries over.
      const family = (d.repeat.family ?? 'square') as LatticeFamily;
      const v = suggestedLattice({ ...d, repeatSetup: setup }, family, to);
      d.repeat = { ...d.repeat, a: v.a, b: v.b, motif: { ...d.repeat.motif }, rule: { ...d.repeat.rule }, gapFills: new Map() };
      setup.auto = { a: { ...v.a }, b: { ...v.b } };
      d.repeatDisplay = withAppearance(d.repeatDisplay, appearanceOf(d.repeatDisplay));
    }
    d.repeatSetup = setup;
    // A suggestion made for an earlier arrangement follows the arrangement as it is now.
    refreshSuggestedSpacing(d);
  });
}

/**
 * While the active source's spacing is still exactly as suggested, works the suggestion out again
 * for the arrangement as it is now (in place, like Repeat's first setup). True if it changed.
 */
export function refreshSuggestedSpacing(doc: Doc): boolean {
  const setup = doc.repeatSetup;
  if (!setup || setup.source !== 'intersect' || !spacingIsSuggested(doc) || doc.repeat.family === undefined) return false;
  const v = suggestedLattice(doc, doc.repeat.family as LatticeFamily, 'intersect');
  if (near(v.a, doc.repeat.a) && near(v.b, doc.repeat.b)) return false;
  doc.repeat = { ...doc.repeat, a: v.a, b: v.b };
  doc.repeatSetup = { ...setup, auto: { a: { ...v.a }, b: { ...v.b } } };
  return true;
}

/** A family chosen in Repeat: its suggested spacing for the active source (marked as suggested). */
export function suggestForFamily(doc: Doc, family: LatticeFamily): { a: Vec2; b: Vec2 } {
  const source = repeatSourceOf(doc);
  const v = suggestedLattice(doc, family, source);
  doc.repeatSetup = { ...(doc.repeatSetup ?? { source }), auto: { a: { ...v.a }, b: { ...v.b } } };
  return v;
}

/**
 * Undo / Redo across a change of source: Repeat's appearance isn't history (it is carried across
 * Undo like the camera), but each source has its own — so the appearance showing goes with the
 * source being left, and the arriving source's own comes back.
 */
export function carryAppearanceAcross(leaving: Doc, arriving: Doc, liveDisplay: Doc['repeatDisplay']): Doc['repeatDisplay'] {
  const from = repeatSourceOf(leaving);
  const to = repeatSourceOf(arriving);
  if (from === to) return liveDisplay;
  const own = leaving.repeatSetup?.saved?.[to]?.appearance;
  const setup: RepeatSetup = arriving.repeatSetup ?? { source: to };
  const keep = setup.saved?.[from] ?? activeConfig(leaving);
  arriving.repeatSetup = { ...setup, saved: { ...setup.saved, [from]: { ...keep, appearance: appearanceOf(liveDisplay) } } };
  return own ? withAppearance(liveDisplay, own) : liveDisplay;
}
