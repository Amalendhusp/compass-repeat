// Data model per interaction spec §3. Field names and shapes follow the spec's
// TS sketch exactly; a few fields are internal completions of details the spec
// leaves implicit (noted inline) rather than behavioural additions.

export type PointId = string;
export type EntityId = string;
export type ColourwayId = string;

export type FrameKind = 'circle' | 'square' | 'hexagon' | 'triangle';

export type Point =
  | { id: PointId; kind: 'intersection'; entities: [EntityId, EntityId]; branch: 0 | 1 }
  | { id: PointId; kind: 'centre'; entity: EntityId }
  | { id: PointId; kind: 'frame-vertex'; index: number }
  // rotationOffset: not in the spec's literal snippet — the anchor angle for a closed-circle
  // division (§4.5: "the existing point on the circle nearest the tap; if the circle has none,
  // the frame's alignment angle"). For an arc-segment division (`span` set, circle host),
  // rotationOffset/arcSpan instead record that arc's own start angle and angular sweep — the
  // pair of endpoint ids alone can't tell which of the two possible arcs between them the
  // original segment was.
  | {
      id: PointId;
      kind: 'division';
      host: EntityId;
      index: number;
      of: number;
      span?: [PointId, PointId];
      rotationOffset?: number;
      arcSpan?: number;
    }
  | { id: PointId; kind: 'midpoint'; a: PointId; b: PointId }
  // arcEnd (Phase 5.2): an Arc's own start/end point — a real construction node, so it snaps as
  // a Primary target even though it is stored like any other on-curve point.
  | { id: PointId; kind: 'on-curve'; host: EntityId; param: number; arcEnd?: boolean }
  // free: unconstrained; used for free radii and the frame circle's own
  // internal through-point. `hidden` is an internal rendering hint (not part
  // of the spec's snippet) so a frame circle's defining through-point, which
  // has no user-facing role until the circle is divided, doesn't draw as a
  // stray dot on a fresh frame — see spec §4.5's "if the circle has none".
  | { id: PointId; kind: 'free'; x: number; y: number; hidden?: boolean };

// colour (C1): the element's own construction colour (a hex string). Absent = the default
// construction grey. It belongs to the whole line or circle — every Construction / Extension piece
// of it, however it is split or trimmed — and never to its Fair pieces, which keep their own stroke.
export type Entity =
  | { id: EntityId; kind: 'circle'; centre: PointId; through: PointId; locked?: boolean; colour?: string }
  // groupId: not in the spec's snippet — Phase 2A's completion of "preserve polygon/group
  // identity so a completed polygon can later be selected as one shape": every edge line an
  // in-progress or completed Polygon commits shares one groupId, so Select can treat them as a
  // single unit (see SelectCandidate's 'group' kind) without inventing a new Entity kind.
  // axis: a horizontal ('h', 0°) or vertical ('v', 90°) extension through point `a`, made on demand
  // to find where it crosses other geometry. `b` is a hidden internal point fixing its direction.
  // Deleting an axis leaves what was built from its crossings in place (doc.ts — detach).
  | { id: EntityId; kind: 'line'; a: PointId; b: PointId; extended: boolean; locked?: boolean; groupId?: string; axis?: 'h' | 'v'; colour?: string };

export type SegmentKey = string; // `${entityId}:${fromPointId}:${toPointId}`

export interface SegmentState {
  state: 'construction' | 'extension' | 'fair' | 'trimmed';
  stroke?: { colour: string; width: number };
  /** Phase 5.6: what a Fair segment was before it was promoted (Construction or Extension), so
   * un-Fairing returns exactly that — a finite Construction span on an extended line goes back to
   * solid Construction, an Extension-only line's span back to dashed Extension. */
  base?: 'construction' | 'extension';
}

export type FaceSig = string;

export interface Colourway {
  id: ColourwayId;
  name: string;
}

export interface SymmetrySource {
  id: string;
  kind: 'frame' | 'divide';
  n: number;
  group: 'D' | 'C'; // dihedral (mirrors) or cyclic
  centre: PointId;
  mirrorAxisAngle?: number; // radians; axis through vertices when frame/divide provides it
  label: string;
}

