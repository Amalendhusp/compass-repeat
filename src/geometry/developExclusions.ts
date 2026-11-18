// Develop (Intersect, Stage B): parts of a Whole copy's Fair taken OUT of the developed design.
//
// Whole includes a copy's entire Construct Fair motif where the copy stands (the `primaryCopy` flag, as
// before). A segment of it can then be removed from the design on its own: the copy records the removed
// stretch as an exclusion — in its OWN coordinates (the Construct motif's), as a range along one Construct
// line or circle:
//
//   line   → { entity, t0, t1 }   0 ≤ t0 < t1 ≤ 1, along the line from its A to its B
//   circle → { entity, t0, t1 }   t0 the start angle (0 ≤ t0 < 2π), t1 = t0 + sweep (anticlockwise)
//
// — the same parameters the Construct pieces themselves use. So an exclusion follows its copy through
// every move, turn, reflection and scale, other copies moving never changes it, and the Construct source
// is never touched (its Fair, the other copies and Construct's own Repeat are unchanged). Stored as
// `intersection.copies[key].excluded`, written only when there is one (an artwork that never excluded
// anything keeps exactly its stored shape). Repeat, Fill spaces, crossings and Close Gap all read the
// Whole copies through `cutFeature` / `remainingRanges`, so what Develop removed is never repeated.

import type { Doc, Vec2 } from '../model/types.ts';
import { resolveEntityGeom } from './kernel.ts';
import { inversePoint, type InstancePose } from './lattice.ts';
import { dot, norm, sub, TAU, type Prim } from './fairGeometry.ts';

export interface Excluded {
  entity: string;
  t0: number;
  t1: number;
}

/** Ranges closer than this (in the parameter: a fraction of a line, or radians) are one. */
const PARAM_EPS = 1e-7;

/** Copy `key`'s exclusions (empty when it has none). */
export function exclusionsOf(doc: Doc, key: string): Excluded[] {
  const list = doc.intersection?.copies?.[key]?.excluded;
  return Array.isArray(list) ? list.filter((e) => e && typeof e.entity === 'string' && Number.isFinite(e.t0) && Number.isFinite(e.t1) && e.t1 > e.t0) : [];
}

const mapCache = new WeakMap<object, Map<string, Map<string, Excluded[]> | null>>();

/** Copy `key`'s exclusions by entity — or null when it has none (worked out once per stored list). */
export function exclusionMap(doc: Doc, key: string): Map<string, Excluded[]> | null {
  const copies = doc.intersection?.copies;
  if (!copies?.[key]?.excluded) return null;
  let byKey = mapCache.get(copies[key]!);
  if (!byKey) mapCache.set(copies[key]!, (byKey = new Map()));
  if (byKey.has(key)) return byKey.get(key)!;
  const list = exclusionsOf(doc, key);
  let map: Map<string, Excluded[]> | null = null;
  if (list.length) {
    map = new Map();
    for (const e of list) (map.get(e.entity) ?? map.set(e.entity, []).get(e.entity)!).push(e);
  }
  byKey.set(key, map);
  return map;
}

/** A short signature of every copy's exclusions (for cache keys) — '' when there are none. */
export function exclusionSignature(doc: Doc, keys: string[]): string {
  const parts: string[] = [];
  for (const k of keys) {
    const list = exclusionsOf(doc, k);
    if (list.length) parts.push(`${k}:${list.map((e) => `${e.entity}@${e.t0.toFixed(9)}-${e.t1.toFixed(9)}`).join('/')}`);
  }
  return parts.length ? `|ex:${parts.join(';')}` : '';
}

/**
 * What is left of the range [t0, t1] along an entity once `excluded` is taken out (the entity's own
 * parameters; a circle's range may run past 2π). Pieces shorter than PARAM_EPS are dropped.
 */
