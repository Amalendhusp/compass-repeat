// Line tool, spec §4.3, Point Lock per Phase 1.2a. Both endpoints must be point targets —
// unlike Circle's radius, Line has no free-point fallback, so an empty-space release cancels
// the pending step (§1.3) rather than planting a point.
//
// Phase 3.1 item 3: Fair's "Line" sub-mode wants this exact A→B gesture (same Point Lock rules,
// same anchor-survives-pinch/pan behaviour, same node inset) but landing as a Fair segment
// instead of a plain construction line — so the gesture itself is factored out as
// beginLineLikeGesture, parameterised by what "landing" on a committed pair of points means.

import type { Doc, Entity, EntityId, PointId, Vec2 } from '../../model/types.ts';
import { addLineEntity, invalidateGeometryCaches } from '../../model/doc.ts';
import type { AppController, ViewTransform } from '../../app/controller.ts';
import { screenToWorld } from '../../app/controller.ts';
import { epsilon, resolveEntityGeom, resolvePoint } from '../../geometry/kernel.ts';
import { defaultSegmentKind, deriveSegments, effectiveSegmentKind } from '../../geometry/segments.ts';
import { isNearAnyCurve, pickPointTarget } from '../hittest.ts';
import { buildNodeInset } from '../nodeinset.ts';
import { materializeRef, refFromHit, refLocation, type PointRef } from '../pointref.ts';
import { showToast } from '../../ui/toast.ts';
import type { Gesture, ToolModule } from './types.ts';

function sameExisting(a: PointRef, b: PointRef): boolean {
  return a.kind === 'existing' && b.kind === 'existing' && a.id === b.id;
}

/** The shared A→B point-to-point gesture. `land` runs inside the commit and decides what the
 * new pair of points becomes (a plain line, or — Fair's Line sub-mode — a line pre-fired as a
 * Fair segment); returning null means "nothing was created" (e.g. A and B coincided). `onLanded`
 * runs after the commit with whatever `land` returned, for tool-specific post-commit UI. */
export function beginLineLikeGesture(
  controller: AppController,
  view: ViewTransform,
  screenPos: { x: number; y: number },
  land: (d: Doc, aId: PointId, bId: PointId) => EntityId | null,
  onLanded?: (newId: EntityId | null) => void,
  /** Phase 5.6: a chance to resolve A→B some other way (a role on an existing supporting line);
   * true means it was handled — committed, or refused with its own message. */
  intercept?: (aRef: PointRef, bRef: PointRef) => boolean,
): Gesture | null {
  const doc = controller.doc;
  let aRef: PointRef;
  // See circle.ts: only gates onUp's tap-vs-plant distinction, never onCancel.
  let justSetA = false;

  if (controller.pending?.kind === 'line') {
    aRef = controller.pending.a;
  } else {
    const hit = pickPointTarget(doc, view, screenPos);
    if (!hit) return null;
    aRef = refFromHit(hit);
    controller.pending = { kind: 'line', a: aRef };
    justSetA = true;
  }

  const aAt = refLocation(doc, aRef);
  controller.preview = { kind: 'line', a: aAt, b: aAt };
  controller.notify();

  const finish = (bRef: PointRef) => {
    if (!sameExisting(aRef, bRef) && intercept?.(aRef, bRef)) {
      controller.pending = null;
      controller.preview = null;
      controller.nodeInset = null;
      controller.pointLockHint = false;
      controller.notify();
      return;
    }
    // Phase 5.5: the exact same line again is never useful — and a doubled edge used to merge the
    // regions on either side of it. Nothing is created (and no undo step).
    if (aRef.kind === 'existing' && bRef.kind === 'existing' && doc.entities.some((e) => e.kind === 'line' && ((e.a === aRef.id && e.b === bRef.id) || (e.a === bRef.id && e.b === aRef.id)))) {
      showToast('Already drawn');
      controller.cancelPending();
      controller.nodeInset = null;
      return;
    }
    if (sameExisting(aRef, bRef)) {
      controller.pending = null;
      controller.preview = null;
      controller.nodeInset = null;
      controller.notify();
      return;
    }
    let newId: EntityId | null = null;
    controller.commit((d) => {
      const aId = materializeRef(d, aRef);
      const bId = materializeRef(d, bRef);
      if (aId !== bId) newId = land(d, aId, bId);
    });
    controller.pending = null;
    controller.preview = null;
    controller.nodeInset = null;
    controller.pointLockHint = false;
    onLanded?.(newId);
    controller.notify();
  };

  return {
    onMove(sp) {
      const hit = pickPointTarget(doc, view, sp);
      const b = hit ? hit.at : screenToWorld(view, sp);
      controller.preview = { kind: 'line', a: aAt, b };
      controller.nodeInset = hit ? buildNodeInset(doc, view, sp, hit.at) : null;
      const lockedOut = !doc.pointTargets.free && !hit && isNearAnyCurve(doc, view, sp);
      const transitioned = lockedOut !== controller.pointLockHint;
      controller.pointLockHint = lockedOut;
      // Rendering-only, except when the lock hint itself changed — see circle.ts's onMove.
      if (transitioned) controller.notify();
      else controller.notifyView();
    },
    onUp(sp, wasDrag) {
      if (!wasDrag && justSetA) {
        controller.preview = null;
        controller.nodeInset = null;
        controller.notify();
        return;
      }
      const hit = pickPointTarget(doc, view, sp);
      if (hit) {
        finish(refFromHit(hit));
        return;
      }
      if (!doc.pointTargets.free && isNearAnyCurve(doc, view, sp)) {
        // Point Lock: touched a curve with no explicit point there — stay armed for a fresh
        // attempt at B rather than cancelling A (§Phase 1.2a acceptance: A survives).
        controller.preview = { kind: 'line', a: aAt, b: aAt };
        controller.nodeInset = null;
        controller.pointLockHint = true;
        controller.notify();
        return;
      }
      // No free-point fallback for Line; empty release/miss cancels the pending step.
      controller.cancelPending();
    },
    onCancel() {
      // Phase 3.2 item 4: a second finger (pinch/pan) now cancels the pending anchor outright —
      // the earlier Phase 1.1 item 3 behaviour (preserve A across a view gesture) is no longer
      // wanted now that the node inset exists to disambiguate a finger-occluded target, so a
      // pinch/pan is free to mean "start over" instead. The tool itself stays active; the next
      // tap after the view gesture is a fresh point A. No geometry is created or committed here.
      controller.cancelPending();
    },
  };
}

