# Issue tracker

Findings from the code and UI review of 2026-11-09 (branch `vtp-fixes`, commit `d13865f`).

**How to use:** tick the box when an issue is fixed and add the commit hash after the title.

**Severity:** `P0` can damage a print or printer, or blocks building/deploying · `P1` wrong behaviour, crash or hang · `P2` leak, performance or misleading UI · `P3` cleanup.

**Confidence:** `verified` = re-read in the source or reproduced in the running app · `read` = found by reading the code, not executed · `unconfirmed` = plausible, needs checking on a printer or in the app.

Nothing here was tested on a physical printer. Visual findings come from DOM measurements of a local build, not screenshots.

## Summary

| Area | P0 | P1 | P2 | P3 | Total |
|---|---|---|---|---|---|
| Build and repo (B) | 3 | 1 | 1 | 4 | 9 |
| G-code and toolpath (G) | 5 | 9 | 4 | 2 | 20 |
| Slicer and geometry (S) | 0 | 7 | 4 | 3 | 14 |
| App and GUI logic (A) | 0 | 7 | 7 | 2 | 16 |
| Usability and aesthetics (U) | 0 | 4 | 8 | 4 | 16 |
| Structure (T) | 0 | 0 | 3 | 3 | 6 |

---

## Build and repo

- [ ] **B1 · P0 · verified — `npm start` fails on this checkout.** `webpack-dev-server` and `css-loader` are missing from the committed `node_modules`; `css-loader` is not in `package.json` at all although `webpack.config.js:22` uses it.
  Fix: add `css-loader` to `devDependencies`, stop tracking `node_modules` (B6), run `npm install`.
- [ ] **B2 · P0 · verified — `src/style.css` never reaches a build.** Nothing imports it, so `MiniCssExtractPlugin` emits no CSS. The tracked `dist/style.css` is a March 2025 file with only tippy styles. Result: unstyled panel, 512 px icons (see U1).
  Fix: `import './style.css'` (and `tippy.js/dist/tippy.css`) in `src/index.ts`.
- [ ] **B3 · P0 · verified — `npm run deploy` publishes whatever is in local `dist/`.** No build step runs first; the bundle there is a 7.3 MB development build with `eval-source-map` (`webpack.config.js:9` hard-codes `devtool` and `mode`). `origin/gh-pages` was last updated 2024-05-19 and contains no CSS or assets.
  Fix: add `"predeploy": "npm run build"`; set `devtool` by mode; drop the hard-coded `mode`.
- [ ] **B4 · P1 · verified — `src/index.html:11` hard-codes `<script src="../dist/bundle.js">`** on top of the script webpack injects. It 404s at the site root; opened as `/dist/index.html` both would load and the app could initialise twice (unconfirmed).
  Fix: delete the manual script tag.
- [ ] **B5 · P2 · read — `@types/three` 0.173 against `three` 0.164.1.** A cast at `initTransformControls.ts:127` hides the mismatch.
  Fix: align the two versions.
- [ ] **B6 · P3 · verified — `node_modules` is tracked** (about 8,500 files) despite being in `.gitignore`, and the tracked copy is incomplete.
  Fix: `git rm -r --cached node_modules`.
- [ ] **B7 · P3 · verified — build output and junk are tracked:** `dist/index.html`, `dist/style.css`, 0-byte `dist/main.js`, `dist/assets`, two `.DS_Store` files, and `temp.js` (2,516 lines, an old pre-TypeScript `Visualizer` that nothing imports and that has a syntax error).
  Fix: untrack and ignore `dist/` and `.DS_Store`; delete `temp.js`.
- [ ] **B8 · P3 · read — unused and misplaced dependencies.** `js-angusj-clipper`, `three-bvh-csg`, `three-csg-ts`, `stats.js` are never imported. `gh-pages`, `html-webpack-plugin`, `mini-css-extract-plugin` are in `dependencies`. Bootstrap and Font Awesome are loaded from CDNs but no classes are used.
  Fix: remove the unused ones; move build tools to `devDependencies`; drop the CDN links.
- [ ] **B9 · P3 · read — no typecheck, lint or test script.** `tsconfig.json` targets `es5` and has an unused `jsx` option.
  Fix: add `tsc --noEmit` and a test runner; raise the target.

