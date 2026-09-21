import type { Doc, EntityId, FaceSig, PointId, SegmentKey, SegmentState, Vec2 } from '../model/types.ts';
import { cloneDoc } from '../model/doc.ts';
import type { PointRef } from '../interaction/pointref.ts';

export type ToolId = 'select' | 'circle' | 'line' | 'polygon' | 'divide' | 'fair' | 'fill';

/** Tools implemented in this pass; the rest render in the dock but are inert (§ "do not attempt the entire app in one pass"). */
export const LIVE_TOOLS: ReadonlySet<ToolId> = new Set(['select', 'circle', 'line', 'polygon', 'divide', 'fair', 'fill']);

export type PendingStep =
  | { kind: 'circle'; centre: PointRef }
  | { kind: 'line'; a: PointRef }
  // vertices: every committed vertex so far, oldest first (§2A).
  | { kind: 'polygon'; vertices: PointRef[] }
  | null;

/** Phase 1.2 item 3 / Phase 2D: Select's target granularities — Point → Segment → whole Entity
 * or Group (a completed Polygon's edges share one groupId, §2A — selected as one shape, not N
 * unrelated lines). Region is a later phase, once Fill exists. A completed tap cycles through
 * whichever of these exist at that location. */
/** Phase 3.6 item 4: `from`/`to` are the SelectableGroup's outer boundary points (a run of one or
 * more consecutive granular segments acting as one tappable/Fair-able unit — see
 * geometry/segments.ts), never a raw granular DerivedSegment's own endpoints. `keys` lists every
 * granular segment key the group actually spans, so an action (Trim, Fair toggle, stroke edit)
 * can apply itself to all of them atomically while segment STATE STORAGE stays keyed granularly. */
/** Phase 4 item 8: an already-filled region, selected by its FaceSig — Select edits/removes an
 * existing fill; it never creates one (that's Fill's own job). */
export type SelectCandidate =
  | { kind: 'point'; id: PointId }
  | { kind: 'segment'; entityId: EntityId; from: PointId; to: PointId; fromParam: number; toParam: number; keys: SegmentKey[] }
  | { kind: 'entity'; entityId: EntityId }
  | { kind: 'group'; groupId: string; entityIds: EntityId[] }
  | { kind: 'fill'; sig: FaceSig };

/** Empty = nothing selected. Multiple entries = a marquee or ⇧-style multi-select (item 4). */
export type Selection = SelectCandidate[];

export type Preview =
  | { kind: 'circle'; centre: Vec2; through: Vec2 }
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'polygon'; vertices: Vec2[]; current: Vec2 }
  | null;

/** Phase 2H: the precision loupe (§5.4 / §2's press-then-slide). One tool gesture hands off to
 * this when the candidates at a tap are too close to pick reliably; the reticle then tracks the
 * finger at 1/4 speed and release commits to whichever candidate it's nearest. */
export interface PrecisionCandidate {
  ref: PointRef;
  at: Vec2; // world position
}
export interface PrecisionSession {
  candidates: PrecisionCandidate[];
  activeIndex: number;
  anchorWorld: Vec2; // world-space centroid of the candidate cluster — the loupe's magnification centre
  anchorScreen: Vec2; // the finger position precision mode opened at, for loupe placement + delta tracking
  reticleWorld: Vec2; // world-space reticle position; starts at anchorWorld, drifts at 1/4 finger speed
  lastFingerScreen: Vec2; // updated every move, to compute this sample's incremental delta
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

/** Phase 2C: what the Divide tool's canvas tap resolved to — either one derived segment (line
 * piece or arc, divided between its own endpoints) or a whole untouched closed circle (divided
 * all the way round). Consumed by the shell, which owns the N-picker sheet (§4.5). */
export type DivideTarget =
  | { entityId: EntityId; kind: 'segment'; from: PointId; to: PointId; fromParam: number; toParam: number }
  | { entityId: EntityId; kind: 'circle-whole' };

/** Phase 2.1 item 1: the compact Divide sheet's live preview — recomputed on every slider/stepper
 * change, read only by the renderer, never recorded in history. `chords` previews the optional
 * closed-circle star connector, empty otherwise. */
export interface DividePreview {
  target: DivideTarget;
  points: Vec2[];
  chords: [Vec2, Vec2][];
}

/** Phase 1.2 item 7: the point-visibility model. Geometry/snapping always sees every point —
 * this only controls what's drawn. */
export type PointVisibility = 'near-finger' | 'all' | 'used' | 'none';

/** Phase 3.7 item 4: Select's own targeting filter — 'all' is today's unfiltered behaviour;
 * 'fair'/'construction' narrow tap targeting and marquee to segments/entities uniformly in that
 * state (a mixed-state whole entity matches neither, only its individual SelectableGroups can);
 * 'points' narrows to eligible manual points only (see isEditablePointKind) and excludes every
 * segment/entity/group tier outright. Divide and Fair never see this — each calls
 * pickSelectCandidates with the default 'all', keeping their targeting completely independent of
 * whatever Select's filter happens to be set to. */
export type SelectFilter = 'all' | 'fair' | 'construction' | 'points';

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
}

