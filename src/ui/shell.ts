import type { AppController, PointVisibility, SelectCandidate, ToolId, ViewTransform } from '../app/controller.ts';
import type { Doc, EntityId, PointId, SegmentKey } from '../model/types.ts';
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
  setSegmentFair,
  setSegmentStroke,
  trimSegment,
  type DeletionPlan,
} from '../model/doc.ts';
import { colourAlpha, colourRgb, withAlpha } from '../model/colour.ts';
import { isEditablePointKind } from '../geometry/usage.ts';
import { entityKeys, isUniformlyFair } from '../interaction/hittest.ts';
import { dividePreviewPoints, setDivideTarget } from '../interaction/tools/divide.ts';
import { iconSvg, type IconName } from './icons.ts';
import { showToast } from './toast.ts';
import { openConfirmSheet } from './confirmsheet.ts';
import { onTap } from './tap.ts';
import { color, fairPalette } from '../render/tokens.ts';
import { defaultLatticeVectors, isSixtyDegreeFamily, type LatticeFamily } from '../geometry/lattice.ts';
import { rotationFractionLabel } from '../render/repeatRenderer.ts';
import { CAPTURED_CUE_MS } from '../interaction/tools/arc.ts';
import { deliverFile, exportVisibleView, fileShareSupport, type ExportSettings } from '../render/export.ts';
import type { RepeatDisplay, RepeatSystem } from '../model/types.ts';

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
function colourSwatchRow(menu: HTMLElement, current: string | null, onPick: (colour: string | null) => void, extra?: { label: string; value: null }): void {
  const row = document.createElement('div');
  row.className = 'swatch-row';
  const swatches: HTMLButtonElement[] = [];
  let active = current ? colourRgb(current).toLowerCase() : null;
  const refresh = () => swatches.forEach((el) => el.classList.toggle('active', (el.dataset.colour ?? null) === active));
  if (extra) {
    const none = document.createElement('button');
    none.className = 'swatch swatch-none';
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

function showColourPopover(anchor: HTMLElement, sections: { title: string; current: string | null; noFill?: boolean; onPick: (colour: string | null) => void }[]): void {
  mountPopover(anchor, (menu) => {
    for (const s of sections) {
      popoverSectionLabel(menu, s.title);
      colourSwatchRow(menu, s.current, s.onPick, s.noFill ? { label: 'No fill', value: null } : undefined);
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
function showPopover(anchor: HTMLElement, items: { label: string; active?: boolean; onSelect: () => void }[], title?: string): void {
  mountPopover(anchor, (menu, close) => {
    if (title) popoverSectionLabel(menu, title);
    for (const item of items) {
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

/** "Label ───●── 70%" on one line (Phase 5.3 item 5). */
function panelSliderRow(menu: HTMLElement, label: string, opts: { min: number; max: number; step: number; value: number; format: (v: number) => string; onInput: (v: number) => void }): void {
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
  row.appendChild(text);
  row.appendChild(slider);
  row.appendChild(value);
  menu.appendChild(row);
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

/**
 * Phase 5.1 items 3–6 / Phase 5.3 items 2–5: Repeat's Appearance panel — how the repeated motif is
 * drawn, never what it is. Every control writes only `doc.repeatDisplay` (a display preference:
 * not undo-tracked, persisted by autosave). Compact: one segmented row, one toggle line, one
 * swatch row (scrolls sideways if a narrow screen needs it), one slider line.
 */
function showRepeatAppearancePanel(anchor: HTMLElement, controller: AppController): void {
  const display = (): RepeatDisplay => controller.doc.repeatDisplay;
  const changed = () => controller.notifyView();

  mountPopover(
    anchor,
    (menu) => {
      panelSegmented(
        menu,
        [
          { id: 'design', label: 'Design' },
          { id: 'stroke', label: 'Stroke' },
          { id: 'fill', label: 'Fill' },
        ],
        () => display().artwork,
        (id) => {
          display().artwork = id;
          changed();
        },
        'Artwork',
      );

      popoverToggleRow(
        menu,
        'Construction overlay',
        () => display().constructionOverlay,
        (on) => {
          display().constructionOverlay = on;
          changed();
        },
        'Shows the construction around the reference motif only — a guide, not artwork',
      );

      const swatchRow = document.createElement('div');
      swatchRow.className = 'swatch-row panel-swatches';
      swatchRow.setAttribute('role', 'group');
      swatchRow.setAttribute('aria-label', 'Background colour');
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

      panelSliderRow(menu, 'Fill opacity', {
        min: 0,
        max: 100,
        step: 5,
        value: Math.round(display().fillOpacity * 100),
        format: (v) => `${v}%`,
        onInput: (v) => {
          display().fillOpacity = v / 100;
          changed();
        },
      });
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
    },
    { shieldCanvas: true, panel: true },
  );
}

/** Session-sticky share choices — construction/guides are re-read from what's visible each time. */
const exportChoice: Pick<ExportSettings, 'format' | 'scale' | 'transparent'> = { format: 'png', scale: 2, transparent: false };

/**
 * Phase 5.3 items 7–19 / Phase 5.4 items 1–3: Share — always the current view (zoom, pan, crop,
 * background, artwork mode and opacity; never re-fitted). Compact: format, resolution, background,
 * whether construction (and in Repeat, the grid/guides) come along — defaulting to what's showing.
 *
 * The file is rendered ahead of the tap (on open, and again whenever a choice changes), so the
 * Share tap hands the operating system a ready file straight away: iOS only opens its share sheet
 * from within the tap itself. The view can't change meanwhile — touching the canvas closes this.
 */
function showExportPanel(anchor: HTMLElement, controller: AppController, getView: () => ViewTransform): void {
  const inRepeat = controller.doc.view.workspace === 'repeat';
  const display = controller.doc.repeatDisplay;
  const settings: ExportSettings = {
    ...exportChoice,
    construction: inRepeat ? display.constructionOverlay : true,
    guides: inRepeat ? display.grid : false,
  };
  let ready: Promise<{ blob: Blob; filename: string }> | null = null;
  let readyFile: { blob: Blob; filename: string } | null = null;
  const prepare = () => {
    readyFile = null;
    const job = exportVisibleView(controller, getView(), { ...settings });
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
      panelSegmented(
        formatRow,
        [
          { id: 'png', label: 'PNG' },
          { id: 'svg', label: 'SVG' },
        ],
        () => settings.format,
        (id) => {
          settings.format = exportChoice.format = id;
          scale?.buttons.forEach((b) => (b.disabled = id === 'svg'));
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
      scale.buttons.forEach((b) => (b.disabled = settings.format === 'svg'));

      const bgRow = document.createElement('div');
      bgRow.className = 'popover-toggle-row';
      const bgLabel = document.createElement('span');
      bgLabel.className = 'popover-row-label';
      bgLabel.textContent = 'Background';
      bgRow.appendChild(bgLabel);
      panelSegmented(
        bgRow,
        [
          { id: 'current', label: 'Current' },
          { id: 'transparent', label: 'Transparent' },
        ],
        () => (settings.transparent ? 'transparent' : 'current'),
        (id) => {
          settings.transparent = exportChoice.transparent = id === 'transparent';
          prepare();
        },
        'Background',
      );
      menu.appendChild(bgRow);

      popoverToggleRow(
        menu,
        'Construction',
        () => settings.construction,
        (on) => {
          settings.construction = on;
          prepare();
        },
      );
      if (inRepeat) {
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

      // Phase 5.5 item 12: the button says what will really happen here — the system share sheet
      // where this page can share files, otherwise a file saved by the browser.
      const canShareFiles = fileShareSupport().files;
      const go = document.createElement('button');
      go.className = 'panel-primary';
      go.textContent = canShareFiles ? 'Share' : 'Save file';
      onTap(go, () => {
        go.disabled = true;
        const file = readyFile;
        const delivered = file ? deliverFile(file.blob, file.filename) : ready!.then((f) => deliverFile(f.blob, f.filename));
        delivered
          .then((result) => {
            const name = readyFile?.filename ?? file?.filename ?? 'file';
            // Never implies a share sheet that didn't open: a refused sheet says so.
            if (result === 'saved') showToast(canShareFiles ? `Share sheet unavailable · saved ${name}` : `Saved ${name}`);
          })
          .catch(() => showToast('Couldn’t create the file'))
          .finally(() => close());
      });
      menu.appendChild(go);
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
    onMyArtworks: () => void;
    onSave: () => void;
    onSaveAsNew: () => void;
    onNewArtwork: () => void;
    onClearDrawing: () => void;
    onSwitchWorkspace: (ws: 'construct' | 'repeat') => void;
    getView: () => ViewTransform;
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
  const menuBtn = document.createElement('button');
  menuBtn.className = 'icon-btn';
  menuBtn.setAttribute('aria-label', 'Menu');
  menuBtn.innerHTML = iconSvg('menu');
  onTap(menuBtn, () =>
    togglePanel(menuBtn, () =>
      showPopover(menuBtn, [
        { label: 'My Artworks', onSelect: () => opts.onMyArtworks() },
        { label: 'Save', onSelect: () => opts.onSave() },
        { label: 'Save as new…', onSelect: () => opts.onSaveAsNew() },
        { label: 'New artwork…', onSelect: () => opts.onNewArtwork() },
        { label: 'Clear drawing…', onSelect: () => opts.onClearDrawing() },
      ], controller.doc.named ? controller.doc.name : 'Untitled artwork'),
    ),
  );
  leftSide.appendChild(menuBtn);

  // Phase 3.2 item 1 / Phase 3.4 item 10 / Phase 3.5 item 5: a persistent control in the space
  // between the menu and Construct/Repeat, opening the Point Targets panel. Redesigned in Phase
  // 3.5 to match the plain icon-btn weight of menu/eye/export — no permanently large dark pill,
  // since that competed visually with Construct/Repeat for a control this secondary. The icon
  // itself (a node + a lock badge) still carries the primary idea ("which points may I target?")
  // with the lock as a secondary cue whose shackle opens/closes with whether Free-on-curve is
  // allowed — the same shape language as before, just no longer wrapped in a heavy fill.
  const pointLockBtn = document.createElement('button');
  pointLockBtn.className = 'icon-btn point-targets-btn';
  onTap(pointLockBtn, () => togglePanel(pointLockBtn, () => showPointTargetsPanel(pointLockBtn, controller)));
  function refreshPointLockBtn(): void {
    const freeAllowed = controller.doc.pointTargets.free;
    pointLockBtn.innerHTML = iconSvg(freeAllowed ? 'pointLockOpen' : 'pointLock', 22);
    pointLockBtn.classList.toggle('free-on', freeAllowed);
    pointLockBtn.setAttribute('aria-label', `Point targets · Free on curve ${freeAllowed ? 'on' : 'off'}`);
  }
  refreshPointLockBtn();
  leftSide.appendChild(pointLockBtn);

  // Phase 5.1 item 2: in Repeat, Appearance takes Point Targets' slot (and Grid/Guides takes the
  // Points eye's, below) — same header architecture, workspace-appropriate controls.
  const appearanceBtn = document.createElement('button');
  appearanceBtn.className = 'icon-btn';
  appearanceBtn.setAttribute('aria-label', 'Appearance');
  appearanceBtn.innerHTML = iconSvg('appearance');
  onTap(appearanceBtn, () => togglePanel(appearanceBtn, () => showRepeatAppearancePanel(appearanceBtn, controller)));
  leftSide.appendChild(appearanceBtn);

  const segmented = document.createElement('div');
  segmented.className = 'segmented';
  const constructBtn = document.createElement('button');
  constructBtn.textContent = 'Construct';
  const repeatBtn = document.createElement('button');
  repeatBtn.textContent = 'Repeat';
  constructBtn.addEventListener('click', () => opts.onSwitchWorkspace('construct'));
  repeatBtn.addEventListener('click', () => opts.onSwitchWorkspace('repeat'));
  segmented.appendChild(constructBtn);
  segmented.appendChild(repeatBtn);

  const rightSide = document.createElement('div');
  rightSide.className = 'topbar-side right';
  const visBtn = document.createElement('button');
  visBtn.className = 'icon-btn';

  // Phase 5.3 item 1: Point Visibility is a panel toggle like every other top-bar control (Show
  // points on/off + which points). `remembered` is the shown mode that "on" restores.
  const remembered: { mode: Exclude<PointVisibility, 'none'> } = { mode: controller.pointVisibility === 'none' ? 'near-finger' : controller.pointVisibility };

  function refreshEyeIcon(): void {
    // Phase 3.3 item 2 / Phase 3.5 item 6: the eye stays the dominant shape either way — hidden
    // state mutes it (lower-opacity icon paths, plus the button's own colour switching to muted
    // ink here) rather than slashing it, so it never reads as Delete/Error.
    const hidden = controller.pointVisibility === 'none';
    visBtn.innerHTML = iconSvg(hidden ? 'pointsEyeOff' : 'pointsEye');
    visBtn.style.color = hidden ? 'var(--muted)' : '';
    visBtn.setAttribute('aria-label', `Point visibility · ${hidden ? 'hidden' : 'shown'}`);
  }
  onTap(visBtn, () => togglePanel(visBtn, () => showPointsPanel(visBtn, controller, remembered)));
  refreshEyeIcon();
  controller.subscribeView(refreshEyeIcon);

  const exportBtn = document.createElement('button');
  exportBtn.className = 'icon-btn';
  exportBtn.setAttribute('aria-label', 'Share');
  exportBtn.innerHTML = iconSvg('share');
  onTap(exportBtn, () => togglePanel(exportBtn, () => showExportPanel(exportBtn, controller, opts.getView)));
  const guidesBtn = document.createElement('button');
  guidesBtn.className = 'icon-btn';
  guidesBtn.setAttribute('aria-label', 'Grid and guides');
  guidesBtn.innerHTML = iconSvg('gridGuides');
  // Like the Points eye: muted when every guide is off, so "why can't I see the handles?" has a visible answer.
  function refreshGuidesBtn(): void {
    const d = controller.doc.repeatDisplay;
    guidesBtn.style.color = d.grid || d.handles || d.motifBoundary ? '' : 'var(--muted)';
  }
  onTap(guidesBtn, () => togglePanel(guidesBtn, () => showRepeatGuidesPanel(guidesBtn, controller, refreshGuidesBtn)));

  rightSide.appendChild(visBtn);
  rightSide.appendChild(guidesBtn);
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

  utilRow.appendChild(undoRedoPill);
  utilRow.appendChild(fitBtn);

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

  const familyRow = document.createElement('div');
  familyRow.className = 'segmented-mini';
  const FAMILIES: { id: LatticeFamily; label: string }[] = [
    { id: 'square', label: 'Square' },
    { id: 'triangle', label: 'Triangle' },
    { id: 'hex', label: 'Hexagon' },
  ];
  const familyBtns = new Map<LatticeFamily, HTMLButtonElement>();
  for (const f of FAMILIES) {
    const btn = document.createElement('button');
    btn.textContent = f.label;
    btn.addEventListener('click', () => {
      const current = controller.doc.repeat.family;
      if (current === f.id) return;
      // Phase 5 item 3: switching between Square and a 60° family resets a/b to that family's
      // own comfortable defaults. Phase 5.1 item 10: Triangle ↔ Hexagon is the SAME lattice, only
      // presented differently, so the participant's arrangement carries straight across.
      const keepVectors = isSixtyDegreeFamily(current) && isSixtyDegreeFamily(f.id);
      controller.commit((d) => {
        d.repeat.family = f.id;
        if (keepVectors) return;
        const { a, b } = defaultLatticeVectors(d, f.id);
        d.repeat.a = a;
        d.repeat.b = b;
      });
    });
    familyBtns.set(f.id, btn);
    familyRow.appendChild(btn);
  }
  repeatPanel.appendChild(familyRow);

  const ruleRow = document.createElement('div');
  ruleRow.className = 'segmented-mini';
  const RULES: { id: RepeatSystem['rule']['kind']; label: string }[] = [
    { id: 'same', label: 'Same' },
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
  repeatPanel.appendChild(ruleRow);

  // Phase 5.6 items 19–20: Space — one compact toggle; while on, its Colour · Opacity sit beside
  // it (the same grammar as Construct's Fill) and a tap on the canvas colours negative space.
  const spaceRow = document.createElement('div');
  spaceRow.className = 'space-row';
  const spaceBtn = document.createElement('button');
  spaceBtn.className = 'space-chip';
  spaceBtn.textContent = 'Space';
  spaceBtn.setAttribute('aria-pressed', 'false');
  onTap(spaceBtn, () => {
    closeAnyPopover();
    controller.spaceMode = !controller.spaceMode;
    controller.notify();
  });
  const spaceColourBtn = document.createElement('button');
  spaceColourBtn.className = 'space-chip';
  const spaceDot = document.createElement('span');
  spaceDot.className = 'stroke-chip-dot';
  spaceColourBtn.appendChild(spaceDot);
  spaceColourBtn.appendChild(document.createTextNode('Colour'));
  spaceColourBtn.addEventListener('click', () =>
    togglePanel(spaceColourBtn, () =>
      showColourPopover(spaceColourBtn, [
        {
          title: 'Space colour',
          current: controller.doc.spaceDefaults.colour,
          noFill: true,
          onPick: (c) => {
            controller.doc.spaceDefaults = { ...controller.doc.spaceDefaults, colour: c };
            controller.notify();
          },
        },
      ]),
    ),
  );
  const spaceOpacityBtn = document.createElement('button');
  spaceOpacityBtn.className = 'space-chip';
  spaceOpacityBtn.addEventListener('click', () =>
    togglePanel(spaceOpacityBtn, () =>
      showSliderPopover(spaceOpacityBtn, 'Space opacity', {
        min: 10,
        max: 100,
        step: 5,
        value: Math.round(controller.doc.spaceDefaults.opacity * 100),
        format: (v) => `${v}%`,
        onCommit: (pct) => {
          controller.doc.spaceDefaults = { ...controller.doc.spaceDefaults, opacity: pct / 100 };
          controller.notify();
        },
      }),
    ),
  );
  spaceRow.appendChild(spaceBtn);
  spaceRow.appendChild(spaceColourBtn);
  spaceRow.appendChild(spaceOpacityBtn);
  repeatPanel.appendChild(spaceRow);

  function refreshSpaceRow(): void {
    const on = controller.spaceMode;
    const pref = controller.doc.spaceDefaults;
    spaceBtn.classList.toggle('active', on);
    spaceBtn.setAttribute('aria-pressed', String(on));
    spaceColourBtn.style.display = on ? '' : 'none';
    spaceOpacityBtn.style.display = on ? '' : 'none';
    spaceDot.classList.toggle('none', !pref.colour);
    spaceDot.style.background = pref.colour ? withAlpha(pref.colour, pref.opacity) : '';
    spaceColourBtn.setAttribute('aria-label', `Space colour ${pref.colour ?? 'no fill'}`);
    spaceOpacityBtn.textContent = `Opacity ${Math.round(pref.opacity * 100)}%`;
  }


  overlay.appendChild(utilRow);
  overlay.appendChild(repeatPanel);
  overlay.appendChild(contextSlot);
  overlay.appendChild(dock);
  canvasWrap.appendChild(overlay);

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
    openConfirmSheet(root, {
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
        openConfirmSheet(root, {
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
    const fair = regions.length > 0 ? regions[0]!.fair : isUniformlyFair(doc, keys);
    const entityIds = selectionEntityIds(doc, sel, keys);
    const allLocked = entityIds.every((id) => doc.entities.find((e) => e.id === id)?.locked);
    if (controller.multiRegion) cue(`${regions.length} region${regions.length === 1 ? '' : 's'}`);

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
      chip('Construction', () => {
        controller.commit((d) => {
          for (const k of keys) setSegmentFair(d, k, false);
        });
        flipRegionTypes();
        controller.notify();
      });
    } else {
      chip('Fair', () => {
        controller.commit((d) => {
          for (const id of entityIds) ensureCircleSegments(d, id);
          const fresh = selectionKeys(d, sel);
          for (const k of fresh.length > 0 ? fresh : keys) setSegmentFair(d, k, true);
        });
        flipRegionTypes();
        controller.notify();
      });
      if (keys.length > 0 && !allLocked) {
        chip('Trim', () => {
          controller.commit((d) => {
            for (const k of keys) {
              const entityId = k.split(':')[0]!;
              trimSegment(d, entityId, k);
            }
          });
          controller.select([]);
        });
      }
    }

    const plan = computeEntitiesDeletionPlan(doc, entityIds);
    if (plan && !allLocked) {
      const roots = entityIds.filter((id) => !doc.entities.find((e) => e.id === id)?.locked).length;
      const noun = roots === 1 ? (doc.entities.find((e) => e.id === plan.rootEntityId)?.kind === 'circle' ? 'this circle' : 'this line') : `${roots} shapes`;
      chip('Delete', () => confirmDelete(plan, roots, noun, () => controller.select([])));
    }
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
      controller.dividePreview = { target: d.target, points: dividePreviewPoints(controller.doc, d.target, d.n) };
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
    const { target, n } = state;
    let created: PointId[] = [];
    controller.commit((d) => {
      const entity = d.entities.find((e) => e.id === target.entityId);
      if (!entity) return;
      created = target.kind === 'circle-whole' ? addCircleDivision(d, entity.id, n, d.frame.rotation) : addSegmentDivisionPoints(d, target, n);
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
      modeToggle(
        [
          { id: 'set', label: 'Set radius' },
          { id: 'same', label: 'Same radius', disabled: !prefs.lastRadius },
        ],
        prefs.circleMode === 'same' && prefs.lastRadius ? 'same' : 'set',
        (mode) => {
          controller.cancelPending();
          prefs.circleMode = mode;
          controller.notify();
        },
      );
      if (pending?.kind === 'circle') cue('Centre selected → choose radius');
    } else if (tool === 'line') {
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
      if (pending?.kind === 'line') cue('A selected → choose B');
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
    if (controller.tool === 'select') renderSelectRibbon();
    else renderToolRibbon(controller.tool);
    contextBar.classList.toggle('hidden', !contextBar.hasChildNodes());
  }

  /** Phase 5.1 item 1: a contact is announced briefly as it's first reached, then fades — never a
   * permanent readout. The rotation-fraction label still shows while (and only while) rotating.
   * Updated on the cheap view-only channel too, since both track a drag at pointermove rate. */
  function updateRepeatStatus(): void {
    const flash = controller.repeatContactFlash;
    const rotating = controller.repeatRotateDrag;
    const text = flash ? flash.label : rotating ? (rotationFractionLabel(rotating.rawRotation) ?? 'Rotating…') : null;
    if (text) repeatStatus.textContent = text; // keep the last text while fading out
    repeatStatus.classList.toggle('show', !!text);
  }

  let shownWorkspace = controller.doc.view.workspace;

  function update(): void {
    const inRepeat = controller.doc.view.workspace === 'repeat';
    // Phase 5.3 item 1: a panel never outlives the workspace it belongs to.
    if (controller.doc.view.workspace !== shownWorkspace) {
      shownWorkspace = controller.doc.view.workspace;
      closeAnyPopover();
      controller.spaceMode = false; // Space belongs to one visit to Repeat, not the next
    }
    constructBtn.classList.toggle('active', !inRepeat);
    repeatBtn.classList.toggle('active', inRepeat);

    for (const [id, btn] of dockButtonEls) {
      btn.classList.toggle('active', controller.tool === id);
      btn.classList.toggle('pending-ring', controller.tool === id && !!controller.pending);
    }
    undoBtn.disabled = !controller.canUndo();
    redoBtn.disabled = !controller.canRedo();
    refreshPointLockBtn();

    pointLockBtn.style.display = inRepeat ? 'none' : '';
    visBtn.style.display = inRepeat ? 'none' : '';
    appearanceBtn.style.display = inRepeat ? '' : 'none';
    guidesBtn.style.display = inRepeat ? '' : 'none';
    if (inRepeat) refreshGuidesBtn();

    dock.style.display = inRepeat ? 'none' : 'flex';
    contextSlot.style.display = inRepeat ? 'none' : 'flex';
    repeatPanel.style.display = inRepeat ? 'flex' : 'none';

    if (inRepeat) {
      for (const [id, btn] of familyBtns) btn.classList.toggle('active', controller.doc.repeat.family === id);
      for (const [id, btn] of ruleBtns) btn.classList.toggle('active', controller.doc.repeat.rule.kind === id);
      refreshSpaceRow();
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
