import './style.css';
import { clearDrawing, createDoc, defaultRepeatDisplay, placeFrame } from './model/doc.ts';
import { AppController, type ViewTransform } from './app/controller.ts';
import { PointerManager } from './interaction/pointer.ts';
import { selectTool } from './interaction/tools/select.ts';
import { circleTool } from './interaction/tools/circle.ts';
import { lineTool } from './interaction/tools/line.ts';
import { arcTool } from './interaction/tools/arc.ts';
import { divideTool } from './interaction/tools/divide.ts';
import { fairTool } from './interaction/tools/fair.ts';
import { fillTool } from './interaction/tools/fill.ts';
import { repeatTool } from './interaction/tools/repeatTool.ts';
import { render } from './render/renderer.ts';
import { renderRepeat } from './render/repeatRenderer.ts';
import { buildShell } from './ui/shell.ts';
import { openFramePicker } from './ui/framepicker.ts';
import { openConfirmSheet } from './ui/confirmsheet.ts';
import { buildDrawFrameHud } from './ui/drawframehud.ts';
import { attachDrawFrame } from './interaction/drawframe.ts';
import { initToast } from './ui/toast.ts';
import type { Doc, FrameKind } from './model/types.ts';
import { resolvePoint } from './geometry/kernel.ts';
import { worldToScreen } from './app/controller.ts';
import { attachAutosave, type AutosaveHandle } from './persist/autosave.ts';
import { deleteArtwork, getMeta, listArtworks, loadDocument, loadHistory } from './persist/db.ts';
import { openArtworksSheet, openNameSheet } from './ui/artworks.ts';
import { showToast } from './ui/toast.ts';
import { genId } from './model/id.ts';
import { setupCanvasDPR } from './render/canvasSetup.ts';
import { computeVisibleBounds } from './geometry/bounds.ts';
import { ensureRepeatDefaults, fitBounds as repeatFitBounds, firstEntryBounds } from './geometry/lattice.ts';
import { preventSafariPageZoom } from './interaction/preventPageZoom.ts';
import { migrateLegacyFillKeys } from './geometry/regions.ts';

const root = document.getElementById('app');
if (!root) throw new Error('missing #app root');

preventSafariPageZoom();

const tools = { select: selectTool, circle: circleTool, line: lineTool, arc: arcTool, divide: divideTool, fair: fairTool, fill: fillTool } as const;

/** Phase 5.5: the artwork currently open. Tearing it down stops its render loop, resize observer
 * and autosave, so switching artworks never leaves an old one drawing or saving in the background. */
let session: { controller: AppController; autosave: AutosaveHandle; teardown: () => void } | null = null;

function endSession(): void {
  session?.teardown();
  session = null;
}

const FIT_PADDING = 0.86; // consistent margin around the fitted geometry, both axes

/** Shared by fitView and fitRepeatView: fits `bounds` into whatever usable rectangle the canvas
 * currently has, writing the result into `viewState` directly (never through commit — Fit is a
 * view action, same as Phase 3.6 item 2 established for pan/zoom generally). The usable rectangle
 * excludes wherever the floating context-bar/dock overlay obstructs the bottom of the canvas. */
