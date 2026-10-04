import './style.css';
import { cloneDoc, createDoc, defaultRepeatDisplay, placeFrame } from './model/doc.ts';
import { AppController, type ToolId, type ViewTransform } from './app/controller.ts';
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
import { buildShell, closeAnyPopover } from './ui/shell.ts';
import { openGuide, type CoachHost } from './tutorial/engine.ts';
import { beginnerGuide } from './tutorial/guides/beginner.ts';
import { openStartScreen, type CardActions } from './ui/startscreen.ts';
import { buildDrawFrameHud } from './ui/drawframehud.ts';
import { attachDrawFrame } from './interaction/drawframe.ts';
import { initToast } from './ui/toast.ts';
import type { Doc, FrameKind } from './model/types.ts';
import { resolvePoint } from './geometry/kernel.ts';
import { worldToScreen } from './app/controller.ts';
import { attachAutosave, type AutosaveHandle } from './persist/autosave.ts';
import { attachProcessRecorder, type ProcessHandle } from './persist/processRecorder.ts';
import { copyProcess, enqueue, listProcesses, loadEvents, loadMeta } from './persist/processStore.ts';
import { replayProcess, stateAt } from './persist/processReplay.ts';
import { captureState, stateHash, stateToDoc } from './persist/processState.ts';
import { makeThumbnail } from './persist/thumbnail.ts';
import { deleteArtwork, getMeta, listArtworks, loadDocument, loadHistory, saveDocument, setMeta, type ArtworkSummary } from './persist/db.ts';
import { openNameSheet } from './ui/artworks.ts';
import { openConfirmSheet } from './ui/confirmsheet.ts';
import { showToast } from './ui/toast.ts';
import { genId } from './model/id.ts';
import { setupCanvasDPR } from './render/canvasSetup.ts';
import { attachDiagnostics } from './ui/diagnostics.ts';
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
let session: { controller: AppController; autosave: AutosaveHandle; process: ProcessHandle | null; getView: () => ViewTransform; fit: () => void; teardown: () => void } | null = null;

/** Phase 5.7: the draw-frame gesture's own listeners and render loop, while it's armed. */
let detachFrameDrawing: (() => void) | null = null;

function endSession(): void {
  session?.teardown();
  session = null;
  detachFrameDrawing?.();
  detachFrameDrawing = null;
}

/** Phase 5.7 / vNext Phase 3: while the Beginner Guide runs, the artwork shown is a throwaway
 * practice artwork — never autosaved, never listed, never the "last open" artwork. What was open
 * before is saved as it stands on entry and reopened, untouched, when the guide closes. */
let guideReturn: { artworkId: string | null } | null = null;
const inertAutosave: AutosaveHandle = { detach: () => {}, flush: () => {} };

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
  // vNext Phase 3: while the Beginner Guide's strip sits over the top of the canvas, fit below it.
  const strip = document.querySelector('.coach-strip.at-top')?.getBoundingClientRect();
  const usableTop = strip ? Math.min(Math.max(strip.bottom + 8 - canvasRect.top, 0), usableBottom * 0.5) : 0;
  const usableW = canvasW;
  const usableH = Math.min(Math.max(usableBottom - usableTop, canvasH * 0.25), canvasH);

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
    y: (usableTop + usableH / 2 - canvasH / 2) / zoom - centre.y,
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
const KEY_ZOOM_STEP = 1.25;

