import type { AppController, DivideTarget, PointVisibility, SelectCandidate, SelectFilter, ToolId } from '../app/controller.ts';
import { LIVE_TOOLS } from '../app/controller.ts';
import type { Doc, PointId, Vec2 } from '../model/types.ts';
import { deriveSegments, findSelectableGroup } from '../geometry/segments.ts';
import {
  addCircleDivision,
  addSegmentDivisionPoints,
  addStarChords,
  applyDeletionPlan,
  applyPointDeletionPlan,
  computeDeletionPlan,
  computeGroupDeletionPlan,
  computePointDeletionPlan,
  getRegionFill,
  promoteEntityToFair,
  removeRegionFill,
  setFrameDesignEnabled,
  setRegionFill,
  setSegmentFair,
  setSegmentStroke,
  trimSegment,
  type DeletionPlan,
} from '../model/doc.ts';
import { finishOpenPolygon } from '../interaction/tools/polygon.ts';
import { iconSvg, type IconName } from './icons.ts';
import { showToast } from './toast.ts';
import { openConfirmSheet } from './confirmsheet.ts';
import { openDivideSheet } from './dividesheet.ts';
import { fairPalette } from '../render/tokens.ts';
import { defaultLatticeVectors, type LatticeFamily } from '../geometry/lattice.ts';
import { currentContactLabel, rotationFractionLabel } from '../render/repeatRenderer.ts';
import type { RepeatSystem } from '../model/types.ts';

interface DockButtonSpec {
  id: ToolId;
  label: string;
  divider?: boolean;
}

const DOCK_BUTTONS: DockButtonSpec[] = [
  { id: 'select', label: 'Select' },
  { id: 'circle', label: 'Circle' },
  { id: 'line', label: 'Line' },
  { id: 'polygon', label: 'Polygon' },
  { id: 'divide', label: 'Divide', divider: true },
  { id: 'fair', label: 'Fair' },
  { id: 'fill', label: 'Fill' },
];

const VISIBILITY_OPTIONS: { id: PointVisibility; label: string }[] = [
  { id: 'near-finger', label: 'Near finger' },
  { id: 'all', label: 'All' },
  { id: 'used', label: 'Used' },
  { id: 'none', label: 'None' },
];

function pointKindLabel(doc: Doc, id: PointId): string {
  const p = doc.points.find((pt) => pt.id === id);
  if (!p) return 'point';
  switch (p.kind) {
    case 'centre':
      return 'centre';
    case 'frame-vertex':
      return 'frame vertex';
    case 'intersection':
      return 'intersection';
    case 'on-curve':
      return 'on curve';
    case 'free':
      return 'free';
    case 'midpoint':
      return 'midpoint';
    case 'division':
      return 'division';
  }
}

/** Item 3's example format: "Circle · construction". Locked (frame) entities read "locked". */
function entityLabel(doc: Doc, entityId: string): { title: string; hint: string } {
  const e = doc.entities.find((x) => x.id === entityId);
  if (!e) return { title: 'Shape', hint: '' };
  return { title: e.kind === 'circle' ? 'Circle' : 'Line', hint: e.locked ? 'locked' : 'construction' };
}

/** Phase 2A/2D: "Polygon · construction" for a completed vertex chain's group selection. */
function groupLabel(doc: Doc, entityIds: string[]): { title: string; hint: string } {
  const e = doc.entities.find((x) => entityIds.includes(x.id));
  return { title: 'Polygon', hint: e?.locked ? 'locked' : 'construction' };
}

/** "Segment · construction arc" for a circle segment, "Segment · fair" for a faired line, etc. */
function segmentLabel(doc: Doc, entityId: string, state: string): string {
  const e = doc.entities.find((x) => x.id === entityId);
  return `${state}${e?.kind === 'circle' ? ' arc' : ''}`;
}

/**
 * Phase 3H: a compact stroke colour/width popover — palette swatches, a "Mine" custom colour
 * input, and a 1–8px width slider. `onChange` fires on every colour pick and on width-slider
 * release (one commit each, not one per drag sample).
 */
function showFairStrokePopover(anchor: HTMLElement, current: { colour: string; width: number }, onChange: (stroke: { colour: string; width: number }) => void): void {
  mountPopover(anchor, (menu, close) => {
    void close;
    const colourLabel = document.createElement('div');
    colourLabel.className = 'popover-section-label';
    colourLabel.textContent = 'Stroke colour';
    menu.appendChild(colourLabel);

    const swatchRow = document.createElement('div');
    swatchRow.className = 'swatch-row';
    let activeColour = current.colour;
    const swatchEls: HTMLButtonElement[] = [];
    const refreshSwatches = () => {
      swatchEls.forEach((el) => el.classList.toggle('active', el.dataset.colour?.toLowerCase() === activeColour.toLowerCase()));
    };
    for (const p of fairPalette) {
      const sw = document.createElement('button');
      sw.className = 'swatch';
      sw.dataset.colour = p.colour;
      sw.style.background = p.colour;
      sw.setAttribute('aria-label', p.name);
      sw.title = p.name;
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        activeColour = p.colour;
        refreshSwatches();
        onChange({ colour: activeColour, width: current.width });
      });
      swatchEls.push(sw);
      swatchRow.appendChild(sw);
    }
    const customWrap = document.createElement('label');
    customWrap.className = 'swatch swatch-custom';
    customWrap.title = 'Mine';
    const customInput = document.createElement('input');
    customInput.type = 'color';
    customInput.value = /^#[0-9a-f]{6}$/i.test(current.colour) ? current.colour : '#1e2a36';
    customInput.addEventListener('click', (e) => e.stopPropagation());
    customInput.addEventListener('input', () => {
      activeColour = customInput.value;
      refreshSwatches();
      onChange({ colour: activeColour, width: current.width });
    });
    customWrap.appendChild(customInput);
    swatchRow.appendChild(customWrap);
    refreshSwatches();
    menu.appendChild(swatchRow);

    const widthLabel = document.createElement('div');
    widthLabel.className = 'popover-section-label';
    widthLabel.textContent = 'Stroke width';
    menu.appendChild(widthLabel);

    const widthRow = document.createElement('div');
    widthRow.className = 'popover-toggle-row';
    const widthSlider = document.createElement('input');
    widthSlider.type = 'range';
    widthSlider.min = '1';
    widthSlider.max = '8';
    widthSlider.step = '0.5';
    widthSlider.value = String(current.width);
    widthSlider.className = 'width-slider';
    const widthValue = document.createElement('span');
    widthValue.className = 'popover-row-label';
    widthValue.textContent = `${current.width}px`;
    widthSlider.addEventListener('input', (e) => {
      e.stopPropagation();
      widthValue.textContent = `${widthSlider.value}px`;
    });
    widthSlider.addEventListener('change', (e) => {
      e.stopPropagation();
      onChange({ colour: activeColour, width: Number(widthSlider.value) });
    });
    widthRow.appendChild(widthSlider);
    widthRow.appendChild(widthValue);
    menu.appendChild(widthRow);
  });
}

