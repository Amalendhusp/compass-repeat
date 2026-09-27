import type { Doc, EntityId, FaceSig, PointId, SegmentKey, SegmentState, Vec2 } from '../model/types.ts';
import type { PointDependent } from '../model/doc.ts';
import { cloneDoc } from '../model/doc.ts';
import { invalidatePointFacts } from '../geometry/usage.ts';
import type { PointRef } from '../interaction/pointref.ts';

/** Phase 5.2 item 1: Polygon is no longer a creation tool (connected Lines make any polygon);
 * existing polygon groups stay fully supported as data and as Select targets. */
export type ToolId = 'select' | 'circle' | 'line' | 'arc' | 'divide' | 'fair' | 'fill';

/** Tools implemented in this pass; the rest render in the dock but are inert (§ "do not attempt the entire app in one pass"). */
export const LIVE_TOOLS: ReadonlySet<ToolId> = new Set(['select', 'circle', 'line', 'arc', 'divide', 'fair', 'fill']);

export type PendingStep =
  | { kind: 'circle'; centre: PointRef }
  | { kind: 'line'; a: PointRef }
  // Phase 5.2 item 19 / Phase 5.6 items 1–7: Arc's compass — A chosen (Measure radius only), then
  // the open compass: its radius, where its centre sits now (carried point to point), and — when
  // measured — the A–B measuring line, shown until the arc is drawn. Never geometry or history.
  | { kind: 'arc'; stage: 'measure-b'; a: PointRef }
  | { kind: 'arc'; stage: 'compass'; radius: number; centre: PointRef; measure?: { a: Vec2; b: Vec2 }; capturedAt?: number }
  | null;

/** Phase 1.2 item 3 / Phase 2D: Select's target granularities — Point → Segment → whole Entity
 * or Group (a legacy Polygon's edges share one groupId, §2A — selected as one shape). */
/** Phase 3.6 item 4: `from`/`to` are the SelectableGroup's outer boundary points (a run of one or
 * more consecutive granular segments acting as one tappable/Fair-able unit — see
 * geometry/segments.ts), never a raw granular DerivedSegment's own endpoints. `keys` lists every
 * granular segment key the group actually spans, so an action (Trim, Fair toggle, stroke edit)
 * can apply itself to all of them atomically while segment STATE STORAGE stays keyed granularly. */
export type SelectCandidate =
  | { kind: 'point'; id: PointId }
  // Phase 5.10: `scope` says what a tap chose — one 'segment' (between the split points around the
  // tap) or its visually continuous 'run'. Absent for older/other sources (sweeps treat it as segment).
  | { kind: 'segment'; entityId: EntityId; from: PointId; to: PointId; fromParam: number; toParam: number; keys: SegmentKey[]; scope?: 'segment' | 'run' }
  | { kind: 'entity'; entityId: EntityId }
  | { kind: 'group'; groupId: string; entityIds: EntityId[] }
  // Phase 5.2 items 9–11: a closed region picked by tapping inside it — stands for its whole
  // boundary (`keys`), Fair or Construction, and (Fair only) the fill inside it.
  | { kind: 'region'; sig: FaceSig; fair: boolean; keys: SegmentKey[] };

/** Empty = nothing selected. Multiple entries = a drag across segments, or a long-press region set. */
export type Selection = SelectCandidate[];

export type Preview =
  | { kind: 'circle'; centre: Vec2; through: Vec2 }
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'measure'; a: Vec2; b: Vec2 }
  // Arc: the dashed compass circle, plus the swept arc once a sweep is under way.
  | { kind: 'arc'; centre: Vec2; radius: number; start?: number; sweep?: number }
  | null;

/** Phase 2H: the precision loupe (§5.4 / §2's press-then-slide). One tool gesture hands off to
 * this when the candidates at a tap are too close to pick reliably; the reticle then tracks the
 * finger at 1/4 speed and release commits to whichever candidate it's nearest. */
