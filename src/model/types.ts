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
  | { id: PointId; kind: 'on-curve'; host: EntityId; param: number }
  // free: unconstrained; used for free radii and the frame circle's own
  // internal through-point. `hidden` is an internal rendering hint (not part
  // of the spec's snippet) so a frame circle's defining through-point, which
  // has no user-facing role until the circle is divided, doesn't draw as a
  // stray dot on a fresh frame — see spec §4.5's "if the circle has none".
  | { id: PointId; kind: 'free'; x: number; y: number; hidden?: boolean };

export type Entity =
  | { id: EntityId; kind: 'circle'; centre: PointId; through: PointId; locked?: boolean }
  // groupId: not in the spec's snippet — Phase 2A's completion of "preserve polygon/group
  // identity so a completed polygon can later be selected as one shape": every edge line an
  // in-progress or completed Polygon commits shares one groupId, so Select can treat them as a
  // single unit (see SelectCandidate's 'group' kind) without inventing a new Entity kind.
  | { id: EntityId; kind: 'line'; a: PointId; b: PointId; extended: boolean; locked?: boolean; groupId?: string };

export type SegmentKey = string; // `${entityId}:${fromPointId}:${toPointId}`

export interface SegmentState {
  state: 'construction' | 'extension' | 'fair' | 'trimmed';
  stroke?: { colour: string; width: number };
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

export interface ViewState {
  zoom: number;
  pan: { x: number; y: number };
  workspace: 'construct' | 'repeat';
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
   * compete as snap/select targets for the geometry-creation tools (Circle/Line/Polygon) — not
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
  fillDefaults: { colour: string };
  /** Phase 5 item 12: Repeat's own pan/zoom — separate from `view` so navigating the tessellation
   * never moves the participant's Construct viewport (and vice versa). Not undo-tracked, exactly
   * like `view` (Phase 3.6 item 2's fix applies here too — see AppController.undo/redo). Which
   * workspace is showing right now is `view.workspace`, already part of the schema. */
  repeatView: { zoom: number; pan: Vec2 };
  /** Phase 5 item 14: the optional Guide overlay (motif/frame boundary, lattice directions,
   * neighbour anchors) — an interaction aid, never part of the artwork, so it's a display
   * preference like `pointVisibility`, not undo-tracked and not part of `repeat` itself (which
   * IS undo-tracked — keeping this out of it avoids the same view/undo bug Phase 3.6 item 2 fixed
   * for `view`, since a whole-`repeat` snapshot restore must never silently fight a live toggle). */
  repeatGuide: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Vec2 {
  x: number;
  y: number;
}