function boot(doc: Doc, opts: { fitToScreen: boolean; history?: { undo: Doc[]; redo: Doc[] }; fresh?: boolean }): void {
  endSession();
  const controller = new AppController(doc);
  // §9 restore: "the tool reset to Select" — AppController already defaults tool to 'select'.
  if (opts.history) controller.restoreHistory(opts.history.undo, opts.history.redo);

  const fit = () => (controller.doc.view.workspace === 'repeat' ? fitRepeatView(controller, canvas, overlay) : fitView(controller, canvas, overlay));
  const { canvas, overlay } = buildShell(root!, controller, {
    onFit: () => fit(),
    onNew: () => showStart('frames'),
    onOpen: () => showStart('artworks'),
    onSave: () => saveArtwork(),
    onSaveAs: () => saveAsNewArtwork(),
    getView: () => getView(),
    // vNext Phase 4B: Timelapse reads the history after every change so far is recorded.
    timelapse: guideReturn
      ? null
      : {
          prepare: async () => {
            process?.flush();
            await enqueue(async () => {});
          },
        },
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
  // vNext Phase 3: the practice artwork has no file menu — nothing in it is saved, and the guide's
  // own Exit is the way back.
  if (guideReturn) root!.querySelector<HTMLElement>('[aria-label="Menu"]')?.style.setProperty('visibility', 'hidden');
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

  const pointer = new PointerManager(
    canvas,
    controller,
    getView,
    () => (controller.doc.view.workspace === 'repeat' ? repeatTool : (tools[controller.tool] ?? null)),
    () => (controller.doc.view.workspace === 'repeat' ? controller.doc.repeatView : controller.doc.view),
  );
  const autosave = guideReturn ? inertAutosave : attachAutosave(controller);
  // vNext Phase 4A: the artwork's process history — never for the Beginner Guide's practice artwork.
  // A brand-new artwork's history starts at its frame; an existing one at its first real change.
  const process = guideReturn ? null : attachProcessRecorder(controller, { fresh: opts.fresh === true });

  if (import.meta.env.DEV) {
    (window as unknown as { __app: unknown }).__app = {
      controller,
      canvas,
      getView,
      resolvePoint: (id: string) => resolvePoint(controller.doc, id),
      pointScreen: (id: string) => worldToScreen(getView(), resolvePoint(controller.doc, id)),
    };
  }

  // Mobile performance: frames are drawn only when something changed — an idle drawing costs no
  // CPU at all — and never while the page is hidden (a backgrounded tab, a locked phone).
  let running = true;
  let dirty = true;
  let scheduled = false;
  const diagnostics = attachDiagnostics(controller, canvas);
  function frame(): void {
    scheduled = false;
    if (!running || !dirty || document.hidden) return;
    dirty = false;
    const t0 = performance.now();
    let copies: number | null = null;
    if (controller.doc.view.workspace === 'repeat') copies = renderRepeat(ctx!, controller, getView());
    else render(ctx!, controller, getView());
    diagnostics?.record(performance.now() - t0, copies);
  }
  const requestDraw = () => {
    dirty = true;
    if (!scheduled && running && !document.hidden) {
      scheduled = true;
      requestAnimationFrame(frame);
    }
  };
  // subscribeView: catches both view-only changes (pinch/pan) and full state changes, so the
  // canvas redraws for either — but this loop never touches the DOM itself either way.
  controller.subscribeView(requestDraw);
  const onVisibility = () => {
    if (!document.hidden && dirty && !scheduled && running) {
      scheduled = true;
      requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // Phase 5.12c: keyboard zoom for desktop — + / − about the canvas centre, 0 = Fit. Plain keys
  // only (⌘/Ctrl + keeps the browser's own meaning), and never while typing into a field.
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.start-screen')) return; // the artwork is covered — leave it be
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const centre = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
    if (e.key === '+' || e.key === '=') pointer.zoomAt(centre, KEY_ZOOM_STEP);
    else if (e.key === '-' || e.key === '_' || e.key === '\u2212') pointer.zoomAt(centre, 1 / KEY_ZOOM_STEP);
    else if (e.key === '0') controller.doc.view.workspace === 'repeat' ? fitRepeatView(controller, canvas, overlay) : fitView(controller, canvas, overlay);
    else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);

  const stopResizing = setupCanvasDPR(canvas, ctx, requestDraw);
  if (opts.fitToScreen) fitView(controller, canvas, overlay);
  requestDraw();

  session = {
    controller,
    autosave,
    process,
    getView,
    fit,
    teardown: () => {
      running = false;
      stopResizing();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('keydown', onKey);
      diagnostics?.detach();
      autosave.detach();
      process?.detach();
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

/** A new, independent artwork with the same content as `doc`: its own id, the given name, and
 * created/edited now. Shared by Save As and My Artworks' Duplicate. */
function asNewArtwork(doc: Doc, name: string): Doc {
  const copy = structuredClone(doc);
  const now = Date.now();
  copy.id = genId('doc');
  copy.name = name;
  copy.named = true;
  copy.createdAt = now;
  copy.updatedAt = now;
  return copy;
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
      const copy = asNewArtwork(s.controller.doc, name);
      // vNext Phase 4A: the copy carries the process so far, then continues on its own.
      s.process?.flush();
      void copyProcess(s.controller.doc.id, copy.id);
      boot(copy, { fitToScreen: false });
      showToast(`Saved as “${name}”`);
    },
  });
}

// ---- vNext Phase 2: the Start screen (Choose a frame · Beginner Guide · My Artworks) ----

/** New opens the Start screen at its frames, Open… at My Artworks. The artwork that was open is
 * saved as it stands first — so its card is up to date, and nothing chosen next can overwrite it —
 * and stays open underneath until something else is actually chosen. */
function showStart(focus: 'frames' | 'artworks'): void {
  closeAnyPopover();
  session?.autosave.flush({ thumbnail: true });
  openStartScreen(root!, {
    focus,
    dismissible: session !== null,
    currentId: session?.controller.doc.id ?? null,
    loadArtworks: () =>
      listArtworks().catch((err) => {
        console.warn('Listing artworks failed:', err);
        return [];
      }),
    actions: cardActions,
    guide: { onStart: () => startGuide() },
    onChooseFrame: (k) => armDrawFrame(k),
    onOpenArtwork: (id) => void openFromStart(id),
  });
}

// ---- Patch: My Artworks card actions (⋮ → Rename / Duplicate / Delete) ----

const displayName = (a: { name: string; named: boolean }) => (a.named ? a.name : 'Untitled');

const cardActions: CardActions = {
  rename(a, done) {
    openNameSheet(root!, {
      title: 'Rename artwork',
      initial: a.named ? a.name : '',
      confirmLabel: 'Rename',
      onConfirm: (name) => void renameArtwork(a.id, name).then(done),
    });
  },
  duplicate(a, done) {
    void duplicateArtwork(a).then((name) => {
      if (name) showToast(`Duplicated as “${name}”`);
      done();
    });
  },
  remove(a, done) {
    openConfirmSheet(root!, {
      title: `Delete “${displayName(a)}”?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      onConfirm: () => void deleteFromStart(a.id).then(done),
    });
  },
};

/** Rename touches only the name: same id, geometry, thumbnail, last-edited time, Undo/Redo and
 * process history (a name is not part of the recorded artwork, so no process moment either). */
async function renameArtwork(id: string, name: string): Promise<void> {
  const s = session;
  if (s && s.controller.doc.id === id) {
    // The open artwork: rename the live document, or its own autosave would write the old name back.
    s.controller.doc.name = name;
    s.controller.doc.named = true;
    s.controller.notify();
    s.autosave.flush();
    return;
  }
  const record = await loadDocument(id);
  if (!record?.snapshot) return;
  await saveDocument({ ...record, name, named: true, snapshot: { ...record.snapshot, name, named: true } });
}

/** Duplicate works like Save As — the same copy, the same history copy — but from My Artworks, so
 * the copy is listed rather than opened (Save As opens its copy because it's saving the work in
 * hand). Like Save As, the copy starts with no Undo/Redo of its own. Returns the copy's name. */
async function duplicateArtwork(a: ArtworkSummary): Promise<string | null> {
  const s = session;
  if (s && s.controller.doc.id === a.id) {
    // The open artwork: copy it as it stands right now, thumbnail and process included.
    s.autosave.flush({ thumbnail: true });
    s.process?.flush();
  }
  const record = await loadDocument(a.id);
  if (!record?.snapshot) return null;
  const taken = new Set((await listArtworks()).map(displayName));
  const base = `${displayName(a)} copy`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  const copy = asNewArtwork(record.snapshot, name);
  await copyProcess(a.id, copy.id);
  await saveDocument({ id: copy.id, name, named: true, createdAt: copy.createdAt, updatedAt: copy.updatedAt, schemaVersion: record.schemaVersion, thumbnail: record.thumbnail, snapshot: copy });
  return name;
}

/** Delete, after confirmation: the artwork, its Undo history and its process history. Deleting the
 * artwork that's open closes it first — so nothing can save it again — and leaves the Start screen,
 * with nothing open and no last-opened artwork to come back to. */
async function deleteFromStart(id: string): Promise<void> {
  const wasOpen = session?.controller.doc.id === id;
  if (wasOpen) {
    closeAnyPopover();
    endSession();
  }
  await deleteArtwork(id);
  await enqueue(async () => {}); // its process history is removed through the same queue
  if ((await getMeta<string>('lastOpenDocId')) === id) await setMeta('lastOpenDocId', null);
  if (wasOpen) {
    root!.innerHTML = '';
    showStart('artworks');
  }
}

async function openFromStart(id: string): Promise<void> {
  if (await openArtwork(id)) return;
  showToast('That artwork could not be opened');
  if (!session) showStart('artworks');
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
  const hud = buildDrawFrameHud(root!, kind, () => showStart('frames'));
  detachFrameDrawing = attachDrawFrame(
    hud.canvas,
    kind,
    (result) => {
      const doc = createDoc(kind);
      placeFrame(doc, result.origin, result.radius, result.rotation);
      // The participant already placed, sized and oriented it on screen — keep that exact view.
      boot(doc, { fitToScreen: false, fresh: true });
    },
    hud.setHint,
  );
}

// ---- vNext Phase 3: the Beginner Guide's host — the only door the guide has into the app ----

/** Opens a practice state: never saved (guideReturn is set), points all shown so a first-timer can
 * see what there is to start from. */
function bootPractice(doc: Doc, history?: { undo: Doc[]; redo: Doc[] }, tool?: ToolId): void {
  boot(doc, { fitToScreen: false, history });
  const c = session!.controller;
  c.pointVisibility = 'all';
  if (tool) c.tool = tool;
  c.notify();
}

const guideHost: CoachHost = {
  begin(doc) {
    closeAnyPopover();
    session?.autosave.flush({ thumbnail: true });
    guideReturn = { artworkId: session?.controller.doc.id ?? null };
    bootPractice(doc);
  },
  fit: () => session?.fit(),
  capture() {
    if (!session) return null;
    const c = session.controller;
    const { undo, redo } = c.getHistorySnapshot();
    return { doc: cloneDoc(c.doc), undo, redo, tool: c.tool };
  },
  restore(state) {
    closeAnyPopover();
    bootPractice(cloneDoc(state.doc), { undo: state.undo, redo: state.redo }, state.tool);
  },
  async exit() {
    const back = guideReturn;
    guideReturn = null;
    closeAnyPopover();
    endSession();
    root!.innerHTML = '';
    const reopened = back?.artworkId ? await openArtwork(back.artworkId) : false;
    if (!reopened) showStart('frames');
  },
  controller: () => session?.controller ?? null,
  view: () => session?.getView() ?? null,
};

function startGuide(): void {
  if (guideReturn) return;
  openGuide(beginnerGuide, guideHost);
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

// vNext Phase 4A: development/test access to process histories (no user-facing playback yet).
if (import.meta.env.DEV) {
  (window as unknown as { __process: unknown }).__process = {
    meta: loadMeta,
    events: loadEvents,
    list: listProcesses,
    replay: replayProcess,
    stateAt,
    capture: captureState,
    hash: stateHash,
    toDoc: stateToDoc,
    thumbnail: makeThumbnail,
    current: () => session?.controller.doc ?? null,
    controller: () => session?.controller ?? null,
    view: () => session?.getView() ?? null,
  };
}

async function launch(): Promise<void> {
  try {
    const lastId = await getMeta<string>('lastOpenDocId');
    if (lastId && (await openArtwork(lastId))) return;
  } catch (err) {
    // §9: "If the snapshot fails schema validation, fall back to..." — fall through to the
    // Start screen.
    console.warn('Restore failed, starting fresh:', err);
  }
  showStart('frames');
}

void launch();
