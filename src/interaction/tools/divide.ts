// Divide tool — Phase 2C (§4.5), reworked in Phase 5.2 items 21–23. A tap picks the segment
// under it; tapping that same target again escalates to its parent (the whole line, circle or
// arc); again clears it. Escalation follows what is CURRENTLY targeted, never tap timing, so it
// behaves identically on every device. The target and N live in `controller.divide`; the compact
// ribbon (shell.ts) owns − N + / slider / Apply. Divide only ever creates points.
//
// A whole circle's points start from its rightmost point (0°) and can be turned before Apply: drag
// any preview point and the whole set goes round with it, equally spaced as ever. Only the preview
// turns — the circle, the camera and the construction are untouched until Apply.

import type { Doc, Entity, Vec2 } from '../../model/types.ts';
import type { AppController, DivideTarget, ViewTransform } from '../../app/controller.ts';
import { screenToWorld, worldToScreen } from '../../app/controller.ts';
import { deriveSegments, deriveSelectableGroups, groupContainingParam, paramInRange } from '../../geometry/segments.ts';
import { circleDivisionPositions, segmentDivisionPositions, snapDivisionAngle, wholeAngle } from '../../geometry/divide.ts';
import { epsilon, resolveEntityGeom, resolvePoint, type CircleGeom } from '../../geometry/kernel.ts';
import { POINT_HIT_RADIUS, pickCurveHit } from '../hittest.ts';
import type { Gesture, ToolModule } from './types.ts';

/** The live (untrimmed) span of a circle when it is an Arc — one contiguous run of segments. */
function arcSpan(doc: Doc, entity: Entity): { from: string; to: string; fromParam: number; toParam: number } | null {
  const segs = deriveSegments(doc, entity);
  const live = segs.map((s) => (doc.segmentStates.get(s.key)?.state ?? 'construction') !== 'trimmed');
  if (live.every(Boolean) || !live.some(Boolean)) return null;
  const n = segs.length;
  const startIdx = live.findIndex((l, i) => l && !live[(i - 1 + n) % n]);
  let endIdx = startIdx;
  while (live[(endIdx + 1) % n] && (endIdx + 1) % n !== startIdx) endIdx = (endIdx + 1) % n;
  const first = segs[startIdx]!;
  const last = segs[endIdx]!;
  return { from: first.from, to: last.to, fromParam: first.fromParam, toParam: last.toParam };
}

function parentTarget(doc: Doc, entity: Entity): DivideTarget | null {
  if (entity.kind === 'line') {
    return { label: 'Line', scope: 'parent', entityId: entity.id, kind: 'segment', from: entity.a, to: entity.b, fromParam: 0, toParam: 1 };
  }
  const span = arcSpan(doc, entity);
  if (span) return { label: 'Arc', scope: 'parent', entityId: entity.id, kind: 'segment', ...span };
  const hasTrim = deriveSegments(doc, entity).some((s) => doc.segmentStates.get(s.key)?.state === 'trimmed');
  return hasTrim ? null : { label: 'Circle', scope: 'parent', entityId: entity.id, kind: 'circle-whole' };
}

function sameSpan(a: DivideTarget, b: DivideTarget): boolean {
  if (a.kind !== b.kind || a.entityId !== b.entityId) return false;
  return a.kind === 'segment' && b.kind === 'segment' ? a.from === b.from && a.to === b.to : true;
}

function resolveTap(doc: Doc, current: DivideTarget | null, entity: Entity, param: number): DivideTarget | null {
  const group = groupContainingParam(deriveSelectableGroups(doc, entity), param, entity.kind === 'circle');
  const segment: DivideTarget | null = group
    ? { label: 'Segment', scope: 'segment', entityId: entity.id, kind: 'segment', from: group.from, to: group.to, fromParam: group.fromParam, toParam: group.toParam }
    : null;
  const parent = parentTarget(doc, entity);

  if (current && current.entityId === entity.id) {
    if (current.scope === 'segment' && segment && sameSpan(current, segment)) {
      // The parent can be the very same span (a line with nothing crossing it): skip to "none".
      return parent && !sameSpan(parent, segment) ? parent : null;
    }
    if (current.scope === 'parent') {
      const inside = current.kind === 'circle-whole' || paramInRange(param, current.fromParam, current.toParam, entity.kind === 'circle');
      if (inside) return null;
    }
  }
  return segment ?? parent;
}

/** Where Apply would put points: `angle` is where a whole circle's first one goes (ignored for a span). */
export function dividePreviewPoints(doc: Doc, target: DivideTarget, n: number, angle: number): Vec2[] {
  const entity = doc.entities.find((e) => e.id === target.entityId);
  if (!entity) return [];
  if (target.kind === 'circle-whole') return circleDivisionPositions(doc, entity, n, angle);
  return segmentDivisionPositions(doc, entity, target, n);
}

export function setDivideTarget(controller: AppController, target: DivideTarget | null): void {
  controller.divideTurn = null;
  if (!target) {
    controller.divide = null;
    controller.dividePreview = null;
  } else {
    const n = controller.divide?.n ?? controller.doc.dividePrefs.lastN;
    // A newly chosen target always starts from the rightmost point, however the last one was turned.
    controller.divide = { target, n, angle: 0 };
    controller.dividePreview = { target, points: dividePreviewPoints(controller.doc, target, n, 0) };
  }
  controller.notify();
}