export interface PrecisionCandidate {
  ref: PointRef;
  at: Vec2; // world position
  /** Phase 5.9: what the location is (merged, e.g. "Centre · 2 intersections"), shown for the active one. */
  label?: string;
}
export interface PrecisionSession {
  candidates: PrecisionCandidate[];
  activeIndex: number;
  anchorWorld: Vec2; // world-space centroid of the candidate cluster — the loupe's magnification centre
  anchorScreen: Vec2; // the finger position precision mode opened at, for loupe placement + delta tracking
  reticleWorld: Vec2; // world-space reticle position; starts at anchorWorld, drifts at 1/4 finger speed
  lastFingerScreen: Vec2; // updated every move, to compute this sample's incremental delta
  /** Phase 5.9: the loupe (screen), its magnification and the screen point it magnifies. */
  loupe: { x: number; y: number; r: number; mag: number; centreScreen: Vec2 };
  /** One spread marker per candidate (screen, inside the loupe), and the finger's cursor there. */
  markers: Vec2[];
  cursor: Vec2;
  holdStart: Vec2;
  cursorStart: Vec2;
}

export interface ExtendChip {
  entityId: EntityId;
  expiresAt: number;
}

/** Phase 3.4 item 3: "Promote to Fair" — a lightweight one-tap shortcut shown right after a new
 * line commits, alongside (not instead of) the existing Extend chip. Internally identical to
 * tapping that same segment in the Fair tool; ignoring it just leaves the line as Construction/
 * Extension. Same shape/lifecycle as ExtendChip. */
export interface FairPromoteChip {
  entityId: EntityId;
  expiresAt: number;
}

/** Phase 3.5 item 3: "Merge into…" is armed, waiting for the next tap to pick a destination
 * point — Select's own gesture checks this first, ahead of its ordinary candidate logic. */
export interface PendingMerge {
  sourceId: PointId;
}

/** Phase 2C: what a Divide tap resolved to — a span of one curve (a segment, or a whole line/arc)
 * divided between its own endpoints, or a whole closed circle divided all the way round.
 * Phase 5.2 item 21: `scope` is where the tap-escalation cycle currently sits (segment → its
 * parent line/circle/arc); `label` is what the compact ribbon calls it. */
export type DivideTarget = { label: 'Segment' | 'Line' | 'Arc' | 'Circle'; scope: 'segment' | 'parent' } & (
  | { entityId: EntityId; kind: 'segment'; from: PointId; to: PointId; fromParam: number; toParam: number }
  | { entityId: EntityId; kind: 'circle-whole' }
);

/** Phase 2.1 item 1: Divide's live preview — recomputed on every stepper/slider change, read only
 * by the renderer, never recorded in history. */
export interface DividePreview {
  target: DivideTarget;
  points: Vec2[];
}

/** Phase 1.2 item 7: the point-visibility model. Geometry/snapping always sees every point —
 * this only controls what's drawn. */
export type PointVisibility = 'near-finger' | 'all' | 'used' | 'none';

/** Phase 3C/3D: a Fair trace in progress. `draft` overrides `doc.segmentStates` for rendering
 * only — a segment key mapped to `null` means "show as reverted to construction", mapped to a
 * SegmentState means "show as this" — real `doc.segmentStates` is untouched until release, so
 * the whole trace commits as one undo step. `preview` is the brass leader/runner-up candidate at
 * an as-yet-undecided junction (§4.7 step 5). `relevantPoints` (Phase 3.1 item 1/5) is the small
 * set of points worth keeping visible while this trace runs — the trace's own start/current
 * junction plus whatever the finger needs to read to choose the next branch — overriding the
 * global Points preference for the trace's duration only. */
export interface FairTraceState {
  draft: Map<SegmentKey, SegmentState | null>;
  preview: { leaderKey: SegmentKey; runnerUpKey: SegmentKey | null } | null;
  relevantPoints: Set<PointId>;
  /** Phase 5.9: an untouched circle a tap would Fair whole (it has no pieces to draft yet). */
  whole?: EntityId | null;
}

