// Divide tool, Phase 2C (§4.5): tap a line/arc segment to divide it between its own endpoints,
// or tap a whole untouched closed circle to divide it all the way round. The actual N-picker is
// a DOM sheet, not a canvas gesture, so a hit here just hands the target to the shell via
// controller.pendingDivide (same cross-layer pattern as extendChip) rather than doing anything
// itself — the shell watches for it and opens the sheet.
//
// Phase 3.5 item 2: selection level decides scope, mirroring Select's own tap-then-double-tap
// escalation (§Phase 2.3) — a single tap on an arc divides just that arc; a second tap on the
// SAME arc within the double-tap window escalates to the whole circle, dividing the entire
// circumference into N parts regardless of how many arcs crossing geometry already split it
// into. Previously the tool could only ever reach "whole circle" for a circle with zero derived
// segments (nothing had crossed it yet) — this is what "do not force the user to find an
// unsegmented piece of the circle" actually needed fixed.

import type { Doc, Vec2 } from '../../model/types.ts';
import type { DivideTarget, ViewTransform } from '../../app/controller.ts';
import { deriveSegments } from '../../geometry/segments.ts';
import { dist } from '../../geometry/vec.ts';
import { pickSelectCandidates } from '../hittest.ts';
import type { Gesture, ToolModule } from './types.ts';

const DOUBLE_TAP_TIME_MS = 350; // matches select.ts's segment→parent escalation window
const DOUBLE_TAP_DIST = 10; // pt

let lastSegmentTap: { entityId: string; from: string; to: string; screen: Vec2; time: number } | null = null;

function pickDivideTarget(doc: Doc, view: ViewTransform, screenPos: Vec2): DivideTarget | null {
  const candidates = pickSelectCandidates(doc, view, screenPos);
  for (const c of candidates) {
    if (c.kind === 'segment') return { entityId: c.entityId, kind: 'segment', from: c.from, to: c.to, fromParam: c.fromParam, toParam: c.toParam };
    if (c.kind === 'entity') {
      const e = doc.entities.find((x) => x.id === c.entityId);
      // A line always has at least one derived segment (its own endpoints, §Phase 2B) so an
      // 'entity' candidate here is only ever reached for an as-yet-undivided closed circle — an
      // already-divided circle is only reachable as 'circle-whole' via the double-tap escalation
      // below, same as Select's own segment→parent escalation.
      if (e && e.kind === 'circle' && deriveSegments(doc, e).length === 0) return { entityId: e.id, kind: 'circle-whole' };
    }
  }
  return null;
}

export const divideTool: ToolModule = {
  id: 'divide',
  hint() {
    return 'Tap a circle, arc or line segment to divide — tap the same arc twice for the whole circle';
  },
  beginGesture(controller, view, screenPos): Gesture | null {
    const target = pickDivideTarget(controller.doc, view, screenPos);
    if (!target) {
      lastSegmentTap = null;
      return null;
    }
    return {
      onMove() {
        // No live preview — the sheet itself is the feedback, opened on release.
      },
      onUp(sp, wasDrag) {
        if (wasDrag) return;
        let resolved = pickDivideTarget(controller.doc, view, sp) ?? target;

        if (resolved.kind === 'segment') {
          const entity = controller.doc.entities.find((e) => e.id === resolved.entityId);
          const isSameArcAsLastTap =
            entity?.kind === 'circle' &&
            lastSegmentTap &&
            lastSegmentTap.entityId === resolved.entityId &&
            lastSegmentTap.from === resolved.from &&
            lastSegmentTap.to === resolved.to &&
            dist(sp, lastSegmentTap.screen) <= DOUBLE_TAP_DIST &&
            Date.now() - lastSegmentTap.time <= DOUBLE_TAP_TIME_MS;
          if (isSameArcAsLastTap) {
            resolved = { entityId: resolved.entityId, kind: 'circle-whole' };
            lastSegmentTap = null;
          } else {
            lastSegmentTap = { entityId: resolved.entityId, from: resolved.from, to: resolved.to, screen: sp, time: Date.now() };
          }
        } else {
          lastSegmentTap = null;
        }

        controller.pendingDivide = resolved;
        controller.notify();
      },
      onCancel() {
        // A second finger arriving cancels the tap-in-progress; nothing was armed yet.
      },
    };
  },
};
