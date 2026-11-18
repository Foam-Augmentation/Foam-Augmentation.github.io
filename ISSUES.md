# Issue tracker

Findings from the code and UI review of 2026-11-09 (branch `vtp-fixes`, commit `d13865f`).

**How to use:** `[x]` fixed · `[~]` partly fixed (see the status line) · `[ ]` open.

**Fix pass (2026-11-09):** of the 81 original issues, 71 are fixed, 8 partly fixed and 2 open (G20, T4). Checked with `npm run typecheck`, `npm test` (160 tests), a production build, and a browser run on a generated dome STL: import, box selection, toolpath, save, Slice Plate, preset export/import, delete and resize. On that test the saved augmentation G-code has the same 60,806 extrusion moves as the original build. **Nothing has been run on a printer.** See "Found during the fix pass" and "Behaviour changes to check before printing" at the end.

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
| Product design (D), added in the second pass | 0 | 6 | 17 | 5 | 28 |
| Objects list and regular prints (R) | 0 | 2 | 3 | 2 | 7 |
| Review of 2026-11-16 (E, L, K, P, Q), added in the third pass | 5 | 14 | 20 | 14 | 53 |
| Foam print order, nozzle shape and coils (C), added 2026-11-17 | 0 | 1 | 3 | 1 | 5 |
| Moves across the bed in Slice Prints and placement (V), added 2026-11-17 | 2 | 1 | 0 | 0 | 3 |

---

## Build and repo

- [x] **B1 · P0 · verified — `npm start` fails on this checkout.** `webpack-dev-server` and `css-loader` are missing from the committed `node_modules`; `css-loader` is not in `package.json` at all although `webpack.config.js:22` uses it.
  Fix: add `css-loader` to `devDependencies`, stop tracking `node_modules` (B6), run `npm install`.
- [x] **B2 · P0 · verified — `src/style.css` never reaches a build.** Nothing imports it, so `MiniCssExtractPlugin` emits no CSS. The tracked `dist/style.css` is a March 2025 file with only tippy styles. Result: unstyled panel, 512 px icons (see U1).
  Fix: `import './style.css'` (and `tippy.js/dist/tippy.css`) in `src/index.ts`.
- [x] **B3 · P0 · verified — `npm run deploy` publishes whatever is in local `dist/`.** No build step runs first; the bundle there is a 7.3 MB development build with `eval-source-map` (`webpack.config.js:9` hard-codes `devtool` and `mode`). `origin/gh-pages` was last updated 2024-05-19 and contains no CSS or assets.
  Fix: add `"predeploy": "npm run build"`; set `devtool` by mode; drop the hard-coded `mode`.
- [x] **B4 · P1 · verified — `src/index.html:11` hard-codes `<script src="../dist/bundle.js">`** on top of the script webpack injects. It 404s at the site root; opened as `/dist/index.html` both would load and the app could initialise twice (unconfirmed).
  Fix: delete the manual script tag.
- [x] **B5 · P2 · read — `@types/three` 0.173 against `three` 0.164.1.** A cast at `initTransformControls.ts:127` hides the mismatch.
  Fix: align the two versions.
- [x] **B6 · P3 · verified — `node_modules` is tracked** (about 8,500 files) despite being in `.gitignore`, and the tracked copy is incomplete.
  Fix: `git rm -r --cached node_modules`.
- [x] **B7 · P3 · verified — build output and junk are tracked:** `dist/index.html`, `dist/style.css`, 0-byte `dist/main.js`, `dist/assets`, two `.DS_Store` files, and `temp.js` (2,516 lines, an old pre-TypeScript `Visualizer` that nothing imports and that has a syntax error).
  Fix: untrack and ignore `dist/` and `.DS_Store`; delete `temp.js`.
- [x] **B8 · P3 · read — unused and misplaced dependencies.** `js-angusj-clipper`, `three-bvh-csg`, `three-csg-ts`, `stats.js` are never imported. `gh-pages`, `html-webpack-plugin`, `mini-css-extract-plugin` are in `dependencies`. Bootstrap and Font Awesome are loaded from CDNs but no classes are used.
  Fix: remove the unused ones; move build tools to `devDependencies`; drop the CDN links.
- [x] **B9 · P3 · read — no typecheck, lint or test script.** `tsconfig.json` targets `es5` and has an unused `jsx` option.
  Fix: add `tsc --noEmit` and a test runner; raise the target.

---

## G-code and toolpath

Files: `src/printer/Printer.ts`, `src/visualizer/toolpath/*`.

- [x] **G1 · P0 · verified — wrong tool across concatenated models.** Each model's body G-code is generated at selection time, seeded from whatever `printer.activeExtruder` was then (`Printer.ts:617`, `updateSelection.ts:311`), and joined at save (`initGUI.ts:313-315`). If model A ends on T1 and model B was generated while the active extruder was 0, B prints with T1 and no toolchange. Each body also repeats the purge line and opens with a straight `G0` down from A's top.
  Fix: generate all bodies at save time in one pass after `build_start_gcode`.
- [x] **G2 · P0 · read — initial-layer filament swap state is per chunk.** (`generateFoamToolpath.ts:1009,1022,1106`, `Printer.ts:641-644`.) With "Initial Foam Layers" above 0, a second island prints its initial layers in the wrong material, then an `M600` inverts the two. The `M600` is emitted even on a toolchanger and switches nozzle geometry and temperature to the other profile.
  Fix: track the loaded material globally in `generate_foam_gcode`.
- [x] **G3 · P0 · verified — NaN Z with curve augment and one layer.** `generateFoamToolpath.ts:1231` divides by `totalLayers - 1`.
  Fix: guard `totalLayers <= 1`.
- [x] **G4 · P0 · read — heater left on / wrong first tool in Slice Plate.** (`initGUI.ts:355`, `Printer.ts:234,422`.) `toolpath[0]` is a purge point with no extruder, so the first tool is always T0. In a T1-only print T0 is heated, idled at 70 °C and never switched off, because `build_end_gcode` only covers extruders seen in the toolpath. Whether Slice Plate can produce a T1-only print is unconfirmed.
  Fix: turn off every extruder at the end; take the first tool from the first point with a defined extruder.
- [x] **G5 · P0 · unconfirmed — no bed-bounds check anywhere.** The purge tower is fixed at (235, 195) and the purge line spans x 5–245 regardless of bed size or model position.
  **Note:** Software side only: `assertPrintable` refuses non-finite or out-of-bed points before emission, and purge positions derive from bed size. Not checked on hardware.
  Fix: one validation pass before emission (bounds, NaN, positive parameters); move the fixed positions into printer config.
- [x] **G6 · P1 · read — crashes on empty input.** `generateFoamToolpath.ts:1311` (`chunkPath[0]` on an empty path), `:1299-1308` (empty roots), `:2020` (`modelObjs[0]`), `:2164` (no boundary contours), `sampleSelectedMesh.ts:30` (sense selected before foam). The "Mesh is not watertight" throw at `:730` is uncaught and invisible to the user.
  Fix: early returns and a try/catch at the callers with a visible message.
- [x] **G7 · P1 · read — purge-tower travel points counted as model points.** (`generateFoamToolpath.ts:2877-2915`.) With the purge tower on (default) and curve augment, the three extra flat layers become travel-only and are never printed; the vertical gradient range is skewed.
  Fix: tag tower points explicitly and filter on the tag.
- [x] **G8 · P1 · read — vertical H\* gradient does not change Z.** (`generateFoamToolpath.ts:1835` vs `:1208/1238`, `Printer.ts:675`.) Z is fixed from the base H\* before the gradient overwrites it; only V\* and the comment change.
  Fix: resolve the gradient before `applyLayerHeight`.
- [x] **G9 · P1 · read — `initialOffset` ignored for rectilinear infill.** (`generateFoamToolpath.ts:1075-1083,727-734`.) The offset contour only sets scan bounds; lines come from the un-offset `region.BVH`.
  Fix: build a BVH from the offset contour.
- [x] **G10 · P1 · read — layer index uses untransformed geometry.** (`generateFoamToolpath.ts:1013`.) A scaled or rotated model in Slice Plate gets the wrong layer index, so initial-layer detection and the deltaL ramp are off.
  Fix: pass the transformed mesh's min z.
- [x] **G11 · P1 · read — selection geometry transform compounds.** (`sampleSelectedMesh.ts:30-38`.) Scale and rotation are baked into the selected mesh geometry on every call; with scale 2 each sense selection doubles it again. The sense mesh is never transformed.
  Fix: transform a clone or use `matrixWorld`.
- [x] **G12 · P1 · read — collision check is unreliable.** (`generateFoamToolpath.ts:3012-3027,1551-1584`.) It ignores the `checkCollisions` flag, runs on every selection, and reports "no collisions" when every probe collides.
  Fix: gate on the flag, test the upper bound, use the BVH.
- [x] **G13 · P1 · read — `gridSize` 0 loops forever** in `sampleSelectedMesh.ts:58` (see S2 for `deltaZ`).
  Fix: clamp inputs.