/** Phase 5.2 items 13–15: Select's point editing. `move` drags a hand-placed point freely;
 * `slide` moves an on-curve point along its own curve; `rebind` re-anchors one dependent
 * construction onto a different point (the selected point itself stays put). `chosen` is which
 * dependent is being re-anchored — preset when there is only one. `drag` is the live finger/snap
 * position while dragging (world space). */
export interface PointEditState {
  pointId: PointId;
  mode: 'move' | 'slide' | 'rebind';
  dependents: PointDependent[];
  chosen: PointDependent | null;
  drag: { at: Vec2; snapped: boolean } | null;
}

/**
 * Phase 3.1 item 2: the node inset — a true magnified view of the local geometry around a
 * candidate, replacing the old single-marker snap loupe. `activeAt` is the currently-chosen
 * candidate (drawn centred and highlighted); `candidates` are other nearby points worth showing
 * so the participant can see *which* junction they're about to commit to, not just that
 * something snapped. Used by every point-taking tool (Circle/Line/Arc, and Select's Move/Rebind
 * mode) and by Fair's trace junction scoring.
 */
export interface NodeInsetState {
  anchorScreen: Vec2; // finger position, for loupe placement away from it
  activeAt: Vec2; // world position of the chosen candidate — the magnification centre
  candidates: Vec2[]; // other nearby points, world space, excluding activeAt
  /** Smart Snap: what each point in the loupe is (Centre, Division point…) — the chosen one, and
   * whether the choice is currently too close to call. */
  labels?: { at: Vec2; label: string; active: boolean }[];
  ambiguous?: boolean;
}

/** Phase 5.8: a tap that landed on a curve where no point exists yet — said plainly instead of
 * quietly snapping to a neighbouring point. `divide` is set when the tap sat near the middle of a
 * segment: an optional shortcut to the ordinary Divide ÷2 of that segment. */
export interface NoPointHint {
  anchorScreen: Vec2;
  at: Vec2;
  divide: { label: 'Segment'; scope: 'segment'; entityId: EntityId; kind: 'segment'; from: PointId; to: PointId; fromParam: number; toParam: number } | null;
  midAt: Vec2 | null;
  until: number;
}

/** Phase 5.8: one complete Fair run a tap could mean — what "Which line?" offers, and what a
 * Fair preview shows before it is confirmed. `whole` marks an untouched circle (no pieces yet). */
export interface FairRun {
  label: string;
  detail: string;
  keys: SegmentKey[];
  draft: Map<SegmentKey, SegmentState | null>;
  fairing: boolean;
  whole: EntityId | null;
  /** World positions of the run's open ends (none for a closed loop). */
  ends: Vec2[];
  /** A world point on the run, near the tap, where its number badge is anchored. */
  badgeAt: Vec2;
}

export interface LineChoice {
  anchorScreen: Vec2;
  candidates: FairRun[];
  focus: number | null;
  resolve: (index: number | null) => void;
}

type Listener = () => void;

/** Phase 5.12a: what AppController.captureGestureState() records (see there). */
type GestureTransientKey =
  | 'pending'
  | 'selection'
  | 'extendChip'
  | 'fairPromoteChip'
  | 'pendingMerge'
  | 'preview'
  | 'nodeInset'
  | 'snapConfirm'
  | 'noPoint'
  | 'pressHighlight'
  | 'lineChoice'
  | 'cue'
  | 'focusWorld'
  | 'sweep'
  | 'multiRegion'
  | 'pointEdit'
  | 'divide'
  | 'precision'
  | 'dividePreview'
  | 'recentPoints'
  | 'fairTrace'
  | 'fillPreview'
  | 'fillDiagnostic'
  | 'repeatDrag'
  | 'repeatContactFlash'
  | 'repeatRotateDrag';
export interface GestureSnapshot {
  doc: Doc;
  undo: Doc[];
  redo: Doc[];
  transient: Pick<AppController, GestureTransientKey>;
}