---

## G-code and toolpath

Files: `src/printer/Printer.ts`, `src/visualizer/toolpath/*`.

- [ ] **G1 · P0 · verified — wrong tool across concatenated models.** Each model's body G-code is generated at selection time, seeded from whatever `printer.activeExtruder` was then (`Printer.ts:617`, `updateSelection.ts:311`), and joined at save (`initGUI.ts:313-315`). If model A ends on T1 and model B was generated while the active extruder was 0, B prints with T1 and no toolchange. Each body also repeats the purge line and opens with a straight `G0` down from A's top.
  Fix: generate all bodies at save time in one pass after `build_start_gcode`.
- [ ] **G2 · P0 · read — initial-layer filament swap state is per chunk.** (`generateFoamToolpath.ts:1009,1022,1106`, `Printer.ts:641-644`.) With "Initial Foam Layers" above 0, a second island prints its initial layers in the wrong material, then an `M600` inverts the two. The `M600` is emitted even on a toolchanger and switches nozzle geometry and temperature to the other profile.
  Fix: track the loaded material globally in `generate_foam_gcode`.
- [ ] **G3 · P0 · verified — NaN Z with curve augment and one layer.** `generateFoamToolpath.ts:1231` divides by `totalLayers - 1`.
  Fix: guard `totalLayers <= 1`.
- [ ] **G4 · P0 · read — heater left on / wrong first tool in Slice Plate.** (`initGUI.ts:355`, `Printer.ts:234,422`.) `toolpath[0]` is a purge point with no extruder, so the first tool is always T0. In a T1-only print T0 is heated, idled at 70 °C and never switched off, because `build_end_gcode` only covers extruders seen in the toolpath. Whether Slice Plate can produce a T1-only print is unconfirmed.
  Fix: turn off every extruder at the end; take the first tool from the first point with a defined extruder.
- [ ] **G5 · P0 · unconfirmed — no bed-bounds check anywhere.** The purge tower is fixed at (235, 195) and the purge line spans x 5–245 regardless of bed size or model position.
  Fix: one validation pass before emission (bounds, NaN, positive parameters); move the fixed positions into printer config.
- [ ] **G6 · P1 · read — crashes on empty input.** `generateFoamToolpath.ts:1311` (`chunkPath[0]` on an empty path), `:1299-1308` (empty roots), `:2020` (`modelObjs[0]`), `:2164` (no boundary contours), `sampleSelectedMesh.ts:30` (sense selected before foam). The "Mesh is not watertight" throw at `:730` is uncaught and invisible to the user.
  Fix: early returns and a try/catch at the callers with a visible message.
- [ ] **G7 · P1 · read — purge-tower travel points counted as model points.** (`generateFoamToolpath.ts:2877-2915`.) With the purge tower on (default) and curve augment, the three extra flat layers become travel-only and are never printed; the vertical gradient range is skewed.
  Fix: tag tower points explicitly and filter on the tag.
- [ ] **G8 · P1 · read — vertical H\* gradient does not change Z.** (`generateFoamToolpath.ts:1835` vs `:1208/1238`, `Printer.ts:675`.) Z is fixed from the base H\* before the gradient overwrites it; only V\* and the comment change.
  Fix: resolve the gradient before `applyLayerHeight`.
- [ ] **G9 · P1 · read — `initialOffset` ignored for rectilinear infill.** (`generateFoamToolpath.ts:1075-1083,727-734`.) The offset contour only sets scan bounds; lines come from the un-offset `region.BVH`.
  Fix: build a BVH from the offset contour.
- [ ] **G10 · P1 · read — layer index uses untransformed geometry.** (`generateFoamToolpath.ts:1013`.) A scaled or rotated model in Slice Plate gets the wrong layer index, so initial-layer detection and the deltaL ramp are off.
  Fix: pass the transformed mesh's min z.
- [ ] **G11 · P1 · read — selection geometry transform compounds.** (`sampleSelectedMesh.ts:30-38`.) Scale and rotation are baked into the selected mesh geometry on every call; with scale 2 each sense selection doubles it again. The sense mesh is never transformed.
  Fix: transform a clone or use `matrixWorld`.
