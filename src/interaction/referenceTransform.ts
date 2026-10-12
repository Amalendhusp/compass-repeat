// Reference Transform: while it is on (controller.referenceTransform), every finger on the canvas
// moves the reference instead of reaching a tool or the camera (PointerManager's takeover). One
// finger slides it; two fingers scale it uniformly and turn it together, about the point between
// them — as if the image were held under the fingers. Only this workspace's placement of it changes
// (centre, width, rotation, in the artwork's own coordinates — render/underlay.ts): never another
// workspace's, no camera and no geometry.
//
// The touch is shown live (controller.underlayDraft) and committed once, when the last finger
// lifts — one Undo step per complete gesture. A pointercancel puts it back untouched.

import type { Underlay, Vec2 } from '../model/types.ts';
import type { AppController, ViewTransform } from '../app/controller.ts';
import { screenToWorld } from '../app/controller.ts';
import type { PointerTakeover } from './pointer.ts';
import { underlayIn, withPlacement } from '../render/underlay.ts';

/** The reference stays between these widths, as multiples of the frame radius. */
const MIN_WIDTH = 0.05;
const MAX_WIDTH = 2000;
/** Below this finger spacing (px) a second finger only moves — too close to judge a scale or turn. */
const MIN_SPREAD_PX = 12;

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** The reference as moved by the fingers since `basePts` (world): one finger slides it; two map
 * the pair as it was onto the pair as it is — scale, turn and slide in one. */
export function transformedUnderlay(base: Underlay, basePts: Vec2[], pts: Vec2[], radius: number, zoom: number): Underlay {
  if (pts.length === 1 || basePts.length === 1) {
    const d = sub(pts[0]!, basePts[0]!);
    return { ...base, centre: { x: base.centre.x + d.x, y: base.centre.y + d.y } };
  }
  const v0 = sub(basePts[1]!, basePts[0]!);
  const v1 = sub(pts[1]!, pts[0]!);
  const m0 = mid(basePts[0]!, basePts[1]!);
  const m1 = mid(pts[0]!, pts[1]!);
  const l0 = Math.hypot(v0.x, v0.y);
  const l1 = Math.hypot(v1.x, v1.y);
  if (l0 * zoom < MIN_SPREAD_PX || l1 * zoom < MIN_SPREAD_PX) {
    return { ...base, centre: { x: base.centre.x + m1.x - m0.x, y: base.centre.y + m1.y - m0.y } };
  }
  const width = Math.min(MAX_WIDTH * radius, Math.max(MIN_WIDTH * radius, base.width * (l1 / l0)));
  const s = width / base.width;
  const turn = Math.atan2(v0.x * v1.y - v0.y * v1.x, v0.x * v1.x + v0.y * v1.y);
  const c = Math.cos(turn);
  const n = Math.sin(turn);
  const r = sub(base.centre, m0);
  let rotation = base.rotation + turn;
  rotation = Math.atan2(Math.sin(rotation), Math.cos(rotation));
  return { ...base, width, rotation, centre: { x: m1.x + s * (r.x * c - r.y * n), y: m1.y + s * (r.x * n + r.y * c) } };
}

/** The takeover for one touch while Transform is on — or null when there's nothing to transform. */
export function referenceTakeover(controller: AppController, getView: () => ViewTransform): PointerTakeover | null {
  if (!controller.referenceTransform || !controller.doc.underlay) return null;
  const view = getView(); // the camera can't move during the touch: every finger is the reference's
  const ws = controller.doc.view.workspace;
  const start = underlayIn(controller.doc.underlay, ws); // as this workspace shows it
  let base: Underlay = start;
  let basePts: Vec2[] = [];
  const world = (pts: Vec2[]) => pts.slice(0, 2).map((p) => screenToWorld(view, p));
  return {
    update(points, phase) {
      const pts = world(points);
      // A finger added or lifted: carry on from where the reference is now, with the new fingers.
      if (phase !== 'move' || pts.length !== basePts.length) {
        base = controller.underlayDraft ?? start;
        basePts = pts;
        return;
      }
      controller.underlayDraft = transformedUnderlay(base, basePts, pts, controller.doc.frame.radius, view.zoom);
      controller.notifyView();
    },
    end() {
      const next = controller.underlayDraft;
      controller.underlayDraft = null;
      const moved = next && (next.centre.x !== start.centre.x || next.centre.y !== start.centre.y || next.width !== start.width || next.rotation !== start.rotation);
      if (moved) {
        controller.commit((d) => {
          if (d.underlay) d.underlay = withPlacement(d.underlay, ws, next);
        });
      } else controller.notifyView();
    },
    cancel() {
      controller.underlayDraft = null;
      controller.notifyView();
    },
  };
}