- [x] **G14 · P1 · read — spread calls overflow the stack on large paths.** `Math.min(...)`, `Math.max(...)`, `push(...path)` at `generateFoamToolpath.ts:2884-2896,1093` throw `RangeError` beyond roughly 100k points.
  Fix: use loops.
- [x] **G15 · P2 · read — sensing cylinder bugs.** (`addSensingIntersectionGeo.ts`.) The inside-cylinder test assumes a local Z axis but `CylinderGeometry` is along Y (`:162`); `|| new THREE.Mesh()` makes the missing-highlight branch dead and then `geometry.index!` is null (`:230-241`); three canvas listeners per sensing object are never removed (`:129-131`).
- [x] **G16 · P2 · read — hard-coded 0.2 mm shell and tower layer height** while the bead maths assumes nozzle/2 (`Printer.ts:513`, `generateFoamToolpath.ts:1916`); non-0.4 nozzles mis-extrude.
- [x] **G17 · P2 · read — gradient bounds are per chunk, not per model** (`:1120,1158`), and divide by zero for a zero-width chunk.
- [x] **G18 · P2 · read — toolpath performance hot spots.** `fillToolpath` re-runs over the remaining path at every recursion level (`:1389`); one `THREE.Points` object per sample point (`:3029-3051`); `unshift` per point (`:2011,2156,2194`); `getImageData(1×1)` per gradient sample (`modelLoader.ts:278`).
- [x] **G19 · P3 · read — `changeTool` heats to print temperature even in `testSweep`** (`Printer.ts:418`); `saveGcodeToFile.ts:23` revokes the blob URL synchronously.
- [ ] **G20 · P3 · unconfirmed — printer-behaviour questions to check on hardware.** `approachTravelPoint` crosses at `max(from.z, to.z)` and could hit a taller printed chunk in between; the purge tower is printed by the outgoing tool so the incoming one is never primed; `G92 X0 Y0` after homing may be wrong on XL firmware (the start G-code no longer writes `M900 K30`: pressure advance is now turned off with `M572 S0` on the XL and `M900 K0` on the MK3S); `initGUI.ts:357` carries a TODO asking whether end G-code is added twice.
  **Status: not fixed.** Needs a printer. Firmware commands untouched; in-print travel to the purge tower still crosses at `max(from.z, to.z)`. So do moves between chunks, except from one object to another on a plate with Regular Prints, which cross at least 10 mm above the regular parts (V2).

---

## Slicer and geometry

Files: `src/visualizer/utils/TreeSlicer.ts`, `geometryUtils.ts`, `src/visualizer/loaders/modelLoader.ts`.

- [x] **S1 · P1 · verified — nested holes are grouped wrongly.** `getHolesAndOuters` (`TreeSlicer.ts:163-206`) ignores nesting depth. For a ring with a post in its bore, the gap is filled with foam and the post is never printed.
  Fix: compute containment depth; even depth is an outer, holes are its direct children only.
- [x] **S2 · P1 · verified — layer thickness 0 hangs the tab.** The slider allows 0 (`refreshModelGUIList.ts:363`) and `sliceMeshIntoLayers` loops on `z += deltaZ` (`TreeSlicer.ts:104`); `buildRegionTree` (`:687`) also divides by it.
  Fix: slider minimum above 0; throw on a non-positive step; compute `z = minZ + k * deltaZ`.
- [x] **S3 · P1 · read — `offsetContour` keeps only the largest polygon** (`TreeSlicer.ts:1728-1736`). A cross-section that splits when inset silently loses its smaller lobe. Holes are grown independently and never clipped against the inset outer (impact unconfirmed).
  **Note:** `generateFoamToolpath.ts` now uses `offsetRegion`, so initial-layer offsets print every piece and also offset the holes.
  Fix: return all solution paths, one region per path.
- [x] **S4 · P1 · read, not reproduced — alpha-shape loop walk can spin forever at a pinch vertex** (`TreeSlicer.ts:1846-1854`); it never checks visited edges.
  Fix: take the next unvisited edge and stop when none is left.
- [~] **S5 · P1 · read — region tree parenting uses bounding-box overlap only** and does not exclude same-layer nodes (`TreeSlicer.ts:701-713`). Two interlocking towers get a wrong chunk tree and print order. Shell regions are sliced at 0.2 mm but indexed with `deltaZ` (`:687`) and chained without an overlap check (`:714-717`).
  **Status: partly fixed.** Foam parenting now needs a higher layer and a real polygon overlap. Shell chaining across islands is unchanged (changing it reorders shell printing and could not be verified).
  Fix: require `layer + 1` and a real polygon overlap test.
- [x] **S6 · P1 · read — no error handling on file load** (`modelLoader.ts:36-41,209-214,347-352`). A corrupt STL throws inside `onload` with no message; a zero-triangle STL gives a non-finite position; an STL with zero X or Y extent gives an Infinity scale (`:365`).
  Fix: try/catch around parsing, validate vertex count and extents, show a message.
- [x] **S7 · P1 · read — callers' arrays are mutated in place** (`TreeSlicer.ts:1173-1179,1330,1356,1441,1638`): contours are reversed and extra points spliced in. Related crash: `offsetContour` can return `[]` (`generateFoamToolpath.ts:1066`), after which `getWindingOrder([])` throws at `:1758`.
  Fix: copy the arrays; return early on fewer than 3 points.
- [~] **S8 · P2 · read — slicing is brute force on the main thread** (`TreeSlicer.ts:380-391,431-494`). Every layer scans every triangle; `connectSegments` is O(n²) per layer; the shell pass re-slices at 0.2 mm. A 100k-triangle model freezes the UI.
  **Status: partly fixed.** Triangles are bucketed by z-range, stitching is hashed, the augment raycasts use a BVH. Still on the main thread (no Web Worker).
  Fix: sort triangles by z-range and sweep; hash quantised endpoints for stitching; move to a Worker.
- [x] **S9 · P2 · read — augment sampling does one un-accelerated raycast per grid cell** (`modelLoader.ts:296-327,383`). No `boundsTree` is built and `acceleratedRaycast` is not installed anywhere.
  Fix: build a `MeshBVH` and use `raycastFirst`.
- [x] **S10 · P2 · read — `MIN_AREA = 3` is compared against scaled Clipper units** (`TreeSlicer.ts:12,1534`), so the sliver filter does nothing. `def_arc_tolerance` of 0.25 scaled units makes round joins emit about 180 vertices per circle.
  Fix: compare against `MIN_AREA * CLIPPER_SCALE²`; raise the arc tolerance.
- [x] **S11 · P2 · read — convex hull edge cases** (`geometryUtils.ts:23-46,124`). `getConvexHull` mutates its input, does not break lowest-y ties by x, and has an inconsistent comparator for collinear points; `pointRayCrossesSegments` throws on an empty list.
- [~] **S12 · P3 · read — plane-vertex edge case** (`TreeSlicer.ts:403-421`). Strict inequalities drop triangles with a vertex exactly on the plane; open chains are accepted as closed (`:488`). Latent because of the 1e-5 offset.
  **Status: partly fixed.** A vertex on the plane now counts as above, so contours stay closed. Open chains are still accepted so leaky STLs keep slicing.
- [~] **S13 · P3 · read — minor.** Point-cloud region ids omit height (`:1870`); `Math.min(...xs)` can overflow on large contours (`:1875`); `splitChunkTreeByOverlap` re-runs over the whole subtree at each recursion level (`:852,867`); the SVG gradient returns alpha 0–255 while the default returns 1 (`modelLoader.ts:275-279`).
  **Status: partly fixed.** Ids include height, spread calls removed, gradient alpha consistent. `splitChunkTreeByOverlap` still re-runs per level (could not show a single pass keeps the print order).
- [x] **S14 · P3 · read — `clipper-lib.d.ts` `EndType` order does not match the library.** Harmless today; breaks if changed to `const enum`.

---

## App and GUI logic

Files: `src/visualizer/Visualizer.ts`, `gui/*`, `interactions/*`, `renderer/*`.

- [x] **A1 · P1 · verified — listeners registered inside the `pointerdown` handler** (`initTransformControls.ts:53,67`). Every canvas click adds another document `keydown` and another `transformControls` `change` listener.
  Fix: register both once.
- [x] **A2 · P1 · verified — `initScene` return value discarded** (`initGUI.ts:170,176,181`, `presetManager.ts:227`). Each bed-size slider tick or preset import leaves another bed outline, origin sphere and axes helper in the scene.
  Fix: assign the result back to `visualizer.printBaseObjects` and dispose the old objects.
- [x] **A3 · P1 · read — delete is incomplete** (`refreshModelGUIList.ts:51-90`). It does not clear `current_Obj` or `uuid_to_modelObj_Map` and disposes nothing; the next Alt-drag re-adds the deleted model's sample points. Bounding-box helpers and sensing objects are left behind.
  Fix: one `disposeModel()` covering meshes, aux objects, map entry and selection.
