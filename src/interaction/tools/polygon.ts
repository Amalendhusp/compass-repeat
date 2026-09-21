// Polygon tool, Phase 2A: sequential vertex tapping — every vertex is a point target (existing
// point, or an on-curve projection when Point Lock allows), same targeting rules as Line's
// endpoints, with no free-point fallback. Tapping the first vertex again closes the shape;
// tapping the Polygon dock button again mid-chain (finishOpenPolygon, called from the shell)
// commits whatever's been placed as an open chain instead.

import type { PointId } from '../../model/types.ts';
import { addPolygonEntities } from '../../model/doc.ts';
import type { AppController } from '../../app/controller.ts';
import { screenToWorld, worldToScreen } from '../../app/controller.ts';
import { dist } from '../../geometry/vec.ts';
import { isNearAnyCurve, pickPointTarget } from '../hittest.ts';
import { buildNodeInset } from '../nodeinset.ts';
import { materializeRef, refFromHit, refLocation, type PointRef } from '../pointref.ts';
import type { Gesture, ToolModule } from './types.ts';

const CLOSE_HIT_RADIUS = 26; // screen px around the first vertex that closes the shape

function commitPolygon(controller: AppController, vertices: PointRef[], closed: boolean): void {
  controller.commit((d) => {
    const ids: PointId[] = [];
    for (const ref of vertices) {
      const id = materializeRef(d, ref);
      if (ids[ids.length - 1] !== id) ids.push(id);
    }
    if (closed && ids.length >= 2 && ids[0] === ids[ids.length - 1]) ids.pop();
    if (ids.length >= 2) addPolygonEntities(d, ids, closed && ids.length >= 3);
  });
  controller.pending = null;
  controller.preview = null;
  controller.nodeInset = null;
  controller.pointLockHint = false;
  controller.notify();
}

/** §2A: "tapping Polygon again may finish an open chain" — the shell calls this from the dock
 * button before falling back to the ordinary setTool()-resets-everything behaviour. */
export function finishOpenPolygon(controller: AppController): boolean {
  if (controller.pending?.kind !== 'polygon' || controller.pending.vertices.length < 2) return false;
  commitPolygon(controller, controller.pending.vertices, false);
  return true;
}

export const polygonTool: ToolModule = {
  id: 'polygon',
  hint(controller) {
    if (controller.pending?.kind === 'polygon') {
      if (controller.pointLockHint) return 'Point Targets · choose an existing point';
      return controller.pending.vertices.length >= 3 ? 'Tap the next point, or the first vertex to close' : 'Tap the next point';
    }
    return 'Tap a point or a curve to start';
  },
  beginGesture(controller, view, screenPos): Gesture | null {
    const doc = controller.doc;
    let justSet = false;

    if (controller.pending?.kind !== 'polygon') {
      const hit = pickPointTarget(doc, view, screenPos);
      if (!hit) return null;
      controller.pending = { kind: 'polygon', vertices: [refFromHit(hit)] };
      justSet = true;
    }

    const vertices = (controller.pending as { kind: 'polygon'; vertices: PointRef[] }).vertices;
    const committedAt = vertices.map((v) => refLocation(doc, v));
    const lastAt = committedAt[committedAt.length - 1]!;
    controller.preview = { kind: 'polygon', vertices: committedAt, current: lastAt };
    controller.notify();

    return {
      onMove(sp) {
        const hit = pickPointTarget(doc, view, sp);
        const current = hit ? hit.at : screenToWorld(view, sp);
        controller.preview = { kind: 'polygon', vertices: committedAt, current };
        controller.nodeInset = hit ? buildNodeInset(doc, view, sp, hit.at) : null;
        const lockedOut = !doc.pointTargets.free && !hit && isNearAnyCurve(doc, view, sp);
        const transitioned = lockedOut !== controller.pointLockHint;
        controller.pointLockHint = lockedOut;
        if (transitioned) controller.notify();
        else controller.notifyView();
      },
      onUp(sp, wasDrag) {
        if (!wasDrag && justSet) {
          // First tap only planted vertex 0; wait for the next tap.
          controller.preview = { kind: 'polygon', vertices: committedAt, current: lastAt };
          controller.nodeInset = null;
          controller.notify();
          return;
        }
        const hit = pickPointTarget(doc, view, sp);
        if (hit) {
          const v0Screen = worldToScreen(view, committedAt[0]!);
          const hitScreen = worldToScreen(view, hit.at);
          if (vertices.length >= 3 && dist(v0Screen, hitScreen) <= CLOSE_HIT_RADIUS) {
            commitPolygon(controller, vertices, true);
            return;
          }
          const nextVertices = [...vertices, refFromHit(hit)];
          controller.pending = { kind: 'polygon', vertices: nextVertices };
          const nextAt = nextVertices.map((v) => refLocation(doc, v));
          controller.preview = { kind: 'polygon', vertices: nextAt, current: nextAt[nextAt.length - 1]! };
          controller.nodeInset = null;
          controller.pointLockHint = false;
          controller.notify();
          return;
        }
        if (!doc.pointTargets.free && isNearAnyCurve(doc, view, sp)) {
          // Point Lock: touched a curve with no explicit point there — stay armed rather than
          // discarding the chain (mirrors line.ts/circle.ts's Point Lock handling).
          controller.preview = { kind: 'polygon', vertices: committedAt, current: lastAt };
          controller.nodeInset = null;
          controller.pointLockHint = true;
          controller.notify();
          return;
        }
        // No free-point fallback for Polygon vertices; a miss cancels the pending chain — use
        // the dock's re-tap (finishOpenPolygon) to keep an in-progress chain instead.
        controller.cancelPending();
      },
      onCancel() {
        // Phase 1.1 item 3 / reaffirmed by Phase 3.2 item 4: Polygon is the one pending-anchor
        // tool that keeps this behaviour — a second finger (pinch/pan) preserves every already-
        // committed vertex, only suspending the live rubber-band preview to the next vertex.
        // Resuming after the view gesture continues the chain from the last committed vertex.
        controller.preview = null;
        controller.nodeInset = null;
        controller.notify();
      },
    };
  },
};