export function remainingRanges(t0: number, t1: number, excluded: Excluded[] | undefined, circle: boolean): [number, number][] {
  if (!excluded?.length) return [[t0, t1]];
  // The excluded stretches, in [t0, t1]'s own frame (a circle's shifted round to meet it).
  const cuts: [number, number][] = [];
  for (const e of excluded) {
    if (!circle) {
      cuts.push([e.t0, e.t1]);
      continue;
    }
    const w = e.t1 - e.t0;
    const s = t0 + norm(e.t0 - t0);
    for (const at of [s - TAU, s, s + TAU]) cuts.push([at, at + w]);
  }
  cuts.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let from = t0;
  for (const [c0, c1] of cuts) {
    if (c1 <= from + PARAM_EPS || c0 >= t1) continue;
    if (c0 > from + PARAM_EPS) out.push([from, Math.min(c0, t1)]);
    from = Math.max(from, c1);
    if (from >= t1 - PARAM_EPS) break;
  }
  if (from < t1 - PARAM_EPS) out.push([from, t1]);
  return out;
}

/** Whether parameter `t` on an entity lies in one of `excluded`. */
export function isExcludedAt(t: number, excluded: Excluded[] | undefined, circle: boolean): boolean {
  if (!excluded?.length) return false;
  return excluded.some((e) => (circle ? norm(t - e.t0) <= e.t1 - e.t0 : t >= e.t0 && t <= e.t1));
}

/** A copy-local primitive's range along its Construct entity: a line's parameters at its two ends (in
 * order), or an arc's start angle and end (start + sweep). Null if the entity is gone. */
export function rangeOfPrim(doc: Doc, entityId: string, p: Prim): [number, number] | null {
  const e = doc.entities.find((x) => x.id === entityId);
  if (!e) return null;
  const g = resolveEntityGeom(doc, e);
  if (g.kind === 'circle') {
    if (p.k !== 'arc') return null;
    const a0 = norm(p.a0);
    return [a0, a0 + p.sw];
  }
  if (p.k !== 'seg') return null;
  const d = sub(g.b, g.a);
  const dd = dot(d, d);
  if (dd <= 1e-18) return null;
  const ta = dot(sub(p.a, g.a), d) / dd;
  const tb = dot(sub(p.b, g.a), d) / dd;
  return ta <= tb ? [ta, tb] : [tb, ta];
}

/** The copy-local primitive for a range along an entity. */
export function primOfRange(doc: Doc, entityId: string, t0: number, t1: number): Prim | null {
  const e = doc.entities.find((x) => x.id === entityId);
  if (!e) return null;
  const g = resolveEntityGeom(doc, e);
  if (g.kind === 'circle') return { k: 'arc', c: { ...g.centre }, r: g.radius, a0: norm(t0), sw: Math.min(TAU, t1 - t0) };
  const at = (t: number): Vec2 => ({ x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t });
  return { k: 'seg', a: at(t0), b: at(t1) };
}

/** A copy-local feature with copy `key`'s exclusions taken out: the pieces that remain (the feature
 * itself, untouched, when nothing of it is excluded). */
export function cutFeature(doc: Doc, map: Map<string, Excluded[]> | null, entityId: string | undefined, p: Prim): Prim[] {
  if (!map || !entityId) return [p];
  const ex = map.get(entityId);
  if (!ex?.length) return [p];
  const range = rangeOfPrim(doc, entityId, p);
  if (!range) return [p];
  const circle = p.k === 'arc';
  const left = remainingRanges(range[0], range[1], ex, circle);
  if (left.length === 1 && left[0]![0] === range[0] && left[0]![1] === range[1]) return [p];
  return left.map(([a, b]) => primOfRange(doc, entityId, a, b)).filter((q): q is Prim => !!q);
}

/**
 * Where a PLACED segment of copy `pose` lies along the copy's Construct entity `entityId` — its range in
 * the entity's own parameters — or null. The segment's ends and middle are taken back into the copy's
 * own coordinates (so a reflected or scaled copy gives the same range as an unplaced one).
 */