/** Phase 4 item 5: Fill's colour-only popover — same approved palette + "Mine" custom input as
 * Fair's, minus the width row (a fill has no stroke). */
function showFillColourPopover(anchor: HTMLElement, current: string, onChange: (colour: string) => void): void {
  mountPopover(anchor, (menu, close) => {
    void close;
    const colourLabel = document.createElement('div');
    colourLabel.className = 'popover-section-label';
    colourLabel.textContent = 'Fill colour';
    menu.appendChild(colourLabel);

    const swatchRow = document.createElement('div');
    swatchRow.className = 'swatch-row';
    let activeColour = current;
    const swatchEls: HTMLButtonElement[] = [];
    const refreshSwatches = () => {
      swatchEls.forEach((el) => el.classList.toggle('active', el.dataset.colour?.toLowerCase() === activeColour.toLowerCase()));
    };
    for (const p of fairPalette) {
      const sw = document.createElement('button');
      sw.className = 'swatch';
      sw.dataset.colour = p.colour;
      sw.style.background = p.colour;
      sw.setAttribute('aria-label', p.name);
      sw.title = p.name;
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        activeColour = p.colour;
        refreshSwatches();
        onChange(activeColour);
      });
      swatchEls.push(sw);
      swatchRow.appendChild(sw);
    }
    const customWrap = document.createElement('label');
    customWrap.className = 'swatch swatch-custom';
    customWrap.title = 'Mine';
    const customInput = document.createElement('input');
    customInput.type = 'color';
    customInput.value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#1e2a36';
    customInput.addEventListener('click', (e) => e.stopPropagation());
    customInput.addEventListener('input', () => {
      activeColour = customInput.value;
      refreshSwatches();
      onChange(activeColour);
    });
    customWrap.appendChild(customInput);
    swatchRow.appendChild(customWrap);
    refreshSwatches();
    menu.appendChild(swatchRow);
  });
}

/** Mounts an anchored popover shell (positioning, outside-tap dismissal, single-instance),
 * leaving the caller to fill in `menu`. Returns a `close` the caller can invoke itself
 * (e.g. after a selection). */
function mountPopover(anchor: HTMLElement, fill: (menu: HTMLElement, close: () => void) => void): void {
  document.querySelector('.popover-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'popover-menu';

  function onOutside(e: PointerEvent): void {
    if (!menu.contains(e.target as Node)) close();
  }
  function close(): void {
    menu.remove();
    document.removeEventListener('pointerdown', onOutside, true);
  }

  fill(menu, close);
  document.body.appendChild(menu);

  const anchorRect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = anchorRect.left + anchorRect.width / 2 - menuRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
  let top = anchorRect.top - menuRect.height - 10;
  if (top < 8) top = anchorRect.bottom + 10;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
}

/** A small anchored flat-list menu, dismissed on an outside tap or a selection. Used by the
 * menu button (Frame…/Clear drawing). */
function showPopover(anchor: HTMLElement, items: { label: string; active?: boolean; onSelect: () => void }[]): void {
  mountPopover(anchor, (menu, close) => {
    for (const item of items) {
      const btn = document.createElement('button');
      btn.textContent = item.label;
      if (item.active) btn.classList.add('active');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
        item.onSelect();
      });
      menu.appendChild(btn);
    }
  });
}

const POINT_TARGET_ROWS: { key: keyof Doc['pointTargets']; label: string; hint: string }[] = [
  { key: 'primary', label: 'Primary', hint: 'Intersections · centres · frame vertices' },
  { key: 'derived', label: 'Derived', hint: 'Midpoints · division points' },
  { key: 'free', label: 'Free on curve', hint: 'Allow new points anywhere on geometry' },
];

/**
 * Phase 3.4 items 5–10: the Point Targets panel — what the geometry-creation tools may snap to
 * or materialize, replacing the old binary Point Lock. Three independent toggles (Primary/
 * Derived/Free), each taking effect immediately (a document preference, like the old lock, so no
 * explicit "done" step). Deliberately separate from Points-shown (item 9): a category here
 * governs eligibility to target/create, not what's drawn — see showPointsMenu for that.
 */
function showPointTargetsPanel(anchor: HTMLElement, controller: AppController): void {
  mountPopover(anchor, (menu, close) => {
    void close;
    const heading = document.createElement('div');
    heading.className = 'popover-section-label';
    heading.textContent = 'Point targets';
    menu.appendChild(heading);

    for (const row of POINT_TARGET_ROWS) {
      const toggleRow = document.createElement('div');
      toggleRow.className = 'popover-toggle-row';
      const label = document.createElement('span');
      label.className = 'popover-row-label';
      label.textContent = row.label;
      const toggleSwitch = document.createElement('button');
      const setState = (on: boolean) => {
        toggleSwitch.className = 'toggle-switch' + (on ? ' on' : '');
        toggleSwitch.setAttribute('aria-label', `${row.label} ${on ? 'on' : 'off'}`);
        toggleSwitch.setAttribute('aria-pressed', String(on));
      };
      setState(controller.doc.pointTargets[row.key]);
      toggleSwitch.innerHTML = '<span class="toggle-knob"></span>';
      toggleSwitch.addEventListener('click', (e) => {
        e.stopPropagation();
        controller.setPointTarget(row.key, !controller.doc.pointTargets[row.key]);
        setState(controller.doc.pointTargets[row.key]);
      });
      toggleRow.appendChild(label);
      toggleRow.appendChild(toggleSwitch);
      menu.appendChild(toggleRow);

      const hint = document.createElement('p');
      hint.className = 'popover-hint';
      hint.textContent = row.hint;
      menu.appendChild(hint);
    }
  });
}

