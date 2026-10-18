// Line tool, spec §4.3, Point Lock per Phase 1.2a.
//
// Three ways of giving the line (controller.lineGuide): Connect ('free' — A → B, as ever) and two exact
// constructions from a reference line and one point: Parallel (the line through the point parallel
// to the reference) and Perpendicular (the line through the point at 90° to it — a perpendicular
// THROUGH A POINT, not a perpendicular bisector). Both land exactly as Line does, as Construction
// or as an Extension line (controller.lineMode). See beginGuidedGesture.
// Both endpoints must be point targets —
// unlike Circle's radius, Line has no free-point fallback, so an empty-space release cancels
// the pending step (§1.3) rather than planting a point.
//
// Phase 3.1 item 3: Fair's "Line" sub-mode wants this exact A→B gesture (same Point Lock rules,
// same anchor-survives-pinch/pan behaviour, same node inset) but landing as a Fair segment
// instead of a plain construction line — so the gesture itself is factored out as
// beginLineLikeGesture, parameterised by what "landing" on a committed pair of points means.

import type { Doc, Entity, EntityId, PointId, Vec2 } from '../../model/types.ts';
import { addLineEntity, invalidateGeometryCaches } from '../../model/doc.ts';
import { genId } from '../../model/id.ts';
import type { AppController, ViewTransform } from '../../app/controller.ts';
import { screenToWorld } from '../../app/controller.ts';
import { epsilon, resolveEntityGeom, resolvePoint } from '../../geometry/kernel.ts';
import { defaultSegmentKind, deriveSegments, effectiveSegmentKind } from '../../geometry/segments.ts';
import { curveCandidatesAt, isNearAnyCurve, pickPointTarget } from '../hittest.ts';
import { contextLinesAt, contextNear, contextPointAt } from '../context.ts';
import { buildNodeInset } from '../nodeinset.ts';
import { confirmSnap, noPointGesture, PointHold, resolveTap, showNoPoint, SnapTracker } from '../snap.ts';
import { materializeRef, refFromHit, refLocation, type PointRef } from '../pointref.ts';
import { showToast } from '../../ui/toast.ts';
import type { NoPointHint } from '../../app/controller.ts';
import type { Gesture, ToolModule } from './types.ts';

function sameExisting(a: PointRef, b: PointRef): boolean {
  return a.kind === 'existing' && b.kind === 'existing' && a.id === b.id;
}

/** Line takes only existing points: on a bare curve it says so plainly — never offering to Divide
 * (Divide is its own tool) and never making a point. */
function tapAPoint(info: Omit<NoPointHint, 'until'>): Omit<NoPointHint, 'until'> {
  return { ...info, divide: null, midAt: null, text: 'Tap an existing point' };
}

const LINE_FLASH_MS = 1600;

