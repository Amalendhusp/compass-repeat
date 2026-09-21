# Construct & Repeat — Interaction Specification v1.1

Handoff for Claude Code. This supersedes v1.0. The visual design is approved and lives on the design canvas; this document is the behavioural contract.

This is a mobile-first web app: a digital compass and straightedge for Islamic geometric pattern. It has two workspaces, **Construct** and **Repeat**, sharing one live **Master Motif**.

**Changes from v1.0:** Select as inspection mode with cross-class cycling (§1, §5) · implicit points on curves (§5.3) · free points and the circle radius model (§3) · Trim vs Delete (§4.6) · Use frame in design (§4.1) · lattice suggestions, not defaults (§6.1) · direction-based Fair tracing (§4.7) · Symmetry Echo Off/Preview/Apply from explicit metadata (§4.8) · n/k stars on closed circles only (§4.5) · Repeat footprint (§6.3) · gap computation from neighbouring copies (§6.6) · rectangular PNG supercells (§7) · local-first persistence (§9).

---

## 1. Interaction grammar

### 1.1 Active verbs: one target class each

| Verb | Target class | Produces |
|---|---|---|
| Circle | **point** (existing, or implicit on a curve, or free when dragging a radius) | construction circle |
| Line | point, point | construction segment; optional Extend |
| Polygon | points in sequence; tap the first point to close | construction segments |
| Divide | **entity** (whole circle, arc segment, or line segment) | division points; star n/k chords for closed circles |
| Fair | **segment** (tap toggles; drag traces) | segment state |
| Fill | **region** | fill in the active colourway |

An active verb ignores every other class. A tap that finds nothing of its class does nothing, and the context bar hints what the verb needs ("Tap a point or a curve").

### 1.2 Select is the inspection mode

Select is the resting state. It accepts **points, segments and regions** and exposes class-specific actions (§4.9). It never constructs.

### 1.3 Tool lifecycle

- Tools are sticky. After a commit, the same tool stays armed.
- Tapping the lit tool, or Select, returns to Select.
- A pending step (e.g. centre chosen, radius pending) shows a brass ring on the dock button and step dots in the context bar. ✕ in the context bar, or a tap on empty canvas, cancels the pending step.
- There is no Arc tool. Arcs are circle segments produced by splitting.

## 2. Gestures

| Gesture | Effect |
|---|---|
| 1-finger tap | act with the current verb |
| 1-finger drag | Circle: radius preview. Line: A→B. Polygon: rubber band. Fair: trace. Repeat: handles |
| 1-finger press ≥ 350 ms, then slide | Precision mode: loupe plus a reticle moving at ¼ finger speed; lift commits, sliding off the loupe cancels |
| 2-finger pinch / drag | zoom / pan — **never edits** |
| 2-finger tap (< 250 ms, < 10 px travel) | undo |
| 3-finger tap | redo |

**Arbitration:** if a second pointer lands within 120 ms of the first, discard the first pointer's action and treat the gesture as a view gesture. If a preview has already started, a second finger cancels it without committing.

**Desktop shortcuts:** V Select · C Circle · L Line · P Polygon · D Divide · F Fair · G Fill · E cycle Symmetry Echo (Off → Preview → Apply) · Tab next candidate · ⇧-click add to selection · Space+drag pan · ⌘/Ctrl+scroll zoom · ⌘Z / ⇧⌘Z undo / redo.

## 3. Data model

