// Develop (Intersect): what a tap means — take a segment into the developed design, or out of it — and
// the one commit that does it (one Undo step). Construct, its Fair and the copies are never changed.
//
// A segment is IN the design when a developed segment lies along it, or when it is Fair of a Whole copy
// (whose entire Fair motif is in the design) that has not been taken out there. A tap reverses that:
// - in → out: the developed segment along it is removed, and each Whole copy it belongs to records it
//   as excluded (geometry/developExclusions.ts — in the copy's own coordinates, so it follows the copy);
// - out → in: a Whole copy's excluded stretch is restored; otherwise the segment's exact geometry is
//   added to the developed design (independent of the copy from then on, as before).
// Developed segments no copy draws any more (the copy moved since) can still be tapped out. Coincident
// geometry is one candidate. Nothing is ever joined up or closed automatically.

import { LAYER_ORIGIN } from '../geometry/intersectLayer.ts';
import type { DevelopedSegment, Doc, Vec2 } from '../model/types.ts';
import type { AppController } from '../app/controller.ts';
import { asForm, developedSegments, formMode, inComposition, shownCopies, intersectionCopies } from '../geometry/intersection.ts';
import { closestOn, len, sub, type Prim } from '../geometry/fairGeometry.ts';
import { developedAlong, developedPrim, formSegments, geomOf, midOf, type FormLayer, type FormOffer, type FormOrigin, type FormSegment } from '../geometry/formSegments.ts';
import { exclusionMap, isExcludedAt, localRange, withExcluded, withoutExcluded } from '../geometry/developExclusions.ts';
import { showToast } from '../ui/toast.ts';

/** A Whole copy's Fair that a segment is part of: where along which Construct line or circle, in the
 * copy's own coordinates, and whether it is excluded there now. */
export interface WholeRef {
  copy: string;
  entity: string;
  t0: number;
  t1: number;
  circle: boolean;
  excluded: boolean;
}

export interface FormPick {
  prim: Prim;
  action: 'add' | 'remove';
  /** The arrangement's segment, when the candidate is one. */
  segment?: FormSegment;
  /** The developed segment along it (removing), if any. */
  developed?: DevelopedSegment;
  /** The Whole copies whose Fair it is. */
  whole?: WholeRef[];
  /** Distance from the finger (artwork units), and where on the candidate that nearest point is. */
  d: number;
  at: Vec2;
  /** A point on the candidate a little way from the finger toward its middle — where its marker or
   * number goes, so candidates meeting at one crossing still point apart. */
  marker: Vec2;
}

export interface FormLoupe {
  x: number;
  y: number;
  r: number;
  mag: number;
  /** The screen point it magnifies. */
  centreScreen: Vec2;
  markers: Vec2[];
  cursor: Vec2;
  holdStart: Vec2;
  cursorStart: Vec2;
}

export interface FormPress {
  picks: FormPick[];
  active: number;
  anchorScreen: Vec2;
  loupe: FormLoupe | null;
}

/** The Whole copies (shown, their whole motif in the design) whose Fair `seg` is part of. */
export function wholeRefsOf(doc: Doc, seg: FormSegment): WholeRef[] {
  const out: WholeRef[] = [];
  const copies = shownCopies(doc);
  for (const o of seg.origins) {
    if (o.kind || o.copy === LAYER_ORIGIN) continue; // only Fair: Whole takes a copy's Fair motif
    const copy = copies.find((c) => c.key === o.copy);
    if (!copy || !inComposition(doc, copy.key)) continue;
    const r = localRange(doc, copy.pose, o.entity, seg.prim);
    if (!r) continue;
    out.push({ copy: copy.key, entity: o.entity, t0: r.t0, t1: r.t1, circle: r.circle, excluded: isExcludedAt(r.mid, exclusionMap(doc, copy.key)?.get(o.entity), r.circle) });
  }
  return out;
}

/** Whether segment `seg` is in the developed design now. */
export function segmentIncluded(doc: Doc, seg: FormSegment, developed = developedSegments(doc)): boolean {
  return !!developedAlong(doc, developed, seg.prim) || wholeRefsOf(doc, seg).some((r) => !r.excluded);
}

