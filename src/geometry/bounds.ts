// Phase 3.2 item 3: the world-space bounding box Fit fits into the usable canvas rectangle —
// pure geometry, no view/DOM concerns (those live in main.ts's fitView).

import type { Doc, Point } from '../model/types.ts';
import { epsilon, projectOntoEntity, resolveEntityGeom, resolvePoint } from './kernel.ts';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A world point as seen by a camera turned by `turn` (radians): its coordinates in that frame. */
export function turned(p: { x: number; y: number }, turn: number): { x: number; y: number } {
  if (!turn) return { x: p.x, y: p.y };
  const c = Math.cos(turn);
  const n = Math.sin(turn);
  return { x: p.x * c - p.y * n, y: p.x * n + p.y * c };
}

function expand(b: Bounds | null, x: number, y: number): Bounds {
  if (!b) return { minX: x, maxX: x, minY: y, maxY: y };
  return { minX: Math.min(b.minX, x), maxX: Math.max(b.maxX, x), minY: Math.min(b.minY, y), maxY: Math.max(b.maxY, y) };
}

const PARAM_EPS = 1e-6;

/**
 * Phase 3.6 item 1: true for every point EXCEPT one that only exists out along an Extension
 * line's infinite reach — a circle has no infinite extent at all (always finite), and any point
 * kind other than 'intersection'/'on-curve' isn't parametrized against a specific curve's own
 * extent to begin with (midpoint/division/free/centre/frame-vertex are all finite by construction).
 * An intersection or explicitly-placed on-curve point is finite only if its param, re-derived by
 * projecting its resolved position back onto the host, falls within the host's own literal A→B
 * span — regardless of whether that line happens to be `extended`.
 */
function isPointWithinFiniteSpan(doc: Doc, point: Point): boolean {
  if (point.kind !== 'intersection' && point.kind !== 'on-curve') return true;
  const hostIds = point.kind === 'intersection' ? point.entities : [point.host];
  const worldPos = resolvePoint(doc, point.id);
  const eps = epsilon(doc);
  for (const id of hostIds) {
    const e = doc.entities.find((x) => x.id === id);
    if (!e) continue;
    if (e.kind === 'circle') return true; // circles are always fully finite
    const proj = projectOntoEntity(doc, e, worldPos);
    if (proj.d <= eps && proj.param >= -PARAM_EPS && proj.param <= 1 + PARAM_EPS) return true;
  }
  return false;
}

/**
 * World-space bounds of "active visible geometry" (spec): every non-hidden point that lies
 * within some entity's own finite span (Phase 3.6 item 1: a point materialized only out along an
 * Extension line's infinite reach is excluded, so it can't pull the design off-centre or shrink
 * it), plus each circle's full centre±radius extent — the one shape whose meaningful bounds
 * aren't already implied by its points, and each line's own literal endpoints regardless of
 * `extended` (belt-and-braces alongside the point filter above, in case an extended line has no
 * materialized point anywhere near one of its own ends). Null for a doc with nothing beyond a
 * still-hidden frame internals (fitView falls back to the frame radius in that case).
 */
export function computeVisibleBounds(doc: Doc, turn = 0): Bounds | null {
  // With `turn`, the bounds as a camera turned by it sees them (in its frame — see turned()), so a
  // turned view is fitted to what it actually shows.
  let b: Bounds | null = null;
  for (const p of doc.points) {
    if (p.kind === 'free' && p.hidden) continue;
    if (!isPointWithinFiniteSpan(doc, p)) continue;
    const at = turned(resolvePoint(doc, p.id), turn);
    b = expand(b, at.x, at.y);
  }
  for (const e of doc.entities) {
    const g = resolveEntityGeom(doc, e);
    if (g.kind === 'circle') {
      const c = turned(g.centre, turn);
      b = expand(b, c.x - g.radius, c.y - g.radius);
      b = expand(b, c.x + g.radius, c.y + g.radius);
    } else {
      const a = turned(g.a, turn);
      const z = turned(g.b, turn);
      b = expand(b, a.x, a.y);
      b = expand(b, z.x, z.y);
    }
  }
  return b;
}

/** The bounds of a few discs (centre ± radius) as a camera turned by `turn` sees them. */
export function discBounds(discs: { x: number; y: number; r: number }[], turn = 0): Bounds | null {
  let b: Bounds | null = null;
  for (const d of discs) {
    const c = turned(d, turn);
    b = expand(b, c.x - d.r, c.y - d.r);
    b = expand(b, c.x + d.r, c.y + d.r);
  }
  return b;
}

/**
 * Phase 1.1: exactly what an export — and so a Timelapse frame — draws, as points (line ends, and
 * arcs sampled every 5°, within 0.1% of the radius) and whole circles (`discs`, kept exact so they
 * can be turned): every Fair piece, and with `construction` every Construction piece; never points
 * (exports draw none), trimmed pieces, or dashed Extension (whose tails run to the frame's edge
 * whatever it frames). World coordinates.
 *
 * Read straight from the recorded piece states, without splitting anything (a Timelapse asks this
 * of every moment): each state's key names the piece's two end points, so its interval along the
 * line (0..1 from A to B) or round the circle (angle) is known exactly. Drawn = the literal span
 * (or whole circle) less the trimmed and Extension intervals — plus any Fair piece out on an
 * extended line; Fair alone = the Fair intervals.
 */