```ts
Doc {
  id, name, schemaVersion: 2,
  frame: { kind: 'circle'|'square'|'hexagon'|'triangle', entityIds[], centreId,
           designEnabled: boolean },
  points: Point[], entities: Entity[],
  segmentStates: Map<SegmentKey, SegmentState>,   // segments themselves are derived
  fills: Map<ColourwayId, Map<FaceSig, Colour>>, colourways: Colourway[], activeColourway,
  symmetrySources: SymmetrySource[], echo: { mode: 'off'|'preview'|'apply', sourceId?, mirrors: boolean },
  repeat: RepeatSystem, view: { zoom, pan, workspace }
}

Point =
  | { id, kind: 'intersection', entities: [EntityId, EntityId], branch: 0|1 }  // which root of a circle–circle / line–circle pair
  | { id, kind: 'centre', entity }                                            // frame centre, or a centre recorded at creation
  | { id, kind: 'frame-vertex', index }
  | { id, kind: 'division', host: EntityId, index, of: N, span?: [PointId, PointId] }
  | { id, kind: 'midpoint', a: PointId, b: PointId }
  | { id, kind: 'on-curve', host: EntityId, param: number }   // angle (circle) or t (line), user-placed
  | { id, kind: 'free', x, y }                                 // unconstrained; used for free radii

Entity =
  | { id, kind: 'circle', centre: PointId, through: PointId, locked?: boolean }
  | { id, kind: 'line', a: PointId, b: PointId, extended: boolean, locked?: boolean }

SegmentKey   = `${entityId}:${fromPointId}:${toPointId}`   // arcs are counter-clockwise from → to
SegmentState = { state: 'construction'|'extension'|'fair'|'trimmed', stroke?: { colour, width } }
```

**The radius model (item 3).** A circle is always defined as *centre + a point it passes through*.
- Tapping a second point uses that point.
- A drag that ends on a snap target or on a curve uses that point (existing or new on-curve point).
- A drag that ends in empty space creates a `free` point at the release position. Free points are real points: they are snap targets and they render as a small hollow square.
- A circle's own `through` point **does not split** that circle into arcs, so a free radius never introduces an arbitrary joint. It does split any other entity it happens to lie on.

A single representation keeps compass semantics: the radius is always "the distance to that point", and it can be reused.

**Derived geometry.** All coordinates are evaluated from definitions.
- Coincident points merge within ε = 1e-6 × drawing extent. A merged point keeps every definition, and its canonical id is the earliest-created.
- Segments are derived by splitting each entity at every point that lies on it, except a circle's own `through` point when that point is free.
- Segment state is stored by `SegmentKey`. When a new point splits a segment, both children inherit the parent's state.
- Collinear overlapping segments from different entities merge into one drawn segment with multiple owners. The segment is fair if any owner's piece is fair.

## 4. Construct behaviours

### 4.1 Frame

The start sheet offers Circle, Hexagon, Square and Triangle. The frame creates locked entities, a `centre` point and `frame-vertex` points.

Frame segments are **locked construction**: they cannot be trimmed or deleted, and Fair ignores them by default.

**Use frame in design (item 5).**
- In Select, tapping a frame segment shows the action bar with Fair disabled (lock glyph) and a primary action **Use frame in design**.
- In Fair mode, tapping a frame segment shows a toast "The frame is locked · Use frame in design" with that action.
- Applying it sets `frame.designEnabled = true` and promotes **all** frame boundary segments to fair (one undo step).
- From then on, frame segments behave like ordinary segments for Fair, Construction and Extension state changes, but they remain untrimmable and undeletable.
- Reversal: the action becomes **Stop using frame in design**, which returns all frame segments to construction and drops any fills whose faces no longer close (with a toast and Undo).

### 4.2 Circle

1. Tap a point target (§5) to set the centre.
2. Then either tap a second point target, or drag from the centre and release (§3 radius model).

The preview is a dashed signal circle. On commit, the circle is construction and the tool stays armed.

### 4.3 Line

Tap A, then tap B (or press on A and drag to B). After commit, an **Extend** chip appears for 4 s. Extend sets `extended = true`: the line renders to the canvas bounds as extension state, and its extended parts generate intersections.

### 4.4 Polygon

Tap vertices in order. A rubber band follows the finger. Tap the first vertex to close, or tap the tool to finish an open chain. Each vertex target may be implicit on a curve (§5.3).

### 4.5 Divide (item 9)

In Divide mode:
- Tapping a circle targets the **whole circle**.
- The context bar offers an **Arc only** chip, which retargets to the arc segment under the tap.
- Tapping a line targets its segment between the nearest points.

| Target | Points created | Start / anchor | Connect section |
|---|---|---|---|
| Closed circle | N | the existing point on the circle nearest the tap; if the circle has none, the frame's alignment angle (−90° for a circle frame) | **shown**: star n/k, k = 2…⌊n/2⌋ |
| Arc segment | N − 1 interior | its endpoints | **hidden** |
| Line segment | N − 1 interior | its endpoints | hidden |

Division points are `division` points: evaluated from the host plus index, and for arcs and segments also the span endpoints.

