// Divide tool — Phase 2C (§4.5), reworked in Phase 5.2 items 21–23. A tap picks the segment
// under it; tapping that same target again escalates to its parent (the whole line, circle or
// arc); again clears it. Escalation follows what is CURRENTLY targeted, never tap timing, so it
// behaves identically on every device. The target and N live in `controller.divide`; the compact
// ribbon (shell.ts) owns − N + / slider / Apply. Divide only ever creates points.

import type { Doc, Entity, Vec2 } from '../../model/types.ts';
import type { AppController, DivideTarget } from '../../app/controller.ts';
import { deriveSegments, deriveSelectableGroups, groupContainingParam, paramInRange } from '../../geometry/segments.ts';
import { circleDivisionPositions, segmentDivisionPositions } from '../../geometry/divide.ts';
import { pickCurveHit } from '../hittest.ts';
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

export function dividePreviewPoints(doc: Doc, target: DivideTarget, n: number): Vec2[] {
  const entity = doc.entities.find((e) => e.id === target.entityId);
  if (!entity) return [];
  if (target.kind === 'circle-whole') return circleDivisionPositions(doc, entity, n, doc.frame.rotation);
  return segmentDivisionPositions(doc, entity, target, n);
}

export function setDivideTarget(controller: AppController, target: DivideTarget | null): void {
  if (!target) {
    controller.divide = null;
    controller.dividePreview = null;
  } else {
    const n = controller.divide?.n ?? controller.doc.dividePrefs.lastN;
    controller.divide = { target, n };
    controller.dividePreview = { target, points: dividePreviewPoints(controller.doc, target, n) };
  }
  controller.notify();
}

export const divideTool: ToolModule = {
  id: 'divide',
  hint() {
    return '';
  },
  beginGesture(controller, view): Gesture {
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