export class AppController {
  doc: Doc;
  tool: ToolId = 'select';
  pending: PendingStep = null;
  selection: Selection = [];
  extendChip: ExtendChip | null = null;
  fairPromoteChip: FairPromoteChip | null = null;
  pendingMerge: PendingMerge | null = null;
  /** Live drag preview, read by the renderer; never recorded in history (§8). */
  preview: Preview = null;
  /** Phase 1.1 item 4 / Phase 3.1 item 2: an offset, magnified view of the current snap target
   * and its local geometry, away from the fingertip that's occluding it. Set by the active
   * tool's onMove, null when nothing is snapped. */
  nodeInset: NodeInsetState | null = null;
  /** Smart Snap: the brief label shown on the point just used (Phase 5.9: with an optional hint
   * line, e.g. after a tap in a crowded spot). */
  snapConfirm: { at: Vec2; label: string; hint?: string; until: number } | null = null;
  /** Phase 5.8/5.9: "No point here yet" feedback; the advanced "Which line?" chooser (Fair
   * long-press only); a brief canvas cue such as "Trace the line you want". Never history. */
  noPoint: NoPointHint | null = null;
  /** Phase 5.10: the segment under a finger that is still down (Select) — emphasised before release. */
  pressHighlight: SegmentKey[] | null = null;
  lineChoice: LineChoice | null = null;
  cue: { at: Vec2; text: string; until: number } | null = null;
  /** Phase 3.4 item 2: Line's own creation mode — every new line commits as either a finite
   * Construction line or a through-both-points Extension line (spec's extension-line logic,
   * dashed/subdued). Sticky across gestures, like Fair's old stroke default was. */
  lineMode: 'construction' | 'extension' = 'construction';
  /** Phase 5.6 item 19: Repeat's Space action — while on, a one-finger tap colours negative-space
   * classes instead of reaching the lattice handles. Session state, never saved. */
  spaceMode = false;
  /** Mobile performance: true while two fingers pan/zoom — renderers may draw a lighter version and
   * restore full quality on release. Session state only. */
  viewGesture = false;
  /** Focus construction: the beginner display mode (fade construction far from the current work),
   * and where the work is — updated from the finger and the pending anchor. */
  focusConstruction = (() => {
    try {
      return localStorage.getItem('cr.focusConstruction') === '1';
    } catch {
      return false;
    }
  })();
  focusWorld: Vec2 | null = null;
  pointVisibility: PointVisibility = 'near-finger';
  /** Screen position of the single active pointer, for "near finger" reveal; null when no
   * pointer is down. Updated by PointerManager, read by the renderer only. */
  pointerScreenPos: Vec2 | null = null;
  /** Phase 5.2 item 12: the finger's path while a drag collects segments, for a faint trail. */
  sweep: Vec2[] | null = null;
  /** Phase 5.2 item 11: non-null while a long-press has started collecting regions of one type. */
  multiRegion: { fair: boolean } | null = null;
  pointEdit: PointEditState | null = null;
  /** Phase 5.2 item 21: the current Divide target and N, shown in the compact ribbon. */
  divide: { target: DivideTarget; n: number } | null = null;
  /** Phase 1.2a: true while the active tool's current touch is over a curve that Point Lock is
   * blocking from becoming a point — drives the "Point Lock · choose an existing point" hint. */
  pointLockHint = false;
  /** Phase 2H: non-null while the precision loupe is open. */
  precision: PrecisionSession | null = null;
  /** Phase 2.1 item 1: non-null while the compact Divide sheet is open, updated live as the
   * slider/stepper/connector change — read only by the renderer. */
  dividePreview: DividePreview | null = null;
  /** Phase 2.1 item 2: points to flash in temporary Signal feedback regardless of the current
   * Points-shown rule (e.g. right after Divide commits), and until when. Cleared automatically
   * by the next committed action (see commit()) or after its own timeout, whichever is first. */
  recentPoints: { ids: Set<PointId> } | null = null;
  /** Phase 3C/3D: non-null while a Fair tap/trace gesture is in progress. */
  fairTrace: FairTraceState | null = null;
  /** Phase 4 item 2/6: non-null while a Fill tap is held down on a resolvable region — a
   * translucent preview only, cleared on release either way (commit happens separately). */
  fillPreview: { sig: FaceSig; colour: string } | null = null;
  /** Phase 5.4 items 5–8: after an "Open boundary" Fill tap — the Fair chain that fails to close
   * and its likely open ends, shown briefly. Interaction feedback only: never part of the doc. */
  fillDiagnostic: { keys: SegmentKey[]; endpoints: PointId[]; until: number } | null = null;
  private diagnosticTimer: ReturnType<typeof setInterval> | null = null;
  /** Phase 5 item 4/6: non-null while a lattice-arm handle is being dragged. Phase 5.1: `translate`
   * is what is shown (finger position after magnetic attraction/hysteresis snapping), and exactly
   * what gets committed on release; `snapped` says whether it currently sits on a contact detent. */
  repeatDrag: { dir: 'a' | 'b'; translate: Vec2; snapped: boolean } | null = null;
  repeatContactFlash: { label: string } | null = null;
  /** Phase 5 item 7: non-null while the rotation ring is being dragged — same draft/commit split
   * as `repeatDrag`. */
  repeatRotateDrag: { rawRotation: number } | null = null;

