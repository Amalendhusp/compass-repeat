// Intersect's own construction layer. What Line, Circle, Arc and Divide draw in Intersect belongs to
// Intersect alone (doc.intersection.construction), in the workspace's own coordinates — never to
// Construct, never to Repeat. The copies stay what they are: the one Construct construction, placed.
//
// The layer is edited by the very same tools, kernel and renderer as Construct, through a LAYER
// DOCUMENT: a Doc whose geometry (points, lines, circles, segment states) is the layer's and whose
// everything else (preferences, view, workspace…) reads and writes the real artwork. A LAYER
// CONTROLLER hands the tools that document and turns their commits into one ordinary commit of the
// real artwork (one Undo step, recorded like any other).
//
// From the copies, the layer takes positions only: a copy's point, or a crossing between copies (or
// between a copy and the layer), becomes a fixed free point of the layer where it lies (contextual
// places — interaction/context.ts). Moving, turning, reflecting or hiding a copy afterwards never moves
// the layer, as it never moves the developed Fair geometry it sits beside.

import type { Doc, IntersectConstruction, SegmentKey, SegmentState, Vec2 } from '../model/types.ts';
import type { AppController } from '../app/controller.ts';
import { withConstruction } from './intersection.ts';

/** The layer's own centre point: a hidden fixed point at the frame centre (a layer document's frame
 * needs one); never drawn. */
export const LAYER_CENTRE = 'ix_centre';
/** The `copy` a developed Fair segment taken from Intersect's own construction records as its origin. */
export const LAYER_ORIGIN = 'ix';

/** The geometry a layer document holds itself; every other Doc field is the real artwork's. */
const OWN = new Set(['points', 'entities', 'segmentStates', 'fills', 'frame', 'symmetrySources', 'echo']);

export function layerOf(doc: Doc): IntersectConstruction | undefined {
  return doc.intersection?.construction;
}

/** Whether anything has been drawn in Intersect (the centre alone doesn't count). */
export function hasLayerGeometry(doc: Doc): boolean {
  return (layerOf(doc)?.entities.length ?? 0) > 0;
}

function emptyLayer(doc: Doc): IntersectConstruction {
  return { points: [{ id: LAYER_CENTRE, kind: 'free', x: doc.frame.origin.x, y: doc.frame.origin.y, hidden: true }], entities: [], segmentStates: [] };
}

/** A Doc over `doc` whose geometry is `layer`'s (copied in, so a commit can change it freely). */
function makeLayerDoc(doc: Doc, layer: IntersectConstruction): Doc {
  const L = {} as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (OWN.has(key)) continue;
    Object.defineProperty(L, key, {
      get: () => (doc as unknown as Record<string, unknown>)[key],
      set: (v) => {
        (doc as unknown as Record<string, unknown>)[key] = v;
      },
      enumerable: true,
      configurable: true,
    });
  }
  L.points = layer.points.map((p) => ({ ...p }));
  L.entities = layer.entities.map((e) => ({ ...e }));
  L.segmentStates = new Map<SegmentKey, SegmentState>(layer.segmentStates.map(([k, v]) => [k, { ...v }]));
  L.fills = new Map();
  L.frame = { ...doc.frame, origin: { ...doc.frame.origin }, entityIds: [], centreId: LAYER_CENTRE };
  L.symmetrySources = [];
  L.echo = { mode: 'off', mirrors: false };
  return L as unknown as Doc;
}

const docCache = new WeakMap<Doc, Doc>();

/** The layer document of an artwork state (one per state, so the kernel's caches hold). */
export function layerDoc(doc: Doc): Doc {
  let L = docCache.get(doc);
  if (!L) {
    L = makeLayerDoc(doc, layerOf(doc) ?? emptyLayer(doc));
    docCache.set(doc, L);
  }
  return L;
}

function layerFrom(L: Doc): IntersectConstruction {
  return {
    points: L.points.map((p) => ({ ...p })),
    entities: L.entities.map((e) => ({ ...e })),
    segmentStates: [...L.segmentStates].map(([k, v]) => [k, { ...v }]),
  };
}

/** One commit of the real artwork that runs `mutate` on its layer document. */
function commitLayer(controller: AppController, mutate: (doc: Doc) => void): void {
  controller.commit((d) => {
    const L = makeLayerDoc(d, layerOf(d) ?? emptyLayer(d));
    mutate(L);
    d.intersection = withConstruction(d, layerFrom(L));
  });
}

const controllerCache = new WeakMap<AppController, AppController>();

/**
 * The controller as the construction tools see it in Intersect: the same controller (tool state,
 * selection, notifications, Undo) — but its `doc` is the layer document and its `commit` edits the
 * layer. Everything else goes straight through.
 */
export function layerController(controller: AppController): AppController {
  let p = controllerCache.get(controller);
  if (!p) {
    p = new Proxy(controller, {
      get(target, prop, receiver) {
        if (prop === 'doc') return layerDoc(target.doc);
        if (prop === 'commit') return (mutate: (doc: Doc) => void) => commitLayer(target, mutate);
        return Reflect.get(target, prop, receiver);
      },
      set(target, prop, value) {
        return Reflect.set(target, prop, value);
      },
    });
    controllerCache.set(controller, p);
  }
  return p;
}

/** Every position of the layer's own points (for bounds). */
export function layerPositions(doc: Doc, resolve: (doc: Doc, id: string) => Vec2): Vec2[] {
  if (!hasLayerGeometry(doc)) return [];
  const L = layerDoc(doc);
  const out: Vec2[] = [];
  for (const p of L.points) {
    if (p.id === LAYER_CENTRE) continue;
    try {
      const w = resolve(L, p.id);
      if (Number.isFinite(w.x) && Number.isFinite(w.y)) out.push(w);
    } catch {
      // a point that no longer resolves adds nothing
    }
  }
  return out;
}