- [x] **A4 · P1 · read — preset export/import crash with no everyday model** (`presetManager.ts:93,201`). Export throws; import applies printer keys, throws on the first model key and skips `syncConfigToPrinter()`, leaving config and printer out of sync behind a generic alert.
  Fix: make the model section optional; parse, validate, then commit.
- [x] **A5 · P1 · read — weak preset validation** (`presetManager.ts:230-235,255-257,286-288`). No NaN check (`bedTemp abc` puts NaN into G-code); `extruders` and `currentSelectedModel` are accepted as keys; any string is accepted for `toolMode` and `selectionMode`; no version field.
  Fix: explicit key schema with type and range, plus a version line.
- [x] **A6 · P1 · read — presets do not round-trip** (`presetManager.ts:124-135`). Export omits `deltaLEnd`, all sense params, `curveAugment`, `generateBumps`, `steepnessThreshold`, `flatLayerZOffset`, `additionalCurveLayers`, the whole initial-layer config and `initialOffset`. Model keys apply only to the last-lassoed or first model.
- [x] **A7 · P1 · verified — no resize handler and no `setPixelRatio`** (`initRenderer.ts:27`). After a window resize the canvas and aspect are stale while lasso and pick maths use live `window.innerWidth/innerHeight`, so selection is offset from the cursor. Rendering is blurry on HiDPI (measured DPR 1.5, canvas 1280×720).
  Fix: resize listener, `setPixelRatio`, NDC from `getBoundingClientRect()`.
- [x] **A8 · P2 · read — view cube faces do not match `BoxGeometry` order** (`ViewCube.ts:24-31,199-217`). Four of six faces send the camera to the wrong view.
- [x] **A9 · P2 · read — model folders removed with DOM `.remove()`, not `folder.destroy()`** (`refreshModelGUIList.ts:546-547`). Dead folders and their `.listen()` controllers accumulate. Each rebuild also resets every model's transform type, open/closed state and selection highlight.
  Fix: `guiItem.destroy()`; add or remove only the affected folder.
- [x] **A10 · P2 · read — BVH pruning for lasso selection is dead** (`updateSelection.ts:85,173`). `useBoundsTree` is not a config key, so every triangle is tested. The same call synchronously generates the toolpath and G-code and `console.log`s the full G-code (`:224,338`); with `liveUpdate` this runs every frame.
  **Note:** Enabling the pruning exposed a missing perspective divide in it, which made selection return nothing; fixed and checked in the browser against the original build (see N1).
  Fix: add the flag, drop the logs, debounce to pointer-up.
- [x] **A11 · P2 · read — pick handler ignores `altKey`** (`initTransformControls.ts:16`). Starting an Alt-drag lasso on a model also attaches the gizmo and resets it to translate.
- [x] **A12 · P2 · read — numeric X/Y/Z, "Snap" and "Center" move only the main mesh** (`refreshModelGUIList.ts:151-199`). Highlight overlays stay behind; the gizmo handler syncs a never-assigned `pointsMesh` (`initTransformControls.ts:98`).
  Fix: one `syncAuxTransforms(model)` used by both paths.
- [~] **A13 · P2 · read — two perpetual render loops and two WebGL contexts** (`Visualizer.ts:275`, `ViewCube.ts:270`); `ViewCube.dispose` does not cancel its loop.
  **Status: partly fixed.** One render loop, cancelled in `Visualizer.dispose()`. The view cube still has its own WebGL context.
- [x] **A14 · P2 · read — `importPresetFromFile` never resolves if the dialog is cancelled.**
- [x] **A15 · P3 · read — type-safety holes.** `any` at `ViewCube.ts:20,35` and `updateSelection.ts:49`; unused imports; dead config keys (`useTreeSlicer`, duplicate `config.currentSelectedModel`).
- [x] **A16 · P3 · verified — console noise.** `initGUI` logs DOM elements on startup; Slice Plate logs the whole toolpath and G-code.

---

## Usability and aesthetics

- [x] **U1 · P1 · verified — a build from the current tree is unstyled** (consequence of B2). The three icons render at 512×512 px, and the panel sits top-right at 245 px wide on top of the view cube. With `src/style.css` applied by hand the panel is on the left at 300 px with 16 px icons.
- [~] **U2 · P1 · verified — no feedback on actions.** "Save Toolpath G-Code" with nothing generated does nothing visible; slicing freezes the tab with no progress indicator; errors go to the console; the two surfaced messages use `alert()`.
  **Status: partly fixed.** Toasts replace alerts and silent failures; slicing, saving and selection run behind a busy overlay. Buttons are not disabled when they cannot do anything.
  Fix: a status line or toast area, disabled states, and a progress indicator.
- [x] **U3 · P1 · verified — the core workflow is undiscoverable in the app.** Lasso needs Alt-drag from a top-down view, which only the README says. "Saving" and "Foam Slicing" start collapsed at the bottom.
  Fix: an on-canvas hint when selection mode is armed; order the panel as import → select → parameters → generate → save.
- [x] **U4 · P1 · verified — delete has no confirmation or undo** and is an unlabelled image with no keyboard access (`<img alt="delete">` inside a span, no `button`, `title` or `tabindex`).
- [x] **U5 · P2 · verified — inconsistent control names.** Raw identifiers (`bedTemp`, `machineDepth`, `machineDepthY`, `useFermatSpirals`, `toolMode`, `selectModel`, `curveAugment`, `generateBumps`) sit beside labelled ones ("Nozzle Diameter") and jargon (`V*`, `H*`, `Edot`, `Delta L`).
- [x] **U6 · P2 · verified — no units on any control** (mm, °C, mm/min).
- [x] **U7 · P2 · verified — almost no in-app help.** Only two tooltips exist, both on folder titles. Parameter descriptions live in the README only.
- [x] **U8 · P2 · verified — nesting is five levels deep** with a 20 px indent each, leaving 209 px for the innermost controls in a 300 px panel.
- [x] **U9 · P2 · verified — three params folders repeat the same eight labels** ("params", "initial params", "sense params") with nothing showing which values differ from the base.
- [x] **U10 · P2 · verified — folder titles are lowercase and inconsistent** ("foam model list", "slice params", "Everyday Object Models"); the import button reads "Import Everyday STL Model!".
- [x] **U11 · P2 · read — slider ranges allow invalid values** (layer thickness 0, grid size 0); see S2 and G13.
- [x] **U12 · P2 · verified — the "press esc to quit" bar** is the only mode indicator and does not say what is being quit.
- [x] **U13 · P3 · verified — page scrolls by 5 px** because the canvas is `display: inline` (document height 725 in a 720 viewport).
  Fix: `canvas { display: block }`.
- [x] **U14 · P3 · verified — two product names.** The panel title is "AugPrint Design Tool", the tab title is "3DP Foam Slicer".
- [x] **U15 · P3 · from README screenshots — toolpath colours are harsh.** Saturated lime green and pure blue on dark grey; travel and print moves are hard to tell apart.
  **Note:** Travel moves are a muted grey-blue; default extruder colours are a softer green and orange.
- [x] **U16 · P3 · verified — preset files are `.txt`** with the fixed name `foam_printer_preset.txt`; G-code always saves as `toolpath.gcode`, so repeated saves collide.

---

## Product design review

