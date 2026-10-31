import type { AppController, PointVisibility, SelectCandidate, ToolId, ViewTransform } from '../app/controller.ts';
import { unturned } from '../app/controller.ts';
import type { Doc, Entity, EntityId, PointId, SegmentKey, Vec2 } from '../model/types.ts';
import {
  addCircleDivision,
  addSegmentDivisionPoints,
  applyDeletionPlan,
  applyPointDeletionPlan,
  computeEntitiesDeletionPlan,
  computePointDeletionPlan,
  ensureCircleSegments,
  getRegionFill,
  pointDependents,
  promoteEntityToFair,
  removeRegionFill,
  setRegionFill,
  setEntityColour,
  setSegmentFair,
  setSegmentStroke,
  trimSegment,
  type DeletionPlan,
} from '../model/doc.ts';
import { colourAlpha, colourRgb, withAlpha } from '../model/colour.ts';
import { isEditablePointKind } from '../geometry/usage.ts';
import { entityKeys, isUniformlyFair } from '../interaction/hittest.ts';
import { dividePreviewPoints, setDivideTarget } from '../interaction/tools/divide.ts';
import { axisThrough } from '../interaction/tools/line.ts';
import { settleReferenceWheel } from '../interaction/referenceTransform.ts';
import { removeSelectedAnchor } from '../interaction/tools/anchorTool.ts';
import { iconSvg, type IconName } from './icons.ts';
import { showToast } from './toast.ts';
import { describeGap } from '../interaction/closeGapMode.ts';
import { isInConfirmLayer, openConfirmSheet } from './confirmsheet.ts';
import { onTap } from './tap.ts';
import { color, fairPalette, stroke } from '../render/tokens.ts';
import { suggestedFamily, type LatticeFamily } from '../geometry/lattice.ts';
import { rotationFractionLabel } from '../render/repeatRenderer.ts';
import { inComposition, withPrimaryCopy, withArrangement, asReference, intersectionCopies, layoutOf, MAX_CONSTRUCTIONS, placedAt, PRIMARY, referenceCurrent, sliderToSpread, SPREAD_SLIDER_MAX, spreadToSlider, withAddedCopy, withCopySetting, withLayout, withLock, withoutCopy, withSpreadAround, isLocked } from '../geometry/intersection.ts';
import { canMoveAgainst, convertPick, isPointPick, planMatchEdge, planSnap, resolvePick, type PickKind } from '../geometry/intersectionSnap.ts';
import { PICK_REACH_PX } from '../interaction/tools/intersectionTool.ts';
import { repeatSource, type RepeatSource } from '../geometry/repeatUnit.ts';
import { repeatSourceOf, suggestForFamily, switchRepeatSource } from '../geometry/repeatSetup.ts';
import { repeatComposition } from '../geometry/repeatComposition.ts';
import { repeatFill, repeatPaint, repeatPaintOpacity } from '../interaction/tools/repeatTool.ts';
import { editableStroke, MAX_STROKE_PX, strokeKind, withColour, withKind, withWidth } from '../geometry/repeatStroke.ts';
import type { PatternBy } from '../geometry/repeatColour.ts';
import { artworksUsing, deleteReference, inLibrary, listReferences, setReferenceScope, type ReferenceRecord } from '../persist/referenceStore.ts';
import { importReference, ReferenceImportError } from '../reference/importReference.ts';
import { forgetUnderlayImage, initialUnderlay, onUnderlayImage, underlayImage, underlayViewOf, withUnderlayView } from '../render/underlay.ts';
import { intersectionThumbnail } from '../render/intersectionRenderer.ts';
import { genId } from '../model/id.ts';
import { CAPTURED_CUE_MS } from '../interaction/tools/arc.ts';
import { syncSnapChooser } from './snapchooser.ts';
import { deriveSelectableGroups } from '../geometry/segments.ts';
import { deliverFile, exportVisibleView, fileShareSupport, type ExportSettings } from '../render/export.ts';
import { createTimelapse, timelapseInfo, videoType, type TimelapseInfo, type TimelapseResult } from '../render/timelapse.ts';
import type { RepeatDisplay, RepeatStroke, RepeatStrokeLayer, RepeatSystem } from '../model/types.ts';

/** Phase 5.2 item 1: the final Construct dock. */
const DOCK_BUTTONS: { id: ToolId; label: string; divider?: boolean }[] = [
  { id: 'select', label: 'Select' },
  { id: 'circle', label: 'Circle' },
  { id: 'line', label: 'Line' },
  { id: 'arc', label: 'Arc' },
  { id: 'divide', label: 'Divide', divider: true },
  { id: 'fair', label: 'Fair' },
  { id: 'fill', label: 'Fill' },
];

const DIVIDE_MIN = 2;
const DIVIDE_MAX = 64;

/** Palette swatches plus a "Mine" custom colour, for any colour popover section. `extra` (e.g. No
 * fill) sits first. Swatches compare by #rrggbb, so a translucent fill still shows its colour. */
function colourSwatchRow(menu: HTMLElement, current: string | null, onPick: (colour: string | null) => void, extra?: { label: string; value: null; swatch?: string }): void {
  const row = document.createElement('div');
  row.className = 'swatch-row';
  const swatches: HTMLButtonElement[] = [];
  let active = current ? colourRgb(current).toLowerCase() : null;
  const refresh = () => swatches.forEach((el) => el.classList.toggle('active', (el.dataset.colour ?? null) === active));
  if (extra) {
    const none = document.createElement('button');
    none.className = extra.swatch ? 'swatch swatch-default' : 'swatch swatch-none';
    if (extra.swatch) none.style.background = extra.swatch;
    none.setAttribute('aria-label', extra.label);
    none.title = extra.label;
    onTap(none, () => {
      active = null;
      refresh();
      onPick(null);
    });
    swatches.push(none);
    row.appendChild(none);
  }
  for (const p of fairPalette) {
    const sw = document.createElement('button');
    sw.className = 'swatch';
    sw.dataset.colour = p.colour.toLowerCase();
    sw.style.background = p.colour;
    sw.setAttribute('aria-label', p.name);
    sw.title = p.name;
    onTap(sw, () => {
      active = p.colour.toLowerCase();
      refresh();
      onPick(p.colour);
    });
    swatches.push(sw);
    row.appendChild(sw);
  }
  const customWrap = document.createElement('label');
  customWrap.className = 'swatch swatch-custom';
  customWrap.title = 'Mine';
  const input = document.createElement('input');
  input.type = 'color';
  input.value = current && /^#[0-9a-f]{6}$/i.test(colourRgb(current)) ? colourRgb(current) : '#1e2a36';
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('input', () => {
    active = input.value.toLowerCase();
    refresh();
    onPick(input.value);
  });
  customWrap.appendChild(input);
  row.appendChild(customWrap);
  refresh();
  menu.appendChild(row);
}

/** A labelled slider row whose value commits on release (one undo step), previewing as it moves. */
function sliderRow(menu: HTMLElement, opts: { min: number; max: number; step: number; value: number; format: (v: number) => string; onCommit: (v: number) => void }): void {
  const row = document.createElement('div');
  row.className = 'popover-toggle-row';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(opts.min);
  slider.max = String(opts.max);
  slider.step = String(opts.step);
  slider.value = String(opts.value);
  slider.className = 'width-slider';
  const value = document.createElement('span');
  value.className = 'popover-row-label popover-value';
  value.textContent = opts.format(opts.value);
  slider.addEventListener('input', () => (value.textContent = opts.format(Number(slider.value))));
  slider.addEventListener('change', () => opts.onCommit(Number(slider.value)));
  row.appendChild(slider);
  row.appendChild(value);
  menu.appendChild(row);
}

function showColourPopover(anchor: HTMLElement, sections: { title: string; current: string | null; noFill?: boolean; defaultSwatch?: string; onPick: (colour: string | null) => void }[]): void {
  mountPopover(anchor, (menu) => {
    for (const s of sections) {
      popoverSectionLabel(menu, s.title);
      // C1: `defaultSwatch` offers "Default" — back to the default colour, shown as that colour.
      const extra = s.noFill ? { label: 'No fill', value: null } : s.defaultSwatch ? { label: 'Default', value: null, swatch: s.defaultSwatch } : undefined;
      colourSwatchRow(menu, s.current, s.onPick, extra);
    }
  });
}

function showSliderPopover(anchor: HTMLElement, title: string, opts: Parameters<typeof sliderRow>[1]): void {
  mountPopover(anchor, (menu) => {
    popoverSectionLabel(menu, title);
    sliderRow(menu, opts);
  });
}


/** Mounts an anchored popover shell (positioning, outside-tap dismissal, single-instance),
 * leaving the caller to fill in `menu`. Phase 5.3 item 1: it remembers which control opened it, so
 * that control can close it again (togglePanel) — a tap on that same control is therefore NOT an
 * "outside" tap. Any other tap — another control, the canvas, anywhere — closes it. */
let closeOpenPopover: (() => void) | null = null;
let openPopoverAnchor: HTMLElement | null = null;

function mountPopover(anchor: HTMLElement, fill: (menu: HTMLElement, close: () => void) => void, opts: { shieldCanvas?: boolean; panel?: boolean } = {}): void {
  // Close (not just remove) any popover already open, so its outside-tap listener goes with it.
  closeOpenPopover?.();
  const menu = document.createElement('div');
  menu.className = 'popover-menu' + (opts.panel ? ' panel' : '');

  function onOutside(e: PointerEvent): void {
    const target = e.target as Node;
    if (menu.contains(target) || anchor.contains(target)) return;
    // A confirmation the panel asked for (Delete) sits above it; answering it keeps the panel.
    if (isInConfirmLayer(target)) return;
    // Phase 5.1 item 12: a tap on the canvas that only dismisses a panel must not also act on the
    // artwork underneath it.
    if (opts.shieldCanvas && e.target instanceof HTMLCanvasElement) e.stopPropagation();
    close();
  }
  function close(): void {
    menu.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    anchor.classList.remove('panel-open');
    if (closeOpenPopover === close) {
      closeOpenPopover = null;
      openPopoverAnchor = null;
    }
  }
  closeOpenPopover = close;
  openPopoverAnchor = anchor;
  anchor.classList.add('panel-open');

  fill(menu, close);
  document.body.appendChild(menu);

  const anchorRect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = anchorRect.left + anchorRect.width / 2 - menuRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
  let top = anchorRect.top - menuRect.height - 10;
  if (top < 8) top = anchorRect.bottom + (opts.panel ? 4 : 10);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
}

/** Phase 5.3 item 1: the top-bar contextual controls are true toggles — the same control opens
 * and closes its panel; a different one swaps panels (the outside tap closes, its own tap opens). */
function togglePanel(anchor: HTMLElement, open: () => void): void {
  if (openPopoverAnchor === anchor) {
    closeOpenPopover?.();
    return;
  }
  open();
}

export function closeAnyPopover(): void {
  closeOpenPopover?.();
}

/** A small anchored flat-list menu, dismissed on an outside tap or a selection. Used by the
 * menu button (My Artworks, Save, Save as new, New artwork, Clear drawing). `title`, when given,
 * heads the list (the open artwork's name). */
function showPopover(anchor: HTMLElement, items: { label: string; active?: boolean; divided?: boolean; onSelect: () => void }[], title?: string, className?: string): void {
  mountPopover(anchor, (menu, close) => {
    if (className) menu.classList.add(className);
    if (title) popoverSectionLabel(menu, title);
    for (const item of items) {
      if (item.divided) {
        const divider = document.createElement('div');
        divider.className = 'popover-divider';
        menu.appendChild(divider);
      }
      const btn = document.createElement('button');
      btn.textContent = item.label;
      if (item.active) btn.classList.add('active');
      // Phase 5.2 item 28: a genuine tap on the item itself (see ui/tap.ts).
      onTap(btn, () => {
        close();
        item.onSelect();
      });
      menu.appendChild(btn);
    }
  });
}

/** A labelled on/off row in a popover; `refresh` re-reads `get()` so sibling rows can resync.
 * `help` is kept out of the layout (Phase 5.3 item 3) — a tooltip and accessible description. */
function popoverToggleRow(menu: HTMLElement, label: string, get: () => boolean, set: (on: boolean) => void, help?: string): { refresh: () => void } {
  const row = document.createElement('div');
  row.className = 'popover-toggle-row';
  if (help) row.title = help;
  const text = document.createElement('span');
  text.className = 'popover-row-label';
  text.textContent = label;
  const sw = document.createElement('button');
  sw.innerHTML = '<span class="toggle-knob"></span>';
  if (help) sw.setAttribute('aria-description', help);
  const refresh = () => {
    const on = get();
    sw.className = 'toggle-switch' + (on ? ' on' : '');
    sw.setAttribute('aria-label', `${label} ${on ? 'on' : 'off'}`);
    sw.setAttribute('aria-pressed', String(on));
  };
  sw.addEventListener('click', (e) => {
    e.stopPropagation();
    set(!get());
    refresh();
  });
  refresh();
  row.appendChild(text);
  row.appendChild(sw);
  menu.appendChild(row);
  return { refresh };
}

function popoverSectionLabel(menu: HTMLElement, text: string): void {
  const el = document.createElement('div');
  el.className = 'popover-section-label';
  el.textContent = text;
  menu.appendChild(el);
}

/** A compact segmented row inside a panel; returns a refresh for when the value changes elsewhere. */
function panelSegmented<T extends string>(parent: HTMLElement, options: { id: T; label: string }[], get: () => T, set: (id: T) => void, ariaLabel: string): { refresh: () => void; buttons: HTMLButtonElement[] } {
  const seg = document.createElement('div');
  seg.className = 'segmented-mini popover-segmented';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', ariaLabel);
  const buttons: HTMLButtonElement[] = [];
  const refresh = () => options.forEach((o, i) => buttons[i]!.classList.toggle('active', get() === o.id));
  for (const o of options) {
    const btn = document.createElement('button');
    btn.textContent = o.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      set(o.id);
      refresh();
    });
    buttons.push(btn);
    seg.appendChild(btn);
  }
  refresh();
  parent.appendChild(seg);
  return { refresh, buttons };
}

/** "Label ───●── 70%" on one line (Phase 5.3 item 5). `onCommit` runs once the thumb is let go. */
/**
 * A quiet vertical slider for the canvas's edge (0–1, bottom to top): a finger anywhere on its
 * track sets the value there and follows the drag; arrow keys step it. `icon` names it at the top.
 */
function verticalSlider(label: string, icon: string, min: number, get: () => number, set: (v: number) => void): { el: HTMLElement; refresh: () => void } {
  const el = document.createElement('div');
  el.className = 'vslider';
  const head = document.createElement('span');
  head.className = 'vslider-icon';
  head.innerHTML = icon;
  const track = document.createElement('div');
  track.className = 'vslider-track';
  track.tabIndex = 0;
  track.setAttribute('role', 'slider');
  track.setAttribute('aria-label', label);
  track.setAttribute('aria-orientation', 'vertical');
  track.setAttribute('aria-valuemin', String(Math.round(min * 100)));
  track.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('div');
  fill.className = 'vslider-fill';
  const thumb = document.createElement('div');
  thumb.className = 'vslider-thumb';
  track.appendChild(fill);
  track.appendChild(thumb);
  const value = document.createElement('span');
  value.className = 'vslider-value';
  el.appendChild(head);
  el.appendChild(track);
  el.appendChild(value);
  const show = (v: number) => {
    const pct = Math.round(v * 100);
    // The thumb travels within the track (its centre 9 px in from either end), never past it.
    fill.style.height = `calc(9px + ${v} * (100% - 18px))`;
    thumb.style.bottom = `calc(${v} * (100% - 18px))`;
    value.textContent = `${pct}%`;
    track.setAttribute('aria-valuenow', String(pct));
    track.setAttribute('aria-valuetext', `${pct}%`);
  };
  const clamp = (v: number) => Math.min(1, Math.max(min, Math.round(v * 100) / 100));
  const fromY = (clientY: number) => {
    const r = track.getBoundingClientRect();
    return clamp((r.bottom - 9 - clientY) / (r.height - 18));
  };
  let dragging: number | null = null;
  track.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = e.pointerId;
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer has nothing to capture */
    }
    const v = fromY(e.clientY);
    show(v);
    set(v);
  });
  track.addEventListener('pointermove', (e) => {
    if (dragging !== e.pointerId) return;
    const v = fromY(e.clientY);
    show(v);
    set(v);
  });
  const end = (e: PointerEvent) => {
    if (dragging === e.pointerId) dragging = null;
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('keydown', (e) => {
    const step = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key];
    const v = step !== undefined ? clamp(get() + step) : e.key === 'Home' ? min : e.key === 'End' ? 1 : null;
    if (v === null) return;
    e.preventDefault();
    show(v);
    set(v);
  });
  const refresh = () => show(get());
  refresh();
  return { el, refresh };
}

function panelSliderRow(menu: HTMLElement, label: string, opts: { min: number; max: number; step: number; value: number; format: (v: number) => string; onInput: (v: number) => void; onCommit?: (v: number) => void }): { slider: HTMLInputElement; value: HTMLSpanElement } {
  const row = document.createElement('div');
  row.className = 'popover-toggle-row panel-slider-row';
  const text = document.createElement('span');
  text.className = 'popover-row-label';
  text.textContent = label;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(opts.min);
  slider.max = String(opts.max);
  slider.step = String(opts.step);
  slider.value = String(opts.value);
  slider.className = 'width-slider';
  slider.setAttribute('aria-label', label);
  const value = document.createElement('span');
  value.className = 'popover-row-label popover-value';
  value.textContent = opts.format(opts.value);
  slider.addEventListener('input', (e) => {
    e.stopPropagation();
    value.textContent = opts.format(Number(slider.value));
    opts.onInput(Number(slider.value));
  });
  if (opts.onCommit) {
    slider.addEventListener('change', (e) => {
      e.stopPropagation();
      opts.onCommit!(Number(slider.value));
    });
  }
  row.appendChild(text);
  row.appendChild(slider);
  row.appendChild(value);
  menu.appendChild(row);
  return { slider, value };
}

const POINT_TARGET_ROWS: { key: keyof Doc['pointTargets']; label: string; hint: string }[] = [
  { key: 'primary', label: 'Primary', hint: 'Intersections · centres · frame vertices' },
  { key: 'derived', label: 'Derived', hint: 'Midpoints · division points' },
  { key: 'free', label: 'Free on curve', hint: 'Allow new points anywhere on geometry' },
];

/**
 * Phase 3.4 items 5–10: the Point Targets panel — what the geometry-creation tools may snap to
 * or materialize. Three independent toggles, each taking effect immediately. Deliberately
 * separate from Points shown: a category here governs eligibility to target/create, not what's
 * drawn. Phase 5.3: compact rows; each category's explanation is help text, not a layout line.
 */
