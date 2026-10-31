// Fair in Intersect (Stage D): develops the Primary — Intersect's own geometry, independent of the
// Construct source. Unlike Line, Circle, Arc and Divide (which edit the Construct motif through the
// active instance, so every copy follows), Fair here never touches the Construct source: it shows
// every copy's Fair geometry, translucent, and the Developed Primary, opaque, over it.
//
// Checkpoint D2: the display mode only — a tap does nothing yet (segments arrive in D3, tap to add
// and remove in D4).

import type { ToolModule } from './types.ts';

export const intersectFairTool: ToolModule = {
  id: 'fair',
  hint: () => 'Tap a Fair segment to add it to the Primary — tap again to remove it',
  beginGesture: () => null,
};
