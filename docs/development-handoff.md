# Development handoff — Construct → Intersect → Repeat

Keep this short and current. It is a starting point, not a substitute for reading the code.

## Where things are

- **Branch:** `feature/release-candidate` (release refinements R1–R5, from `feature/final-sprint` `d331b1f`, which the
  user tested on iPhone and approved). Latest commit: see `git log -1`. Remote: `origin`
  https://github.com/Amalendhusp/compass-repeat.git — nothing pushed.
- **Release cycle (2026-11-01):** R1 point-first · R2 Intersect Fair from construction/extension · R3 Intersect
  arrangement popover · R4 Repeat Fill / handles · R5 participant info + export attribution. One commit each; no
  merge/push/deploy; stop for iPhone approval. No further features this cycle.

| Stage | Scope | Status |
|---|---|---|
| C1 | Individual construction colouring | done — `6b8e300` (branch `feature/c1-construction-colouring`) |
| A | Colour-before-drawing (top-bar swatch) | done — see `git log` "Stage A" |
| B | F0 shared geometry foundation | done — see `git log` "Stage B" |
| C | Close Gap integration (from `feature/close-gap-poc` `f75482a`) | done — "Stage C 1/2" + "Stage C 2/2" |
| D | Intersect Form Development (independent Primary) | done — D1–D7 (see `git log` "Stage D") |
| Fill | Enclosed-space detection + Fill interface (after the user's device test, 2026-10-31) | done — F1, F2 (see `git log` "Fill F") |
| UI-1 | Working draft vs saved artworks; Recover last session; Menu simplified | done — see `git log` "UI-1" |
| UI-2 | Contextual Appearance panel (top right): construction / Fair / Fill preferences | done — "UI-2" |
| UI-3 | Intersect: Reference into Menu; eye keeps the sliders | done — "UI-3" |
| UI-4 | Repeat: rules row, Construct/Intersect source, Motif/Space Fill, master guide toggle | done — "UI-4" |
| S1 | One Fill: Intersect-unit regions, no Motif/Space choice, gap marks | done — "Sprint S1" |
| S2 | Top-left Appearance (Fill · Stroke · Background), Fill toggle, preferences in the draft | done — "Sprint S2" |
| S3 | Interlaced strokes (Single · Banded · Interlaced, over-under, crossing reversal) | done — "Sprint S3" |
| S4 | Integration, regression, iPhone release candidate | done — "Sprint S4" (features frozen) |
| R1 | Point first: a selected point feeds Line (A) / Circle (centre); Divide keeps it selected | done — "Release R1" |
| R2 | Intersect Fair: develop from construction and extension segments too (Fair only · Construction · Extensions) | done — "Release R2" |
| R3 | Intersect: Spread / Reference / Save arrangement / bookmarks in the bookmark popover | done — "Release R3" |
| R4 | Repeat: Fill on the lower row; grid/handle icon = back to geometry | done — "Release R4" |
| R5 | Optional participant info; export attribution (default off) | done — "Release R5" |

## Protected — never modify, merge into, push or deploy

- Public `main` / `origin/main`: `c9096bd`
- Geometry Explorer pilot (`../Geometry-Explorer - Git`): `f94f1a7`
- Free lattice: `feature/phase1-2-free-lattice` `f4f0c18`
- C1: `feature/c1-construction-colouring` `6b8e300`
- Close Gap PoC: `feature/close-gap-poc` `f75482a`
- Accelerated A–D + Fill: `feature/integration-a-d` `cf5b038` (A–D `cb28659`; Fill `f927427`, `4434caf`)
- UI phase: `feature/ui-refinement` `cbb5ee4` (UI-1 `27b5ceb`, UI-2 `353c44e`, UI-3 `d86b54b`, UI-4 `cbb5ee4`)
- `dist/phone-import.html`, `dist/plate113.json` (phone import fixtures; never delete)

## Decisions in force

- Repeat lattice handles: completely free; no automatic snapping, ever. Rotation ring keeps its fraction snap.
- Construction colour: optional `colour` on line/circle entities (whole element, incl. dashed extension
  tails; trimmed circle = one colour). Frame never coloured. Fair colours independent. Intersect keeps
  instance colours (its magnifiers stay grey). Repeat never draws construction.
- Stage A (moved by UI-2 to the top RIGHT, beside Share, and made contextual): top-bar swatch (Construct only). Nothing selected → sets
  `doc.toolPrefs.constructionColour` (a drawing preference: not Undo, saved with the artwork); new
  entities inherit it in `addEntity` / `addArc` (`doc.ts`). Construction selected (Select tool) → the same
  swatch recolours the whole selected elements (one Undo step) and never changes the drawing colour; a
  blue ring shows that mode. The C1 ribbon Colour chip was removed.
- Close Gap (approved direction): Fair geometry only, no frame fallback, geometric gaps (stroke-independent),
  positive gaps only, designer selects (tap-near-gap, ≤3 local valid candidates, nearest previewed, magnified
  preview), one arm changes minimally, full-arrangement validation at Fair-run level (moved crossings harmless;
  lost/new crossings, broken contacts invalid; <3° or unmatched = uncertain → rejected with a reason),
  tolerance 4 % of one motif's own Fair reach, Apply = one Undo step, Cancel changes nothing.
- Intersect Form Development D1–D12 (see the 2026-10-30 approval): Fair in Intersect develops an independent
  Primary; Line/Circle/Divide keep editing the Construct source (needs a clear ownership cue); `'0,0'` = Original,
  included in Repeat for new arrangements; split at Fair intersections only; tap add/remove (Undo), reuse
  loupe/chooser; coincident segments drawn once (provenance kept); promoted copies' segments selectable, no
  doubled strokes; per-member Fill in V1; bookmarks keep positions/transforms/Primary-copy flags, not Developed
  geometry; legacy artworks keep identical output; empty-state card; one Primary stroke style; no snapping to
  Developed Primary yet.

- Sprint S1 supersedes the Fill interfaces below: ONE Fill (no Motif | Space | Done). Fill chip on → tap any
  enclosed region; the app decides region-of-the-design vs space-between-copies; Fill chip again → off. Pattern
  stays hidden (its data and drawing kept).
- Fill (2026-10-31): Repeat's Fill is one entry point with scopes Space | Motif | Pattern; colour and opacity
  live in Appearance → Fill (shared by all scopes). Space = an enclosed space between copies (and every one like
  it); Motif = a region of the motif in every copy; Pattern = a region in the second group (every other copy, row
  or column) — kept as its own scope because it is the only one that makes two-colour patterns. Hair-line gaps
  between copies narrower than 2 % of the motif radius count as closed for Space (region-finding only).

## Known limitations

- At 375 px a long selection ribbon scrolls sideways (existing pattern).
- (Fixed in S1: regions formed by the Developed Primary, or jointly by several Intersect members, can be filled.)
- No snapping to the Developed Primary (D12). The Developed Primary is one style (ink); per-segment styling is not in V1.
- A bookmark restores the arrangement and In Repeat states, never the Developed Primary (D8).
- Copies moved after developing leave the Developed Primary where it was (by design); its segments can still
  be removed by tapping them.
- Not yet tested on a physical iPhone (Stage D was tested by the user on their device; the Fill build not yet).
- Space: gaps wider than 2 % of the motif radius are open (Close Gap closes them); Motif fill of regions formed by
  the Developed Primary is still per member (above). Pattern applies to motif regions, not to spaces.
- Space fills keep their own opacity; Appearance's "Motif fills" strength applies to motif regions only (as before).
- Undo does not revert Repeat background (display settings are outside history — existing behaviour).

## Shared services (Stage B)

- `src/geometry/fairGeometry.ts`: exact Fair primitives (line = two ends; arc = centre, radius, start,
  sweep), `motifPieces`, `motifRuns`, `placePrim`/`placeAll`, `hits`/`relate`/`crossingsOf` (tangency judged on
  centre/line distance), `insideOutline`, `nearPairs`, `motifScale`. Extracted unchanged from the Close Gap PoC.
- `src/geometry/repeatComposition.ts`: `repeatComposition(doc)` (members: key, pose, owner) and
  `compositionFeatures(doc, 'pieces' | 'runs')` (ids `${member}|${motif id}`, with source). `repeatUnit` now
  reads its members from here. Stage D adds the 'developed' owner and Primary-copy opt-in here.
- Proof: `scratchpad/f0-equivalence.mjs` (Node) — identical to the PoC on all fixtures and 20 000 random
  line/arc pairs; Intersect-source Repeat fingerprint identical with old and new `repeatUnit`.

## Close Gap in the app (Stage C)

- Grid and guides → "Close gap…" → `controller.closeGap = { phase: 'pick' }`; Repeat panel row shows
  "Tap near a gap" · Cancel. A tap (`repeatTool.ts` `closeGapTapGesture`) → `interaction/closeGapMode.ts`
  `gapsAtTap` (cached per Doc: `findGaps` + `validate`; valid only; reach 28 px) → preview phase with ≤3 local
  gaps (chips "1·A 3.0"), `describeGap` ("A moves 3.00"), Apply (one commit setting the arm) · Cancel.
- `repeatRenderer.ts` draws the corrected arm while previewing (never stored) and `drawCloseGapInset` (tapped copy
  held still: current dashed, proposed solid, brass meeting dot, arm label). Rotation ring hidden in the mode.
- Handles stay completely free: in the mode a handle drag works as always and returns to picking.

## Form Development data model (Stage D1)

- `types.ts`: `doc.intersection.form?: { developed: DevelopedSegment[] }` (segment = exact `geom` line/arc +
  `origins` provenance); `copies[key].primaryCopy?: boolean`.
- `intersection.ts` `formMode(doc)`: `'form'` (form stored) · `'legacy'` (an arrangement stored, or Intersect
  source used, without form — Repeat = every instance, exactly as before) · `'new'` (never arranged nor
  repeated from Intersect — treated as form). Nothing is converted on load (history shape unchanged).
- Every arrangement write goes through `baseOf` — keeps all fields (the Developed Primary above all) and records
  an empty form for a 'new' artwork. Bookmark restore uses `withArrangement` (D8: Developed geometry kept).
  `switchRepeatSource` to Intersect records the form for a 'new' artwork.
- `inComposition(doc, key)`: legacy → all; else Original `'0,0'` unless `primaryCopy === false`, copies only when
  `primaryCopy === true`. `asForm(doc)`: legacy → every current instance promoted (output unchanged).
- `repeatComposition`: filters by `inComposition` and adds member `'developed'` (owner 'developed', identity pose)
  when there are segments; `developedFeatures` gives exact features. `repeatUnit` lists construct members only
  until D6 draws the Developed Primary.
- Note: older test fixtures (e.g. "Regress P11 intersect") use keys `'primary'`/`'copy-1'`; they are legacy, so
  every instance is included.
- Regression: `scratchpad/suite.js` `start()` → poll `window.__reg` (fingerprints, interrupted-touch, smoke, Guide).
  Guide baseline is `line:true circle:true divide:false buildOn:true fair:true fill:true repeat:true share:false`
  (the two `false` are harness timing, identical at every baseline).

## Intersect Fair display mode (Stage D2)

- Fair is no longer a linked tool in Intersect (`main.ts` LINKED_TOOLS); Intersect + Fair → `intersectFairTool`
  (`interaction/tools/intersectFair.ts`; D2: taps do nothing, never touch the Construct source or history).
- `intersectionRenderer.ts`: with Fair as the tool, `drawFairOnly` (each copy's Fair strokes, alpha 0.3, own colour;
  no construction, no extensions, no rotation ring). `drawDevelopedPrimary` always, over the copies: ink 3.2 px on
  a 1.6 px paper casing (the Original's copy colour is ink itself, so the casing keeps the Primary apart). Nothing
  drawn when there are no developed segments → legacy output identical.
- Ownership tag (`shell.ts` `refreshOwnerTag`, `.owner-tag`): top-centre of the canvas while a tool is in hand in
  Intersect — "Construct source · every copy follows" (Line/Circle/Arc/Divide; thin light mark) or "Developed
  Primary · Intersect's own geometry" (Fair; heavy ink mark). Fair's ribbon in Intersect has no Colour/Width
  (those style Construct's Fair).
- Test helper: `scratchpad/staged-app.js` (`starDoc` two squares at 45°, `save`, `intersectFair`, `tapWorld`, `ownerTag`).

## Segments and tap add/remove (Stages D3–D4)

- `geometry/formSegments.ts` `formSegments(doc)`: every copy's Fair RUNS placed, split where Fair meets Fair
  (crossings, touches, T-junctions, overlap ends), coincident pieces merged with all origins; `developedAlong`,
  `geomOf`, `developedPrim`, `samePiece` (tolerance `formEps` = motif scale × 1e-6, ×10 for identity).
- `interaction/formPick.ts`: `formPicksAt` (developed segments → remove; segments not yet in the Primary → add;
  reach 16 px), `commitPick` (one Undo step through `asForm`; a legacy artwork starts Form Development with every
  copy promoted and a toast "Developing the Primary · every copy stays in Repeat"). `controller.formPress`.
- `tools/intersectFair.ts`: tap = add/remove the one candidate; crowded (next candidate within 7 px) → tap opens
  the "Which line?" chooser (`lineChoice` with `shape`), hold 380 ms → loupe (precision.ts helpers exported:
  `loupeCentre`, `spreadMarkers`, `LOUPE_R`, `MARKER_GAP`, `SWITCH_PX`); moving >10 px or a cancelled touch does
  nothing. Renderer exports reused: `fanMarkers`, `drawNumberBadge`, `drawLabelPill`, `RUN_COLOURS/DASHES`.
- Copies panel: the first construction is now labelled "Original" ('Primary' names the Developed Primary).

## Primary-copy (Stage D5)

- Copies panel (Intersect): columns Copies · In Repeat · Extensions. "In Repeat" = `inComposition`; a tap commits
  `withPrimaryCopy(d, key, on)` (through `asForm`: a legacy artwork starts Form Development with every other copy
  kept). The source motif is never touched. The Original can be demoted.
- Fair mode draws Primary-copies at alpha 0.62, reference copies at 0.3.
- `withArrangement` (bookmark restore): a bookmark recording no `primaryCopy` flags keeps the current flags.

## Repeat composition, Timelapse and export (Stages D6–D7)

- `repeatUnit` now has `developed: Prim[]` (Developed Primary minus segments lying along a Primary-copy's Fair
  run — no doubled strokes), extent and key include it; `drawDeveloped` in `repeatRenderer.ts` (ink, Fair default
  width or Repeat's stroke layer, via `makePath` so SVG export works). Fit (`main.ts`) includes it.
- Empty composition: `.empty-composition` card in Repeat ("Nothing to repeat yet", Back to Intersect → Fair,
  Use Construct → `switchRepeatSource(motif)`).
- History: `describeChange` tags Developed Primary edits `intersect-primary`; Timelapse framing (`drawnBox`)
  includes developed segments. The whole `doc.intersection` (form included) is already in every recorded state.

## Fill: enclosed spaces and the Fill interface (F1–F2)

- Cause of "No enclosed spaces yet": `spaces.ts` joined copies only where they met within 0.3 % of the motif
  radius. With free lattice handles, copies that look touching miss by a fraction of a unit, so each space leaked
  through the gaps into the next and none was bounded (reproduced: star motif tip to tip — exact or overlapping →
  found; 0.5 units short → none).
- F1 (`spaces.ts`): after crossings and T-junctions are split, `findBridges` adds BRIDGE pieces between different
  lattice copies across gaps ≤ `GAP_FRACTION` (2 %) × motif radius: vertex → nearest vertex or point on the other
  copy's piece; skipped where the two copies already meet within 2·gap, and where it would cross another piece.
  Bridged slivers narrower than the gap are dropped. Bridges never enter `signature`, so a Space's key is the same
  closed exactly or across a gap (Close Gap keeps its fill). `SpaceClass.gap` = widest bridge.
- F1: strokes come from the Repeat composition — Construct: `motifStrokes`/`computeFairRegions` exactly as before;
  Intersect: `compositionFeatures(doc, 'pieces')`, members split where they cross, unit faces (`unitFaces`) as its
  own regions, keys prefixed `unit|`. `repeatRenderer` draws Space fills for both sources.
- Compatibility: on all 131 saved artworks every existing Space class and Space fill is unchanged (only the
  deliberate hair-line-gap fixture "CG teeth alternate" gains one space). ~20 % slower to compute (cached).
- F2 (`shell.ts`, `repeatTool.ts`): Fill chip → `● [Space | Motif | Pattern] · Done` (`setFillScope`, session
  `lastFillScope`; Space = `controller.spaceMode`, Motif/Pattern = `repeatColourMode`). Bottom-row Colour / Opacity /
  As designed / Space chips removed. Appearance → Fill: colour swatches (No fill), Opacity (next fill), Clear (current
  scope), Motif fills (old global Fill opacity), "Fill on the canvas…". `doc.repeatPaint` gains `opacity`;
  `repeatFill()` = colour with alpha (100 % → exactly the old stored colour). `spaceDefaults` is no longer used by
  the UI (kept in data).
- Taps: Space now recolours with a different colour and clears with the same colour or No fill (like Motif). A Motif
  tap in a space / a Space tap in a motif names the right scope; a gap-closed space says so once when filled.
- Identity (point 4 of the request): Motif regions are keyed by the construction's face signature (entities), so
  lattice spacing never moves them; Spaces by which copies' which curves bound them (lattice offsets relative to
  the space), so spacing that keeps the arrangement keeps the fill, and a changed arrangement hides it (never moves
  it); each Repeat source keeps its own fills. Developed Primary segments have stable ids (`developed|dN`).
- Tests (git-ignored): `scratchpad/fill-app.js` — `starMotif`, `lattice`, `starArtwork(name, gap, rule)`,
  `tapWorld`; old detector kept as `scratchpad/spaces-old.ts` for comparisons.

## UI-1: saved artworks and the working draft

- Before UI-1 every artwork was autosaved into its own `documents` record from its first frame, so every
  experiment appeared in My Artworks; `named` only recorded that a name was given. Save provenance of existing
  records cannot be established, so EVERY existing record stays listed; the new rules apply from now on.
- `persist/draft.ts`: one working draft in `meta.workingDraft` — doc, Undo/Redo, view, thumbnail, `savedBase`,
  `baseHash` (artwork-state fingerprint of the saved version or of a new artwork's bare frame; `captureState`, so
  view / tool preferences / name never count), `dirty`. Autosave (`autosave.ts`) writes only this slot, never a
  `documents` record; it never replaces another artwork's unsaved draft with a clean one.
- `main.ts`: `writeSaved` (Save / Save As) writes record + history + thumbnail + `processMeta` (process-history
  summary at that save) and `lastOpenDocId`. `confirmLeave` asks "Save changes to …?" (Cancel · Don't save · Save)
  before New / Open / another frame replace unsaved work; a leftover draft from an earlier session is asked about
  ("Discard the unsaved session?"). Discard = clear the slot + `rollbackProcess` to `processMeta` (never-saved:
  `deleteProcess`); legacy records without `processMeta` keep their process history (resync handles it).
- Save As from a saved artwork: the work in hand becomes the new artwork (process copied, Undo kept); the original
  record is untouched and its process rolls back. Save As on a never-saved artwork = Save with a name.
- Launch: a dirty draft → Start screen at My Artworks with **Recover last session** (dashed brass card, Discard);
  a clean draft that still matches its saved record → reopened as it was (view, Undo); else `lastOpenDocId`.
- Beginner Guide: the work in hand is kept in the draft and reopened from it on exit (unsaved changes kept).
- Gallery card of the open artwork says "Open now · unsaved changes"; Menu heading adds "· unsaved".
- Menu: New · Open… · Save · Save As… (Reference joins in UI-3). Point targets / Show points are kept (with their
  saved values) but only offered with `?dev` in the address (`DEV_MENU`, shell.ts).
- Rename changes only the saved record's name (and the live name); Duplicate copies the saved version; Delete of
  an artwork also clears its draft.
- Harness: `scratchpad/start-app.js` `answerLeave()` and `divide-app.js` `open()` answer the new prompt with
  "Don't save" (test edits are never kept). UI-1 tests: `scratchpad/ui1-app.js`; shared checks (exports, Undo/Redo,
  Timelapse): `scratchpad/ui-checks.js`.
- Results: new work not listed; refresh → one Recover entry; Recover restores work + Undo; Save adds one entry;
  editing a saved artwork leaves its record unchanged; Discard keeps the original (process head back to the save);
  Save As independent; Cancel / Don't save / Save; Guide round trip keeps unsaved work. Whole suite: Plate 113,
  intersectSourceRepeat, colourC identical; cancel 16/0; smoke all true; Guide baseline; and NOT ONE of the 136
  stored artwork records changed during the suite (previously autosave rewrote them). PNG/SVG export, Timelapse
  (8 frames, playable), Undo/Redo fine; prompt checked at 375 px.

## UI-2: contextual Appearance control (Option B)

- `shell.ts` `ccBtn` / `showConstructAppearance` (`.appearance-panel`): Construct only, in `rightSide` before Share.
  Kind follows the tool: Fair → "Fair colour · new strokes" (Default = ink) + "Fair width" slider (1–8, default
  2.5); Fill → "Fill colour · next fills" + "Fill opacity" (10–100 %, default 100 %); anything else →
  "Construction · new lines, circles, arcs" (Default + palette + custom). The dot shows that kind's colour (Fill
  with its opacity). Select with construction selected → also a "Selected · whole line/circle/N…" section
  (recolour = one Undo step, `setEntityColour`), above the drawing section; the drawing colour never changes from it.
- The Fair tool's and Construct Fill tool's ribbon Colour / Width / Opacity chips are gone (the ribbon hides when
  empty). The Select ribbon's chips for a selected Fair stroke / region (recolour that selection) are unchanged.
- Preferences (`toolPrefs.constructionColour`, `fairDefaults`, `fillDefaults`, `repeatPaint`) are never Undo steps.
  (Superseded by Sprint S2: they no longer go into the saved record at once — see S2.)
- Results (375 px): independent kinds; no Undo steps for preferences; new line / circle take the construction colour;
  Fair stroke #C98A2C @ 4 px; Fill `#C98A2C80` at 50 %; selection recolour one Undo (Undo/Redo exact) and the
  drawing colour untouched; prefs survive Don't-save + reopen; rows fit at 375 px. Suite: fingerprints identical,
  cancel 16/0, smoke all true, Guide baseline, no stored record changed; PNG/SVG, Timelapse (1031 frames) fine.
  (Plate 113's fill preference was changed during the test and put back to `#1E3A6E` / 100 %.)
- Not in UI-2: the swatch is Construct-only (Intersect's linked Line/Circle/Arc still draw in the construction colour
  set in Construct).

## UI-3: Reference into the Menu

- The canvas-row image button (`referencePanelBtn`, `.reference-btn`) is no longer added, in any workspace. The
  same panel (`showReferencePanel`: this workspace's Show / Reference % / Artwork %, Transform…, Remove from
  artwork, Reference Library with Edit, + Add to library, + Image for this artwork only) opens from Menu →
  **Reference image…**, anchored at the Menu button. Nothing about references or their storage changed.
- The eye stays on the canvas row (only while the artwork has a reference); it shows / hides the two right-hand
  vertical sliders, now captioned **Image** and **Artwork** (`verticalSlider(..., caption)`).
- Bookmarks (Snapshots) untouched. Spread and its **Reference** text button (sets Spread's reference arrangement —
  a different thing from the reference image) stay exactly where they were; the shared word is flagged for review.
- Old git-ignored harness files `anchor-app.js`, `modal-app.js`, `refxf-app.js` still tap `.reference-btn`
  (not part of the suite): open the panel through Menu → Reference image… instead.
- Results (375 px): Menu shows New · Open… · Save · Save As… · Reference image…; panel opens, a library image
  applied, Transform → Move image | Anchors | Done, Done locks; eye toggles the captioned sliders; reference kept.
  Intersect: bookmark panel opens; Fair tap develops the Primary (one Undo); save/reopen keeps it; PNG/SVG,
  Timelapse, Undo/Redo fine. Suite identical / 16/0 / all true / Guide baseline; no stored record changed.

## UI-4: Repeat simplification

- Rule row: Uniform | Alternate | Mirror only. Source row: Construct | Intersect (no "Source" word) and then
  **Fill** as its own outlined action chip with the Fill icon (`.fill-action`). Source default stays Construct
  (`repeatSourceOf`); switching keeps each source's lattice and never touches either design.
- Fill row: Motif | Space · Done (`colourKindRow`). Pattern is hidden: no button; an old "last scope" of Pattern
  opens Motif. Pattern fills / grouping stay in the data and draw exactly as before (no renderer change).
- Top bar in Repeat: left = Menu only; right = master guides toggle · contextual control · Share. The old top-left
  Appearance button is no longer shown: the contextual control (`ccBtn`) shows the Appearance icon (Stroke |
  Background panel, `showRepeatAppearancePanel(..., 'look')`) — or, while filling, the Fill colour dot (Fill colour ·
  next fills, Opacity, Clear for the current scope, Motif fills strength — `'fill'`). Fill colour/opacity appear
  nowhere else (the bottom dot chip is gone). Background stays an appearance setting; changing it leaves Motif and
  Space fills untouched (checked).
- Master toggle (`.guides-master`, gridGuides icon): ON whenever any of grid / handles (rotation ring, A, B) /
  motif boundary shows; OFF hides all three and remembers which were on (`rememberedGuides`, per artwork, this
  session); ON brings exactly those back (default handles + boundary). A view setting, never Undo.
- Canvas-row button (`handles-btn`, new `tune` icon, "Grid settings"): Grid · Handles · rotation, A, B · Motif
  boundary (individually), Reset lattice, Close gap… The "All guides" row was removed (the master replaces it), so
  master and individual settings cannot disagree. Close Gap unchanged; it works with every guide hidden.
- Results (375 px): rows as above; contextual panel look/fill; new colour → Space fill `#C6402C99` and Motif fill,
  one Undo each; Background change leaves fills identical; master off/on (remembers grid on + handles off);
  Close gap with guides hidden → Apply moved A 201 → 200, Undo exact; source switch keeps the Construct lattice;
  Intersect-source Motif fill. Suite identical / 16/0 / all true / Guide baseline; no stored record changed;
  "Repeat pattern D" PNG/SVG, Timelapse (18 frames), Undo/Redo fine. `git diff cf5b038 -- src/render src/geometry
  src/interaction src/model` is empty for the whole UI phase.
- Harness: `scratchpad/ui4-app.js`.

## Sprint S1: one Fill (root cause, correction, gap marks)

- **Root cause of "Not a closed region of the design" (Intersect source)** — computational, not geometric. Repeat
  had two separate region models: Motif fill (`regionAtInRepeat`) knew only the Construct motif's own Fair faces,
  applied member by member; Space (`spaces.ts`) traced the whole unit's faces (`unitFaces`) but used them only to
  EXCLUDE points from Spaces. A region bounded by the Developed Primary (no Construct faces at all), or jointly by
  several members, was therefore in neither model. Reproduced (`scratchpad/fillx-app.js`): Developed-Primary-only
  star → every region "not closed"; Developed + Original → the developed tips unfillable and the centre filled the
  whole square; legacy two-square star → every tap filled a whole square, never the piece tapped.
- **Correction (smallest, no migration)**: `spaces.ts` `unitRegions(doc)` promotes those same unit faces to
  fillable regions — traced from the exact composition features (members placed + Developed Primary, arcs finely
  sampled as Space does), split where members cross, holes from other parts lying inside (evenodd), cached per
  unit geometry (lattice-independent). Identity `face:` + boundary signature (which member's which piece, in order,
  direction; `#n` only for an identical signature). Nothing flattened, merged or stored besides the colour.
- `repeatColour.ts` `fillTargetAt` — the one tap: Construct source → motif region (as before) else Space; Intersect
  → the unit region under the tap in the top lattice copy; if it is exactly one member's own face (area within
  0.5 %) it keeps that face's legacy key `instance|sig` (old fills still toggle and stay tied to the construction),
  else `face:…`; else Space. Fills go in `repeatSetup.colour.regions` (same map, same toggle/Undo); drawn by
  `repeatRenderer.ts` `drawUnitRegionFills` over member fills, under every line, in the sprite and exports.
- Stability: unit regions never depend on the lattice; a changed arrangement changes the signature → the fill is
  hidden, never moved; each source keeps its own fills; legacy per-member fills are untouched and still drawn.
- **Gap marks** (`geometry/repeatGaps.ts` `fillOpeningsAt`, read-only): only when curves cover ≥ 75 % of the turn
  round the tap; (1) curve ends touching nothing (between copies a ≤ 2 % hair-line counts as closed, as for Space)
  and visible from the tap; else (2) near misses: rays escaping past 3× the median distance pass between two curves
  that do not meet → their closest points (≤ 20 % of motif radius) marked, joined by a dashed hairline — never an
  invented endpoint. `controller.repeatGapMarks` (session; cleared by the next tap, leaving Fill, or any commit);
  drawn screen-only as 7 px alert rings. Distinct from Close Gap (which moves a lattice arm).
- UI: Fill chip (`colouringBtn`) toggles Fill (`repeatColourMode = 'motif'`); while on, the row is a dark Fill chip
  carrying the current Fill colour dot (tap = finish) + "Tap any enclosed region". `spaceMode` is no longer set.
- Tests (`scratchpad/fill1-app.js` 20/20): closed square; star tip and centre from crossing segments; Developed
  Primary only; Developed tip + Original; Original face keeps key; joint region of two members; space between
  copies; space between Intersect units; open square → both ends marked; crossing / X → nothing marked; tangent
  circles → space; 4 % near miss → miss marked; wide spacing → nothing; coincident duplicate side; partly
  overlapping sides (overlap and remainder); lens and crescent of two circles. Live (`fill1-live.js`): Developed
  star filled in every copy by a tap, one Undo, Undo/Redo exact, same colour clears, open tap marks nothing wrongly,
  SVG carries the fill, PNG, save → reopen keeps it; Construct: one Fill fills a motif region and a space; open
  shape → 2 rings, no Undo step; row fits at 375 px. Plate 113 taps: region ≤ 1 ms, open-ground diagnosis ≤ 15 ms
  (grid + angular ray buckets; was 143 ms). Suite: fingerprints identical, cancel 16/0, smoke all true, Guide
  baseline. PNG/SVG, Timelapse (8 frames), Undo/Redo fine. (The suite's touch tests need a ≥ 1100 px viewport.)
- Limits: a unit region that equals a member's face uses the legacy key only when the member on top there owns it;
  an old whole-member fill under a newly split region stays (clear it with Clear in the Fill panel); hair-line
  bridging applies between lattice copies only (not inside one unit), as before.

## Sprint S2: Appearance and UI finalisation

- **Top-left Appearance in Repeat again** (`appearanceBtn` in `leftSide`, Repeat only): `showRepeatAppearancePanel
  (anchor, controller, tab?)` with **Fill | Stroke | Background** (session `appearanceTab`, default Fill). Fill = the
  colour (No fill + palette + custom) and Opacity a Fill tap applies next (`repeatPaint`), **Clear Repeat fills**
  (regions + spaces, one Undo; Pattern's hidden fills and the construction's own fills kept); "Region fills" (the old
  global `repeatDisplay.fillOpacity`) only shows for an artwork where it is not 100 %. Stroke and Background as before
  (Background never touches fills).
- The top-right contextual control (`ccBtn`) is Construct only now (Line/Circle/Arc construction colour, Fair colour
  and width, Fill colour and opacity, selection recolour) — Intersect and Repeat hide it; no duplicate Fill colour.
- Fill toggle: the Fill chip (Source row) turns Fill on; while on, the row is `[■ Fill]` (dark, tap = finish) ·
  colour swatch (40 px target; shows the colour and opacity applied next; tap = Appearance → Fill) · "Tap any enclosed
  region" (paper pill). No Done, no scopes.
- **Save / draft persistence (2.4)**: `persistPrefs` no longer writes preferences into the saved record; it flushes
  the working draft. `draft.ts` `prefsHash(doc)` (construction colour, Fair default, Fill default, Repeat paint);
  `dirtyTracker(base, prefsBase)` counts a preference change as unsaved for a SAVED artwork (`prefsBase` null for a
  never-saved one); the draft stores `prefsBase`; `writeSaved` rebases both; `bootDraft` takes the draft's
  `prefsBase` (an older draft without it: its own preferences, which the old code had already saved). Repeat
  background / stroke / fill strength were already artwork state (dirty, saved only by Save).
- Tests (`scratchpad/s2-app.js`, 375 px): top bar left Menu · Appearance, right guides · Share, nothing clipped;
  panel 8–338 px, tabs Fill/Stroke/Background; swatch opens Fill tab. Persistence: open saved artwork → Fill colour +
  Background changed → saved record unchanged, Menu "· unsaved", draft dirty → reload → Recover card → recovered
  with both changes; record still original → leave with Don't save → reopened original (no fill colour, original
  background, clean). Preference only (Fair colour in Construct): no Undo step, "· unsaved", record unchanged,
  "Save changes?" on leaving, Don't save → original colour; Save → record has it, draft clean. Suite: fingerprints
  identical, cancel 16/0, smoke all true, Guide baseline; digest of all 142 stored records identical before/after.

## Sprint S3: interlaced strokes

- Scope: Repeat's Stroke style (the drawn bands of the repeated design — Construct source, Intersect source, the
  Developed Primary and Primary-copies alike). Construct and Intersect workspaces draw lines as before.
- Data: `RepeatStroke.weave?: { on, flips[] }` (types.ts) — absent in every older artwork (rendering unchanged).
  `repeatStroke.ts`: `StrokeKind` + `'interlaced'`, `weaves()`, `withBands(1|2|3)`, `withFlip(key)`; `withKind`,
  `withWidth`, `withColour` keep `weave` (reversals survive a style change and coming back).
- Panel (Appearance → Stroke): **As designed · Single · Banded · Interlaced**; Banded/Interlaced → **Bands** (Banded
  2|3 — the old Double/Triple; Interlaced 1 plain | 2 edged | 3 edged + centre line); layer rows (Edge/Band/Centre:
  colour + width, existing controls); Interlaced → status ("N crossings · alternating over and under" / "· K can't
  alternate" / "· R reversed") and **Reverse crossings…** → canvas mode (`controller.weaveEdit`): row `[Crossings]`
  (tap = finish) + cue; rings at every crossing in view (brass = reversed, orange = can't alternate); a tap within
  24 px reverses that crossing in every copy (one Undo step, `repeatTool.ts` `weaveTapGesture`). Fill / Close Gap /
  leaving Repeat / another style end the mode.
- Network (`geometry/weave.ts` `weaveNetwork`, cached per geometry + lattice; skipped while a handle / ring is dragged
  or Close Gap previews): copies around the reference (≤ 160) → `spaces.ts planarSubs` (extracted from `traceFaces`,
  unchanged: split at crossings between copies/members, points on pieces, coincident pieces once). Vertex: 2 pieces
  → band runs on; 4 pieces in two straight-through strands (≤ 50° from straight) alternating round it → crossing;
  else junction (flat). Ids: the two strands' pieces with copy offsets relative to the crossing (shift by the period
  only, as Space signatures), `#n` for repeats at different places in the copy — every copy of a crossing is one
  class. Weave: per class one unknown; consecutive crossings along a strand must alternate → parity union–find;
  contradicting constraints are not forced and both classes are flagged (`conflict`). Period = lattice (Uniform) or
  every-other-copy sub-lattice (Alternate / Mirror) — so a plain grid alternates under Alternate, not under Uniform.
- Drawing (`repeatRenderer.ts` `drawWeave`, inside the artwork layer after all bands): per crossing, the over strand's
  piece (`strandPiece`, through bends and arcs, never past half-way to the next crossing) redrawn layer by layer with
  butt caps, long enough to cover the under band (`(W/2)(1+cos)/sin`); one band: first a background-colour
  parallelogram exactly over the under band's crossing (the gap), then the over band. Every instance via
  `periodTranslations`. makePath throughout → PNG, SVG, Timelapse identical to the canvas.
- Tests (`scratchpad/weave-app.js`, 14/14): two bands; '#' checkerboard; reversal local; two squares 8 crossings;
  two circles 2; circles + line 6; tangency → none; T → none; Intersect squares 8; Developed outline alone → none
  (it never crosses itself); overlapping copies 20; plain grid Uniform → conflict reported; Alternate → alternates;
  ids stable under a spacing nudge (160 → 162). Export probes at a crossing (PNG): 1 band → background gap in the
  under band; 2 / 3 bands → under band cut by the over band's edge, over band (and centre line) unbroken; reversed →
  swapped; Intersect and Developed Primary + promoted copy correct. Live: Interlaced from the panel (one Undo), 20
  crossings alternating; Reverse crossings → tap → 1 Undo, Undo/Redo, Finish; save → reopen keeps the reversal (same
  id); SVG +1 path per band layer; Timelapse (7 frames) playable. Plate 113 (dense): 197 classes, 16 can't
  alternate, 3303 junctions; network 210 ms once per change (≈ 40 ms to recognise an unchanged one); woven export not
  slower than flat.
- Limits: three or more lines through one point, T-junctions and touching corners are drawn flat; very shallow
  crossings (< 10°) are drawn as at 10° (the piece may not cover fully); one-band gaps use the Background colour (a
  transparent PNG shows it); conflicts are reported, not resolved (reverse by hand); reversals whose crossing no longer
  exists are kept in the data and ignored; the network is rebuilt after each lattice change (~0.2 s on Plate 113 on
  desktop — expect more on a phone).

## Sprint S4: integration and iPhone release candidate

- Chain in the app (`scratchpad/s4-app.js`). Intersect source: two-square star in Form Development → Intersect Fair,
  16 outline taps → 16 developed segments, 16 Undo steps, owner tag "Developed Primary" → Repeat (Intersect), spacing
  170 (copies overlap) → one Fill: a developed star tip (`face:` key) and the centre (the Original's own key) →
  Interlaced from the panel: 12 crossings, alternating → PNG / SVG, Undo/Redo, Timelapse (23 frames) → Save → an
  unsaved Background change → reload → Recover: change, weave, fills, Developed Primary, 20 Undo steps all back;
  saved record still has the old background. Construct source: Fair star, spacing 160 → Fill tip + centre →
  Interlaced (20 crossings) → exports, Undo/Redo, Timelapse (6 frames). Close Gap ('square, small gap along A') with
  every guide hidden: preview → Apply moves A 144.42 → 141.42, Undo exact.
- Regression after each stage (S1–S3) and at S4: Plate 113 / legacy Intersect-source / coloured construction
  fingerprints identical; cancel 16/0; smoke all true; Guide baseline; digest of every stored artwork record identical
  before and after the suite (142–144 records). Fill tests 20/20, weave tests 14/14. Type-check and production build
  clean.
- 375 px: top bar Menu · Appearance | guides · Share; Appearance panel 8–338 px, Stroke segments all fit; Fill row and
  Crossings row fit; nothing clipped.
- iPhone build (temp dir, `index-BXXhE8eU.js` / `index-DrX1Jkwo.css`); fixtures unchanged (`2350b02c56`, `5d4b82fd7d`);
  phone-preview on 5189 → http://192.168.1.5:5189/compass-repeat/ (HTTP 200, new assets, no console errors).
- Not tested on a physical iPhone (simulated touch and 375 px emulation only).

## Release R1: point first

- `controller.ts` `setTool`: when the tool changes from Select with exactly one existing point selected (Construct
  only), Line gets `pending = { kind: 'line', a: point }` and Circle (By radius) `pending = { kind: 'circle', centre:
  point }` — the same state a first tap makes, so the next tap completes it exactly as tool-first does (preview, A's
  continuations on the ribbon, one Undo step, no new point). Divide (its first input is a curve): the point simply
  stays selected; nothing started. Other tools, other circle variants, Intersect / Repeat: as before (selection
  cleared). Changing the tool again, or a Circle variant / Line guide, cancels the pending step (never executes it).
- Tests (`scratchpad/r1-app.js`, real taps): A → Line → tap B: one line A–B, 0 new points, 1 Undo, Undo/Redo exact;
  A → Circle → tap C: circle centred on A, same new points as the tool-first circle (2 and 2 on a fresh square);
  A → Divide: tool Divide, A still selected, nothing pending or made; A → Line → Circle: nothing made; tool first
  Line unchanged; Circle with nothing selected: nothing pending. Suite identical / 16/0 / all true / Guide baseline.

## Release R2: Intersect Fair from Construction and Extensions

- Ribbon in Intersect with Fair: **Fair only · Construction · Extensions** (`controller.formLayer`, session; default
  Fair only). Drawing (`intersectionRenderer.ts` `drawFairOnly(…, layer)`): each copy's Construction pieces thin
  (alpha 0.55) and, with Extensions, its extension pieces dashed, under the translucent Fair strokes; the loupe too.
- Geometry reuses the one segment engine (`formSegments(doc, layer)`, cached per Doc and layer):
  `fairGeometry.ts` `motifPieces(doc, kind)` gives Construction / Extension pieces (state as drawn —
  `effectiveSegmentKind`; trimmed never) between the points on each line/circle; every copy's pieces are placed and
  split wherever they meet anything offered; Fair runs are split exactly as before (only where Fair meets Fair) — so
  Fair only is unchanged and Fair segments are identical in all three layers. Coincident pieces merge, all origins
  kept; `FormSegment.kind` (fair > construction > extension); `FormOrigin.kind` / stored
  `DevelopedSegment.origins[].kind` ('construction' | 'extension'; absent = Fair, as before).
- Taking a piece stores its exact geometry (independent of the source); nothing is joined, closed, recoloured or
  changed in the construction. Tap / chooser / loupe / remove / Undo exactly as before (`formPicksAt(…, layer)`).
- Tests (`scratchpad/r2-app.js`): Fair only has only Fair; Fair identical across layers; the construction diagonal
  offered as 8 bounded pieces (≤ 70.7 of 200) with source; live: Fair only tap on construction takes nothing;
  Construction takes the 70.7 piece (1 Undo, origin kind construction); Extensions takes the 40.7 piece beyond the
  line's end (origin kind extension); construction (entities + segment states) untouched; tap again removes; Undo/
  Redo. Suite identical / 16/0 / all true / Guide baseline.
- Limits: the frame circle counts as Construction (offered too); extension pieces are those between points on the
  extended line (never an unbounded tail); a construction piece is not split at Fair it merely touches inside a copy
  unless a point is there.

## Release R3: Intersect arrangement controls in the bookmark popover

- The Spread row (`ixSpreadRow`: Spread slider · value · Reference) is no longer on the canvas; the top-right bookmark
  button opens `showIntersectionSnapshotsPanel(…, { spreadRow, refresh })` (`.arrangement-panel`): **Arrangement**
  (the same Spread row element, with its stale / "Set ref." behaviour; a hint "Reference: this arrangement becomes
  Spread 100 %"), **Reference image** Show switch (Intersect's own visibility; only when the artwork has a
  reference image; a view, never Undo), then **Snapshots** (Save this arrangement, list, restore, delete) unchanged.
  The popover closes when leaving Intersect. Bookmark data model and D8 (no Developed Primary in bookmarks) unchanged.
- Tests (`scratchpad/r3-app.js`, 375 px): no Spread on the canvas; popover 14–367 px; Spread 150 % (1 Undo, label
  150 %); Reference → 100 %; Save → 1 bookmark, popover stays open; change → restore → spread back.

## Release R4: Repeat Fill and the way back to the handles

- Fill chip (lowest row, after Construct | Intersect, a 14 px gap and a hairline): off = plain paper button (no
  outline, normal weight, `aria-pressed=false`), on = ink. The shell resets it to off whenever Fill is not on (it
  stayed "active" when Fill was left by another route — fixed).
- Top-right grid icon (`.guides-master`): reads OFF while a canvas mode has the canvas (Fill, reversing crossings,
  Close Gap). A tap then leaves that mode and shows the handles (rotation, A, B) with the guides that were on (or the
  remembered ones; handles always on) — display only, no Undo. Otherwise unchanged: on → hides handles, grid and
  boundary (remembered); off → back. Handles stay completely free (no snapping).
- Tests (`scratchpad/r4-app.js`, 375 px): Fill off look (paper, pressed false); Fill on (ink, icon off); a fill; icon
  → Fill off, handles on, chip off; icon → all hidden, Undo depth unchanged; icon → handles back; Fill chip still
  ends Fill.

## Release R5: participant information and export attribution

- Data: `Doc.participant?: { name?, email?, phone?, attribution?: { on, text } }` (types.ts `ParticipantInfo`). Not
  artwork (not in `captureState`, never Undo — carried across Undo in `controller.swapTo`); counted in `prefsHash`
  (draft.ts), so for a saved artwork a change is an unsaved change: kept in the working draft, saved only by Save /
  Save As. Absent in every older artwork. No analytics, no upload, no sharing.
- UI: Menu → **Participant & attribution…** (`ui/artworks.ts` `openParticipantSheet`, a bottom sheet): Name or
  participant code · Email · Phone (all optional), **Include attribution in export** (off by default) and, when on,
  **Attribution text** (suggested "Created by <name>"). Done applies (toast), Cancel changes nothing.
- Drawing (`render/attribution.ts`): only `attribution.text`, only when on; bottom-right, 9–15 px, text with a thin
  opposite-tone halo (no box) — light/dark by the ground; transparent exports keep a transparent ground. PNG/SVG:
  `export.ts drawArtwork` (SVG: `SvgContext.text`, `paint-order="stroke"`). Timelapse: on the final frame only
  (`frameRenderer().attribution`), held `CREDIT_HOLD` 1.25 s longer.
- Tests (`scratchpad/r5-app.js`): sheet fields; attribution off by default; suggestion "Created by P07"; after Done
  the artwork is "· unsaved" and the saved record unchanged; SVG has `<text>Created by P07</text>`, no email, no
  phone, no `<rect>` when transparent; transparent PNG corner: only glyphs + halo opaque (24 % of the box, 0 % when
  off); Undo keeps it; Timelapse playable (9 frames, 5.8 s); Save writes it; off again → no text, details kept;
  sheet fits at 375 px.

## Release candidate: final regression and build (2026-11-01)

- Full suite: Plate 113 / legacy Intersect-source / coloured construction fingerprints identical; interrupted-touch
  16/0; smoke all true; Beginner Guide baseline; digest of all 160 stored artwork records identical before/after.
  Fill 20/20, weave 14/14; R1–R5 tests pass; chain (Intersect: develop 16 → Fill → Interlace 12 crossings → PNG/SVG,
  Undo/Redo, Timelapse 23 frames; Construct: Fill → Interlace 20 → exports, Timelapse); Close Gap with guides hidden
  (Apply, Undo exact); Save As leaves the original unchanged; reload → Recover → unsaved change back, record not.
- iPhone build (temp dir): `index-tMPIdqHe.js` / `index-BLapttXc.css`; fixtures unchanged (`2350b02c56`,
  `5d4b82fd7d`); http://192.168.1.5:5189/compass-repeat/ (HTTP 200, new assets, no console errors).
- Not tested on a physical iPhone by me.

## GitHub Desktop release checklist (for the user — do not run without their approval)

1. Repository: `Amalendhusp/compass-repeat` (local folder `Compass-Repeat - Git`). Branch: `feature/release-candidate`,
   HEAD = `git log -1` (code at `6629ea5`, then this handoff). It is 84+ commits ahead of `main` (`c9096bd`) and based
   on it (merge base = `c9096bd`): no divergence, a clean merge.
2. Publish the branch (GitHub Desktop → Publish branch) — this alone deploys nothing.
3. Open a pull request: base `main` ← compare `feature/release-candidate`. Review the diff; leave the intermediate
   branches (`feature/final-sprint`, `feature/ui-refinement`, `feature/integration-a-d`, …) as they are.
4. **Deployment implication:** merging into `main` (any push to `main`) runs `.github/workflows/deploy.yml`, which
   builds and deploys the PUBLIC site to GitHub Pages (https://amalendhusp.github.io/compass-repeat/) within minutes.
   Merge only when the iPhone review is approved.
5. Existing users of the public site keep their artworks (IndexedDB on their device; nothing is migrated or deleted).
   After the update, autosave keeps a working draft instead of adding Gallery entries (UI-1); older artworks open
   unchanged. Participant information stays on each device; nothing is uploaded.
6. The Geometry Explorer student pilot is a separate repository — unaffected.
7. After merging: check the Actions tab (Deploy to GitHub Pages: success), open the public URL on the iPhone, hard
   refresh once, and test one saved artwork.

## Interface refinement (November 2026) — branch `feature/interface-refinement`

Branched from the published `main` (9a4ea59); no upstream, never pushed to `main`. Staged plan approved by the
user (D1–D9 as recommended). Do not merge or deploy without explicit approval.

- **Stage 1a — Fair independence.** Line in Intersect no longer offers Promote to Fair (`line.ts` offerAfterLine,
  `shell.ts` ribbon guard). Intersect Fair writes only `doc.intersection.form.developed`, as before.
- **Stage 1b — selection first = tool first** (`interaction/selectionFirst.ts`, used by `controller.setTool`, Construct
  only). A Select selection gives the tool chosen next the same first input a tap would: point → Line (A), point →
  Circle By radius (centre), point → Arc (Measure: A; Same radius: the compass opens on it), segment / run / line /
  arc / circle → Divide (target previewed, never applied). A point under Divide stays selected, as before. A
  selection a tool can't start from is cleared with a short message (`controller.onNotice` → toast). Nothing is
  made until the tool's next input. Divide's target helpers moved to `interaction/divideTarget.ts` (unchanged).
- Checks: `scratchpad/refine-tests/stage1.mjs` (isolated headless Chrome on port 9334, dev server 5188), touch at
  390 × 844 and mouse at 1280 × 800 — 29/29 each.
- **Stage 2a — reflection-aware placement maths** (`lattice.ts`: composePose mirror = XOR, relativePlacement,
  inversePoint, poseVector(Inverse), poseArcRange). Intersect linking / snapping / Match Edge use them;
  `instanceCamera` refuses a reflected pose. Repeat unit cache key includes reflection (only when set).
- **Stage 2b — Intersect copy reflection.** `layout.pieces[].mirror?: true` (written only when true; never the
  Original; never a locked copy). `withReflection(doc, key, 'h' | 'v')`: ↔ → mirror toggles, turn → π − turn;
  ↕ → mirror toggles, turn → −turn (twice = identity; both = half turn). Construction tools never draw through a
  reflected copy (main.ts `activeCopy` falls back to the Original; a touch on one → notice). Temporary Reflect
  buttons under a copy's colour swatches until Stage 3.
- **Stage 2c — Repeat rules.** `rule.flip?: 'h'` (mirror only: reflect across the motif's vertical axis = mirror +
  half turn) and `rule.by?: 'rows' | 'columns'` (absent = every other copy, i + j odd, as always). Shared helpers
  in `lattice.ts`: `alternationOf`, `isAlternateCopy`, `evenShift`, `ruleKey` (= `rule.kind` for every older rule,
  so Space keys / caches are unchanged). Space periods (`patternPeriod`): rows → (a, 2b), columns → (2a, b).
  Close gap bases per alternation. UI: Transformation (As drawn · Rotate 180° · Reflect ↔ · Reflect ↕) and
  Apply to (Alternating · Rows · Columns, shown only while something changes).
- Stage 2 checks (`scratchpad/refine-tests/`): `stage2-math.mjs` 17/17; `stage2-ui.mjs` 36/36 touch and mouse;
  `stage2-features.mjs` (Plate 113: Space colours, Fill targets, interlacing, Close gap, PNG/SVG under every new
  rule and with a reflected copy in the Intersect source); `stage2-timelapse.mjs`; `compat-compare.mjs` (Plate
  113 on published main — `preview_start main-baseline`, a `git archive origin/main` copy in the session
  scratchpad on port 5191 — vs the branch: drawing, Space keys and crossings identical under Uniform /
  Alternate / Mirror / turned motif / Intersect source); `compat-saved.mjs` (an artwork saved by the release,
  opened and re-saved by the branch: identical record).
- **Stage 3 — Intersect panels.** Copies panel (`showIntersectionCopiesPanel`): "Arrangement · moves all copies"
  (the shared Spread row + Reference, and a hint that follows it — `ixSpreadHint`), then one row per construction
  (`.copy-row[data-copy]`: colour, name, tags In Repeat / ⇋ Reflected / turn° / Locked / No extensions). A row
  selects that copy on the canvas and opens its settings (Include in Repeat, Show extensions, Reflect ↔ / ↕, Colour,
  Remove); the canvas selection opens with the panel. Original: no Reflect / Remove. Bookmarks popover: Save
  arrangement + the list only (stored data unchanged: `intersectionSnapshots`); reference-image visibility stays in
  Menu → Reference image…. Checks: `stage3-ui.mjs` 33/33 touch and mouse (shared setup: `setup.mjs`);
  `compat-saved.mjs` also restores the release's bookmark through the new popover.
- **Stage 4 — one colour control; Repeat rows.** The top-right control (`selectionColouring`, Construct + Select):
  with a selection it shows the selection's colour (a small wheel when mixed) and edits only it — one swatch row for
  construction lines (Entity.colour, the whole line or circle — said so) and Fair pieces (stroke) together, Fair width
  when Fair pieces are included, Fill (No fill, opacity kept) + Line for a Fair region; one Undo step each. Nothing
  selected: the tool's drawing colour as before (Fair width, Fill opacity kept). The Select ribbon's Colour / Width
  chips are gone. `colourSwatchRow(current = '')` lights no swatch (mixed). Repeat panel, top to bottom: Source ·
  Transformation · Apply to · Fill (own row `.fill-entry-row`); Space colouring's alternation reads "Colour every other:
  Copy · Row · Column". Checks: `stage4-ui.mjs` 39/39 and `stage4-region.mjs` 7/7, touch and mouse.
- **Baseline correction:** the published release's Plate 113 Repeat fingerprint is `b6c2014136565e92·4729`
  (measured on main 9a4ea59); the `c25d06fd…·4321` value below predates the last release changes.
- **Transformation caption** (commit after Stage 4): a small visible "Transformation" label above Repeat's four
  choices (`.rule-line .row-caption`, aria-hidden — the group already has that accessible name). Display only.
  Check: `label.mjs` 7/7.

## Project files (November 2026) — `src/persist/projectFile.ts`

One artwork, complete and editable, as a single `Name.compass-repeat.json` file for another browser or device.

- **Controls.** Menu → Save project file… (the work in hand, unsaved changes included) and Open project file…; My
  Artworks → Open project file… (works on a device with nothing saved) and card ⋮ → Save project file (the saved
  version). Never in Share, which stays PNG / SVG / Timelapse.
- **Format v1.** `{ format: 'compass-repeat-project', formatVersion: 1, app, exportedAt, contains, check, payload }`.
  `payload.artwork` = name, named, dates, schemaVersion and the Doc exactly as stored (Maps `{__map}`, Sets `{__set}`,
  non-finite numbers `{__num}`); `payload.reference` = the reference image's record and its working copy as a data
  URL. `check` = `check64` (64-bit, cyrb-style) of `JSON.stringify(payload)` — re-indenting keeps it valid, any
  content change fails. Not included: Undo history, process / Timelapse history, email, phone.
- **Export.** Built first, then a sheet "Project file ready" (name, size, reference included / not on this device,
  what is left out) with Share… (only where `navigator.canShare` accepts this very file — iOS Safari) and Download.
  The file is handed over from the tap on that button, so the share sheet keeps its user activation.
- **Import.** `readProjectFile` does everything in memory: size, JSON, format, version (newer → "Made with a newer
  Compass Repeat"), check, `snapshotProblem` (frame, points, entities and their references, Maps, Repeat, view,
  bookmarks, underlay), `upgradeSnapshot`, then a test drawing (every point resolves, `artworkHash`,
  `makeThumbnail`); the image is decoded (`createImageBitmap`) and its library thumbnail redrawn. Refused files show
  a notice with OK only, and storage is untouched. Accepted files ask "Open “Name”?" (notes: renamed because the
  name is taken → "Name (imported)", reference included / missing / damaged, contact details left out); then the
  usual unsaved-changes question (`confirmLeave`). `writeImportedArtwork` writes a NEW artwork (new id, now, no
  history); the image is reused only if this device holds the same bytes, otherwise added with scope `'artwork'`;
  if the artwork write fails that new image is removed again. A missing or damaged image: the artwork opens without
  it and keeps its placement (shown as missing, as before).
- **No storage change.** No database, store, key or version changed; nothing existing is ever rewritten or cleared.
- **Checks** (scratchpad/refine-tests, two isolated Chrome profiles on two origins — A: port 9334 /
  `localhost:5188`, B: port 9335 / `[::1]:5188`): `project.mjs [A] [B]` 63/63 desktop→phone and phone→desktop
  (export → transfer → import → edit → save → reload; drawing fingerprints equal; re-import; 7 refused files with
  storage unchanged; missing / damaged image; contact details; share path with a stubbed share sheet);
  `project-extra.mjs` 8/8 phone and desktop (Menu, card ⋮, Share panel); `compat-project.mjs` — an artwork saved by
  the published release, exported by the branch and opened on device B, draws identically and saves an identical
  record.

## Intersect construction independence (November 2026) — `src/geometry/intersectLayer.ts`

Approved decisions D1 (independent Intersect construction) and D4 (one Extensions switch, later stage); D2
(what Repeat takes from Intersect) awaits approval of its example; D3 (older states kept as they are).

- **Why Construct used to change.** Line / Circle / Arc / Divide in Intersect were Construct's own tools run
  through the active copy's camera (`onActiveInstance`, `instanceCamera`), committing to `doc.points` /
  `doc.entities`; a point taken from another copy became a free point of Construct. Removed.
- **The layer.** `doc.intersection.construction = { points, entities, segmentStates: [key, state][] }` in
  workspace coordinates (plain data: Timelapse's `plain()` would flatten a Map). Absent until something is drawn.
  A layer document (`layerDoc(doc)`, one per artwork state) gives the kernel, tools and renderer a Doc whose
  geometry is the layer's and whose every other field reads/writes the artwork (accessors). Frame: no entities,
  centre `ix_centre` (a hidden free point at the frame centre).
- **Editing.** `layerController(controller)` (a Proxy): `doc` = layer document, `commit` = one commit of the
  artwork writing the layer back through `withConstruction` (which records an empty Form for a 'new' artwork,
  as any first Intersect write does). main.ts wraps the four tools (`onLayer`); shell.ts's ribbon actions use
  `geo()` (Divide preview / Apply, Horizontal / Vertical, Extend). The tools work through the workspace camera.
- **From the copies.** `layerContextPointNear` / `layerContextLinesNear` / `layerCopiesNear` (intersectionLink.ts):
  every copy's points that lie on what it draws (`pointOnDrawn` — divisions and midpoints included, unlike
  Snap's `pointShown`), and crossings between any two drawn pieces, at least one a copy's. Taken, they become
  fixed free points of the layer. Reflected copies work like any other (the "draw on the Original" notice is gone).
- **Fixed.** Moving, turning, reflecting a copy never moves the layer or the developed Fair.
- **Drawn** by Construct's entity renderer (`drawConstructionOnly`) over the copies, under the developed Fair,
  quieter while Fair is the tool; included in Intersect's Fit.
- **Intersect Fair** (`formSegments`): the layer's construction pieces are always offered (its extensions with the
  Extensions setting), split wherever they meet anything offered; origin `copy: 'ix'` ("Intersect construction").
- **Never Construct, never Repeat.** Nothing reads the layer outside Intersect except Undo, the draft, Timelapse
  state and project files (validated: `snapshotProblem`, and every layer point must resolve).
- **Old artworks.** Unchanged: construction drawn in Intersect before this change stays in Construct (no migration).
- **Select / delete / recolour** (`intersectSelect` in main.ts): a press nearer Intersect construction than any
  shown copy (16 px reach, 4 px in its favour) goes to Construct's own Select on the layer; else the copy tool
  (and the construction selection clears). `renderLayerSelectRibbon`: Delete (whole shapes with dependents,
  confirmed; pieces; points). `lens()` points the top-right colour control at the layer. Developed Fair stays.
- **Checks:** `layer.mjs` 22/22, `layer-fair.mjs` 13/13, `layer-select.mjs` 21/21, phone and desktop.

## Intersect Fair composition, Show/Hide and the compact Copies panel (November 2026)

- **What Repeat takes from Intersect** = developed Intersect Fair + whole source motifs in the design. Whole
  motifs are the stored `primaryCopy` flag (formerly "Include in Repeat"), unchanged in meaning: the Original is
  in by default, copies out; a legacy artwork keeps every instance until its first change (asForm keeps them).
  Construction never repeats.
- **Whole motif** (`controller.formWhole`; Fair's ribbon in Intersect, first): a tap toggles a copy's whole motif
  (`withPrimaryCopy`), one Undo step; drawn 0.95 / 0.2 strong / faint while on; overlapping copies → "Which
  copy?" chooser (`LineChoice.title`). Hidden copies are never offered.
- **Show/Hide** (`intersection.copies[key].hidden: true`, absent when shown; `withHidden`, `shownCopies`):
  hidden copies are not drawn, picked, snapped to, offered to Fair, fitted or repeated (`repeatComposition`
  filters them). Pose, colour, lock and `primaryCopy` are kept. Bookmarks now record `visibility: true`; an older
  bookmark (none) keeps the copies' current visibility on restore (`withArrangement(…, recordsVisibility)`).
- **Copies panel** (`showIntersectionCopiesPanel`): chips (colour; ⇋ reflected; dashed hidden; ◆ whole motif in
  the design; ring selected) + Add; the selected copy's Colour · Reflect ↔ (`withReflection 'h'` only; never the
  Original or a locked copy) · Shown/Hidden, and Remove; footer: Spread + Reference, one Extensions switch for all
  copies (writes every copy's `extensions`; an older mix shows "Extensions · some copies" until used). Older ↕
  reflections keep their pose and show ⇋.
- **Checks:** `hidden.mjs` 15, `whole.mjs` 18, `copies-panel.mjs` 28, `repeat-cases.mjs` 8 (the four cases),
  phone and desktop; `stage2-ui.mjs` / `stage3-ui.mjs` updated to the chip panel.

## Bounding boxes, Stage 2a: the scale foundation (November 2026)

Plan approved 2026-11-13 (Intersect copy box; Repeat Uniform box, Alternate kept with its old Transformation rows;
no Rows/Columns keyframes yet). Stage 2a adds scale underneath, with no interface yet.

- **Data:** `InstancePose.scale?` (absent = 1). Stored as `layout.pieces[].scale?` (a copy; written only when not
  1) and the existing `repeat.motif.scale` (always 1 until now; now applied). `poseScale` reads malformed values as
  1; `scaleField` keeps 25–400 % and writes nothing for 1. Pivots unchanged: a copy's own frame centre; Repeat's
  frame centre for both sources.
- **Maths** (`lattice.ts`): transformPoint / poseVector scale; inverse, compose and relativePlacement include it;
  `poseLength` for radii and distances. At scale 1 every result is bit-identical (× 1 and ÷ 1 are exact).
- **Callers:** arc radii (placePrim, both renderers), distances measured in a copy's own frame
  (instanceDistances, instanceUnder, contextual pieces), Snap's shown lines (unit direction, extents × scale), hit
  areas and the rotation ring, Intersect bounds and Fit, Repeat reach (visibleInstances, `repeatReach`), Fit,
  circle contact, Spaces / weave / Fill openings / construction spaces / Close Gap tolerances (all × the Repeat
  scale, keys gain `scale:` only when not 1), Spaces' and colouring's inverse, Timelapse bounds.
- **Line weight is constant:** Repeat's screen bitmap is drawn with the scale inside it and stamped with turn and
  mirror only.
- **Fair:** developed Fair is stored geometry and never moves or scales with a copy. A whole-motif copy's Fair is
  its motif placed by its pose, so it scales with it. Repeat's doubled-stroke filter means a developed piece that
  a copy drew at 100 % is drawn again when that copy is scaled.
- **Match Edge:** `EdgePlan.lengthsDiffer` (the middles meet; ends can't). The warning is shown in Stage 2b.
- **Checks:** `scale1-compare.mjs` (checkpoint tag on port 5192 vs branch, and the branch with `scale: 1` written:
  306 exact comparisons over nine scenarios), `scale-math.mjs` 38 (maths; a 2× / ½× copy; the field at ½× / 2× equals
  the 100 % field scaled, for both sources).

## Bounding boxes, Stage 2b: an Intersect copy's bounding box (November 2026)

- **Opening and closing** (`controller.intersectionBox`, session only): a long-press of 450 ms without moving
  (`holdForBox`), or a right-click or Control-click (`PointerManager.onContextPress` → `openBoxAt`), on a copy in
  Select. It opens on the selected copy when the press is on it, else the nearest. It never moves on to the next
  of several overlapping copies; a tap does that. A tap or click outside it, selecting another copy, an alignment
  (Parallel / Point Snap / Match Edge), another tool or leaving Intersect closes it (`openBox` normalises).
- **Box** (`render/copyBox.ts`): canvas-aligned around the copy's frame and Fair and its rotation ring (corners
  stay ≥ 44 px from the ring's handle); kept inside the canvas and above the dock and its buttons
  (`ViewTransform.usableBottom`, set by `getView` while a box is open). Grey ground under the copies; dashed
  outline and handles over everything.
- **Handles**, answered before everything (also before Intersect's own construction, in `intersectSelect`):
  top-left Reflect ↔ (`withReflection 'h'`; never the Original or a locked copy); top-right Delete (`withoutCopy`;
  never the Original); bottom-left Lock / Unlock; bottom-right Scale. Each is one Undo step. Scale is a drag
  (`draggedScale`: proportional to the finger's distance from the copy's centre, 25–400 %, snapping to 100 % within 4 %;
  stored with `withCopyScale`, nothing stored at 100 %). The live draft is `intersectionDrag` mode `'scale'` with
  a readout pill "Scale n %".
- **Copies panel**: Colour · Shown/Hidden (eye) · Reset (`withCopyReset`: 100 %, no turn, no reflection, same
  place; off while locked or as constructed) · Delete (bin; not for the Original). Reflect ↔ moved to the box.
- **Match Edge**: when a scaled copy's edges differ in length (`EdgePlan.lengthsDiffer`), the status line and a
  toast on applying say that the middles meet, not the ends.
- **Timelapse kinds**: `intersect-scale`, `intersect-reflect`, `intersect-reset`, `repeat-scale`,
  `repeat-reflect` (new moments only; recorded histories keep theirs).
- **Developed Fair** is unchanged by any of this. Stored pieces stay where they are, and Intersect always draws
  them. Repeat draws a piece again once a scaled copy no longer draws the same line.
- **Checks:** `box.mjs` phone 41 (touch) and desktop 39 (mouse, right-click, Control-click); `copies-panel.mjs`,
  `stage2-ui.mjs`, `stage3-ui.mjs` updated (Reflect through the box handle; Delete; Reset). `setup.mjs`
  `motifRetry` reloads when headless touch emulation drops a touch during setup.

## Intersect: Duplicate and Reset Intersect (November 2026)

- **Duplicate** (Copies panel, the selected copy: Colour · Shown · Reset · Duplicate · Delete — `withDuplicate`): a new
  copy with the same turn, reflection, scale, colour and Extensions setting, offset right and down by a quarter of
  its frame radius (at its scale). Unlocked, shown, its whole motif not in the design. The Original duplicates as an
  ordinary copy. Off at six constructions. Selected afterwards; one Undo step. Timelapse kind `intersect-duplicate`.
- **Reset Intersect…** (Copies panel footer, confirmed — `withIntersectReset`): back to the Original alone at its
  centre, unturned, 100 % (its colour and Extensions kept); every copy, Intersect's own construction and developed
  Fair removed; a Form Development arrangement whose design is the Original's whole motif. Construct and bookmarks
  are never touched. One Undo step. Off when there is nothing to reset (`intersectResettable`). Timelapse kind
  `intersect-clear`.
- **Checks:** `intersect-extra.mjs` 26/26 phone and desktop; `copies-panel.mjs` and `box.mjs` updated for Duplicate.

## Repeat redesign: Source → Fill and the motif's bounding box (November 2026)

- **Panel:** Undo / Redo (as before, above) → Source (Construct | Intersect) → Fill. Uniform (`rule: same`, As drawn)
  is the default for new work, as it already was in `doc.ts`. Transformation and Apply to are folded away.
- **Legacy alternating rules** are never changed silently: an artwork whose rule alternates (`alternationOf`) keeps
  it exactly and shows a row "Alternating rule · Rotate 180° · every other copy" with **Edit** (shows the old
  Transformation · Apply to rows until Done) and **Uniform** (rule → same, one Undo step). Grid settings →
  **Alternating rules…** opens the same rows on any artwork (`controller.repeatLegacyRules`, session only).
- **Box** (`render/repeatBox.ts`, `controller.repeatBox`, session only): long-press (450 ms) on the central design
  (within its reach of the frame centre) or right-click / Control-click (`openRepeatBoxAt`). Square about the pivot,
  as large as the design reaches (`repeatUnit.extent` or `motifExtent`, × scale) — turning or reflecting never moves
  its corners; frames the whole Intersect composition for that source; kept on screen and above the panel
  (`usableBottom`). Closes on a tap outside, Fill, crossings, Close Gap, hidden handles or leaving Repeat.
  Corners: top-left **Reset** (rotation 0, scale 1, no mirror; A / B kept; off when already so), top-right **Rotate**
  (drag round the centre, by the angle swept, `snapRotation`; readout "Turn 1/6 turn"), bottom-left **Reflect**
  (toggles `motif.mirror`), bottom-right **Scale** (`draggedScale`, 25–400 %, snap at 100 %; readout "Scale n %").
  Each change is one Undo step. Touch order: A / B handles, then the box's corners, then the motif.
- **The ring is gone** (`drawRotationRing`, `rotateRingGesture` removed). Guides panel: "Handles · A, B and the box".
- **Reflection** (`motif.mirror?: true`, written only when on): the motif reflected across its own vertical axis,
  then turned — pose rotation θ + π, mirror; a legacy alternation is applied within it as `composePose` would
  (rotation θ + π − adj, mirror XOR). Absent = exactly the old pose. Space and weave cache keys gain `mirror` only
  when on. Close Gap's inside test turns its tiny ray tilt the other way in a reflected repeat
  (`insideOutline(…, reflected)`), so a reflected design gets exactly the mirror image of the unreflected one's gaps.
- **Constant line weight:** the sprite carries the scale; stamping applies turn and mirror only (unchanged).
- **Timelapse:** `repeat-rotation`, `repeat-reflect`, `repeat-scale`, `repeat-reset`.
- **Checks:** `repeat-box.mjs` 52/52 phone and desktop; `repeat-mirror.mjs` (Plate 113: reflected field = the mirror
  image of the unreflected field with the lattice reflected — Spaces, crossings, Close Gap candidates, Fill
  openings, both sources, Uniform and Alternate; export draws); `ring-check.mjs` (scale1-compare with handles
  hidden: 306/306 identical to the checkpoint — the only change to existing artworks is the ring no longer drawn);
  `label.mjs`, `stage2-ui.mjs`, `stage4-ui.mjs`, `project.mjs` open the folded rules first (`openLegacyRules`).
- **Test harness:** headless Chrome is now stopped every few minutes on this Mac (the updater wakes, then the
  browser is terminated). `refine-tests/run.sh "suite mode" …` starts Chrome in its own session when needed and
  retries a suite once if the browser is lost mid-run.

## Intersect refinement, Stage A: interface simplification (November 2026)

Brief: Select and arrange copies → observe intersections → develop a new motif → repeat it. Stages A–D,
stopping for review after each; Stage A is the interface only (Develop's behaviour is Stage B).

- **Dock in Intersect:** Select · Develop · Spread · Reset (`shell.ts`: Circle, Line, Arc, Divide, Fill and the
  divider hidden there; the Fair button is labelled Develop in Intersect only — Construct's dock is unchanged).
  The construction tools stay in Construct. Intersect's own construction layer from older artworks is still
  drawn, selectable and deletable with Select, and offered to Develop; nothing new can be drawn there.
- **Select:** unchanged — tap selects (rotation handle at once), drag moves, the handle turns, snapping and the
  alignments (Parallel · Join, Point Snap, Match Edge, Lock) as before. Long-press / right-click: the Stage 2b box
  (Reflect ↔, Delete, Lock, Scale). The Original has no Delete and, as decided in Stage 2b, no Reflect.
- **Copies panel** (`showIntersectionCopiesPanel`): a coloured circle per construction (tap = select, on the
  canvas too; hidden copies stay selectable), a small eye under each (Show/Hide, one Undo step, never a change of
  selection; a hidden copy's circle at 20 % opacity), and Add. Removed from the panel: Duplicate, Colour,
  Shown/Hidden button, Reset copy, Delete (it is on the canvas box), Spread, the Extensions switch and Reset
  Intersect. `withDuplicate` / `withCopyReset` stay in `intersection.ts` (Timelapse kinds kept for recorded
  histories); nothing calls them from the interface now.
- **Spread** (dock): a compact column on the canvas's left edge (`.ix-spread-panel`), open while the dock's
  Spread is lit: the percentage, a vertical track (same log mapping, 25–500 %, `withSpreadAround` unchanged; a
  light hold at 100 %), a brass reference line at 100 % with **Ref** beside it (a tap goes back to 100 %), and
  **Set ref.** (`asReference`, as before). A changed set of copies: "Copies changed", the track rests until Set
  ref. Every press on the track may drag (a touch near Ref is often given to it); a still press on Ref = 100 %.
  Closes with Develop, an alignment, or leaving Intersect; opening it from Develop returns to Select.
- **Reset** (dock, confirmed — `confirmIntersectReset`, `withIntersectReset`): the Original and two copies in
  `defaultLayout` (as a new artwork starts), Spread 100 % with that group as reference; other copies, every copy
  setting (lock, hidden, colour, whole motif), Intersect's construction and the developed design removed; the
  Original keeps its colour and Extensions setting. Construct and its Fair, and bookmarks, untouched. One Undo
  step. Off when Intersect is already as it starts (`intersectResettable` now compares with the start). Timelapse
  `intersect-clear` recognises both the new start and the older "Original alone" reset; deleting the one extra
  copy of an untouched start stays a deletion.
- **Wording:** owner tag "Develop · Intersect’s own design (Construct is never changed)"; Develop's hint; the
  empty-composition card points to Develop.
- **Checks:** `stage-a.mjs` 59/59 phone (touch) and desktop (mouse, right-click). `run.sh` now calls
  `/usr/bin/python3` (the Homebrew python3 first on bash's PATH is an x86 build that no longer runs).

## Intersect refinement, Stage B: Develop independent of Construct Fair (November 2026)

Stage A decisions applied with it: the Original is never reflected (it stays the reference); a quiet Delete for
the selected copy in the Copies panel (`.copy-delete`, never the Original; asks first only when the copy's whole
Fair is in the design; one Undo step); Reset Intersect now gives every copy its default colour and Extensions
setting too (`copies: {}`); no permanent Extensions switch; older Intersect construction kept (selectable,
deletable, used in Develop with Construction on); the Spread column sits low on the left on a narrow canvas,
just above the floating controls (`placeSpreadPanel`; top-left on wider screens or when there is no room).

- **Develop ribbon** (`shell.ts`, Intersect + `fair`): the copy it works with (chip with its colour — a tap moves to
  the next shown copy; selection only, never a change to the design), then **Whole · Construction · Extension**,
  always together. The canvas "Whole motif" mode and its "Which copy?" chooser are gone.
- **Whole** (`setWhole` in `interaction/formPick.ts`): the target copy's whole Construct Fair in or out of the design
  — the existing `primaryCopy` flag, unchanged in meaning and storage; turning it on or off forgets that copy's
  exclusions (one Undo step).
- **Exclusions** (`geometry/developExclusions.ts`, `intersection.copies[key].excluded?: { entity, t0, t1 }[]`, written
  only when there is one): a stretch of a Whole copy's Fair taken out of the design, as a range along one Construct
  line (t along A→B) or circle (start angle, start + sweep) — the copy's OWN coordinates, so it follows every move,
  turn, reflection and scale, other copies moving never changes it, and Construct is never touched. Interval
  helpers: `remainingRanges`, `withExcluded` (merge), `withoutExcluded`, `localRange` (a placed segment back into
  the copy's coordinates via `inversePoint`), `cutFeature`.
- **A tap** (`formPicksAt` / `commitPick`): a segment is in the design when a developed segment lies along it or it is
  Fair of a Whole copy not excluded there (`segmentIncluded`, `wholeRefsOf` — Fair origins only). In → out removes
  the developed segment along it and excludes it on every Whole copy it belongs to; out → in restores a Whole
  copy's excluded stretch, otherwise adds the exact geometry as a developed segment (as before). Developed
  segments no offered segment stands for stay removable. The chooser / loupe for crowded taps are unchanged
  (Stage C replaces them); wording "Add to the design" / "Take out of the design".
- **Construction / Extension** (`controller.formConstruction`, `formExtension`, session only): independent;
  `formSegments(doc, { construction, extension })` (a FormLayer string still reads as before). Each shows its
  pieces as quiet guides (1.1 px; Extension dashed; Intersect construction only while one is on) and offers them;
  neither ever changes what is already developed.
- **Editing widths** (`drawDevelop`, intersectionRenderer): every copy's Fair 2 px at 50 % (the source), what is in
  the design 4 px — Whole copies' Fair less exclusions in the copy's colour on a paper casing, developed segments
  in ink cased. Screen px, Develop only; Select draws as before (developed 3.2 px).
- **Repeat** reads exclusions everywhere the composition is used: `compositionFeatures` (Fill spaces, unit regions,
  crossings / interlacing, Close Gap) cuts them out of Whole members (untouched features keep their ids, so every
  artwork without exclusions is unchanged); `repeatUnit` key gains `|ex:…` only when there are any, and
  `notDrawnBy` uses the cut runs; `drawCopy` strokes only the kept ranges (`keptRanges`); `unitSkips` never lets a
  partly drawn stroke stand in for a whole one. Repeat draws with its own stroke settings — never the 4 px.
- **Bookmarks** restore arrangements, not the design: `withArrangement` keeps the current exclusions (as it keeps
  developed segments).
- **Checks:** `stage-b.mjs` 47/47 phone and desktop (ribbon; independent offers; Whole segment out → excluded, not
  developed; back in; non-Whole copy → developed; exclusion through move / turn / reflect / scale; target chip;
  Repeat composition, pixels and one stroke width; Save → reload identical; project file round trip; bookmark;
  Whole off / on; 2 px / 4 px; Delete; Reset defaults; Spread placement). `whole.mjs` rewritten for the ribbon
  (16/16). Suites updated for the new controls (Intersect construction now injected — `setup.mjs` `layerAdd`):
  hidden, layer-fair, layer-select, stage2-ui, stage3-ui, box, repeat-cases. Retired (kept in
  `refine-tests/retired/` with a note): copies-panel, intersect-extra, layer.

## Exact next step

Intersect refinement Stage B is committed locally; stop for the user's review before Stage C (proximity selection:
nearest segment, the selected copy first in a near-tie, non-modal switching for coincident candidates). Do not
merge, push or deploy.

## Commands

- Type-check: `npx tsc --noEmit -p .`
- Dev server (browser pane): `preview_start compass-git-test` → http://localhost:5190/compass-repeat/
- **iPhone build — never `npm run build` in the repo root** (it empties `dist/`, deleting the phone fixtures):
  ```bash
  B=$(mktemp -d); git archive HEAD | tar -x -C "$B"; ln -s "$PWD/node_modules" "$B/node_modules"
  (cd "$B" && npm run build) && rm -rf dist/assets dist/index.html && cp -R "$B/dist/assets" dist/ && cp "$B/dist/index.html" dist/
  ```
  then `preview_start phone-preview` (port 5189) → `http://$(ipconfig getifaddr en0):5189/compass-repeat/`
- Regression (browser console, git-ignored helpers in `scratchpad/`; apply `unthrottle()` and `shim()` first):
  `regress.js` (`smoke`, `cancel('Plate 113 (free test)')`), `directfp.js` (`fingerprints`), `guide-app.js`.
  Baseline fingerprints at 1100×900: Plate 113 construct `114d63ec9c3fa713·29274`, intersection
  `552ae06983044a91·29253`, repeat `c25d06fd94c8c4be·4321`.