  private undoStack: Doc[] = [];
  private redoStack: Doc[] = [];
  private listeners = new Set<Listener>();
  /** Cheap channel for view-only (pan/zoom) changes — redraw + autosave-debounce only, never
   * the dock/context-bar DOM rebuild (Phase 1.1 item 2: that rebuild was the real-device stagger). */
  private viewListeners = new Set<Listener>();

  constructor(doc: Doc) {
    this.doc = doc;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Subscribes to view-only changes too (a superset is delivered here: both notify() and notifyView() reach it). */
  subscribeView(fn: Listener): () => void {
    this.viewListeners.add(fn);
    return () => this.viewListeners.delete(fn);
  }

  notify(): void {
    for (const fn of this.listeners) fn();
    for (const fn of this.viewListeners) fn();
  }

  /** Pan/zoom only — skips the (relatively expensive) full-state listeners such as the shell's
   * context-bar/dock DOM rebuild, which don't depend on the view transform at all. */
  notifyView(): void {
    for (const fn of this.viewListeners) fn();
  }

  /** Applies a mutation as one undo step (spec §8: every committed action is one entry).
   * Phase 2.1 item 2: any new committed action retires the previous action's "recent points"
   * feedback — the caller re-arms it afterward via setRecentPoints() if this commit is the one
   * that should show it. */
  commit(mutate: (doc: Doc) => void): void {
    this.recentPoints = null;
    this.clearFillDiagnostic();
    const before = cloneDoc(this.doc);
    const next = cloneDoc(this.doc);
    mutate(next);
    // Phase 5.11: point facts read while `mutate` was still editing `next` (a Trim can change a
    // segment's state without changing any count the cache guards on) are dropped here, so the
    // committed document always derives them fresh.
    invalidatePointFacts(next);
    next.updatedAt = Date.now();
    this.undoStack.push(before);
    this.redoStack = [];
    this.doc = next;
    this.notify();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** For persistence (§9): a snapshot of both stacks, newest-last, as committed. */
  getHistorySnapshot(): { undo: Doc[]; redo: Doc[] } {
    return { undo: this.undoStack.slice(), redo: this.redoStack.slice() };
  }

  /** For persistence restore: replaces both stacks wholesale (does not itself notify). */
  restoreHistory(undo: Doc[], redo: Doc[]): void {
    this.undoStack = undo.slice();
    this.redoStack = redo.slice();
  }

  /** Phase 5.12a: everything one single-finger gesture can change — the document and its history
   * (a gesture only ever edits through commit()) and every transient tool, selection and feedback
   * state — taken at pointerdown so a pointercancel can abandon the gesture without a trace. */
  captureGestureState(): GestureSnapshot {
    return {
      doc: this.doc,
      undo: this.undoStack.slice(),
      redo: this.redoStack.slice(),
      transient: {
        pending: this.pending,
        selection: this.selection,
        extendChip: this.extendChip,
        fairPromoteChip: this.fairPromoteChip,
        pendingMerge: this.pendingMerge,
        preview: this.preview,
        nodeInset: this.nodeInset,
        snapConfirm: this.snapConfirm,
        noPoint: this.noPoint,
        pressHighlight: this.pressHighlight,
        lineChoice: this.lineChoice,
        cue: this.cue,
        focusWorld: this.focusWorld,
        sweep: this.sweep,
        multiRegion: this.multiRegion,
        pointEdit: this.pointEdit,
        divide: this.divide,
        precision: this.precision,
        dividePreview: this.dividePreview,
        recentPoints: this.recentPoints,
        fairTrace: this.fairTrace,
        fillPreview: this.fillPreview,
        fillDiagnostic: this.fillDiagnostic,
        repeatDrag: this.repeatDrag,
        repeatContactFlash: this.repeatContactFlash,
        repeatRotateDrag: this.repeatRotateDrag,
      },
    };
  }

  /** Puts back a captureGestureState() snapshot. A commit made during the gesture is dropped like
   * an undo (camera and preferences stay live — see swapTo), and the history is restored exactly,
   * so no undo or redo entry is gained or lost. */
  restoreGestureState(snapshot: GestureSnapshot): void {
    if (this.doc !== snapshot.doc) this.swapTo(snapshot.doc);
    this.undoStack = snapshot.undo;
    this.redoStack = snapshot.redo;
    Object.assign(this, snapshot.transient);
    this.notify();
  }

  /** Phase 3.6 item 2: `view` (zoom/pan) rides inside every snapshot for cloning convenience, but
   * it is a camera preference, not document history — undo/redo must revert geometry while
   * leaving the participant's current zoom/pan exactly where they left it. Carry the live view
   * across the swap rather than restoring the one baked into the popped snapshot. */
  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.doc);
    this.swapTo(prev);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.doc);
    this.swapTo(next);
  }

  /** Camera and Repeat display preferences are not history — carry the live ones across. */
  private swapTo(snapshot: Doc): void {
    const { view, repeatView, repeatDisplay, toolPrefs, dividePrefs, fillDefaults, fairDefaults, pointTargets, name, named, spaceDefaults } = this.doc;
    this.doc = snapshot;
    // The artwork's name is not history either (Phase 5.5).
    this.doc.name = name;
    this.doc.named = named;
    this.doc.view = view;
    this.doc.repeatView = repeatView;
    this.doc.repeatDisplay = repeatDisplay;
    // Tool preferences aren't history either (Phase 5.2: the remembered radius/N survive undo).
    this.doc.toolPrefs = toolPrefs;
    this.doc.dividePrefs = dividePrefs;
    this.doc.fillDefaults = fillDefaults;
    this.doc.fairDefaults = fairDefaults;
    this.doc.pointTargets = pointTargets;
    this.doc.spaceDefaults = spaceDefaults;
    this.pending = null;
    this.pointEdit = null;
    this.divide = null;
    this.dividePreview = null;
    this.lineChoice = null;
    this.notify();
  }

  static readonly FILL_DIAGNOSTIC_MS = 1800;

  /** Shows the open-boundary diagnosis for ~1.8s (fading at the end), or until the next touch. */
  showFillDiagnostic(diag: { keys: SegmentKey[]; endpoints: PointId[] }): void {
    this.clearFillDiagnostic();
    this.fillDiagnostic = { ...diag, until: Date.now() + AppController.FILL_DIAGNOSTIC_MS };
    // Redraw steadily only so the fade-out is smooth; stops the moment it ends.
    this.diagnosticTimer = setInterval(() => {
      if (!this.fillDiagnostic || Date.now() >= this.fillDiagnostic.until) this.clearFillDiagnostic();
      this.notifyView();
    }, 60);
    this.notifyView();
  }

  clearFillDiagnostic(): void {
    if (this.diagnosticTimer !== null) clearInterval(this.diagnosticTimer);
    this.diagnosticTimer = null;
    if (!this.fillDiagnostic) return;
    this.fillDiagnostic = null;
    this.notifyView();
  }

  /** Phase 5.1 item 1: a brief label on first reaching a contact — never left on screen. */
  flashRepeatContact(label: string): void {
    const record = { label };
    this.repeatContactFlash = record;
    this.notifyView();
    setTimeout(() => {
      if (this.repeatContactFlash === record) {
        this.repeatContactFlash = null;
        this.notifyView();
      }
    }, 1100);
  }

  /** §1.3: tapping the lit tool, or Select, returns to Select. */
  setTool(tool: ToolId): void {
    if (!LIVE_TOOLS.has(tool)) return;
    this.lineChoice = null;
    this.noPoint = null;
    this.cue = null;
    this.pressHighlight = null;
    this.pending = null;
    this.preview = null;
    this.nodeInset = null;
    this.extendChip = null;
    this.fairPromoteChip = null;
    this.pendingMerge = null;
    this.pointLockHint = false;
    this.precision = null;
    this.divide = null;
    this.dividePreview = null;
    this.fairTrace = null;
    this.fillPreview = null;
    this.sweep = null;
    this.multiRegion = null;
    this.pointEdit = null;
    this.clearFillDiagnostic();
    this.tool = tool === this.tool || tool === 'select' ? 'select' : tool;
    if (this.tool !== 'select') this.selection = [];
    this.notify();
  }

  cancelPending(): void {
    if (!this.pending && !this.preview) return;
    this.pending = null;
    this.preview = null;
    this.nodeInset = null;
    this.pointLockHint = false;
    this.precision = null;
    this.notify();
  }

  /** Phase 2.1 item 2: flashes `ids` in Signal feedback for ~2.5s, or until the next committed
   * action retires it first (see commit()). */
  setRecentPoints(ids: PointId[]): void {
    const record = { ids: new Set(ids) };
    this.recentPoints = record;
    this.notifyView();
    setTimeout(() => {
      if (this.recentPoints === record) {
        this.recentPoints = null;
        this.notifyView();
      }
    }, 2500);
  }

  select(sel: Selection): void {
    this.selection = sel;
    this.notify();
  }

  setExtendChip(entityId: EntityId | null): void {
    this.extendChip = entityId ? { entityId, expiresAt: Date.now() + 4000 } : null;
    this.notify();
  }

  setFairPromoteChip(entityId: EntityId | null): void {
    this.fairPromoteChip = entityId ? { entityId, expiresAt: Date.now() + 4000 } : null;
    this.notify();
  }

  /** Phase 3.4 item 5: a document preference, so it's not undo-tracked — like `view`. Replaces
   * the old binary togglePointLock(). */
  setPointTarget(category: keyof Doc['pointTargets'], value: boolean): void {
    this.doc.pointTargets[category] = value;
    this.notify();
  }
}

export interface ViewTransform {
  zoom: number;
  pan: Vec2;
  w: number;
  h: number;
}

export function worldToScreen(v: ViewTransform, p: Vec2): Vec2 {
  return { x: (p.x + v.pan.x) * v.zoom + v.w / 2, y: (p.y + v.pan.y) * v.zoom + v.h / 2 };
}

export function screenToWorld(v: ViewTransform, p: Vec2): Vec2 {
  return { x: (p.x - v.w / 2) / v.zoom - v.pan.x, y: (p.y - v.h / 2) / v.zoom - v.pan.y };
}