// ---- turning a whole circle's preview ----

/** A preview point within this of one of the circle's existing points (screen px, along the
 * circle) goes the rest of the way onto it, so the two are one point after Apply — never a pair a
 * hair apart. The rightmost point, where every division starts, can be found again the same way. */
const MEET_PX = 8;
/** Nearer the centre than this (screen px) the finger says nothing about direction. */
const DEAD_CENTRE_PX = 6;

/** The preview point under the finger, when the preview is a whole circle's. */
function previewPointAt(controller: AppController, view: ViewTransform, sp: Vec2): number | null {
  const preview = controller.dividePreview;
  if (!controller.divide || controller.divide.target.kind !== 'circle-whole' || !preview) return null;
  let best: { index: number; d: number } | null = null;
  preview.points.forEach((at, index) => {
    const s = worldToScreen(view, at);
    const d = Math.hypot(s.x - sp.x, s.y - sp.y);
    if (d <= POINT_HIT_RADIUS && (!best || d < best.d)) best = { index, d };
  });
  return (best as { index: number; d: number } | null)?.index ?? null;
}

/** The angles of everything already on the circle (plus 0, where every division starts). */
function meetingAngles(doc: Doc, g: CircleGeom): number[] {
  const eps = epsilon(doc);
  const angles = [0];
  for (const p of doc.points) {
    if (p.kind === 'free' && p.hidden) continue;
    const at = resolvePoint(doc, p.id);
    if (Math.abs(Math.hypot(at.x - g.centre.x, at.y - g.centre.y) - g.radius) < eps) angles.push(Math.atan2(at.y - g.centre.y, at.x - g.centre.x));
  }
  return angles;
}

/** One finger holding a preview point: the set turns by exactly as much as the finger has gone
 * round the centre since it landed. A tap that never becomes a drag changes nothing; neither does
 * a touch that is taken away (a second finger for the camera, or the system). */
function turnGesture(controller: AppController, view: ViewTransform, sp: Vec2, index: number): Gesture | null {
  const start = controller.divide!;
  const entity = controller.doc.entities.find((e) => e.id === start.target.entityId);
  if (!entity || entity.kind !== 'circle') return null;
  const g = resolveEntityGeom(controller.doc, entity) as CircleGeom;
  const fingerAngle = (p: Vec2): number | null => {
    const w = screenToWorld(view, p);
    const dx = w.x - g.centre.x;
    const dy = w.y - g.centre.y;
    return Math.hypot(dx, dy) * view.zoom < DEAD_CENTRE_PX ? null : Math.atan2(dy, dx);
  };
  const candidates = meetingAngles(controller.doc, g);
  let from = fingerAngle(sp);
  let turned = 0; // how far the finger has gone round since it landed (may pass ±180° any number of times)

  const show = (angle: number, met: Vec2[]): void => {
    const d = controller.divide;
    if (!d) return;
    controller.divide = { ...d, angle };
    controller.dividePreview = { target: d.target, points: dividePreviewPoints(controller.doc, d.target, d.n, angle) };
    controller.divideTurn = { index, met };
    controller.notifyView();
  };
  const putBack = (): void => {
    const d = controller.divide;
    controller.divideTurn = null;
    if (!d) return;
    controller.divide = { ...d, angle: start.angle };
    controller.dividePreview = { target: d.target, points: dividePreviewPoints(controller.doc, d.target, d.n, start.angle) };
    controller.notifyView();
  };

  controller.divideTurn = { index, met: [] };
  return {
    onMove(p) {
      const d = controller.divide;
      const now = fingerAngle(p);
      if (!d || now === null) return;
      if (from !== null) {
        const step = now - from;
        turned += Math.atan2(Math.sin(step), Math.cos(step)); // the short way round: no jump at 0°/360°
      }
      from = now;
      const reach = MEET_PX / Math.max(g.radius * view.zoom, 1e-9);
      const snapped = snapDivisionAngle(wholeAngle(start.angle + turned), d.n, candidates, reach);
      show(
        snapped.angle,
        snapped.met.map((a) => ({ x: g.centre.x + g.radius * Math.cos(a), y: g.centre.y + g.radius * Math.sin(a) })),
      );
    },
    onUp(_sp, wasDrag) {
      if (!wasDrag) putBack();
      controller.divideTurn = null;
      controller.notifyView();
    },
    onCancel: putBack,
  };
}

export const divideTool: ToolModule = {
  id: 'divide',
  hint() {
    return '';
  },
  beginGesture(controller, view, screenPos): Gesture {
    // A finger landing on a whole circle's preview point holds it — to turn the set, never to pick.
    const held = previewPointAt(controller, view, screenPos);
    const turn = held === null ? null : turnGesture(controller, view, screenPos, held);
    if (turn) return turn;
    return {
      onMove() {},
      onUp(sp, wasDrag) {
        if (wasDrag) return;
        const hit = pickCurveHit(controller.doc, view, sp);
        // Tapping outside anything cancels: the preview goes, nothing is created.
        setDivideTarget(controller, hit ? resolveTap(controller.doc, controller.divide?.target ?? null, hit.entity, hit.param) : null);
      },
      onCancel() {},
    };
  },
};