// ---- Phase 5.6 items 32–36: Construction and Extension share one supporting line ----

type LineEntity = Extract<Entity, { kind: 'line' }>;

/** Where `p` sits along `line`'s supporting line (a = 0, b = 1) and how far off it is. */
function alongLine(doc: Doc, line: LineEntity, p: Vec2): { t: number; off: number } {
  const g = resolveEntityGeom(doc, line);
  if (g.kind !== 'line') return { t: 0, off: Infinity };
  const dx = g.b.x - g.a.x;
  const dy = g.b.y - g.a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return { t: 0, off: Infinity };
  return { t: ((p.x - g.a.x) * dx + (p.y - g.a.y) * dy) / len2, off: Math.abs((p.x - g.a.x) * g.dir.y - (p.y - g.a.y) * g.dir.x) };
}

/** Existing lines whose supporting line passes through both A and B. */
function supportingLines(doc: Doc, pa: Vec2, pb: Vec2): { line: LineEntity; ta: number; tb: number }[] {
  const tol = epsilon(doc) * 100;
  const out: { line: LineEntity; ta: number; tb: number }[] = [];
  for (const e of doc.entities) {
    if (e.kind !== 'line') continue;
    const A = alongLine(doc, e, pa);
    const B = alongLine(doc, e, pb);
    if (A.off < tol && B.off < tol) out.push({ line: e, ta: A.t, tb: B.t });
  }
  return out;
}

const covers = (line: LineEntity, t: number) => line.extended || (t >= -1e-6 && t <= 1 + 1e-6);

/** True when every piece of `line` between params lo..hi already exists as Construction or Fair —
 * drawing Construction there again would only double an edge. */
function spanAlreadyDrawn(doc: Doc, line: LineEntity, lo: number, hi: number): boolean {
  const pieces = deriveSegments(doc, line).filter((s) => s.toParam > lo + 1e-9 && s.fromParam < hi - 1e-9);
  if (pieces.length === 0) return false;
  if (Math.min(...pieces.map((s) => s.fromParam)) > lo + 1e-6 || Math.max(...pieces.map((s) => s.toParam)) < hi - 1e-6) return false;
  return pieces.every((s) => {
    const k = effectiveSegmentKind(doc, line, s);
    return k === 'construction' || k === 'fair';
  });
}