export interface RepeatSystem {
  family?: 'square' | 'rect' | 'brick' | 'triangle' | 'hex';
  a: { x: number; y: number };
  b: { x: number; y: number };
  rowOffset: number;
  motif: { rotation: number; scale: number };
  rule: { kind: 'same' | 'alternate' | 'mirror' | 'around'; rotation?: number; order?: number };
  footprint: 'design' | 'frame';
  overlap: 'stack' | 'clip';
  showStrokes: boolean;
  gapFills: Map<string, string>;
}

/** Intersection's arrangement. Each construction's REFERENCE centre offset (where its frame centre
 * sits, relative to the original, at Spread 100%) and its own rotation about that centre. What is
 * shown is centre + spread × (reference − centre): Spread moves centres in or out about the
 * reference group's centre — sizes and rotations never change. */
export interface IntersectionLayout {
  /** The Primary first ("0,0"), then each copy, in the order added. */
  pieces: { key: string; x: number; y: number; rotation: number }[];
  /** Which constructions the reference was set with. When the copies present differ (one added or
   * removed since), the reference is out of date and Spread waits for a new one. Absent in
   * arrangements saved before copies could be added — those are always current. */
  referenceKeys?: string[];
  /** Legacy: the starting arrangement (Square / Triangle / Hexagon) of arrangements saved before
   * copies could be added freely. Not used. */
  family?: 'square' | 'triangle' | 'hex';
  /** The reference group's centre: the mean of the reference centres when the reference was set —
   * fixed until it is set again, so moving one construction never shifts where Spread pulls to. */
  centre: Vec2;
  /** 1 = the reference arrangement (100%). */
  spread: number;
}

export type Workspace = 'construct' | 'intersection' | 'repeat';

/** A reference image placed in an artwork's own coordinates (see Doc.underlay). */
/** Where a reference lies in the artwork's own coordinates. */
export interface UnderlayPlacement {
  /** Where its centre lies, in the artwork's coordinates. */
  centre: Vec2;
  /** Its width, in the artwork's units; its height follows from the image's `aspect`. */
  width: number;
  /** Its turn about its centre (radians) — relative to the artwork, never the camera. */
  rotation: number;
}

/**
 * A reference image under an artwork: one Reference Library image (one `refId`, never copied), and
 * where it lies in each workspace — Construct, Intersection and Repeat each keep their own
 * placement (render/underlay.ts — placementOf). The placement fields of the underlay itself are
 * the most recently established placement: what a workspace that has none yet starts from, and
 * the one shared placement of artworks made before placements were per workspace.
 */
export interface Underlay extends UnderlayPlacement {
  /** Its Reference Library id. */
  refId: string;
  /** The image's own width ÷ height, as imported — so it is always drawn undistorted, and still
   * known if the library image goes missing. */
  aspect: number;
  /** Each workspace's own placement, once it has one. */
  placements?: Partial<Record<Workspace, UnderlayPlacement>>;
  /** Reference anchors: places in the image the participant has marked (a crossing, a vertex, a
   * star's point…), kept as a fraction of the image's width (u) and height (v) from its top-left —
   * so each stays on its spot in the image however the image is moved, scaled or turned. Alignment
   * aids only: never construction points, never part of the artwork's geometry. */
  anchors?: ReferenceAnchor[];
}

export interface ReferenceAnchor {
  id: string;
  u: number;
  v: number;
}

/** One workspace's viewing balance between the reference and the artwork. */
export interface UnderlayView {
  visible: boolean;
  /** 0–1. */
  referenceOpacity: number;
  /** 0–1: how strongly the artwork is shown over the reference — a view only, never its styling. */
  artworkOpacity: number;
}

/** Intersect Form Development (Stage D): a piece of the Developed Primary — geometry Intersect OWNS,
 * fixed where it was taken (moving or removing the copy it came from never changes it). Exact: a
 * line's two ends, or an arc's centre, radius, start angle and sweep (increasing angle). `origins`
 * records which copy (and Construct line or circle) contributed it — provenance only, never used to
 * place it; coincident pieces from several copies are one segment with several origins. */