function fitViewState(viewState: { zoom: number; pan: { x: number; y: number } }, bounds: { minX: number; minY: number; maxX: number; maxY: number } | null, fallbackRadius: number, fallbackCentre: { x: number; y: number }, canvas: HTMLCanvasElement, overlay: HTMLElement): void {
  const canvasW = canvas.clientWidth || 1;
  const canvasH = canvas.clientHeight || 1;
  const canvasRect = canvas.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  const usableBottom = overlayRect.top > canvasRect.top ? overlayRect.top - canvasRect.top : canvasH;
  const usableW = canvasW;
  const usableH = Math.min(Math.max(usableBottom, canvasH * 0.25), canvasH);

  let zoom: number;
  let centre: { x: number; y: number };
  if (bounds) {
    const bw = Math.max(bounds.maxX - bounds.minX, 1e-6);
    const bh = Math.max(bounds.maxY - bounds.minY, 1e-6);
    zoom = Math.min(usableW / bw, usableH / bh) * FIT_PADDING;
    centre = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
  } else {
    zoom = (Math.min(usableW, usableH) * FIT_PADDING) / Math.max(fallbackRadius, 1);
    centre = fallbackCentre;
  }
  zoom = Math.max(0.15, Math.min(8, zoom));

  viewState.zoom = zoom;
  // worldToScreen(p) = (p + pan) * zoom + canvas-half — solve pan so `centre` lands on the
  // usable rectangle's centre (canvas-local coordinates) rather than the full canvas's centre.
  viewState.pan = {
    x: (usableW / 2 - canvasW / 2) / zoom - centre.x,
    y: (usableH / 2 - canvasH / 2) / zoom - centre.y,
  };
}

/**
 * Phase 3.2 item 3: Fit, reimplemented around two real rectangles instead of a fixed fraction of
 * the frame radius. `computeVisibleBounds` gives the world-space extent of what's actually drawn
 * (spec: "active visible geometry"); the usable canvas rectangle is read straight off the DOM —
 * the full canvas width, but only up to where the floating context-bar/dock overlay's own top
 * edge begins (it obstructs the bottom of the canvas; the top bar and safe-area insets are
 * already outside the canvas entirely, by layout). Centring the geometry in THAT rectangle,
 * rather than the canvas's own geometric centre, is what the old implementation got wrong — it
 * always centred on the full canvas, so the dock/context-bar routinely sat over the bottom of
 * the design. Never touches document geometry, only view.zoom/view.pan.
 */
function fitView(controller: AppController, canvas: HTMLCanvasElement, overlay: HTMLElement): void {
  const bounds = computeVisibleBounds(controller.doc);
  fitViewState(controller.doc.view, bounds, controller.doc.frame.radius, controller.doc.frame.origin, canvas, overlay);
  controller.notify();
}

/** Phase 5 item 13: Repeat's own Fit — a small 3×3 tessellation sample (geometry/lattice.ts's
 * fitBounds), never the Construct viewport, never an unbounded lattice extent. */
function fitRepeatView(controller: AppController, canvas: HTMLCanvasElement, overlay: HTMLElement): void {
  const bounds = repeatFitBounds(controller.doc);
  fitViewState(controller.doc.repeatView, bounds, controller.doc.frame.radius, controller.doc.frame.origin, canvas, overlay);
  controller.notifyView();
}

/** Phase 5 item 2: the view shown the very first time Repeat is entered — deliberately tighter
 * than fitRepeatView's own 3×3 sample (see firstEntryBounds): "here is my motif, with room for a
 * neighbour," not "here is the whole pattern." */
function fitRepeatFirstEntry(controller: AppController, canvas: HTMLCanvasElement, overlay: HTMLElement): void {
  const bounds = firstEntryBounds(controller.doc);
  fitViewState(controller.doc.repeatView, bounds, controller.doc.frame.radius, controller.doc.frame.origin, canvas, overlay);
  controller.notifyView();
}