Star n/k adds the n chords P_i → P_(i+k mod n) as construction lines. It is only available when the host is a closed circle; star chords never wrap cyclically around an arc.

Midpoint is Divide N = 2 on a segment, and also appears directly in the segment action bar.

Every division of a circle **centred on the frame centre** registers a symmetry source (§4.8).

### 4.6 Trim vs Delete (item 4)

- **Trim** (segment action, scissors icon): sets the segment to `trimmed`.
  - The segment is not drawn and does not take part in the region arrangement.
  - Its parent entity and every point it defines stay geometrically active: the points remain snap targets and other segments still split at them.
  - In Select mode only, trimmed segments render as 15% dotted ghosts and are selectable, with the single action **Restore**.
- **Delete** removes the underlying **entity**. It is reached by long-pressing a segment → "Delete circle" / "Delete line", or on desktop with Delete/Backspace while a segment is selected (acting on its entity).
  - It deletes, recursively, every point defined by the entity and every entity defined through those points.
  - If there are dependents, it first confirms: "Delete circle and 4 dependent constructions?"
  - It is one undo step.
  - Locked frame entities cannot be deleted.
- A lone point (on-curve, free, midpoint or division) can be deleted from its point action bar when nothing depends on it. Otherwise the same dependency confirmation applies.

### 4.7 Fair (item 7)

**Tap** (≤ 6 px travel) toggles one segment: construction/extension ↔ fair.

**Trace mode is fixed by the first segment touched.** If that segment is not fair, the stroke fairs segments. If it is fair, the stroke un-fairs them (erase trace).

**Trace algorithm:**
1. Keep a *current segment*, its *exit junction* (the endpoint the finger is moving toward) and a *heading*: an exponential moving average of pointer velocity, α = 0.35, over the last 24 pt of travel.
2. When the pointer comes within 16 pt of the exit junction, collect the outgoing candidates: all segments incident on the junction except the incoming one. Trimmed segments and frame segments are excluded unless the frame is design-enabled.
3. Score each candidate by the angle between its tangent at the junction (arcs use the circle tangent in their direction of travel) and the heading.
4. **Commit a candidate only if** its angle is ≤ 35° **and** it beats the runner-up by ≥ 12°. Otherwise keep accumulating heading for up to 24 pt past the junction, re-scoring as the finger moves.
5. **Candidate preview:** while a candidate is leading but not yet committed, draw it as a brass dashed segment ahead of the finger. The runner-up is shown faintly if its angle is within 20° of the leader.
6. If the finger travels 24 pt past the junction without a decisive candidate, the chain **stops at the junction**. It never guesses. The chain resumes if the finger re-enters any segment's 16 pt hit band within 16 pt of that segment's endpoint.
7. **Backtracking:** if the heading reverses by more than 150° along the segment just processed, that segment reverts to its state before the stroke.
8. A whole trace is one undo step.

High-degree junctions (degree ≥ 6, common in rosettes) rely on this direction test, not on connectivity alone.

### 4.8 Symmetry Echo (item 8)

**States:** Off (default for every new document) · Preview · Apply. It is set per document and persisted, and it affects Fair and Fill only.
- **Off:** actions affect only their target.
- **Preview:** while a target is pressed, traced or selected, draw the target's symmetric images as signal ghosts at 22%. **Nothing is committed to the images.** This is for seeing the symmetry without handing the work over to it.
- **Apply:** commit the target and all its images as **one** undo step; the images glow in signal for 400 ms.

**Symmetry sources.** v1 uses only explicit metadata; there is no automatic detection.
- Frame: square → D4, hexagon → D6, triangle → D3, each about the frame centre, with mirror axes through the vertices and edge midpoints. A circle frame registers nothing on its own.
- Divide of a circle centred on the frame centre into N registers D_N, with mirror axes through the division points and the midpoints between them.

**Active source:** by default, the registered source with the largest N. A chip in the context bar lists all sources ("Hexagon ×6", "Divide ×12") and a **Mirrors** switch (default on). With mirrors off, the group is the cyclic C_N.

**Image matching:** each image of a target is transformed and matched to an existing segment or face within tolerance.
- An image with no match is skipped, and the result is reported: "Applied to 9 of 12 · 3 images have no matching geometry".
- With no source registered, the Echo control is disabled and explains: "Divide the frame circle to enable".