- [ ] **G12 · P1 · read — collision check is unreliable.** (`generateFoamToolpath.ts:3012-3027,1551-1584`.) It ignores the `checkCollisions` flag, runs on every selection, and reports "no collisions" when every probe collides.
  Fix: gate on the flag, test the upper bound, use the BVH.
- [ ] **G13 · P1 · read — `gridSize` 0 loops forever** in `sampleSelectedMesh.ts:58` (see S2 for `deltaZ`).
  Fix: clamp inputs.
- [ ] **G14 · P1 · read — spread calls overflow the stack on large paths.** `Math.min(...)`, `Math.max(...)`, `push(...path)` at `generateFoamToolpath.ts:2884-2896,1093` throw `RangeError` beyond roughly 100k points.
  Fix: use loops.
- [ ] **G15 · P2 · read — sensing cylinder bugs.** (`addSensingIntersectionGeo.ts`.) The inside-cylinder test assumes a local Z axis but `CylinderGeometry` is along Y (`:162`); `|| new THREE.Mesh()` makes the missing-highlight branch dead and then `geometry.index!` is null (`:230-241`); three canvas listeners per sensing object are never removed (`:129-131`).
- [ ] **G16 · P2 · read — hard-coded 0.2 mm shell and tower layer height** while the bead maths assumes nozzle/2 (`Printer.ts:513`, `generateFoamToolpath.ts:1916`); non-0.4 nozzles mis-extrude.
- [ ] **G17 · P2 · read — gradient bounds are per chunk, not per model** (`:1120,1158`), and divide by zero for a zero-width chunk.
- [ ] **G18 · P2 · read — toolpath performance hot spots.** `fillToolpath` re-runs over the remaining path at every recursion level (`:1389`); one `THREE.Points` object per sample point (`:3029-3051`); `unshift` per point (`:2011,2156,2194`); `getImageData(1×1)` per gradient sample (`modelLoader.ts:278`).
- [ ] **G19 · P3 · read — `changeTool` heats to print temperature even in `testSweep`** (`Printer.ts:418`); `saveGcodeToFile.ts:23` revokes the blob URL synchronously.
- [ ] **G20 · P3 · unconfirmed — printer-behaviour questions to check on hardware.** `approachTravelPoint` crosses at `max(from.z, to.z)` and could hit a taller printed chunk in between; the purge tower is printed by the outgoing tool so the incoming one is never primed; `M900 K30` and `G92 X0 Y0` after homing may be wrong on XL firmware; `initGUI.ts:357` carries a TODO asking whether end G-code is added twice.

---

## Slicer and geometry

Files: `src/visualizer/utils/TreeSlicer.ts`, `geometryUtils.ts`, `src/visualizer/loaders/modelLoader.ts`.

- [ ] **S1 · P1 · verified — nested holes are grouped wrongly.** `getHolesAndOuters` (`TreeSlicer.ts:163-206`) ignores nesting depth. For a ring with a post in its bore, the gap is filled with foam and the post is never printed.
  Fix: compute containment depth; even depth is an outer, holes are its direct children only.
- [ ] **S2 · P1 · verified — layer thickness 0 hangs the tab.** The slider allows 0 (`refreshModelGUIList.ts:363`) and `sliceMeshIntoLayers` loops on `z += deltaZ` (`TreeSlicer.ts:104`); `buildRegionTree` (`:687`) also divides by it.
  Fix: slider minimum above 0; throw on a non-positive step; compute `z = minZ + k * deltaZ`.
- [ ] **S3 · P1 · read — `offsetContour` keeps only the largest polygon** (`TreeSlicer.ts:1728-1736`). A cross-section that splits when inset silently loses its smaller lobe. Holes are grown independently and never clipped against the inset outer (impact unconfirmed).
  Fix: return all solution paths, one region per path.
- [ ] **S4 · P1 · read, not reproduced — alpha-shape loop walk can spin forever at a pinch vertex** (`TreeSlicer.ts:1846-1854`); it never checks visited edges.
  Fix: take the next unvisited edge and stop when none is left.
- [ ] **S5 · P1 · read — region tree parenting uses bounding-box overlap only** and does not exclude same-layer nodes (`TreeSlicer.ts:701-713`). Two interlocking towers get a wrong chunk tree and print order. Shell regions are sliced at 0.2 mm but indexed with `deltaZ` (`:687`) and chained without an overlap check (`:714-717`).
  Fix: require `layer + 1` and a real polygon overlap test.
