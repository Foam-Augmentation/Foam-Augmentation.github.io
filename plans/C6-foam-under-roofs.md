# Plan: foam under shallow roofs (ISSUES C6, C7; touches C1 and C8)

Status: implemented in code on 2026-11-18, behind `Thin Foam Under Roofs`, on by default (section 6.6 had it off until test print 3); section 12 says where the code differs from this plan. Test prints 1 to 3 (section 5) have not been done, so `Lowest H*` and `Layer Response` are still guesses. Written 2026-11-17 from a design discussion, revised 2026-11-18 after a review. Nothing in it has been run on a printer.

## 1. The problem

A Foam Print slices its foam and its walls at different heights:

- **Foam** is cut every ΔZ (default 1.7 mm; 1.667 mm on the part below) by `sliceMeshIntoLayers`. Each foam region is the cross-section at the **bottom** of its layer (`extractRegionsFromLayer`), inset from the outline by the wall, and the foam laid on it is a whole ΔZ thick.
- **Walls (shell)** are cut every `shellLayerHeight` (0.1 mm) by `extractShellRegionsFromLayer`: two perimeters per slice.

Where the part narrows going up (a roof), the shell slices inside one foam layer lean in over that layer's foam. On a steep wall that is C3, already handled: those walls stand on the wall below, are printed first, and the foam keeps a coil's radius from them. On a shallow roof each shell line is more than half a line width (`wallLean`, 0.2 mm) to the side of the one below, so it is not held up by it, and `buildRegionTree` records that it **rests on the foam** (`shellDependentRegions`; any shell from 0 to ΔZ above the foam's slice counts).

That is a contradiction:

1. The shell rests on the foam, so it has to wait for it (`blockerOf`: "which it covers from above").
2. The foam is ΔZ thick, so it would stand above the nozzle tip of the shell slices inside its layer, and has to wait for them (`blockerOf`'s nozzle check).
3. Nothing can go. `buildChunkForest` falls back to the stack with the lowest nozzle, which is the shell (tip 0.1 mm above its slice, against H* d = 2.4 mm for foam). The roof lines are laid over nothing, and the foam is then laid up through them.

### Evidence

"Part Studio 1 (2).stl": a box with a gable roof from about z 4.8 mm, rising about 0.197 mm per mm (11° from horizontal, 79° from vertical). The fallback warning (`TreeSlicer.ts`, commit `4f43e96`) fired four times:

```
... the shell region region_4.014_0_S ... at z 8.80 mm (extruder 0, nozzle tip at z 8.90 mm) is printed anyway
before the foam region region_3.334_0 ... at z 8.12 mm, which it covers from above.
```

(and the same for the shells at 8.90, 9.00 and 9.10 mm). At 11°:

| | Sideways move of the roof |
|---|---|
| per 0.1 mm shell layer | 0.1 / 0.197 = 0.51 mm, more than the 0.2 mm a line can lean and stay held up, so every roof line rests on foam |
| per foam layer (1.667 mm) | 8.5 mm: along each slope there is an 8.5 mm wedge where the foam would stand up to a whole layer above the roof |

C1 (walls leaning more than 60°) is the same situation on steeper walls. C7 is the fallback warning saying "the nozzle may hit printed material" here, where the actual risk is the shell laid over nothing.

## 2. The decision

**Lower H\* point by point in the top foam layer under a roof, so that layer comes out only as thick as the room under the roof. Where the room is less than the thinnest layer the lowest usable H\* gives, lay no foam; the roof goes over that strip.** The roof is then printed onto the fitted foam, as the region tree already says it should be.

### Why it works

- **H\* sets the layer height.** Emery et al. 2024 ([Advanced Science](https://pmc.ncbi.nlm.nih.gov/articles/PMC11600193/), arXiv 2407.06051) model the layer height H_L from (V*, H*, ΔL), with a positive H*–H_L relation, and show VTP is self-stabilizing: H_L is pulled to ΔZ over several layers because the effective H* adjusts. So lowering the nozzle locally is, in effect, a local ΔZ.
- **Only the top foam layer under any point is ever thinned.** The roof is right above it, so no later foam layer is printed over that point to pull the thickness back to ΔZ. The self-stabilization does not work against the change.
- **Smaller coils make denser support.** Coil size goes with H* (`coilModel.ts`: about 0.165 H* + 1.0 mm at 0.4 mm thread), so the foam the roof lands on is finer and denser where it is thinned. That is what a roof printed onto foam needs; nothing else has to be tuned for density.
- **The strip at the edge is fine.** It is at most one thinnest-layer above the layer below (about 0.5 mm, see 3), and the roof goes over it. Test print 3 looks at it.
- **It removes the deadlock rather than choosing who loses it.** With the foam kept below every roof line's nozzle, the foam can go first and the roof after.

### The assumption to test

The plan assumes that in a single layer the thickness follows the nozzle: lowering it by δ thins the layer by δ (the response g′ = dH_L/dH = 1). The paper's "several layers to settle" suggests g′ < 1 in general. Two reasons to expect it near 1 here: small coils at low H*, and a nozzle close enough to the fresh foam to bound its top. If the test print (5) gives g′ < 1, the plan still works with g′ as a setting: the nozzle is lowered δ / g′. But that eats into the gap between nozzle and fresh foam, which limits how thin a layer can be made and widens the empty strip.

## 3. The numbers, at the defaults

With H*₀ = 6, d = 0.4 mm (thread diameter), ΔZ = 1.7 mm, g′ = 1 and a lowest usable H* of 3 (the lowest H* in the Emery cubes; to be measured):

- Layer height at H*: `t(H*) = ΔZ − g′ (H*₀ − H*) d`, so t(3) = 1.7 − 3 × 0.4 = **0.5 mm**, the thinnest layer t_min.
- H* for a room t: `H* = H*₀ − (ΔZ − t) / (g′ d)`. A room of 1.1 mm gives H* 4.5.
- Nozzle gap above the fresh foam: `H*·d − t(H*)` = 2.4 − 1.7 = 0.7 mm at H* 6, and the same at every H* when g′ = 1.
- Empty strip at the roof edge: t_min / slope = 0.5 / 0.197 = **2.5 mm** wide on the 11° roof, at most 0.5 mm above the layer below.
- With points every 0.5 mm along a path (`TOOLPATH_FILL_DISTANCE`), H* changes by about 0.25 between neighbouring points across the 11° wedge.
- A coil reaches past its point. At H* 3 a coil is about 1.5 mm across, so toward the roof edge the room within its reach is smaller than at the point, by slope × coil radius: about 0.15 mm at 11°, 0.43 mm at 30°, and more on walls past 60°. The room is therefore taken over the coil's reach, not at the point (6.1).

## 4. Options considered and ruled out

| Option | What it would do | Why not |
|---|---|---|
| Print the covered foam first in the fallback | Choose the foam instead of the shell when stuck | The shell slices inside the band are then printed into foam that stands up to about 0.9 mm above their nozzle tip. Swaps one fault for another. |
| Terrace the roof | A shell line over foam is only printed from the top of that foam layer up | At 11°, a 1.7 mm step every 8.5 mm: changes the part's shape. Fine only for walls leaning 60–75°, where the steps are narrow. |
| Fill only inside the outline at the top of the layer | Foam never reaches the roof | The roof lines over the 8.5 mm wedge have up to 1.7 mm of nothing under them. |
| Keep the foam away from the roof (as C3 does for standing walls) | Cut the foam back from where the roof leans over it | On a roof the foam is the support; taking it away leaves the roof hanging. |
| Thinner ΔZ under roofs, or everywhere | Fewer mm per layer, narrower wedge | Changes whole layers and print time, and still leaves a (smaller) wedge that needs this fix. |
| Drape the top foam layer along the roof, at full thickness | Lower the layer so its top follows the roof | Its bottom then sits inside the layer below, which is already full. Only works if the whole stack is draped. |
| Share the thinning over several layers | Each of N layers under the roof a bit thinner | The self-stabilization pulls each nominal layer printed over a thinned one back to ΔZ, unless every nozzle height follows the layers below. More code, and changes more of the part. |
| Raise V\* to thin the layer | Less material per mm, nozzle where it is | V* sets coil density more than layer height, so the likely result is sparser foam at nearly the same height. Sparser foam is also worse support for the roof. |
| Pick (H*, V*) for the densest foam that fits, from the lab's layer-height model | A search per point | Unneeded: the smaller coils of a lower H* already make the foam denser. Adds a model dependency and complexity for no clear gain. |
| Raise H* in the layer below, under the empty strip | Layer k−1 comes up to the roof where layer k has too little room | Layer k−1 would then stand above the nozzle tips of the roof lines in layer k's band: the same deadlock, one layer down. The strip is fine as it is. |
| The `shell` branch's `hStarMax` (`f372e8f`) | Cap H* by distance to the region's edge, `H* · dist / coilRadius`, floor `(ΔZ + nozzle) / d` | Triggers on every edge (augmentations and vertical walls too), not on what is above. Sized from the base H*, not the gradient. Its floor assumed the layer stays ΔZ thick while the nozzle drops, which the self-stabilization result contradicts. Points under the floor were dropped silently, and it commented out the layer-height tests. The idea of a per-point cap is kept; the trigger and the numbers are replaced. |

## 5. Test prints, before relying on the defaults

None of this needs the slicer change; the existing `Test Start/End H*` pattern or a hand-written file is enough. TPU as used in the lab, 0.4 mm nozzle.

1. **Response.** Three layers at defaults, then one layer whose H* ramps from 6 down to 2.5 across the part. Measure that layer's thickness along the ramp (calipers on sections, or a scan). Gives g′ and t(H*).
2. **Lowest usable H\*.** The bar is "still supports a roof line", not just "still coils": print a few shell lines across the ramp from (1) at the height the plan would give them, and take the lowest H* where they sit without sinking or tearing. If the two bars differ, use the stricter one.
3. **Roof pieces,** once the code is in: boxes with gable roofs at 11°, 20° and 30° from horizontal, and a bar leaning 68° (C1), with and without the setting. Cut them open: foam through the roof, gaps under it, the roof over the empty strip.

## 6. Design

### 6.1 Room under the roof

For foam layer k, slice height z_k, the **band** is (z_k, z_k + ΔZ]. Only the shell regions in the band that **rest on this foam** (its id is in their `shellDependentRegions`) feed the room. They are the ones printed after it; the walls that stand are printed before it, and C3 already keeps the foam off them.

```
material(h)  = wall.outline(h) − grow(wall.inside(h), lineWidth / 2)     // from the ShellWall C3 added
room_k(x) = min over resting shell slices h in the band of
              (h − z_k)                         where x is under material(h)
              (h + shellLayerHeight + a − z_k)  where x is within nozzleRadiusAt(a) + NOZZLE_CLEARANCE of it
            capped at ΔZ
```

The first term keeps the foam under each roof line. The second keeps it below that line's nozzle as it is printed (tip at h + shellLayerHeight, widening as `nozzleRadiusAt`). It also covers the first walls of a part that starts on top of foam inside the band, which have the same problem.

**Over the coil's reach, not at the point.** The foam a point lays reaches a coil radius around it, so the room used for a point is the smallest room within that radius. Done once per layer by growing every area by the coil radius at the layer's nominal (uncapped) H*. That is conservative, since a lowered H* has a smaller coil, and avoids a circular dependency. C3 does the same with its gap.

**Stored as nested levels.** The room is rounded down to 0.1 mm levels, and for each level L the area where the room is ≤ L is kept as one Clipper union with one BVH:

```
RoofRoom = { levels: { room: number; area: PolygonWithHoles[]; bvh: SliceRegionBVHNode[] }[] }   // room ascending, areas nested
room(x)  = levels[first i whose area contains x].room, else ΔZ        // binary search: the areas are nested
```

At 11° that is about 17 levels per layer (one per shell slice), and a lookup tests about 5 of them. Without the levels it would be about 85 areas (17 slices × 5 cone heights), each tested at every point.

### 6.2 H* from the room (new `layerModel.ts`)

```
layerHeightAt(hStar, nominal = { hStar: H*₀, deltaZ }, d, response) = deltaZ − response · (H*₀ − hStar) · d
hStarForLayerHeight(t, nominal, d, response, minHStar):
    if t >= deltaZ: return H*₀
    return max(minHStar, H*₀ − (deltaZ − t) / (response · d))
thinnestLayer(nominal, d, response, minHStar) = layerHeightAt(minHStar, ...)
```

H*₀ is the point's own H* after the gradient, so the cap only ever lowers it: `point.hStar = min(gradientHStar, hStarForLayerHeight(room, ...))`. With `response` < 1 the code also checks `hStar·d − layerHeightAt(hStar) ≥ minGap`. A point that fails is clipped out like one with too little room, never left at full height.

### 6.3 What changes in the toolpath

1. **Area:** in `foamFill`, layer k's foam is clipped to where `room_k ≥ thinnestLayer`. Unlike C3's step, if that leaves nothing, the region gets no foam; it does not fall back to the unclipped area. The fill records whether the roof clip and cap applied (`roofApplied`), and the chunk builder reads that (6.4).
2. **Per point:** in `makeChunkPath`'s final loop, where `point.hStar` is set from the gradient, the cap above is applied. The points are still in model coordinates and at their slice height there, so `layerOf(point.point.z)` and `room(point.point)` can be read directly. `applyLayerHeight` then puts the point at H*·d above its slice as now, so the nozzle follows the roof down. No change to `PathPoint` or `fillToolpath`.
3. **Augmentations** are not touched: they have no walls (`context.wallGap` is unset), the same rule C3 uses.

### 6.4 Chunk order

1. **Hook:** `ChunkSource` gains `keptBelow(foam, shell)`. It is true only when the foam's room was built from that same shell **and** the foam's fill actually applied it (`roofApplied`). In `blockerOf`, a foam slot does not wait for an unprinted shell for which `keptBelow` is true; the shell still waits for the foam ("covers"), so the order is foam, then roof. Everything else is checked as now.
2. **Nozzle height:** `foamClearance` (the `tipOffset`) uses the lowest capped H* in the region. That makes the whole region look as low as its lowest point, which can change the order against other parts and cause new fallbacks there. Test it with two parts, one with a roof. If it does, add a pair-wise `tipOffsetNear(region, other)` that takes the lowest H* within reach of the other region.

### 6.5 Collision check

`printCollision.ts` (`Check Collisions` in Slice Prints) builds a height map from each point's own Z, but takes foam to stand ΔZ thick: `materialDrop` is `H*·d − deltaZ`. With a capped H* that puts thinned foam at full height. It becomes `H*·d − layerHeightAt(H*)`. The check only covers the head body; the nozzle itself is "a thin needle and is not checked", so it will not catch the lowered foam nozzle against walls. The chunk builder's `nozzleRadiusAt` check is the only protection there.

### 6.6 Settings

| Setting | Where | Default | Why |
|---|---|---|---|
| `Thin Foam Under Roofs` (checkbox) | printer-wide, next to `Check Collisions` | off until test print 3, then on | The same part can be sliced with and without it (the C5 complaint). |
| `Lowest H*` | per extruder, next to `Die Swell Factor` | 3 | Material-dependent; from test print 2. |
| `Layer Response` | per extruder | 1 | g′ from test print 1. Remove once it is known and stable. |

## 7. Changes by file

Pseudocode follows the codebase's patterns (callbacks on `ChunkSource`, per-layer maps on `ModelContext`, Clipper helpers in `TreeSlicer.ts`, pure models in their own file with a test).

### `src/visualizer/toolpath/layerModel.ts` (new) and `layerModel.test.ts` (new)
**Why:** the H*-to-layer-height relation in one testable place with no DOM, as `coilModel.ts` does for coil size.
**What:** `layerHeightAt`, `hStarForLayerHeight`, `thinnestLayer` (6.2), with doc comments stating that the relation is a straight line through the nominal point with slope `response`, not measured.
**Test:**
- the nominal point gives ΔZ;
- the inverse round-trips;
- the clamp at `minHStar`;
- `response` < 1 lowers H* further;
- a room ≥ ΔZ leaves H* alone.

### `src/visualizer/utils/TreeSlicer.ts`
**Why:** the geometry helpers and the chunk builder live here.
**What:**
1. `ChunkSource` gains
   ```ts
   /** Whether a foam region is kept below a shell while that shell is printed (fitted under it,
    *  see C6). Such a shell then does not hold the foam up. Defaults to never. */
   keptBelow?: (foam: SliceRegion, shell: SliceRegion) => boolean;
   ```
   and in `blockerOf`, after the `covers` check:
   ```ts
   if (!slot.region.shell && other.region.shell && slot.source.keptBelow?.(slot.region, other.region)) continue;
   ```
2. Helpers:
   - `intersectAreas(polygons, area)`, a Clipper intersection written like `keepAwayFrom`;
   - an exported point-in-area test over BVHs, wrapping `boundaryCrossingsRightOf`.
3. C7: give `blockerOf`'s result a `kind: 'covers' | 'nozzle' | 'head'`, and let the fallback warning say "is printed over foam that is not there yet" for `covers`. This can ship on its own now.

### `src/visualizer/toolpath/layerHeights.ts`
**Why:** `ModelContext` is where placement-dependent, per-model facts go (`wallGap`, `wallOverhangs`).
**What:** `roofRooms?: Map<number, RoofRoom>` (by layer, as `wallOverhangs`), with the `RoofRoom` type from 6.1, plus the extruder's `minHStar` and `layerResponse` (or read them from the printer where `threadDiameters` are read).

### `src/visualizer/toolpath/generateFoamToolpath.ts`
**Why:** this is where a Foam Print's regions are sliced, filled and given their H*.
**What:**
1. `findRoofRooms(regionTree, layerOf, layerZ, deltaZ, coilRadius, extruder)` next to `findWallOverhangs`, built the same way (shell regions by foam layer, slices sorted from the bottom):
   ```
   for each layer k, for each foam region F of layer k:
       resting = shell slices in F's band whose shellDependentRegions has F.id
       if none: continue
       areas by level = {}
       for each resting slice h:
           material = wall.outline(h) − grow(wall.inside(h), lineWidth / 2)
           add(level(h − z_k), material)
           for a in CONE_SAMPLES:
               add(level(h + shellLayerHeight + a − z_k), grow(material, nozzleRadiusAt(extruder, a) + NOZZLE_CLEARANCE))
           fedBy(F).add(h's region id)
       grow every area by coilRadius(nominal H*)                 // the coil's reach (6.1)
       make the levels nested: area(L) = union of the areas of every level ≤ L
       drop levels ≥ ΔZ; build a BVH per level
       rooms.set(k, merged with what is already there for layer k)
   ```
   Called in `generateFoamToolpath` right after `context.wallOverhangs = findWallOverhangs(...)`, only when the setting is on.
2. `foamWalls` / `foamFill`: `FoamWalls.roof?: { room: RoofRoom; thinnest: number }`. In `foamFill`, after the C3 steps, `pieces = intersectAreas(pieces, areaWhere(room ≥ thinnest))`. No fallback to the unclipped area. Record `roofApplied` on `FoamFill`, and add `roof` to the cache key.
3. `makeChunkPath`, final loop:
   ```ts
   const room = roofRoomAt(context, layerOf(point.point.z), point.point);   // ΔZ when none
   point.hStar = Math.min(point.hStar, hStarForLayerHeight(room, { hStar: point.hStar, deltaZ: stackDeltaZ },
                                                           threadDiameter, response, minHStar));
   ```
4. `foamClearance` takes `context` too, and makes `nozzleHeight` use the lowest capped H* in the region.
5. `chunkSources.push({ ..., keptBelow: (foam, shell) => fedBy(foam).has(shell.id) && foamFill(...).roofApplied })`.

### `src/visualizer/toolpath/printCollision.ts`
**Why:** its height map takes foam to be ΔZ thick (6.5).
**What:** `materialDrop` returns `H*·d − layerHeightAt(H*, …)`; it needs the nominal H* and response, so pass them in with the thread diameter, or tag them on the point.

### `src/printer/Printer.ts`
**Why:** printer- and extruder-level settings live here.
**What:**
- `thinFoamUnderRoofs: boolean` on `Printer` (default per 6.6).
- On `Extruder`: `minHStar` and `layerResponse`, defaulted in `createDefaultExtruder` and the constructor's two extruders. Old extruders without them fall back to the defaults, as `nozzleRadiusAt` does for the nozzle shape.

### `src/visualizer/gui/paramSpecs.ts`
**Why:** the tooltips and the README come from here.
**What:**
- `SETTING_SPECS.thinFoamUnderRoofs: bool('Thin Foam Under Roofs', 'Where a roof leans in over the foam within its layer, lower H* there so that layer is only as thick as the room under the roof, and print the roof after it. Where there is less room than the thinnest layer Lowest H* gives, no foam is laid.')`
- `EXTRUDER_SPECS.minHStar: num('Lowest H*', ...)` and `layerResponse: num('Layer Response', 0.1, 1, 0.01, ...)`, with their descriptions.

### `src/visualizer/Visualizer.ts`, `src/visualizer/gui/initGUI.ts`, `src/visualizer/gui/extruderSettings.ts`
**Why:** the controls have to reach the printer.
**What:**
- `Visualizer.ts`: `thinFoamUnderRoofs` in `config`, its default, and the copy to the printer next to `generateBoundary` / `checkCollisions`.
- `initGUI.ts`: add the checkbox to the list with `checkCollisions`.
- `extruderSettings.ts`: add `minHStar` and `layerResponse` to the extruder keys.

### `src/visualizer/gui/presetFormat.ts` and `presetFormat.test.ts`
**Why:** extruder fields are saved in presets (the nozzle-shape fields were added the same way).
**What:** carry the two new extruder fields, defaulting when a preset lacks them; extend the test's extruder fixture.

## 8. Tests

- **`toolpath/layerModel.test.ts`:** as above.
- **`toolpath/generateFoamToolpath.test.ts`,** with gable boxes at 11° and 30° and a bar leaning 68° (C1), setting on:
  - no foam point's top (slice height + `layerHeightAt(point.hStar)`) is above the room within its coil's reach;
  - no foam in the strip with less room than the thinnest layer;
  - H* changes between neighbouring points by no more than the room allows (no jumps);
  - with the setting off, the toolpath is the same as now;
  - vertical-walled parts (40 mm block, 12 mm post) give the same toolpath with the setting on;
  - augmentations are unchanged;
  - two parts, one with a roof, still slice without a fallback (6.4).
- **`utils/TreeSlicer.test.ts`:**
  - with `keptBelow`, the fitted foam goes before the roof lines that rest on it, and the fallback warning does not fire (spy on `console.warn`);
  - a `keptBelow` that is false for a region whose fit did not apply keeps the old check;
  - C7: the warning text for `covers`.
- **`toolpath/printCollision.test.ts`:** thinned foam puts the right height in the map.
- **`gui/presetFormat.test.ts`:** the new extruder fields round-trip and default.

## 9. Documentation (part of the same change, per CLAUDE.md)

- **README, "How a Foam Print Is Printed":** a point "Foam is fitted under roofs", with the numbers from 3, and say that the walls-first rule has this exception for roofs.
- **README, controls:** `Thin Foam Under Roofs`, `Lowest H*`, `Layer Response`, worded as in `paramSpecs.ts`.
- **README, Tests:** a row for `layerModel.test.ts`; update the rows for `generateFoamToolpath.test.ts`, `TreeSlicer.test.ts`, `printCollision.test.ts` and `presetFormat.test.ts`.
- **ISSUES.md:**
  - tick C6 and C7 with what was checked;
  - measure C1 again (the 68° bar);
  - add to "Behaviour changes to check before printing":
    - the thinned top layer under roofs and its lower nozzle;
    - the empty strip at the roof edge;
    - the denser foam there.
  - Say plainly that it was not run on a printer.
- Delete this plan once it is done, or keep it as the record of the decision.

## 10. Order of work

1. **Now, on its own:** C7 (the warning's wording). Small and independent.
2. Test prints 1 and 2 (no code). They set `Lowest H*` and `Layer Response`, and say whether g′ ≈ 1 holds.
3. `layerModel.ts` and its test.
4. `findRoofRooms` and the room lookup, with tests on the room values.
5. Area clip and per-point H* cap, behind the setting.
6. `keptBelow`; collision-check height (6.5).
7. Settings, presets, docs.
8. `npm run typecheck`, `npm test`, `npm run build`; slice "Part Studio 1 (2).stl" and confirm the warning no longer fires.
9. Test print 3; then decide the setting's default.

## 11. Risks and open questions

- **g′ < 1** shrinks the usable range and widens the empty strip; below about 0.5 the plan stops covering an 11° roof well.
- **Foam under roofs is denser and stiffer.** The paper ties H* to density and modulus. The preview's H* colouring shows it.
- **Region-wide nozzle height** may cause new fallbacks next to other parts (6.4).
- **Slicing time.** One more per-layer Clipper pass, similar to C3 (about 0.5 s on a 40 mm sphere).
- **More points with changing Z.** The G-code emitter already handles per-point H* from gradients, but the feed rate of a move whose Z changes should be checked in an export.
- **Flat tops (C8) are out of scope.** The shell is perimeters only, and the last foam slice sits at or below the model's top but is laid ΔZ thick, so the top layer can stand up to ΔZ above the part. Nothing rests on it, so there is no deadlock. The same room idea (room = model top − z_k) would fit it, but it changes the top of nearly every Foam Print, so it is a separate decision.
- **The fallback can still fire** for reasons other than this one; the warning stays as the detector.

## 12. As implemented (2026-11-18)

Steps 1 and 3 to 8 of section 10 are done; steps 2 and 9 (the test prints) are not. Where the code differs from sections 6 and 7:

- **Which walls feed the room.** Not only the shell regions that rest on this foam region, but every wall of the layer above its bottom slice that is printed after the foam: the ones `wallsBeforeFoam` (the C3 rule, shared with `findWallOverhangs`) does not count as standing on the wall below. A wall slice built on a resting one is printed after the foam too, through the shell chain, and would otherwise still block it. The room is one per layer (`RoofFit.rooms`), and `keptBelow(foam, shell)` is "the shell is one of the walls that layer's room was built from" (`RoofFit.fedBy`). Since the fill never falls back to the unclipped area, there is no `roofApplied` flag.
- **Upright parts of those walls.** A wall slice is one region per outline, so the vertical gable ends of a roof slice feed the room as well. Their nozzle passes over the foam beside them later, so that foam is lowered too, and its H* there changes as steeply as the nozzle's cone: up to about 1.6 H* between path points 0.4 mm apart next to a gable end. The test "H* changes between neighbouring points by no more than the room allows" was therefore not written; the tests check the room itself instead (no foam above a later wall line, none reaching into its nozzle).
- **Wall material.** `wallLineArea` takes the outline grown by half a line, less the inside shrunk by half a line (6.1 says grow the inside, which would leave out the inner half of the innermost line).
- **No rounding of the room.** The levels are the room values themselves, merged within 0.1 µm, rather than rounded down to 0.1 mm. The nozzle cone is sampled every 0.25 mm (`ROOF_NOZZLE_STEP`), each step with the nozzle as wide as at its top.
- **Nozzle height in the chunk builder (6.4.2).** `foamClearance` is unchanged. Instead `ChunkSource.lowestTipOffset` gives the dipped nozzle (lowest H* times d), and `blockerOf` checks every region against it except the walls of the same model that the foam is not kept below. Those are printed before the foam, lie below the roof's lowest line, and the foam's nozzle stays above the foam it lays, which is at least that high. Lowering the whole region's tip, as 6.4.2 proposed, made the walls printed before the foam wait for it, and the foam wait for them. The two-part test (a roofed box beside a block) slices without a fallback, so no pair-wise `tipOffsetNear` was needed.
- **Collision check (6.5).** `materialDrop` is unchanged: each lowered point's `deltaZ` is set to its own layer's thickness (`layerHeightAt`), which `materialDrop` already subtracts. The G-code comment of the point shows that thickness too.
- **Nozzle gap.** `lowestHStar` keeps the nozzle at least `minGap` = shell layer height + `NOZZLE_CLEARANCE` (0.2 mm) above the foam it lays, or as close as it is at the nominal H* if that is closer. That only matters for `Layer Response` below 1.
- **Thinnest layer.** Never thinner than one thread diameter (`thinnestLayer`), and worked out at the lowest H* of a region's gradient, which gives the thickest of the thinnest layers.
- **Coil reach.** The room is grown by half the coil diameter at the largest H* of the model's settings (both extruders, initial layers included), as C3 does.
- **Augmentations** have no walls (`wallGap` unset), so `foamWalls` returns nothing and `findRoofRooms` is not run for them.