### 4.9 Select actions

| Selected | Action bar |
|---|---|
| Segment | Fair · Construction · Extension · Trim · Midpoint · Divide… (long-press: Delete entity). When fair: stroke colour and width |
| Frame segment | Use frame in design (or Stop using frame in design) · Extension · Midpoint · Divide… |
| Trimmed segment (ghost) | Restore |
| Region | palette swatches · Clear fill |
| Point | Circle from here · Line from here · Delete (if permitted) |

⇧-click on desktop, or the **+** chip on phone, adds to the selection; the action bar then shows only the actions common to everything selected.

### 4.10 Fill

Regions are the faces of the planar arrangement of **fair** segments (lines and true arcs) built with a half-edge / DCEL structure. The unbounded face is excluded.
- A tap inside a face fills it in the active colourway.
- A tap in an area that is not a closed face pulses the nearest open endpoints and shows "2 gaps".
- Fills are keyed by face signature: the sorted SegmentKeys of the boundary.
- When an edit changes a face, carry the fill over to the child face that contains the old face's interior sample point; otherwise drop the fill, with a toast and Undo.
- Construction fades to 30% in Fair and Fill modes (visibility setting "Quiet construction while colouring").

**Colourways** A, B, C… are alternative fill and stroke maps over the same geometry. Repeat and export use the active colourway.

## 5. Targeting, snapping and precision

### 5.1 Hit radii (screen space, constant across zoom)

- Points: 22 pt
- Segments and curves: 16 pt
- Regions: tap inside the face

### 5.2 Point tools

Candidate ranking: explicit points (intersection, centre, frame-vertex, division, midpoint, free, on-curve) come first, then implicit on-curve projections (§5.3), each group ordered by distance.

### 5.3 Implicit point on a curve (item 2)

When a point-taking tool (Circle centre or through point, Line A/B, Polygon vertex) finds no explicit point within 22 pt, but a visible, non-trimmed curve lies within 16 pt:
- Project the tap onto the nearest curve.
- Show the **diamond preview** in signal (from the approved Point · on curve state).
- On commit, create `on-curve { host, param }`. It becomes a normal point: it splits its host's segments, it is a snap target, and it is deleted with its host.

If two or more curves are within 16 pt, each contributes a projection to the candidate set. If projections fall within 8 pt of each other, the ambiguity rule (§5.4) applies.

Near the crossing of two curves, the true intersection (an explicit point) always outranks the projections.

### 5.4 Ambiguity and precision

**Point tools.** If two or more point candidates, explicit or implicit, lie within 8 pt of each other, a tap does not guess. It opens Precision mode automatically:
- A loupe (ø 132 pt) placed away from the finger, magnified 4–8× so that candidates end up ≥ 24 pt apart.
- Candidates are numbered. The reticle slides at ¼ finger speed; lift commits.
- For an implicit candidate, the reticle slides **along** its curve.

**Select (cross-class cycling, item 1).**
- The candidate list for a tap is: points within 22 pt, segments within 16 pt (including trimmed ghosts), and the region containing the tap.
- Order: points, then segments, then regions, each ordered by distance.
- The first tap selects the head of the list. If the list has more than one entry, the cycle chip shows the class and position ("Segment · 2/4").
- Another tap within 10 pt and 1.5 s advances through the list, crossing classes. On desktop, Tab advances.
- The floating tag near the selection names the current class and state (e.g. "Segment · construction", "Region · filled", "Point · intersection").

**Fair and Fill** also use the cycle chip, within their own class only.

**Tiny arcs** (< 12 pt on screen): the hit band widens to the arc's chord ±16 pt, and a "Zoom here" chip is offered.

**Snap feedback:** signal ring plus crosshair ticks, and `navigator.vibrate(8)` where supported.

**Point visibility modes:** All · Near finger (default) · Used · None. Below 60% zoom, available points hide and construction thins to 0.6 px.

## 6. Repeat

### 6.1 Entering Repeat (item 6)

- The motif is the active colourway's fair geometry plus fills, referenced live and never copied. Construction never appears in Repeat.
- **There is no forced lattice default.** On first entry, the Lattice chips show with **none selected** and the master motif alone, with the prompt "Choose a lattice".
- A hexagon, square or triangle frame marks its matching chip with a small brass dot and the caption "suggested". A circle frame suggests nothing.
- The first chip the user chooses is persisted. After that, entering Repeat restores it.