- [ ] **S6 · P1 · read — no error handling on file load** (`modelLoader.ts:36-41,209-214,347-352`). A corrupt STL throws inside `onload` with no message; a zero-triangle STL gives a non-finite position; an STL with zero X or Y extent gives an Infinity scale (`:365`).
  Fix: try/catch around parsing, validate vertex count and extents, show a message.
- [ ] **S7 · P1 · read — callers' arrays are mutated in place** (`TreeSlicer.ts:1173-1179,1330,1356,1441,1638`): contours are reversed and extra points spliced in. Related crash: `offsetContour` can return `[]` (`generateFoamToolpath.ts:1066`), after which `getWindingOrder([])` throws at `:1758`.
  Fix: copy the arrays; return early on fewer than 3 points.
- [ ] **S8 · P2 · read — slicing is brute force on the main thread** (`TreeSlicer.ts:380-391,431-494`). Every layer scans every triangle; `connectSegments` is O(n²) per layer; the shell pass re-slices at 0.2 mm. A 100k-triangle model freezes the UI.
  Fix: sort triangles by z-range and sweep; hash quantised endpoints for stitching; move to a Worker.
- [ ] **S9 · P2 · read — augment sampling does one un-accelerated raycast per grid cell** (`modelLoader.ts:296-327,383`). No `boundsTree` is built and `acceleratedRaycast` is not installed anywhere.
  Fix: build a `MeshBVH` and use `raycastFirst`.
- [ ] **S10 · P2 · read — `MIN_AREA = 3` is compared against scaled Clipper units** (`TreeSlicer.ts:12,1534`), so the sliver filter does nothing. `def_arc_tolerance` of 0.25 scaled units makes round joins emit about 180 vertices per circle.
  Fix: compare against `MIN_AREA * CLIPPER_SCALE²`; raise the arc tolerance.
- [ ] **S11 · P2 · read — convex hull edge cases** (`geometryUtils.ts:23-46,124`). `getConvexHull` mutates its input, does not break lowest-y ties by x, and has an inconsistent comparator for collinear points; `pointRayCrossesSegments` throws on an empty list.
- [ ] **S12 · P3 · read — plane-vertex edge case** (`TreeSlicer.ts:403-421`). Strict inequalities drop triangles with a vertex exactly on the plane; open chains are accepted as closed (`:488`). Latent because of the 1e-5 offset.
- [ ] **S13 · P3 · read — minor.** Point-cloud region ids omit height (`:1870`); `Math.min(...xs)` can overflow on large contours (`:1875`); `splitChunkTreeByOverlap` re-runs over the whole subtree at each recursion level (`:852,867`); the SVG gradient returns alpha 0–255 while the default returns 1 (`modelLoader.ts:275-279`).
- [ ] **S14 · P3 · read — `clipper-lib.d.ts` `EndType` order does not match the library.** Harmless today; breaks if changed to `const enum`.

---

## App and GUI logic

Files: `src/visualizer/Visualizer.ts`, `gui/*`, `interactions/*`, `renderer/*`.

- [ ] **A1 · P1 · verified — listeners registered inside the `pointerdown` handler** (`initTransformControls.ts:53,67`). Every canvas click adds another document `keydown` and another `transformControls` `change` listener.
  Fix: register both once.
- [ ] **A2 · P1 · verified — `initScene` return value discarded** (`initGUI.ts:170,176,181`, `presetManager.ts:227`). Each bed-size slider tick or preset import leaves another bed outline, origin sphere and axes helper in the scene.
  Fix: assign the result back to `visualizer.printBaseObjects` and dispose the old objects.
- [ ] **A3 · P1 · read — delete is incomplete** (`refreshModelGUIList.ts:51-90`). It does not clear `current_Obj` or `uuid_to_modelObj_Map` and disposes nothing; the next Alt-drag re-adds the deleted model's sample points. Bounding-box helpers and sensing objects are left behind.
  Fix: one `disposeModel()` covering meshes, aux objects, map entry and selection.