export interface DevelopedSegment {
  id: string;
  geom: { kind: 'line'; a: Vec2; b: Vec2 } | { kind: 'arc'; c: Vec2; r: number; a0: number; sw: number };
  origins: { copy: string; entity: string }[];
}
/** The Developed Primary. Its presence marks an artwork that uses Intersect Form Development: Repeat's
 * Intersect source is then the Original (unless demoted), the promoted Primary-copies and this —
 * not every instance (geometry/intersection.ts — formMode). */
export interface IntersectionForm {
  developed: DevelopedSegment[];
}

export interface IntersectionSnapshot {
  id: string;
  at: number;
  layout: IntersectionLayout;
  copies: Record<string, { colour?: string; extensions?: boolean; locked?: boolean; primaryCopy?: boolean }>;
  /** A small picture of it (JPEG data URL), if one could be drawn. */
  thumb?: string;
}

export interface RepeatDisplay {
  /** No longer chosen: Repeat always shows the whole design ('design'). An artwork saved in the old
   * Stroke-only or Fill-only view is restated on opening (see main.ts); states recorded in those views
   * still draw as they looked, so a Timelapse replays them faithfully. */
  artwork: 'design' | 'stroke' | 'fill';
  background: string;
  fillOpacity: number; // 0..1, applied at render time only
  /** Repeat's own outline style for the repeated design, applied at render time only — absent or
   * null means "as designed" (each Fair piece's own Construct colour/width). Width is in screen px;
   * 0 draws no outlines. Never touches geometry or region boundaries. */
  strokeColour?: string | null;
  strokeWidth?: number | null;
  grid: boolean;
  handles: boolean;
  motifBoundary: boolean;
  /** Legacy: where the Source choice was kept before it became part of Undo and the recorded
   * artwork (Doc.repeatSetup). Moved there when an artwork is opened. */
  source?: 'motif' | 'intersect';
}

export type RepeatSourceKind = 'motif' | 'intersect';

/** Repeat's own appearance for one source (see RepeatDisplay): kept with that source's setup. */
export interface RepeatAppearance {
  background: string;
  fillOpacity: number;
  strokeColour?: string | null;
  strokeWidth?: number | null;
}

/**
 * Repeat's own colouring of the repeated design — never the construction's fills (Construct keeps
 * those untouched). A region is keyed by its face signature (the motif), or by
 * "instanceKey|signature" (an Intersect arrangement: the same region of different instances can be
 * coloured differently). A colour replaces the design's own fill there; null shows it unfilled.
 */
export interface RepeatColouring {
  /** Motif Colouring: applied to the region in every copy. */
  regions?: Record<string, string | null>;
  /** Pattern Colouring: copies fall into two groups by their place in the lattice — alternate
   * copies (i + j odd), rows (j odd) or columns (i odd) — and the second group may have its own
   * region colours (over Motif Colouring's). 'none' keeps them but does not apply them. */
  pattern?: { by: 'none' | 'copies' | 'rows' | 'columns'; regions: Record<string, string | null> };
}

/** One layer of Repeat's outline style: a colour and a width along every line — in the artwork's own
 * units (px at 100% zoom), so it scales with the pattern. */
export interface RepeatStrokeLayer {
  colour: string;
  width: number;
}

/**
 * Repeat's own outline style for every visible line of the repeated design — 1 to 3 layers drawn
 * along exactly the same paths, widest first (outer, inner, centre), each narrower than the one
 * before: a double or triple line is rendered, never constructed (no new geometry, no offset
 * paths). No layers = as designed (each line's own Construct colour and width).
 */
export interface RepeatStroke {
  layers: RepeatStrokeLayer[];
  /** Sprint S3 — Interlaced: the bands weave over and under one another where the design's lines
   * genuinely cross (geometry/weave.ts). Rendered only: no line is cut or changed. `on` false keeps the
   * reversals for when Interlaced is chosen again. `flips`: crossings (stable ids) whose automatic
   * over/under is reversed. Absent in every artwork made before it. */
  weave?: { on: boolean; flips: string[] };
}