export function localRange(doc: Doc, pose: InstancePose, entityId: string, placed: Prim): { t0: number; t1: number; mid: number; circle: boolean } | null {
  const e = doc.entities.find((x) => x.id === entityId);
  if (!e) return null;
  const g = resolveEntityGeom(doc, e);
  const pivot = doc.frame.origin;
  const back = (w: Vec2) => inversePoint(pivot, pose, w);
  const ends = placed.k === 'seg' ? [placed.a, placed.b] : [arcAt(placed, placed.a0), arcAt(placed, placed.a0 + placed.sw)];
  const midW = placed.k === 'seg' ? { x: (placed.a.x + placed.b.x) / 2, y: (placed.a.y + placed.b.y) / 2 } : arcAt(placed, placed.a0 + placed.sw / 2);
  const [p0, p1, pm] = [back(ends[0]!), back(ends[1]!), back(midW)];
  if (g.kind === 'circle') {
    const ang = (q: Vec2) => norm(Math.atan2(q.y - g.centre.y, q.x - g.centre.x));
    if (placed.k === 'arc' && placed.sw >= TAU - 1e-9) return { t0: 0, t1: TAU, mid: Math.PI, circle: true };
    const s = ang(p0);
    const t = ang(p1);
    const m = ang(pm);
    // Anticlockwise from one end to the other, through the middle.
    const [a, b] = norm(m - s) <= norm(t - s) ? [s, t] : [t, s];
    return { t0: a, t1: a + norm(b - a), mid: m, circle: true };
  }
  const d = sub(g.b, g.a);
  const dd = dot(d, d);
  if (dd <= 1e-18) return null;
  const par = (q: Vec2) => dot(sub(q, g.a), d) / dd;
  const ta = par(p0);
  const tb = par(p1);
  return { t0: Math.min(ta, tb), t1: Math.max(ta, tb), mid: par(pm), circle: false };
}

function arcAt(p: Extract<Prim, { k: 'arc' }>, t: number): Vec2 {
  return { x: p.c.x + p.r * Math.cos(t), y: p.c.y + p.r * Math.sin(t) };
}

/** `list` with [t0, t1] along `entity` excluded too (merged with what it touches). */
export function withExcluded(list: Excluded[], entity: string, t0: number, t1: number, circle: boolean): Excluded[] {
  const same = list.filter((e) => e.entity === entity);
  const others = list.filter((e) => e.entity !== entity);
  let cur: [number, number] = [t0, t1];
  const keep: Excluded[] = [];
  for (const e of same) {
    // Shift a circle's range round to meet the new one, where they overlap or touch.
    const shifts = circle ? [-TAU, 0, TAU] : [0];
    let merged = false;
    for (const k of shifts) {
      const a = e.t0 + k;
      const b = e.t1 + k;
      if (a <= cur[1] + PARAM_EPS && b >= cur[0] - PARAM_EPS) {
        cur = [Math.min(a, cur[0]), Math.max(b, cur[1])];
        merged = true;
        break;
      }
    }
    if (!merged) keep.push(e);
  }
  if (circle) {
    if (cur[1] - cur[0] >= TAU - PARAM_EPS) cur = [0, TAU];
    else {
      const s = norm(cur[0]);
      cur = [s, s + (cur[1] - cur[0])];
    }
  } else cur = [Math.max(0, cur[0]), Math.min(1, cur[1])];
  return [...others, ...keep, { entity, t0: cur[0], t1: cur[1] }];
}

/** `list` with [t0, t1] along `entity` no longer excluded (what is left of each range kept). */
export function withoutExcluded(list: Excluded[], entity: string, t0: number, t1: number, circle: boolean): Excluded[] {
  const out: Excluded[] = [];
  for (const e of list) {
    if (e.entity !== entity) {
      out.push(e);
      continue;
    }
    // The part of e outside [t0, t1]: e's range minus the restored range.
    const restored: Excluded = { entity, t0, t1 };
    for (const [a, b] of remainingRanges(e.t0, e.t1, [restored], circle)) {
      if (b - a <= PARAM_EPS) continue;
      const s = circle ? norm(a) : a;
      out.push({ entity, t0: s, t1: s + (b - a) });
    }
  }
  return out;
}
