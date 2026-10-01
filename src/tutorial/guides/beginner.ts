// vNext Phase 3: the Beginner Guide — eight short steps on a practice Square: construct (Line,
// Circle, Divide, then build on a new point), define the design (Fair, Fill), Repeat it, and share
// it. The learner does each step with the real tools; each one is recognised from what the app
// itself committed (see ../engine.ts). The only geometry provided is the Square frame — the same
// frame a student gets from the Start screen; every closed shape that Fill needs comes from the
// learner's own Fair strokes (the square's four edges always make one).

import type { CoachStep, Guide, StepContext } from '../engine.ts';
import type { Doc, Entity, PointId } from '../../model/types.ts';
import { createDoc, placeFrame } from '../../model/doc.ts';
import { resolvePoint } from '../../geometry/kernel.ts';
import { computeFairRegions, pointInPolygon } from '../../geometry/regions.ts';

const dock = (ctx: StepContext, label: string) => ctx.find('.dock button', label);
const ribbonButton = (ctx: StepContext, text: string) => ctx.find('.context-bar button', text);

/** Entities in the current document that weren't there when the step began. */
function newEntities(ctx: StepContext, kind?: Entity['kind']): Entity[] {
  const before = new Set(ctx.start.entities.map((e) => e.id));
  return ctx.controller.doc.entities.filter((e) => !before.has(e.id) && (!kind || e.kind === kind));
}

const divisionIds = (doc: Doc): Set<PointId> => new Set(doc.points.filter((p) => p.kind === 'division').map((p) => p.id));
const fairCount = (doc: Doc) => [...doc.segmentStates.values()].filter((s) => s.state === 'fair').length;
const fillCount = (doc: Doc) => doc.fills.get(doc.activeColourway)?.size ?? 0;
const definingPoints = (e: Entity): PointId[] => (e.kind === 'line' ? [e.a, e.b] : [e.centre, e.through]);

/** "Tap X" while the tool isn't chosen yet; the step's own instruction once it is. */
function withTool(ctx: StepContext, tool: string, label: string, lead: string, then: () => ReturnType<CoachStep['view']>): ReturnType<CoachStep['view']> {
  if (ctx.controller.doc.view.workspace !== 'construct') return { text: 'Go back to Construct.', targets: [ctx.find('.topbar button', 'Construct')] };
  if (ctx.controller.tool !== tool) return { text: `${lead}Tap ${label}.`, targets: [dock(ctx, label)] };
  return then();
}

const line: CoachStep = {
  label: 'Line',
  success: 'Line drawn',
  view: (ctx) =>
    withTool(ctx, 'line', 'Line', 'This square is your practice frame. Build with geometric construction. ', () =>
      ctx.controller.pending?.kind === 'line'
        ? { text: 'Now tap a second point.' }
        : { text: 'Tap two points to draw a line between them.', spots: framePoints(ctx.controller.doc) },
    ),
  done: (ctx) => newEntities(ctx, 'line').length > 0,
};

const circle: CoachStep = {
  label: 'Circle',
  success: 'Circle made',
  begin(ctx) {
    // Teach the default mode only; the other two are left for later.
    if (ctx.controller.circleVariant !== 'centre-radius') {
      ctx.controller.circleVariant = 'centre-radius';
      ctx.controller.notify();
    }
  },
  view(ctx) {
    const c = ctx.controller;
    return withTool(ctx, 'circle', 'Circle', '', () =>
      c.circleVariant !== 'centre-radius'
        ? { text: 'Choose By radius.', targets: [ribbonButton(ctx, 'By radius')] }
        : { text: 'Press on a point for the centre, drag to set the radius, then release.', spots: c.pending ? [] : usablePoints(c.doc) },
    );
  },
  done: (ctx) => newEntities(ctx, 'circle').length > 0,
};

const divide: CoachStep = {
  label: 'Divide',
  success: 'New points made',
  view: (ctx) =>
    withTool(ctx, 'divide', 'Divide', 'Construction can make new points. ', () =>
      ctx.controller.divide
        ? { text: 'Choose how many parts, then Apply.', targets: [ribbonButton(ctx, 'Apply')] }
        : { text: 'Tap a line or circle to divide it into equal parts.' },
    ),
  done: (ctx) => divisionIds(ctx.controller.doc).size > divisionIds(ctx.start).size,
};

const buildOn: CoachStep = {
  label: 'Build on it',
  success: 'Built on a new point',
  view(ctx) {
    const doc = ctx.controller.doc;
    const spots = [...divisionIds(doc)].map((id) => resolvePoint(doc, id));
    if (doc.view.workspace !== 'construct') return { text: 'Go back to Construct.', targets: [ctx.find('.topbar button', 'Construct')] };
    if (ctx.controller.tool !== 'line' && ctx.controller.tool !== 'circle') {
      return { text: 'Constructions build on constructions. Tap Line or Circle.', targets: [dock(ctx, 'Line'), dock(ctx, 'Circle')], spots };
    }
    const elsewhere = newEntities(ctx).length > 0;
    return { text: elsewhere ? 'Good — now start one at a new division point.' : 'Draw from one of the new division points.', spots };
  },
  done(ctx) {
    const divisions = divisionIds(ctx.controller.doc);
    return newEntities(ctx).some((e) => definingPoints(e).some((id) => divisions.has(id)));
  },
};