/** One source's whole Repeat configuration, kept while the other source is showing. */
export interface RepeatConfig {
  /** doc.repeat as it was (gapFills as entries). */
  repeat: Omit<RepeatSystem, 'gapFills'> & { gapFills: [string, string][] };
  appearance: RepeatAppearance;
  colour?: RepeatColouring;
  stroke?: RepeatStroke;
  auto?: { a: Vec2; b: Vec2 } | null;
}

/**
 * What Repeat repeats and each source's own configuration — part of Undo and of the recorded
 * artwork. The active source's lattice is doc.repeat and its appearance doc.repeatDisplay (as
 * always); `saved` holds the other source's, restored when it is chosen again.
 */
export interface RepeatSetup {
  source: RepeatSourceKind;
  saved?: Partial<Record<RepeatSourceKind, RepeatConfig>>;
  /** The active source's colouring. */
  colour?: RepeatColouring;
  /** The active source's outline style (absent: the older display-level style, if any, applies). */
  stroke?: RepeatStroke;
  /** The lattice vectors as Repeat suggested them for this source — while doc.repeat still has
   * exactly these, the spacing is the suggestion (and follows changes to an Intersect
   * arrangement); once the participant adjusts it, it is theirs and is never replaced. */
  auto?: { a: Vec2; b: Vec2 } | null;
}

/** A workspace camera: how the artwork's own coordinates are shown — never the artwork itself. */
export interface Camera {
  zoom: number;
  pan: Vec2;
  /** The view's turn on screen (radians; absent = 0) — like turning the sheet under the hands:
   * every coordinate stays exactly as it is. */
  rotation?: number;
}

export interface ViewState extends Camera {
  workspace: Workspace;
}

export interface Frame {
  kind: FrameKind;
  entityIds: EntityId[];
  centreId: PointId;
  designEnabled: boolean;
  // Internal placement parameters. The spec's Doc.frame snippet doesn't spell
  // out how frame-vertex coordinates are derived; a fixed origin/radius/rotation
  // recorded at creation is the natural completion (frame entities are locked
  // and never dragged in v1 — assumption §12.3), not a behavioural change.
  origin: { x: number; y: number };
  radius: number;
  rotation: number;
}

