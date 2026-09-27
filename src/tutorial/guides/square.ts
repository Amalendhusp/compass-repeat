// Phase 5.7: the Square Beginner Guide — frame, construction, Point Targets and Visibility,
// Divide, Fair, Fill, Select, then Repeat into a finished tessellation. Every step is a short
// script over the live app (see ../engine.ts): it finds the real controls and the real geometry
// by position — never by stored ids, which differ from one demonstration to the next.

import type { Guide, GuideContext } from '../engine.ts';
import type { Vec2 } from '../../model/types.ts';
import { resolvePoint } from '../../geometry/kernel.ts';

const dock = (ctx: GuideContext, label: string) => ctx.find('.dock button', label);
const canvasArea = (ctx: GuideContext) => ctx.host.root.querySelector('canvas.stage');
const ribbon = () => document.querySelector('.context-bar:not(.hidden)');
const mid = (a: Vec2, b: Vec2, k = 0.5): Vec2 => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
const centroid = (...ps: Vec2[]): Vec2 => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length });

/** The square's corners and centre on screen (canvas-local), named by where they appear. */
function square(ctx: GuideContext) {
  const doc = ctx.controller().doc;
  const corners = doc.points.filter((p) => p.kind === 'frame-vertex').map((p) => ctx.toScreen(resolvePoint(doc, p.id)));
  const by = (f: (p: Vec2) => number, max: boolean) => corners.reduce((best, p) => ((max ? f(p) > f(best) : f(p) < f(best)) ? p : best));
  return {
    tl: by((p) => p.x + p.y, false),
    br: by((p) => p.x + p.y, true),
    tr: by((p) => p.x - p.y, true),
    bl: by((p) => p.x - p.y, false),
    c: ctx.toScreen(doc.frame.origin),
  };
}

/** Every point along the bottom edge, left to right: its corners and the division points. */
function bottomEdge(ctx: GuideContext): Vec2[] {
  const doc = ctx.controller().doc;
  const { bl, br } = square(ctx);
  const onEdge = doc.points
    .filter((p) => p.kind === 'division')
    .map((p) => ctx.toScreen(resolvePoint(doc, p.id)))
    .filter((p) => Math.abs(p.y - bl.y) < 2 && p.x > bl.x + 1 && p.x < br.x - 1);
  return [bl, ...onEdge.sort((a, b) => a.x - b.x), br];
}


function toggleRow(label: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('.popover-menu .popover-toggle-row')].find((r) => r.querySelector('.popover-row-label')?.textContent === label) ?? null;
}

