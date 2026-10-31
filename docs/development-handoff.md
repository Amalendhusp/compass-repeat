# Development handoff — Construct → Intersect → Repeat

Keep this short and current. It is a starting point, not a substitute for reading the code.

## Where things are

- **Branch:** `feature/integration-a-d` (from C1 `6b8e300`). Latest commit: see `git log -1`.
- **Accelerated cycle (approved 2026-10-31):** Stages A–D, one or more commits per stage, no merge/push/deploy.

| Stage | Scope | Status |
|---|---|---|
| C1 | Individual construction colouring | done — `6b8e300` (branch `feature/c1-construction-colouring`) |
| A | Colour-before-drawing (top-bar swatch) | done — see `git log` "Stage A" |
| B | F0 shared geometry foundation | done — see `git log` "Stage B" |
| C | Close Gap integration (from `feature/close-gap-poc` `f75482a`) | done — "Stage C 1/2" + "Stage C 2/2" |
| D | Intersect Form Development (independent Primary) | next — D1 data model |

## Protected — never modify, merge into, push or deploy

- Public `main` / `origin/main`: `c9096bd`
- Geometry Explorer pilot (`../Geometry-Explorer - Git`): `f94f1a7`
- Free lattice: `feature/phase1-2-free-lattice` `f4f0c18`
- C1: `feature/c1-construction-colouring` `6b8e300`
- Close Gap PoC: `feature/close-gap-poc` `f75482a`
- `dist/phone-import.html`, `dist/plate113.json` (phone import fixtures; never delete)

## Decisions in force

- Repeat lattice handles: completely free; no automatic snapping, ever. Rotation ring keeps its fraction snap.
- Construction colour: optional `colour` on line/circle entities (whole element, incl. dashed extension
  tails; trimmed circle = one colour). Frame never coloured. Fair colours independent. Intersect keeps
  instance colours (its magnifiers stay grey). Repeat never draws construction.
- Stage A: top-bar swatch beside Menu (Construct only). Nothing selected → sets
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

## Known limitations

- At 375 px a long selection ribbon scrolls sideways (existing pattern).
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

## Exact next step

Stage D, checkpoint D1 — the independent Developed Primary data model, with legacy compatibility:
`doc.intersection.form = { developed: DevelopedSegment[] }` (absent = legacy: Intersect Repeat = all instances,
exactly as now), `copies[key].primaryCopy?: boolean`; `repeatComposition` returns, for a `form` artwork,
'0,0' Original (promoted by default) + promoted copies + a 'developed' member (owner 'developed', identity pose)
whose features come from the stored segments. No UI yet. Prove: legacy artworks' Repeat fingerprints unchanged.
Then D2 Intersect Fair display mode, D3 segment splitting, D4 tap add/remove, D5 Primary-copy, D6 Repeat
composition + empty state, D7 Timelapse/export/regression.

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