export interface Doc {
  id: string;
  name: string;
  /** Phase 5.5 item 6: true once the participant has given this artwork a name (Save asks once). */
  named: boolean;
  schemaVersion: 2;
  frame: Frame;
  points: Point[];
  entities: Entity[];
  segmentStates: Map<SegmentKey, SegmentState>;
  fills: Map<ColourwayId, Map<FaceSig, string>>;
  colourways: Colourway[];
  activeColourway: ColourwayId;
  symmetrySources: SymmetrySource[];
  echo: { mode: 'off' | 'preview' | 'apply'; sourceId?: string; mirrors: boolean };
  repeat: RepeatSystem;
  view: ViewState;
  /**
   * Phase 3.4 item 5: replaces the old binary Point Lock. Governs which existing point KINDS
   * compete as snap/select targets for the geometry-creation tools (Circle/Line/Arc) — not
   * merely what's drawn (that's `PointVisibility`, deliberately kept separate — item 9). A
   * document preference, not undo-tracked (like `view`).
   * - `primary`: intersections, centres, frame vertices.
   * - `derived`: midpoints, division points.
   * - `free`: whether an implicit new point may be materialized on a curve (line/circle/arc)
   *   when nothing eligible already exists there — the direct successor of the old `pointLock`
   *   boolean (pointLock=true ⟺ free=false).
   */
  pointTargets: { primary: boolean; derived: boolean; free: boolean };
  /** Phase 3H: the stroke a newly-faired segment gets, and what the Fair tool's own stroke
   * picker shows/edits when nothing specific is selected. A document preference (like
   * `pointTargets`) rather than an undo-tracked field on its own — but every segment it gets
   * *applied to* records its own `stroke` copy in that segment's SegmentState, which is
   * undo-tracked normally through commit(). */
  fairDefaults: { colour: string; width: number };
  /** Phase 3.7 item 10: the last N used to Divide something, offered as the next Divide sheet's
   * starting value — a document preference (like `pointTargets`/`fairDefaults`), not undo-tracked,
   * and persisted across reload since it lives on the Doc that autosave already serializes. */
  dividePrefs: { lastN: number };
  /** Phase 4 item 5: the Fill tool's own current colour — what tapping a region next applies,
   * mirroring `fairDefaults`. What an already-filled region actually renders is its own entry in
   * `fills`, undo-tracked normally through commit(); this is only the tool's next-fill default. */
  fillDefaults: { colour: string; opacity: number };
  /** Phase 5.2 items 17/19: Circle's and Arc's own modes, and the radius they share — the last
   * radius Circle set or Arc measured, reused by either tool's "Same radius". A document
   * preference like `dividePrefs`: not undo-tracked, persisted by autosave. */
  /** constructionColour (Stage A): the colour new lines, circles and arcs are drawn in — a drawing
   * preference (absent / null = the default grey). Changing it never touches existing geometry. */
  toolPrefs: { circleMode: 'set' | 'same'; arcMode: 'measure' | 'same'; lastRadius: number | null; constructionColour?: string | null };
  /** Phase 5 item 12: Repeat's own pan/zoom — separate from `view` so navigating the tessellation
   * never moves the participant's Construct viewport (and vice versa). Not undo-tracked, exactly
   * like `view` (Phase 3.6 item 2's fix applies here too — see AppController.undo/redo). Which
   * workspace is showing right now is `view.workspace`, already part of the schema. */
  repeatView: Camera;
  /** Phase 5.1: how Repeat draws the motif and its guides — display preferences only, never the
   * artwork's own stored Fair/fill state. Not undo-tracked (carried across undo/redo like
   * `repeatView`). Replaces Phase 5's single `repeatGuide` boolean. */
  repeatDisplay: RepeatDisplay;
  /** Repeat's source and each source's own configuration and colouring (types: RepeatSetup). Part
   * of Undo and of the recorded artwork. Absent = the motif, never configured separately. */
  repeatSetup?: RepeatSetup;
  /** Repeat Fill's next colour (null = unfilled / "No fill") and opacity (absent = 100%) — one
   * choice for Space, Motif and Pattern alike. A tool preference like `fillDefaults`, never history. */
  repeatPaint?: { colour: string | null; opacity?: number };
  /** Intersection's own camera — like repeatView, never history. Absent until Intersection is first
   * entered. */
  intersectionView?: Camera;
  /** Intersection: an exploratory composition of a few copies of the construction, entirely its own —
   * never Repeat's lattice. Per-copy analysis colour and whether its extensions are drawn (keyed by
   * the copy's key; the primary is "0,0"), and the arrangement itself. Absent or partial = defaults
   * (see geometry/intersection.ts). Part of Undo; never part of the recorded artwork (it is a way of
   * exploring, not the design). */
  intersection?: { copies: Record<string, { colour?: string; extensions?: boolean; locked?: boolean; primaryCopy?: boolean }>; layout?: IntersectionLayout; form?: IntersectionForm };
  /** Intersection Snapshots: discoveries kept on purpose while exploring — not history, so Undo /
   * Redo never adds or removes one (carried across them like the cameras). */
  intersectionSnapshots?: IntersectionSnapshot[];
  /** The reference image under this artwork (one at most): which Reference Library image, and
   * where it lies in the artwork's own coordinates in each workspace (each also looking at it
   * through its own camera). Never image data (that stays in the library). Part of Undo; never
   * part of the recorded artwork, its exports or its Timelapse. */
  underlay?: Underlay;
  /** How the reference and the artwork are balanced for viewing, in each workspace — not history
   * (carried across Undo/Redo like the cameras). Absent = the defaults (underlay.ts). */
  underlayView?: Partial<Record<Workspace, UnderlayView>>;
  /** Phase 5.6 item 20: Space's own next colour and opacity (null = "No fill", which only clears).
   * A tool preference like `fillDefaults`; what each Space class actually shows is its own entry in
   * `repeat.gapFills`, undo-tracked through commit(). */
  spaceDefaults: { colour: string | null; opacity: number };
  createdAt: number;
  updatedAt: number;
}

export interface Vec2 {
  x: number;
  y: number;
}