export const squareGuide: Guide = {
  id: 'square-beginner',
  title: 'Beginner Guide',
  steps: [
    {
      title: 'Choose a frame',
      text: 'Start with a frame. Choose Square to define your working area.',
      controls: (ctx) => [ctx.find('.frame-option', 'Square')],
      areas: (ctx) => [canvasArea(ctx)],
      async run(ctx) {
        await ctx.press(ctx.find('.frame-option', 'Square'));
        await ctx.wait(500);
        // Draw it: touch the centre, drag toward a corner — diagonally, so the square sits level.
        const cv = ctx.canvas();
        const top = cv.getBoundingClientRect().top;
        const r = Math.min(cv.clientWidth * 0.34, window.innerHeight * 0.16);
        const c = { x: cv.clientWidth / 2, y: window.innerHeight * 0.47 - top };
        const d = r / Math.SQRT2;
        await ctx.drag([c, { x: c.x + d * 0.5, y: c.y + d * 0.5 }, { x: c.x + d, y: c.y + d }], { duration: 1100 });
      },
    },
    {
      title: 'Draw construction lines',
      text: 'Build with construction lines. Choose Line, then tap two points to connect them.',
      controls: (ctx) => [dock(ctx, 'Line')],
      areas: (ctx) => [canvasArea(ctx)],
      async run(ctx) {
        await ctx.press(dock(ctx, 'Line'));
        let s = square(ctx);
        await ctx.tap(s.tl);
        await ctx.tap(s.br);
        await ctx.wait(400);
        s = square(ctx);
        await ctx.tap(s.tr);
        await ctx.tap(s.bl);
      },
    },
    {
      title: 'Point Targets',
      text: 'Point Targets control which points you can use.',
      micro: ['Primary = intersections, centres, frame vertices', 'Derived = midpoints and division points', 'Free on curve = create a new point anywhere on existing geometry'],
      controls: (ctx) => [ctx.find('[aria-label^="Point targets"]')],
      areas: (ctx) => [canvasArea(ctx)],
      async run(ctx) {
        const btn = ctx.find('[aria-label^="Point targets"]');
        await ctx.press(btn);
        await ctx.wait(500);
        for (const [i, label] of ['Primary', 'Derived', 'Free on curve'].entries()) {
          ctx.spot([toggleRow(label)]);
          ctx.reveal(i);
          await ctx.wait(1700);
        }
        ctx.spot([]);
        // Free on curve stays off: new points only where something real already exists.
        await ctx.press(btn);
      },
    },
    {
      title: 'Point Visibility',
      text: 'Point Visibility controls which nodes you see while you work.',
      micro: ['Near finger · Used · All — or hide points altogether'],
      controls: (ctx) => [ctx.find('[aria-label^="Point visibility"]')],
      areas: (ctx) => [canvasArea(ctx)],
      async run(ctx) {
        const btn = ctx.find('[aria-label^="Point visibility"]');
        await ctx.press(btn);
        await ctx.wait(400);
        ctx.reveal(0);
        await ctx.press(ctx.find('.popover-menu button', 'All'));
        await ctx.wait(1200);
        await ctx.press(ctx.find('.popover-menu button', 'Near finger'));
        await ctx.wait(700);
        await ctx.press(btn);
      },
    },
    {
      title: 'Divide',
      text: 'Create equal divisions. Select geometry, choose the number of parts, then Apply.',
      controls: (ctx) => [dock(ctx, 'Divide')],
      areas: (ctx) => [canvasArea(ctx), ribbon()],
      async run(ctx) {
        ctx.controller().doc.dividePrefs.lastN = 4;
        await ctx.press(dock(ctx, 'Divide'));
        const s = square(ctx);
        await ctx.tap(mid(s.bl, s.br, 0.38));
        await ctx.wait(800);
        await ctx.press(ctx.find('.context-bar button', 'More parts'));
        await ctx.wait(800);
        await ctx.press(ctx.find('.context-bar button', 'More parts'));
        await ctx.wait(900);
        await ctx.press(ctx.find('.context-bar button', 'Apply'));
      },
    },
    {
      title: 'Develop the construction',
      text: 'Use the new points to develop the motif. Construction lines are working geometry.',
      controls: (ctx) => [dock(ctx, 'Line')],
      areas: (ctx) => [canvasArea(ctx)],
      async run(ctx) {
        await ctx.press(dock(ctx, 'Line'));
        for (const k of [1, 3, 5]) {
          const edge = bottomEdge(ctx);
          const target = edge[k];
          if (!target) break;
          await ctx.tap(square(ctx).c);
          await ctx.tap(target);
          await ctx.wait(250);
        }
      },
    },
    {
      title: 'Fair the design',
      text: 'Construction helps you build. Fair defines the design.',
      controls: (ctx) => [dock(ctx, 'Fair')],
      areas: (ctx) => [canvasArea(ctx)],
      async run(ctx) {
        await ctx.press(dock(ctx, 'Fair'));
        const s = square(ctx);
        const edge = bottomEdge(ctx);
        const runs: [Vec2, Vec2][] = [
          [s.tl, s.tr],
          [s.tr, s.br],
          [s.tl, s.bl],
          [s.bl, s.br],
          [s.c, s.tl],
          [s.c, s.tr],
          [s.c, s.bl],
          [s.c, s.br],
          ...[1, 3, 5].filter((k) => edge[k]).map((k): [Vec2, Vec2] => [s.c, edge[k]!]),
        ];
        // Phase 5.9: Fair is traced — press on a line, drag along it, release.
        for (const [a, b] of runs) await ctx.drag([mid(a, b, 0.04), mid(a, b, 0.5), mid(a, b, 0.97)]);
      },
    },
    {
      title: 'Fill',
      text: 'Closed Fair boundaries can hold colour.',
      controls: (ctx) => [dock(ctx, 'Fill')],
      areas: (ctx) => [canvasArea(ctx), ribbon()],
      async run(ctx) {
        await ctx.press(dock(ctx, 'Fill'));
        const colour = async (name: string) => {
          await ctx.press(ctx.find('.context-bar .chip', 'Colour'));
          await ctx.wait(350);
          await ctx.press(ctx.find('.popover-menu .swatch', name));
          await ctx.wait(300);
        };
        await colour('Lapis & Zellige');
        const s = square(ctx);
        await ctx.tap(centroid(s.tl, s.tr, s.c));
        await ctx.wait(500);
        await colour('Terracotta');
        const edge = bottomEdge(ctx);
        if (edge[3]) {
          await ctx.tap(centroid(s.c, edge[1]!, edge[3]));
          if (edge[5]) await ctx.tap(centroid(s.c, edge[3], edge[5]), { fast: true });
        }
      },
    },
    {
      title: 'Select and edit',
      text: 'Use Select when you want to edit existing geometry or design.',
      controls: (ctx) => [dock(ctx, 'Select')],
      areas: (ctx) => [canvasArea(ctx), ribbon()],
      async run(ctx) {
        await ctx.press(dock(ctx, 'Select'));
        const s = square(ctx);
        await ctx.tap(centroid(s.tl, s.tr, s.c));
        await ctx.wait(600);
        await ctx.press(ctx.find('.context-bar .chip', 'Colour'));
        await ctx.wait(400);
        // The first row is the region's own fill.
        const row = document.querySelector('.popover-menu .swatch-row');
        await ctx.press(row ? [...row.querySelectorAll<HTMLElement>('.swatch')].find((b) => b.getAttribute('aria-label') === 'Athangudi') : null);
        await ctx.wait(500);
        // Done: tap clear of the drawing to put the selection down.
        const cv = ctx.canvas();
        await ctx.tap({ x: cv.clientWidth * 0.12, y: s.tl.y - 40 > 20 ? s.tl.y - 40 : 30 });
      },
    },
    {
      title: 'Repeat',
      text: 'Turn one motif into a pattern.',
      controls: (ctx) => [ctx.find('.topbar button', 'Repeat')],
      areas: (ctx) => [canvasArea(ctx), document.querySelector('.repeat-panel')],
      async run(ctx) {
        await ctx.press(ctx.find('.topbar button', 'Repeat'));
        await ctx.wait(700);
        // Step back far enough to see the neighbours and both lattice handles.
        await ctx.press(ctx.find('button', 'Fit drawing to screen'));
      },
    },
    {
      title: 'Adjust spacing',
      text: 'Move neighbouring copies until the pattern feels right.',
      areas: (ctx) => [canvasArea(ctx)],
      async run(ctx) {
        const doc = ctx.controller().doc;
        const pivot = doc.frame.origin;
        const corners = doc.points.filter((p) => p.kind === 'frame-vertex').map((p) => resolvePoint(doc, p.id));
        const side = Math.hypot(corners[1]!.x - corners[0]!.x, corners[1]!.y - corners[0]!.y);
        for (const dir of ['a', 'b'] as const) {
          const v = ctx.controller().doc.repeat[dir];
          const len = Math.hypot(v.x, v.y);
          const from = ctx.toScreen({ x: pivot.x + v.x, y: pivot.y + v.y });
          // Just past edge-to-edge: the real contact snap takes it the rest of the way.
          const k = (side * 1.02) / len;
          const to = ctx.toScreen({ x: pivot.x + v.x * k, y: pivot.y + v.y * k });
          await ctx.drag([from, mid(from, to, 0.6), to], { duration: 1200 });
          await ctx.wait(500);
        }
        await ctx.press(ctx.find('button', 'Fit drawing to screen'));
      },
    },
    {
      title: 'Explore and finish',
      text: 'Explore the arrangement, then hide the guide to see the finished pattern.',
      controls: () => [document.querySelector('.repeat-panel .segmented-mini:nth-of-type(2)') ?? null, document.querySelector('[aria-label="Grid and guides"]')],
      areas: (ctx) => [canvasArea(ctx)],
      async run(ctx) {
        for (const rule of ['Alternate', 'Mirror', 'Same']) {
          await ctx.press(ctx.find('.repeat-panel button', rule));
          await ctx.wait(rule === 'Same' ? 600 : 1300);
        }
        const guides = ctx.find('[aria-label="Grid and guides"]');
        await ctx.press(guides);
        await ctx.wait(450);
        for (const label of ['Handles', 'Motif boundary', 'Grid']) {
          const sw = toggleRow(label)?.querySelector('.toggle-switch') ?? null;
          if (!sw?.classList.contains('on')) continue;
          ctx.spot([toggleRow(label)]);
          await ctx.press(sw);
          await ctx.wait(450);
        }
        ctx.spot([]);
        await ctx.press(guides);
      },
    },
  ],
  finale: {
    title: 'You made your first repeating pattern.',
    text: 'Try it yourself with a new frame, or close the guide to return to your work.',
  },
};