/**
 * Drawing along a line that already exists never adds a second, coincident line:
 * - Extension through it: that line gains its Extension role (dashed beyond its own span), unless
 *   it already has it — then it's a true duplicate.
 * - Construction between two points on it: those pieces become Construction (restoring any that
 *   were trimmed), unless they already are — then it's a true duplicate.
 * Anything else (e.g. a Construction span running past a finite line's end) is an ordinary new line.
 */
function resolveOnSupportingLine(controller: AppController, aRef: PointRef, bRef: PointRef): boolean {
  const doc = controller.doc;
  const pa = refLocation(doc, aRef);
  const pb = refLocation(doc, bRef);
  const lines = supportingLines(doc, pa, pb);
  if (lines.length === 0) return false;

  if (controller.lineMode === 'extension') {
    if (lines.some((l) => l.line.extended)) {
      showToast('Already drawn');
      return true;
    }
    const lineId = lines[0]!.line.id;
    controller.commit((d) => {
      materializeRef(d, aRef);
      materializeRef(d, bRef);
      const line = d.entities.find((e) => e.id === lineId);
      if (line?.kind === 'line') line.extended = true;
      invalidateGeometryCaches(d);
    });
    return true;
  }

  const host = lines.find((l) => covers(l.line, l.ta) && covers(l.line, l.tb));
  if (!host) return false;
  if (spanAlreadyDrawn(doc, host.line, Math.min(host.ta, host.tb), Math.max(host.ta, host.tb))) {
    showToast('Already drawn');
    return true;
  }
  const lineId = host.line.id;
  controller.commit((d) => {
    const aId = materializeRef(d, aRef);
    const bId = materializeRef(d, bRef);
    const line = d.entities.find((e) => e.id === lineId);
    if (line?.kind !== 'line') return;
    const ta = alongLine(d, line, resolvePoint(d, aId)).t;
    const tb = alongLine(d, line, resolvePoint(d, bId)).t;
    const lo = Math.min(ta, tb);
    const hi = Math.max(ta, tb);
    for (const s of deriveSegments(d, line)) {
      const mid = (s.fromParam + s.toParam) / 2;
      if (mid <= lo || mid >= hi) continue;
      const kind = effectiveSegmentKind(d, line, s);
      if (kind === 'construction' || kind === 'fair') continue;
      if (defaultSegmentKind(line, s) === 'construction') d.segmentStates.delete(s.key);
      else d.segmentStates.set(s.key, { state: 'construction' });
    }
  });
  return true;
}

export const lineTool: ToolModule = {
  id: 'line',
  hint(controller) {
    if (controller.pending?.kind === 'line') {
      return controller.pointLockHint ? 'Point Targets · choose an existing point' : 'Tap or drag to the second point';
    }
    return 'Tap a point or a curve';
  },
  beginGesture(controller, view, screenPos): Gesture | null {
    return beginLineLikeGesture(
      controller,
      view,
      screenPos,
      // Phase 3.4 item 2: Line only ever creates Construction or Extension geometry, chosen by
      // the context bar's mode toggle before the gesture starts — never Fair (that's Fair's own
      // promotion job, item 1). An Extension line commits already `extended` (drives the existing
      // dashed-tail rendering) AND with every one of its derived segments explicitly marked
      // `state: 'extension'` (dashed/subdued for the between-points span too, not just the
      // tails) — future splits inherit this automatically via segmentstate.ts's existing,
      // state-agnostic migration, the same mechanism Fair state has always relied on.
      (d, aId, bId) => {
        const entity = addLineEntity(d, aId, bId);
        if (controller.lineMode === 'extension' && entity.kind === 'line') {
          entity.extended = true;
          for (const seg of deriveSegments(d, entity)) d.segmentStates.set(seg.key, { state: 'extension' });
        }
        return entity.id;
      },
      (newId) => {
        if (!newId) return;
        const entity = controller.doc.entities.find((e) => e.id === newId);
        if (entity?.kind === 'line' && !entity.extended) {
          controller.setExtendChip(newId);
          setTimeout(() => {
            if (controller.extendChip?.entityId === newId) controller.setExtendChip(null);
          }, 4000);
        }
        // Phase 3.4 item 3: offered for either mode — an Extension line "may later be promoted
        // where appropriate" just as much as a Construction one.
        controller.setFairPromoteChip(newId);
        setTimeout(() => {
          if (controller.fairPromoteChip?.entityId === newId) controller.setFairPromoteChip(null);
        }, 4000);
      },
      (aRef, bRef) => resolveOnSupportingLine(controller, aRef, bRef),
    );
  },
};