### 6.2 Model

```ts
RepeatSystem {
  family?: 'square'|'rect'|'brick'|'triangle'|'hex',
  a: vec2, b: vec2,            // stored; family constraints re-imposed after every edit
  rowOffset: number,           // brick, 0..1
  motif: { rotation, scale },
  rule: { kind: 'same'|'alternate'|'mirror'|'around', rotation?, order? },
  footprint: 'design'|'frame',
  overlap: 'stack'|'clip', showStrokes: boolean,
  gapFills: Map<GapSig, Colour>
}
```

**Family constraints:**
- square: |b| = |a|, b ⟂ a
- rect: b ⟂ a
- brick: rect plus rowOffset
- triangle and hex: b = rot60(a)

**The pattern's translation lattice** is the lattice generated by a and b, extended by the rule's orbit period:
- alternate and mirror double one period;
- around uses the lattice point's orbit.

Every exporter and the gap computation use this translation lattice, not the raw (a, b).

### 6.3 Footprint (item 10)

The footprint is the shape used for contact detents, overlap hatching and gaps.

- **Design footprint** (default): the union of filled faces, plus the fair strokes buffered by half their stroke width (round joins).
  - Arcs are flattened to polygons with a chord error ≤ 0.25 px at export resolution.
  - The result is a multipolygon with holes.
- **Stroke-only motif** (fair strokes, no fills): the footprint is the buffered strokes alone, so contacts are stroke-to-stroke.
- **Disconnected motif**: the footprint keeps every component. Contacts between any component of one copy and any component of another count.
- **Frame footprint** (View sheet option): the frame polygon or circle. It is for motifs whose parts float and should repeat by their frame. Available whether or not the frame is design-enabled.
- **Empty footprint** (nothing faired): Repeat shows "Fair something in Construct to repeat it", and the handles are disabled.

### 6.4 Direct manipulation (unchanged interaction, now precise)

- **Arm handles** on neighbours a and b: dragging a handle changes that vector; the other follows the family constraint. The ring is dashed brass with a knob.
  - Tangential drag rotates the motif, with detents at 360° / lcm(motif order, lattice order). Motif order comes from the active symmetry source, or 1 if there is none.
  - Radial drag scales the motif.
- **Row grip** (brick): drag sideways, with detents at ¼, ⅓ and ½.
- **Neighbour rule chips:** Same · Alternate · Mirror · Around. A non-Same rule gives the second orientation class its own ring.
- Pinch and two-finger pan are view only.

### 6.5 Contact detents

While a handle is being dragged, parameterise the drag as s (the handle's distance from the master along the pointer's ray, or the scale factor for a radial ring drag). Against **all first-ring copies**:
- Compute the separation function sep(s) = the minimum distance between the master footprint and the union of the neighbour footprints (negative for penetration depth, found with GJK/EPA on convex parts or polygon-clipping area as a fallback).
- **Touch detents** are the roots of sep(s) = 0, found by sampling s in 1 pt steps across the visible range and then bisecting.
- **Tip detents** are the values of s where a footprint vertex of one copy coincides with a footprint vertex of another within 0.5 px. Only vertices that are themselves points of the motif (not flattening artefacts) are considered.
- **Labels:** "Edges meet" (touch with a collinear contact edge), "Tips touch" (vertex–vertex), "Touch" (any other contact), "Overlap" (sep < 0 between detents).
- Snap within 6 pt of a detent. Every detent shows as a brass tick on the arm. No numbers appear by default.

### 6.6 Gaps (item 11)

