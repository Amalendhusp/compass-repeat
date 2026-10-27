// Phase 1.1: one snap engine for Repeat's two lattice handles — contact with the neighbouring motif
// and exact relations between the two arms — built so the handle stays with the finger.
//
// - Direct manipulation: while free the handle is exactly under the finger (no magnetic pull).
// - Intentional capture: a target takes hold only when the finger is near it, heading towards it
//   (not merely passing it) and moving slowly — a deliberate approach slows down; a sweep does not —
//   and never on pick-up.
// - Easy release: always measured from the finger itself, a few px past where capture began, so the
//   handle is never far from the finger and lets go promptly.
// - Predictable choice: exact points (edges meet, tips touch, a regular lattice) come before lines
//   (touching anywhere, an angle, equal arms); while held, the only switch allowed is onto an exact
//   point lying on the held line, reached by sliding along it.
//
// Distances are in screen px, so it feels the same at every zoom.

import type { Vec2 } from '../model/types.ts';
import type { ContactModel } from './lattice.ts';

export type SnapKind = 'edges' | 'tips' | 'touch' | 'angle' | 'equal' | 'regular';

export interface SnapTarget {
  key: string;
  kind: SnapKind;
  /** 1: an exact point; 2: a line the arm can slide along. */
  tier: 1 | 2;
  label: string;
  /** Distance (artwork units) from the finger's arm to this target. */
  dist(raw: Vec2): number;
  /** Where the arm sits when held by this target. */
  at(raw: Vec2): Vec2;
  /** For feedback: the angle (degrees) to the other arm this target makes, if any. */
  angle?: number;
  /** For feedback: whether it makes the arms equal. */
  equal?: boolean;
}

/** Exact points take hold within this (px) and let go past this. */
export const POINT_ENTER_PX = 10;
export const POINT_RELEASE_PX = 16;
/** Lines are narrower, so passing near one is rarely caught. */
export const LINE_ENTER_PX = 7;
export const LINE_RELEASE_PX = 12;
/** Capture needs the finger slower than this (px per ms, smoothed): about 250 px/s. */
export const CAPTURE_SPEED = 0.25;
/** Speed smoothing time constant (ms). */
const SPEED_TAU_MS = 40;
/** "Moving towards": at least this share of the finger's last step must have closed the distance
 * (1 = straight at it; moving away, or a pass that only grazes it, does not count). An exact point
 * needs the finger heading at it; a line only needs it crossing towards it. */
const APPROACH_SHARE_POINT = 0.8;
const APPROACH_SHARE_LINE = 0.4;

const ANGLES = [90, 60, 120] as const;

const turn = (v: Vec2, deg: number): Vec2 => {
  const a = (deg * Math.PI) / 180;
  return { x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) };
};
const hyp = (v: Vec2) => Math.hypot(v.x, v.y);
const sub = (p: Vec2, q: Vec2) => ({ x: p.x - q.x, y: p.y - q.y });

function pointTarget(key: string, kind: SnapKind, label: string, p: Vec2, extra: Partial<SnapTarget> = {}): SnapTarget {
  return { key, kind, tier: 1, label, dist: (raw) => hyp(sub(raw, p)), at: () => ({ ...p }), ...extra };
}

/** Every target for dragging one arm: contact with the neighbour (`model`) and relations with the
 * `other` arm. Prepared once when the drag begins. */
export function handleTargets(model: ContactModel, other: Vec2): SnapTarget[] {
  const out: SnapTarget[] = [];
  model.detents.forEach((d, i) => {
    out.push(pointTarget(`detent:${i}`, d.state === 'edges-meet' ? 'edges' : 'tips', d.state === 'edges-meet' ? 'Edges meet' : 'Tips touch', d.translate));
  });
  // Touching anywhere: along the finger's own direction, where the neighbour stops overlapping.
  const contactAt = (raw: Vec2): Vec2 => {
    const len = hyp(raw);
    if (!(len > 1e-9)) return { ...raw };
    const u = { x: raw.x / len, y: raw.y / len };
    const c = model.contactDistance(u);
    return { x: u.x * c, y: u.y * c };
  };
  out.push({ key: 'touch', kind: 'touch', tier: 2, label: 'Touching', dist: (raw) => hyp(sub(raw, contactAt(raw))), at: contactAt });

  const len = hyp(other);
  if (len > 1e-9) {
    const unit = { x: other.x / len, y: other.y / len };
    for (const deg of ANGLES) {
      for (const side of [1, -1]) {
        const u = turn(unit, side * deg);
        const along = (raw: Vec2) => raw.x * u.x + raw.y * u.y;
        out.push({
          key: `angle:${deg}:${side}`,
          kind: 'angle',
          tier: 2,
          label: `${deg}°`,
          angle: deg,
          dist: (raw) => (along(raw) > 0 ? Math.abs(raw.x * u.y - raw.y * u.x) : Infinity),
          at: (raw) => ({ x: u.x * along(raw), y: u.y * along(raw) }),
        });
        out.push(pointTarget(`regular:${deg}:${side}`, 'regular', deg === 90 ? 'Square lattice' : '60° lattice', { x: u.x * len, y: u.y * len }, { angle: deg, equal: true }));
      }
    }
    const onCircle = (raw: Vec2): Vec2 => {
      const r = hyp(raw);
      return r > 1e-9 ? { x: (raw.x / r) * len, y: (raw.y / r) * len } : { x: unit.x * len, y: unit.y * len };
    };
    out.push({ key: 'equal', kind: 'equal', tier: 2, label: 'Equal arms', equal: true, dist: (raw) => hyp(sub(raw, onCircle(raw))), at: onCircle });
  }
  return out;
}