- [ ] **A4 · P1 · read — preset export/import crash with no everyday model** (`presetManager.ts:93,201`). Export throws; import applies printer keys, throws on the first model key and skips `syncConfigToPrinter()`, leaving config and printer out of sync behind a generic alert.
  Fix: make the model section optional; parse, validate, then commit.
- [ ] **A5 · P1 · read — weak preset validation** (`presetManager.ts:230-235,255-257,286-288`). No NaN check (`bedTemp abc` puts NaN into G-code); `extruders` and `currentSelectedModel` are accepted as keys; any string is accepted for `toolMode` and `selectionMode`; no version field.
  Fix: explicit key schema with type and range, plus a version line.
- [ ] **A6 · P1 · read — presets do not round-trip** (`presetManager.ts:124-135`). Export omits `deltaLEnd`, all sense params, `curveAugment`, `generateBumps`, `steepnessThreshold`, `flatLayerZOffset`, `additionalCurveLayers`, the whole initial-layer config and `initialOffset`. Model keys apply only to the last-lassoed or first model.
- [ ] **A7 · P1 · verified — no resize handler and no `setPixelRatio`** (`initRenderer.ts:27`). After a window resize the canvas and aspect are stale while lasso and pick maths use live `window.innerWidth/innerHeight`, so selection is offset from the cursor. Rendering is blurry on HiDPI (measured DPR 1.5, canvas 1280×720).
  Fix: resize listener, `setPixelRatio`, NDC from `getBoundingClientRect()`.
- [ ] **A8 · P2 · read — view cube faces do not match `BoxGeometry` order** (`ViewCube.ts:24-31,199-217`). Four of six faces send the camera to the wrong view.
- [ ] **A9 · P2 · read — model folders removed with DOM `.remove()`, not `folder.destroy()`** (`refreshModelGUIList.ts:546-547`). Dead folders and their `.listen()` controllers accumulate. Each rebuild also resets every model's transform type, open/closed state and selection highlight.
  Fix: `guiItem.destroy()`; add or remove only the affected folder.
- [ ] **A10 · P2 · read — BVH pruning for lasso selection is dead** (`updateSelection.ts:85,173`). `useBoundsTree` is not a config key, so every triangle is tested. The same call synchronously generates the toolpath and G-code and `console.log`s the full G-code (`:224,338`); with `liveUpdate` this runs every frame.
  Fix: add the flag, drop the logs, debounce to pointer-up.
- [ ] **A11 · P2 · read — pick handler ignores `altKey`** (`initTransformControls.ts:16`). Starting an Alt-drag lasso on a model also attaches the gizmo and resets it to translate.
- [ ] **A12 · P2 · read — numeric X/Y/Z, "Snap" and "Center" move only the main mesh** (`refreshModelGUIList.ts:151-199`). Highlight overlays stay behind; the gizmo handler syncs a never-assigned `pointsMesh` (`initTransformControls.ts:98`).
  Fix: one `syncAuxTransforms(model)` used by both paths.
- [ ] **A13 · P2 · read — two perpetual render loops and two WebGL contexts** (`Visualizer.ts:275`, `ViewCube.ts:270`); `ViewCube.dispose` does not cancel its loop.
- [ ] **A14 · P2 · read — `importPresetFromFile` never resolves if the dialog is cancelled.**
- [ ] **A15 · P3 · read — type-safety holes.** `any` at `ViewCube.ts:20,35` and `updateSelection.ts:49`; unused imports; dead config keys (`useTreeSlicer`, duplicate `config.currentSelectedModel`).
- [ ] **A16 · P3 · verified — console noise.** `initGUI` logs DOM elements on startup; Slice Plate logs the whole toolpath and G-code.

---

## Usability and aesthetics

- [ ] **U1 · P1 · verified — a build from the current tree is unstyled** (consequence of B2). The three icons render at 512×512 px, and the panel sits top-right at 245 px wide on top of the view cube. With `src/style.css` applied by hand the panel is on the left at 300 px with 16 px icons.
- [ ] **U2 · P1 · verified — no feedback on actions.** "Save Toolpath G-Code" with nothing generated does nothing visible; slicing freezes the tab with no progress indicator; errors go to the console; the two surfaced messages use `alert()`.
  Fix: a status line or toast area, disabled states, and a progress indicator.