Second pass, 2026-11-09 (branch `vtp-fixes`, commit `9ee01ee`), after the fixes above. It looks at the app as a product: can a new user get from an STL to a G-code file, and does the screen show what is going on. The six P1 items were fixed the same day, and a visual restyle closed D4, D23 and D24 (see each item's note). D5, D8, D13, D25 and D26 are partly fixed; the other 14 are open.

**Severity here:** `P1` blocks or misleads the main workflow · `P2` friction or missing feedback · `P3` polish.

**P1 fix pass (2026-11-09):** checked with `npm run typecheck`, `npm test` (163 tests), a production build, and a dev-build run at 1024×768 on the built-in example model: empty-state card, Load Example, arming selection, a plain (no Alt) box drag, toolpath refresh after a parameter edit and after a slicer setting, the job switch, Slice Plate and Fit View. Pointer and input events were scripted, so a real mouse drag, a real file drop and the look of the result on screen were not checked. Nothing was run on a printer.

**Visual restyle (2026-11-09):** one dark theme for the panel and every overlay (`style.css` rewritten around CSS variables), primary buttons for Import / Save / Slice, model cards, thin accent sliders, a gradient behind the scene, softer three-light shading, a bed with a grid, and a neutral view cube. Looked at in a dev build at 1280×800 with the example model (empty state, model loaded, selection armed, toasts). Not looked at: other window sizes, the foam job, busy overlay and tooltips. It closes D4, D23 and D24 and partly D13, D25 and D26.

**How it was checked:** `verified` items were seen in a dev build at 1024×768 with a generated 60 mm dome STL (import, open every folder, arm selection, top view, box selection). `read` items come from the source only. The selection drag was simulated with scripted pointer events, so the feel of a real Alt-drag was not judged. Lighting and model shading were not judged (the test STL had no normals).

### Workflow and layout

- [x] **D1 · P1 · verified — two different jobs share one panel with nothing separating them.** "Augment an object" ends in **Save Toolpath G-Code**; "print a model as foam" ends in **Slice Plate**. The two buttons sit one above the other, each in its own one-button folder, and neither says it belongs to a different job. Slice Plate slices the *everyday* models, while the "Models for Foam Slicing" list feeds nothing (N7).
  **Fixed:** A **Job** control at the top of the panel (Augment an Object / Print a Foam Model) shows only that job's action: Save G-Code or Foam Slicing. The foam job also hides each model's Area Selection folder; the other per-model folders stay because slicing reads some of them. The dead "Models for Foam Slicing" list is hidden, not deleted. The model list is now titled "Models" and its button "Import STL Model".
  Fix: a mode switch at the top of the panel (Augment an Object / Print a Foam Model) that shows only that job's sections. Remove the foam model list or make Slice Plate use it.
  **Superseded:** the Job control was replaced by a type on each object (see "Objects list and regular prints").
- [x] **D2 · P1 · verified — the empty state gives no direction.** A first-time user sees bare axes and four buttons; two of them (Slice Plate, Save Toolpath G-Code) only produce a warning. Import is by file dialog only, one file at a time.
  **Fixed:** A getting-started card shows while no model is loaded (Import STL Model, Load Example, three steps). STL files can be dropped on the window. Load Example adds a built-in 60 mm puck. Slice Plate and Save Toolpath G-Code are disabled until they can do something. The file drop was not exercised in the browser.
  Fix: an on-canvas card ("Drop an STL here, or Import") with a "Load Example" button; accept drag-and-drop; disable Slice and Save until they can do something (rest of U2).
- [x] **D3 · P1 · verified — the camera never frames the content.** The orbit target is the bed origin (`initRenderer.ts:54`), so on load the bed runs off the right edge. An imported model lands at the bed centre and was cut off by the window edge. "Go to Top View" centres the origin, so the model ends up in the top-right corner next to the hint and the view cube.
  **Fixed:** The camera starts in front of the bed and orbits its centre. Importing a model frames all models. Arming a selection goes to the top view centred on that model. A **Fit View** button sits under the view cube.
  Fix: orbit around the bed centre; frame the model on import; make "Go to Top View" centre the armed model; add a "Fit View" button.
- [x] **D4 · P2 · verified — the bed is a dashed wireframe box with no surface.** It is hard to tell whether a model rests on the bed or which edge is the front.
  **Fixed:** The bed has a surface, a 10 mm grid (stronger every 50 mm) and a solid outline; the rest of the print space is drawn faintly.
  Fix: a grid plane with the front edge marked.
- [~] **D5 · P2 · verified — import gives no confirmation and does not select the new model.** No toast, no highlight in the panel. Every model is placed at the bed centre (`modelLoader.ts:147`), so a second model lands inside the first.
  **Status: partly fixed.** A new model is framed by the camera (D3), selected, and placed in the free space nearest the bed centre (2026-11-11). There is still no toast.
  Fix: select and frame the new model; place it in free bed space.
- [ ] **D6 · P2 · read — nothing survives a reload.** Models, transforms and selected areas are lost; presets carry parameters only. There is no warning on leaving the page.
  Fix: a project file (or autosave to browser storage) and a leave-page warning while there is unsaved work.

### Area selection

- [x] **D7 · P1 · verified — selecting an area takes three separate steps the app could do itself.** Press "Select Foam Area", go to the top view, then hold Alt and drag. The mode is already armed, so the Alt key adds nothing; the top view is required but left to the user. Alt-drag is also a window-move gesture on many Linux desktops (not tested).
  **Fixed:** "Select Foam Area" / "Select Sensing Area" now release the gizmo, go to the top view of the model and arm selection; a plain left-drag draws. While armed, right-drag rotates the view (Shift + right-drag pans). Alt-drag still works as before.
  Fix: arming switches to the top view of that model, and a plain drag draws while armed. Keep orbit on right-drag.
- [~] **D8 · P2 · verified — the armed state is shown only in the bars, not where the user clicked.** "Select Foam Area" looks the same armed or not, the cursor does not change, and the mode stays armed after a successful selection.
  **Status: partly fixed.** The cursor is a crosshair while armed. The button has no pressed state and the mode stays armed after a selection.
  Fix: a pressed state on the button and a crosshair cursor on the canvas.
- [ ] **D9 · P2 · read — a selection cannot be cleared or edited.** There is no "Clear Foam Area" and no add or subtract with Shift/Ctrl; a new drag replaces the old area. "Select Whole Model" is a checkbox three levels away in Settings › Selection Settings, as is the lasso/box choice.
  Fix: put Lasso / Box / Whole Model / Clear next to the select buttons; Shift adds, Ctrl subtracts.
- [x] **D10 · P1 · read — the preview goes stale when a parameter changes.** The toolpath is drawn when the area is selected. Save regenerates from the current parameters, so after any edit the file differs from what is on screen. Only layer thickness triggers a redraw (`refreshModelGUIList.ts:286`).
  **Fixed:** Finishing an edit in a model's folder (slider released, value entered), or in Printer or Slicer Settings, regenerates the preview of every affected model that has a selected area, 300 ms after the last edit, behind the busy overlay. Buttons (Snap, Center, file pickers) and gizmo moves do not trigger it yet (N6). A preset import did not trigger it either until 2026-11-16 (see E6).
  Fix: regenerate on change (debounced), or mark the preview "out of date" with a Regenerate button.
- [~] **D11 · P2 · verified — a successful selection reports nothing.** No message, no numbers. The preview was thin grey and green lines with no legend for travel, purge and extruder colours.
  **Status: partly fixed (2026-11-10).** A preview bar works on the selected augmentation's preview (and on the sliced plate): colour by feature, tool, speed, V\*, H\* or Edot with a legend, a slider through the layers in print order, and travel on or off. The augmentation export's message gives the time and filament. A selection itself still reports no numbers until it is exported.
  Fix: a result summary (layers, path length, estimated time and filament), a colour legend and a layer slider.

### Parameters panel

- [x] **D12 · P1 · verified — the sliders cannot be used.** Slider ranges are the validation ranges (line spacing 0.2–100 mm, extrusion rate 0.01–1000 mm/min) on an 80 px track, so every default sits at the left edge and one pixel is more than 1 mm.
  **Fixed:** Each numeric spec can carry a narrower slider range (`slider` in `paramSpecs.ts`); the hard limits still apply to typed values and presets. Line spacing now slides over 0.5–5 mm and sits at 27 % of the track. **The slider ranges are estimates around the defaults and need a check by someone who prints with these parameters.**
  Fix: give each spec a narrow slider range separate from the hard limits, or drop the sliders for number fields with steppers.
- [~] **D13 · P2 · verified — the panel is too dense for its width.** One model adds 90 controls; fully open, the panel holds 1,831 px of content in a 758 px window. Text is 11 px and 35 of 90 labels wrap to two lines in the 300 px panel.
  **Status: partly fixed.** Text is 12 px, rows are 24 px high and the panel is 340–380 px wide, so most labels fit on one line. The number of controls is unchanged.
  Fix: a wider or resizable panel; show the unit as a suffix in the value field; split Basic and Advanced.
- [ ] **D14 · P2 · verified — Initial Layer and Sensing parameters are always shown as full copies.** Nine rows each, even with Initial Foam Layers at 0 and no sensing area. Two defaults already differ (initial extrusion rate 200 vs 35, sensing V\* 0.16 vs 0.15, `modelLoader.ts:200,214`), so a fresh model shows "differs" marks nobody set.
  Fix: make overrides opt-in per row with "Reset to Foam Value"; hide each group until it applies.
- [ ] **D15 · P2 · verified — layer-count names collide.** "Foam Layers" (Augmentation Settings) and "Initial Foam Layers" (Initial Layer Parameters) are different values, and the first is stored under the key `initialFoamLayerCount`. "Top Line Spacing" (bottom-to-top ramp) and "Gradient End V\*/H\*" (SVG gradient) are two kinds of gradient named two ways.
  Fix: one "Layers" group showing the total; name the two ramps consistently ("Top …" for vertical, "Gradient …" for SVG).
- [ ] **D16 · P2 · read — file pickers leave no trace.** After "Select Augment Model", "Select Bump Model" or "Select Gradient SVG" nothing shows that a file is loaded, which one, or how to remove it (`modelLoader.ts:266-348,438`).
  Fix: show the file name with a remove button; draw the gradient or bump preview on the model.
- [~] **D17 · P2 · read — the transform controls are minimal.** One X/Y/Z triple changes meaning with Mode; no uniform-scale lock, no reset, and the model is not dropped back onto the bed after a rotate or scale. Any click on a model attaches the gizmo, including a click meant to start an orbit.
  Fix: separate position / rotation / scale rows, a scale lock, Reset, auto drop-to-bed, and W/E/R shortcuts.
  **Status: partly fixed (2026-11-11).** Lay on Face (F), Arrange (A), Duplicate (Ctrl+D), and Snap Model to Plate now rests the lowest point on the bed whatever the rotation. Still one X/Y/Z triple, no scale lock or reset.
- [ ] **D18 · P3 · read — printer setup is a list of raw numbers.** No printer profiles, presets exist only as `.txt` files on disk, extruders are numbered from 0 with no tie to T0/T1, and the extruder colour has a spec but no control (`extruderSettings.ts:9`).
  Fix: a printer dropdown with built-in profiles, named presets kept in the app, a colour swatch per extruder.

### Feedback and safety

- [ ] **D19 · P2 · read — messages disappear before they can be used.** Errors close after 10 s and warnings after 7 s (`notify.ts:11`), with no history. The collision warning carries a recommended H\* the user then has to type from memory.
  Fix: keep errors until dismissed, add a message log, and give the collision warning an "Apply H\*" button.
- [ ] **D20 · P2 · read — the busy overlay has no progress and no cancel** (`notify.ts:82`). A long slice looks the same as a hung tab (S8).
  Fix: run in a worker, show progress per layer, allow Cancel.
- [~] **D21 · P2 · read — saving goes straight to a download.** There is no summary of what the file contains (models, layers, temperatures, tools, time). Slice Plate slices and downloads in one click, so the result cannot be inspected first.
  **Status: partly fixed (2026-11-10).** Foam and regular prints are sliced by **Slice Prints**, which shows the toolpath, each object's layer count and a summary (objects, regular slicer, tools, height, file size), and saved by **Export Print G-Code**. Any change to the plate marks the slice out of date, and the export compares a fingerprint of the plate with the one taken at slicing, so a stale file is never saved. The summary also gives the print time, filament (m and g per tool) and pauses, worked out from the G-code (2026-11-10). The augmentation export still generates and downloads in one step.
  Fix: Slice → preview and summary → Export.
- [ ] **D22 · P2 · read — delete uses the browser's `confirm()` and has no undo.**
  Fix: delete at once and offer Undo in the toast.

### Visual and layout polish

- [x] **D23 · P2 · verified — the panel title is crushed when the panel overflows.** "AugPrint Foam Slicer" shrinks to 11 px high and is clipped, and the panel's last 5 px fall below the window (top 5 px + height 100%).
  **Fixed:** The title keeps its height and the panel stays 12 px inside the window on every side.
  Fix: `.lil-gui.root > .title { flex-shrink: 0 }` and `max-height: calc(100% - 10px)`.
- [x] **D24 · P2 · verified — overlays are positioned against the window, not the canvas.** The Esc bar spans the full width and covers the bottom rows of the panel; the selection hint is centred on the window and touches the panel edge at 1024 px.
  **Fixed:** The selection hint, the Esc message (now a pill) and the getting-started card are centred in the part of the window the panel leaves free; toasts stack above the Esc pill.
  Fix: offset both by the panel width, or move them into one status strip over the canvas.
- [~] **D25 · P3 · verified — the view cube does not match the scene.** Six unrelated pastel face colours against red/green/blue axes, no home or isometric view, only faces are clickable.
  **Status: partly fixed.** The cube is one neutral colour with drawn edges, and a Fit View button sits under it. Edges and corners are still not clickable.
  Fix: a neutral cube with axis-coloured labels, clickable edges and corners, and a Home button.
- [~] **D26 · P3 · read — colour has no fixed meaning.** Orange marks the foam highlight, the "differs" label and the selection hint; blue marks the selected model; hex values are spread across `style.css` and the TypeScript.
  **Status: partly fixed.** `style.css` defines every colour once as a CSS variable: blue for interactive things and the selected model, orange for the foam area, amber for "differs". Scene colours (bed, lights, toolpath) are still constants in the TypeScript.
  Fix: CSS variables for a small palette, one meaning per colour.
- [ ] **D27 · P3 · read — mouse-only and small.** Area selection has no keyboard path, the canvas has no accessible name, text is 11 px. Below about 700 px wide the panel, hint and view cube overlap.
  Fix: a "Use Whole Model" button as the keyboard path, a canvas label, 12–13 px base text, a collapsible panel on narrow windows.
- [ ] **D28 · P3 · read — help lives only in the README.** No link to it from the app, no first-run walkthrough, no sample model in the repo.
  Fix: a "?" link in the panel title, a three-step first-run overlay, and a bundled example STL.

---

## Structure

- [~] **T1 · P2 — hidden mutable state on `Printer`** (`activeExtruder`, global VTP settings) is the root of G1, G2, G4 and G7.
  **Status: partly fixed.** `generate_foam_gcode(toolpath, state)` runs on an explicit emitter state and points carry a `role`. The `travel` / `regularSegment` / `ironing` booleans remain.
  Fix: a pure `generate(toolpath, startState)` emitter and a discriminated `kind` on `PathPoint` instead of overlapping `travel` / `regularSegment` / `ironing` booleans.
- [~] **T2 · P2 — three overlapping "current model" fields on `Visualizer`** (`current_Obj`, `currentSelectedModel`, `config.currentSelectedModel`) and a hand-synced config-to-printer mirror are the root of A3, A6 and A12.
  **Status: partly fixed.** `disposeModel()` and `syncAuxTransforms()` exist and `Visualizer.selectedModel` is the single source (old names are aliases). No `Model` class.
  Fix: a `Model` class owning its meshes, GUI folder and disposal; one selection state.
- [x] **T3 · P2 — no tests.** Start with unit tests for nested holes (S1), split offsets (S3) and G-code emission across two models (G1).
  **Note:** 160 tests in 11 files (`npm test`).
- [ ] **T4 · P3 — `generateFoamToolpath.ts` (3,257 lines) and `TreeSlicer.ts` (1,885 lines) mix unrelated concerns.** Split into slice / contours / tree / offset / infill / visualisation modules.
  **Status: not fixed.** Not attempted: a pure-move split of two 2,000-line files on top of this change set would make it unreviewable. `generateFoamToolpath.ts` did shrink from 3,257 to about 2,050 lines through dead-code removal and extracted modules (`buildGcode`, `collision`, `layerHeights`, `pathTypes`, `toolpathConstants`).
- [x] **T5 · P3 — dead and commented-out code.** Roughly a third of `generateFoamToolpath.ts` (`_generatePath`, `generateZigzagInfill`, `createLinearSVG`, `visualizeChunks`, the trial and nonplanar generators); about 150 lines each in `TreeSlicer.ts` and `updateSelectedMeshBoundingBox.ts`; all of `generateBottomBoundingBox.js`.
- [x] **T6 · P3 — scattered magic numbers.** Tolerances (1e-5, 1e-4, 0.09, 0.01), the 0.2 mm shell height, 0.4 nozzle and (235, 195) tower position should live in one config.

---

## Objects list and regular prints

Added 2026-11-09 (after commit `260667e`). The single nested panel and the global Job switch were replaced, and a third kind of object was added.

**What changed**

- Every object has a **type**: Augmentation (an existing object; foam is printed onto a selected area), Foam Print (printed entirely as foam) or Regular Print (printed as an ordinary solid part). The type replaces the Job switch from D1.
- An **Objects** list on the right shows every object with its type as a coloured badge and a status line. "+ Add" asks which type to import. The two export buttons sit under the list and say what they will include.
- Clicking a row, or the object in the 3D view, **selects** it: it gets an outline box, and the left panel shows only that object's settings (only the ones for its type) under "Selected Object".
- **Regular prints** are sliced by a new module, `src/visualizer/toolpath/regularSlicer.ts`: walls, rectilinear infill at ±45°, and solid layers wherever a region is within N layers of a top or bottom surface. All regular parts print together, layer by layer.
- "Slice & Export Prints" writes one file: purge line, the regular prints, then the foam prints. Between the two the head rises 10 mm above everything printed and arrives over the foam print from above.

**How it was checked:** `npm run typecheck`, `npm test` (218 tests, 46 of them for the regular slicer), a production build, and a dev-build run at 1280×800 with one object of each type (selection, per-type settings, export of a regular box plus a foam box, reading the downloaded G-code for NaN, speeds and the hand-off moves). Pointer and file input were scripted. **No regular-print G-code has been run on a printer.**

**Open issues**

- [ ] **R1 · P1 · unconfirmed — regular prints are untested on hardware and have no retraction.** The G-code pipeline has no retraction, so travels inside a layer cross gaps and holes at print height with the nozzle primed: expect stringing. There is no first-layer handling (same height, flow and speed as every layer), no skirt or brim, no supports, bridging or fan control.
  Fix: test on a printer first; then add retraction with z-hop and a first-layer speed.
- [~] **R2 · P1 · read — no collision check on a mixed plate.** Foam prints follow the regular prints in the same file. The head arrives from above, but nothing checks that the print head (about 75 × 85 mm) clears a finished regular part while it prints foam next to it. The app warns about this after export.
  Fix: check the print-head footprint against finished parts, or refuse plates where they are closer than the head.
  **Status: partly fixed (2026-11-11).** Arrange and the placement of new objects keep anything taller than the nozzle out of the print head's reach (Print Head Min/Max X/Y) around a Foam Print or Augmentation, and slicing or exporting warns by name about any such object placed by hand. The check is on outlines seen from above and the head's rectangle; it is not a full 3D collision check.
- [~] **R3 · P2 · read — the object type and the regular print settings are not in presets.** Export and import carry the foam parameters only.
  **Status: partly fixed (2026-11-10).** Presets (version 3) carry every Regular Print setting as `regular.<key>` lines. The object type is left out on purpose: a preset imported with no object selected applies to every object, and it would turn them all into the same type.
- [ ] **R4 · P2 · read — augmentations export to a separate file.** A plate cannot print a regular part and then augment it in one run.
- [ ] **R5 · P2 · read — regular slicer limits.** A model height that is not a multiple of the layer height is rounded up by up to one layer; slanted surfaces are offset by up to one layer; walls thinner than one line get nothing; a mesh that is not watertight is not detected; two regular parts on different extruders change tool every layer with no purge tower; one speed for every extrusion.
- [ ] **R6 · P3 · read — a Foam Print still shows Augmentation Settings.** The foam slicer reads some of those values (layer counts, curved augmentation), so they were not hidden; which ones matter needs someone who knows the process.
- [ ] **R7 · P3 · read — files dropped on the window always come in as Augmentation.** The type can be changed afterwards in the object's settings.

---

## Found during the fix pass

- [x] **N1 · P1 · verified — lasso BVH pruning lacked a perspective divide.** Turning the pruning on (A10) made every selection come back empty. Fixed in `updateSelection.ts`; caught by comparing against the original build in the browser.
- [x] **N2 · P2 · verified — selection bounding box and outline were drawn at the bed origin**, not on the model, because they used the detached selection mesh's matrix. Fixed in `updateSelectedMeshBoundingBox.ts`.
- [x] **N3 · P2 · verified — the new delete button was stretched over the model name** by lil-gui's `.lil-gui button` rule. Fixed in `style.css`.
- [x] **N4 · P3 · verified — long folder titles wrapped onto the folder below** ("Presets (Applied: ...)"). Fixed in `style.css`.
- [ ] **N5 · P2 · read — rectilinear infill uses `remainder / 2` of a line count as millimetres** (both rectilinear infill functions in `generateFoamToolpath.ts`). Not changed: it alters where scan lines land.
- [ ] **N6 · P2 · read — selection box, outline and toolpath preview do not follow the model** when it is moved after selecting; they are rebuilt only on the next selection.
- [ ] **N7 · P3 · read — `foamModelList` models can be imported but no slicing code reads them.** Slice Plate slices the everyday models.
- [ ] **N8 · P3 — `bedMargin`, `purgeTowerRadius` and `useBoundsTree` have no GUI or preset entries.** They are fields with defaults (5 mm, 10 mm, on).
- [~] **N9 · P3 — `npm audit` reports vulnerabilities in dev dependencies** after the reinstall. Not triaged.
  **Status: partly fixed (2026-11-16).** See K6.

## Behaviour changes to check before printing

**G-code**

- Save regenerates every model's toolpath at save time, so parameter edits made after selecting reach the file. All models are emitted in one pass with one start sequence and one purge line.
- Save and Slice Plate refuse, with an error message, if any point is non-finite or outside the configured bed and build height.
- The first approach crosses the bed at model top + 10 mm before descending (it used to cross at printing height).
- End G-code switches off every extruder, not only the ones used.
- The initial-layer filament swap is a bare `M600` and no longer changes temperature or nozzle profile.
- The vertical H\*/V\* gradient now changes Z per layer.
- The collision check runs only when "Check Collisions" is on.
- Shell and purge-tower layers use nozzle diameter / 2 (unchanged for a 0.4 mm nozzle).
- Initial-layer offset now offsets holes as well as the outer contour, and prints every piece if the region splits.

**Slicing**

- Nested contours follow even-odd nesting (a post inside a bore prints; the gap stays empty).
- Inset loops smaller than 3 mm² are dropped; rounded offsets have about 30 vertices per circle instead of about 180.
- Walls thinner than twice the shell inset get no foam region.
- Regions in the same layer are never parent and child, which can change chunk order for multi-island prints.

**App**

- Esc also disarms area selection and deselects the model.
- Preset files have a `presetVersion 2` line and carry every per-model parameter; old files still import. An invalid line rejects the whole file.
- Downloads are timestamped: `<model>_<date>-<time>.gcode`, `augprint-preset_<date>-<time>.txt`.
- Control labels were renamed (config keys and preset keys were not); the README parameter sections were updated to match.

**Design fix pass (D1, D2, D3, D7, D10, D12)**

- The panel has a Job control; Save G-Code shows only when augmenting and Foam Slicing only when printing a foam model. "Models for Foam Slicing" is hidden.
- "Everyday Object Models" is now "Models"; "Import Everyday STL Model" is now "Import STL Model".
- While area selection is armed, left-drag draws and right-drag rotates the view. Alt is no longer needed.
- Editing a parameter regenerates the on-screen toolpath of models with a selected area. G-code output is unchanged: Save already regenerated from the current parameters.
- Sliders cover a narrower range than the limits; values outside the slider can still be typed.
- Slice Plate and Save Toolpath G-Code are disabled until there is a model / a selected area.

**Objects list and regular prints**

- The Job control is gone. Each object has a Type; "Export Augmentation G-Code" covers Augmentation objects and "Slice & Export Prints" covers Foam Print and Regular Print objects. Both buttons are under the Objects list on the right.
- Slicing no longer includes every object: an Augmentation object is left out of "Slice & Export Prints", and only Augmentation objects are in the augmentation file.
- Regular Print is new G-code that has never been printed (see R1). In a mixed file the foam part starts with a move from above instead of a travel across the bed from the origin; a foam-only file is unchanged.
- `PathPoint` has an optional `speed` for regular segments; points without it print as before.
- Imported models are shaded from their triangles, not from the normals in the STL file.

---

## Review of 2026-11-16

Third pass (branch `vtp-fixes`, commit `5b210b1`): a full read of the code by area (G-code emission, slicing geometry, app and GUI, desktop app and PrusaSlicer), plus a maintainability pass. 53 findings; 38 are fixed, 3 partly, 12 open.

**How it was checked:** `npm run typecheck` (now includes the test files), `npm test` (400 tests in 23 files, 36 of them new), a production build, and a run of that build in the browser next to a build of `5b210b1`, both driven by the same scripted pointer events on the example model:

- Augmentation, default settings, one lasso: the two G-code files are the same line for line (33,349 lines compared) apart from the two intended changes, `M83` before the first extruder move and decimal feed rates on foam moves.
- Foam Print of the example model: the same 29,211 foam moves, 5,117.67 mm of foam filament, 11 layers and 74,753 shell moves; 215 fewer travel lines.
- In the fixed build: Select Whole Model covers the whole top of the model (11,414 foam moves against 580), Esc in a number field keeps the object selected, and a sliced plate still exports after switching the Selection Tool.

**Not checked:** nothing was run on a printer. The desktop app was not started, so the Slicer-menu notice, the page check on calls to PrusaSlicer and the production-build `npm run desktop` are covered by unit tests and reading only. PrusaSlicer itself was not run. No real mouse was used.

### G-code and emission (E)

- [x] **E1 · P0 · verified — the boundary pause cut across the bed in one move.** `G0 X0 Y<max> Z50` from printing height, with no lift first: with two augmentations the second pause crossed the first object.
  **Fixed:** the head lifts straight up to at least 50 mm (and at least the pause point's height), then crosses. The pause point is above everything printed before (`minimumSafeZ`).
- [x] **E2 · P0 · verified (emitted G-code) — tool change between two PrusaSlicer groups was followed by a straight move from the dock down to the first layer.**
  **Fixed:** the group's tool is named on the crossing point above the parts, so the move after the change is that crossing.
- [ ] **E3 · P0 if real · unconfirmed — an augmentation's start sequence does not know an object is on the bed.** With the defaults the probing area (`M555`) is the whole bed; with the purge line and tower off, nozzle cleaning (`G29 P9`) is placed at the foam area, i.e. at the object. Safe only if the object is placed at the boundary pause.
  **Not fixed:** needs a decision on where probing and cleaning should go when an object is on the bed from the start.
- [x] **E4 · P1 · verified — the part cooling fan stayed on for foam printed after a PrusaSlicer part.**
  **Fixed:** `M107` before the app's own extrusions that follow PrusaSlicer's, and the fan as PrusaSlicer last set it before PrusaSlicer's next move. Assumes the firmware carries the fan across a tool change.
- [x] **E5 · P1 · verified — curved augmentation layers stepped down into the object** where the target surface is below the object's surface.
  **Fixed:** a layer never steps down. **Where the target is below the surface the layers now sit at one height; whether that is the wanted result there needs someone who uses curved augmentation.**
- [x] **E6 · P0 · verified — the augmentation export used sample points from before the last edit** (rotation, scale or grid size typed just before pressing Export; any foam parameter after a preset import).
  **Fixed:** the export samples every area again, and a preset import refreshes the previews.
- [x] **E7 · P2 · verified — the start G-code retracted before `M83`.**
  **Fixed:** `M83` comes right after `G90`.
- [x] **E8 · P2 · verified — foam feed rates were rounded to whole mm/min and could be written as `F00`.**
  **Fixed:** three decimals; a head speed below 0.001 mm/min is refused with a message.
- [x] **E9 · P2 · verified — surface height at the edge of the sampled area depended on the slice height.**
  **Fixed:** the lookup uses x and y only.
- [x] **E10 · P2 · read — Print Speed did not limit bridges, supports, gap fill or outer walls under PrusaSlicer.**
  **Fixed:** every print speed setting is sent at Print Speed (setting names checked against PrusaSlicer's source in `reference/`; PrusaSlicer was not run). Travel speed is still the extruder's, as before.
- [ ] **E11 · P2 · unconfirmed — a final wipe leaves the filament retracted** when PrusaSlicer retracts before or during it; what follows starts short of filament.
- [ ] **E12 · P3 · read — estimate details.** `G28 X Y` is timed as a full home; the start G-code's trial picks count as tool changes; a single-head print that starts on extruder 1 books its filament to tool 0.

### Slicing (L)

- [x] **L1 · P1 · verified — rectilinear foam infill threw a false "Mesh is not watertight"** when a scan line ran through a corner of the outline or along an edge (23 of 300 random selections at the default 1.7 mm spacing; an L bracket at 1.2 mm).
  **Fixed:** crossings follow a half-open rule, so the count is even on any closed outline. A scan line exactly on the edge of a region is cut 1e-6 mm inside it; pieces shorter than 0.01 mm are not printed.
- [x] **L2 · P1 · verified — a sensing area under about 10 mm across was also covered by foam.**
  **Fixed:** the sensing regions are cut out of the foam regions.
- [x] **L3 · P1 · verified — the extra flat layers of a curve augment copied "points near the highest z"**, 3 points instead of the layer.
  **Fixed:** they copy the top layer of the stack by its number, each copy one layer thickness above the last.
- [ ] **L4 · P1 · unconfirmed — the purge tower is built to the full print height with one tool** (reviewer's measurement: 94 m of tower path for 0.7 m of foam on a 100 mm object). An existing test expects a tower for a single-tool print.
  **Not fixed:** needs a decision on whether a one-tool print should have a tower at all.
- [x] **L5 · P1 · verified — boundary outline: contours were joined by a printed line, left open, and holes were outlined under the wall.**
  **Fixed:** each outline is closed, the move from one to the next is a travel, and only the outside of each piece of the base is outlined.
- [x] **L6 · P1 · verified — the line spacing ramp of an augmentation was measured against the object's height**, so the top layer never reached Top Line Spacing.
  **Fixed:** it runs over the foam stack.
- [x] **L7 · P1 · verified (option-gated) — Fermat spiral infill overflowed the stack on long contours** (the part of G14 that was left).
- [x] **L8 · P2 · verified — a sensing layer thickness that differs from the layer thickness gave sensing layers the wrong layer numbers**, and with them the wrong initial-layer settings.
  **Fixed:** layers are numbered by the model's layer thickness. The sensing and initial "layer thickness" values still do not change any layer height.
- [~] **L9 · P2 · measured — foam-print slicing is quadratic in contour vertices** (`checkShellRegularOverlap`, the shell offsets on unsimplified contours), and every move is cut into 0.5 mm pieces (525k points for a 100 × 100 × 20 mm print).
  **Not fixed.** The first foam region of a chunk now picks its start corner in the right frame, which removes some travel; the hot spots are untouched.
- [x] **L10 · P2 · verified — a sampling grid above about 7 mm gave no toolpath.**
  **Fixed:** the outline radius grows with the grid (1.5 grid steps where that is more than 5 mm).
- [ ] **L11 · P2 · verified (option-gated) — the Fermat inset tree drops holes smaller than about 1 mm radius after the first inset.**
- [ ] **L12 · P3 · read — region ids are not unique across two copies of a model**, while the set of printed regions is shared. The print order came out right in the case tried.

### Desktop app and security (K)

- [x] **K1 · P0 (security) · verified up to the last step — a preset file could run code in the desktop app.** A profile name with markup reached a dropdown that writes its text as HTML; from the page, a slicing request could set `post_process`, which PrusaSlicer runs as a program (read in PrusaSlicer's source, not run).
  **Fixed:** preset text may not contain `<` or `>`; the dropdowns are rebuilt before they are shown after an import; the main process refuses a request that sets `post_process`, and the app's settings blank it; production builds carry a Content Security Policy with no inline or evaluated script; calls to PrusaSlicer are answered only for the app's own page.
- [x] **K2 · P2 · read — a slice was not marked out of date when the PrusaSlicer program or profile changed.**
  **Fixed:** the Slicer menu tells the page, which marks the slice out of date and reads the profiles of the install in use again (that also covers a profile bundle that was cached as missing).
- [x] **K3 · P3 · read — main-process robustness.** Failure messages named Node error codes as exit codes; a temporary folder that could not be removed replaced the real error; PrusaSlicer kept running after the app quit; any local file could be navigated to.
- [ ] **K4 · P3 · unconfirmed — PrusaSlicer may drop a regular part's Z placement** (`--no-ensure-on-bed` is not passed), where the built-in slicer keeps it.
- [ ] **K5 · P3 · measured — picking a printer profile blocks the page for over a second** (every profile section's inheritance is resolved again, with no memo).
- [~] **K6 · P2 — `npm audit`.** 33 advisories before, 11 after `npm audit fix`. The rest need major upgrades (vitest 5, webpack-dev-server 6, copy-webpack-plugin 14). All are in development tooling.

### App and GUI (P)

- [x] **P1 · P1 · verified — Add Copies, placing a new object and Arrange froze the page when objects do not fit** (reviewer: about 25 s for 50 copies of the example model).
  **Fixed:** the head reach is worked out once per outline, bounding boxes settle most pairs, a shape that fits nowhere is not tried again, an object's outline is kept per orientation, and copies stop searching once one finds no room. Arranging 50 such objects takes about 0.5 s in the test.
- [x] **P2 · P2 · verified — Arrange could put an object on top of one that did not fit.**
- [x] **P3 · P1 · read — a press on a gizmo handle drawn over another object selected that object** instead of moving.
- [x] **P4 · P1 · verified — "Select Whole Model" selected one triangle.**
- [x] **P5 · P1 · read — copies kept Curved Augmentation and Generate Bumps switched on without the files they need.**
  **Fixed:** a copy shares the augment surface and gets its own copy of the bump model.
- [~] **P6 · P1 · read — the augment surface was sized to the model's raw geometry.**
  **Partly fixed:** it is sized to the model as it is placed when the file is loaded. It is still not fitted again when the model is scaled or rotated afterwards.
- [x] **P7 · P2 · read — Lay on Face and area selection left each other's state behind** (mouse buttons, hints, a click that turned the wrong object).
- [x] **P8 · P2 · read — "Back to Top View" framed the first model that was ever armed.**
- [x] **P9 · P2 · read — after an augmentation export the preview bar acted on a removed preview**, and editing Layer Thickness deleted the preview until the refresh.
- [x] **P10 · P2 · read — the plate slice went out of date for changes that do not affect it** (Copies, Transform Mode), and Export was refused after changing a selection setting.
- [x] **P11 · P2 · read — changing an object's type left the selected area's box and outline in view**, and a hidden sensing box could still be dragged.
- [x] **P12 · P2 · read — one model that could not be regenerated stopped the preview refresh for all the others.**
- [x] **P13 · P2 · read — keyboard shortcuts stayed live while a slice was running.**
- [x] **P14 · P3 · verified — Esc in a number field deselected the object.**
- [x] **P15 · P3 · read — "Show Selection Wireframe" did nothing.** The control is gone; presets that carry the key still load.
- [ ] **P16 · P2 · unconfirmed — dragging a sensing box does heavy work on every pointer move** on a large model.

### Tooling and structure (Q)

- [x] **Q1 · P3 · verified — test files were not typechecked, and two no longer matched their types.** `npm run typecheck` now uses `tsconfig.typecheck.json` (tests included, unused locals refused).
- [x] **Q2 · P3 — no CI.** `.github/workflows/ci.yml` runs typecheck, tests and a production build on pushes to `main` and on pull requests.
- [x] **Q3 · P3 — the desktop app always ran a development build.** `npm run desktop` builds for production; `npm run desktop:dev` keeps the old behaviour.
- [x] **Q4 · P3 — dead code.** Removed the layer preview nothing fed (`visualize_All_Layers`), `Printer.boundsFromGcode`, and the model fields only they read. `TreeSlicer.ts` no longer imports a type from `generateFoamToolpath.ts`.
- [ ] **Q5 · P3 — no linter.** The code carries `eslint-disable` comments, but ESLint is not installed.
- [ ] **Q6 · P3 — structure, not attempted.** Three half-pipelines build an augmentation toolpath; change notification is spread over four ad-hoc calls; what belongs to a model is listed by hand in several places (one list, `augmentOverlays`, now feeds the type change); where a tool change happens is a convention each caller follows by hand; three scan-line fillers, three point-in-polygon tests, two Clipper wrappers and four G-code line readers exist side by side; 23 functions are over 100 lines. See also T2, T4.
- [ ] **Q7 · P3 — README screenshots show the interface from before the Objects list** (`select-model.png`, `saving.png`), and several passages still say "everyday model".

### Behaviour changes to check before printing

- A boundary pause starts with a vertical lift, and parks above everything printed before.
- Between two PrusaSlicer groups on different tools, the tool changes above the parts, before the crossing.
- Foam after a PrusaSlicer part prints with the fan off; PrusaSlicer's next moves get the fan back.
- A curved augmentation onto a surface below the object no longer goes down; its layers sit at one height there.
- `M83` is written before the start sequence's first retraction.
- Foam moves carry feed rates with three decimals (`F100.488`, was `F0100`).
- Scan lines through corners of an outline no longer stop the print with "not watertight"; a region can gain or lose a scan line exactly on its edge.
- A small sensing area is no longer covered by foam as well.
- The extra flat layers of a curve augment are whole layers.
- The line spacing ramp of an augmentation reaches Top Line Spacing on the top layer.
- The boundary outline is closed, has no printed line between two outlines and none around holes.
- With PrusaSlicer, bridges, supports, gap fill and outer walls print at Print Speed unless Use Profile Speeds is on.
- A post-processing script in a PrusaSlicer profile is not run.
- An object placed after one that did not fit keeps clear of it.

## Moves across the bed in Slice Prints and placement (2026-11-17)

Found while checking the coil model on 2026-11-17: sliced Foam Prints were walked in print order, and the G-code of a foam-only file was read. Checked with `npm run typecheck`, `npm test`, a production build and an export from the app (see the status lines). **Nothing has been run on a printer.**

- [x] **V1 · P0 · verified (emitted G-code) — a Foam Print went back to the bed origin at printing height and crossed the bed there.** After the purge line the file lifted 2 mm, went down to `X0 Y0 Z0.1` and crossed the bed at 0.1 mm to the first layer: through the start of the purge line (0.3 mm tall) and, with `Print Boundary` on, across the boundary it had just printed. With `Print Boundary` on and a Regular Print on the plate, the move from the boundary crossed the finished regular part (the toolpath check found the head 25 mm inside a 30 mm post). Augmentations were not affected.
  **Fixed:** every move from the purge line to a boundary outline, from one outline to the next, and from there to the first layer lifts straight up, crosses 10 mm above everything printed so far (and at least 10 mm above the regular parts on the plate), then comes straight down where printing starts. In an export from the app (a 30 mm Regular Print and a Foam Print, `Print Boundary` on), the head left the boundary straight up to 40 mm, crossed, and came straight down onto the first layer.
- [x] **V2 · P0 · verified (toolpath check) — on a plate with Regular Prints, the move from one foam object to another crossed at foam height**, through a regular part standing between them (18 mm deep into a 30 mm post in the test).
  **Fixed:** from one object to another, the head crosses at least 10 mm above the regular parts. Moves within one object, and between foam objects on a plate without Regular Prints, still cross at the higher of their two ends (G20).
- [x] **V3 · P1 · verified (app, toolpath check) — placement did not allow for the boundary outline.** New objects and Arrange kept a tall part out of the print head's reach around a Foam Print's outline, but with `Print Boundary` on the boundary is printed 1 mm (`BOUNDARY_OFFSET`) further out. In the app, a 30 mm Regular Print placed 15 mm in front of a Foam Print was hit by the head body while the front edge of the boundary printed (12 moves at z 0.1; `Check Collisions` reported it).
  **Fixed:** with Print Boundary on, the head's reach is grown by the boundary offset on every side, for new objects, copies, Arrange and the warning after slicing. Objects already on the plate do not move until Arrange is pressed; the warning names them.

### Behaviour changes to check before printing

- A Foam Print no longer goes to the front-left corner of the bed after the purge line. It lifts 10 mm above the purge line, crosses to the first boundary outline or the first layer, and comes straight down; the same before each further boundary outline.
- On a plate with Regular Prints, the foam goes to its boundaries, to its first layer and from one foam object to another at least 10 mm above the tallest regular part. With many turns between two foam objects this adds travel time.
- With `Print Boundary` on, new objects, copies and Arrange keep tall parts 1 mm further from a Foam Print or Augmentation than before, and the warning after slicing counts that 1 mm. The G-code itself is unchanged by this.

## Foam print order, nozzle shape and coils (2026-11-17)

Not review findings: a change to the order a Foam Print is printed in and to where its foam is laid (commits `07dd2f9` and `120732a`; described in the README under "How a Foam Print Is Printed"). Checked with `npm run typecheck`, `npm test`, a production build, a block sliced in the app, and test plates (posts, posts 5 mm apart, a post on a base, two models, a 40 mm block, a bar leaning 50°) whose toolpaths were walked on a 0.2 mm grid: the nozzle, as wide as it is at each height, touched nothing already printed. **Nothing has been run on a printer.**

### Open (C)

- [ ] **C1 · P1 · verified (simulated) — a wall leaning more than about 60° from vertical is still printed over foam that is not there yet in places.** Such a wall counts as resting on the foam and keeps the old order. On a bar leaning 68° the nozzle passed up to 1.2 mm below material already printed.
- [ ] **C2 · P2 · unconfirmed — the coil size at the usual H* is extrapolated.** The lab's roads were measured at H* 17.5 to 47.5; at H* 6 and 9 the fitted line is carried down (2.0 and 2.5 mm). If real coils are smaller, foam sits loose from the wall. Other thread diameters are scaled, which nothing has measured either.
- [x] **C3 · P2 · fixed (simulated) — a leaning wall hung over the edge of the foam of its own layer.** The foam's inset from the wall was measured in the slice plane at the bottom of the layer, so on the side a wall leans over the foam, the coils landed on the wall higher up in the layer. Walked in print order with coils sized by `coilDiameter`, a 10 mm bar leaning 30° had 19 % of its foam points with a coil on a wall line of the same layer, by up to 0.92 mm; at 50°, 38 % and 1.19 mm; a cone narrowing from 32 to 8 mm across, 17 % and 0.96 mm. The foam path now also keeps a coil's radius from the walls higher up in its layer that stand on the wall below them, which are the ones printed before the foam: none of those coils reaches a wall line now (test "keeps the coils off a wall leaning …"). Vertical walls give the same toolpath as before (40 mm block at H* 6 and 9, 12 mm post, two posts 5 mm apart, a cylinder, a post on a base). Walls that rest on the foam keep the foam under them (test "leaves the foam under a wall that rests on it"). Working out where the walls lean takes time: under `npm test`, slicing a 16k-triangle sphere 40 mm across went from about 1.3 s to 1.8–2.0 s, and the 20 mm cone from 0.25 s to 0.47 s; a block takes as long as before. On the sphere, 1 % of the foam points still have a coil on a wall line, near its top, where the walls rest on the foam. The nozzle walk described above was not repeated. Not run on a printer.
- [ ] **C4 · P2 · unconfirmed — `Nozzle Length` (4.5 mm) and the `Print Head` box were not measured on a Prusa XL.** The tip, cone and hex of the nozzle were taken off E3D's drawing.
- [ ] **C5 · P3 — no setting turns the wall inset off** (nor keeping clear of leaning walls), for printing the same part with and without it.

### Behaviour changes to check before printing

- The walls of a Foam Print are printed before the foam inside them, up to the height of the foam nozzle; the foam then fills them. Leaning walls up to about 60° from vertical as well, without an ironing pass.
- A section of a Foam Print is as tall as the shape of the nozzle and the print head allow, where it was a fixed height set by the nozzle length. Pieces close together are built up in turns; pieces out of each other's reach are finished one after the other.
- The foam path stops a coil radius short of the inner face of the wall: 1.6 mm inside the outline at H* 6 and 1.85 mm at H* 9, where it was 1.2 mm. Less foam is laid near walls: the foam path of a 40 mm block is 6 % shorter at H* 6, that of a 12 mm post 18 %.
- A part too narrow for that inset is filled as before.
- With an H* gradient, one inset is used for a whole piece of a layer, sized by the largest H* along its edge.
- Where a wall leans over the foam and stands on the wall below it, the foam path also keeps a coil's radius from the wall as it is higher up in the layer (C3). In 1.7 mm layers at H* 6 it stops about 0.9 mm further from a wall leaning 30° and 1.9 mm from one leaning 50°; the foam path of a 10 mm bar is 19 % and 38 % shorter, that of a cone narrowing from 32 to 8 mm across 18 %, and that of a 40 mm sphere 5 %. A part that only a leaning wall leaves no room in is filled inside the bottom inset as before.
- A wall that rests on the foam keeps the foam under it, but the lowest lines of a wall leaning more than about 60° that still stand on the wall below are now kept clear of too: the foam path of a 10 mm bar leaning 68° is 20 % shorter. C1's figures were taken before this change and were not measured again.