/** Candidates within `reach` of `at` (artwork units), nearest first. */
export function formPicksAt(doc: Doc, at: Vec2, reach: number, markerStep: number, offer: FormLayer | FormOffer = 'fair'): FormPick[] {
  const developed = developedSegments(doc);
  const out: FormPick[] = [];
  const marker = (prim: Prim, q: Vec2): Vec2 => {
    const m = midOf(prim);
    const v = sub(m, q);
    const l = len(v);
    if (l <= 1e-12) return m;
    const step = Math.min(l, markerStep);
    return { x: q.x + (v.x / l) * step, y: q.y + (v.y / l) * step };
  };
  const taken = new Set<string>();
  for (const seg of formSegments(doc, offer)) {
    const b = seg.box;
    if (at.x < b.x0 - reach || at.x > b.x1 + reach || at.y < b.y0 - reach || at.y > b.y1 + reach) continue;
    const c = closestOn(at, seg.prim);
    if (c.d > reach) continue;
    const dev = developedAlong(doc, developed, seg.prim);
    if (dev) taken.add(dev.id);
    const whole = wholeRefsOf(doc, seg);
    const included = !!dev || whole.some((r) => !r.excluded);
    out.push({ prim: seg.prim, action: included ? 'remove' : 'add', segment: seg, developed: dev, whole, d: c.d, at: c.q, marker: marker(seg.prim, c.q) });
  }
  // Developed segments that no offered segment stands for (a copy has moved since): still removable.
  for (const s of developed) {
    if (taken.has(s.id)) continue;
    const prim = developedPrim(s);
    const c = closestOn(at, prim);
    if (c.d <= reach) out.push({ prim, action: 'remove', developed: s, d: c.d, at: c.q, marker: marker(prim, c.q) });
  }
  return out.sort((p, q) => p.d - q.d);
}

/** "Original", "Copy 2"… — the contributors of a segment, as Intersect names its constructions. */
export function originsLabel(doc: Doc, origins: FormOrigin[]): string {
  const labels = new Map(intersectionCopies(doc).map((c) => [c.key, c.label]));
  labels.set(LAYER_ORIGIN, 'Intersect construction');
  return [...new Set(origins.map((o) => o.copy))].map((k) => labels.get(k) ?? 'a removed copy').join(' + ');
}

/** What a candidate is, in a few words (the chooser's detail line). */
export function describePick(doc: Doc, p: FormPick): string {
  const kind = p.prim.k === 'seg' ? 'Line' : 'Arc';
  if (!p.segment) return `${kind} · in the design`;
  return `${kind} · ${originsLabel(doc, p.segment.origins)}${p.action === 'remove' ? ' · in the design' : ''}`;
}

/** The next free developed-segment id. */
function nextId(list: DevelopedSegment[]): string {
  let n = 0;
  for (const s of list) {
    const m = /^d(\d+)$/.exec(s.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `d${n + 1}`;
}

/** Takes one candidate into the design or out of it — one Undo step. A legacy artwork starts Form
 * Development here with every copy kept in Repeat (asForm), so nothing it already repeats changes. */
export function commitPick(controller: AppController, pick: FormPick): void {
  const wasLegacy = formMode(controller.doc) === 'legacy';
  controller.commit((d) => {
    const ix = asForm(d);
    const setExcluded = (copy: string, edit: (list: NonNullable<(typeof ix.copies)[string]['excluded']>) => NonNullable<(typeof ix.copies)[string]['excluded']>) => {
      const own = { ...ix.copies[copy] };
      const next = edit(own.excluded ?? []);
      if (next.length) own.excluded = next;
      else delete own.excluded;
      ix.copies[copy] = own;
    };
    if (pick.action === 'remove') {
      if (pick.developed) {
        const id = pick.developed.id;
        ix.form.developed = ix.form.developed.filter((s) => s.id !== id);
      }
      for (const r of pick.whole ?? []) if (!r.excluded) setExcluded(r.copy, (list) => withExcluded(list, r.entity, r.t0, r.t1, r.circle));
    } else {
      const restore = (pick.whole ?? []).filter((r) => r.excluded);
      if (restore.length) for (const r of restore) setExcluded(r.copy, (list) => withoutExcluded(list, r.entity, r.t0, r.t1, r.circle));
      else if (pick.segment) ix.form.developed.push({ id: nextId(ix.form.developed), geom: geomOf(pick.prim), origins: pick.segment.origins.map((o) => ({ ...o })) });
    }
    d.intersection = ix;
  });
  if (wasLegacy) showToast('Developing the design · every copy stays in Repeat', 2600);
}

/** Whole: copy `key`'s entire Fair motif into the design, or out of it — one Undo step. Either way what
 * Develop had excluded from it is forgotten (Undo brings it back). The Construct source is never touched. */
export function setWhole(controller: AppController, key: string, on: boolean): void {
  const label = intersectionCopies(controller.doc).find((c) => c.key === key)?.label ?? 'The copy';
  controller.commit((d) => {
    const ix = asForm(d);
    const own = { ...ix.copies[key], primaryCopy: on };
    delete own.excluded; // Whole on: all of its Fair; off: none of it
    ix.copies[key] = own;
    d.intersection = ix;
  });
  showToast(on ? `${label}’s whole Fair is in the design` : `${label}’s whole Fair is out of the design`, 2200);
}