/**
 * Phase 3.2 item 2: the secondary Points-shown menu — Near Finger/Used/All/None, reached only by
 * a long-press on the Eye button now that an ordinary tap is a quick Show/Hide toggle (see
 * buildShell). Point Lock no longer lives here (item 1: it's a persistent top-bar control now).
 * `onShownModePicked` lets the Eye button remember the last non-None mode it should restore to.
 */
function showPointsMenu(anchor: HTMLElement, controller: AppController, onShownModePicked: (mode: PointVisibility) => void): void {
  mountPopover(anchor, (menu, close) => {
    const pointsLabel = document.createElement('div');
    pointsLabel.className = 'popover-section-label';
    pointsLabel.textContent = 'Points shown';
    menu.appendChild(pointsLabel);

    for (const opt of VISIBILITY_OPTIONS) {
      const active = controller.pointVisibility === opt.id;
      const btn = document.createElement('button');
      btn.className = 'popover-row' + (active ? ' active' : '');
      btn.innerHTML = `<span class="popover-row-label">${opt.label}</span>${active ? '<span class="popover-row-check">✓</span>' : ''}`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        controller.pointVisibility = opt.id;
        if (opt.id !== 'none') onShownModePicked(opt.id);
        controller.notifyView();
        close();
      });
      menu.appendChild(btn);
    }
  });
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
  opts: { onFit: () => void; onFrame: () => void; onClearDrawing: () => void; onSwitchWorkspace: (ws: 'construct' | 'repeat') => void },
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
  menuBtn.addEventListener('click', () => {
    showPopover(menuBtn, [
      { label: 'Frame…', onSelect: () => opts.onFrame() },
      { label: 'Clear drawing…', onSelect: () => opts.onClearDrawing() },
    ]);
  });
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
  pointLockBtn.addEventListener('click', () => showPointTargetsPanel(pointLockBtn, controller));
  function refreshPointLockBtn(): void {
    const freeAllowed = controller.doc.pointTargets.free;
    pointLockBtn.innerHTML = iconSvg(freeAllowed ? 'pointLockOpen' : 'pointLock', 22);
    pointLockBtn.classList.toggle('free-on', freeAllowed);
    pointLockBtn.setAttribute('aria-label', `Point targets · Free on curve ${freeAllowed ? 'on' : 'off'}`);
  }
  refreshPointLockBtn();
  leftSide.appendChild(pointLockBtn);

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

  // Phase 3.2 item 2: an ordinary tap is a plain Show points / Hide points toggle — no menu, no
  // choice to make. Near Finger/Used/All/None are still reachable, but only via a long-press
  // (same 350ms/8px hold-vs-drag idiom Select's precision loupe already uses), so the everyday
  // interaction stays a single obvious action. `lastShown` remembers whichever granular mode was
  // last active, so toggling back to "Show" restores it rather than resetting to a fixed default.
  const EYE_HOLD_MS = 350;
  const EYE_HOLD_MOVE_TOLERANCE = 8;
  let lastShown: PointVisibility = controller.pointVisibility === 'none' ? 'near-finger' : controller.pointVisibility;
  let eyeHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let eyeHoldFired = false;
  let eyeDownPos: Vec2 | null = null;

  function refreshEyeIcon(): void {
    // Phase 3.3 item 2 / Phase 3.5 item 6: the eye stays the dominant shape either way — hidden
    // state mutes it (lower-opacity icon paths, plus the button's own colour switching to muted
    // ink here) rather than slashing it, so it never reads as Delete/Error. Corner dots stay
    // strictly secondary to the eye in both states.
    const hidden = controller.pointVisibility === 'none';
    visBtn.innerHTML = iconSvg(hidden ? 'pointsEyeOff' : 'pointsEye');
    visBtn.style.color = hidden ? 'var(--muted)' : '';
    visBtn.setAttribute('aria-label', hidden ? 'Show points' : 'Hide points');
  }
  function toggleQuickVisibility(): void {
    if (controller.pointVisibility === 'none') {
      controller.pointVisibility = lastShown;
    } else {
      lastShown = controller.pointVisibility;
      controller.pointVisibility = 'none';
    }
    controller.notifyView();
  }
  visBtn.addEventListener('pointerdown', (e) => {
    eyeHoldFired = false;
    eyeDownPos = { x: e.clientX, y: e.clientY };
    eyeHoldTimer = setTimeout(() => {
      eyeHoldTimer = null;
      eyeHoldFired = true;
      showPointsMenu(visBtn, controller, (mode) => {
        lastShown = mode;
      });
    }, EYE_HOLD_MS);
  });
  visBtn.addEventListener('pointermove', (e) => {
    if (!eyeDownPos || eyeHoldTimer === null) return;
    if (Math.hypot(e.clientX - eyeDownPos.x, e.clientY - eyeDownPos.y) > EYE_HOLD_MOVE_TOLERANCE) {
      clearTimeout(eyeHoldTimer);
      eyeHoldTimer = null;
    }
  });
  visBtn.addEventListener('pointerup', () => {
    if (eyeHoldTimer !== null) {
      clearTimeout(eyeHoldTimer);
      eyeHoldTimer = null;
    }
    if (!eyeHoldFired) toggleQuickVisibility();
    eyeDownPos = null;
  });
  visBtn.addEventListener('pointercancel', () => {
    if (eyeHoldTimer !== null) {
      clearTimeout(eyeHoldTimer);
      eyeHoldTimer = null;
    }
    eyeDownPos = null;
  });
  refreshEyeIcon();
  controller.subscribeView(refreshEyeIcon);

  const exportBtn = document.createElement('button');
  exportBtn.className = 'icon-btn';
  exportBtn.setAttribute('aria-label', 'Export');
  exportBtn.innerHTML = iconSvg('share');
  exportBtn.addEventListener('click', () => showToast('Export arrives in a later pass'));
  rightSide.appendChild(visBtn);
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

  const overlay = document.createElement('div');
  overlay.className = 'canvas-overlay-bottom';

  const utilRow = document.createElement('div');
  utilRow.className = 'util-row';
  const undoRedoPill = document.createElement('div');
  undoRedoPill.className = 'undo-redo-pill';
  const undoBtn = document.createElement('button');
  undoBtn.setAttribute('aria-label', 'Undo');
  undoBtn.innerHTML = iconSvg('undo');
  undoBtn.addEventListener('click', () => controller.undo());
  const divider = document.createElement('div');
  divider.className = 'divider';
  const redoBtn = document.createElement('button');
  redoBtn.setAttribute('aria-label', 'Redo');
  redoBtn.innerHTML = iconSvg('redo');
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

  const extendChip = document.createElement('button');
  extendChip.className = 'extend-chip';
  extendChip.style.display = 'none';
  extendChip.textContent = 'Extend';
  extendChip.addEventListener('click', () => {
    const chip = controller.extendChip;
    if (!chip) return;
    controller.commit((d) => {
      const e = d.entities.find((en) => en.id === chip.entityId);
      if (e && e.kind === 'line') e.extended = true;
    });
    controller.setExtendChip(null);
  });

  // Phase 3.4 item 3: "Promote to Fair" — a shortcut only; internally the exact same promotion
  // the Fair tool performs on a tap. Sits alongside Extend (a fresh Construction line can offer
  // both at once) rather than replacing it.
  const fairPromoteChip = document.createElement('button');
  fairPromoteChip.className = 'extend-chip';
  fairPromoteChip.style.display = 'none';
  fairPromoteChip.textContent = 'Promote to Fair';
  fairPromoteChip.addEventListener('click', () => {
    const chip = controller.fairPromoteChip;
    if (!chip) return;
    controller.commit((d) => promoteEntityToFair(d, chip.entityId));
    controller.setFairPromoteChip(null);
  });

  const quickActionsRow = document.createElement('div');
  quickActionsRow.className = 'quick-actions-row';
  quickActionsRow.appendChild(extendChip);
  quickActionsRow.appendChild(fairPromoteChip);

  // Phase 3.7 item 4: Select's own compact targeting filter — shown only while Select is active,
  // independent of the (collapsible) context band below it, so it stays reachable even when
  // nothing is selected. Divide and Fair never read `selectFilter` at all (item 8).
  const selectFilterRow = document.createElement('div');
  selectFilterRow.className = 'select-filter-row';
  const selectFilterSeg = document.createElement('div');
  selectFilterSeg.className = 'segmented-mini';
  const SELECT_FILTERS: { id: SelectFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'fair', label: 'Fair' },
    { id: 'construction', label: 'Construction' },
    { id: 'points', label: 'Points' },
  ];
  const selectFilterBtns = new Map<SelectFilter, HTMLButtonElement>();
  for (const f of SELECT_FILTERS) {
    const btn = document.createElement('button');
    btn.textContent = f.label;
    btn.addEventListener('click', () => {
      if (controller.selectFilter === f.id) return;
      controller.selectFilter = f.id;
      controller.select([]);
    });
    selectFilterBtns.set(f.id, btn);
    selectFilterSeg.appendChild(btn);
  }
  selectFilterRow.appendChild(selectFilterSeg);

  const contextBar = document.createElement('div');
  contextBar.className = 'context-bar';

  const dock = document.createElement('div');
  dock.className = 'dock';
  const dockButtonEls = new Map<ToolId, HTMLButtonElement>();
  DOCK_BUTTONS.forEach((spec) => {
    if (spec.divider) {
      const d = document.createElement('div');
      d.className = 'divider';
      dock.appendChild(d);
    }
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', spec.label);
    btn.innerHTML = `${iconSvg(spec.id as IconName)}<span class="label">${spec.label}</span>`;
    // Phase 1.2a item 1: Circle has one meaning — construct a circle. Frame lives only in the
    // first/new-document flow and the menu's "Frame…" item, never on the Circle button itself.
    btn.addEventListener('click', () => {
      if (!LIVE_TOOLS.has(spec.id)) {
        showToast(`${spec.label} arrives in a later pass`);
        return;
      }
      // §2A: tapping Polygon again mid-chain finishes the open chain rather than resetting to
      // Select (the usual "tap the lit tool again" behaviour) — but only when there's actually
      // something to finish.
      if (spec.id === 'polygon' && controller.tool === 'polygon' && finishOpenPolygon(controller)) return;
      controller.setTool(spec.id);
    });
    dockButtonEls.set(spec.id, btn);
    dock.appendChild(btn);
  });

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
    { id: 'hex', label: 'Hex / Triangle' },
  ];
  const familyBtns = new Map<LatticeFamily, HTMLButtonElement>();
  for (const f of FAMILIES) {
    const btn = document.createElement('button');
    btn.textContent = f.label;
    btn.addEventListener('click', () => {
      if (controller.doc.repeat.family === f.id) return;
      // Phase 5 item 3: switching family resets a/b to that family's own comfortable defaults —
      // the old vectors belonged to a different arrangement shape and wouldn't make sense as-is.
      controller.commit((d) => {
        const { a, b } = defaultLatticeVectors(d, f.id);
        d.repeat.family = f.id;
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

  const guideBtn = document.createElement('button');
  guideBtn.className = 'chip';
  guideBtn.addEventListener('click', () => {
    controller.doc.repeatGuide = !controller.doc.repeatGuide;
    controller.notify();
  });
  repeatPanel.appendChild(guideBtn);

  overlay.appendChild(utilRow);
  overlay.appendChild(quickActionsRow);
  overlay.appendChild(selectFilterRow);
  overlay.appendChild(repeatPanel);
  overlay.appendChild(contextBar);
  overlay.appendChild(dock);
  canvasWrap.appendChild(overlay);

  shell.appendChild(topbar);
  shell.appendChild(canvasWrap);
  root.appendChild(shell);

  // ---- Phase 2C / Phase 2.1 item 1: Divide's compact live control, opened either by the
  // Divide tool's canvas tap (via controller.pendingDivide, watched below) or by Select's
  // "Divide…" action chip. ----
  function openDivideForTarget(target: DivideTarget): void {
    const doc = controller.doc;
    const entity = doc.entities.find((e) => e.id === target.entityId);
    if (!entity) return;
    const isCircleWhole = target.kind === 'circle-whole';
    const title = isCircleWhole ? 'Divide circle' : entity.kind === 'circle' ? 'Divide arc' : 'Divide line';
    openDivideSheet(root, controller, target, {
      title,
      allowStar: isCircleWhole,
      // Phase 3.7 item 10: start at whatever N was last used, not a hardcoded default.
      initial: doc.dividePrefs.lastN,
      onApply: (choice) => {
        let createdPointIds: PointId[] = [];
        controller.commit((d) => {
          const freshEntity = d.entities.find((e) => e.id === target.entityId);
          if (!freshEntity) return;
          if (target.kind === 'circle-whole' && freshEntity.kind === 'circle') {
            const pts = addCircleDivision(d, freshEntity.id, choice.of, d.frame.rotation);
            if (choice.starK) addStarChords(d, pts, choice.starK);
            createdPointIds = pts;
          } else if (target.kind === 'segment') {
            const group = findSelectableGroup(d, freshEntity, target.from, target.to);
            if (group) createdPointIds = addSegmentDivisionPoints(d, group, choice.of);
          }
        });
        // A document preference, like pointTargets/fairDefaults — not undo-tracked.
        controller.doc.dividePrefs.lastN = choice.of;
        controller.select([]);
        // Phase 2.1 item 2: flash the new division points in Signal feedback for a few seconds
        // regardless of the current Points-shown rule.
        if (createdPointIds.length > 0) controller.setRecentPoints(createdPointIds);
      },
    });
  }
  controller.subscribe(() => {
    const target = controller.pendingDivide;
    if (!target) return;
    controller.pendingDivide = null;
    openDivideForTarget(target);
  });

  /** Phase 2.1 item 6: labelled by entity kind ("Delete circle"/"Delete line"/"Delete polygon"),
   * not a generic "Delete…" — the whole-entity action should read as unmistakably distinct from
   * a segment's Trim. */
  function renderDeleteChip(plan: () => DeletionPlan, locked: boolean, label: string): void {
    const del = document.createElement('button');
    del.className = 'chip';
    del.textContent = label;
    del.disabled = locked;
    if (locked) del.style.opacity = '0.35';
    del.addEventListener('click', () => {
      if (locked) return;
      const p = plan();
      const depCount = p.entityIds.size - 1 + p.pointIds.size;
      openConfirmSheet(root, {
        title: 'Delete this shape?',
        body: depCount > 0 ? `Also removes ${depCount} dependent construction${depCount === 1 ? '' : 's'}. Undo will bring it back.` : 'Undo will bring it back.',
        confirmLabel: 'Delete',
        onConfirm: () => {
          controller.commit((d) => applyDeletionPlan(d, p));
          controller.select([]);
        },
      });
    });
    contextBar.appendChild(del);
  }

  // ---- reactive updates ----
  /** Phase 3.7 item 2/7: Select edits what already exists — it never starts a new construction.
   * A selected point here means "inspect/clean up this point," never "build from it" (that's
   * Circle/Line's own job, tapping the point directly with that tool active). */
  function renderPointActions(doc: Doc, id: PointId): void {
    const label = document.createElement('div');
    label.className = 'label';
    label.innerHTML = `<span class="title">Point</span><span class="hint">${pointKindLabel(doc, id)}</span>`;
    contextBar.appendChild(label);

    // Phase 3.5 item 3: only free/on-curve points are directly editable — everything else
    // (intersection, centre, midpoint, division, frame vertex) is mathematically derived, so
    // rather than a disabled "Delete" implying a Move/Delete that isn't really on offer, say so.
    const plan = computePointDeletionPlan(doc, id);
    if (!plan) {
      const note = document.createElement('p');
      note.className = 'point-derived-note';
      note.textContent = 'Derived from construction geometry — not directly editable.';
      contextBar.appendChild(note);
      return;
    }

    const mergeBtn = document.createElement('button');
    mergeBtn.className = 'chip';
    mergeBtn.textContent = 'Merge into…';
    mergeBtn.addEventListener('click', () => {
      controller.pendingMerge = { sourceId: id };
      controller.notify();
    });
    contextBar.appendChild(mergeBtn);

    const del = document.createElement('button');
    del.className = 'chip';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      const depCount = plan.entityIds.size + (plan.pointIds.size - 1);
      if (depCount === 0) {
        controller.commit((d) => applyPointDeletionPlan(d, plan));
        controller.select([]);
        return;
      }
      // Phase 3.5 item 3: "Do not silently break geometry" — explicit confirmation naming what
      // else goes with it, same pattern as the whole-entity Delete chip.
      openConfirmSheet(root, {
        title: 'Delete this point?',
        body: `Delete point and ${depCount} dependent construction${depCount === 1 ? '' : 's'}? Undo will bring it back.`,
        confirmLabel: 'Delete',
        onConfirm: () => {
          controller.commit((d) => applyPointDeletionPlan(d, plan));
          controller.select([]);
        },
      });
    });
    contextBar.appendChild(del);
  }

  function renderSelectActions(): void {
    contextBar.innerHTML = '';
    contextBar.classList.remove('hidden');
    const doc = controller.doc;
    const sel = controller.selection;

    // Phase 3.5 item 3: "Merge into…" is picking a destination — a distinct mode from ordinary
    // Select, so it gets its own context bar regardless of whatever's currently selected.
    if (controller.pendingMerge) {
      const label = document.createElement('div');
      label.className = 'label';
      label.innerHTML = `<span class="title">Merge into…</span><span class="hint">Choose an existing point</span>`;
      contextBar.appendChild(label);
      const cancel = document.createElement('button');
      cancel.className = 'chip icon-only';
      cancel.innerHTML = iconSvg('close', 16);
      cancel.setAttribute('aria-label', 'Cancel');
      cancel.addEventListener('click', () => {
        controller.pendingMerge = null;
        controller.notify();
      });
      contextBar.appendChild(cancel);
      return;
    }

    if (sel.length === 0) {
      // Phase 3.6 item 9 / Phase 3.7 item 4: idle Select has no meaningful state to report —
      // collapse the band instead of a generic "Tap a point, segment or shape" instruction,
      // unless there's a real one-tap action available (Select all Fair), which then shows
      // alone. Only offered under All/Fair — it would contradict a Construction/Points filter.
      const fairCandidates: Extract<SelectCandidate, { kind: 'segment' }>[] = [];
      if (controller.selectFilter === 'all' || controller.selectFilter === 'fair') {
        for (const e of doc.entities) {
          for (const seg of deriveSegments(doc, e)) {
            if (doc.segmentStates.get(seg.key)?.state === 'fair') {
              const group = findSelectableGroup(doc, e, seg.from, seg.to);
              if (group) fairCandidates.push({ kind: 'segment', entityId: e.id, from: group.from, to: group.to, fromParam: group.fromParam, toParam: group.toParam, keys: group.segments.map((s) => s.key) });
            }
          }
        }
      }
      const uniqueFair = fairCandidates.filter((c, i) => fairCandidates.findIndex((o) => o.from === c.from && o.to === c.to && o.entityId === c.entityId) === i);
      if (uniqueFair.length > 0) {
        const selectAllBtn = document.createElement('button');
        selectAllBtn.className = 'chip';
        selectAllBtn.textContent = `Select all Fair (${uniqueFair.length})`;
        selectAllBtn.addEventListener('click', () => controller.select(uniqueFair));
        contextBar.appendChild(selectAllBtn);
      } else {
        contextBar.classList.add('hidden');
      }
      return;
    }

    if (sel.length > 1) {
      const label = document.createElement('div');
      label.className = 'label';
      const segCands = sel.filter((c): c is Extract<SelectCandidate, { kind: 'segment' }> => c.kind === 'segment');
      const fairSegs = segCands.filter((c) => c.keys.every((k) => doc.segmentStates.get(k)?.state === 'fair'));
      label.innerHTML =
        fairSegs.length > 0
          ? `<span class="title">${sel.length} selected</span><span class="hint">${fairSegs.length} Fair segment${fairSegs.length === 1 ? '' : 's'}</span>`
          : `<span class="title">${sel.length} selected</span><span class="hint">Marquee selection</span>`;
      contextBar.appendChild(label);

      // Phase 3.1 item 4: recolour/reweight every selected Fair segment in one undoable action,
      // without retracing any of them.
      if (fairSegs.length > 0) {
        const keys = fairSegs.flatMap((c) => c.keys);
        const current = doc.segmentStates.get(keys[0]!)?.stroke ?? doc.fairDefaults;
        const strokeBtn = document.createElement('button');
        strokeBtn.className = 'chip';
        strokeBtn.textContent = `Stroke (${fairSegs.length})`;
        strokeBtn.addEventListener('click', () => {
          showFairStrokePopover(strokeBtn, current, (next) => {
            controller.commit((d) => {
              for (const k of keys) setSegmentStroke(d, k, next.colour, next.width);
            });
          });
        });
        contextBar.appendChild(strokeBtn);
      }
      return;
    }

    const cand: SelectCandidate = sel[0]!;
    if (cand.kind === 'point') {
      renderPointActions(doc, cand.id);
      return;
    }

    const label = document.createElement('div');
    label.className = 'label';

    if (cand.kind === 'segment') {
      // Phase 2.1 item 4: true Trim means a trimmed segment can no longer be selected at all
      // (hit-testing excludes it — see interaction/hittest.ts), so this branch never sees one.
      // Phase 3.6 item 4: `cand` is a SelectableGroup — `cand.keys` lists every granular segment
      // it spans; every action here applies to all of them atomically, while segment STATE
      // STORAGE (doc.segmentStates) stays keyed granularly underneath.
      const keys = cand.keys;
      const entity = doc.entities.find((x) => x.id === cand.entityId);
      const state = doc.segmentStates.get(keys[0]!);
      const isFair = keys.length > 0 && keys.every((k) => doc.segmentStates.get(k)?.state === 'fair');

      // Phase 3.7 items 1/6/8: Divide (and Midpoint, a divide-by-2 shortcut) are CREATE-GEOMETRY
      // actions — Select edits what already exists and never offers them; reach Divide via its
      // own tool instead.
      const fairToggleBtn = (): HTMLButtonElement => {
        const btn = document.createElement('button');
        btn.className = 'chip';
        btn.textContent = isFair ? 'Construction' : 'Fair';
        btn.addEventListener('click', () => {
          controller.commit((d) => {
            for (const k of keys) setSegmentFair(d, k, !isFair);
          });
          controller.select([cand]);
        });
        return btn;
      };
      const strokeBtn = (): HTMLButtonElement => {
        const btn = document.createElement('button');
        btn.className = 'chip';
        btn.textContent = 'Stroke';
        btn.addEventListener('click', () => {
          const current = state?.stroke ?? doc.fairDefaults;
          showFairStrokePopover(btn, current, (next) => {
            controller.commit((d) => {
              for (const k of keys) setSegmentStroke(d, k, next.colour, next.width);
            });
          });
        });
        return btn;
      };

      // Phase 3G: a frame segment gets its own action set — Fair/Construction only become
      // available once the frame is design-enabled, and Trim/Delete never do.
      if (entity?.locked) {
        label.innerHTML = `<span class="title">Segment</span><span class="hint">${doc.frame.designEnabled ? segmentLabel(doc, cand.entityId, state?.state ?? 'construction') : 'locked'}</span>`;
        contextBar.appendChild(label);

        if (!doc.frame.designEnabled) {
          const useFrameBtn = document.createElement('button');
          useFrameBtn.className = 'chip';
          useFrameBtn.textContent = 'Use frame in design';
          useFrameBtn.addEventListener('click', () => {
            controller.commit((d) => setFrameDesignEnabled(d, true));
            controller.select([cand]);
          });
          contextBar.appendChild(useFrameBtn);
          return;
        }

        contextBar.appendChild(fairToggleBtn());
        if (isFair) contextBar.appendChild(strokeBtn());
        const stopFrameBtn = document.createElement('button');
        stopFrameBtn.className = 'chip';
        stopFrameBtn.textContent = 'Stop using frame in design';
        stopFrameBtn.addEventListener('click', () => {
          controller.commit((d) => setFrameDesignEnabled(d, false));
          controller.select([]);
        });
        contextBar.appendChild(stopFrameBtn);
        return;
      }

      label.innerHTML = `<span class="title">Segment</span><span class="hint">${segmentLabel(doc, cand.entityId, state?.state ?? 'construction')}</span>`;
      contextBar.appendChild(label);

      const trimBtn = document.createElement('button');
      trimBtn.className = 'chip';
      trimBtn.textContent = 'Trim';
      trimBtn.addEventListener('click', () => {
        controller.commit((d) => {
          for (const k of keys) trimSegment(d, cand.entityId, k);
        });
        // Phase 2.1 item 4: the segment is now genuinely gone — it must not stay "selected"
        // (that would draw a Signal highlight and an action bar over geometry that no longer
        // renders at all). Undo is the only way back to it in this phase.
        controller.select([]);
      });

      contextBar.appendChild(trimBtn);
      contextBar.appendChild(fairToggleBtn());
      if (isFair) contextBar.appendChild(strokeBtn());
      return;
    }

    if (cand.kind === 'group') {
      const { title, hint } = groupLabel(doc, cand.entityIds);
      label.innerHTML = `<span class="title">${title}</span><span class="hint">${hint}</span>`;
      contextBar.appendChild(label);
      renderDeleteChip(() => computeGroupDeletionPlan(doc, cand.entityIds[0]!), false, 'Delete polygon');
      return;
    }

    if (cand.kind === 'fill') {
      // Phase 4 item 8: Select edits/removes an existing fill; it never creates one.
      const currentColour = getRegionFill(doc, cand.sig) ?? doc.fillDefaults.colour;
      label.innerHTML = `<span class="title">Fill</span><span class="hint">filled region</span>`;
      contextBar.appendChild(label);

      const colourBtn = document.createElement('button');
      colourBtn.className = 'chip stroke-chip';
      const dot = document.createElement('span');
      dot.className = 'stroke-chip-dot';
      dot.style.background = currentColour;
      colourBtn.appendChild(dot);
      colourBtn.appendChild(document.createTextNode('Colour'));
      colourBtn.addEventListener('click', () => {
        showFillColourPopover(colourBtn, currentColour, (next) => {
          controller.commit((d) => setRegionFill(d, cand.sig, next));
        });
      });
      contextBar.appendChild(colourBtn);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'chip';
      removeBtn.textContent = 'Remove fill';
      removeBtn.addEventListener('click', () => {
        controller.commit((d) => removeRegionFill(d, cand.sig));
        controller.select([]);
      });
      contextBar.appendChild(removeBtn);
      return;
    }

    // cand.kind === 'entity'
    const { title, hint } = entityLabel(doc, cand.entityId);
    label.innerHTML = `<span class="title">${title}</span><span class="hint">${hint}</span>`;
    contextBar.appendChild(label);
    const e = doc.entities.find((x) => x.id === cand.entityId);

    // Phase 3G: an undivided circle frame has no derived segments yet, so it can only ever be
    // reached here as the whole entity — "Use frame in design" must still be reachable from it.
    if (e?.locked) {
      const frameBtn = document.createElement('button');
      frameBtn.className = 'chip';
      frameBtn.textContent = doc.frame.designEnabled ? 'Stop using frame in design' : 'Use frame in design';
      frameBtn.addEventListener('click', () => {
        const enable = !doc.frame.designEnabled;
        controller.commit((d) => setFrameDesignEnabled(d, enable));
        controller.select([]);
      });
      contextBar.appendChild(frameBtn);
      return;
    }

    // Phase 3.7 items 1/6/8: Divide is reached only through its own tool now, never as a shortcut
    // from a Select entity selection — see the segment branch above for the same change.
    renderDeleteChip(() => computeDeletionPlan(doc, cand.entityId), !!e?.locked, e?.kind === 'circle' ? 'Delete circle' : 'Delete line');
  }

  function renderToolContext(toolId: ToolId): void {
    contextBar.innerHTML = '';
    contextBar.classList.remove('hidden');
    const doc = controller.doc;

    // Phase 3.6 item 9: the band shows meaningful current task state/action only — an idle tool
    // with nothing pending and nothing selected shows no label at all (and, if nothing else in
    // this function adds a real control either, the band collapses outright at the end).
    let title: string | null = null;
    let hint: string | null = null;
    // Phase 3.2 item 5: a plain "A → B" / "Centre → Radius" status badge instead of the old
    // anonymous two-dot progress indicator — noninteractive.
    let stepBadge: string | null = null;
    let showUseFrameBtn = false;

    if (controller.pending?.kind === 'line') {
      title = `${controller.lineMode === 'extension' ? 'Extension' : 'Construction'} line · A selected`;
      hint = controller.pointLockHint ? 'Point Targets · choose an existing point' : 'Choose second point';
      stepBadge = 'A → B';
    } else if (controller.pending?.kind === 'circle') {
      title = 'Circle · Centre selected';
      hint = controller.pointLockHint ? 'Point Targets · choose an existing point' : 'Drag to set the radius, or choose a point';
      stepBadge = 'Centre → Radius';
    } else if (controller.pending?.kind === 'polygon') {
      const n = controller.pending.vertices.length;
      title = `Polygon · ${n} vertex${n === 1 ? '' : 'es'}`;
      hint = controller.pointLockHint ? 'Point Targets · choose an existing point' : n >= 3 ? 'Tap the next point, or the first vertex to close' : 'Tap the next point';
    } else if (toolId === 'fair') {
      // Phase 3.6 item 7: locking only blocks destructive edits — tapping a not-yet-design frame
      // segment while in Fair now selects it (see interaction/tools/fair.ts), and the context
      // band's job here is to surface the one valid action on it: "Use frame in design".
      const sel = controller.selection[0];
      if (sel && (sel.kind === 'segment' || sel.kind === 'entity')) {
        const e = doc.entities.find((x) => x.id === sel.entityId);
        if (e?.locked && !doc.frame.designEnabled) {
          title = 'Segment';
          hint = 'locked';
          showUseFrameBtn = true;
        }
      }
    }

    if (stepBadge) {
      const badge = document.createElement('div');
      badge.className = 'step-badge';
      badge.textContent = stepBadge;
      contextBar.appendChild(badge);
    }

    if (title) {
      const label = document.createElement('div');
      label.className = 'label';
      label.innerHTML = `<span class="title">${title}</span>${hint ? `<span class="hint">${hint}</span>` : ''}`;
      contextBar.appendChild(label);
    }

    if (showUseFrameBtn) {
      const useFrameBtn = document.createElement('button');
      useFrameBtn.className = 'chip';
      useFrameBtn.textContent = 'Use frame in design';
      useFrameBtn.addEventListener('click', () => {
        controller.commit((d) => setFrameDesignEnabled(d, true));
        controller.select([]);
      });
      contextBar.appendChild(useFrameBtn);
    }

    if (controller.pending?.kind === 'polygon' && controller.pending.vertices.length >= 2) {
      const finish = document.createElement('button');
      finish.className = 'chip';
      finish.textContent = 'Finish';
      finish.addEventListener('click', () => finishOpenPolygon(controller));
      contextBar.appendChild(finish);
    }

    // Phase 3.4 item 2: Line's own Construction/Extension creation mode — kept compact
    // (segmented-mini, the same control Divide's sheet uses) rather than a second dock button,
    // since this is a mode of Line, not a distinct tool. Switching mode mid-gesture cancels
    // whatever was pending, since a line can't change kind partway through being drawn.
    if (toolId === 'line') {
      const modeToggle = document.createElement('div');
      modeToggle.className = 'segmented-mini';
      const modes: { id: 'construction' | 'extension'; label: string }[] = [
        { id: 'construction', label: 'Construction' },
        { id: 'extension', label: 'Extension' },
      ];
      for (const m of modes) {
        const btn = document.createElement('button');
        btn.textContent = m.label;
        if (controller.lineMode === m.id) btn.classList.add('active');
        btn.addEventListener('click', () => {
          if (controller.lineMode === m.id) return;
          controller.cancelPending();
          controller.lineMode = m.id;
          controller.notify();
        });
        modeToggle.appendChild(btn);
      }
      contextBar.appendChild(modeToggle);
    }

    // Phase 3H: the Fair tool's own current stroke — what a freshly-faired segment gets, and
    // editable directly here without needing to select anything first.
    if (toolId === 'fair') {
      // Phase 3.7 item 14: colour AND width both visible before promoting anything — "the
      // segments I promote now will become this colour and this thickness."
      const strokeChip = document.createElement('button');
      strokeChip.className = 'chip stroke-chip';
      const dot = document.createElement('span');
      dot.className = 'stroke-chip-dot';
      dot.style.background = controller.doc.fairDefaults.colour;
      strokeChip.appendChild(dot);
      strokeChip.appendChild(document.createTextNode(`Stroke · ${controller.doc.fairDefaults.width}px`));
      strokeChip.addEventListener('click', () => {
        showFairStrokePopover(strokeChip, controller.doc.fairDefaults, (next) => {
          controller.doc.fairDefaults = next;
          controller.notify();
        });
      });
      contextBar.appendChild(strokeChip);
    }

    // Phase 4 item 5: Fill's own current colour, compact — "Fill [swatch]", tapping opens the
    // same approved palette Fair uses.
    if (toolId === 'fill') {
      const fillChip = document.createElement('button');
      fillChip.className = 'chip stroke-chip';
      const dot = document.createElement('span');
      dot.className = 'stroke-chip-dot';
      dot.style.background = controller.doc.fillDefaults.colour;
      fillChip.appendChild(dot);
      fillChip.appendChild(document.createTextNode('Fill'));
      fillChip.addEventListener('click', () => {
        showFillColourPopover(fillChip, controller.doc.fillDefaults.colour, (next) => {
          controller.doc.fillDefaults = { colour: next };
          controller.notify();
        });
      });
      contextBar.appendChild(fillChip);
    }

    if (controller.pending) {
      const cancel = document.createElement('button');
      cancel.className = 'chip icon-only';
      cancel.innerHTML = iconSvg('close', 16);
      cancel.setAttribute('aria-label', 'Cancel');
      cancel.addEventListener('click', () => controller.cancelPending());
      contextBar.appendChild(cancel);
    }

    // Phase 3.6 item 9: nothing meaningful ended up in the band at all (an idle Circle/Line/
    // Polygon/Divide with no pending step) — collapse it rather than leave an empty shell.
    if (!contextBar.hasChildNodes()) contextBar.classList.add('hidden');
  }

  /** Phase 5: the live contact-state/rotation-fraction readout — updated on the cheap view-only
   * channel too, since it must track a drag in progress at full pointermove frequency. */
  function updateRepeatStatus(): void {
    const contact = currentContactLabel(controller);
    const rotating = controller.repeatRotateDrag;
    if (contact) {
      repeatStatus.textContent = contact;
      repeatStatus.classList.remove('hidden');
    } else if (rotating) {
      const label = rotationFractionLabel(rotating.rawRotation);
      repeatStatus.textContent = label ?? 'Rotating…';
      repeatStatus.classList.remove('hidden');
    } else {
      repeatStatus.classList.add('hidden');
    }
  }

  function update(): void {
    const inRepeat = controller.doc.view.workspace === 'repeat';
    constructBtn.classList.toggle('active', !inRepeat);
    repeatBtn.classList.toggle('active', inRepeat);

    // dock active/pending state
    for (const [id, btn] of dockButtonEls) {
      btn.classList.toggle('active', controller.tool === id);
      btn.classList.toggle('pending-ring', controller.tool === id && !!controller.pending);
    }
    // undo/redo
    undoBtn.disabled = !controller.canUndo();
    redoBtn.disabled = !controller.canRedo();
    refreshPointLockBtn();

    dock.style.display = inRepeat ? 'none' : 'flex';
    contextBar.style.display = inRepeat ? 'none' : 'flex';
    quickActionsRow.style.display = inRepeat ? 'none' : 'flex';
    repeatPanel.style.display = inRepeat ? 'flex' : 'none';

    if (inRepeat) {
      selectFilterRow.style.display = 'none';
      for (const [id, btn] of familyBtns) btn.classList.toggle('active', controller.doc.repeat.family === id);
      for (const [id, btn] of ruleBtns) btn.classList.toggle('active', controller.doc.repeat.rule.kind === id);
      guideBtn.textContent = controller.doc.repeatGuide ? 'Guide on' : 'Guide off';
      guideBtn.classList.toggle('active', controller.doc.repeatGuide);
      updateRepeatStatus();
      return;
    }

    // quick-action chips
    extendChip.style.display = controller.extendChip ? 'flex' : 'none';
    fairPromoteChip.style.display = controller.fairPromoteChip ? 'flex' : 'none';
    // Phase 3.7 item 4: Select's own filter row — visible only while Select is the active tool.
    selectFilterRow.style.display = controller.tool === 'select' ? 'flex' : 'none';
    for (const [id, btn] of selectFilterBtns) btn.classList.toggle('active', controller.selectFilter === id);
    // context bar
    if (controller.tool === 'select') renderSelectActions();
    else renderToolContext(controller.tool);
  }

  controller.subscribe(update);
  controller.subscribeView(updateRepeatStatus);
  update();

  return { canvas, overlay };
}