/** Phase 1.2 item 4: an in-progress marquee drag, in screen space. */
export interface Marquee {
  start: Vec2;
  current: Vec2;
}

/**
 * Phase 3.1 item 2: the node inset — a true magnified view of the local geometry around a
 * candidate, replacing the old single-marker snap loupe. `activeAt` is the currently-chosen
 * candidate (drawn centred and highlighted); `candidates` are other nearby points worth showing
 * so the participant can see *which* junction they're about to commit to, not just that
 * something snapped. Used by every point-taking tool (Circle/Line/Polygon/Fair's Draw-Line
 * mode) and by Fair's trace junction scoring.
 */
export interface NodeInsetState {
  anchorScreen: Vec2; // finger position, for loupe placement away from it
  activeAt: Vec2; // world position of the chosen candidate — the magnification centre
  candidates: Vec2[]; // other nearby points, world space, excluding activeAt
}

type Listener = () => void;

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
  /** Phase 3.4 item 2: Line's own creation mode — every new line commits as either a finite
   * Construction line or a through-both-points Extension line (spec's extension-line logic,
   * dashed/subdued). Sticky across gestures, like Fair's old stroke default was. */
  lineMode: 'construction' | 'extension' = 'construction';
  pointVisibility: PointVisibility = 'near-finger';
  /** Phase 3.7 item 4: Select's own targeting filter, sticky across gestures like `pointVisibility`. */
  selectFilter: SelectFilter = 'all';
  /** Screen position of the single active pointer, for "near finger" reveal; null when no
   * pointer is down. Updated by PointerManager, read by the renderer only. */
  pointerScreenPos: Vec2 | null = null;
  marquee: Marquee | null = null;
  /** Phase 1.2a: true while the active tool's current touch is over a curve that Point Lock is
   * blocking from becoming a point — drives the "Point Lock · choose an existing point" hint. */
  pointLockHint = false;
  /** Phase 2H: non-null while the precision loupe is open. */
  precision: PrecisionSession | null = null;
  /** Phase 2C: set by the Divide tool's canvas tap, cleared by whoever opens the N-picker sheet
   * for it (the shell) — a one-shot cross-layer handoff, same shape as extendChip. */
  pendingDivide: DivideTarget | null = null;
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
  /** Phase 5 item 4/6: non-null while a lattice-arm handle is being dragged — `rawTranslate` is
   * the live, unsnapped world-space vector the render/preview layer uses; only committed to
   * `doc.repeat` on release (possibly snapped to a contact detent first). */
  repeatDrag: { dir: 'a' | 'b'; rawTranslate: Vec2 } | null = null;
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
    const before = cloneDoc(this.doc);
    const next = cloneDoc(this.doc);
    mutate(next);
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

  /** Phase 3.6 item 2: `view` (zoom/pan) rides inside every snapshot for cloning convenience, but
   * it is a camera preference, not document history — undo/redo must revert geometry while
   * leaving the participant's current zoom/pan exactly where they left it. Carry the live view
   * across the swap rather than restoring the one baked into the popped snapshot. */
  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    const view = this.doc.view;
    const repeatView = this.doc.repeatView;
    this.redoStack.push(this.doc);
    this.doc = prev;
    this.doc.view = view;
    this.doc.repeatView = repeatView;
    this.pending = null;
    this.notify();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    const view = this.doc.view;
    const repeatView = this.doc.repeatView;
    this.undoStack.push(this.doc);
    this.doc = next;
    this.doc.view = view;
    this.doc.repeatView = repeatView;
    this.pending = null;
    this.notify();
  }

  /** §1.3: tapping the lit tool, or Select, returns to Select. */
  setTool(tool: ToolId): void {
    if (!LIVE_TOOLS.has(tool)) return;
    this.pending = null;
    this.preview = null;
    this.nodeInset = null;
    this.extendChip = null;
    this.fairPromoteChip = null;
    this.pendingMerge = null;
    this.pointLockHint = false;
    this.precision = null;
    this.pendingDivide = null;
    this.dividePreview = null;
    this.fairTrace = null;
    this.fillPreview = null;
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