function showPointTargetsPanel(anchor: HTMLElement, controller: AppController): void {
  mountPopover(
    anchor,
    (menu) => {
      popoverSectionLabel(menu, 'Point targets');
      for (const row of POINT_TARGET_ROWS) {
        popoverToggleRow(
          menu,
          row.label,
          () => controller.doc.pointTargets[row.key],
          (on) => controller.setPointTarget(row.key, on),
          row.hint,
        );
      }
    },
    { shieldCanvas: true, panel: true },
  );
}

const SHOWN_MODES: { id: Exclude<PointVisibility, 'none'>; label: string }[] = [
  { id: 'near-finger', label: 'Near finger' },
  { id: 'used', label: 'Used' },
  { id: 'all', label: 'All' },
];

/** Phase 5.3 items 1/6: Point Visibility as a panel like every other top-bar control — points
 * shown on/off, and which points while shown. `remembered` is the mode "on" restores. */
function showPointsPanel(anchor: HTMLElement, controller: AppController, remembered: { mode: Exclude<PointVisibility, 'none'> }): void {
  mountPopover(
    anchor,
    (menu) => {
      let modes: { refresh: () => void; buttons: HTMLButtonElement[] } | null = null;
      const refreshModes = () => {
        const off = controller.pointVisibility === 'none';
        modes?.buttons.forEach((b) => (b.disabled = off));
        modes?.refresh();
      };
      popoverToggleRow(
        menu,
        'Show points',
        () => controller.pointVisibility !== 'none',
        (on) => {
          if (!on) remembered.mode = controller.pointVisibility === 'none' ? remembered.mode : controller.pointVisibility;
          controller.pointVisibility = on ? remembered.mode : 'none';
          refreshModes();
          controller.notifyView();
        },
      );
      modes = panelSegmented(
        menu,
        SHOWN_MODES,
        () => (controller.pointVisibility === 'none' ? remembered.mode : controller.pointVisibility),
        (id) => {
          remembered.mode = id;
          controller.pointVisibility = id;
          controller.notifyView();
        },
        'Which points',
      );
      refreshModes();
      // Beginner display: construction near the current work stays clear, the rest fades right
      // back — nothing in the drawing changes, only how strongly it's shown.
      popoverToggleRow(
        menu,
        'Focus construction',
        () => controller.focusConstruction,
        (on) => {
          controller.focusConstruction = on;
          try {
            localStorage.setItem('cr.focusConstruction', on ? '1' : '0');
          } catch {
            // Not remembered in a private window; still applies now.
          }
          controller.notifyView();
        },
        'Keep construction near your work clear and fade the rest. Fair lines stay strong.',
      );
    },
    { shieldCanvas: true, panel: true },
  );
}

const REPEAT_BACKGROUNDS: { name: string; colour: string }[] = [
  { name: 'Plaster', colour: color.plaster },
  { name: 'Paper', colour: color.paper },
  { name: 'Well', colour: color.well },
  { name: 'Ink', colour: color.ink },
  ...fairPalette,
];

/** The Fair stroke colour and width the design mostly uses — where Repeat's Stroke style starts. */
function designStroke(doc: Doc): { colour: string; width: number } {
  const colours = new Map<string, number>();
  const widths = new Map<number, number>();
  for (const st of doc.segmentStates.values()) {
    if (st.state !== 'fair') continue;
    const c = st.stroke?.colour ?? color.ink;
    const w = st.stroke?.width ?? stroke.fairDefault;
    colours.set(c, (colours.get(c) ?? 0) + 1);
    widths.set(w, (widths.get(w) ?? 0) + 1);
  }
  const most = <K,>(m: Map<K, number>, fallback: K): K => [...m].reduce<[K, number]>((best, e) => (e[1] > best[1] ? e : best), [fallback, 0])[0];
  return { colour: most(colours, color.ink as string), width: most(widths, stroke.fairDefault) };
}

/** Which part of Repeat's Appearance panel was last open (session). */
let appearanceTab: 'fill' | 'stroke' | 'background' = 'stroke';
/** Repeat Fill's scopes: a space between motifs, a region in every copy, or in the second group. */
type FillScope = 'space' | 'motif' | 'pattern';
/** The scope Fill returns to (session). */
let lastFillScope: FillScope = 'motif';
/** Which stroke layer's colours are showing in the panel (session). */
let strokeSwatchesOpen: number | null = null;

/**
 * Repeat's Appearance — how the repeated design is drawn, never what it is: three independent
 * parts, one at a time in a compact panel. Fill: Repeat's own region colours (a mode on the
 * canvas — "Colour regions") and how strongly fills are drawn. Stroke: the outlines. Background:
 * the colour behind the pattern. Nothing here changes the construction or its own styling.
 */
function showRepeatAppearancePanel(anchor: HTMLElement, controller: AppController, hooks: { startFill: () => void; scope: () => FillScope | null }): void {
  const display = (): RepeatDisplay => controller.doc.repeatDisplay;
  const changed = () => controller.notifyView();

  mountPopover(
    anchor,
    (panel) => {
      panel.classList.add('appearance-panel');
      panelSegmented(
        panel,
        [
          { id: 'fill' as const, label: 'Fill' },
          { id: 'stroke' as const, label: 'Stroke' },
          { id: 'background' as const, label: 'Background' },
        ],
        () => appearanceTab,
        (id) => {
          appearanceTab = id;
          build();
        },
        'Appearance',
      );
      const body = document.createElement('div');
      body.className = 'appearance-body';
      panel.appendChild(body);
      const build = () => {
        body.replaceChildren();
        if (appearanceTab === 'stroke') buildStroke(body);
        else if (appearanceTab === 'background') buildBackground(body);
        else buildFill(body);
      };

      const buildStroke = (menu: HTMLElement) => {
        // Stroke: Repeat's own outline style for every line of the repeated design — As designed
        // (each line's own Construct colour and width), or one, two or three strokes along the same
        // paths (geometry untouched). Each choice is one Undo step; a width slider shows its change
        // live and commits it on release.
        popoverSectionLabel(menu, 'Stroke');
        const design: RepeatStrokeLayer = designStroke(controller.doc);
        const current = (): RepeatStroke => controller.repeatStrokeDraft ?? editableStroke(controller.doc, design);
        const commitStroke = (next: RepeatStroke) => {
          controller.repeatStrokeDraft = null;
          controller.commit((d) => {
            d.repeatSetup = { ...(d.repeatSetup ?? { source: repeatSource(d) }), stroke: next };
          });
        };
        panelSegmented(
          menu,
          [
            { id: 'designed' as const, label: 'As designed' },
            { id: 'single' as const, label: 'Single' },
            { id: 'double' as const, label: 'Double' },
            { id: 'triple' as const, label: 'Triple' },
          ],
          () => strokeKind(current()),
          (kind) => {
            if (kind === strokeKind(current())) return;
            strokeSwatchesOpen = null;
            commitStroke(withKind(current(), kind, design));
            build();
          },
          'Stroke style',
        );
        const style = current();
        const names = style.layers.length === 1 ? ['Line'] : style.layers.length === 2 ? ['Outer', 'Inner'] : ['Outer', 'Inner', 'Centre'];
        // Widths are the design's own (they scale with the pattern): shown as plain numbers — px at
        // 100% zoom.
        const fmt = (v: number) => (v === 0 ? 'None' : `${Number(v.toFixed(2))}`);
        const rows: { slider: HTMLInputElement; value: HTMLSpanElement }[] = [];
        const showWidths = (st: RepeatStroke) =>
          st.layers.forEach((l, k) => {
            const r = rows[k];
            if (!r) return;
            r.slider.value = String(l.width);
            r.value.textContent = fmt(l.width);
          });
        style.layers.forEach((layer, k) => {
          const row = document.createElement('div');
          row.className = 'popover-toggle-row stroke-layer-row';
          const label = document.createElement('span');
          label.className = 'popover-row-label stroke-layer-name';
          label.textContent = names[k]!;
          const dot = document.createElement('button');
          dot.className = 'stroke-layer-dot' + (strokeSwatchesOpen === k ? ' open' : '');
          dot.style.background = layer.colour;
          dot.setAttribute('aria-label', `${names[k]} colour ${layer.colour}`);
          dot.setAttribute('aria-expanded', String(strokeSwatchesOpen === k));
          onTap(dot, () => {
            strokeSwatchesOpen = strokeSwatchesOpen === k ? null : k;
            build();
          });
          const slider = document.createElement('input');
          slider.type = 'range';
          slider.min = style.layers.length === 1 ? '0' : '0.5';
          slider.max = String(MAX_STROKE_PX);
          slider.step = '0.25';
          slider.value = String(layer.width);
          slider.className = 'width-slider';
          slider.setAttribute('aria-label', `${names[k]} width`);
          slider.title = 'Width in the design — it scales with the pattern (px at 100% zoom)';
          const value = document.createElement('span');
          value.className = 'popover-row-label popover-value';
          value.textContent = fmt(layer.width);
          slider.addEventListener('input', (e) => {
            e.stopPropagation();
            const next = withWidth(current(), k, Number(slider.value));
            controller.repeatStrokeDraft = next;
            showWidths(next); // neighbours pushed to keep outer > inner > centre show it at once
            controller.notifyView();
          });
          slider.addEventListener('change', (e) => {
            e.stopPropagation();
            commitStroke(controller.repeatStrokeDraft ?? withWidth(current(), k, Number(slider.value)));
          });
          row.appendChild(label);
          row.appendChild(dot);
          row.appendChild(slider);
          row.appendChild(value);
          menu.appendChild(row);
          rows.push({ slider, value });
          if (strokeSwatchesOpen === k) {
            const swatches = document.createElement('div');
            swatches.className = 'swatch-row panel-swatches stroke-layer-swatches';
            swatches.setAttribute('role', 'group');
            swatches.setAttribute('aria-label', `${names[k]} colour`);
            for (const p of REPEAT_BACKGROUNDS) {
              const sw = document.createElement('button');
              sw.className = 'swatch' + (p.colour.toLowerCase() === layer.colour.toLowerCase() ? ' active' : '');
              sw.style.background = p.colour;
              sw.setAttribute('aria-label', p.name);
              sw.title = p.name;
              onTap(sw, () => {
                commitStroke(withColour(current(), k, p.colour));
                build();
              });
              swatches.appendChild(sw);
            }
            const customWrap = document.createElement('label');
            customWrap.className = 'swatch swatch-custom';
            customWrap.title = 'Mine';
            const custom = document.createElement('input');
            custom.type = 'color';
            custom.setAttribute('aria-label', `Custom ${names[k]!.toLowerCase()} colour`);
            custom.value = /^#[0-9a-f]{6}$/i.test(layer.colour) ? layer.colour : '#1e2a36';
            custom.addEventListener('click', (e) => e.stopPropagation());
            custom.addEventListener('change', () => {
              commitStroke(withColour(current(), k, custom.value));
              build();
            });
            customWrap.appendChild(custom);
            swatches.appendChild(customWrap);
            menu.appendChild(swatches);
          }
        });
      };

      const buildBackground = (menu: HTMLElement) => {
      // Background: the colour behind the repeated pattern (what shows through and around it).
      popoverSectionLabel(menu, 'Background');
      const swatchRow = document.createElement('div');
      swatchRow.className = 'swatch-row panel-swatches';
      swatchRow.setAttribute('role', 'group');
      swatchRow.setAttribute('aria-label', 'Background colour');
      swatchRow.title = 'The colour behind the pattern';
      const swatchEls: HTMLButtonElement[] = [];
      const refreshSwatches = () => swatchEls.forEach((el) => el.classList.toggle('active', el.dataset.colour?.toLowerCase() === display().background.toLowerCase()));
      const pick = (colour: string) => {
        display().background = colour;
        refreshSwatches();
        changed();
      };
      for (const p of REPEAT_BACKGROUNDS) {
        const sw = document.createElement('button');
        sw.className = 'swatch';
        sw.dataset.colour = p.colour;
        sw.style.background = p.colour;
        sw.setAttribute('aria-label', `Background ${p.name}`);
        sw.title = p.name;
        sw.addEventListener('click', (e) => {
          e.stopPropagation();
          pick(p.colour);
        });
        swatchEls.push(sw);
        swatchRow.appendChild(sw);
      }
      const customWrap = document.createElement('label');
      customWrap.className = 'swatch swatch-custom';
      customWrap.title = 'Mine';
      const customInput = document.createElement('input');
      customInput.type = 'color';
      customInput.setAttribute('aria-label', 'Custom background colour');
      customInput.value = /^#[0-9a-f]{6}$/i.test(display().background) ? display().background : color.plaster;
      customInput.addEventListener('click', (e) => e.stopPropagation());
      customInput.addEventListener('input', () => pick(customInput.value));
      customWrap.appendChild(customInput);
      swatchRow.appendChild(customWrap);
      refreshSwatches();
      menu.appendChild(swatchRow);
      };

      const buildFill = (menu: HTMLElement) => {
      // Fill: the colour and opacity Fill applies next — one choice for Space, Motif and Pattern
      // (the bottom row only picks the scope) — clearing what the current scope has filled, and how
      // strongly motif regions are drawn. Choosing a colour never changes what is already filled:
      // tap a filled region or space with the new colour to change it.
      popoverSectionLabel(menu, 'Fill colour');
      colourSwatchRow(
        menu,
        repeatPaint(controller),
        (c) => {
          controller.doc.repeatPaint = { colour: c, opacity: repeatPaintOpacity(controller) };
          controller.notify();
        },
        { label: 'No fill', value: null },
      );
      panelSliderRow(menu, 'Opacity', {
        min: 10,
        max: 100,
        step: 5,
        value: Math.round(repeatPaintOpacity(controller) * 100),
        format: (v) => `${v}%`,
        onInput: (v) => {
          controller.doc.repeatPaint = { colour: repeatPaint(controller), opacity: v / 100 };
          controller.notify();
        },
      }).slider.title = 'Opacity of the next fill (each fill keeps its own)';
      const scope = hooks.scope();
      if (!scope) {
        const start = document.createElement('button');
        start.className = 'popover-row appearance-regions';
        start.textContent = 'Fill on the canvas…';
        start.title = 'Choose Space, Motif or Pattern, then tap to fill';
        onTap(start, () => hooks.startFill());
        menu.appendChild(start);
      } else {
        // Clearing what this scope has filled: one Undo step.
        const doc = controller.doc;
        const colour = doc.repeatSetup?.colour;
        const has = scope === 'space' ? doc.repeat.gapFills.size > 0 : scope === 'pattern' ? !!colour?.pattern && Object.keys(colour.pattern.regions).length > 0 : !!colour?.regions && Object.keys(colour.regions).length > 0;
        const clear = document.createElement('button');
        clear.className = 'popover-row appearance-regions';
        clear.textContent = scope === 'space' ? 'Clear Space fills' : scope === 'pattern' ? 'Pattern as designed' : 'Motif as designed';
        clear.title = scope === 'space' ? 'Every space unfilled again' : 'Every region shows the design’s own colours again';
        clear.disabled = !has;
        onTap(clear, () => {
          if (!has) return;
          controller.commit((d) => {
            if (scope === 'space') d.repeat.gapFills = new Map();
            else {
              const c = structuredClone(d.repeatSetup!.colour!);
              if (scope === 'pattern') c.pattern = { ...c.pattern!, regions: {} };
              else delete c.regions;
              d.repeatSetup = { ...d.repeatSetup!, colour: c };
            }
          });
          build();
        });
        menu.appendChild(clear);
      }
      panelSliderRow(menu, 'Motif fills', {
        min: 0,
        max: 100,
        step: 5,
        value: Math.round(display().fillOpacity * 100),
        format: (v) => `${v}%`,
        onInput: (v) => {
          display().fillOpacity = v / 100;
          changed();
        },
      }).slider.title = 'How strongly every motif region is drawn (spaces keep their own opacity)';
      };
      build();
    },
    { shieldCanvas: true, panel: true },
  );
}

/**
 * Intersection Snapshots: a promising arrangement kept on purpose — every construction's place and
 * turn, the Spread and its reference, and each copy's colour and extensions — to come back to. Not
 * Undo history: saving or deleting one is never undone; restoring one is a single Undo step.
 */
const MAX_SNAPSHOTS = 24;