1. Let F be the fundamental cell of the **translation lattice** (§6.2), half-open.
2. Enumerate every transformed copy — every lattice translation × every orientation class of the neighbour rule — whose footprint bounding box intersects F expanded by the largest footprint radius.
3. U = the union of those footprints. G = (3×3 block of F) − U.
4. The gap faces are the connected components of G **whose interior sample point lies in F**. This gives each gap exactly one representative, including gaps that straddle cell edges.
5. **Gap classes** are orbits under the lattice translations. Gaps related by the neighbour rule's rotation or mirror are also one class when the rule is not Same.
6. Tapping a gap selects its whole class (signal-light tint, signal outline) and offers palette swatches.
7. Gap fills are keyed by a class signature: area, perimeter, and sorted vertex distances from the centroid, rounded to 0.1 px. They are recomputed on every change; when the geometry changes, a fill carries over to the best-matching class, or is dropped with a toast.
8. **Overlap:** while dragging past contact, overlapping areas are hatched in signal. On release, the default is `stack` (the master's orientation class on top); `clip` clips each copy to its Voronoi cell of the lattice.

## 7. Export (item 12)

**Construct:**
- Include: Design · Design + construction · Construction
- Background: Plaster · Transparent · White
- Format: SVG · PNG 1×/2×/4×

**Repeat:**
- Area: Visible · Seamless tile
- Background: as above
- Format: as above

**Seamless tile**
- **SVG** may use the true lattice cell: a `<pattern>` whose `patternTransform` maps the unit square to the translation-lattice parallelogram, plus a preview `<rect>` filled with that pattern. The pattern includes gap fills.
- **PNG** always uses a **rectangular supercell**, aligned with lattice vector **a** (the artwork is rotated by −angle(a) for export):

| Family | Supercell |
|---|---|
| square / rect | the cell itself: \|a\| × \|b\| |
| brick, offset p/q in lowest terms (q ≤ 12) | \|a\| × q·\|b⊥\| |
| triangle / hex | \|a\| × √3·\|a\| (it contains two lattice points) |
| rules that double a period | double the matching dimension |

- Pixel size: width W px (default 2048); height H = round(W × aspect).
- The irrational √3 aspect is absorbed by a vertical scale of H / (W·√3) (< 0.03% distortion at W ≥ 1024). This scale is applied before rasterising, so the tile wraps exactly.
- A brick offset that is not within 1e-3 of p/q with q ≤ 12 disables PNG seamless tile, with the note "Snap the row offset to a detent for a seamless PNG".

**SVG layer groups:** `construction`, `extension`, `fair`, `fills`, `gaps`. Arcs use `A` commands, never polylines.

## 8. Undo

- Every committed action is one entry, including an Echo Apply batch, Divide + connect, a trace stroke, Use frame in design, and an entity Delete with its dependents.
- View changes, workspace switches and Preview ghosts are never recorded.
- Undo and redo are available after reload (§9).

## 9. Persistence: local-first (item 13)

**Storage:** IndexedDB, with a database per origin.
- `documents` store: `{ id, name, createdAt, updatedAt, schemaVersion, snapshot, thumbnail }`. The thumbnail is a 256 px PNG blob of the design.
- `history` store: an op log per document.
- `meta` store: last open document id and app preferences.
- On first save, call `navigator.storage.persist()`.

**Autosave:**
- Every committed action appends its op to `history` and schedules a snapshot write, debounced by 300 ms, in a single transaction.
- On `visibilitychange → hidden` and on `pagehide`, flush synchronously-queued writes.
- The "saved" indicator reflects the last successful commit.
- **Compaction:** every 50 ops, write a fresh snapshot and keep the last 200 ops for undo. Undo depth after reload is therefore ≥ 200.
- A write is committed only when its transaction completes. If it fails, show a persistent banner "Not saved — storage full?" with **Export .json** as the escape route. Keep the in-memory state.

**Restore:**
- On launch, reopen the last document in the same workspace, zoom and pan, with the tool reset to Select.
- If the snapshot fails schema validation, fall back to the previous snapshot plus a replay of ops.
- Migrations run on open, keyed by `schemaVersion`.

**Documents:** the top-left menu opens a Documents sheet.
- **Recent:** sorted by `updatedAt`, with thumbnail, name and relative time.
- **New:** opens the frame sheet.
- **Rename:** inline edit. The default name is "Untitled 1", "Untitled 2", …
- **Duplicate:** a deep copy with new ids, named "Copy of …", with its history reset.
- **Delete document:** confirmation, then kept in a 7-day Trash section before being purged.
- **Export .json** / **Import .json:** a portable backup containing the document and its colourways, without history.

**Multiple tabs:** use the Web Locks API (`navigator.locks`) per document id.
- The second tab to open a document gets it read-only, with a "Take over" button.
- Tabs sync through BroadcastChannel on commit.

## 10. Layout (unchanged)

**Phone (390 × 844):**
- From top: safe area 47 · top bar 52 (menu, Construct/Repeat segmented control, Show, Export) · canvas · floating context bar (8 pt above the dock, 56–98 tall) · dock 64 · home area 34.
- Undo/redo pill at bottom-left; Fit at bottom-right.
- Construct dock: Select · Circle · Line · Polygon · Divide | Fair · Fill.
- Repeat dock: Lattice · Neighbours · Gaps · View.

**Tablet (≥ 768 pt):** the dock becomes a vertical rail on the leading edge, and the context bar docks to the top of the canvas.

**Desktop (≥ 1200 pt):** a 72 pt rail with shortcut labels, plus a 300 pt right panel (Selection · Colour · Colourways · Show · Symmetry Echo Off/Preview/Apply).

## 11. Tokens (unchanged)

```
plaster #F3EFE7  paper #FBF9F5  well #E8E2D6  hairline #DCD5C8
ink #1E2A36 (text, active verb, fair default)  muted #56606B
construction #8E98A3 0.9px  extension: dash 4 4  trimmed ghost (Select only): 15%, dash 1 3
brass #8C5E1C (draggable handles, trace preview)  brass-light #EADBBE
signal #2F5BEA (selection, snap, echo ghosts)  signal-light #DCE4FC
selected: 3px signal over an 8px plaster halo  ·  fair default 2.5px ink, round caps and joins, 1–8px
Type: Newsreader (titles) · Bricolage Grotesque (UI) · JetBrains Mono (counts)
Radii: dock 20 · sheet 24 · context bar 16 · chip 12  ·  minimum touch target 44
Roles: Ink = mode · Brass = handle · Signal = target
```

Curated palettes contain no colour within ΔE2000 < 20 of signal; a custom colour in that range shows a warning.

Palettes: Lapis & Zellige · Terracotta · Monsoon · Sindoor · Athangudi · Channapatna · Mine (≤ 8).

## 12. Remaining implementation assumptions

These are decisions the build should confirm, or change deliberately.

1. **Geometry kernel.** Double-precision analytic intersections for line–line, line–circle and circle–circle, with a fixed relative ε, and no exact or rational arithmetic. Near-tangent circle pairs (discriminant within ε) produce one merged point, not two.
2. **Polygon operations** (buffer, union, difference) use a robust clipping library on flattened geometry (e.g. Clipper2 via WASM, or `polygon-clipping`). Region faces for **Fill** use true arcs in the DCEL; only the Repeat footprint and gaps are flattened.
3. **No point dragging in v1.** Definitions are parametric, so dragging free points or frame size could be added later without changing the data model.
4. **Division anchor** for a circle with no points on it is the frame's alignment angle. Users who need another start can place an on-curve point first.
5. **Symmetry sources** consider only circles concentric with the frame. Off-centre rosettes (e.g. corner motifs) get no Echo in v1.
6. **Trace thresholds** (35°, 12° margin, 24 pt lookahead, α = 0.35) are starting values and need tuning with real students on real phones.
7. **Contact detents** sample s at 1 pt screen steps within the visible range. On very complex footprints (> 5 000 vertices), fall back to sampling every 3 pt, and compute tip detents only on drag end.
8. **Gap signatures** are metric, not topological: two differently shaped gaps with the same area, perimeter and radial profile would share a fill. This is considered acceptably rare.
9. **The PNG seamless vertical scale** for hex and triangle lattices introduces at most 0.03% distortion. SVG remains exact.
10. **Storage limits.** Typical documents are well under 1 MB. No cloud sync, accounts or collaboration in v1. iOS Safari may evict storage for sites not added to the Home Screen when `persist()` is denied, so the app should encourage "Add to Home Screen" and periodic Export .json.
11. **Haptics** are Android-only (`navigator.vibrate`); iOS gets no haptics.
12. **Repeat performance.** Copies are rendered via a single cached motif (Canvas 2D `Path2D`, or SVG `<use>`) up to about 400 visible copies. Beyond that, render the translation-lattice tile as a pattern fill.
13. **Accessibility.** Keyboard and screen-reader support covers chrome, sheets and Select-mode cycling. Construction by keyboard alone is out of scope for v1.
