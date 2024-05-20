🧽 The foam augmentation slicer web app .

# How to use
1. Drag & drop `stl` file into the interface. The app should load the model into the center of the print bed automatically. 
    - Click `Save boundary G-Code` to save the bottom rectangular boundary constraint print (1 layer, single-pass scan). This constraint is used as the reference area for manually placing the object to be augmented. Default setting uses right extruder (T1) to print the boundary constraint.

!!! note
    Now the web app only supports one model per upload.
!!! warning
    Potential bugs in the bottom boundary slice (e.g. 0.1mm) print generation: **to be fixed**.

2. Hold `alt` (windows) or `option` (Mac) and draw with left cursor down to use lasso or rectangular selection to select part of the mesh. The specific parameters can be changed on the GUI menue. Hit `Save toolpath G-Code` button to download the gcode file for the foam printing toolpath. Default extruder is the left extruder (T0).
 - `selection` folder:
    - `toolMode`: lasso (free draw); box (rectangular draw)
    - `selectionMode`: centroid-visible (only select the visible part of the mesh, i.e. front part); intersection/centroid (also selects non-visible mesh)
    - `selectModel`: if checked, select the whole model
    - `liveUpdate`: if checked, live update the selected mesh and toolpath when lasso/box selection changes.
    - `selectWireframe`: if checked, show the selected mesh's wireframe.
- `display` folder:
    - `objectWireframe`: if checked, render the model in the wireframe mode.
    - `objectBoundingBox`: if checked, show the bounding box for the object.
    - `selectBoundingBox`: if checked, show the bounding box for the selected mesh.
- `printer settings` folder:
    - `bedTemp`: bed temperature.
    - `nozzleLeftTemp`: left extruder temperature.
    - `nozzleRightTemp`: right extruder temperature.
    - `machineDepth`: the max width and length (in mm; assuming that the print bed is a square shape: width = length) of the print space.
    - `machineHeight`: the max height (in mm) of the print space.
- `foam toolpath` folder:
    - `zOffset`: the initial (first layer) distance (mm) between the nozzle and the print bed / object. 
    - `deltaZ`: the delta z distance between different layers of toolpath scan,
    - `foamLayers`: the number of toolpath scanning layers.
    - `extrudeFoamRate`: the speed ratio of extrusion and movement ($V_{extrude} / V_{movement}$). Or can be comprehended as: nozzle move 1mm, `extrudeFoamRate`mm of filament will be extruded.
    - `extrudeFoamSpeed`: nozzle foam print movement speed. Tuning this value will cause the extrusion speed change proportionally (according to the `extrudeFoamRate`). Faster `extrudeFoamSpeed` will lead to faster nozzle movement (less time for the extruded filament to cool down, which would be useful in the conductive TPU printing) and extrusion (might cause filament to get caught in the extruder, in which case might require a larger nozzle diameter).


> [!NOTE]
> Now only supports one time selection: if unsatisfied with the current selection, needs to reselect again.
> **To do**: add features like hold `shift` key to add mesh to selection; hold `control` key to remove mesh from selection. 