const fair: CoachStep = {
  label: 'Fair',
  success: 'A closed shape is Fair',
  view: (ctx) =>
    withTool(ctx, 'fair', 'Fair', 'Construction helps you build. Fair defines the design. ', () =>
      fairCount(ctx.controller.doc) === 0
        ? { text: 'Drag along a line to make it part of the design.' }
        : { text: 'Keep going until a shape is closed — the square’s four edges make one.' },
    ),
  done: (ctx) => fairCount(ctx.controller.doc) > 0 && computeFairRegions(ctx.controller.doc).length > 0,
};

const fill: CoachStep = {
  label: 'Fill',
  success: 'Filled',
  view(ctx) {
    const doc = ctx.controller.doc;
    const spots = computeFairRegions(doc)
      .filter((r) => !doc.fills.get(doc.activeColourway)?.has(r.sig) && pointInPolygon(r.samplePoints, r.centroid))
      .map((r) => r.centroid);
    return withTool(ctx, 'fill', 'Fill', '', () => ({ text: 'Tap inside a closed Fair shape to colour it.', spots }));
  },
  done: (ctx) => fillCount(ctx.controller.doc) > fillCount(ctx.start),
};

const repeat: CoachStep = {
  label: 'Repeat',
  success: 'Your pattern is spaced',
  view(ctx) {
    const c = ctx.controller;
    const doc = c.doc;
    if (doc.view.workspace !== 'repeat') return { text: 'Turn your design into a pattern. Tap Repeat.', targets: [ctx.find('.topbar button', 'Repeat')] };
    // What "moved" is measured from: the spacing as Repeat first showed it — and again after any
    // lattice switch (Square / Triangle / Hexagon), which resets the spacing itself. Only the
    // handles change the spacing within one lattice.
    if (ctx.memo.family !== doc.repeat.family) {
      ctx.memo.family = doc.repeat.family;
      ctx.memo.base = spacing(doc);
    }
    if (!doc.repeatDisplay.handles) return { text: 'Show the handles: Grid and guides → Handles.', targets: [ctx.find('[aria-label="Grid and guides"]')] };
    const o = doc.frame.origin;
    const handles = [doc.repeat.a, doc.repeat.b].map((v) => ({ x: o.x + v.x, y: o.y + v.y }));
    return { text: 'Drag a handle to space the copies — they lock where edges meet.', spots: c.repeatDrag ? [] : handles };
  },
  done(ctx) {
    const doc = ctx.controller.doc;
    return doc.view.workspace === 'repeat' && !ctx.controller.repeatDrag && ctx.memo.family === doc.repeat.family && ctx.memo.base !== spacing(doc);
  },
};

const spacing = (doc: Doc) => JSON.stringify([doc.repeat.a, doc.repeat.b]);

const sharePanelOpen = () => [...document.querySelectorAll('.popover-menu.panel .popover-section-label')].some((l) => l.textContent === 'Share current view');

const share: CoachStep = {
  label: 'Share',
  success: '',
  view(ctx) {
    if (sharePanelOpen()) ctx.memo.opened = true;
    if (!ctx.memo.opened) return { text: 'Share your pattern. Tap Share.', targets: [ctx.find('[aria-label="Share"]')] };
    const formats = document.querySelector('.popover-menu.panel .panel-inline-row .segmented-mini');
    return { text: 'PNG is an image. SVG is an editable vector that scales to any size.', targets: sharePanelOpen() ? [formats] : [] };
  },
  continueLabel: (ctx) => (ctx.memo.opened ? 'Continue' : null),
  done: (ctx) => ctx.continued,
};

/** Every point a construction can start from (not a circle's hidden internal point). */
function usablePoints(doc: Doc) {
  return doc.points.filter((p) => !(p.kind === 'free' && p.hidden)).map((p) => resolvePoint(doc, p.id));
}

/** The square's corners and centre — the points there are to start from. */
function framePoints(doc: Doc) {
  return doc.points.filter((p) => p.kind === 'frame-vertex' || p.id === doc.frame.centreId).map((p) => resolvePoint(doc, p.id));
}

export const beginnerGuide: Guide = {
  title: 'Beginner Guide',
  practice() {
    const doc = createDoc('square', 'Beginner Guide practice');
    // A level square (corners at 45°), the same frame Choose a frame → Square makes.
    placeFrame(doc, { x: 0, y: 0 }, 100, Math.PI / 4);
    return doc;
  },
  steps: [line, circle, divide, buildOn, fair, fill, repeat, share],
  finale: 'You built, defined and repeated a design.',
};