- [ ] **U3 · P1 · verified — the core workflow is undiscoverable in the app.** Lasso needs Alt-drag from a top-down view, which only the README says. "Saving" and "Foam Slicing" start collapsed at the bottom.
  Fix: an on-canvas hint when selection mode is armed; order the panel as import → select → parameters → generate → save.
- [ ] **U4 · P1 · verified — delete has no confirmation or undo** and is an unlabelled image with no keyboard access (`<img alt="delete">` inside a span, no `button`, `title` or `tabindex`).
- [ ] **U5 · P2 · verified — inconsistent control names.** Raw identifiers (`bedTemp`, `machineDepth`, `machineDepthY`, `useFermatSpirals`, `toolMode`, `selectModel`, `curveAugment`, `generateBumps`) sit beside labelled ones ("Nozzle Diameter") and jargon (`V*`, `H*`, `Edot`, `Delta L`).
- [ ] **U6 · P2 · verified — no units on any control** (mm, °C, mm/min).
- [ ] **U7 · P2 · verified — almost no in-app help.** Only two tooltips exist, both on folder titles. Parameter descriptions live in the README only.
- [ ] **U8 · P2 · verified — nesting is five levels deep** with a 20 px indent each, leaving 209 px for the innermost controls in a 300 px panel.
- [ ] **U9 · P2 · verified — three params folders repeat the same eight labels** ("params", "initial params", "sense params") with nothing showing which values differ from the base.
- [ ] **U10 · P2 · verified — folder titles are lowercase and inconsistent** ("foam model list", "slice params", "Everyday Object Models"); the import button reads "Import Everyday STL Model!".
- [ ] **U11 · P2 · read — slider ranges allow invalid values** (layer thickness 0, grid size 0); see S2 and G13.
- [ ] **U12 · P2 · verified — the "press esc to quit" bar** is the only mode indicator and does not say what is being quit.
- [ ] **U13 · P3 · verified — page scrolls by 5 px** because the canvas is `display: inline` (document height 725 in a 720 viewport).
  Fix: `canvas { display: block }`.
- [ ] **U14 · P3 · verified — two product names.** The panel title is "AugPrint Design Tool", the tab title is "3DP Foam Slicer".
- [ ] **U15 · P3 · from README screenshots — toolpath colours are harsh.** Saturated lime green and pure blue on dark grey; travel and print moves are hard to tell apart.
- [ ] **U16 · P3 · verified — preset files are `.txt`** with the fixed name `foam_printer_preset.txt`; G-code always saves as `toolpath.gcode`, so repeated saves collide.

---

## Structure

- [ ] **T1 · P2 — hidden mutable state on `Printer`** (`activeExtruder`, global VTP settings) is the root of G1, G2, G4 and G7.
  Fix: a pure `generate(toolpath, startState)` emitter and a discriminated `kind` on `PathPoint` instead of overlapping `travel` / `regularSegment` / `ironing` booleans.
- [ ] **T2 · P2 — three overlapping "current model" fields on `Visualizer`** (`current_Obj`, `currentSelectedModel`, `config.currentSelectedModel`) and a hand-synced config-to-printer mirror are the root of A3, A6 and A12.
  Fix: a `Model` class owning its meshes, GUI folder and disposal; one selection state.
- [ ] **T3 · P2 — no tests.** Start with unit tests for nested holes (S1), split offsets (S3) and G-code emission across two models (G1).
- [ ] **T4 · P3 — `generateFoamToolpath.ts` (3,257 lines) and `TreeSlicer.ts` (1,885 lines) mix unrelated concerns.** Split into slice / contours / tree / offset / infill / visualisation modules.
- [ ] **T5 · P3 — dead and commented-out code.** Roughly a third of `generateFoamToolpath.ts` (`_generatePath`, `generateZigzagInfill`, `createLinearSVG`, `visualizeChunks`, the trial and nonplanar generators); about 150 lines each in `TreeSlicer.ts` and `updateSelectedMeshBoundingBox.ts`; all of `generateBottomBoundingBox.js`.
- [ ] **T6 · P3 — scattered magic numbers.** Tolerances (1e-5, 1e-4, 0.09, 0.01), the 0.2 mm shell height, 0.4 nozzle and (235, 195) tower position should live in one config.
