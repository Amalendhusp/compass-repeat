// Repeat's outline style (types.ts — RepeatStroke): one, two or three strokes drawn along exactly
// the same paths as the design's own lines, widest first — a rendered treatment, never geometry.
//
// - Single: one colour and width for every line (0 = no outlines).
// - Double: a wide outer stroke under a narrower inner one — two borders of the outer colour
//   enclosing a band of the inner colour.
// - Triple: and a still narrower centre stroke — three colour zones along every line.
// Widths always stay outer > inner > centre > 0: changing one pushes its neighbours just enough.
// An artwork styled before this existed (Repeat's older single colour/width, on the display) keeps
// that look until a style is chosen here.

import type { Doc, RepeatStroke, RepeatStrokeLayer } from '../model/types.ts';

/** One layer as drawn: a colour or width left null keeps each line's own from Construct. */
export interface DrawnLayer {
  colour: string | null;
  width: number | null;
}

export type StrokeKind = 'designed' | 'single' | 'double' | 'triple';

/** The outline style in force (`draft`: one being adjusted, shown live): the layers to draw, widest
 * first — [ {null, null} ] meaning each line exactly as designed. */
export function drawnLayers(doc: Doc, draft?: RepeatStroke | null): DrawnLayer[] {
  const s = draft ?? doc.repeatSetup?.stroke;
  if (s) return s.layers.length ? s.layers.map((l) => ({ colour: l.colour, width: l.width })) : [{ colour: null, width: null }];
  const d = doc.repeatDisplay;
  return [{ colour: d.strokeColour ?? null, width: d.strokeWidth ?? null }];
}

/** The style as the Stroke editor shows it: the older display-level style reads as Single. */
export function editableStroke(doc: Doc, fallback: RepeatStrokeLayer): RepeatStroke {
  const s = doc.repeatSetup?.stroke;
  if (s) return structuredClone(s);
  const d = doc.repeatDisplay;
  if (d.strokeColour != null || d.strokeWidth != null) return { layers: [{ colour: d.strokeColour ?? fallback.colour, width: d.strokeWidth ?? fallback.width }] };
  return { layers: [] };
}

export function strokeKind(s: RepeatStroke): StrokeKind {
  return s.layers.length === 0 ? 'designed' : s.layers.length === 1 ? 'single' : s.layers.length === 2 ? 'double' : 'triple';
}

/** The widest a layer may be, and the least step between neighbouring layers (px). */
export const MAX_STROKE_PX = 24;
export const LAYER_GAP_PX = 0.5;
const MIN_LAYER_PX = 0.5;

const CREAM = '#F2E6C9';
const RED = '#C6402C';

/** The style changed to `kind`, keeping what it can of `from` (colours and widths). */
export function withKind(from: RepeatStroke, kind: StrokeKind, design: RepeatStrokeLayer): RepeatStroke {
  const outer = from.layers[0] ?? design;
  switch (kind) {
    case 'designed':
      return { layers: [] };
    case 'single':
      return { layers: [{ colour: outer.colour, width: from.layers.length > 1 ? Math.max(1, from.layers[from.layers.length - 1]!.width) : outer.width }] };
    case 'double': {
      if (from.layers.length >= 2) return { layers: from.layers.slice(0, 2).map((l) => ({ ...l })) };
      return { layers: [{ colour: outer.colour, width: 6 }, { colour: CREAM, width: 3 }] };
    }
    case 'triple': {
      if (from.layers.length === 3) return structuredClone(from);
      if (from.layers.length === 2) {
        const [o, i] = from.layers as [RepeatStrokeLayer, RepeatStrokeLayer];
        return withWidth({ layers: [{ ...o }, { ...i }, { colour: RED, width: Math.max(MIN_LAYER_PX, i.width / 3) }] }, 2, Math.max(MIN_LAYER_PX, i.width / 3));
      }
      return { layers: [{ colour: outer.colour, width: 9 }, { colour: CREAM, width: 6 }, { colour: RED, width: 2.5 }] };
    }
  }
}

/** Layer `k` set to `width` (single: 0 allowed — no outlines), its neighbours pushed so that each
 * stays at least LAYER_GAP_PX narrower than the one before and the narrowest above zero. */
export function withWidth(s: RepeatStroke, k: number, width: number): RepeatStroke {
  const n = s.layers.length;
  const layers = s.layers.map((l) => ({ ...l }));
  if (n === 1) {
    layers[0]!.width = Math.min(MAX_STROKE_PX, Math.max(0, width));
    return { layers };
  }
  // Room for the narrower layers below and the wider ones above.
  const lo = MIN_LAYER_PX + (n - 1 - k) * LAYER_GAP_PX;
  const hi = MAX_STROKE_PX - k * LAYER_GAP_PX;
  layers[k]!.width = Math.min(hi, Math.max(lo, width));
  for (let i = k - 1; i >= 0; i--) layers[i]!.width = Math.max(layers[i]!.width, layers[i + 1]!.width + LAYER_GAP_PX);
  for (let i = k + 1; i < n; i++) layers[i]!.width = Math.min(layers[i]!.width, layers[i - 1]!.width - LAYER_GAP_PX);
  return { layers };
}

export function withColour(s: RepeatStroke, k: number, colour: string): RepeatStroke {
  return { layers: s.layers.map((l, i) => (i === k ? { ...l, colour } : { ...l })) };
}
