# Development handoff — Construct → Intersect → Repeat

Keep this short and current. It is a starting point, not a substitute for reading the code.

## Where things are

- **Branch:** `feature/ui-refinement` (UI phase, from `feature/integration-a-d` `cf5b038`). Latest commit: see
  `git log -1`. A–D and Fill stay on `feature/integration-a-d` (unchanged).
- **Accelerated cycle (approved 2026-10-31):** Stages A–D, one or more commits per stage, no merge/push/deploy.

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
| UI-4 | Repeat: rules row, Construct/Intersect source, Motif/Space Fill, master guide toggle | next |

## Protected — never modify, merge into, push or deploy

- Public `main` / `origin/main`: `c9096bd`
- Geometry Explorer pilot (`../Geometry-Explorer - Git`): `f94f1a7`
- Free lattice: `feature/phase1-2-free-lattice` `f4f0c18`
- C1: `feature/c1-construction-colouring` `6b8e300`
- Close Gap PoC: `feature/close-gap-poc` `f75482a`
- Accelerated A–D + Fill: `feature/integration-a-d` `cf5b038` (A–D `cb28659`; Fill `f927427`, `4434caf`)
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

- Fill (2026-10-31): Repeat's Fill is one entry point with scopes Space | Motif | Pattern; colour and opacity
  live in Appearance → Fill (shared by all scopes). Space = an enclosed space between copies (and every one like
  it); Motif = a region of the motif in every copy; Pattern = a region in the second group (every other copy, row
  or column) — kept as its own scope because it is the only one that makes two-colour patterns. Hair-line gaps
  between copies narrower than 2 % of the motif radius count as closed for Space (region-finding only).

## Known limitations

- At 375 px a long selection ribbon scrolls sideways (existing pattern).
- Form Development V1 Fill is per member: regions formed jointly by the Developed Primary and Primary-copies
  (or by the Developed Primary alone) cannot be filled yet, and Repeat draws no fills for the Developed Primary.
  Combined-region Fill is a separate investigation (D7).
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
- Preferences (`toolPrefs.constructionColour`, `fairDefaults`, `fillDefaults`, `repeatPaint`) are never Undo steps
  and never count as unsaved changes; `main.ts` `persistPrefs` writes just those fields into the saved record at
  once (`onPrefs`), so reopening a saved artwork remembers them without saving its edits.
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

## Exact next step

UI phase (approved 2026-10-31, Option B — contextual Appearance panel): UI-1, UI-2, UI-3 done; next UI-4 (Repeat:
rules row Uniform | Alternate | Mirror only, Fill separate; source labels Construct | Intersect; Fill = Motif |
Space with Pattern hidden (data kept); Fill colour/opacity only in the top-right panel; Background stays an
appearance setting; top-right master show/hide for handles + boundary + guides; Close Gap unchanged), then a fresh iPhone build and stop for the
user's device review. Do not merge, push or deploy.

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
