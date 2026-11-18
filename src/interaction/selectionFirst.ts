// Selection first: what a selection made with Select means to the tool chosen next. The answer is
// always the same first input the tool would take from a tap, so "select, then choose the tool" and
// "choose the tool, then tap" reach the same step.
//
// Nothing is ever made here. A tool that needs a second input waits for it (Line's B, Circle's radius,
// Arc's B or the arc itself), and Divide only shows its preview until Apply.

import type { Doc, Entity, PointId } from '../model/types.ts';
import type { CircleVariant, DivideTarget, SelectCandidate, ToolId } from '../app/controller.ts';
import { parentTarget } from './divideTarget.ts';

export type SelectionStart =
  /** Line: the point is A. */
  | { kind: 'line'; point: PointId }
  /** Circle (By radius): the point is the centre. */
  | { kind: 'circle'; point: PointId }
  /** Arc (Measure radius): the point is A — the next point measures the radius. */
  | { kind: 'arc-measure'; point: PointId }
  /** Arc (Same radius): the compass opens on the point with the last radius. */
  | { kind: 'arc-compass'; point: PointId; radius: number }
  /** Divide: the selected line, arc, circle or segment is the target — previewed, not applied. */
  | { kind: 'divide'; target: DivideTarget }
  /** The selection stays as it is (a point under Divide, as before). */
  | { kind: 'keep' }
  /** The selection can't start this tool: it is cleared and the message says what to tap instead. */
  | { kind: 'reject'; message: string }
  /** Nothing to carry over (no selection, or a tool that never takes one). */
  | null;

export interface ToolModes {
  circleVariant: CircleVariant;
  arcMode: 'measure' | 'same';
  lastRadius: number | null;
}

/** What the selection starts in `tool`. Only in Construct — Intersect's Select arranges copies. */
export function selectionStart(doc: Doc, tool: ToolId, selection: SelectCandidate[], modes: ToolModes): SelectionStart {
  if (selection.length === 0 || doc.view.workspace !== 'construct') return null;
  const one = selection.length === 1 ? selection[0]! : null;
  const point = one?.kind === 'point' && doc.points.some((p) => p.id === one.id) ? one.id : null;

  switch (tool) {
    case 'line':
      return point ? { kind: 'line', point } : { kind: 'reject', message: 'Line starts from a point — tap one' };
    case 'circle':
      if (modes.circleVariant === 'three-lines') return { kind: 'reject', message: 'Between edges starts from lines — tap the edges' };
      if (modes.circleVariant === 'copy-radius') return { kind: 'reject', message: 'Copy circle starts from a circle — tap one' };
      return point ? { kind: 'circle', point } : { kind: 'reject', message: 'Circle starts from a centre point — tap one' };
    case 'arc':
      if (!point) return { kind: 'reject', message: 'Arc starts from a point — tap one' };
      return modes.arcMode === 'same' && modes.lastRadius ? { kind: 'arc-compass', point, radius: modes.lastRadius } : { kind: 'arc-measure', point };
    case 'divide': {
      if (point) return { kind: 'keep' };
      const target = one ? divideTargetOf(doc, one) : null;
      return target ? { kind: 'divide', target } : { kind: 'reject', message: 'Divide works on one line, arc or circle — tap one' };
    }
    default:
      return null;
  }
}

/** The Divide target a single selected segment, run, line or circle stands for — exactly what a tap
 * in Divide would target (a segment between crossings, or the whole line / arc / circle). */
function divideTargetOf(doc: Doc, c: SelectCandidate): DivideTarget | null {
  const entityOf = (id: string): Entity | undefined => doc.entities.find((e) => e.id === id);
  if (c.kind === 'entity') {
    const e = entityOf(c.entityId);
    return e ? parentTarget(doc, e) : null;
  }
  if (c.kind === 'segment') {
    const e = entityOf(c.entityId);
    if (!e) return null;
    // A run all the way round a circle is the circle itself.
    if (c.from === c.to) return parentTarget(doc, e);
    return { label: 'Segment', scope: 'segment', entityId: e.id, kind: 'segment', from: c.from, to: c.to, fromParam: c.fromParam, toParam: c.toParam };
  }
  return null;
}