/** Nothing was made because the line is already there: say so, and briefly mark that line. */
function lineExists(controller: AppController, entityId: EntityId | undefined): void {
  showToast('This line already exists');
  controller.snapConfirm = null; // no point label (not even A's, still showing): no line was made
  if (!entityId) return;
  const record = { entityId, until: performance.now() + LINE_FLASH_MS };
  controller.lineFlash = record;
  controller.notifyView();
  setTimeout(() => {
    if (controller.lineFlash === record) {
      controller.lineFlash = null;
      controller.notifyView();
    }
  }, LINE_FLASH_MS + 20);
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
  /** Phase 5.6: a chance to resolve A→B some other way (a role on an existing supporting line):
   * 'made' or 'refused' (with its own message) when it handled it, null when it didn't. */
  intercept?: (aRef: PointRef, bRef: PointRef) => 'made' | 'refused' | null,
): Gesture | null {
  const doc = controller.doc;
  const tracker = new SnapTracker(doc);
  let aRef: PointRef;
  // See circle.ts: only gates onUp's tap-vs-plant distinction, never onCancel.
  let justSetA = false;
  let aHit: ReturnType<SnapTracker['pick']> = null;

  if (controller.pending?.kind === 'line') {
    aRef = controller.pending.a;
  } else {
    const hit = tracker.pick(view, screenPos);
    if (!hit) return tracker.noPoint ? noPointGesture(controller, tapAPoint(tracker.noPoint)) : null;
    aHit = hit;
    aRef = refFromHit(hit);
    controller.pending = { kind: 'line', a: aRef };
    justSetA = true;
  }

  let aAt = refLocation(doc, aRef);
  controller.preview = { kind: 'line', a: aAt, b: aAt };
  controller.notify();
  // Phase 5.9: holding still on a crowded spot opens the precision loupe (for A or for B).
  if (!justSetA) tracker.pick(view, screenPos);
  const hold = new PointHold(controller, view, tracker, screenPos);

  /** Lands the line on B. False when nothing was made (so B isn't announced as used). */
  const finish = (bRef: PointRef): boolean => {
    const handled = sameExisting(aRef, bRef) ? null : (intercept?.(aRef, bRef) ?? null);
    if (handled) {
      controller.pending = null;
      controller.preview = null;
      controller.nodeInset = null;
      controller.pointLockHint = false;
      controller.notify();
      return handled === 'made';
    }
    // Phase 5.5: the exact same line again is never useful — and a doubled edge used to merge the
    // regions on either side of it. Nothing is created (and no undo step).
    const a0 = aRef;
    const same = a0.kind === 'existing' && bRef.kind === 'existing' ? doc.entities.find((e) => e.kind === 'line' && ((e.a === a0.id && e.b === bRef.id) || (e.a === bRef.id && e.b === a0.id))) : undefined;
    if (same) {
      lineExists(controller, same.id);
      controller.cancelPending();
      controller.nodeInset = null;
      return false;
    }
    if (sameExisting(aRef, bRef)) {
      controller.pending = null;
      controller.preview = null;
      controller.nodeInset = null;
      controller.notify();
      return false;
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
    return true;
  };

  return {
    onMove(sp) {
      const held = hold.move(sp);
      if (held !== undefined) {
        if (justSetA) {
          aRef = refFromHit(held);
          aAt = held.at;
          controller.pending = { kind: 'line', a: aRef };
          controller.preview = null;
        } else controller.preview = { kind: 'line', a: aAt, b: held.at };
        controller.notifyView();
        return;
      }
      if (hold.open) return;
      const hit = tracker.pick(view, sp);
      const b = hit ? hit.at : screenToWorld(view, sp);
      controller.preview = { kind: 'line', a: aAt, b };
      controller.nodeInset = hit ? buildNodeInset(doc, view, sp, hit.at, tracker) : null;
      const lockedOut = !doc.pointTargets.free && !hit && isNearAnyCurve(doc, view, sp);
      const transitioned = lockedOut !== controller.pointLockHint;
      controller.pointLockHint = lockedOut;
      // Rendering-only, except when the lock hint itself changed — see circle.ts's onMove.
      if (transitioned) controller.notify();
      else controller.notifyView();
    },
    onUp(sp, wasDrag) {
      const held = hold.release();
      if (held) {
        // The loupe chose: A stays armed for B, or B completes the line.
        if (justSetA) {
          confirmSnap(controller, held);
          aRef = refFromHit(held);
          controller.pending = { kind: 'line', a: aRef };
          controller.preview = null;
          controller.nodeInset = null;
          controller.notify();
        } else if (finish(refFromHit(held))) confirmSnap(controller, held);
        return;
      }
      if (!wasDrag && justSetA) {
        controller.preview = null;
        controller.nodeInset = null;
        resolveTap(controller, tracker, aHit, (h) => {
          aRef = refFromHit(h);
          aAt = refLocation(doc, aRef);
          controller.pending = { kind: 'line', a: aRef };
        });
        controller.notify();
        return;
      }
      const hit = tracker.pick(view, sp);
      if (hit) {
        if (wasDrag) {
          if (finish(refFromHit(hit))) confirmSnap(controller, hit);
        } else {
          resolveTap(controller, tracker, hit, (h) => finish(refFromHit(h)));
        }
        return;
      }
      if (!doc.pointTargets.free && isNearAnyCurve(doc, view, sp)) {
        // Point Lock: touched a curve with no explicit point there — stay armed for a fresh
        // attempt at B rather than cancelling A (§Phase 1.2a acceptance: A survives).
        if (tracker.noPoint && !wasDrag) showNoPoint(controller, tapAPoint(tracker.noPoint));
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
      hold.cancel();
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
function resolveOnSupportingLine(controller: AppController, aRef: PointRef, bRef: PointRef): 'made' | 'refused' | null {
  const doc = controller.doc;
  const pa = refLocation(doc, aRef);
  const pb = refLocation(doc, bRef);
  const lines = supportingLines(doc, pa, pb);
  if (lines.length === 0) return null;

  if (controller.lineMode === 'extension') {
    const extended = lines.find((l) => l.line.extended);
    if (extended) {
      lineExists(controller, extended.line.id);
      return 'refused';
    }
    const lineId = lines[0]!.line.id;
    controller.commit((d) => {
      materializeRef(d, aRef);
      materializeRef(d, bRef);
      const line = d.entities.find((e) => e.id === lineId);
      if (line?.kind === 'line') line.extended = true;
      invalidateGeometryCaches(d);
    });
    return 'made';
  }

  const host = lines.find((l) => covers(l.line, l.ta) && covers(l.line, l.tb));
  if (!host) return null;
  if (spanAlreadyDrawn(doc, host.line, Math.min(host.ta, host.tb), Math.max(host.ta, host.tb))) {
    lineExists(controller, host.line.id);
    return 'refused';
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
  return 'made';
}

/** What a new line between two points becomes, as Line always lands it: Construction, or — in
 * Extension mode — an extended line whose every piece is Extension. (Phase 3.4 item 2: Line only
 * ever creates Construction or Extension geometry, chosen by the context bar's mode toggle before
 * the gesture starts — never Fair. An Extension line commits already `extended` AND with every one
 * of its derived segments explicitly marked `state: 'extension'`; future splits inherit this
 * automatically via segmentstate.ts's state-agnostic migration.) */
function landLine(controller: AppController, d: Doc, aId: PointId, bId: PointId): EntityId {
  const entity = addLineEntity(d, aId, bId);
  if (controller.lineMode === 'extension' && entity.kind === 'line') {
    entity.extended = true;
    for (const seg of deriveSegments(d, entity)) d.segmentStates.set(seg.key, { state: 'extension' });
  }
  return entity.id;
}

/** After a line lands: the brief Extend / Promote to Fair offers. */
function offerAfterLine(controller: AppController, newId: EntityId | null): void {
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
}

// ---- Parallel / Perpendicular: a reference line, then the point the new line goes through ----

const GUIDE_LINE_REACH_PX = 16;

/** Another line about as close as the nearest (within this much more, px, widening a little as
 * the tap lands further off) makes the reference ambiguous — unless it runs the same way, since
 * only the reference's direction is used. */
const REFERENCE_AMBIGUITY_PX = 4;
const SAME_DIRECTION_RAD = 1e-4;

/** The reference a tap gives: the straight line nearest the finger — the construction's own, or in
 * Intersect another instance's, on equal terms (its two ends, in the construction's coordinates);
 * 'ambiguous' where lines running different ways are about as close (at a point where lines meet,
 * say — a reference is chosen deliberately, never guessed); null where there is no line. */
function referenceAt(doc: Doc, view: ViewTransform, sp: Vec2): { a: Vec2; b: Vec2 } | 'ambiguous' | null {
  const unit = (a: Vec2, b: Vec2): Vec2 => {
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  };
  const lines: { a: Vec2; b: Vec2; dir: Vec2; d: number }[] = [];
  for (const c of curveCandidatesAt(doc, view, sp, GUIDE_LINE_REACH_PX)) {
    if (c.entity.kind !== 'line') continue;
    const g = resolveEntityGeom(doc, c.entity);
    if (g.kind === 'line') lines.push({ a: { ...g.a }, b: { ...g.b }, dir: g.dir, d: c.d });
  }
  for (const l of contextLinesAt(view, sp, GUIDE_LINE_REACH_PX)) lines.push({ a: l.a, b: l.b, dir: unit(l.a, l.b), d: l.screenD });
  if (lines.length === 0) return null;
  lines.sort((x, y) => x.d - y.d);
  const first = lines[0]!;
  const window = REFERENCE_AMBIGUITY_PX + 0.5 * first.d;
  const rival = lines.slice(1).some((c) => c.d <= first.d + window && Math.abs(first.dir.x * c.dir.y - first.dir.y * c.dir.x) > SAME_DIRECTION_RAD);
  return rival ? 'ambiguous' : { a: first.a, b: first.b };
}

/**
 * Where the guided line through `through` may go, given the lines already lying along it. It is
 * already there when one of them reaches the point itself (an extended one reaches everywhere).
 * Otherwise collinear lines elsewhere don't stop it — but it never runs on over one of them (that
 * would double an edge): it stops where they end, so it meets them end to end.
 */
function guidedSpan(doc: Doc, ends: { a: Vec2; b: Vec2 }): { a: Vec2; b: Vec2 } | { existing: LineEntity } {
  const dx = ends.b.x - ends.a.x;
  const dy = ends.b.y - ends.a.y;
  const len2 = dx * dx + dy * dy;
  const along = (p: Vec2) => ((p.x - ends.a.x) * dx + (p.y - ends.a.y) * dy) / len2; // 0 at a, 1 at b
  const at = (t: number): Vec2 => ({ x: ends.a.x + dx * t, y: ends.a.y + dy * t });
  const mid = 0.5; // the point the line goes through sits at its middle (guidedLine)
  const eps = 1e-9;
  let lo = 0;
  let hi = 1;
  for (const { line } of supportingLines(doc, ends.a, ends.b)) {
    if (line.extended) return { existing: line };
    const g = resolveEntityGeom(doc, line);
    if (g.kind !== 'line') continue;
    const s0 = Math.min(along(g.a), along(g.b));
    const s1 = Math.max(along(g.a), along(g.b));
    if (s0 <= mid + eps && s1 >= mid - eps) return { existing: line };
    if (s1 < mid) lo = Math.max(lo, s1);
    else hi = Math.min(hi, s0);
  }
  return { a: at(lo), b: at(hi) };
}

/** Nothing the Line tool could use is near the finger: no point, no curve, and in Intersect nothing
 * of another instance — so a tap here means "stop", not a near miss. */
function nothingHere(doc: Doc, view: ViewTransform, sp: Vec2): boolean {
  return !pickPointTarget(doc, view, sp) && !isNearAnyCurve(doc, view, sp) && !contextPointAt(view, sp) && !contextNear(view, sp, GUIDE_LINE_REACH_PX);
}

/** Parallel / Perpendicular is over — made, or abandoned: no reference, and Line is Connect again. */
function endGuide(controller: AppController): void {
  controller.lineReference = null;
  controller.lineGuide = 'free';
  controller.preview = null;
  controller.nodeInset = null;
  controller.notify();
}

/**
 * The guided line through `at`: exactly parallel, or exactly perpendicular, to the reference —
 * as long as the reference itself, centred on the point (an Extension line then runs on through).
 * Exact: the direction is the reference's own (or that turned a quarter), never a measured angle.
 */
export function guidedLine(ref: { a: Vec2; b: Vec2 }, guide: 'parallel' | 'perpendicular', at: Vec2): { a: Vec2; b: Vec2 } {
  const dx = ref.b.x - ref.a.x;
  const dy = ref.b.y - ref.a.y;
  const hx = (guide === 'parallel' ? dx : -dy) / 2;
  const hy = (guide === 'parallel' ? dy : dx) / 2;
  return { a: { x: at.x - hx, y: at.y - hy }, b: { x: at.x + hx, y: at.y + hy } };
}

function beginGuidedGesture(controller: AppController, view: ViewTransform, screenPos: Vec2, guide: 'parallel' | 'perpendicular'): Gesture | null {
  const doc = controller.doc;
  const ref = controller.lineReference;
  if (!ref) {
    // First the reference: a tap on a straight line. A tap on empty canvas cancels.
    return {
      onMove() {},
      onUp(sp, wasDrag) {
        if (wasDrag) return;
        const line = referenceAt(doc, view, sp);
        if (line === 'ambiguous') {
          showToast('Lines meet here — tap along the line you mean');
          return;
        }
        if (!line) {
          if (nothingHere(doc, view, sp)) endGuide(controller);
          else showToast('Tap a straight line');
          return;
        }
        controller.lineReference = line;
        controller.notify();
      },
      onCancel() {},
    };
  }
  // Then the point: the line through it is previewed under the finger and made on release.
  const tracker = new SnapTracker(doc);
  let hit = tracker.pick(view, screenPos);
  const show = (sp: Vec2) => {
    controller.preview = hit ? { kind: 'line', ...guidedLine(ref, guide, hit.at) } : null;
    controller.nodeInset = hit ? buildNodeInset(doc, view, sp, hit.at, tracker) : null;
  };
  show(screenPos);
  controller.notifyView();
  const clear = () => {
    controller.preview = null;
    controller.nodeInset = null;
  };
  return {
    onMove(sp) {
      hit = tracker.pick(view, sp);
      show(sp);
      controller.notifyView();
    },
    onUp(sp, wasDrag) {
      hit = tracker.pick(view, sp);
      clear();
      if (!hit) {
        // Empty canvas: the unfinished Parallel / Perpendicular is cancelled. On a bare curve: say
        // what is wanted, and stay.
        if (!wasDrag && nothingHere(doc, view, sp)) {
          endGuide(controller);
          return;
        }
        if (!wasDrag && tracker.noPoint) showNoPoint(controller, tapAPoint(tracker.noPoint));
        controller.notify();
        return;
      }
      const through = refFromHit(hit);
      const ends = guidedLine(ref, guide, hit.at);
      // Along a line that already exists: never a second, coincident line. In Extension mode a line
      // already along it gains its Extension role (as Line does). Otherwise the line is already there
      // only if one reaches this very point; collinear lines elsewhere just bound it (guidedSpan).
      const along = supportingLines(doc, ends.a, ends.b);
      if (controller.lineMode === 'extension' && along.length > 0) {
        const extended = along.find((l) => l.line.extended);
        if (extended) {
          lineExists(controller, extended.line.id);
          controller.notify(); // keep the reference: nothing was made, choose another point
          return;
        }
        const lineId = along[0]!.line.id;
        controller.commit((d) => {
          materializeRef(d, through);
          const line = d.entities.find((e) => e.id === lineId);
          if (line?.kind === 'line') line.extended = true;
          invalidateGeometryCaches(d);
        });
        confirmSnap(controller, hit);
        endGuide(controller);
        return;
      }
      const span = guidedSpan(doc, ends);
      if ('existing' in span) {
        lineExists(controller, span.existing.id);
        controller.notify(); // keep the reference: nothing was made, choose another point
        return;
      }
      const aRef: PointRef = { kind: 'free', at: span.a, reuse: true };
      const bRef: PointRef = { kind: 'free', at: span.b, reuse: true };
      let newId: EntityId | null = null;
      controller.commit((d) => {
        materializeRef(d, through); // the point itself, so the line can be built on there
        const aId = materializeRef(d, aRef);
        const bId = materializeRef(d, bRef);
        if (aId !== bId) newId = landLine(controller, d, aId, bId);
      });
      confirmSnap(controller, hit);
      offerAfterLine(controller, newId);
      // One line per reference: the next Parallel / Perpendicular starts from a fresh choice.
      endGuide(controller);
    },
    onCancel() {
      clear();
      controller.notify();
    },
  };
}

// ---- Horizontal / Vertical extension through a point (on demand, from Connect's first point) ----

/**
 * With Connect's first point chosen: the horizontal (0°) or vertical (90°) extension through it —
 * an extended line in the construction's own coordinates (never the camera's), all of it Extension,
 * so it is drawn faint and dashed and every crossing with other geometry becomes a point to build
 * from. One Undo step. Along a line already there through that point, that line simply gains its
 * Extension role (as Line's Extension mode does); one already extended means it already exists.
 */
export function axisThrough(controller: AppController, axis: 'h' | 'v'): void {
  const pending = controller.pending;
  if (pending?.kind !== 'line') return;
  const doc = controller.doc;
  const aRef = pending.a;
  const at = refLocation(doc, aRef);
  const len = Math.max(doc.frame.radius, 1e-6);
  const toward = axis === 'h' ? { x: at.x + len, y: at.y } : { x: at.x, y: at.y + len };
  const along = supportingLines(doc, at, toward);
  const extended = along.find((l) => l.line.extended);
  if (extended) {
    lineExists(controller, extended.line.id);
    controller.cancelPending();
    return;
  }
  controller.commit((d) => {
    const aId = materializeRef(d, aRef);
    if (along.length > 0) {
      const line = d.entities.find((e) => e.id === along[0]!.line.id);
      if (line?.kind === 'line') line.extended = true;
      invalidateGeometryCaches(d);
      return;
    }
    const bId = genId('pt');
    d.points.push({ id: bId, kind: 'free', x: toward.x, y: toward.y, hidden: true });
    const entity = addLineEntity(d, aId, bId);
    if (entity.kind !== 'line') return;
    entity.extended = true;
    entity.axis = axis;
    for (const seg of deriveSegments(d, entity)) d.segmentStates.set(seg.key, { state: 'extension' });
    invalidateGeometryCaches(d);
  });
  controller.pending = null;
  controller.preview = null;
  controller.nodeInset = null;
  controller.notify();
}

export const lineTool: ToolModule = {
  id: 'line',
  hint(controller) {
    if (controller.lineGuide !== 'free') return controller.lineReference ? 'Tap or drag to the point the line goes through' : 'Tap the reference line';
    if (controller.pending?.kind === 'line') {
      return controller.pointLockHint ? 'Point Targets · choose an existing point' : 'Tap or drag to the second point';
    }
    return 'Tap a point or a curve';
  },
  beginGesture(controller, view, screenPos): Gesture | null {
    if (controller.lineGuide !== 'free') return beginGuidedGesture(controller, view, screenPos, controller.lineGuide);
    return beginLineLikeGesture(
      controller,
      view,
      screenPos,
      (d, aId, bId) => landLine(controller, d, aId, bId),
      (newId) => offerAfterLine(controller, newId),
      (aRef, bRef) => resolveOnSupportingLine(controller, aRef, bRef),
    );
  },
};