function showIntersectionSnapshotsPanel(anchor: HTMLElement, controller: AppController): void {
  mountPopover(
    anchor,
    (menu, close) => {
      const build = () => {
        menu.replaceChildren();
        popoverSectionLabel(menu, 'Snapshots');
        const list = controller.doc.intersectionSnapshots ?? [];
        const save = document.createElement('button');
        save.className = 'popover-row snapshot-save';
        save.textContent = list.length >= MAX_SNAPSHOTS ? `Full (${MAX_SNAPSHOTS}) — delete one to save` : 'Save this arrangement';
        save.disabled = list.length >= MAX_SNAPSHOTS;
        save.addEventListener('click', (e) => {
          e.stopPropagation();
          const doc = controller.doc;
          const snap = {
            id: genId('snap'),
            at: Date.now(),
            layout: structuredClone(layoutOf(doc)),
            copies: structuredClone(doc.intersection?.copies ?? {}),
            thumb: intersectionThumbnail(doc),
          };
          doc.intersectionSnapshots = [...list, snap];
          controller.notify(); // saved with the artwork
          build();
        });
        menu.appendChild(save);
        list.forEach((snap, n) => {
          const row = document.createElement('div');
          row.className = 'snapshot-row';
          const open = document.createElement('button');
          open.className = 'snapshot-open';
          open.setAttribute('aria-label', `Restore snapshot ${n + 1}`);
          if (snap.thumb) {
            const img = document.createElement('img');
            img.src = snap.thumb;
            img.alt = '';
            open.appendChild(img);
          }
          const text = document.createElement('span');
          text.className = 'popover-row-label';
          text.textContent = `${n + 1} · ${new Date(snap.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
          open.appendChild(text);
          open.addEventListener('click', (e) => {
            e.stopPropagation();
            controller.intersectionSelected = null;
            controller.commit((d) => {
              // A bookmark restores the ARRANGEMENT — positions, turns, Primary-copy states — never the
              // Developed Primary, which stays as it is (Stage D, decision D8).
              d.intersection = withArrangement(d, structuredClone(snap.copies), structuredClone(snap.layout));
            });
            close();
          });
          const del = document.createElement('button');
          del.className = 'snapshot-delete';
          del.setAttribute('aria-label', `Delete snapshot ${n + 1}`);
          del.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3 L11 11 M11 3 L3 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
          del.addEventListener('click', (e) => {
            e.stopPropagation();
            close();
            openConfirmSheet({
              title: `Delete snapshot ${n + 1}?`,
              body: 'A deleted snapshot cannot be brought back.',
              confirmLabel: 'Delete',
              onConfirm: () => {
                controller.doc.intersectionSnapshots = (controller.doc.intersectionSnapshots ?? []).filter((s) => s.id !== snap.id);
                controller.notify();
              },
            });
          });
          row.appendChild(open);
          row.appendChild(del);
          menu.appendChild(row);
        });
      };
      build();
    },
    { shieldCanvas: true, panel: true },
  );
}

/**
 * Intersection: the copies shown — the primary and each neighbour — with its analysis colour and
 * whether its extensions are drawn (its bounded construction always is). Every change is one commit
 * (Undo / Redo), on `doc.intersection` only. A tap on a copy's colour opens the app's colour row
 * beneath it.
 */
function showIntersectionCopiesPanel(anchor: HTMLElement, controller: AppController): void {
  mountPopover(
    anchor,
    (menu) => {
      let open: string | null = null;
      const set = (key: string, patch: { colour?: string; extensions?: boolean }) => {
        controller.commit((d) => {
          d.intersection = withCopySetting(d, key, patch);
        });
        build();
      };
      const build = () => {
        menu.replaceChildren();
        // Two columns: each copy (its colour), and whether its extensions are drawn — its bounded
        // construction always is.
        const header = document.createElement('div');
        header.className = 'copies-header';
        popoverSectionLabel(header, 'Copies');
        // Stage D: which constructions the Intersect Repeat repeats whole (Primary-copies), beside the
        // Developed Primary.
        popoverSectionLabel(header, 'In Repeat');
        popoverSectionLabel(header, 'Extensions');
        menu.appendChild(header);
        for (const copy of intersectionCopies(controller.doc)) {
          const row = document.createElement('div');
          row.className = 'popover-toggle-row copy-row';
          const dot = document.createElement('button');
          dot.className = 'copy-colour';
          dot.style.background = copy.colour;
          dot.setAttribute('aria-label', `${copy.label} colour`);
          dot.setAttribute('aria-expanded', String(open === copy.key));
          dot.addEventListener('click', (e) => {
            e.stopPropagation();
            open = open === copy.key ? null : copy.key;
            build();
          });
          const label = document.createElement('span');
          label.className = 'popover-row-label';
          label.textContent = copy.label;
          const sw = document.createElement('button');
          sw.className = 'toggle-switch' + (copy.extensions ? ' on' : '');
          sw.innerHTML = '<span class="toggle-knob"></span>';
          sw.setAttribute('aria-label', `${copy.label} extensions ${copy.extensions ? 'on' : 'off'}`);
          sw.setAttribute('aria-pressed', String(copy.extensions));
          sw.addEventListener('click', (e) => {
            e.stopPropagation();
            set(copy.key, { extensions: !copy.extensions });
          });
          const inRepeat = inComposition(controller.doc, copy.key);
          const rep = document.createElement('button');
          rep.className = 'toggle-switch copy-in-repeat' + (inRepeat ? ' on' : '');
          rep.innerHTML = '<span class="toggle-knob"></span>';
          rep.setAttribute('aria-label', `${copy.label} in Repeat ${inRepeat ? 'on' : 'off'}`);
          rep.setAttribute('aria-pressed', String(inRepeat));
          rep.title = 'Repeat this whole construction, where it stands, with the Developed Primary';
          rep.addEventListener('click', (e) => {
            e.stopPropagation();
            controller.commit((d) => {
              d.intersection = withPrimaryCopy(d, copy.key, !inRepeat);
            });
            build();
          });
          row.appendChild(dot);
          row.appendChild(label);
          row.appendChild(rep);
          row.appendChild(sw);
          // Any copy can be removed again (one Undo step); the Primary stays.
          const remove = document.createElement('button');
          remove.className = 'copy-remove';
          if (copy.key === PRIMARY) {
            remove.disabled = true;
            remove.setAttribute('aria-hidden', 'true');
          } else {
            remove.setAttribute('aria-label', `Remove ${copy.label}`);
            remove.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3 L11 11 M11 3 L3 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
            remove.addEventListener('click', (e) => {
              e.stopPropagation();
              const wasCurrent = referenceCurrent(layoutOf(controller.doc));
              const next = withoutCopy(controller.doc, copy.key);
              if (!next) return;
              if (controller.intersectionSelected === copy.key) controller.intersectionSelected = null;
              controller.commit((d) => {
                d.intersection = next;
              });
              if (wasCurrent && !referenceCurrent(layoutOf(controller.doc))) showToast('Copies changed — set a new Reference to use Spread');
              build();
            });
          }
          row.appendChild(remove);
          menu.appendChild(row);
          if (open === copy.key) {
            const host = document.createElement('div');
            colourSwatchRow(host, copy.colour, (c) => {
              if (c) set(copy.key, { colour: c });
            });
            const swatches = host.firstElementChild as HTMLElement;
            swatches.classList.add('panel-swatches');
            swatches.setAttribute('aria-label', `${copy.label} colour`);
            menu.appendChild(swatches);
          }
        }
        // + Copy: one more construction, in a free spot with a colour of its own (up to six in all).
        const count = intersectionCopies(controller.doc).length;
        const add = document.createElement('button');
        add.className = 'popover-row copy-add';
        add.textContent = count >= MAX_CONSTRUCTIONS ? `${MAX_CONSTRUCTIONS} constructions — the most for now` : '+ Copy';
        add.disabled = count >= MAX_CONSTRUCTIONS;
        add.addEventListener('click', (e) => {
          e.stopPropagation();
          const wasCurrent = referenceCurrent(layoutOf(controller.doc));
          const next = withAddedCopy(controller.doc);
          if (!next) return;
          controller.commit((d) => {
            d.intersection = next;
          });
          if (wasCurrent && !referenceCurrent(layoutOf(controller.doc))) showToast('Copies changed — set a new Reference to use Spread');
          build();
        });
        menu.appendChild(add);
      };
      build();
    },
    { shieldCanvas: true, panel: true },
  );
}

/** Library thumbnails as object URLs, made once per reference for this session. */
const thumbUrls = new Map<string, string>();
const thumbUrl = (r: ReferenceRecord) => {
  let url = thumbUrls.get(r.id);
  if (!url) {
    url = URL.createObjectURL(r.thumb);
    thumbUrls.set(r.id, url);
  }
  return url;
};

const WORKSPACE_NAMES = { construct: 'Construct', intersection: 'Intersection', repeat: 'Repeat' } as const;

/**
 * The Reference panel: the artwork's reference (shown or hidden, its strength and the artwork's
 * over it, in this workspace — viewing only, never Undo — and Transform), and the Reference Library
 * (every imported image, as thumbnails; tapping one makes it this artwork's reference — one Undo
 * step; Edit offers to delete one from the library).
 */
function showReferencePanel(anchor: HTMLElement, controller: AppController, hooks: { onChange: () => void; startTransform: () => void }): void {
  const onChange = hooks.onChange;
  mountPopover(
    anchor,
    (menu) => {
      menu.classList.add('reference-panel');
      let library: ReferenceRecord[] | null = null;
      let adding = false;
      let editing = false;
      const ws = () => controller.doc.view.workspace;
      const setView = (patch: Parameters<typeof withUnderlayView>[2]) => {
        // A view, like the camera: saved with the artwork, never an Undo step or a recorded change.
        controller.doc.underlayView = withUnderlayView(controller.doc, ws(), patch);
        controller.notifyView();
        onChange();
      };
      /** Removing from the library never takes an image away from an artwork: one still in use only
       * leaves the library (those artworks keep it as their own); one no artwork uses is deleted. */
      const confirmDelete = async (r: ReferenceRecord) => {
        const doc = controller.doc;
        let users: string[];
        try {
          users = await artworksUsing(r.id, doc);
        } catch {
          showToast('Couldn’t check which artworks use it', 2600, 'error');
          return;
        }
        if (users.length > 0) {
          openConfirmSheet({
            title: 'Remove from the library?',
            body: `It is used by ${users.length === 1 ? '1 artwork' : `${users.length} artworks`}${users.length <= 3 ? ` (${users.join(', ')})` : ''}. It stays with ${users.length === 1 ? 'it' : 'them'} as ${users.length === 1 ? 'its' : 'their'} own reference, and leaves the library.`,
            confirmLabel: 'Remove',
            onConfirm: () => {
              setReferenceScope(r.id, 'artwork')
                .then(async () => {
                  library = await listReferences().catch(() => library);
                  if (!library?.some(inLibrary)) editing = false;
                  showToast('Removed from the library');
                  if (menu.isConnected) build();
                })
                .catch(() => showToast('Couldn’t change the library', 2600, 'error'));
            },
          });
          return;
        }
        const body = 'No artwork uses it. It will be removed from this device.';
        openConfirmSheet({
          title: 'Delete this reference?',
          body,
          confirmLabel: 'Delete',
          onConfirm: () => {
            deleteReference(r.id)
              .then(async () => {
                forgetUnderlayImage(r.id);
                library = await listReferences().catch(() => (library ?? []).filter((x) => x.id !== r.id));
                if (!library.some(inLibrary)) editing = false;
                showToast('Reference deleted');
                onChange();
                if (menu.isConnected) build();
              })
              .catch(() => showToast('Couldn’t delete the reference', 2600, 'error'));
          },
        });
      };
      const build = () => {
        menu.replaceChildren();
        const u = controller.doc.underlay;
        if (u) {
          popoverSectionLabel(menu, `Reference · ${WORKSPACE_NAMES[ws()]}`);
          const v = underlayViewOf(controller.doc, ws());
          const record = library?.find((r) => r.id === u.refId);
          const missing = (library && !record) || underlayImage(u.refId).state === 'missing';
          const row = document.createElement('div');
          row.className = 'popover-toggle-row reference-active';
          if (record) {
            const img = document.createElement('img');
            img.className = 'reference-active-thumb';
            img.src = thumbUrl(record);
            img.alt = '';
            row.appendChild(img);
          }
          const label = document.createElement('span');
          label.className = 'popover-row-label';
          label.textContent = missing ? 'Reference missing' : 'Show';
          row.appendChild(label);
          if (!missing) {
            const sw = document.createElement('button');
            sw.className = 'toggle-switch' + (v.visible ? ' on' : '');
            sw.innerHTML = '<span class="toggle-knob"></span>';
            sw.setAttribute('aria-label', `Reference ${v.visible ? 'shown' : 'hidden'}`);
            sw.setAttribute('aria-pressed', String(v.visible));
            sw.addEventListener('click', (e) => {
              e.stopPropagation();
              setView({ visible: !v.visible });
              build();
            });
            row.appendChild(sw);
          }
          menu.appendChild(row);
          if (missing) {
            const note = document.createElement('p');
            note.className = 'popover-hint';
            note.textContent = 'This image is no longer in the Reference Library.';
            menu.appendChild(note);
          } else if (record && !inLibrary(record)) {
            // This artwork's own image: offer to keep it for other artworks too.
            const own = document.createElement('button');
            own.className = 'popover-row reference-to-library';
            own.textContent = 'This artwork only · Add to library';
            own.addEventListener('click', (e) => {
              e.stopPropagation();
              setReferenceScope(record.id, undefined)
                .then(async () => {
                  library = await listReferences().catch(() => library);
                  showToast('Added to the Reference Library');
                  if (menu.isConnected) build();
                })
                .catch(() => showToast('Couldn’t change the library', 2600, 'error'));
            });
            menu.appendChild(own);
          }
          if (!missing) {
            panelSliderRow(menu, 'Reference', { min: 0, max: 100, step: 1, value: Math.round(v.referenceOpacity * 100), format: (x) => `${x}%`, onInput: (x) => setView({ referenceOpacity: x / 100 }) });
            panelSliderRow(menu, 'Artwork', { min: 5, max: 100, step: 1, value: Math.round(v.artworkOpacity * 100), format: (x) => `${x}%`, onInput: (x) => setView({ artworkOpacity: x / 100 }) });
          }
          if (!missing) {
            // Transform: the canvas's fingers move, scale and turn the reference until Done.
            const transform = document.createElement('button');
            transform.className = 'popover-row reference-transform';
            transform.textContent = 'Transform…';
            transform.addEventListener('click', (e) => {
              e.stopPropagation();
              hooks.startTransform();
            });
            menu.appendChild(transform);
          }
          const remove = document.createElement('button');
          remove.className = 'popover-row reference-remove';
          remove.textContent = 'Remove from artwork';
          remove.addEventListener('click', (e) => {
            e.stopPropagation();
            controller.commit((d) => {
              delete d.underlay;
            });
            onChange();
            build();
          });
          menu.appendChild(remove);
          const divider = document.createElement('div');
          divider.className = 'popover-divider';
          menu.appendChild(divider);
        }
        const libHead = document.createElement('div');
        libHead.className = 'reference-library-head';
        popoverSectionLabel(libHead, 'Reference Library');
        const listed = (library ?? []).filter(inLibrary);
        if (listed.length) {
          const edit = document.createElement('button');
          edit.className = 'reference-edit';
          edit.textContent = editing ? 'Done' : 'Edit';
          edit.setAttribute('aria-pressed', String(editing));
          edit.addEventListener('click', (e) => {
            e.stopPropagation();
            editing = !editing;
            build();
          });
          libHead.appendChild(edit);
        }
        menu.appendChild(libHead);
        const grid = document.createElement('div');
        grid.className = 'reference-grid';
        if (!library) {
          const wait = document.createElement('p');
          wait.className = 'popover-hint';
          wait.textContent = 'Loading…';
          menu.appendChild(wait);
        } else if (listed.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'popover-hint';
          empty.textContent = 'Images added here can be used under any artwork.';
          menu.appendChild(empty);
        }
        for (const r of listed) {
          const b = document.createElement('button');
          b.className = 'reference-thumb' + (u?.refId === r.id ? ' active' : '');
          b.setAttribute('aria-label', `${u?.refId === r.id ? 'Current reference' : 'Use reference'} ${r.name}`);
          b.title = r.name;
          const img = document.createElement('img');
          img.src = thumbUrl(r);
          img.alt = '';
          b.appendChild(img);
          if (editing) {
            b.classList.add('editing');
            b.setAttribute('aria-label', `Delete reference ${r.name}`);
            const x = document.createElement('span');
            x.className = 'reference-delete-badge';
            x.innerHTML = '<svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3 L11 11 M11 3 L3 11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
            b.appendChild(x);
          }
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            if (editing) {
              void confirmDelete(r);
              return;
            }
            if (controller.doc.underlay?.refId === r.id) return;
            useReference(r); // one Undo step
            build();
          });
          grid.appendChild(b);
        }
        if (listed.length) menu.appendChild(grid);
        const add = document.createElement('button');
        add.className = 'popover-row reference-add';
        add.textContent = adding ? 'Adding…' : '+ Add to library';
        add.disabled = adding;
        add.addEventListener('click', (e) => {
          e.stopPropagation();
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/*';
          input.multiple = true;
          input.addEventListener('change', async () => {
            const files = [...(input.files ?? [])];
            if (files.length === 0) return;
            adding = true;
            build();
            let added = 0;
            for (const file of files) {
              try {
                await importReference(file);
                added++;
              } catch (err) {
                showToast(err instanceof ReferenceImportError ? err.message : 'Couldn’t add the image', 2600, 'error');
                if (err instanceof ReferenceImportError && err.reason === 'storage') break;
              }
            }
            adding = false;
            library = await listReferences().catch(() => library);
            if (added > 0) showToast(added === 1 ? 'Reference added' : `${added} references added`);
            if (menu.isConnected) build();
          });
          input.click();
        });
        menu.appendChild(add);
        // An image for this artwork alone: used here at once, without joining the library.
        const own = document.createElement('button');
        own.className = 'popover-row reference-add-own';
        own.textContent = '+ Image for this artwork only';
        own.disabled = adding;
        own.addEventListener('click', (e) => {
          e.stopPropagation();
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/*';
          input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            adding = true;
            build();
            try {
              const r = await importReference(file, 'artwork');
              useReference(r);
              showToast('Reference added to this artwork');
            } catch (err) {
              showToast(err instanceof ReferenceImportError ? err.message : 'Couldn’t add the image', 2600, 'error');
            }
            adding = false;
            library = await listReferences().catch(() => library);
            if (menu.isConnected) build();
          });
          input.click();
        });
        menu.appendChild(own);
      };
      /** Makes `r` this artwork's reference — one Undo step. It starts at the same place whichever
       * workspace it is chosen in (underlay.ts — initialUnderlay) — except that one replacing a
       * missing reference takes over every workspace's placement of it, proportions apart. */
      const useReference = (r: ReferenceRecord) => {
        const old = controller.doc.underlay;
        const replacingMissing = !!old && (!library?.some((x) => x.id === old.refId) || underlayImage(old.refId).state === 'missing');
        controller.commit((d) => {
          const fresh = initialUnderlay(d, r, d.view.workspace);
          d.underlay = replacingMissing && old ? { ...structuredClone(old), refId: fresh.refId, aspect: fresh.aspect, anchors: [] } : fresh;
        });
        onChange();
      };
      build();
      listReferences()
        .then((all) => {
          library = all;
        })
        .catch(() => {
          library = [];
          showToast('Couldn’t open the Reference Library', 2600, 'error');
        })
        .finally(() => {
          if (menu.isConnected) build();
        });
      // When the reference's image arrives (or turns out to be missing), say so.
      const off = onUnderlayImage(() => (menu.isConnected ? build() : off()));
    },
    { shieldCanvas: true, panel: true },
  );
}

/** Phase 5.1 item 7: Grid / Guides — interaction aids only, each independently switchable, with
 * one master row that turns them all on or off together. */
function showRepeatGuidesPanel(anchor: HTMLElement, controller: AppController, onChange: () => void): void {
  const display = (): RepeatDisplay => controller.doc.repeatDisplay;
  const keys = ['grid', 'handles', 'motifBoundary'] as const;
  const allOn = () => keys.every((k) => display()[k]);

  mountPopover(
    anchor,
    (menu) => {
      const rows: { refresh: () => void }[] = [];
      const refreshAll = () => rows.forEach((r) => r.refresh());
      const set = (apply: () => void) => {
        apply();
        refreshAll();
        onChange();
        controller.notifyView();
      };
      rows.push(popoverToggleRow(menu, 'All guides', allOn, (on) => set(() => keys.forEach((k) => (display()[k] = on)))));
      const divider = document.createElement('div');
      divider.className = 'popover-divider';
      menu.appendChild(divider);
      rows.push(popoverToggleRow(menu, 'Grid', () => display().grid, (on) => set(() => (display().grid = on))));
      rows.push(popoverToggleRow(menu, 'Handles', () => display().handles, (on) => set(() => (display().handles = on))));
      rows.push(popoverToggleRow(menu, 'Motif boundary', () => display().motifBoundary, (on) => set(() => (display().motifBoundary = on))));
      // Reset lattice: back to the lattice Repeat first suggests for this artwork and source — the
      // frame's natural shape (square; 60° for a triangle or hexagon frame) at its comfortable
      // spacing (for the Intersect arrangement, spaced to its extent). The rule, the motif's
      // rotation and every colour stay as they are. One Undo step; Undo also restores a lattice made
      // by hand.
      const reset = document.createElement('button');
      reset.className = 'popover-row guides-reset';
      reset.textContent = 'Reset lattice';
      reset.title = 'Back to the lattice Repeat first suggests (rule, rotation and colours kept)';
      onTap(reset, () => {
        controller.commit((d) => {
          const family: LatticeFamily = suggestedFamily(d.frame.kind);
          const { a, b } = suggestForFamily(d, family);
          d.repeat.family = family;
          d.repeat.a = a;
          d.repeat.b = b;
        });
        showToast('Lattice reset');
      });
      menu.appendChild(reset);
      // Stage C: Close Gap — an explicit action: tap near a gap, preview, Apply or Cancel.
      const closeGapRow = document.createElement('button');
      closeGapRow.className = 'popover-row guides-reset';
      closeGapRow.textContent = 'Close gap…';
      closeGapRow.title = 'Close a small, accidental gap between repeated shapes — tap near it to preview';
      onTap(closeGapRow, () => {
        closeAnyPopover();
        controller.spaceMode = false;
        controller.repeatColourMode = null;
        controller.closeGap = { phase: 'pick' };
        showToast('Tap near a gap between repeated shapes', 2600);
        controller.notify();
      });
      menu.appendChild(closeGapRow);
    },
    { shieldCanvas: true, panel: true },
  );
}

/** Session-sticky share choices — construction/guides are re-read from what's visible each time. */
const exportChoice: { format: 'png' | 'svg' | 'timelapse'; scale: ExportSettings['scale']; transparent: boolean } = { format: 'png', scale: 2, transparent: false };

/** vNext Phase 4B: what the Share panel needs for Timelapse — absent for the Beginner Guide's practice
 * artwork, which has no history. `prepare` makes sure every change is recorded before reading. */
export interface TimelapseSupport {
  prepare: () => Promise<void>;
}

/**
 * Phase 5.3 items 7–19 / Phase 5.4 items 1–3: Share — always the current view (zoom, pan, crop,
 * background, stroke style and opacity; never re-fitted). Compact: format, resolution, background,
 * and whether construction (Construct) or the grid/guides (Repeat) come along — defaulting to
 * what's showing.
 *
 * The file is rendered ahead of the tap (on open, and again whenever a choice changes), so the
 * Share tap hands the operating system a ready file straight away: iOS only opens its share sheet
 * from within the tap itself. The view can't change meanwhile — touching the canvas closes this.
 *
 * vNext Phase 4B: Timelapse is the third format. It takes seconds to make (the video is recorded
 * in real time), so it is made on a first tap and handed over on a second — the share sheet needs
 * a fresh tap of its own. Closing the panel or Cancel stops it; nothing in the artwork changes.
 */
function showExportPanel(anchor: HTMLElement, controller: AppController, getView: () => ViewTransform, timelapse: TimelapseSupport | null): void {
  const inRepeat = controller.doc.view.workspace === 'repeat';
  const display = controller.doc.repeatDisplay;
  if (exportChoice.format === 'timelapse' && !timelapse) exportChoice.format = 'png';
  const settings = {
    ...exportChoice,
    construction: !inRepeat, // Repeat never draws construction
    guides: inRepeat ? display.grid : false,
  };
  const still = (): ExportSettings => ({ ...settings, format: settings.format === 'svg' ? 'svg' : 'png' });
  let ready: Promise<{ blob: Blob; filename: string }> | null = null;
  let readyFile: { blob: Blob; filename: string } | null = null;
  const prepare = () => {
    readyFile = null;
    if (settings.format === 'timelapse') return;
    // Exports frame the same pan and zoom unturned: a turned camera is a way of looking, not the artwork.
    const job = exportVisibleView(controller, unturned(getView()), still());
    ready = job;
    job.then((f) => {
      if (ready === job) readyFile = f;
    }, () => {});
  };

  mountPopover(
    anchor,
    (menu, close) => {
      popoverSectionLabel(menu, 'Share current view');
      const formatRow = document.createElement('div');
      formatRow.className = 'panel-inline-row';
      menu.appendChild(formatRow);
      let scale: { buttons: HTMLButtonElement[] } | null = null;
      let background: { refresh: () => void; buttons: HTMLButtonElement[] } | null = null;
      const formats: { id: 'png' | 'svg' | 'timelapse'; label: string }[] = [
        { id: 'png', label: 'PNG' },
        { id: 'svg', label: 'SVG' },
      ];
      if (timelapse) formats.push({ id: 'timelapse', label: 'Timelapse' });
      const format = panelSegmented(
        formatRow,
        formats,
        () => settings.format,
        (id) => {
          if (making) return;
          settings.format = exportChoice.format = id;
          refreshFormat();
          prepare();
        },
        'Format',
      );
      scale = panelSegmented(
        formatRow,
        [
          { id: '1', label: '1×' },
          { id: '2', label: '2×' },
          { id: '4', label: '4×' },
        ],
        () => String(settings.scale) as '1' | '2' | '4',
        (id) => {
          settings.scale = exportChoice.scale = Number(id) as 1 | 2 | 4;
          prepare();
        },
        'Resolution',
      );

      const bgRow = document.createElement('div');
      bgRow.className = 'popover-toggle-row';
      const bgLabel = document.createElement('span');
      bgLabel.className = 'popover-row-label';
      bgLabel.textContent = 'Background';
      bgRow.appendChild(bgLabel);
      background = panelSegmented(
        bgRow,
        [
          { id: 'current', label: 'Current' },
          { id: 'transparent', label: 'Transparent' },
        ],
        () => (settings.transparent && settings.format !== 'timelapse' ? 'transparent' : 'current'),
        (id) => {
          if (settings.format === 'timelapse') return; // a video always has its background
          settings.transparent = exportChoice.transparent = id === 'transparent';
          prepare();
        },
        'Background',
      );
      menu.appendChild(bgRow);

      if (!inRepeat) {
        popoverToggleRow(
          menu,
          'Construction',
          () => settings.construction,
          (on) => {
            settings.construction = on;
            prepare();
          },
        );
      } else {
        popoverToggleRow(
          menu,
          'Grid / guides',
          () => settings.guides,
          (on) => {
            settings.guides = on;
            prepare();
          },
        );
      }

      // vNext Phase 4B: one short line, only for Timelapse, only when there's something to say.
      const note = document.createElement('div');
      note.className = 'panel-note';
      menu.appendChild(note);

      // Phase 5.5 item 12: the button says what will really happen here — the system share sheet
      // where this page can share files, otherwise a file saved by the browser.
      const canShareFiles = fileShareSupport().files;
      const actions = document.createElement('div');
      actions.className = 'panel-actions';
      const go = document.createElement('button');
      go.className = 'panel-primary';
      const cancel = document.createElement('button');
      cancel.className = 'panel-secondary';
      cancel.textContent = 'Cancel';
      actions.appendChild(go);
      actions.appendChild(cancel);
      menu.appendChild(actions);

      let info: TimelapseInfo | null = null;
      let making = false;
      /** Each making of a video has its own stop flag, so a cancelled one can never resume. */
      let run: { stopped: boolean } | null = null;
      let video: TimelapseResult | null = null;
      const vType = videoType();

      function refreshFormat(): void {
        const isVideo = settings.format === 'timelapse';
        scale?.buttons.forEach((b) => (b.disabled = settings.format !== 'png' || making));
        background?.buttons.forEach((b) => (b.disabled = isVideo));
        background?.refresh();
        format.buttons.forEach((b) => (b.disabled = making && b.textContent !== 'Timelapse'));
        cancel.hidden = !making;
        note.textContent = !isVideo
          ? ''
          : !vType
            ? 'This browser can’t make video.'
            : info && !info.available
              ? 'Make some changes to create a timelapse.'
              : info?.partial
                ? 'Timelapse starts from recorded history.'
                : '';
        note.hidden = note.textContent === '';
        if (!isVideo) {
          go.textContent = canShareFiles ? 'Share' : 'Save file';
          go.disabled = false;
        } else if (video) {
          go.textContent = canShareFiles ? 'Share video' : 'Save video';
          go.disabled = false;
        } else if (!making) {
          go.textContent = 'Create timelapse';
          go.disabled = !vType || !info?.available;
        }
      }

      if (timelapse) {
        void timelapse.prepare().then(() => timelapseInfo(controller.doc.id)).then((i) => {
          info = i;
          refreshFormat();
        });
      }

      const makeVideo = () => {
        making = true;
        const thisRun = { stopped: false };
        run = thisRun;
        go.disabled = true;
        go.textContent = 'Creating timelapse… 0%';
        refreshFormat();
        const view = unturned(getView()); // Timelapse, like exports, is never turned
        void timelapse!
          .prepare()
          .then(() =>
            createTimelapse(
              controller,
              view,
              { construction: settings.construction, guides: settings.guides },
              (f) => {
                if (run === thisRun && !thisRun.stopped) go.textContent = `Creating timelapse… ${Math.round(f * 100)}%`;
              },
              () => thisRun.stopped || !menu.isConnected,
            ),
          )
          .then((result) => {
            if (run !== thisRun || thisRun.stopped) return;
            making = false;
            video = result;
            refreshFormat();
          })
          .catch((e: Error) => {
            if (run !== thisRun || thisRun.stopped) return;
            making = false;
            refreshFormat();
            if (e.message === 'hidden') showToast('Timelapse stopped — keep the app open while it’s made', 2200, 'warning');
            else if (menu.isConnected) showToast('Couldn’t create the timelapse', 2600, 'error');
          });
      };

      onTap(cancel, () => {
        if (run) run.stopped = true;
        making = false;
        refreshFormat();
      });

      onTap(go, () => {
        if (settings.format === 'timelapse') {
          if (making) return;
          if (!video) return makeVideo();
          const v = video;
          go.disabled = true;
          deliverFile(v.blob, v.filename)
            .then((result) => {
              if (result === 'saved') showToast(canShareFiles ? `Share sheet unavailable · saved ${v.filename}` : `Saved ${v.filename}`);
            })
            .catch(() => showToast('Couldn’t share the video', 2600, 'error'))
            .finally(() => close());
          return;
        }
        go.disabled = true;
        const file = readyFile;
        const delivered = file ? deliverFile(file.blob, file.filename) : ready!.then((f) => deliverFile(f.blob, f.filename));
        delivered
          .then((result) => {
            const name = readyFile?.filename ?? file?.filename ?? 'file';
            // Never implies a share sheet that didn't open: a refused sheet says so.
            if (result === 'saved') showToast(canShareFiles ? `Share sheet unavailable · saved ${name}` : `Saved ${name}`);
          })
          .catch(() => showToast('Couldn’t create the file', 2600, 'error'))
          .finally(() => close());
      });
      refreshFormat();
    },
    { shieldCanvas: true, panel: true },
  );
  prepare();
}

export interface ShellHandles {
  canvas: HTMLCanvasElement;
  /** Phase 3.2 item 3: the floating context-bar/dock overlay — Fit reads its rendered top edge
   * to know how much of the canvas it actually obstructs, rather than assuming a fixed height. */
  overlay: HTMLElement;
}

export function buildShell(
  root: HTMLElement,
  controller: AppController,
  opts: {
    onFit: () => void;
    onNew: () => void;
    onOpen: () => void;
    onSave: () => void;
    onSaveAs: () => void;
    onSwitchWorkspace: (ws: 'construct' | 'intersection' | 'repeat') => void;
    getView: () => ViewTransform;
    /** The view the single-finger tool works in (Intersect: the active instance's) — where tool-placed
     * page elements belong. */
    getToolView: () => ViewTransform;
    /** vNext Phase 4B: null for the Beginner Guide's practice artwork (no history, no Timelapse). */
    timelapse: TimelapseSupport | null;
  },
): ShellHandles {
  root.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'app-shell';

  // ---- top bar ----
  const topbar = document.createElement('div');
  topbar.className = 'topbar';

  const leftSide = document.createElement('div');
  leftSide.className = 'topbar-side';
  // Show points' panel: `remembered` is the shown mode that "on" restores.
  const remembered: { mode: Exclude<PointVisibility, 'none'> } = { mode: controller.pointVisibility === 'none' ? 'near-finger' : controller.pointVisibility };
  const menuBtn = document.createElement('button');
  menuBtn.className = 'icon-btn';
  menuBtn.setAttribute('aria-label', 'Menu');
  menuBtn.innerHTML = iconSvg('menu');
  onTap(menuBtn, () =>
    togglePanel(menuBtn, () =>
      // vNext Phase 2: a plain file menu under the artwork's own name (a heading, not an action).
      // New and Open… both lead to the Start screen — at its frames, or at My Artworks.
      showPopover(menuBtn, [
        { label: 'New', onSelect: () => opts.onNew() },
        { label: 'Open…', onSelect: () => opts.onOpen() },
        { label: 'Save', onSelect: () => opts.onSave() },
        { label: 'Save As…', onSelect: () => opts.onSaveAs() },
        // The point settings: kept, with their defaults, but out of the top bar — the usual
        // targeting (Primary and Derived, nearest wins) needs no setting at all.
        ...(controller.doc.view.workspace === 'repeat'
          ? []
          : [
              { label: 'Point targets…', divided: true, onSelect: () => showPointTargetsPanel(menuBtn, controller) },
              { label: 'Show points…', onSelect: () => showPointsPanel(menuBtn, controller, remembered) },
            ]),
      ], controller.doc.named ? controller.doc.name : 'Untitled artwork', 'file-menu'),
    ),
  );
  leftSide.appendChild(menuBtn);

  // Stage A: construction colour, beside the menu in Construct. With construction selected (Select),
  // it recolours that selection — whole lines and circles — and leaves the drawing colour alone;
  // otherwise it is the colour new lines, circles and arcs are drawn in. Fair colours are separate.
  const ccBtn = document.createElement('button');
  ccBtn.className = 'icon-btn cc-btn';
  const ccDot = document.createElement('span');
  ccDot.className = 'cc-dot';
  ccBtn.appendChild(ccDot);
  /** The construction the swatch would recolour: whole non-frame lines and circles under a
   * non-Fair selection (Select only), or none — then it sets the drawing colour. */
  function ccTargets(): Entity[] {
    if (controller.tool !== 'select' || controller.doc.view.workspace !== 'construct') return [];
    const doc = controller.doc;
    const sel = controller.selection.filter((c) => c.kind !== 'point');
    if (sel.length === 0) return [];
    const keys = selectionKeys(doc, sel);
    const regions = sel.filter((c) => c.kind === 'region') as Extract<SelectCandidate, { kind: 'region' }>[];
    if (regions.length > 0 ? regions[0]!.fair : isUniformlyFair(doc, keys)) return [];
    const frame = new Set(doc.frame.entityIds);
    return selectionEntityIds(doc, sel, keys)
      .map((id) => doc.entities.find((e) => e.id === id))
      .filter((e): e is Entity => !!e && !frame.has(e.id));
  }
  function refreshCcBtn(): void {
    const targets = ccTargets();
    const active = controller.doc.toolPrefs?.constructionColour ?? null;
    const shown = targets.length > 0 ? (targets.every((e) => (e.colour ?? null) === (targets[0]!.colour ?? null)) ? (targets[0]!.colour ?? null) : null) : active;
    ccDot.style.background = shown ?? color.construction;
    ccBtn.classList.toggle('recolour', targets.length > 0);
    ccBtn.setAttribute('aria-label', targets.length > 0 ? 'Recolour the selected construction' : 'Construction colour for new lines and circles');
  }
  onTap(ccBtn, () =>
    togglePanel(ccBtn, () => {
      const targets = ccTargets();
      if (targets.length > 0) {
        const first = targets[0]!.colour ?? null;
        const same = targets.every((e) => (e.colour ?? null) === first);
        const what = targets.length === 1 ? (targets[0]!.kind === 'circle' ? 'whole circle' : 'whole line') : `${targets.length} lines and circles`;
        showColourPopover(ccBtn, [
          {
            title: `Recolour · ${what}`,
            current: same ? first : null,
            defaultSwatch: color.construction,
            onPick: (colour) => controller.commit((d) => setEntityColour(d, targets.map((e) => e.id), colour)),
          },
        ]);
        return;
      }
      showColourPopover(ccBtn, [
        {
          title: 'New lines and circles',
          current: controller.doc.toolPrefs?.constructionColour ?? null,
          defaultSwatch: color.construction,
          // A drawing preference, like Fill's colour: not a change to the artwork, so not an Undo step.
          onPick: (colour) => {
            const doc = controller.doc;
            doc.toolPrefs = { ...doc.toolPrefs, constructionColour: colour };
            refreshCcBtn();
            controller.notify();
          },
        },
      ]);
    }),
  );
  leftSide.appendChild(ccBtn);

  // Phase 5.1 item 2: in Repeat, Appearance sits beside the menu (and Grid/Guides on the right,
  // below) — same header architecture, workspace-appropriate controls.
  const appearanceBtn = document.createElement('button');
  appearanceBtn.className = 'icon-btn';
  appearanceBtn.setAttribute('aria-label', 'Appearance');
  appearanceBtn.innerHTML = iconSvg('appearance');
  const openAppearance = () => showRepeatAppearancePanel(appearanceBtn, controller, { startFill: () => setFillScope(lastFillScope), scope: () => fillScope() });
  onTap(appearanceBtn, () => togglePanel(appearanceBtn, openAppearance));
  leftSide.appendChild(appearanceBtn);

  // Intersection: in that slot, the Copies panel — its icon a little 2×2 of the constructions' own
  // analysis colours (the first four), so it says which copies there are without shouting.
  const ixCopiesBtn = document.createElement('button');
  ixCopiesBtn.className = 'icon-btn';
  ixCopiesBtn.setAttribute('aria-label', 'Copies');
  onTap(ixCopiesBtn, () => togglePanel(ixCopiesBtn, () => showIntersectionCopiesPanel(ixCopiesBtn, controller)));
  leftSide.appendChild(ixCopiesBtn);
  function refreshIxCopiesBtn(): void {
    const copies = intersectionCopies(controller.doc).slice(0, 4);
    const at = [[8, 8], [16, 8], [8, 16], [16, 16]] as const;
    const dots = copies.map((c, k) => `<circle cx="${at[k]![0]}" cy="${at[k]![1]}" r="3.4" fill="${c.colour}" stroke="none"/>`).join('');
    ixCopiesBtn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">${dots}</svg>`;
    ixCopiesBtn.setAttribute('aria-label', `Copies · ${intersectionCopies(controller.doc).length} constructions`);
  }

  const segmented = document.createElement('div');
  segmented.className = 'segmented';
  const constructBtn = document.createElement('button');
  constructBtn.textContent = 'Construct';
  // Intersection sits between the two: a small local group of construction copies, placed with
  // Repeat's own lattice. A narrow phone shows its shorter name so all three fit.
  const intersectionBtn = document.createElement('button');
  intersectionBtn.innerHTML = '<span class="ws-long">Intersection</span><span class="ws-short">Intersect</span>';
  intersectionBtn.setAttribute('aria-label', 'Intersection');
  const repeatBtn = document.createElement('button');
  repeatBtn.textContent = 'Repeat';
  constructBtn.addEventListener('click', () => opts.onSwitchWorkspace('construct'));
  intersectionBtn.addEventListener('click', () => opts.onSwitchWorkspace('intersection'));
  repeatBtn.addEventListener('click', () => opts.onSwitchWorkspace('repeat'));
  segmented.appendChild(constructBtn);
  segmented.appendChild(intersectionBtn);
  segmented.appendChild(repeatBtn);

  const rightSide = document.createElement('div');
  rightSide.className = 'topbar-side right';
  const exportBtn = document.createElement('button');
  exportBtn.className = 'icon-btn';
  exportBtn.setAttribute('aria-label', 'Share');
  exportBtn.innerHTML = iconSvg('share');
  onTap(exportBtn, () => togglePanel(exportBtn, () => showExportPanel(exportBtn, controller, opts.getView, opts.timelapse)));
  const guidesBtn = document.createElement('button');
  guidesBtn.className = 'icon-btn';
  guidesBtn.setAttribute('aria-label', 'Grid and guides');
  guidesBtn.innerHTML = iconSvg('gridGuides');
  // Like the Points eye: muted when every guide is off, so "why can't I see the handles?" has a visible answer.
  function refreshGuidesBtn(): void {
    const d = controller.doc.repeatDisplay;
    guidesBtn.style.color = d.grid || d.handles || d.motifBoundary ? '' : 'var(--muted)';
    refreshHandlesBtn();
  }
  onTap(guidesBtn, () => togglePanel(guidesBtn, () => showRepeatGuidesPanel(guidesBtn, controller, refreshGuidesBtn)));

  // Intersection: in Grid / guides' slot, Snapshots — discoveries kept on purpose (not Undo history),
  // with how many there are.
  const ixSnapshotsBtn = document.createElement('button');
  ixSnapshotsBtn.className = 'icon-btn badge-host';
  ixSnapshotsBtn.innerHTML = iconSvg('bookmark');
  const ixSnapshotsBadge = document.createElement('span');
  ixSnapshotsBadge.className = 'icon-badge';
  ixSnapshotsBtn.appendChild(ixSnapshotsBadge);
  onTap(ixSnapshotsBtn, () => togglePanel(ixSnapshotsBtn, () => showIntersectionSnapshotsPanel(ixSnapshotsBtn, controller)));
  function refreshIxSnapshotsBtn(): void {
    const n = controller.doc.intersectionSnapshots?.length ?? 0;
    ixSnapshotsBadge.textContent = n ? String(n) : '';
    ixSnapshotsBadge.style.display = n ? '' : 'none';
    ixSnapshotsBtn.setAttribute('aria-label', `Snapshots · ${n} saved`);
  }

  rightSide.appendChild(guidesBtn);
  rightSide.appendChild(ixSnapshotsBtn);
  rightSide.appendChild(exportBtn);

  topbar.appendChild(leftSide);
  topbar.appendChild(segmented);
  topbar.appendChild(rightSide);

  // ---- canvas ----
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'stage';
  canvasWrap.appendChild(canvas);

  // Phase 5.2 item 3: a fixed three-part bottom — Undo/Redo (and Fit), then a context slot whose
  // height is ALWAYS reserved (the ribbon inside it hides without collapsing, so nothing above or
  // below it ever jumps), then the dock.
  const overlay = document.createElement('div');
  overlay.className = 'canvas-overlay-bottom';

  const utilRow = document.createElement('div');
  utilRow.className = 'util-row';
  const undoRedoPill = document.createElement('div');
  undoRedoPill.className = 'undo-redo-pill';
  const undoBtn = document.createElement('button');
  undoBtn.setAttribute('aria-label', 'Undo');
  undoBtn.innerHTML = iconSvg('undo', 20);
  undoBtn.addEventListener('click', () => controller.undo());
  const divider = document.createElement('div');
  divider.className = 'divider';
  const redoBtn = document.createElement('button');
  redoBtn.setAttribute('aria-label', 'Redo');
  redoBtn.innerHTML = iconSvg('redo', 20);
  redoBtn.addEventListener('click', () => controller.redo());
  undoRedoPill.appendChild(undoBtn);
  undoRedoPill.appendChild(divider);
  undoRedoPill.appendChild(redoBtn);

  const fitBtn = document.createElement('button');
  fitBtn.className = 'fit-btn';
  fitBtn.setAttribute('aria-label', 'Fit drawing to screen');
  fitBtn.innerHTML = iconSvg('fit');
  fitBtn.addEventListener('click', () => opts.onFit());

  // The reference: the opacity eye (only while this artwork has one) and the Reference panel,
  // beside Fit — on the canvas's own control row, in every workspace. The eye shows or hides two
  // quiet vertical sliders on the canvas's right edge — the reference's strength above, the
  // artwork's over it below: this workspace's, the same values as the Reference panel's (a view,
  // like the camera — never an Undo step). Show/Hide itself stays in the Reference panel.
  const referenceEyeBtn = document.createElement('button');
  referenceEyeBtn.className = 'fit-btn reference-eye';
  referenceEyeBtn.setAttribute('aria-label', 'Opacity');
  referenceEyeBtn.setAttribute('aria-pressed', 'false');
  const referencePanelBtn = document.createElement('button');
  referencePanelBtn.className = 'fit-btn reference-btn';
  referencePanelBtn.setAttribute('aria-label', 'Reference');
  referencePanelBtn.innerHTML = iconSvg('reference');
  let opacityOpen = false;
  const opacityColumn = document.createElement('div');
  opacityColumn.className = 'opacity-column';
  opacityColumn.style.display = 'none';
  const setOpacity = (patch: { referenceOpacity?: number; artworkOpacity?: number }) => {
    const ws = controller.doc.view.workspace;
    // Strengthening either while the reference is hidden would change nothing to see: show it.
    controller.doc.underlayView = withUnderlayView(controller.doc, ws, { ...patch, visible: true });
    controller.notifyView();
    refreshReferenceButtons();
    if (openPopoverAnchor === referencePanelBtn) openReferencePanel(); // an open panel follows
  };
  const opacitySliders = [
    verticalSlider('Reference opacity', iconSvg('reference', 16), 0, () => underlayViewOf(controller.doc, controller.doc.view.workspace).referenceOpacity, (x) => setOpacity({ referenceOpacity: x })),
    verticalSlider('Artwork opacity', iconSvg('circle', 16), 0.05, () => underlayViewOf(controller.doc, controller.doc.view.workspace).artworkOpacity, (x) => setOpacity({ artworkOpacity: x })),
  ];
  for (const sl of opacitySliders) opacityColumn.appendChild(sl.el);
  canvasWrap.appendChild(opacityColumn);
  function refreshReferenceButtons(): void {
    const u = controller.doc.underlay;
    referenceEyeBtn.style.display = u ? '' : 'none';
    referencePanelBtn.classList.toggle('has-reference', !!u);
    if (!u) opacityOpen = false;
    opacityColumn.style.display = opacityOpen ? '' : 'none';
    referenceEyeBtn.classList.toggle('active', opacityOpen);
    referenceEyeBtn.setAttribute('aria-pressed', String(opacityOpen));
    if (!u) return;
    // The eye also says whether the reference is shown at all here.
    const shown = underlayViewOf(controller.doc, controller.doc.view.workspace).visible;
    if (eyeShows !== shown) {
      eyeShows = shown;
      referenceEyeBtn.innerHTML = iconSvg(shown ? 'eye' : 'eyeOff');
      referenceEyeBtn.title = shown ? 'Opacity' : 'Opacity · the reference is hidden';
    }
    if (opacityOpen) for (const sl of opacitySliders) sl.refresh();
  }
  let eyeShows: boolean | null = null;
  const openReferencePanel = () => showReferencePanel(referencePanelBtn, controller, { onChange: refreshReferenceButtons, startTransform });
  onTap(referenceEyeBtn, () => {
    opacityOpen = !opacityOpen;
    refreshReferenceButtons();
  });
  controller.subscribeView(refreshReferenceButtons); // a Show/Hide or a strength set elsewhere
  onTap(referencePanelBtn, () => togglePanel(referencePanelBtn, openReferencePanel));

  // Repeat: the handles on or off in one tap (Grid and guides keeps every guide, handles included).
  const handlesBtn = document.createElement('button');
  handlesBtn.className = 'fit-btn handles-btn';
  handlesBtn.setAttribute('aria-label', 'Handles');
  handlesBtn.innerHTML = iconSvg('handles');
  function refreshHandlesBtn(): void {
    const on = controller.doc.repeatDisplay.handles;
    handlesBtn.setAttribute('aria-pressed', String(on));
    handlesBtn.title = on ? 'Hide the handles' : 'Show the handles';
    handlesBtn.classList.toggle('off', !on);
  }
  onTap(handlesBtn, () => {
    if (openPopoverAnchor === guidesBtn) closeAnyPopover(); // its rows would be out of date
    controller.doc.repeatDisplay.handles = !controller.doc.repeatDisplay.handles;
    refreshGuidesBtn();
    controller.notifyView();
  });

  // Reference Transform: an explicit mode with an obvious way out — a compact row at the canvas's
  // bottom right: [Move image | Anchors] says which of its two modes is on, Done locks the image.
  // While Move image is on, every finger on the canvas moves the reference (main.ts →
  // referenceTakeover); while Anchors is on, one finger places anchors and two move the camera. What
  // the fingers do is said briefly, in a small bubble, when Transform begins or the mode changes.
  const transformBar = document.createElement('div');
  transformBar.className = 'transform-bar';
  transformBar.style.display = 'none';
  const transformHint = document.createElement('div');
  transformHint.className = 'transform-hint';
  transformHint.setAttribute('role', 'status');
  // A desktop has no second finger on the canvas: say what the trackpad and keys do instead.
  const finePointer = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
  const moveHint = finePointer ? 'Drag to move · pinch or ⌘-scroll to scale · ⌥-scroll to turn' : 'Drag to move · two fingers to scale and turn';
  const anchorHint = finePointer ? 'Press the image to place an anchor · slide to refine' : 'Press the image to place an anchor · slide to refine · two fingers zoom';
  const HINT_MS = 3800;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  function showTransformHint(): void {
    transformHint.textContent = controller.referenceAnchorMode ? anchorHint : moveHint;
    transformHint.classList.add('show');
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => transformHint.classList.remove('show'), HINT_MS);
  }
  const transformDone = document.createElement('button');
  transformDone.className = 'space-chip active transform-done';
  transformDone.textContent = 'Done';
  transformDone.setAttribute('aria-label', 'Done — lock the reference');
  onTap(transformDone, () => setReferenceTransform(false));
  // The two modes. Anchors: places marked in the image to align it by (reference/anchors.ts) —
  // placed and refined here, then used by the gentle snapping while the image is moved.
  const transformMode = document.createElement('div');
  transformMode.className = 'segmented-mini transform-mode';
  transformMode.setAttribute('role', 'group');
  transformMode.setAttribute('aria-label', 'Transform mode');
  const moveBtn = document.createElement('button');
  moveBtn.className = 'transform-move';
  moveBtn.textContent = 'Move image';
  const anchorsBtn = document.createElement('button');
  anchorsBtn.className = 'transform-anchors';
  anchorsBtn.textContent = 'Anchors';
  const setAnchorMode = (on: boolean) => {
    if (controller.referenceAnchorMode === on) return;
    controller.referenceAnchorMode = on;
    controller.anchorSelected = null;
    controller.anchorDraft = null;
    controller.anchorLoupe = null;
    refreshTransformBar();
    showTransformHint();
    controller.notify();
  };
  onTap(moveBtn, () => setAnchorMode(false));
  onTap(anchorsBtn, () => setAnchorMode(true));
  transformMode.appendChild(moveBtn);
  transformMode.appendChild(anchorsBtn);
  const removeAnchorBtn = document.createElement('button');
  removeAnchorBtn.className = 'space-chip transform-remove-anchor';
  removeAnchorBtn.textContent = 'Remove';
  removeAnchorBtn.setAttribute('aria-label', 'Remove anchor');
  onTap(removeAnchorBtn, () => removeSelectedAnchor(controller));
  function refreshTransformBar(): void {
    const anchoring = controller.referenceAnchorMode;
    moveBtn.classList.toggle('active', !anchoring);
    moveBtn.setAttribute('aria-pressed', String(!anchoring));
    anchorsBtn.classList.toggle('active', anchoring);
    anchorsBtn.setAttribute('aria-pressed', String(anchoring));
    removeAnchorBtn.style.display = anchoring && controller.anchorSelected ? '' : 'none';
  }
  transformBar.appendChild(transformHint);
  transformBar.appendChild(transformMode);
  transformBar.appendChild(removeAnchorBtn);
  transformBar.appendChild(transformDone);
  function setReferenceTransform(on: boolean): void {
    if (controller.referenceTransform === on) return;
    settleReferenceWheel(); // a pinch or scroll still being shown is kept, not lost
    controller.referenceTransform = on;
    controller.referenceAnchorMode = false;
    controller.anchorSelected = null;
    controller.anchorDraft = null;
    controller.anchorLoupe = null;
    refreshTransformBar();
    controller.underlayDraft = null;
    transformBar.style.display = on ? '' : 'none';
    if (on) showTransformHint();
    else transformHint.classList.remove('show');
    referencePanelBtn.classList.toggle('transforming', on);
    controller.notifyView();
  }
  function startTransform(): void {
    closeAnyPopover();
    const ws = controller.doc.view.workspace;
    // What is being moved must be seen.
    if (!underlayViewOf(controller.doc, ws).visible) controller.doc.underlayView = withUnderlayView(controller.doc, ws, { visible: true });
    setReferenceTransform(true);
    refreshReferenceButtons();
  }
  const utilRight = document.createElement('div');
  utilRight.className = 'util-right';
  utilRight.appendChild(handlesBtn);
  utilRight.appendChild(referenceEyeBtn);
  utilRight.appendChild(referencePanelBtn);
  utilRight.appendChild(fitBtn);

  utilRow.appendChild(undoRedoPill);
  utilRow.appendChild(utilRight);

  const contextSlot = document.createElement('div');
  contextSlot.className = 'context-slot';
  const contextBar = document.createElement('div');
  contextBar.className = 'context-bar';
  contextSlot.appendChild(contextBar);

  const dock = document.createElement('div');
  dock.className = 'dock';
  const dockButtonEls = new Map<ToolId, HTMLButtonElement>();
  for (const spec of DOCK_BUTTONS) {
    if (spec.divider) {
      const d = document.createElement('div');
      d.className = 'divider';
      dock.appendChild(d);
    }
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', spec.label);
    btn.innerHTML = `${iconSvg(spec.id as IconName)}<span class="label">${spec.label}</span>`;
    btn.addEventListener('click', () => {
      // Phase 5.2 item 23: tapping the lit Divide button again cancels the current target (and its
      // preview) but stays in Divide; otherwise the usual lit-tool-returns-to-Select convention.
      if (spec.id === 'divide' && controller.tool === 'divide' && controller.divide) {
        setDivideTarget(controller, null);
        return;
      }
      controller.setTool(spec.id);
    });
    dockButtonEls.set(spec.id, btn);
    dock.appendChild(btn);
  }

  // ---- Phase 5: Repeat's own compact control panel — family, orientation rule, Guide toggle,
  // and a live contact/rotation status readout. Shown only while the Repeat workspace is active
  // (see update()); Repeat has no tool dock and no Select-style context bar of its own. ----
  const repeatPanel = document.createElement('div');
  repeatPanel.className = 'repeat-panel';

  const repeatStatus = document.createElement('div');
  repeatStatus.className = 'repeat-status';
  repeatPanel.appendChild(repeatStatus);

  // The lattice is shaped by its handles alone (precise 90° / 60° relations and equal arms snap —
  // geometry/latticeSnap.ts); Grid and guides keeps a Reset lattice.

  const ruleRow = document.createElement('div');
  ruleRow.className = 'segmented-mini';
  const RULES: { id: RepeatSystem['rule']['kind']; label: string }[] = [
    { id: 'same', label: 'Uniform' },
    { id: 'alternate', label: 'Alternate' },
    { id: 'mirror', label: 'Mirror' },
  ];
  const ruleBtns = new Map<RepeatSystem['rule']['kind'], HTMLButtonElement>();
  for (const r of RULES) {
    const btn = document.createElement('button');
    btn.textContent = r.label;
    btn.addEventListener('click', () => {
      if (controller.doc.repeat.rule.kind === r.id) return;
      controller.commit((d) => {
        d.repeat.rule = { kind: r.id };
      });
    });
    ruleBtns.set(r.id, btn);
    ruleRow.appendChild(btn);
  }
  // Repeat Colouring (geometry/repeatColour.ts): beside the rule — how copies alternate in
  // orientation there, how they may differ in colour here. A toggle; while on, the lattice rows
  // step aside for its own few controls and a tap colours a region of the repeated design.
  const ruleLine = document.createElement('div');
  ruleLine.className = 'space-row';
  ruleLine.appendChild(ruleRow);
  const colouringBtn = document.createElement('button');
  colouringBtn.className = 'space-chip';
  colouringBtn.textContent = 'Fill';
  colouringBtn.title = 'Fill spaces and regions of the pattern';
  colouringBtn.setAttribute('aria-pressed', 'false');
  onTap(colouringBtn, () => setFillScope(fillScope() ? null : lastFillScope));
  ruleLine.appendChild(colouringBtn);
  repeatPanel.appendChild(ruleLine);

  // While filling: ● [Space | Motif | Pattern] · Done. The dot is the Fill colour now; it opens
  // Appearance → Fill (upper left), where the colour and opacity are chosen — never duplicated here.
  const colourKindRow = document.createElement('div');
  colourKindRow.className = 'space-row fill-row';
  const fillDotBtn = document.createElement('button');
  fillDotBtn.className = 'space-chip fill-dot-btn';
  const fillDot = document.createElement('span');
  fillDot.className = 'stroke-chip-dot';
  fillDotBtn.appendChild(fillDot);
  onTap(fillDotBtn, () => {
    appearanceTab = 'fill';
    togglePanel(appearanceBtn, openAppearance);
  });
  const colourKind = document.createElement('div');
  colourKind.className = 'segmented-mini';
  colourKind.setAttribute('role', 'group');
  colourKind.setAttribute('aria-label', 'Fill');
  const colourKindBtns = new Map<FillScope, HTMLButtonElement>();
  for (const [id, label, title] of [
    ['space', 'Space', 'A space enclosed between motifs — and every one like it'],
    ['motif', 'Motif', 'A region of the motif — in every copy'],
    ['pattern', 'Pattern', 'A region of the motif — in every other copy, row or column'],
  ] as const) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    onTap(b, () => setFillScope(id));
    colourKindBtns.set(id, b);
    colourKind.appendChild(b);
  }
  const colourDone = document.createElement('button');
  colourDone.className = 'space-chip active';
  colourDone.textContent = 'Done';
  colourDone.setAttribute('aria-label', 'Done filling');
  onTap(colourDone, () => setFillScope(null));
  colourKindRow.appendChild(fillDotBtn);
  colourKindRow.appendChild(colourKind);
  colourKindRow.appendChild(colourDone);
  repeatPanel.appendChild(colourKindRow);

  // Close Gap (Stage C): picking — "Tap near a gap" · Cancel; previewing — up to three nearby gaps,
  // which arm moves and by how much, Apply · Cancel. Nothing changes until Apply (one Undo step).
  const closeGapRow = document.createElement('div');
  closeGapRow.className = 'space-row close-gap-row';
  function closeGapCancel(): void {
    controller.closeGap = null;
    controller.notify();
  }
  function refreshCloseGapRow(): void {
    closeGapRow.innerHTML = '';
    const st = controller.closeGap;
    if (!st) return;
    const add = (label: string, cls: string, act: () => void, aria?: string) => {
      const b = document.createElement('button');
      b.className = `space-chip ${cls}`;
      b.textContent = label;
      if (aria) b.setAttribute('aria-label', aria);
      onTap(b, act);
      closeGapRow.appendChild(b);
      return b;
    };
    if (st.phase === 'pick') {
      const cue = document.createElement('span');
      cue.className = 'close-gap-cue';
      cue.textContent = 'Tap near a gap';
      closeGapRow.appendChild(cue);
      add('Cancel', '', closeGapCancel);
      return;
    }
    if (st.local.length > 1)
      st.local.forEach((g, k) =>
        add(`${k + 1}·${g.cand.arm.toUpperCase()} ${g.cand.distance.toFixed(1)}`, k === st.index ? 'active' : '', () => {
          controller.closeGap = { ...st, index: k };
          controller.notify();
        }, `Gap ${k + 1}: arm ${g.cand.arm.toUpperCase()}, ${g.cand.distance.toFixed(2)} apart`),
      );
    const g = st.local[st.index]!;
    const what = document.createElement('span');
    what.className = 'close-gap-cue';
    what.textContent = describeGap(g);
    closeGapRow.appendChild(what);
    add('Apply', 'active', () => {
      controller.closeGap = null;
      controller.commit((d) => {
        d.repeat[g.cand.arm] = { ...g.repeat[g.cand.arm] };
      });
      showToast(`Gap closed · ${g.cand.arm.toUpperCase()} adjusted`);
    });
    add('Cancel', '', closeGapCancel);
  }
  repeatPanel.appendChild(closeGapRow);

  // Pattern Colouring: which copies form the second group — by their place in the lattice.
  const patternRow = document.createElement('div');
  patternRow.className = 'space-row';
  const patternLabel = document.createElement('span');
  patternLabel.className = 'space-label';
  patternLabel.textContent = 'Alternate';
  const patternSeg = document.createElement('div');
  patternSeg.className = 'segmented-mini';
  patternSeg.setAttribute('role', 'group');
  patternSeg.setAttribute('aria-label', 'Alternate');
  const patternBtns = new Map<PatternBy, HTMLButtonElement>();
  for (const [id, label, title] of [
    ['copies', 'Copies', 'Every other copy'],
    ['rows', 'Rows', 'Every other row'],
    ['columns', 'Columns', 'Every other column'],
  ] as const) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    onTap(b, () => setPatternBy(id));
    patternBtns.set(id, b);
    patternSeg.appendChild(b);
  }
  // Like Source: label and choice on one quiet pill, readable over the pattern.
  const patternGroup = document.createElement('div');
  patternGroup.className = 'source-group pattern-group';
  patternGroup.appendChild(patternLabel);
  patternGroup.appendChild(patternSeg);
  patternRow.appendChild(patternGroup);
  repeatPanel.appendChild(patternRow);
  /** How copies alternate — a choice about the pattern, so one Undo step (and a recorded moment). */
  function setPatternBy(by: PatternBy): void {
    const now = controller.doc.repeatSetup?.colour?.pattern;
    if (now?.by === by) return;
    controller.commit((d) => {
      const c = structuredClone(d.repeatSetup?.colour ?? {});
      c.pattern = { by, regions: c.pattern?.regions ?? {} };
      d.repeatSetup = { ...(d.repeatSetup ?? { source: repeatSource(d) }), colour: c };
    });
  }

  /** Which Fill scope is on (null: not filling). Space, Motif and Pattern share one colour. */
  function fillScope(): FillScope | null {
    return controller.spaceMode ? 'space' : controller.repeatColourMode;
  }
  /** Fill, scoped: Space (spaces between motifs), Motif (a region in every copy) or Pattern (a
   * region in the second group of copies) — or null to stop filling. */
  function setFillScope(scope: FillScope | null): void {
    closeAnyPopover();
    if (scope === fillScope()) return;
    if (scope) lastFillScope = scope;
    controller.spaceMode = scope === 'space';
    controller.repeatColourMode = scope === 'motif' || scope === 'pattern' ? scope : null;
    if (scope) controller.closeGap = null;
    if (scope === 'space') showToast('Tap a space between motifs to fill it — and every one like it');
    if (scope === 'motif') showToast('Tap a region to fill it in every copy');
    if (scope === 'pattern') {
      // Copies alternating is where a pattern starts; rows or columns are one tap away.
      const p = controller.doc.repeatSetup?.colour?.pattern;
      if (!p || p.by === 'none') setPatternBy('copies');
      showToast('Marked copies are the second group · tap a region to fill it there');
    }
    controller.notify();
  }
  function refreshColourRows(): void {
    const scope = fillScope();
    colouringBtn.classList.toggle('active', !!scope);
    colouringBtn.setAttribute('aria-pressed', String(!!scope));
    for (const [id, b] of colourKindBtns) b.classList.toggle('active', scope === id);
    const by = controller.doc.repeatSetup?.colour?.pattern?.by;
    for (const [id, b] of patternBtns) b.classList.toggle('active', by === id);
    const paint = repeatFill(controller);
    fillDot.classList.toggle('none', !paint);
    fillDot.style.background = paint ?? '';
    fillDotBtn.setAttribute('aria-label', `Fill colour ${repeatPaint(controller) ?? 'no fill'}, ${Math.round(repeatPaintOpacity(controller) * 100)}% — change in Appearance`);
  }

  // The Source row (Fill's Space moved into Fill: Space | Motif | Pattern).
  const spaceRow = document.createElement('div');
  spaceRow.className = 'space-row';
  // Source: what stands at each lattice position — the motif (as ever), or the current Intersect
  // arrangement as one unit (geometry/repeatUnit.ts). Only the choice is kept; nothing is copied.
  // It shares Space's row (and steps aside while Space's own controls are out), so the panel is no
  // taller. Spaces belong to the single motif's repeat, so Space rests while the source is Intersect.
  const sourceGroup = document.createElement('div');
  sourceGroup.className = 'source-group';
  const sourceLabel = document.createElement('span');
  sourceLabel.className = 'space-label';
  sourceLabel.textContent = 'Source';
  const sourceSeg = document.createElement('div');
  sourceSeg.className = 'segmented-mini';
  sourceSeg.setAttribute('role', 'group');
  sourceSeg.setAttribute('aria-label', 'Repeat source');
  const sourceBtns = new Map<RepeatSource, HTMLButtonElement>();
  for (const [id, label, title] of [
    ['motif', 'Construct', 'Repeat the construction itself'],
    ['intersect', 'Intersect', 'Repeat the Intersect arrangement as one unit'],
  ] as const) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    onTap(b, () => {
      if (repeatSource(controller.doc) === id) return;
      closeAnyPopover();
      // One Undo step; each source keeps its own spacing, appearance and colouring. No geometry is
      // made or changed.
      switchRepeatSource(controller, id);
    });
    sourceBtns.set(id, b);
    sourceSeg.appendChild(b);
  }
  sourceGroup.appendChild(sourceLabel);
  sourceGroup.appendChild(sourceSeg);

  spaceRow.appendChild(sourceGroup);
  repeatPanel.appendChild(spaceRow);

  // Spread: centres in or out about the reference group's centre (100% = the reference); Reference
  // makes what is shown now the reference. Sizes and rotations never change. Logarithmic, 25–500%,
  // so 100% sits mid-way with fine control either side. Once a copy is added or removed, the old
  // reference is out of date: Spread rests (and says so) until Reference is set again.
  const ixSpreadRow = document.createElement('div');
  ixSpreadRow.className = 'space-row spread-row';
  const spreadLabel = document.createElement('span');
  spreadLabel.className = 'space-label';
  spreadLabel.textContent = 'Spread';
  const spreadSlider = document.createElement('input');
  spreadSlider.type = 'range';
  spreadSlider.className = 'width-slider spread-slider';
  spreadSlider.min = '0';
  spreadSlider.max = String(SPREAD_SLIDER_MAX);
  spreadSlider.step = '1';
  spreadSlider.setAttribute('aria-label', 'Spread');
  const spreadValue = document.createElement('span');
  spreadValue.className = 'space-label spread-value';
  spreadSlider.addEventListener('input', () => {
    const spread = sliderToSpread(Number(spreadSlider.value));
    controller.intersectionSpreadDraft = spread;
    spreadValue.textContent = `${Math.round(spread * 100)}%`;
    controller.notifyView();
  });
  spreadSlider.addEventListener('change', () => {
    const spread = sliderToSpread(Number(spreadSlider.value));
    controller.intersectionSpreadDraft = null;
    if (Math.abs(spread - layoutOf(controller.doc).spread) < 1e-9) {
      controller.notify();
      return;
    }
    controller.commit((d) => {
      // Locked constructions stay where they are; the others spread about the centre.
      d.intersection = withLayout(d, withSpreadAround(d, spread));
    });
  });
  const referenceBtn = document.createElement('button');
  referenceBtn.className = 'space-chip';
  referenceBtn.textContent = 'Reference';
  referenceBtn.title = 'Make this arrangement the Spread reference (100%)';
  referenceBtn.setAttribute('aria-label', 'Set this arrangement as the Spread reference');
  onTap(referenceBtn, () => {
    controller.commit((d) => {
      d.intersection = withLayout(d, asReference(layoutOf(d)));
    });
    showToast('Spread reference set');
  });
  ixSpreadRow.appendChild(spreadLabel);
  ixSpreadRow.appendChild(spreadSlider);
  ixSpreadRow.appendChild(spreadValue);
  ixSpreadRow.appendChild(referenceBtn);

  // Snap: only once something is picked (a tap on a line or point — see intersectionTool). Two
  // lines offer Parallel (turn only) and Join (slide only, once parallel); two points offer Snap
  // (slide only). Each moves just the second pick's construction, as one Undo step. The Line |
  // Point switch says what taps pick, and turns what is picked into the other kind where it was
  // tapped (a line into the point on it there; a point into the line through it).
  const ixSnapRow = document.createElement('div');
  ixSnapRow.className = 'snap-row';
  const snapStatus = document.createElement('div');
  snapStatus.className = 'space-label snap-status';
  const snapDot = document.createElement('span');
  snapDot.className = 'snap-dot';
  const snapText = document.createElement('span');
  snapText.className = 'snap-text';
  snapStatus.appendChild(snapDot);
  snapStatus.appendChild(snapText);
  const snapControls = document.createElement('div');
  snapControls.className = 'space-row';
  const kindSeg = document.createElement('div');
  kindSeg.className = 'segmented-mini snap-kind';
  const kindBtns = new Map<PickKind, HTMLButtonElement>();
  for (const [kind, label] of [
    ['line', 'Line'],
    ['point', 'Point'],
    ['edge', 'Edge'],
  ] as const) {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-label', kind === 'edge' ? 'Match edges' : `Pick ${label.toLowerCase()}s`);
    onTap(b, () => setPickKind(kind));
    kindBtns.set(kind, b);
    kindSeg.appendChild(b);
  }
  /** Taps pick `kind` from now on; what is picked becomes that kind where it was tapped. */
  function setPickKind(kind: PickKind): void {
    if (controller.intersectionPickKind === kind) return;
    // Match Edge picks in its own order (the moving edge first): its picks and the others' never
    // turn into one another — switching in or out starts afresh; so does starting or ending an
    // alignment from instance selection.
    if (kind === 'edge' || controller.intersectionPickKind === 'edge' || kind === 'instance' || controller.intersectionPickKind === 'instance') {
      controller.intersectionPickKind = kind;
      controller.intersectionPicks = [];
      controller.notify();
      return;
    }
    controller.intersectionPickKind = kind;
    const copies = intersectionCopies(controller.doc);
    const reach = (PICK_REACH_PX * 2) / opts.getView().zoom;
    const [reference, moving] = controller.intersectionPicks;
    const ref = reference ? convertPick(controller.doc, copies, reference, kind, reach) : null;
    const mov = ref && moving ? convertPick(controller.doc, copies, moving, kind, reach, (p) => canMoveAgainst(ref, p)) : null;
    const picks = ref ? (mov ? [ref, mov] : [ref]) : [];
    if (picks.length < controller.intersectionPicks.length) showToast(kind === 'point' ? 'No point there — tap one' : 'No line there — tap one', 2200, 'warning');
    controller.intersectionPicks = picks;
    controller.notify();
  }
  const snapChip = (label: string, title: string) => {
    const b = document.createElement('button');
    b.className = 'space-chip snap-op';
    b.textContent = label;
    b.title = title;
    return b;
  };
  const parallelBtn = snapChip('Parallel', 'Turn the second line’s construction until its line is parallel to the first');
  const joinBtn = snapChip('Join', 'Slide the second line’s construction across until its line lies on the first');
  const pointSnapBtn = snapChip('Snap', 'Slide the second point’s construction until its point lies on the first');
  const matchEdgeBtn = snapChip('Match Edge', 'Turn and slide the first edge’s construction until that edge lies exactly on the second edge');
  // Instance selection's own row: the selected instance, and the three alignments that start from it
  // — each switches taps to what it needs (lines, points or edges).
  const alignRow = document.createElement('div');
  alignRow.className = 'space-row align-row';
  for (const [label, kind] of [
    ['Parallel · Join', 'line'],
    ['Point Snap', 'point'],
    ['Match Edge', 'edge'],
  ] as const) {
    const b = snapChip(label, `Align: ${label}`);
    onTap(b, () => setPickKind(kind));
    alignRow.appendChild(b);
  }
  // Lock: the selected construction stays exactly where it is (it can still be selected, and be the
  // one others are aligned to). Which construction is the reference of an alignment is chosen by
  // the picks; Lock only decides which may move. One Undo step.
  const lockBtn = document.createElement('button');
  lockBtn.className = 'space-chip lock-chip';
  onTap(lockBtn, () => {
    const key = controller.intersectionSelected;
    if (!key) return;
    const locked = isLocked(controller.doc, key);
    controller.commit((d) => {
      d.intersection = withLock(d, key, !locked);
    });
  });
  alignRow.appendChild(lockBtn);
  const LOCK_ICON = (closed: boolean) =>
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="${closed ? 'M8 11V8a4 4 0 0 1 8 0v3' : 'M8 11V8a4 4 0 0 1 7.5-2'}"/></svg>`;
  const snapClearBtn = document.createElement('button');
  snapClearBtn.className = 'space-chip snap-clear';
  snapClearBtn.setAttribute('aria-label', 'Clear the selection');
  snapClearBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3 L11 11 M11 3 L3 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  /** Moves one construction as shown — turned to `rotation`, slid by `shift` — as one step. */
  const placeCopy = (key: string, shift: Vec2, rotation: number | null) => {
    const copy = intersectionCopies(controller.doc).find((c) => c.key === key);
    if (!copy) return;
    if (copy.locked) {
      showToast(`${copy.label} is locked · unlock it to move`, 2200, 'warning');
      return;
    }
    const at = { x: copy.pose.translate.x + shift.x, y: copy.pose.translate.y + shift.y };
    controller.commit((d) => {
      d.intersection = withLayout(d, placedAt(layoutOf(d), key, at, rotation ?? copy.pose.rotation));
    });
  };
  const currentPlan = () => {
    const [reference, moving] = controller.intersectionPicks;
    return reference && moving ? planSnap(controller.doc, intersectionCopies(controller.doc), reference, moving) : null;
  };
  onTap(parallelBtn, () => {
    const plan = currentPlan();
    if (plan?.kind !== 'lines' || plan.parallel) return;
    const copy = intersectionCopies(controller.doc).find((c) => c.key === plan.moving);
    if (copy) placeCopy(plan.moving, { x: 0, y: 0 }, copy.pose.rotation + plan.turn);
  });
  onTap(joinBtn, () => {
    const plan = currentPlan();
    if (plan?.kind === 'lines' && plan.shift && !plan.joined) placeCopy(plan.moving, plan.shift, null);
  });
  onTap(pointSnapBtn, () => {
    const plan = currentPlan();
    if (plan?.kind === 'points' && !plan.snapped) placeCopy(plan.moving, plan.shift, null);
  });
  onTap(matchEdgeBtn, () => {
    const [moving, target] = controller.intersectionPicks;
    if (controller.intersectionPickKind !== 'edge' || !moving || !target) return;
    const plan = planMatchEdge(controller.doc, intersectionCopies(controller.doc), moving, target);
    if (plan.kind !== 'edge' || plan.matched) return;
    if (isLocked(controller.doc, plan.moving)) {
      showToast('That construction is locked · unlock it to move', 2200, 'warning');
      return;
    }
    // One exact rigid move — one Undo step.
    controller.commit((d) => {
      d.intersection = withLayout(d, placedAt(layoutOf(d), plan.moving, plan.translate, plan.rotation));
    });
  });
  onTap(snapClearBtn, () => {
    controller.intersectionPicks = [];
    controller.intersectionPickKind = 'instance'; // back to arranging whole instances
    controller.notify();
  });
  ixSnapRow.appendChild(snapStatus);
  snapControls.appendChild(kindSeg);
  snapControls.appendChild(parallelBtn);
  snapControls.appendChild(joinBtn);
  snapControls.appendChild(pointSnapBtn);
  snapControls.appendChild(matchEdgeBtn);
  snapControls.appendChild(snapClearBtn);
  ixSnapRow.appendChild(snapControls);
  ixSnapRow.appendChild(alignRow);
  repeatPanel.appendChild(ixSnapRow);

  repeatPanel.appendChild(ixSpreadRow);

  /** The Snap row for the current picks — after first dropping any pick that no longer exists
   * (never kept at an old position). */
  function refreshSnapRow(): void {
    const copies = intersectionCopies(controller.doc);
    const picks = controller.intersectionPicks;
    if (picks.length > 0) {
      const kept = resolvePick(controller.doc, copies, picks[0]!) ? (picks[1] && !resolvePick(controller.doc, copies, picks[1]) ? [picks[0]!] : picks) : [];
      if (kept.length !== picks.length) {
        controller.intersectionPicks = kept;
        if (controller.intersectionSelected && !copies.some((c) => c.key === controller.intersectionSelected)) controller.intersectionSelected = null;
        showToast(kept.length === 0 ? 'Selection cleared — it is no longer there' : 'Second pick cleared — it is no longer there');
      }
    }
    const [reference, moving] = controller.intersectionPicks;
    const kind = controller.intersectionPickKind;
    const edgeMode = kind === 'edge';
    const labelOf = (key: string) => copies.find((c) => c.key === key)?.label ?? '';
    const colourOf = (key: string) => copies.find((c) => c.key === key)?.colour ?? '';
    // Instance selection (the default): the selected instance, and the alignments to start from it.
    if (kind === 'instance') {
      const sel = copies.find((c) => c.key === controller.intersectionSelected);
      ixSnapRow.style.display = sel ? '' : 'none';
      snapControls.style.display = 'none';
      alignRow.style.display = '';
      if (!sel) return;
      snapText.textContent = sel.locked ? `${sel.label} locked · stays in place` : `${sel.label} selected · drag to move, handle to turn`;
      snapDot.style.display = '';
      snapDot.style.background = sel.colour;
      // A padlock (closed while locked) — compact enough for the row on a phone; the status says it.
      lockBtn.innerHTML = LOCK_ICON(sel.locked);
      lockBtn.title = sel.locked ? 'Unlock — let it move again' : 'Lock — keep it exactly where it is';
      lockBtn.classList.toggle('active', sel.locked);
      lockBtn.setAttribute('aria-pressed', String(sel.locked));
      lockBtn.setAttribute('aria-label', sel.locked ? `Unlock ${sel.label}` : `Lock ${sel.label}`);
      return;
    }
    // An alignment being set up: its picks, the operations, the switch between what taps take, ×.
    ixSnapRow.style.display = '';
    snapControls.style.display = '';
    alignRow.style.display = 'none';
    for (const [k, b] of kindBtns) b.classList.toggle('active', kind === k);
    matchEdgeBtn.style.display = edgeMode ? '' : 'none';
    if (edgeMode) {
      parallelBtn.style.display = 'none';
      joinBtn.style.display = 'none';
      pointSnapBtn.style.display = 'none';
      const edgePlan = reference && moving ? planMatchEdge(controller.doc, copies, reference, moving) : null;
      let edgeText: string;
      if (!reference) edgeText = 'Match Edge · tap the edge that moves';
      else if (!edgePlan) edgeText = `${labelOf(reference.kind === 'line' ? reference.copy : '')} edge moves · now tap the edge it goes onto`;
      else if (edgePlan.kind === 'none') edgeText = edgePlan.note;
      else if (edgePlan.matched) edgeText = 'Edges matched';
      else if (isLocked(controller.doc, edgePlan.moving)) edgeText = `${labelOf(edgePlan.moving)} is locked · unlock it to move`;
      else edgeText = `Match Edge moves ${labelOf(edgePlan.moving)} onto ${labelOf(edgePlan.target)}`;
      const dotKey = edgePlan?.kind === 'edge' ? edgePlan.moving : reference?.kind === 'line' ? reference.copy : '';
      snapText.textContent = edgeText;
      snapDot.style.display = dotKey ? '' : 'none';
      snapDot.style.background = colourOf(dotKey);
      matchEdgeBtn.disabled = edgePlan?.kind !== 'edge' || edgePlan.matched || isLocked(controller.doc, edgePlan.moving);
      return;
    }
    if (!reference) {
      snapText.textContent = kind === 'point' ? 'Point Snap · tap the point that stays' : 'Parallel · Join · tap the line that stays';
      snapDot.style.display = 'none';
      parallelBtn.style.display = 'none';
      joinBtn.style.display = 'none';
      pointSnapBtn.style.display = 'none';
      return;
    }
    const plan = moving ? planSnap(controller.doc, copies, reference, moving) : null;
    const lines = plan ? plan.kind === 'lines' : !isPointPick(reference);
    let text: string;
    let dot = '';
    if (!plan) text = isPointPick(reference) ? 'Reference point · now tap a point to move' : 'Reference line · now tap a line to move';
    else if (plan.kind === 'none') text = plan.note;
    else {
      dot = colourOf(plan.moving);
      const who = labelOf(plan.moving);
      if (isLocked(controller.doc, plan.moving) && !(plan.kind === 'points' ? plan.snapped : plan.joined)) text = `${who} is locked · unlock it to move`;
      else if (plan.kind === 'points') text = plan.snapped ? 'Points coincide' : `Snap moves ${who}`;
      else if (plan.joined) text = 'Lines joined';
      else if (plan.parallel) text = `Parallel — Join moves ${who}`;
      else {
        const deg = Math.abs((plan.turn * 180) / Math.PI);
        text = `Parallel turns ${who} ${deg < 0.05 ? '<0.1' : deg.toFixed(1)}°`;
      }
    }
    snapText.textContent = text;
    snapDot.style.display = dot ? '' : 'none';
    snapDot.style.background = dot;
    parallelBtn.style.display = lines && plan ? '' : 'none';
    joinBtn.style.display = lines && plan ? '' : 'none';
    pointSnapBtn.style.display = !lines && plan ? '' : 'none';
    const movingLocked = !!plan && plan.kind !== 'none' && isLocked(controller.doc, plan.moving);
    parallelBtn.disabled = plan?.kind !== 'lines' || plan.parallel || movingLocked;
    joinBtn.disabled = plan?.kind !== 'lines' || !plan.parallel || plan.joined || movingLocked;
    pointSnapBtn.disabled = plan?.kind !== 'points' || plan.snapped || movingLocked;
  }

  function refreshIntersectionRows(): void {
    const layout = layoutOf(controller.doc);
    const current = referenceCurrent(layout);
    spreadSlider.disabled = !current;
    ixSpreadRow.classList.toggle('stale', !current);
    referenceBtn.classList.toggle('active', !current);
    referenceBtn.title = current ? 'Make this arrangement the Spread reference (100%)' : 'Copies have changed — set a new reference to use Spread';
    if (!current) {
      spreadSlider.value = String(spreadToSlider(1));
      spreadValue.textContent = 'Set ref.';
    } else if (controller.intersectionSpreadDraft === null) {
      spreadSlider.value = String(spreadToSlider(layout.spread));
      spreadValue.textContent = `${Math.round(layout.spread * 100)}%`;
    }
  }

  function refreshSpaceRow(): void {
    const source = repeatSource(controller.doc);
    for (const [id, b] of sourceBtns) b.classList.toggle('active', source === id);
  }



  // Line: how its direction is given — a compact strip over the ribbon, only while Line is the tool
  // (Construct and Intersect alike). Connect joins two points; Parallel / Perpendicular take a
  // reference line, then a point.
  const lineStrip = document.createElement('div');
  lineStrip.className = 'segmented-mini line-strip';
  lineStrip.setAttribute('role', 'group');
  lineStrip.setAttribute('aria-label', 'Line direction');
  const lineGuideBtns = new Map<AppController['lineGuide'], HTMLButtonElement>();
  for (const [id, label] of [
    ['free', 'Connect'],
    ['parallel', 'Parallel'],
    ['perpendicular', 'Perpendicular'],
  ] as const) {
    const b = document.createElement('button');
    b.textContent = label;
    onTap(b, () => {
      if (controller.lineGuide === id) return;
      controller.cancelPending();
      controller.lineGuide = id;
      controller.lineReference = null;
      controller.notify();
    });
    lineGuideBtns.set(id, b);
    lineStrip.appendChild(b);
  }

  overlay.appendChild(transformBar);
  overlay.appendChild(utilRow);
  overlay.appendChild(repeatPanel);
  overlay.appendChild(lineStrip);
  overlay.appendChild(contextSlot);
  overlay.appendChild(dock);
  canvasWrap.appendChild(overlay);
  // Stage D — who a tool in Intersect edits: Line, Circle, Arc and Divide edit the Construct source
  // (every copy follows); Fair develops the Primary, Intersect's own geometry. A quiet tag at the top
  // of the canvas, only while a tool is in hand there.
  const ownerTag = document.createElement('div');
  ownerTag.className = 'owner-tag';
  ownerTag.setAttribute('role', 'status');
  const ownerMark = document.createElement('span');
  ownerMark.className = 'owner-mark';
  const ownerText = document.createElement('span');
  ownerTag.append(ownerMark, ownerText);
  canvasWrap.appendChild(ownerTag);
  // Stage D (D10): Repeat from Intersect with nothing in its composition — no Developed Primary and
  // no construction In Repeat — says so, with the two ways on.
  const emptyCard = document.createElement('div');
  emptyCard.className = 'empty-composition';
  emptyCard.setAttribute('role', 'status');
  const emptyTitle = document.createElement('div');
  emptyTitle.className = 'empty-composition-title';
  emptyTitle.textContent = 'Nothing to repeat yet';
  const emptyText = document.createElement('p');
  emptyText.textContent = 'From Intersect, Repeat repeats the Developed Primary and any construction set In Repeat — and there is neither. Develop the Primary with Fair in Intersect, or repeat the Construct motif.';
  const emptyActions = document.createElement('div');
  emptyActions.className = 'empty-composition-actions';
  const backBtn = document.createElement('button');
  backBtn.className = 'btn-primary';
  backBtn.textContent = 'Back to Intersect';
  backBtn.addEventListener('click', () => {
    opts.onSwitchWorkspace('intersection');
    controller.setTool('fair');
  });
  const constructSrcBtn = document.createElement('button');
  constructSrcBtn.className = 'btn-secondary';
  constructSrcBtn.textContent = 'Use Construct';
  constructSrcBtn.addEventListener('click', () => switchRepeatSource(controller, 'motif'));
  emptyActions.append(backBtn, constructSrcBtn);
  emptyCard.append(emptyTitle, emptyText, emptyActions);
  canvasWrap.appendChild(emptyCard);
  function refreshOwnerTag(building: boolean): void {
    ownerTag.style.display = building ? '' : 'none';
    if (!building) return;
    const primary = controller.tool === 'fair';
    ownerTag.dataset.owner = primary ? 'primary' : 'construct';
    ownerText.textContent = primary ? 'Developed Primary · Intersect’s own geometry' : 'Construct source · every copy follows';
  }

  // While two fingers turn the view: a quiet readout of the camera's angle, gone after the gesture.
  const turnReadout = document.createElement('div');
  turnReadout.className = 'turn-readout';
  turnReadout.setAttribute('aria-hidden', 'true');
  canvasWrap.appendChild(turnReadout);
  controller.subscribeView(() => {
    const turn = opts.getView().screen?.turn ?? 0;
    const deg = Math.round((turn * 180) / Math.PI);
    const show = controller.cameraTurning && turn !== 0;
    if (show) turnReadout.textContent = `${deg === 0 ? 0 : deg}°`; // keep the last angle while fading
    turnReadout.classList.toggle('show', show);
  });

  shell.appendChild(topbar);
  shell.appendChild(canvasWrap);
  root.appendChild(shell);

  // ---- context ribbon building blocks ----

  function chip(label: string, onClick: (el: HTMLButtonElement) => void, dotColour?: string | null): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'chip';
    if (dotColour !== undefined) {
      btn.classList.add('stroke-chip');
      const dot = document.createElement('span');
      dot.className = 'stroke-chip-dot' + (dotColour === null ? ' none' : '');
      if (dotColour) dot.style.background = dotColour;
      btn.appendChild(dot);
    }
    btn.appendChild(document.createTextNode(label));
    btn.addEventListener('click', () => onClick(btn));
    contextBar.appendChild(btn);
    return btn;
  }

  /** A small, non-interactive state cue ("A selected → choose B") — never instructions at idle. */
  function cue(text: string): void {
    const el = document.createElement('div');
    el.className = 'step-badge';
    el.textContent = text;
    contextBar.appendChild(el);
  }

  function modeToggle<T extends string>(modes: { id: T; label: string; disabled?: boolean }[], active: T, onPick: (id: T) => void): void {
    const seg = document.createElement('div');
    seg.className = 'segmented-mini';
    for (const m of modes) {
      const btn = document.createElement('button');
      btn.textContent = m.label;
      btn.disabled = !!m.disabled;
      if (m.id === active) btn.classList.add('active');
      btn.addEventListener('click', () => {
        if (m.id !== active) onPick(m.id);
      });
      seg.appendChild(btn);
    }
    contextBar.appendChild(seg);
  }

  // ---- Select: what is selected, and what can be done with it ----

  function selectionKeys(doc: Doc, sel: SelectCandidate[]): SegmentKey[] {
    const keys: SegmentKey[] = [];
    for (const c of sel) {
      if (c.kind === 'segment' || c.kind === 'region') keys.push(...c.keys);
      else if (c.kind === 'entity' || c.kind === 'group') {
        for (const id of c.kind === 'entity' ? [c.entityId] : c.entityIds) {
          const e = doc.entities.find((x) => x.id === id);
          if (e) keys.push(...entityKeys(doc, e));
        }
      }
    }
    return [...new Set(keys)];
  }

  function selectionEntityIds(doc: Doc, sel: SelectCandidate[], keys: SegmentKey[]): EntityId[] {
    const ids = new Set<EntityId>(keys.map((k) => k.split(':')[0]!));
    for (const c of sel) {
      if (c.kind === 'entity') ids.add(c.entityId);
      if (c.kind === 'group') c.entityIds.forEach((id) => ids.add(id));
    }
    return [...ids].filter((id) => doc.entities.some((e) => e.id === id));
  }

  /** Phase 5.2 item 5: removes the whole shape(s) — confirmed first only when that would also take
   * other constructions built on them (Undo restores either way). */
  function confirmDelete(plan: DeletionPlan, rootCount: number, noun: string, after: () => void): void {
    const extra = plan.entityIds.size - rootCount;
    const run = () => {
      controller.commit((d) => applyDeletionPlan(d, plan));
      after();
    };
    if (extra <= 0) {
      run();
      return;
    }
    openConfirmSheet({
      title: `Delete ${noun}?`,
      body: `Also removes ${extra} dependent construction${extra === 1 ? '' : 's'}. Undo will bring it back.`,
      confirmLabel: 'Delete',
      onConfirm: run,
    });
  }

  function flipRegionTypes(): void {
    controller.selection = controller.selection.map((c) => (c.kind === 'region' ? { ...c, fair: !c.fair } : c));
  }

  function renderPointRibbon(doc: Doc, id: PointId): void {
    const point = doc.points.find((p) => p.id === id);
    if (!point) return;
    const dependents = pointDependents(doc, id);
    const editable = isEditablePointKind(point.kind);
    if (editable || dependents.length > 0) {
      chip('Move/Rebind', () => {
        controller.pointEdit = {
          pointId: id,
          mode: point.kind === 'free' ? 'move' : point.kind === 'on-curve' ? 'slide' : 'rebind',
          dependents,
          chosen: dependents.length === 1 ? dependents[0]! : null,
          drag: null,
        };
        controller.notify();
      });
      chip('Merge', () => {
        controller.pendingMerge = { sourceId: id };
        controller.notify();
      });
    }
    const plan = computePointDeletionPlan(doc, id);
    if (plan) {
      chip('Delete', () => {
        const run = () => {
          controller.commit((d) => applyPointDeletionPlan(d, plan));
          controller.select([]);
        };
        if (editable && plan.entityIds.size === 0) return run();
        openConfirmSheet({
          title: editable ? 'Delete this point?' : 'Delete what is built on this point?',
          body: `${editable ? 'Also removes' : 'Removes'} ${plan.entityIds.size} construction${plan.entityIds.size === 1 ? '' : 's'}. Undo will bring ${plan.entityIds.size === 1 ? 'it' : 'them'} back.`,
          confirmLabel: 'Delete',
          onConfirm: run,
        });
      });
    }
  }

  function renderSelectRibbon(): void {
    const doc = controller.doc;
    const sel = controller.selection;

    if (controller.pendingMerge) {
      cue('Tap the point to merge into');
      return;
    }
    const edit = controller.pointEdit;
    if (edit) {
      cue(edit.mode === 'move' ? 'Drag to move the point' : edit.mode === 'slide' ? 'Drag along its curve' : edit.chosen ? 'Drag its end to a new point' : 'Tap the construction to re-anchor');
      return;
    }
    if (sel.length === 0) return;
    if (sel.length === 1 && sel[0]!.kind === 'point') {
      renderPointRibbon(doc, sel[0]!.id);
      return;
    }

    const keys = selectionKeys(doc, sel);
    const regions = sel.filter((c): c is Extract<SelectCandidate, { kind: 'region' }> => c.kind === 'region');
    // Phase 5.10: the scope is always stated, and every action names it and acts on exactly it.
    const scope = selectionScope(doc, sel, keys);
    if (scope.label) cue(scope.label);
    const fair = regions.length > 0 ? regions[0]!.fair : isUniformlyFair(doc, keys);
    const entityIds = selectionEntityIds(doc, sel, keys);
    const allLocked = entityIds.every((id) => doc.entities.find((e) => e.id === id)?.locked);
    if (controller.multiRegion) cue(`${regions.length} region${regions.length === 1 ? '' : 's'}`);

    // Phase 5.10: the actions that change WHAT is Fair or present come first (scope-named), so on
    // a phone they are never scrolled out of sight; styling follows.
    if (fair) {
      chip(`Un-Fair ${scope.noun}`, () => {
        controller.commit((d) => {
          for (const k of keys) setSegmentFair(d, k, false);
        });
        flipRegionTypes();
        controller.notify();
      });
    } else {
      chip(`Fair ${scope.noun}`, () => {
        controller.commit((d) => {
          for (const id of entityIds) ensureCircleSegments(d, id);
          const fresh = selectionKeys(d, sel);
          for (const k of fresh.length > 0 ? fresh : keys) setSegmentFair(d, k, true);
        });
        flipRegionTypes();
        controller.notify();
      });
    }

    if (!scope.whole) {
      // A segment, a run, swept segments or a region's boundary — Delete removes exactly those
      // pieces (true Trim), never the rest of the line they belong to.
      if (keys.length > 0 && !allLocked) {
        chip(`Delete ${scope.noun}`, () => {
          controller.commit((d) => {
            for (const k of keys) trimSegment(d, k.split(':')[0]!, k);
          });
          controller.select([]);
        });
      }
    } else {
      const plan = computeEntitiesDeletionPlan(doc, entityIds);
      if (plan && !allLocked) {
        const roots = entityIds.filter((id) => !doc.entities.find((e) => e.id === id)?.locked).length;
        const noun = roots === 1 ? (doc.entities.find((e) => e.id === plan.rootEntityId)?.kind === 'circle' ? 'this circle' : 'this line') : `${roots} shapes`;
        chip(`Delete ${scope.noun}`, () => confirmDelete(plan, roots, noun, () => controller.select([])));
      }
      if (!fair && keys.length > 0 && !allLocked) {
        chip('Trim', () => {
          controller.commit((d) => {
            for (const k of keys) trimSegment(d, k.split(':')[0]!, k);
          });
          controller.select([]);
        });
      }
    }

    // (Construction colour: the top-bar swatch — Stage A — recolours a construction selection.)

    if (fair) {
      const firstStroke = doc.segmentStates.get(keys[0]!)?.stroke ?? doc.fairDefaults;
      const filled = regions.map((r) => getRegionFill(doc, r.sig)).find((c) => c !== undefined) ?? null;
      chip(
        'Colour',
        (el) => {
          const sections: Parameters<typeof showColourPopover>[1] = [];
          if (regions.length > 0) {
            // Phase 5.2 item 10: a region's Colour covers its fill too — "No fill" instead of a
            // separate Remove fill action.
            sections.push({
              title: 'Fill',
              current: filled,
              noFill: true,
              onPick: (colour) =>
                controller.commit((d) => {
                  for (const r of regions) {
                    if (colour === null) {
                      removeRegionFill(d, r.sig);
                      continue;
                    }
                    const existing = getRegionFill(d, r.sig);
                    setRegionFill(d, r.sig, withAlpha(colour, existing ? colourAlpha(existing) : d.fillDefaults.opacity));
                  }
                }),
            });
          }
          sections.push({
            title: regions.length > 0 ? 'Line' : 'Stroke colour',
            current: firstStroke.colour,
            onPick: (colour) => {
              if (!colour) return;
              controller.commit((d) => {
                for (const k of keys) setSegmentStroke(d, k, colour, d.segmentStates.get(k)?.stroke?.width ?? d.fairDefaults.width);
              });
            },
          });
          showColourPopover(el, sections);
        },
        regions.length > 0 ? filled : firstStroke.colour,
      );
      chip('Width', (el) =>
        showSliderPopover(el, 'Stroke width', {
          min: 1,
          max: 8,
          step: 0.5,
          value: firstStroke.width,
          format: (v) => `${v}px`,
          onCommit: (width) =>
            controller.commit((d) => {
              for (const k of keys) setSegmentStroke(d, k, d.segmentStates.get(k)?.stroke?.colour ?? d.fairDefaults.colour, width);
            }),
        }),
      );
    }
  }

  /** Phase 5.10: what the selection covers, in words — for the ribbon label and action names. */
  function selectionScope(doc: Doc, sel: SelectCandidate[], keys: SegmentKey[]): { label: string; noun: string; whole: boolean } {
    const count = segmentCount(doc, keys);
    const n = `${count} segment${count === 1 ? '' : 's'}`;
    if (sel.length === 1) {
      const c = sel[0]!;
      if (c.kind === 'segment') return c.scope === 'run' ? { label: `Run · ${n}`, noun: 'run', whole: false } : { label: '1 segment', noun: 'segment', whole: false };
      if (c.kind === 'entity') {
        const kind = doc.entities.find((e) => e.id === c.entityId)?.kind === 'circle' ? 'circle' : 'line';
        return { label: `Whole ${kind} · ${n}`, noun: kind, whole: true };
      }
      if (c.kind === 'group') return { label: `Whole shape · ${n}`, noun: 'shape', whole: true };
      if (c.kind === 'region') return { label: `Region · ${n}`, noun: 'region edges', whole: false };
    }
    if (sel.every((c) => c.kind === 'segment')) return { label: n, noun: n, whole: false };
    if (sel.every((c) => c.kind === 'region')) return { label: '', noun: 'region edges', whole: false };
    return { label: n, noun: 'selection', whole: sel.some((c) => c.kind === 'entity' || c.kind === 'group') };
  }

  /** Visible segments (selectable groups) wholly covered by `keys`. */
  function segmentCount(doc: Doc, keys: SegmentKey[]): number {
    const set = new Set(keys);
    let n = 0;
    for (const id of new Set(keys.map((k) => k.split(':')[0]!))) {
      const e = doc.entities.find((x) => x.id === id);
      if (!e) continue;
      n += deriveSelectableGroups(doc, e).filter((g) => g.segments.every((sg) => set.has(sg.key))).length;
    }
    return n;
  }

  // ---- tools ----

  function renderDivideRibbon(): void {
    const state = controller.divide;
    if (!state) return;
    const label = document.createElement('div');
    label.className = 'step-badge';
    label.textContent = state.target.label;
    contextBar.appendChild(label);

    const count = document.createElement('span');
    count.className = 'divide-count';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'divide-slider';
    slider.min = String(DIVIDE_MIN);
    slider.max = String(DIVIDE_MAX);
    slider.step = '1';
    slider.setAttribute('aria-label', 'Number of parts');

    // Stepping N only redraws the preview (notifyView) — never a ribbon rebuild, which would
    // pull the slider out from under a finger mid-drag.
    const setN = (n: number) => {
      const d = controller.divide;
      if (!d) return;
      d.n = Math.max(DIVIDE_MIN, Math.min(DIVIDE_MAX, Math.round(n)));
      controller.dividePreview = { target: d.target, points: dividePreviewPoints(controller.doc, d.target, d.n, d.angle) };
      count.textContent = String(d.n);
      slider.value = String(d.n);
      minus.disabled = d.n <= DIVIDE_MIN;
      plus.disabled = d.n >= DIVIDE_MAX;
      controller.notifyView();
    };
    const minus = chip('−', () => setN((controller.divide?.n ?? 2) - 1));
    minus.classList.add('icon-only');
    minus.setAttribute('aria-label', 'Fewer parts');
    contextBar.appendChild(count);
    const plus = chip('+', () => setN((controller.divide?.n ?? 2) + 1));
    plus.classList.add('icon-only');
    plus.setAttribute('aria-label', 'More parts');
    slider.addEventListener('input', () => setN(Number(slider.value)));
    contextBar.appendChild(slider);
    const apply = chip('Apply', () => applyDivide());
    apply.classList.add('primary');
    setN(state.n);
  }

  function applyDivide(): void {
    const state = controller.divide;
    if (!state) return;
    const { target, n, angle } = state;
    let created: PointId[] = [];
    controller.commit((d) => {
      const entity = d.entities.find((e) => e.id === target.entityId);
      if (!entity) return;
      created = target.kind === 'circle-whole' ? addCircleDivision(d, entity.id, n, angle) : addSegmentDivisionPoints(d, target, n);
    });
    controller.doc.dividePrefs.lastN = n;
    setDivideTarget(controller, null);
    if (created.length > 0) controller.setRecentPoints(created);
  }

  function renderToolRibbon(tool: ToolId): void {
    const doc = controller.doc;
    const prefs = doc.toolPrefs;
    const pending = controller.pending;

    if (tool === 'circle') {
      // Phase 5.13: three choices and nothing else — the canvas shows the state (chosen edges, the
      // ghost circle, its centre and tangency points), release makes the circle, Undo corrects.
      modeToggle(
        [
          { id: 'centre-radius', label: 'By radius' },
          { id: 'three-lines', label: 'Between edges' },
          { id: 'copy-radius', label: 'Copy circle' },
        ],
        controller.circleVariant,
        (variant) => {
          controller.cancelPending();
          controller.circleVariant = variant;
          controller.incircle = null;
          controller.copyRadius = null;
          controller.notify();
        },
      );
    } else if (tool === 'line') {
      // Construction | Extension is chosen before the first point (changing it cancels a step): while
      // point A waits for B, the ribbon offers A's own continuations instead.
      const waitingForB = controller.lineGuide === 'free' && pending?.kind === 'line';
      if (!waitingForB) {
        modeToggle(
          [
            { id: 'construction', label: 'Construction' },
            { id: 'extension', label: 'Extension' },
          ],
          controller.lineMode,
          (mode) => {
            controller.cancelPending();
            controller.lineMode = mode;
            controller.notify();
          },
        );
      }
      if (controller.lineGuide !== 'free') {
        if (!controller.lineReference) cue('Tap the reference line');
        else {
          cue('Tap the point it goes through');
          chip('Change line', () => {
            controller.lineReference = null;
            controller.notify();
          });
        }
      } else if (pending?.kind === 'line') {
        cue('Choose B, or');
        // …from A alone, the horizontal / vertical extension through it.
        chip('Horizontal', () => axisThrough(controller, 'h'));
        chip('Vertical', () => axisThrough(controller, 'v'));
      }
      const extendFor = controller.extendChip;
      if (extendFor && !pending) {
        chip('Extend', () => {
          controller.commit((d) => {
            const e = d.entities.find((en) => en.id === extendFor.entityId);
            if (e && e.kind === 'line') e.extended = true;
          });
          controller.setExtendChip(null);
        });
      }
      const promoteFor = controller.fairPromoteChip;
      if (promoteFor && !pending) {
        chip('Promote to Fair', () => {
          controller.commit((d) => promoteEntityToFair(d, promoteFor.entityId));
          controller.setFairPromoteChip(null);
        });
      }
    } else if (tool === 'arc') {
      modeToggle(
        [
          { id: 'measure', label: 'Measure radius' },
          { id: 'same', label: 'Same radius', disabled: !prefs.lastRadius },
        ],
        prefs.arcMode === 'same' && prefs.lastRadius ? 'same' : 'measure',
        (mode) => {
          controller.cancelPending();
          prefs.arcMode = mode;
          controller.notify();
        },
      );
      // Phase 5.6: a word only where the canvas can't say it — which point comes next, and a brief
      // acknowledgement that the radius was picked up.
      if (pending?.kind === 'arc' && pending.stage === 'measure-b') cue('Choose second point');
      else if (pending?.kind === 'arc' && pending.capturedAt && Date.now() - pending.capturedAt < CAPTURED_CUE_MS) cue('Radius captured');
    } else if (tool === 'divide') {
      renderDivideRibbon();
    } else if (tool === 'fair' && doc.view.workspace === 'intersection') {
      // Fair in Intersect develops the Primary, in its one Primary style: Construct's Fair colour and
      // width are not its to change (the owner tag says what it edits).
    } else if (tool === 'fair') {
      const stroke = doc.fairDefaults;
      const setStrokeColour = (c: string | null) => {
        if (!c) return;
        doc.fairDefaults = { ...doc.fairDefaults, colour: c };
        controller.notify();
      };
      chip('Colour', (el) => showColourPopover(el, [{ title: 'Stroke colour', current: stroke.colour, onPick: setStrokeColour }]), stroke.colour);
      chip(`Width ${stroke.width}px`, (el) =>
        showSliderPopover(el, 'Stroke width', {
          min: 1,
          max: 8,
          step: 0.5,
          value: stroke.width,
          format: (v) => `${v}px`,
          onCommit: (width) => {
            doc.fairDefaults = { ...doc.fairDefaults, width };
            controller.notify();
          },
        }),
      );
    } else if (tool === 'fill') {
      const fill = doc.fillDefaults;
      const setFillColour = (c: string | null) => {
        if (!c) return;
        doc.fillDefaults = { ...doc.fillDefaults, colour: c };
        controller.notify();
      };
      chip('Colour', (el) => showColourPopover(el, [{ title: 'Fill colour', current: fill.colour, onPick: setFillColour }]), withAlpha(fill.colour, fill.opacity));
      chip(`Opacity ${Math.round(fill.opacity * 100)}%`, (el) =>
        showSliderPopover(el, 'Fill opacity', {
          min: 10,
          max: 100,
          step: 5,
          value: Math.round(fill.opacity * 100),
          format: (v) => `${v}%`,
          onCommit: (pct) => {
            doc.fillDefaults = { ...doc.fillDefaults, opacity: pct / 100 };
            controller.notify();
          },
        }),
      );
    }
  }

  /** Phase 5.2 item 3: the ribbon appears only when the tool or selection has controls to offer;
   * otherwise it hides — but its slot keeps its height, so Undo/Redo and the dock never move. */
  function renderRibbon(): void {
    contextBar.innerHTML = '';
    contextBar.classList.toggle('circle-bar', controller.tool === 'circle' && controller.doc.view.workspace !== 'repeat');
    if (controller.tool === 'select') renderSelectRibbon();
    else renderToolRibbon(controller.tool);
    contextBar.classList.toggle('hidden', !contextBar.hasChildNodes());
  }

  /** The rotation-fraction label shows while (and only while) rotating. Updated on the cheap
   * view-only channel too, since it tracks a drag at pointermove rate. (Phase 1.2: the lattice
   * handles no longer snap, so there are no contacts to announce.) */
  function updateRepeatStatus(): void {
    const rotating = controller.repeatRotateDrag;
    const text = rotating ? (rotationFractionLabel(rotating.rawRotation) ?? 'Rotating…') : null;
    if (text) repeatStatus.textContent = text; // keep the last text while fading out
    repeatStatus.classList.toggle('show', !!text);
  }

  let shownWorkspace = controller.doc.view.workspace;

  function update(): void {
    syncSnapChooser(controller, canvas, opts.getToolView);
    const inRepeat = controller.doc.view.workspace === 'repeat';
    const inIntersection = controller.doc.view.workspace === 'intersection';
    const placing = inRepeat || inIntersection; // both have a bottom panel of their own
    // Intersect is also a linked editing workspace: the construction tools (not Fill) work on the
    // active instance; Select arranges the instances. Repeat has no tools.
    const building = inIntersection && controller.tool !== 'select';
    refreshOwnerTag(building);
    emptyCard.style.display = inRepeat && repeatSourceOf(controller.doc) === 'intersect' && repeatComposition(controller.doc).members.length === 0 ? '' : 'none';
    // Phase 5.3 item 1: a panel never outlives the workspace it belongs to.
    if (controller.doc.view.workspace !== shownWorkspace) {
      shownWorkspace = controller.doc.view.workspace;
      closeAnyPopover();
      controller.spaceMode = false; // Space belongs to one visit to Repeat, not the next
      controller.repeatColourMode = null; // nor does Colouring
      controller.closeGap = null; // nor does Close Gap
      controller.intersectionPicks = []; // nor do Intersection's picks outlive a visit
      controller.intersectionPickKind = 'instance';
      setReferenceTransform(false); // Transform is locked again on leaving a workspace
    }
    constructBtn.classList.toggle('active', !placing);
    intersectionBtn.classList.toggle('active', inIntersection);
    repeatBtn.classList.toggle('active', inRepeat);

    for (const [id, btn] of dockButtonEls) {
      btn.classList.toggle('active', controller.tool === id);
      btn.classList.toggle('pending-ring', controller.tool === id && !!controller.pending);
    }
    undoBtn.disabled = !controller.canUndo();
    redoBtn.disabled = !controller.canRedo();
    if (controller.referenceTransform) refreshTransformBar();
    refreshReferenceButtons();

    appearanceBtn.style.display = inRepeat ? '' : 'none';
    ccBtn.style.display = controller.doc.view.workspace === 'construct' ? '' : 'none';
    refreshCcBtn();
    guidesBtn.style.display = inRepeat ? '' : 'none';
    handlesBtn.style.display = inRepeat ? '' : 'none';
    exportBtn.style.display = inIntersection ? 'none' : ''; // Intersection has nothing to share yet
    if (inRepeat) refreshGuidesBtn();

    dock.style.display = inRepeat ? 'none' : 'flex';
    dockButtonEls.get('fill')!.style.display = inIntersection ? 'none' : '';
    contextSlot.style.display = inRepeat || (inIntersection && !building) ? 'none' : 'flex';
    lineStrip.style.display = !inRepeat && controller.tool === 'line' ? '' : 'none';
    for (const [id, b] of lineGuideBtns) b.classList.toggle('active', controller.lineGuide === id);
    repeatPanel.style.display = placing ? 'flex' : 'none';
    // Repeat's lattice controls belong to Repeat; Intersection has its own rows.
    // While colouring, the lattice rows step aside for the colouring controls.
    const colouring = inRepeat && (!!controller.repeatColourMode || controller.spaceMode);
    const closingGap = inRepeat && !!controller.closeGap;
    ruleLine.style.display = inRepeat && !colouring && !closingGap ? '' : 'none';
    spaceRow.style.display = inRepeat && !colouring && !closingGap ? '' : 'none';
    closeGapRow.style.display = closingGap ? '' : 'none';
    if (closingGap) refreshCloseGapRow();
    colourKindRow.style.display = colouring ? '' : 'none';
    patternRow.style.display = colouring && controller.repeatColourMode === 'pattern' ? '' : 'none';
    if (colouring) refreshColourRows();
    // Spread arranges the instances: it belongs to Select's instance arranging — never under a
    // construction tool's ribbon, nor while an alignment (Parallel · Join, Point Snap, Match Edge)
    // is being picked.
    ixSpreadRow.style.display = inIntersection && !building && controller.intersectionPickKind === 'instance' ? '' : 'none';
    if (!inIntersection) ixSnapRow.style.display = 'none';
    ixCopiesBtn.style.display = inIntersection ? '' : 'none';
    ixSnapshotsBtn.style.display = inIntersection ? '' : 'none';

    if (placing) {
      for (const [id, btn] of ruleBtns) btn.classList.toggle('active', controller.doc.repeat.rule.kind === id);
      if (inRepeat) refreshSpaceRow();
      else {
        refreshIxCopiesBtn();
        refreshIxSnapshotsBtn();
        refreshIntersectionRows();
        refreshSnapRow();
        // The Snap row belongs to arranging (Select); a construction tool has its own ribbon.
        if (building) {
          ixSnapRow.style.display = 'none';
          renderRibbon();
        }
      }
      updateRepeatStatus();
      return;
    }
    renderRibbon();
  }

  controller.subscribe(update);
  controller.subscribeView(updateRepeatStatus);
  update();

  return { canvas, overlay };
}
