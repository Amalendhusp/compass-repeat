// Fill tool — Phase 4: tap-to-colour a single enclosed Fair/design region. Never floods, never
// infers a missing boundary, never creates geometry — it only ever reads the already-computed
// Fair region topology (geometry/regions.ts) and writes one colour into doc.fills.

import { screenToWorld, type ViewTransform } from '../../app/controller.ts';
import { computeFairRegions, findRegionAt } from '../../geometry/regions.ts';
import { setRegionFill } from '../../model/doc.ts';
import { showToast } from '../../ui/toast.ts';
import type { Gesture, ToolModule } from './types.ts';

export const fillTool: ToolModule = {
  id: 'fill',
  hint() {
    return 'Tap inside a Fair-bounded region to fill it';
  },
  beginGesture(controller, view: ViewTransform, screenPos): Gesture {
    const doc = controller.doc;
    const worldPos = screenToWorld(view, screenPos);
    const region = findRegionAt(computeFairRegions(doc), worldPos);

    // Phase 4 item 2/6: a temporary translucent preview the instant the region resolves, cleared
    // on release either way — committing (or the "open boundary" refusal) happens only on tap-up.
    if (region) {
      controller.fillPreview = { sig: region.sig, colour: doc.fillDefaults.colour };
      controller.notifyView();
    }

    return {
      onMove() {
        // A plain tap tool — no live re-targeting while the finger moves.
      },
      onUp(_sp, wasDrag) {
        controller.fillPreview = null;
        if (wasDrag) {
          controller.notify();
          return;
        }
        if (!region) {
          // Phase 4 item 3: never guess a missing boundary, never flood past it — a quiet,
          // explicit refusal instead.
          showToast('Open boundary');
          controller.notify();
          return;
        }
        controller.commit((d) => setRegionFill(d, region.sig, d.fillDefaults.colour));
      },
      onCancel() {
        // §2 arbitration: a second finger cancels without committing, same as every other tool.
        controller.fillPreview = null;
        controller.notify();
      },
    };
  },
};