/** Boots the app on a document. `fitToScreen: false` preserves a drawn/restored viewport. */
function boot(doc: Doc, opts: { fitToScreen: boolean; history?: { undo: Doc[]; redo: Doc[] } }): void {
  endSession();
  const controller = new AppController(doc);
  // §9 restore: "the tool reset to Select" — AppController already defaults tool to 'select'.
  if (opts.history) controller.restoreHistory(opts.history.undo, opts.history.redo);

  const { canvas, overlay } = buildShell(root!, controller, {
    onFit: () => (controller.doc.view.workspace === 'repeat' ? fitRepeatView(controller, canvas, overlay) : fitView(controller, canvas, overlay)),
    onNewArtwork: () => {
      // The artwork being left is saved as it stands; a new one never overwrites it.
      session?.autosave.flush({ thumbnail: true });
      openFramePicker(root!, { dismissible: true, onChoose: (k) => armDrawFrame(k), onMyArtworks: () => void showMyArtworks() });
    },
    onMyArtworks: () => void showMyArtworks(),
    onSave: () => saveArtwork(),
    onSaveAsNew: () => saveAsNewArtwork(),
    onClearDrawing: () => {
      openConfirmSheet(root!, {
        title: 'Clear drawing?',
        body: 'Removes everything except the frame. Undo will bring it back.',
        confirmLabel: 'Clear drawing',
        onConfirm: () => {
          controller.commit((d) => clearDrawing(d));
          controller.setTool('select');
        },
      });
    },
    getView: () => getView(),
    onSwitchWorkspace: (ws) => {
      if (controller.doc.view.workspace === ws) return;
      // Phase 5 item 2: the frame only ever SUGGESTS a lattice, and only the very first time —
      // ensureRepeatDefaults() itself is idempotent (guarded by `family` already being set), so
      // check "was it already configured" first, purely to decide whether THIS entry deserves an
      // automatic Fit (a first look at the motif) or should leave the last Repeat view exactly
      // where the participant left it (item 12/18: Repeat's own viewport persists across visits).
      const firstEntry = ws === 'repeat' && controller.doc.repeat.family === undefined;
      controller.doc.view.workspace = ws;
      if (ws === 'repeat') {
        ensureRepeatDefaults(controller.doc);
        if (firstEntry) fitRepeatFirstEntry(controller, canvas, overlay);
      }
      controller.notify();
    },
  });
  // Phase 4: buildShell() clears `root` (`root.innerHTML = ''`) to rebuild the whole shell DOM
  // on every boot — a toast mounted before that point, as this used to be at module scope, ends
  // up appended then immediately detached, so showToast() would set text on an orphaned node no
  // one could ever see. Mounting it fresh after the shell exists keeps it alive for this boot.
  initToast(root!);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');

  function getView(): ViewTransform {
    const vs = controller.doc.view.workspace === 'repeat' ? controller.doc.repeatView : controller.doc.view;
    return { zoom: vs.zoom, pan: vs.pan, w: canvas.clientWidth, h: canvas.clientHeight };
  }

  new PointerManager(
    canvas,
    controller,
    getView,
    () => (controller.doc.view.workspace === 'repeat' ? repeatTool : (tools[controller.tool] ?? null)),
    () => (controller.doc.view.workspace === 'repeat' ? controller.doc.repeatView : controller.doc.view),
  );
  const autosave = attachAutosave(controller);

  if (import.meta.env.DEV) {
    (window as unknown as { __app: unknown }).__app = {
      controller,
      canvas,
      getView,
      resolvePoint: (id: string) => resolvePoint(controller.doc, id),
      pointScreen: (id: string) => worldToScreen(getView(), resolvePoint(controller.doc, id)),
    };
  }

  let dirty = true;
  const requestDraw = () => {
    dirty = true;
  };
  // subscribeView: catches both view-only changes (pinch/pan) and full state changes, so the
  // canvas redraws for either — but this loop never touches the DOM itself either way.
  controller.subscribeView(requestDraw);

  const stopResizing = setupCanvasDPR(canvas, ctx, () => {
    dirty = true;
  });
  if (opts.fitToScreen) fitView(controller, canvas, overlay);

  let running = true;
  function loop(): void {
    if (!running) return;
    if (dirty) {
      dirty = false;
      if (controller.doc.view.workspace === 'repeat') renderRepeat(ctx!, controller, getView());
      else render(ctx!, controller, getView());
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  session = {
    controller,
    autosave,
    teardown: () => {
      running = false;
      stopResizing();
      autosave.detach();
    },
  };
}

// ---- Phase 5.5 items 3–9: saved artworks ----

/** Save: the first time, the artwork gets a name; after that it simply writes (autosave keeps
 * writing to the same artwork in between). */
function saveArtwork(): void {
  const s = session;
  if (!s) return;
  const done = () => {
    s.autosave.flush({ thumbnail: true });
    showToast(`Saved “${s.controller.doc.name}”`);
  };
  if (s.controller.doc.named) return done();
  openNameSheet(root!, {
    title: 'Name this artwork',
    initial: '',
    confirmLabel: 'Save',
    onConfirm: (name) => {
      s.controller.doc.name = name;
      s.controller.doc.named = true;
      s.controller.notify();
      done();
    },
  });
}

/** Save as new: the current artwork (saved as it stands) is copied into a new artwork with its own
 * id and name, and that copy is what's open afterwards — the original is left exactly as it was. */
function saveAsNewArtwork(): void {
  const s = session;
  if (!s) return;
  openNameSheet(root!, {
    title: 'Save as new artwork',
    initial: s.controller.doc.named ? `${s.controller.doc.name} variant` : '',
    confirmLabel: 'Save',
    onConfirm: (name) => {
      s.autosave.flush({ thumbnail: true });
      const copy = structuredClone(s.controller.doc);
      const now = Date.now();
      copy.id = genId('doc');
      copy.name = name;
      copy.named = true;
      copy.createdAt = now;
      copy.updatedAt = now;
      boot(copy, { fitToScreen: false });
      showToast(`Saved as “${name}”`);
    },
  });
}

async function showMyArtworks(): Promise<void> {
  // Reachable with no artwork open too (from the first-launch frame picker).
  session?.autosave.flush({ thumbnail: true });
  const artworks = await listArtworks();
  if (artworks.length === 0) {
    showToast('No saved artworks yet');
    return;
  }
  openArtworksSheet(root!, {
    currentId: session?.controller.doc.id ?? '',
    artworks,
    onOpen: (id) => void openArtwork(id),
    onDelete: (id) => removeArtwork(id),
  });
}

/** Phase 5.6 items 15–16: deleting another artwork touches only that one. Deleting the open one
 * stops its autosave FIRST (so nothing can write it back), removes it, then opens the most recently
 * edited artwork left — or, with none left, the ordinary new-artwork frame picker. */
async function removeArtwork(id: string): Promise<void> {
  const deletingOpen = session?.controller.doc.id === id;
  if (deletingOpen) endSession();
  await deleteArtwork(id);
  if (!deletingOpen) return;
  const remaining = await listArtworks();
  for (const next of remaining) if (await openArtwork(next.id)) return;
  root!.innerHTML = '';
  openFramePicker(root!, { dismissible: false, onChoose: (k) => armDrawFrame(k), onMyArtworks: () => void showMyArtworks() });
}

/** Loads one saved artwork — its whole editable state, history included — and opens it. */
async function openArtwork(id: string): Promise<boolean> {
  const [docRecord, historyRecord] = await Promise.all([loadDocument(id), loadHistory(id)]);
  if (!docRecord || docRecord.schemaVersion !== 2 || !docRecord.snapshot) return false;
  upgradeSnapshot(docRecord.snapshot, docRecord.named);
  // Phase 5.4: Fills keyed by the old every-vertex region signature move to the new corner-based
  // one — for the document and every undo/redo snapshot alike.
  historyRecord?.undoStack.forEach(migrateLegacyFillKeys);
  historyRecord?.redoStack.forEach(migrateLegacyFillKeys);
  boot(docRecord.snapshot, {
    fitToScreen: false,
    history: historyRecord ? { undo: historyRecord.undoStack, redo: historyRecord.redoStack } : undefined,
  });
  return true;
}

/** Phase 1.1 item 1: arms the draw-frame gesture — the participant places, sizes and
 * orients the frame themselves, rather than receiving a pre-positioned one (§4.1 still
 * governs the resulting locked-frame metadata once it's built). */
function armDrawFrame(kind: FrameKind): void {
  endSession();
  const hud = buildDrawFrameHud(root!, kind, () => {
    openFramePicker(root!, { dismissible: false, onChoose: (k) => armDrawFrame(k), onMyArtworks: () => void showMyArtworks() });
  });
  attachDrawFrame(
    hud.canvas,
    kind,
    (result) => {
      const doc = createDoc(kind);
      placeFrame(doc, result.origin, result.radius, result.rotation);
      // The participant already placed, sized and oriented it on screen — keep that exact view.
      boot(doc, { fitToScreen: false });
    },
    hud.setHint,
  );
}

/** Brings a snapshot saved by any earlier version up to the current document shape. */
function upgradeSnapshot(doc: Doc, recordNamed: boolean | undefined): void {
  // Phase 3.4 item 5: snapshots saved before Point Targets replaced the old binary Point
  // Lock carry a `pointLock` boolean instead — translate it (locked ⟺ free=false) so a
  // restored document's targeting behaves exactly as it did before, not silently reset.
  if (!doc.pointTargets) {
    const legacy = doc as unknown as { pointLock?: boolean };
    const wasLocked = legacy.pointLock !== false; // undefined defaulted to true (Phase 1.2a)
    doc.pointTargets = { primary: true, derived: true, free: !wasLocked };
  }
  // Phase 3H: snapshots saved before Fair existed have no stroke default recorded.
  if (doc.fairDefaults === undefined) doc.fairDefaults = { colour: '#1E2A36', width: 2.5 };
  // Phase 3.7 item 10: snapshots saved before Divide remembered its last N.
  if (doc.dividePrefs === undefined) doc.dividePrefs = { lastN: 6 };
  // Phase 4 item 5: snapshots saved before Fill existed have no default colour recorded.
  if (doc.fillDefaults === undefined) doc.fillDefaults = { colour: '#1E3A6E', opacity: 1 };
  // Phase 5.2: fill opacity, and Circle/Arc's modes + shared remembered radius.
  if (doc.fillDefaults.opacity === undefined) doc.fillDefaults.opacity = 1;
  if (doc.toolPrefs === undefined) doc.toolPrefs = { circleMode: 'set', arcMode: 'measure', lastRadius: null };
  // Phase 5 item 18: snapshots saved before Repeat existed have no separate viewport/guide.
  if (doc.repeatView === undefined) doc.repeatView = { zoom: 1, pan: { x: 0, y: 0 } };
  // Phase 5.1 item 13: Phase 5's single Guide toggle becomes handles + motif boundary.
  if (doc.repeatDisplay === undefined) {
    const legacy = doc as unknown as { repeatGuide?: boolean };
    doc.repeatDisplay = defaultRepeatDisplay(legacy.repeatGuide !== false);
    delete legacy.repeatGuide;
  }
  // Phase 5.4: Fills keyed by the old every-vertex region signature move to the new one.
  migrateLegacyFillKeys(doc);
  // Phase 5.6: Space colouring's own next colour.
  if (doc.spaceDefaults === undefined) doc.spaceDefaults = { colour: '#B5502E', opacity: 1 };
  if (!(doc.repeat.gapFills instanceof Map)) doc.repeat.gapFills = new Map();
  // Phase 5.5: artworks saved before naming existed were never named by the participant.
  if (doc.named === undefined) doc.named = recordNamed ?? false;
}

async function launch(): Promise<void> {
  try {
    const lastId = await getMeta<string>('lastOpenDocId');
    if (lastId && (await openArtwork(lastId))) return;
  } catch (err) {
    // §9: "If the snapshot fails schema validation, fall back to..." — fall through to the
    // frame picker.
    console.warn('Restore failed, starting fresh:', err);
  }
  openFramePicker(root!, {
    dismissible: false,
    onChoose: (kind) => armDrawFrame(kind),
    onMyArtworks: () => void showMyArtworks(),
  });
}

void launch();
