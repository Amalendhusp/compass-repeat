// Fill tool — Phase 4: tap-to-colour a single enclosed Fair/design region. Never floods, never
// infers a missing boundary, never creates geometry — it only ever reads the already-computed
// Fair region topology (geometry/regions.ts) and writes one colour into doc.fills.
// Phase 5.2 item 26: a toggle, like Fair — an empty region fills with the current colour and
// opacity; a filled region, tapped again, goes back to no fill.

import { screenToWorld, type ViewTransform } from '../../app/controller.ts';
import { computeFairRegions, findRegionAt } from '../../geometry/regions.ts';
import { diagnoseOpenBoundary } from '../../geometry/openBoundary.ts';
import { getRegionFill, removeRegionFill, setRegionFill } from '../../model/doc.ts';
import { withAlpha } from '../../model/colour.ts';
import { showToast } from '../../ui/toast.ts';
import type { Gesture, ToolModule } from './types.ts';

export const fillTool: ToolModule = {
  id: 'fill',
  hint() {
    return '';
  },
  beginGesture(controller, view: ViewTransform, screenPos): Gesture {
    const doc = controller.doc;
    const tapWorld = screenToWorld(view, screenPos);
    const region = findRegionAt(computeFairRegions(doc), tapWorld);
    const filled = region ? getRegionFill(doc, region.sig) !== undefined : false;
    const colour = withAlpha(doc.fillDefaults.colour, doc.fillDefaults.opacity);

    // Phase 4 item 2/6: a translucent preview the instant an EMPTY region resolves, cleared on
    // release either way — committing (or the "open boundary" refusal) happens only on tap-up.
    if (region && !filled) {
      controller.fillPreview = { sig: region.sig, colour };
      controller.notifyView();
    }

    return {
      onMove() {},
      onUp(_sp, wasDrag) {
        controller.fillPreview = null;
        if (wasDrag) {
          controller.notify();
          return;
        }
        if (!region) {
          // Phase 4 item 3: never guess a missing boundary, never flood past it. Phase 5.4: and
          // show WHERE it's open — the chain and its loose ends, briefly; nothing is changed.
          showToast('Open boundary');
          const diagnosis = diagnoseOpenBoundary(doc, tapWorld, 70 / view.zoom);
          if (diagnosis) controller.showFillDiagnostic(diagnosis);
          controller.notify();
          return;
        }
        controller.commit((d) => (filled ? removeRegionFill(d, region.sig) : setRegionFill(d, region.sig, colour)));
      },
      onCancel() {
        controller.fillPreview = null;
        controller.notify();
      },
    };
  },
};
