// Fair in Intersect (Stage D4): what a tap means — add a segment to the Developed Primary, or take a
// developed segment out of it — and the one commit that does it (one Undo step).
//
// Candidates near the finger: the arrangement's segments not yet in the Primary (formSegments.ts),
// and the Developed Primary's own segments (wherever they are — a copy moved since they were taken
// no longer has a segment there, but the developed one can still be removed). Coincident geometry is
// one candidate. Nothing is ever joined up or closed automatically.

import type { DevelopedSegment, Doc, Vec2 } from '../model/types.ts';
import type { AppController } from '../app/controller.ts';
import { asForm, developedSegments, formMode, intersectionCopies } from '../geometry/intersection.ts';
import { closestOn, len, sub, type Prim } from '../geometry/fairGeometry.ts';
import { developedAlong, developedPrim, formSegments, geomOf, midOf, type FormLayer, type FormOrigin, type FormSegment } from '../geometry/formSegments.ts';
import { showToast } from '../ui/toast.ts';

export interface FormPick {
  prim: Prim;
  action: 'add' | 'remove';
  /** The arrangement's segment (adding), or the developed one (removing). */
  segment?: FormSegment;
  developed?: DevelopedSegment;
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

/** Candidates within `reach` of `at` (artwork units), nearest first. */
export function formPicksAt(doc: Doc, at: Vec2, reach: number, markerStep: number, layer: FormLayer = 'fair'): FormPick[] {
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
  for (const s of developed) {
    const prim = developedPrim(s);
    const c = closestOn(at, prim);
    if (c.d <= reach) out.push({ prim, action: 'remove', developed: s, d: c.d, at: c.q, marker: marker(prim, c.q) });
  }
  for (const seg of formSegments(doc, layer)) {
    const b = seg.box;
    if (at.x < b.x0 - reach || at.x > b.x1 + reach || at.y < b.y0 - reach || at.y > b.y1 + reach) continue;
    const c = closestOn(at, seg.prim);
    if (c.d > reach) continue;
    if (developedAlong(doc, developed, seg.prim)) continue; // already in the Primary: the developed one stands for it
    out.push({ prim: seg.prim, action: 'add', segment: seg, d: c.d, at: c.q, marker: marker(seg.prim, c.q) });
  }
  return out.sort((p, q) => p.d - q.d);
}

/** "Original", "Copy 2"… — the contributors of a segment, as Intersect names its constructions. */
export function originsLabel(doc: Doc, origins: FormOrigin[]): string {
  const labels = new Map(intersectionCopies(doc).map((c) => [c.key, c.label]));
  return [...new Set(origins.map((o) => o.copy))].map((k) => labels.get(k) ?? 'a removed copy').join(' + ');
}

/** What a candidate is, in a few words (the chooser's detail line). */
export function describePick(doc: Doc, p: FormPick): string {
  const kind = p.prim.k === 'seg' ? 'Line' : 'Arc';
  if (p.action === 'remove') return `${kind} · in the Primary`;
  return `${kind} · ${originsLabel(doc, p.segment?.origins ?? [])}`;
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

/** Adds or removes one candidate — one Undo step. A legacy artwork starts Form Development here with
 * every copy kept in Repeat (asForm), so nothing it already repeats changes. */
export function commitPick(controller: AppController, pick: FormPick): void {
  const wasLegacy = formMode(controller.doc) === 'legacy';
  controller.commit((d) => {
    const ix = asForm(d);
    if (pick.action === 'add' && pick.segment) {
      ix.form.developed.push({ id: nextId(ix.form.developed), geom: geomOf(pick.prim), origins: pick.segment.origins.map((o) => ({ ...o })) });
    } else if (pick.action === 'remove' && pick.developed) {
      const id = pick.developed.id;
      ix.form.developed = ix.form.developed.filter((s) => s.id !== id);
    }
    d.intersection = ix;
  });
  if (wasLegacy) showToast('Developing the Primary · every copy stays in Repeat', 2600);
}