export function drawnShapes(doc: Doc, construction: boolean): { points: { x: number; y: number }[]; discs: { x: number; y: number; r: number }[] } {
  const points: { x: number; y: number }[] = [];
  const discs: { x: number; y: number; r: number }[] = [];
  const STEP = Math.PI / 36;
  const TAU = Math.PI * 2;
  // Each entity's recorded pieces: [state, from point, to point].
  const recorded = new Map<string, { state: string; from: string; to: string }[]>();
  for (const [key, st] of doc.segmentStates) {
    const [id, from, to] = key.split(':');
    if (!id || !from || !to) continue;
    let list = recorded.get(id);
    if (!list) recorded.set(id, (list = []));
    list.push({ state: st.state, from, to });
  }
  const at = (id: string) => {
    try {
      return resolvePoint(doc, id);
    } catch {
      return null;
    }
  };
  for (const e of doc.entities) {
    const own = recorded.get(e.id) ?? [];
    if (own.length === 0 && !construction) continue;
    const g = resolveEntityGeom(doc, e);
    if (g.kind === 'line') {
      const dx = g.b.x - g.a.x;
      const dy = g.b.y - g.a.y;
      const len2 = dx * dx + dy * dy;
      if (!(len2 > 0)) continue;
      const param = (id: string) => {
        const p = at(id);
        return p ? ((p.x - g.a.x) * dx + (p.y - g.a.y) * dy) / len2 : null;
      };
      const intervals = (pick: (state: string) => boolean) => {
        const out: [number, number][] = [];
        for (const r of own) {
          if (!pick(r.state)) continue;
          const t0 = param(r.from);
          const t1 = param(r.to);
          if (t0 !== null && t1 !== null) out.push([Math.min(t0, t1), Math.max(t0, t1)]);
        }
        return out;
      };
      const fair = intervals((st) => st === 'fair');
      let lo = Infinity;
      let hi = -Infinity;
      for (const [t0, t1] of fair) {
        lo = Math.min(lo, t0);
        hi = Math.max(hi, t1);
      }
      if (construction) {
        // The literal span 0..1 less what is trimmed or Extension within it.
        const removed = intervals((st) => st === 'trimmed' || st === 'extension').sort((p, q) => p[0] - q[0]);
        let from = 0;
        for (const [t0, t1] of removed) if (t0 <= from + 1e-9) from = Math.max(from, t1);
        let to = 1;
        for (const [t0, t1] of [...removed].sort((p, q) => q[1] - p[1])) if (t1 >= to - 1e-9) to = Math.min(to, t0);
        if (from < to - 1e-9) {
          lo = Math.min(lo, from);
          hi = Math.max(hi, to);
        }
      }
      if (lo <= hi) points.push({ x: g.a.x + dx * lo, y: g.a.y + dy * lo }, { x: g.a.x + dx * hi, y: g.a.y + dy * hi });
      continue;
    }
    // A circle: angles increase from a piece's `from` to its `to` (as the renderers draw arcs).
    const angle = (id: string) => {
      const p = at(id);
      return p ? Math.atan2(p.y - g.centre.y, p.x - g.centre.x) : null;
    };
    const arcs = (pick: (state: string) => boolean) => {
      const out: [number, number][] = [];
      for (const r of own) {
        if (!pick(r.state)) continue;
        const a0 = angle(r.from);
        const a1 = angle(r.to);
        if (a0 === null || a1 === null) continue;
        let sweep = a1 - a0;
        while (sweep <= 0) sweep += TAU;
        out.push([a0, sweep]);
      }
      return out;
    };
    const sample = (a0: number, sweep: number) => {
      const n = Math.max(1, Math.ceil(sweep / STEP));
      for (let k = 0; k <= n; k++) {
        const a = a0 + (sweep * k) / n;
        points.push({ x: g.centre.x + g.radius * Math.cos(a), y: g.centre.y + g.radius * Math.sin(a) });
      }
    };
    if (!construction) {
      for (const [a0, sweep] of arcs((st) => st === 'fair')) sample(a0, sweep);
      continue;
    }
    const removed = arcs((st) => st === 'trimmed' || st === 'extension');
    if (removed.length === 0) {
      discs.push({ x: g.centre.x, y: g.centre.y, r: g.radius });
      continue;
    }
    // Every 5° (and each removed arc's ends) where the circle is drawn on at least one side — so the
    // point where two removed arcs meet is not counted.
    const covered = (a: number) =>
      removed.some(([a0, sweep]) => {
        let d = (a - a0) % TAU;
        if (d < 0) d += TAU;
        return d <= sweep;
      });
    const drawn = (a: number) => !covered(a - 1e-7) || !covered(a + 1e-7);
    const probes: number[] = [];
    for (let k = 0; k < 72; k++) probes.push((k * TAU) / 72);
    for (const [a0, sweep] of removed) probes.push(a0, a0 + sweep);
    for (const a of probes) if (drawn(a)) points.push({ x: g.centre.x + g.radius * Math.cos(a), y: g.centre.y + g.radius * Math.sin(a) });
  }
  return { points, discs };
}