export interface SnapState {
  held: SnapTarget | null;
  /** The line a held point was reached along — what holds the arm again once the point lets go. */
  via: SnapTarget | null;
  /** Each target's distance (px) at the previous sample — to tell approaching from leaving. */
  prevPx: Map<string, number>;
  speed: number;
  lastRaw: Vec2;
  lastT: number;
}

/** The state at the press: nothing held, even if the arm already sits exactly on a target — so a
 * handle picked up from a snapped place comes away with the finger at once. */
export function startSnap(raw: Vec2, now: number): SnapState {
  return { held: null, via: null, prevPx: new Map(), speed: 0, lastRaw: { ...raw }, lastT: now };
}

const enterPx = (t: SnapTarget) => (t.tier === 1 ? POINT_ENTER_PX : LINE_ENTER_PX);
const releasePx = (t: SnapTarget) => (t.tier === 1 ? POINT_RELEASE_PX : LINE_RELEASE_PX);

/** A point target lies on the held line (so sliding along the line reaches it). */
function liesOn(point: SnapTarget, line: SnapTarget, zoom: number): boolean {
  return line.tier === 2 && point.tier === 1 && line.dist(point.at({ x: 0, y: 0 })) * zoom < 0.5;
}

export interface SnapStep {
  held: SnapTarget | null;
  /** Where the arm is drawn: the target's position when held, else exactly the finger's arm. */
  shown: Vec2;
  /** Set on the sample a target first takes hold (for feedback). */
  captured: SnapTarget | null;
}

/** One drag sample. `raw` is the arm exactly under the finger (artwork units). */
export function stepHandleSnap(targets: SnapTarget[], state: SnapState, raw: Vec2, zoom: number, now: number): SnapStep {
  // Finger speed (screen px per ms), smoothed so one jittery sample decides nothing.
  const dt = Math.max(1, now - state.lastT);
  const movePx = hyp(sub(raw, state.lastRaw)) * zoom;
  const v = movePx / dt;
  state.speed += (v - state.speed) * (1 - Math.exp(-dt / SPEED_TAU_MS));
  state.lastRaw = { ...raw };
  state.lastT = now;

  const px = new Map<string, number>();
  for (const t of targets) px.set(t.key, t.dist(raw) * zoom);
  const approaching = (t: SnapTarget) => {
    const before = state.prevPx.get(t.key);
    return before !== undefined && movePx > 1e-3 && (before - px.get(t.key)!) / movePx >= (t.tier === 1 ? APPROACH_SHARE_POINT : APPROACH_SHARE_LINE);
  };
  const deliberate = state.speed <= CAPTURE_SPEED;
  const candidates = (pool: SnapTarget[]) =>
    pool
      .filter((t) => px.get(t.key)! <= enterPx(t) && approaching(t) && deliberate)
      // exact points first; then nearest; then the order targets were made (contact before relations)
      .sort((p, q) => p.tier - q.tier || px.get(p.key)! - px.get(q.key)!);

  let held = state.held;
  let via = state.via;
  let captured: SnapTarget | null = null;
  // Release: from the finger itself. A point reached along a line hands back to that line (sliding
  // on along a 90° line through the square lattice stays at 90°).
  if (held && px.get(held.key)! > releasePx(held)) {
    held = via && px.get(via.key)! <= releasePx(via) ? via : null;
    via = null;
  }
  if (held) {
    // Sliding along a held line onto an exact point on it is the one switch allowed.
    if (held.tier === 2) {
      const line = held;
      const next = candidates(targets.filter((t) => liesOn(t, line, zoom)))[0];
      if (next) {
        via = line;
        held = captured = next;
      }
    }
  } else {
    via = null;
    const next = candidates(targets)[0];
    if (next) held = captured = next;
  }

  state.held = held;
  state.via = via;
  state.prevPx = px;
  return { held, shown: held ? held.at(raw) : { ...raw }, captured };
}

/** Labels of every target sitting exactly where `t` holds the arm (e.g. "Edges meet · Square
 * lattice" when an edge contact is also a regular lattice). */
export function coincidentLabels(targets: SnapTarget[], held: SnapTarget, at: Vec2, zoom: number): string[] {
  const labels = [held.label];
  for (const t of targets) {
    if (t === held || labels.includes(t.label) || t.tier !== 1) continue;
    if (t.dist(at) * zoom < 0.5) labels.push(t.label);
  }
  return labels;
}
