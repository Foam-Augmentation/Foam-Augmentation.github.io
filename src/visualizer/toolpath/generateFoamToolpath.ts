import * as THREE from 'three';
import type Visualizer from '../Visualizer';
import type Printer from '../../printer/Printer';
import type { EverydayModel, PointCloudPoint } from '../types/modelTypes';
import {
    sliceMeshIntoLayers,
    extractRegionsFromLayer,
    buildRegionTree,
    SliceRegion,
    generateBoundaryContours,
    generateInsetContourTree,
    getBounds,
    connectIsocontours,
    buildChunkTree,
    ChunkNode,
    extractRegionsFromPointCloud,
    pointAlongLine,
    pointInPolygon,
    offsetRegion,
    getBoundarySegments,
    buildSliceRegionBVH,
    LineSegment,
    SliceRegionBVHNode,
    extractShellRegionsFromLayer,
} from '../utils/TreeSlicer';
import { notify } from '../gui/notify';
import { FEATURE, type PathPoint } from './pathTypes';
import { buildToolpathPreview } from './toolpathPreview';
import { applyLayerHeight, LayerHeights, LayerStack, ModelContext } from './layerHeights';
import { getRequiredZOffset } from './collision';
import {
    BOUNDARY_FIRST_LAYER_Z,
    BOUNDARY_LAYER_HEIGHT,
    BOUNDARY_OFFSET,
    COLLISION_OFFSET_TOLERANCE,
    CURVE_AUGMENT_EXTRA_FLAT_LAYERS,
    LAYER_INDEX_TOLERANCE,
    POINT_CLOUD_ALPHA,
    PURGE_LINE_COUNT,
    PURGE_LINE_SEPARATION,
    PURGE_LINE_Z,
    PURGE_TOWER_POINT_SPACING,
    PURGE_TOWER_WALL_LINES,
    TOOLPATH_FILL_DISTANCE,
    TOP_LAYER_TOLERANCE,
    TRAVEL_CLEARANCE,
    TRAVEL_PREVIEW_COLOR,
} from './toolpathConstants';

export type { PathPoint, PathRole } from './pathTypes';

/** How many shell (regular, non-foam) perimeters are printed around each layer of a sliced model. */
const SHELL_LAYER_COUNT = 2;

/**
 * Throws a readable error for a parameter that has to be positive. A zero or negative layer
 * thickness, line spacing or grid size would otherwise make a slicing loop run forever.
 *
 * @param {number} value The value to check.
 * @param {string} name What to call the value in the error message.
 */
function assertPositive(value: number, name: string): void {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be greater than 0 (it is ${value}).`);
    }
}

/**
 * Appends every element of one array to another. Used instead of `target.push(...source)`,
 * which passes each element as a call argument and overflows the stack on long toolpaths.
 */
function pushAll<T>(target: T[], source: T[]): void {
    for (const item of source) {
        target.push(item);
    }
}

/**
 * Removes a model's toolpath visualization from the scene and frees its GPU resources.
 *
 * @param {Visualizer} visualizer The visualizer whose scene holds the visualization.
 * @param {EverydayModel} modelObj The model to clear the visualization of.
 */
function removeToolpathVisualization(visualizer: Visualizer, modelObj: EverydayModel): void {
    if (!modelObj.toolpathVisualizationObject) {
        return;
    }
    visualizer.scene.remove(modelObj.toolpathVisualizationObject);
    modelObj.toolpathVisualizationObject.traverse((child: any) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
    });
    modelObj.toolpathVisualizationObject = undefined;
}

/**
     * visualize single layer of segments (could be foam, sense or all)
     *
     * @param globalSegments - An array of segments (each segment is an array of sample points).
     * @param type - The type of segments to be visualized ('sensing' or 'regular').
     * @param zOffset - The z-axis offset to be applied.
     * @returns A THREE.Object3D representing the visualized segments, or null if no segments exist.
     */
function _visualizeSegments(globalSegments: PointCloudPoint[][], type: 'sensing' | 'regular', zOffset: number): THREE.Object3D | null {
    if (globalSegments.length === 0) return null;
    let obj: THREE.Object3D;
    if (globalSegments.length === 1) {
        let vertices: number[] = [];
        globalSegments[0].forEach((item: { point: THREE.Vector3 }) => {
            vertices.push(item.point.x, item.point.y, item.point.z);
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
        // if globalSegments[0][0].type === 'foam', color is 0x00ff00, else 0x0000ff
        const material = new THREE.LineBasicMaterial({ color: type === 'regular' ? 0xCACAFF : 0x58ea96 });
        obj = new THREE.Line(geometry, material);
    } else {
        obj = new THREE.Group();
        const palette = type === 'regular' ? [0x5c5cff, 0x7d7dff, 0x9797ff, 0xacacff] : [0x58ea96, 0x2d784d, 0x1d4d32, 0xc8f8dd];
        globalSegments.forEach((seg, idx) => {
            let vertices: number[] = [];
            seg.forEach((item: { point: THREE.Vector3 }) => {
                vertices.push(item.point.x, item.point.y, item.point.z);
            });
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices), 3));
            const material = new THREE.LineBasicMaterial({ color: palette[idx % palette.length] });
            const line = new THREE.Line(geometry, material);
            (obj as THREE.Group).add(line);
        });
    }
    obj.position.set(0, 0, zOffset);
    return obj;
}

/**
 * visualize and organize all layers of segments (based on toolpathConfig.deltaZ, toolpathConfig.zOffset, and sandwiched structure layer counts), call visualizeSegments for each layer
 * @param visualizer 
 * @param modelObj 
 */
export function visualize_All_Layers(visualizer: Visualizer, modelObj: EverydayModel): void {
    /** remove previous toolpathVisualizationObject */
    if (modelObj.toolpathVisualizationObject) {
        visualizer.scene.remove(modelObj.toolpathVisualizationObject);
        modelObj.toolpathVisualizationObject.traverse((child: any) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
        modelObj.toolpathVisualizationObject = undefined;
    }

    const zOffset = modelObj.toolpathConfig.hStar * (visualizer.printer.extruders[0].nozzleDiameter * visualizer.printer.extruders[0].dieSwelling);

    let visualizationGroup: THREE.Group | undefined;
    if (modelObj.toolpathSamplePoints && modelObj.toolpathSamplePoints.every((item: any) => item.type === 'foam')) {
        if (modelObj.regular_area_segments) {
            // visualizationGroup = visualizeSegments(modelObj.regular_area_segments, 0x00ff00, 20) as THREE.Group;
            let layerCount = 0;
            visualizationGroup = new THREE.Group() as THREE.Group;
            for (let i = 0; i < modelObj.toolpathConfig.initialFoamLayerCount; i++) {
                const toolpathFoam = _visualizeSegments(modelObj.regular_area_segments, 'regular', zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                if (toolpathFoam) visualizationGroup.add(toolpathFoam);
                layerCount++;
            }
        }
    } else {
        if (modelObj.all_area_segments && modelObj.regular_area_segments && modelObj.sense_area_segments) {
            let layerCount = 0;
            visualizationGroup = new THREE.Group() as THREE.Group;
            for (let i = 0; i < modelObj.toolpathConfig.initialFoamLayerCount; i++) {
                const toolpathAll = _visualizeSegments(modelObj.all_area_segments, 'regular', zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                if (toolpathAll) visualizationGroup.add(toolpathAll);
                layerCount++;

            }
            for (let i = 0; i < modelObj.toolpathConfig.middleSenseLayerCount; i++) {
                const toolpathSense = _visualizeSegments(modelObj.sense_area_segments, 'sensing', zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                const toolpathFoam = _visualizeSegments(modelObj.regular_area_segments, 'regular', zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                if (toolpathSense) visualizationGroup.add(toolpathSense);
                if (toolpathFoam) visualizationGroup.add(toolpathFoam);
                layerCount++;

            }
            for (let i = 0; i < modelObj.toolpathConfig.finalFoamLayerCount; i++) {
                const toolpathAll = _visualizeSegments(modelObj.all_area_segments, 'regular', zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                if (toolpathAll) visualizationGroup.add(toolpathAll);
                layerCount++;

            }
            // const toolpathAll = visualizeSegments(modelObj.all_area_segments, 0xff00ff, 10);
            // const toolpathFoam = visualizeSegments(modelObj.regular_area_segments, 0x00ff00, 20);
            // const toolpathSense = visualizeSegments(modelObj.sense_area_segments, 0x0000ff, 30);
            // visualizationGroup = new THREE.Group() as THREE.Group;
            // if (toolpathAll) visualizationGroup.add(toolpathAll);
            // if (toolpathFoam) visualizationGroup.add(toolpathFoam);
            // if (toolpathSense) visualizationGroup.add(toolpathSense);
        }
    }
    // Position the parent group at the model's mesh position.
    if (visualizationGroup) {
        // Add the toolpath visualization to the scene.
        visualizer.scene.add(visualizationGroup);
        // Save the generated toolpath visualization to the model object.
        modelObj.toolpathVisualizationObject = visualizationGroup as THREE.Group;
    }
    modelObj.toolpathVisualizationObject = visualizationGroup as THREE.Group | undefined;

}


/**
 * Gets the smallest distance from a contour to a given point.
 * 
 * @param {THREE.Vector3} point The point to find the distance to
 * @param {THREE.Vector3} contour The contour to find the distance from
 * @returns {number} The lowest possible distance from the given contour to the given point.
 */
function contourDistToPoint(
    point: THREE.Vector3,
    contour: THREE.Vector3[]
): number {
    let lowestDist = Infinity
    let lastPoint = contour[contour.length - 1];
    for (const contourPoint of contour) {
        let closestPointOnLine: THREE.Vector3 = new THREE.Vector3;
        const line = new THREE.Line3(lastPoint, contourPoint);
        line.closestPointToPoint(point, true, closestPointOnLine);
        const dist = point.distanceTo(closestPointOnLine);
        if (dist < lowestDist) {
            lowestDist = dist;
        }
        lastPoint = contourPoint;
    }
    return lowestDist;
}


/**
 * Fills a toolpath with points so that the maximum distance between points is fillDist.
 * Maintains parameters for filled points.
 * Used for curving the toolpath and for gradients.
 * 
 * @param {PathPoint[]} toolpath The toolpath to fill
 * @param {number} fillDist The maximum distance points can be from each other in the toolpath
 * @returns {PathPoint[]} The new path filled with points.
 */
function fillToolpath(
    toolpath: PathPoint[],
    fillDist: number
): PathPoint[] {
    const newPath: PathPoint[] = [];
    if (!toolpath.length) {
        return newPath;
    }
    for (let i = 0; i < toolpath.length - 1; i++) {
        const point = toolpath[i];
        const nextPoint = toolpath[i + 1];
        newPath.push(point);
        const dist = point.point.distanceTo(nextPoint.point);

        if (dist > fillDist) {
            // A travel move that starts or ends on a helper point (purge tower, approach) is itself
            // only an approach: its in-between points can be far above the model, so they must not
            // be mistaken for model points or for part of the tower.
            const role = nextPoint.travel
                ? (nextPoint.role !== undefined || point.role !== undefined ? 'approach' : undefined)
                : nextPoint.role;
            for (let j = 1; j < Math.floor(dist / fillDist); j++) {
                newPath.push({
                    point: pointAlongLine(point.point, nextPoint.point, j * fillDist),
                    travel: nextPoint.travel,
                    regularSegment: nextPoint.regularSegment,
                    ironing: nextPoint.ironing,
                    role: role,
                    layerHeight: nextPoint.layerHeight,
                    initialMaterial: nextPoint.initialMaterial,
                    // The points in between are part of the move to nextPoint.
                    objectId: nextPoint.objectId,
                    layer: nextPoint.layer,
                    feature: nextPoint.feature,
                    extruder: point.extruder,
                    hStar: point.hStar,
                    vStar: point.vStar,
                    edot: point.edot,
                    deltaL: point.deltaL
                });
            }
        }
    }

    newPath.push(toolpath[toolpath.length - 1])
    return newPath;
}


/**
 * Fills a contour so the maximum distance between points is fillDist.
 * 
 * @param {THREE.Vector3[]} contour The contour to fill
 * @param {number} fillDist The maximum distance between points
 * @returns {THREE.Vector3[]} The new filled contour
 */
function fillContour(
    contour: THREE.Vector3[],
    fillDist: number
): THREE.Vector3[] {
    const newPath: THREE.Vector3[] = [];
    for (let i = 0; i < contour.length - 1; i++) {
        const point = contour[i];
        const nextPoint = contour[i + 1];
        newPath.push(point);
        const dist = point.distanceTo(nextPoint);

        if (dist > fillDist) {
            for (let i = 1; i < Math.floor(dist / fillDist); i++) {
                newPath.push(pointAlongLine(point, nextPoint, i * fillDist));
            }
        }
    }

    newPath.push(contour[contour.length - 1])
    return newPath;
}


/**
 * Creates a rectilinear path to fill in a given contour.
 * Certain contour geometries may cause the toolpath to go outside of the contour.
 * 
 * @param {THREE.Vector3[]} contour The contour to create the path inside of.
 * @param {number} deltaL How far apart the infill lines will be.
 * @param {boolean} scanX If true, the lines will have a constant x and varying y instead of the other way around.
 * @param {lastLayerPoint} lastLayerPoint The last point printed so far. It will try to start as close to this as possible.
 * @returns {THREE.Vector3[]}
 */
function generateRectilinearInfill(
    contour: THREE.Vector3[],
    deltaL: number,
    scanX: boolean,
    lastLayerPoint: THREE.Vector3,
    edot?: number,
): PathPoint[] {
    const toolpath: PathPoint[] = [];
    assertPositive(deltaL, 'Line spacing (deltaL)');
    if (!contour.length) {
        return toolpath;
    }
    const bounds = getBounds(contour, contour[0].z);
    const corners = [new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z), new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.min.z), new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.min.z)]

    let lowestDist = Infinity;
    let startPoint = new THREE.Vector3;
    for (const corner of corners) {
        const dist = corner.distanceTo(lastLayerPoint);
        if (dist < lowestDist) {
            lowestDist = dist;
            startPoint = corner;
        }
    }

    let atRight = false;
    let atTop = false;

    if (startPoint.x === bounds.min.x && scanX) {
        atRight = false;
    } else if (scanX) {
        atRight = true;
    } else if (startPoint.y === bounds.min.y) {
        atRight = false;
    } else {
        atRight = true;
    }

    if (startPoint.x === bounds.min.x && !scanX) {
        atTop = false;
    } else if (!scanX) {
        atTop = true;
    } else if (startPoint.y === bounds.min.y) {
        atTop = false;
    } else {
        atTop = true;
    }

    let scanLength = ((scanX ? bounds.max.x - bounds.min.x : bounds.max.y - bounds.min.y) / deltaL) + 1;
    const remainder = scanLength - Math.floor(scanLength);
    scanLength = Math.floor(scanLength);

    if (scanX) {
        startPoint.setX(startPoint.x + (atRight ? -1 : 1) * remainder / 2);
    } else {
        startPoint.setY(startPoint.y + (atRight ? -1 : 1) * remainder / 2)
    }

    for (let i = 0; i < scanLength; i++) {
        const currentScanPoint = (atRight ? -i * deltaL : i * deltaL) + (scanX ? (startPoint.x) : (startPoint.y));
        const intersections: THREE.Vector3[] = [];
        for (let i = 0; i < contour.length; i++) {
            const a = contour[i];
            const b = contour[(i + 1) % contour.length];
            if (scanX) {
                if ((a.x <= currentScanPoint && b.x > currentScanPoint) || (b.x <= currentScanPoint && a.x > currentScanPoint)) {
                    // Edge crosses the scanline
                    const t = (currentScanPoint - a.x) / (b.x - a.x);
                    const y = a.y + t * (b.y - a.y);
                    intersections.push(new THREE.Vector3(currentScanPoint, y, contour[0].z));
                }
            } else {
                if ((a.y <= currentScanPoint && b.y > currentScanPoint) || (b.y <= currentScanPoint && a.y > currentScanPoint)) {
                    // Edge crosses the scanline
                    const t = (currentScanPoint - a.y) / (b.y - a.y);
                    const x = a.x + t * (b.x - a.x);
                    intersections.push(new THREE.Vector3(x, currentScanPoint, contour[0].z));
                }
            }
        }

        if (intersections.length <= 1) {
            toolpath.push(...intersections.map(point => {
                return{
                    point,
                    travel: false,
                    edot
                }
            }));
            continue;
        }

        intersections.sort((a, b) => scanX ? (atTop ? b.y - a.y : a.y - b.y) : (atTop ? b.x - a.x : a.x - b.x));

        toolpath.push({point: intersections[0],travel: false, edot});
        toolpath.push({point: intersections[intersections.length - 1],travel: false, edot});
        atTop = !atTop;
    }

    return toolpath;
}

/**
 * Slices a region's boundary along an X or Y axis-aligned line
 * and returns the intersection points sorted along the perpendicular axis.
 *
 * Walks the region's BVH rather than its whole segment list: a node whose bounds don't reach the
 * slice line can't hold a segment that crosses it, so the entire subtree underneath is skipped.
 * A scan line only crosses the boundary a handful of times, so this visits far fewer segments
 * than there are in the region.
 *
 * @param {SliceRegionBVHNode} bvh The root of the BVH over the boundary segments to slice.
 * @param {'x' | 'y'} axis The axis the slice line is perpendicular to.
 * @param {number} sliceValue Where along that axis to slice.
 * @param {number} epsilon Tolerance for a segment counting as touching or lying on the slice line.
 * @returns {THREE.Vector3[]} The deduplicated intersection points, sorted along the other axis.
 */
export function sliceSegments(
  bvh: SliceRegionBVHNode,
  axis: 'x' | 'y',
  sliceValue: number,
  epsilon: number = 1e-6
): THREE.Vector3[] {
  const intersections: THREE.Vector3[] = [];
  const crossAxis = axis === 'x' ? 'y' : 'x';

  // Iterative rather than recursive so that a deep tree can't overflow the stack. A node with no
  // children is a leaf and holds segments; an internal node's leafSegments is empty, so the
  // segment loop below is a no-op for it.
  const stack: SliceRegionBVHNode[] = [bvh];

  while (stack.length) {
    const node = stack.pop()!;

    // 1. Skip nodes completely on one side of the cutting line, along with everything below them
    if (sliceValue < node.min[axis] - epsilon || sliceValue > node.max[axis] + epsilon) {
      continue;
    }

    if (node.left) stack.push(node.left);
    if (node.right) stack.push(node.right);

    for (const segment of node.leafSegments) {
      const startVal = segment.start[axis];
      const endVal = segment.end[axis];

      const minVal = Math.min(startVal, endVal);
      const maxVal = Math.max(startVal, endVal);

      // 2. Skip segments completely on one side of the cutting line. A leaf's bounds are looser
      // than its individual segments, so this still has to be checked per segment.
      if (sliceValue < minVal - epsilon || sliceValue > maxVal + epsilon) {
        continue;
      }

      // 3. Handle collinear segments (segment lies flat ON the slice line)
      // Prevents division by zero in the t-calculation below.
      if (Math.abs(endVal - startVal) < epsilon) {
        if (Math.abs(startVal - sliceValue) < epsilon) {
          intersections.push(segment.start.clone(), segment.end.clone());
        }
        continue;
      }

      // 4. Calculate linear interpolation factor (t)
      const t = (sliceValue - startVal) / (endVal - startVal);
      const clampedT = Math.max(0, Math.min(1, t)); // Clamp to [0, 1] for safety

      // Use Three.js lerp to compute the exact X, Y, and Z intersection
      const intersectionPoint = segment.start.clone().lerp(segment.end, clampedT);
      intersections.push(intersectionPoint);
    }
  }

  // 5. Deduplicate points (crucial when slicing directly through a shared vertex)
  const uniqueIntersections: THREE.Vector3[] = [];
  for (const pt of intersections) {
    const isDuplicate = uniqueIntersections.some(
      (existing) => existing.distanceToSquared(pt) < epsilon * epsilon
    );
    if (!isDuplicate) {
      uniqueIntersections.push(pt);
    }
  }

  // 5. Sort points along the cross axis (e.g., if X-slice, sort from lowest to highest Y)
  uniqueIntersections.sort((a, b) => a[crossAxis] - b[crossAxis]);

  return uniqueIntersections;
}

/**
 * Creates a rectilinear path filling a region that may have holes: the region's boundary is cut
 * along evenly spaced scan lines, and the pieces of each line that lie inside the region are
 * printed nearest-first.
 *
 * @param {SliceRegionBVHNode} boundaryBVH BVH over the boundary segments (outer contour and holes) to cut.
 * @param {THREE.Vector3[]} outContour The outer contour, which sets the area the scan lines cover.
 * @param {number} deltaL How far apart the infill lines are. Must be positive.
 * @param {boolean} scanX If true, the lines have a constant x and varying y instead of the other way around.
 * @param {THREE.Vector3} lastLayerPoint The last point printed so far. The path starts as close to it as possible.
 * @param {number} [edot] Filament feed rate to tag the extruding points with.
 * @returns {PathPoint[]} The infill path. Empty if no scan line crosses the region.
 * @throws {Error} If a scan line crosses the boundary an odd number of times (the outline is open).
 */
function generateRectilinearInfillWithHoles(
    boundaryBVH: SliceRegionBVHNode,
    outContour: THREE.Vector3[],
    deltaL: number,
    scanX: boolean,
    lastLayerPoint: THREE.Vector3,
    edot?: number,
): PathPoint[] {
    assertPositive(deltaL, 'Line spacing (deltaL)');
    if (!outContour.length) {
        return [];
    }
    const axis = scanX ? 'x': 'y';
    const bounds = getBounds(outContour, outContour[0].z);
    const corners = [new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z), new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.min.z), new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.min.z)]

    let lowestDist = Infinity;
    let startPoint = new THREE.Vector3;
    for (const corner of corners) {
        const dist = corner.distanceTo(lastLayerPoint);
        if (dist < lowestDist) {
            lowestDist = dist;
            startPoint = corner;
        }
    }

    // Whether the scan starts at the high end of the scan axis and works its way down.
    let atRight = false;

    if (startPoint.x === bounds.min.x && scanX) {
        atRight = false;
    } else if (scanX) {
        atRight = true;
    } else if (startPoint.y === bounds.min.y) {
        atRight = false;
    } else {
        atRight = true;
    }

    const scanLength = ((scanX ? bounds.max.x - bounds.min.x : bounds.max.y - bounds.min.y) / deltaL) + 1;
    const remainder = scanLength - Math.floor(scanLength);

    if (scanX) {
        startPoint.setX(startPoint.x + (atRight ? -1 : 1) * remainder / 2);
    } else {
        startPoint.setY(startPoint.y + (atRight ? -1 : 1) * remainder / 2)
    }

    const printLines: LineSegment[] = [];
    const firstCut = startPoint[axis];
    const cutStep = deltaL * (atRight ? -1 : 1);

    // Stepped by index rather than by repeated addition, so rounding cannot drift or stall the loop.
    for (let k = 0; ; k++) {
        const cutposition = firstCut + k * cutStep;
        if (!(bounds.min[axis] <= cutposition && cutposition <= bounds.max[axis])) {
            break;
        }
        const points = sliceSegments(boundaryBVH,axis,cutposition);
        if(points.length % 2 != 0){
            throw new Error("Mesh is not watertight: a scan line crosses its outline an odd number of times. Repair the model and try again.");
        }
        for(let i = 0; i < points.length; i+=2){
            printLines.push({start:points[i], end:points[i+1]})
        }
    }
    if(!printLines.length){
        return [];
    }
    const toolpath: PathPoint[] = [];
    let printHead = printLines[0].start.distanceTo(startPoint) < printLines[0].end.distanceTo(startPoint) ? printLines[0].start: printLines[0].end;
    //toolpath.push({point: printHead, travel: true}) //travel to start
    while(printLines.length){
        //find closest point to printhead
        let start = false;
        let bestIndex = -1;
        let bestDist = Infinity;
        for(let i = 0; i < printLines.length; i++){
            const distToStart = printHead.distanceTo(printLines[i].start);
            const distToEnd = printHead.distanceTo(printLines[i].end);
            const chosenDist = Math.min(distToStart,distToEnd);
            if(bestIndex == -1 || chosenDist < bestDist){
                bestIndex = i;
                bestDist = chosenDist;
                start = chosenDist == distToStart;
            }
        }
        //travel to segment
        toolpath.push({point: printLines[bestIndex][start ? 'start': 'end'], travel: true});
        //move to other
        toolpath.push({point: printLines[bestIndex][!start ? 'start': 'end'], travel: false, edot});
        printHead = printLines[bestIndex][!start ? 'start': 'end'];
        //remove line
        printLines.splice(bestIndex, 1);
    }

    return toolpath;
}

/**
 * Where the purge tower stands and how it is built. Derived from the printer, so the tower
 * follows the bed size and the nozzle instead of assuming one particular machine.
 */
interface PurgeTowerSpec {
    /** Center of the tower on the bed. */
    center: THREE.Vector2;
    /** Outer radius of the tower (mm). */
    radius: number;
    /** Height of one tower layer (mm). */
    layerHeight: number;
    /** How far apart the turns of the spiral are (mm) for each extruder: about one extrusion width. */
    lineSpacings: number[];
}

/**
 * Reads the purge tower's position and dimensions off the printer.
 *
 * @param {Printer} printer The printer the tower is printed on.
 * @returns {PurgeTowerSpec} The tower's position and dimensions.
 */
function makePurgeTowerSpec(printer: Printer): PurgeTowerSpec {
    return {
        center: printer.purgeTowerCenter(),
        radius: printer.purgeTowerRadius,
        layerHeight: printer.regularLayerHeight(0),
        lineSpacings: printer.extruders.map(extruder => extruder.nozzleDiameter),
    };
}

/**
 * Generates one layer of the purge tower, as a single Archimedean spiral winding from the rim inwards
 * over a fixed number of turns. The tower is hollow: the spiral stops at an inner radius, leaving the
 * middle empty, so the layer is a thick ring (PURGE_TOWER_WALL_LINES beads wide) rather than a filled disc.
 * Being one unbroken curve with no corners, the head holds its speed across the whole layer.
 *
 * @param {number} extruder The extruder printing this layer. Set on every point.
 * @param {number} z The height to print the layer at.
 * @param {PurgeTowerSpec} tower Where the tower stands and how it is built.
 * @returns {PathPoint[]} The layer's toolpath. Its first point is a travel out to the spiral's start.
 */
function addPurgeTowerToolpathAtZ(
    extruder: number,
    z: number,
    tower: PurgeTowerSpec,
): PathPoint[] {
    const toolpath: PathPoint[] = [];
    const lineSpacing = tower.lineSpacings[extruder] ?? tower.lineSpacings[0];
    assertPositive(lineSpacing, 'Purge tower line spacing (nozzle diameter)');
    assertPositive(tower.radius, 'Purge tower radius');

    // The spiral stops once it has wound in by the wall thickness. The floor of one line spacing
    // keeps a thick wall setting from winding past the centre on a small tower.
    const innerRadius = Math.max(lineSpacing, tower.radius - PURGE_TOWER_WALL_LINES * lineSpacing);

    let theta = 0;
    let radius = tower.radius;

    while (radius > innerRadius) {
        toolpath.push({
            point: new THREE.Vector3(
                tower.center.x + radius * Math.cos(theta),
                tower.center.y + radius * Math.sin(theta),
                z,
            ),
            extruder: extruder,
            regularSegment: true,
            role: 'purgeTower',
            layerHeight: tower.layerHeight,
        });

        // Stepped along the curve rather than by a fixed angle, so chords stay about the same length.
        theta += PURGE_TOWER_POINT_SPACING / Math.max(radius, lineSpacing);
        radius = tower.radius - (lineSpacing * theta) / (Math.PI * 2);
    }

    // The first point is only how the head gets out to the rim, so nothing is extruded reaching it.
    if (toolpath.length) {
        toolpath[0].travel = true;
        toolpath[0].regularSegment = false;
    }

    return toolpath;
}

/**
 * Builds the intermediate travel point that gets the print head from one place to another without
 * dragging it through anything on the way. If the head is above its destination it crosses in x and
 * y first and drops afterwards; otherwise it climbs to the destination's height before crossing.
 *
 * @param {THREE.Vector3} from Where the print head currently is.
 * @param {PathPoint} to The first point of the path being approached.
 * @returns {PathPoint} The travel point to insert before `to`.
 */
function approachTravelPoint(from: THREE.Vector3, to: PathPoint): PathPoint {
    return {
        point: from.z >= to.point.z
            ? new THREE.Vector3(to.point.x, to.point.y, from.z)
            : new THREE.Vector3(from.x, from.y, to.point.z),
        travel: true,
        role: 'approach',
        hStar: to.hStar,
        vStar: to.vStar,
        edot: to.edot,
    };
}

/**
 * Finds the point on a closed contour that is nearest to a target, measured in XY.
 *
 * @returns The distance, the index of the segment (contour[i] -> contour[i + 1]) the point lies on,
 *          and the point itself.
 */
function closestPointOnContour(
    contour: THREE.Vector3[],
    target: THREE.Vector3,
): { dist: number, segIndex: number, point: THREE.Vector3 } {
    // Compare at the contour's own height, so the head being at a different z doesn't skew the result.
    const flatTarget = new THREE.Vector3(target.x, target.y, contour[0].z);
    const closest = new THREE.Vector3();
    let best = { dist: Infinity, segIndex: 0, point: contour[0].clone() };

    for (let i = 0; i < contour.length; i++) {
        const line = new THREE.Line3(contour[i], contour[(i + 1) % contour.length]);
        line.closestPointToPoint(flatTarget, true, closest);
        const dist = closest.distanceTo(flatTarget);
        if (dist < best.dist) {
            best = { dist, segIndex: i, point: closest.clone() };
        }
    }
    return best;
}

/**
 * Path for a shell region: the outer contour and each inner contour (stored in holes), each printed
 * as a complete closed loop.
 *
 * The next contour to print is always the one with a segment closest to where the head is. The loop
 * starts on that segment, at the point on it nearest the head, and goes all the way around until it
 * arrives back at the start, so every contour is finished before the next one begins. Points are
 * cloned because makeChunkPath moves them afterwards, and the region's contours are shared with its BVH.
 *
 * @param {SliceRegion} region The shell region to build the path for.
 * @param {THREE.Vector3} startPoint Where the print head is coming from, in the region's coordinates.
 */
function makeShellPath(region: SliceRegion, startPoint: THREE.Vector3): PathPoint[] {
    const path: PathPoint[] = [];
    const remaining = [region.contour, ...region.holes].filter(c => c.length >= 2);
    let head = startPoint;

    while (remaining.length) {
        // Pick the contour with the closest segment to the head.
        let bestIdx = 0;
        let best = closestPointOnContour(remaining[0], head);
        for (let i = 1; i < remaining.length; i++) {
            const candidate = closestPointOnContour(remaining[i], head);
            if (candidate.dist < best.dist) {
                best = candidate;
                bestIdx = i;
            }
        }
        const contour = remaining.splice(bestIdx, 1)[0];

        // Start at the closest point on that segment, walk the rest of the segment's end and every
        // other vertex in order, then come back to the start to close the loop.
        const loop: THREE.Vector3[] = [best.point];
        for (let k = 1; k <= contour.length; k++) {
            loop.push(contour[(best.segIndex + k) % contour.length]);
        }
        loop.push(best.point);

        // Drop consecutive duplicates (e.g. when the closest point lands exactly on a vertex).
        const deduped = loop.filter((p, i) => i === 0 || p.distanceToSquared(loop[i - 1]) > 1e-12);

        deduped.forEach((p, i) => {
            // the first point of each loop is a travel, the rest are standard (non-VTP) extrusion
            path.push({ point: p.clone(), travel: i === 0, regularSegment: i !== 0 });
        });

        head = deduped[deduped.length - 1];
    }
    return path;
}

/**
 * Stacks purge tower layers from the height the tower has already reached up to a target height.
 *
 * The tower keeps its own running height instead of following the model's, because it cannot do
 * anything else: chunks are printed one whole chunk at a time and each one covers its own band of z,
 * so the height the print is at when a tool change comes up moves both up and down, while a tower
 * can only ever grow. Where the model is instead gets handled by the travel move in and out.
 *
 * @param {number} extruder The extruder the tower is being printed with.
 * @param {number} fromHeight How much tower has already been laid down (in mm).
 * @param {number} toHeight The height to bring the tower up to (in mm). Below fromHeight prints nothing.
 * @param {THREE.Vector3} lastPoint Where the print head is coming from.
 * @param {PurgeTowerSpec} tower Where the tower stands and how it is built.
 * @returns {{ path: PathPoint[], height: number }} The layers' toolpath, and the tower's new height.
 */
function makePurgeTowerBlock(
    extruder: number,
    fromHeight: number,
    toHeight: number,
    lastPoint: THREE.Vector3,
    tower: PurgeTowerSpec,
): { path: PathPoint[], height: number } {
    assertPositive(tower.layerHeight, 'Purge tower layer height');
    const layerCount = Math.max(0, Math.ceil((toHeight - fromHeight) / tower.layerHeight));
    const path: PathPoint[] = [];

    for (let i = 1; i <= layerCount; i++) {
        pushAll(path, addPurgeTowerToolpathAtZ(extruder, fromHeight + i * tower.layerHeight, tower));
    }

    if (path.length) {
        const approach = approachTravelPoint(lastPoint, path[0]);
        approach.extruder = extruder;
        path.unshift(approach);
    }

    return { path: path, height: fromHeight + layerCount * tower.layerHeight };
}


/**
 * Generates the toolpath for a single chunk.
 *
 * Every point's H*, V* and Edot are resolved here (gradients included) and only then is its
 * height finished off, because H* is what sets how far above the layer below the nozzle rides.
 *
 * @param {ChunkNode} chunk The chunk to print the toolpath for. This should have a modelObj with the
 *                          config to print this chunk with.
 * @param {THREE.Vector3} lastLayerPoint The last point printed so far.
 * @param {Set<string>} printedRegions The ids of every region printed so far; this chunk's are added.
 * @param {number | undefined} height The height layer 0 of the model starts at, in model-local coordinates.
 *                                    Defaults to the bottom of the model's transformed mesh.
 * @param {boolean} initialScanX If true, the first layer scans the x direction, alternating every layer.
 *                               Only applicable for rectilinear infill.
 * @param {number} fillDist Controls the maximum distance points can be from the last in the toolpath. Lowering this
 *                          means more points are generated in the same space, leading to higher accuracy with gradients.
 * @param {LayerHeights} layerHeights How to finish off each point's z, and the placement of each model.
 * @returns {PathPoint[]} The generated toolpath. All foam points will have an hStar, vStar, and edot parameter.
 */
function makeChunkPath(
    chunk: ChunkNode,
    lastLayerPoint: THREE.Vector3,
    printedRegions: Set<string>,
    height: number | undefined,
    initialScanX: boolean,
    fillDist: number,
    layerHeights: LayerHeights,
): PathPoint[] {
    const modelObj = chunk.modelObj!;
    const context = layerHeights.models.get(modelObj);
    if (!context) {
        throw new Error(`No placement information for model "${modelObj.name}".`);
    }

    let lastLayerEndPoint = lastLayerPoint;
    let chunkPath: PathPoint[] = [];
    let scanX = initialScanX;
    const initialConfig = modelObj.initialConfig;
    const VTPSettings = chunk.VTPSettings;
    assertPositive(VTPSettings.deltaZ, 'Layer thickness (deltaZ)');
    // Layer 0 starts at the bottom of the mesh as it is placed (scaled and rotated), not of its raw geometry.
    const modelHeight = height ?? context.minZ;
    const layerOf = (z: number) => Math.floor((z - modelHeight + LAYER_INDEX_TOLERANCE) / VTPSettings.deltaZ);
    const initialOffset = modelObj.initialOffset;
    const gradient = modelObj.gradient;
    let count = 0;
    const isFirstChunkPrinted = printedRegions.size === 0;
    const totalHeight = context.maxZ - context.minZ;

    for (const region of chunk.regions) {
        printedRegions.add(region.id);
        const useInitial = !region.shell && layerOf(region.height) < initialConfig.initialFoamLayerCount;
        const configToUse = useInitial ? initialConfig : VTPSettings;

        // Vertical gradient for deltaL: bottom of the model = deltaL, top = deltaLEnd.
        let heightPercent = 0;
        if (totalHeight > 0) {
            heightPercent = Math.min(1, Math.max(0, (region.height - context.minZ) / totalHeight));
        }
        const currentDeltaL = configToUse.deltaL + heightPercent * (configToUse.deltaLEnd - configToUse.deltaL);

        let path: PathPoint[];
        if (region.shell) {
            let shellStart = count === 0 //switch to relative (model) coordinates
                ? lastLayerEndPoint.clone().sub(modelObj.mesh.position)
                : lastLayerEndPoint;
            path = [];
            if (!isFirstChunkPrinted && chunk.dependentRegions?.size) { //ironing pass: retrace the shell loops
                path = makeShellPath(region, shellStart);
                path.forEach(p => p.ironing = !p.travel);
                if (path.length) {
                    shellStart = path[path.length - 1].point;
                    path[0].debug = "IRONING START";
                    path[path.length - 1].debug = "IRONING END";
                }
            }
            pushAll(path, makeShellPath(region, shellStart));
        } else {
            assertPositive(currentDeltaL, 'Line spacing (deltaL)');
            const edot = useInitial ? initialConfig.edot : VTPSettings.Edot;

            // The initial layers are printed inside the region offset by `initialOffset`. The whole
            // region is offset at once (outer and holes together), so a region that splits apart
            // prints every piece, and holes that grow into the wall are clipped against it.
            const pieces = useInitial && initialOffset
                ? offsetRegion(region.contour, region.holes, initialOffset)
                : [{ outer: region.contour, holes: region.holes }];
            const isOffset = pieces.length !== 1 || pieces[0].outer !== region.contour;

            path = [];
            let pieceStart = lastLayerEndPoint;
            for (const piece of pieces) {
                if (piece.outer.length < 3) {
                    continue;
                }

                let piecePath: PathPoint[];
                if (VTPSettings.useFermatSpirals) {
                    const insetContoursRoot = generateInsetContourTree(piece.outer, piece.holes, currentDeltaL);
                    piecePath = connectIsocontours(insetContoursRoot, currentDeltaL, pieceStart, edot);
                } else {
                    // The infill is cut from the offset boundary, so the scan lines actually stop at it.
                    const boundaryBVH = isOffset
                        ? buildSliceRegionBVH(getBoundarySegments(piece.outer, piece.holes))
                        : region.BVH;
                    piecePath = generateRectilinearInfillWithHoles(boundaryBVH, piece.outer, currentDeltaL, scanX, pieceStart, edot);
                }

                if (!piecePath.length) {
                    continue;
                }
                // Moving from one piece to the next must not extrude across the gap between them.
                piecePath[0].travel = true;
                pieceStart = piecePath[piecePath.length - 1].point;
                pushAll(path, piecePath);
            }
            if (!VTPSettings.useFermatSpirals) {
                scanX = !scanX;
            }
        }

        if (!path.length) {
            continue;
        }

        // Every point of the region is on the same layer of the model's stack. A shell region is
        // sliced finer than the foam; it counts as part of the foam layer it sits in.
        const layer = layerOf(region.height);
        // Sensing regions are the ones on another extruder than the foam's (see Printer.getVTPSettings).
        const foamFeature = useInitial ? FEATURE.initialFoam : region.extruder !== 0 ? FEATURE.sensingFoam : FEATURE.foam;
        for (const point of path) {
            point.layer = layer;
            if (!point.travel) {
                point.feature = region.shell ? (point.ironing ? FEATURE.ironing : FEATURE.shell) : foamFeature;
            }
        }

        const prevPathLen = chunkPath.length;
        pushAll(chunkPath, path);
        chunkPath[prevPathLen].travel = true;

        lastLayerEndPoint = chunkPath[chunkPath.length - 1].point;
        count++;
    }

    if (!chunkPath.length) {
        return chunkPath;
    }
    chunkPath[0].travel = true;

    chunkPath = fillToolpath(chunkPath, fillDist);

    if (chunk.shell) {
        for (const point of chunkPath) {
            point.point.add(modelObj.mesh.position);
            point.point.z += layerHeights.shellLayerHeight;
            if (!point.travel) {
                point.layerHeight = layerHeights.shellLayerHeight;
            }
        }
        return chunkPath;
    }

    // Each chunk is printed by a single extruder, so its thread diameter sets H = H* d.
    const extruder = chunk.regions[0]?.extruder ?? 0;
    const threadDiameter = layerHeights.threadDiameters[extruder] ?? layerHeights.threadDiameters[0];
    const stack: LayerStack = {
        meshPosition: modelObj.mesh.position,
        deltaZ: modelObj.toolpathConfig.deltaZ,
        curveAugment: modelObj.toolpathConfig.curveAugment,
        totalLayers: modelObj.toolpathConfig.initialFoamLayerCount + initialConfig.initialFoamLayerCount,
        flatLayerZOffset: modelObj.toolpathConfig.flatLayerZOffset,
        augmentSamplePoints: modelObj.augmentSamplePoints,
    };
    // The SVG gradient is stretched over the whole model, so neighbouring chunks agree on it.
    const gradientMin = context.gradientBounds.min;
    const gradientWidth = context.gradientBounds.max.x - gradientMin.x;
    const gradientHeight = context.gradientBounds.max.y - gradientMin.y;
    const usesInitialMaterial = initialConfig.initialFoamLayerCount > 0;

    // Resolve H*, V* and Edot for every point, then finish off its height.
    for (const point of chunkPath) {
        const useInitial = layerOf(point.point.z) < initialConfig.initialFoamLayerCount;
        const configToUse = useInitial ? initialConfig : VTPSettings;
        const hStar = useInitial ? initialConfig.hStar : VTPSettings.H_star;
        const vStar = useInitial ? initialConfig.vStar : VTPSettings.V_Star;

        // How far along the gradient the point is: 0 = start values, 1 = end values.
        let percent: number;
        if (context.verticalGradient) {
            const { minZ, maxZ } = context.verticalGradient;
            percent = maxZ > minZ ? Math.min(1, Math.max(0, (point.point.z - minZ) / (maxZ - minZ))) : 0;
        } else {
            // A model with no width in x or y has nothing to stretch the gradient over.
            const scaledX = gradientWidth > 0 ? ((point.point.x - gradientMin.x) / gradientWidth) * gradient.width : 0;
            const scaledY = gradientHeight > 0 ? ((point.point.y - gradientMin.y) / gradientHeight) * gradient.height : 0;
            const sampledColor = gradient.sampleColor(scaledX, scaledY);
            // Black is 1 white is 0
            percent = 1 - (sampledColor.r + sampledColor.g + sampledColor.b) / (3 * 255);
        }

        point.hStar = hStar + percent * (configToUse.hStarEnd - hStar);
        point.vStar = vStar + percent * (configToUse.vStarEnd - vStar);
        point.edot = useInitial ? initialConfig.edot : VTPSettings.Edot;
        point.deltaZ = configToUse.deltaZ;
        point.deltaL = configToUse.deltaL;
        if (usesInitialMaterial) {
            point.initialMaterial = useInitial;
        }
        point.point.add(modelObj.mesh.position);

        applyLayerHeight(point, threadDiameter, stack, layerHeights.surface);
    }

    return chunkPath;
}


/**
 * Makes a toolpath that minimizes travel movements given a tree of printable chunk regions.
 * Expects the roots to have a modelObj object.
 *
 * Chunks are printed one after the other in a loop (rather than by recursion), and the finished
 * path is filled with intermediate points once at the end.
 *
 * @param {ChunkNode[]} roots The root nodes of the chunk tree. Emptied as the chunks are printed.
 * @param {THREE.Vector3} startPoint It will try to start the print as close to this point as possible.
 * @param {Set<string>} printedRegions The ids of the regions printed so far.
 * @param {number | undefined} modelHeight The height layer 0 starts at, in model-local coordinates.
 *                                         Leave undefined to use the bottom of each model's transformed mesh.
 * @param {LayerHeights} layerHeights Passed straight through to makeChunkPath, so that each chunk's points carry their real heights by the time the travel moves between chunks are worked out.
 * @param {PurgeTowerSpec} [purgeTower] The purge tower to build alongside the print. Leave out for no tower.
 * @param {number} purgeTowerStartHeight How tall the purge tower already is (mm), e.g. from a model printed before this one.
 * @returns {PathPoint[]} The toolpath that minimizes travel movements as a list of points.
 */
function makeChunkTreePath(
    roots: ChunkNode[],
    startPoint: THREE.Vector3,
    printedRegions: Set<string>,
    modelHeight: number | undefined,
    layerHeights: LayerHeights,
    purgeTower?: PurgeTowerSpec,
    purgeTowerStartHeight: number = 0,
): PathPoint[] {
    const toolpath: PathPoint[] = [];
    let lastPoint = startPoint;
    // Whether the next chunk's first layer scans the x or y axis. Only applies to rectilinear paths.
    let scanX = false;
    // The extruder that is currently picked, so chunks that need it are preferred over ones that
    // would force a tool change.
    let currentExtruder: number | undefined = undefined;
    let purgeTowerHeight = purgeTowerStartHeight;

    /** Replaces a chunk in the list of roots by its children, which become printable. */
    const replaceByChildren = (index: number) => {
        const chunk = roots[index];
        chunk.children.forEach(child => {
            child.modelObj = chunk.modelObj;
        });
        roots.splice(index, 1, ...chunk.children);
    };

    while (roots.length) {
        // A chunk without regions has nothing to print or to measure distances to.
        const emptyIndex = roots.findIndex(root => !root.regions.length);
        if (emptyIndex !== -1) {
            replaceByChildren(emptyIndex);
            continue;
        }

        const isBlocked = (chunk: ChunkNode) => chunk.shell && [...(chunk.dependentRegions ?? [])].some(id => !printedRegions.has(id));
        const unblockedIndices = roots.map((_, i) => i).filter(i => !isBlocked(roots[i]));
        const eligibleIndices = unblockedIndices.length ? unblockedIndices : roots.map((_, i) => i);

        let lowestHeight = Infinity;
        for (const i of eligibleIndices) {
            const height = roots[i].regions[0].height;
            if (height < lowestHeight) {
                lowestHeight = height;
            }
        }

        const printableChunkIndices = eligibleIndices.filter(
            i => roots[i].regions[0].height <= lowestHeight
        );

        const shellIndices = printableChunkIndices.filter(i => roots[i].shell);
        const pool = shellIndices.length ? shellIndices : printableChunkIndices;

        const sameExtruderIndices = pool.filter(
            i => roots[i].regions[0].extruder === currentExtruder
        );
        const candidateIndices = sameExtruderIndices.length ? sameExtruderIndices : pool;

        // for now it just prints the closest one. In the future can make hamiltonian path to find the most efficient path.
        let printIndex = candidateIndices[0];
        let lowestDist = Infinity;
        for (const i of candidateIndices) {
            const dist = contourDistToPoint(lastPoint.clone().sub(roots[i].modelObj!.mesh.position), roots[i].regions[0].contour);
            if (dist < lowestDist) {
                lowestDist = dist;
                printIndex = i;
            }
        }

        const chunk = roots[printIndex];
        const printExtruder = chunk.regions[0].extruder;
        const chunkPath = makeChunkPath(chunk, lastPoint, printedRegions, modelHeight, scanX, TOOLPATH_FILL_DISTANCE, layerHeights);
        const objectId = chunk.modelObj!.objectId;
        chunkPath.forEach(p => {
            p.extruder = printExtruder;
            p.objectId = objectId;
        });
        if (chunkPath.length) {
            chunkPath[0].debug = `NEW CHUNK. Min: ${chunk.regions[0].height}, MAX: ${chunk.regions[chunk.regions.length-1].height}, shell ${chunk.shell}, extruder ${printExtruder}, scanX ${scanX}` + (chunkPath[0].debug ? " | " + chunkPath[0].debug : "");
        }

        if (chunk.regions.length % 2 === 1) {
            scanX = !scanX;
        }

        let towerPath: PathPoint[] = [];
        if (purgeTower && chunkPath.length) {
            let chunkTopZ = -Infinity;
            for (const point of chunkPath) {
                if (point.point.z > chunkTopZ) {
                    chunkTopZ = point.point.z;
                }
            }

            const levelHeight = Math.max(purgeTowerHeight, chunkTopZ); //go at least as far as the top of the chunk
            const toolChanging = currentExtruder !== undefined && printExtruder !== currentExtruder;

            const block = makePurgeTowerBlock(
                toolChanging ? currentExtruder! : printExtruder,
                purgeTowerHeight,
                toolChanging ? Math.max(levelHeight, purgeTowerHeight + purgeTower.layerHeight) : levelHeight,
                lastPoint,
                purgeTower,
            );

            towerPath = block.path;
            purgeTowerHeight = block.height;
        }

        pushAll(toolpath, towerPath);
        if (chunkPath.length) {
            const approach = approachTravelPoint(
                towerPath.length ? towerPath[towerPath.length - 1].point : lastPoint,
                chunkPath[0],
            );
            approach.extruder = printExtruder; // the swap happens here, after the purge
            toolpath.push(approach);
        }

        replaceByChildren(printIndex);

        pushAll(toolpath, chunkPath);

        if (chunkPath.length) {
            lastPoint = chunkPath[chunkPath.length - 1].point;
        } else if (towerPath.length) {
            lastPoint = towerPath[towerPath.length - 1].point;
        }
        currentExtruder = printExtruder;
    }

    return fillToolpath(toolpath, TOOLPATH_FILL_DISTANCE);
}


/**
 * Given a matrix of points, returns a matrix of gradient values matching
 * the shape of the inputted matrix.
 * 
 * @param {THREE.Vector3[][]} pointMatrix The sorted matrix of points, with columns having constant x values.
 * @returns {THREE.Vector2[][]} The constructed gradient matrix.
 */
function makeGradientMatrix(
    pointMatrix: THREE.Vector3[][],
): THREE.Vector2[][] {
    const gradientMatrix: THREE.Vector2[][] = [];
    for (let i = 0; i < pointMatrix.length; i++) {
        const column = pointMatrix[i];
        let nextColumn: THREE.Vector3[];
        if (i >= pointMatrix.length - 1) {
            nextColumn = pointMatrix[i - 1];
        } else {
            nextColumn = pointMatrix[i + 1];
        }

        gradientMatrix.push([]);
        // A slope needs a neighbour in both directions: a lone column, or a column with a single
        // point, gets no gradients, so its points are kept without a steepness check.
        if (column.length <= 1 || !nextColumn || !nextColumn.length) {
            continue;
        }

        const columnDist = Math.abs(column[0].x - nextColumn[0].x);
        for (let j = 0; j < column.length; j++) {
            const point = column[j];
            let nextPoint: THREE.Vector3;
            if (j >= column.length - 1) {
                nextPoint = column[j - 1];
            } else {
                nextPoint = column[j + 1];
            }
            const yGradient = (nextPoint.z - point.z) / (nextPoint.y - point.y);

            let closestPointIndex = 0;
            let closestDist = Infinity;
            for (let k = 0; k < nextColumn.length; k++) {
                const otherPoint = nextColumn[k];
                const yDist = Math.abs(point.y - otherPoint.y);
                if (yDist < closestDist) {
                    closestDist = yDist;
                    closestPointIndex = k;
                }
            }

            if (closestDist > 1.5 * columnDist && i > 0 && i < pointMatrix.length - 1) {
                nextColumn = pointMatrix[i - 1];
                closestPointIndex = 0;
                closestDist = Infinity;
                for (let k = 0; k < nextColumn.length; k++) {
                    const otherPoint = nextColumn[k];
                    const yDist = Math.abs(point.y - otherPoint.y);
                    if (yDist < closestDist) {
                        closestDist = yDist;
                        closestPointIndex = k;
                    }
                }
            }

            const xGradient = (nextColumn[closestPointIndex].z - point.z) / (nextColumn[closestPointIndex].x - point.x);
            gradientMatrix[i].push(new THREE.Vector2(xGradient, yGradient));
        }
    }
    return gradientMatrix;
}


/**
 * Gets a copy of a mesh with its transforms applied to it, except position.
 * Position is always (0, 0, 0).
 * 
 * @param {THREE.Mesh} mesh The mesh to copy and apply transforms to.
 * @returns {THREE.Mesh} The copied and transformed mesh.
 */
export function getTransformedMesh(
  mesh: THREE.Mesh,
): THREE.Mesh {
    const position = mesh.position.clone();
    mesh.position.setScalar(0);
    mesh.updateWorldMatrix(true, false);

    const m = mesh.matrix;
    const geo = mesh.geometry.clone();
    geo.applyMatrix4(m);

    const newMesh = new THREE.Mesh(geo, mesh.material);
    mesh.position.set(position.x, position.y, position.z);
    return newMesh;
}


/** Options for {@link generateFoamToolpath}. */
export interface FoamToolpathOptions {
    /**
     * Whether the toolpath starts with a purge line. Left out, it follows the printer's own
     * `purgeLine` setting. Pass false when another toolpath in the same print already primes
     * the nozzle.
     */
    purgeLine?: boolean;
    /**
     * Whether to draw the toolpath in the scene (on the first model's `toolpathVisualizationObject`).
     * Defaults to true. Pass false when the caller draws a bigger toolpath it is part of.
     */
    preview?: boolean;
}

/**
 * Slices a model for foam printing, using travel slicer outer reductions to reduce travel movements
 * and uses either rectilinear or fermat spiral infill.
 *
 * @param {Visualizer} visualizer The Visualizer instance
 * @param {EverydayModel[]} modelObjs A list of model objects to slice.
 * @param {FoamToolpathOptions} options See {@link FoamToolpathOptions}.
 * @returns {PathPoint[]} The toolpath for the whole plate. Empty if there was nothing to slice.
 * @throws {Error} If a model's parameters cannot be sliced (e.g. a layer thickness of 0) or its
 *                 mesh is not watertight.
 */
export function generateFoamToolpath(
    visualizer: Visualizer,
    modelObjs: EverydayModel[],
    options: FoamToolpathOptions = {},
): PathPoint[] {
    if (!modelObjs.length) {
        return [];
    }

    const printer = visualizer.printer;
    const chunkRoots: ChunkNode[] = [];
    let highestStartHeight = -Infinity;
    let boundaryPath: PathPoint[] = [];
    const models = new Map<EverydayModel, ModelContext>();
    const shellLayerHeight = printer.shellLayerHeight;

    modelObjs.forEach(modelObj => {
        assertPositive(modelObj.toolpathConfig.deltaZ, `Layer thickness (deltaZ) of "${modelObj.name}"`);

        // Remove previous visualization
        removeToolpathVisualization(visualizer, modelObj);

        if (modelObj.pointsMesh_sense) {
            visualizer.scene.remove(modelObj.pointsMesh_sense);
            modelObj.pointsMesh_sense.geometry.dispose();
            (modelObj.pointsMesh_sense.material as THREE.Material).dispose();
        }

        if (modelObj.pointsMesh_foam) {
            visualizer.scene.remove(modelObj.pointsMesh_foam);
            modelObj.pointsMesh_foam.geometry.dispose();
            (modelObj.pointsMesh_foam.material as THREE.Material).dispose();
        }

        const transformedMesh = getTransformedMesh(modelObj.mesh);
        transformedMesh.geometry.computeBoundingBox();
        const bbox = transformedMesh.geometry.boundingBox!;
        if (bbox.isEmpty()) {
            return; // a mesh without vertices has nothing to slice
        }

        // Layer indices, the deltaL ramp and the gradient all have to follow the mesh as it is
        // placed (scaled and rotated), not its raw geometry.
        models.set(modelObj, {
            minZ: bbox.min.z,
            maxZ: bbox.max.z,
            gradientBounds: {
                min: new THREE.Vector2(bbox.min.x, bbox.min.y),
                max: new THREE.Vector2(bbox.max.x, bbox.max.y),
            },
        });

        if (printer.generateBoundary) {
            const boundary = makeBoundaryPath(transformedMesh, modelObj.mesh.position, printer.machine_depth_y, 1, BOUNDARY_OFFSET, false);
            tagBoundary(boundary, modelObj);
            boundaryPath = boundary.concat(boundaryPath);
        }

        // Update parameters for printing
        printer.updateParameters(modelObj.toolpathConfig);

        // --- 1. Slice mesh into layers and extract regions ---
        const layers = sliceMeshIntoLayers(transformedMesh, modelObj.toolpathConfig.deltaZ);
        const allRegions: SliceRegion[] = [];
        for (const { z, segments } of layers) {
            pushAll(allRegions, extractRegionsFromLayer(z, segments, printer.threadDiameter(0), SHELL_LAYER_COUNT));
        }

        // Shells are regular extrusions, sliced at their own layer height (printer.shellLayerHeight).
        const shellLayers = sliceMeshIntoLayers(transformedMesh, shellLayerHeight);
        for (const { z, segments } of shellLayers) {
            pushAll(allRegions, extractShellRegionsFromLayer(z, segments, printer.extruders[0].nozzleDiameter, SHELL_LAYER_COUNT));
        }

        const regionTree = buildRegionTree(allRegions, modelObj.toolpathConfig.deltaZ);
        regionTree.forEach(root => {
            const height = root.region.height + modelObj.mesh.position.z
            if (height > highestStartHeight) {
                highestStartHeight = height;
            }
        });

        const chunkTree = buildChunkTree(regionTree, printer);

        chunkTree.forEach(chunkNode => {
            chunkNode.modelObj = modelObj;
        });

        pushAll(chunkRoots, chunkTree);
    });

    const startPoint = new THREE.Vector3(0, 0, Number.isFinite(highestStartHeight) ? highestStartHeight : 0);
    // Each point's ZOffset is applied in makeChunkPath, where its hStar is resolved. The boundary
    // and purge line are added below on purpose: neither has an hStar to offset by.
    const modelPath = makeChunkTreePath(
        chunkRoots,
        startPoint,
        new Set<string>(),
        undefined,
        {
            threadDiameters: printer.extruders.map((_, i) => printer.threadDiameter(i)),
            shellLayerHeight,
            models,
        },
    );

    if (!modelPath.length) {
        return [];
    }

    const toolpath: PathPoint[] = [];
    if (options.purgeLine ?? printer.purgeLine) {
        pushAll(toolpath, makePurgeLine(printer));
    }
    pushAll(toolpath, boundaryPath);
    pushAll(toolpath, modelPath);

    if (options.preview ?? true) {
        const visualizationGroup = new THREE.Group();
        visualizeToolpath(toolpath, visualizationGroup, printer.extruders.map(e => e.color), TRAVEL_PREVIEW_COLOR,
            (point, extruder) => printer.moveSpeed(point, extruder));
        visualizer.scene.add(visualizationGroup);
        modelObjs[0].toolpathVisualizationObject = visualizationGroup;
    }
    return toolpath;
}


/**
 * Builds the boundary of a mesh's base, to be printed before the model itself.
 *
 * @param {THREE.Mesh} mesh The mesh to get the boundary of.
 * @param {THREE.Vector3} position The position of the boundary.
 * @param {number} machineDepthY The Y dimension of the print bed.
 * @param {number} layerNum How many layers the boundary should be (work in progress for more than 1).
 * @param {number} offset How far offset the boundary should be.
 * @param {boolean} pause Whether it should park and pause after printing the boundary.
 * @returns {PathPoint[]} The boundary's points in print order, followed by the pause point if asked for.
 *                        Empty if the mesh has no base contour and no pause was asked for.
 */
function makeBoundaryPath(
    mesh: THREE.Mesh,
    position: THREE.Vector3,
    machineDepthY: number,
    layerNum: number,
    offset: number,
    pause: boolean,
): PathPoint[] {
    const expandedContours = generateBoundaryContours(mesh, offset);
    const path: PathPoint[] = [];

    for (let i = 0; i < layerNum; i++) {
        expandedContours.forEach(contour => {
            contour.forEach(pt => {
                const point = pt.clone().add(position);
                point.setZ(BOUNDARY_FIRST_LAYER_Z + i * BOUNDARY_LAYER_HEIGHT);
                path.push({
                    point: point,
                    regularSegment: true,
                    role: 'boundary',
                })
            });
        });
    }

    // The contours are printed back to front, as they always have been.
    path.reverse();

    if (pause) {
        mesh.geometry.computeBoundingBox();
        path.push({
            point: new THREE.Vector3(0, machineDepthY, mesh.geometry.boundingBox!.max.z + position.z + TRAVEL_CLEARANCE),
            travel: true,
            pause: true,
            role: 'approach',
        });
    }

    // Nothing is extruded on the way to the first point.
    if (path.length) {
        path[0].travel = true;
        path[0].regularSegment = false;
    }

    return path;
}


/**
 * Marks the boundary points of a boundary path as belonging to the model they surround. The
 * pause and travel points around them stay unassigned.
 *
 * @param {PathPoint[]} path A path from makeBoundaryPath. Modified in place.
 * @param {EverydayModel} modelObj The model the boundary surrounds.
 */
function tagBoundary(path: PathPoint[], modelObj: EverydayModel): void {
    for (const point of path) {
        if (point.role === 'boundary') {
            point.objectId = modelObj.objectId;
        }
    }
}


/**
 * Builds the purge line printed once at the start of a print: a couple of passes along the
 * front edge of the bed, one bed margin in from the edges, so it follows the configured bed size.
 *
 * @param {Printer} printer The printer, for its bed size and bed margin.
 * @returns {PathPoint[]} The purge line's points in print order.
 * @throws {Error} If the bed is too small to fit the purge line inside its margins.
 */
export function makePurgeLine(printer: Printer): PathPoint[] {
    const margin = printer.bedMargin;
    const farX = printer.machine_depth - margin;
    const farY = margin + PURGE_LINE_SEPARATION * (PURGE_LINE_COUNT - 1) + 0.001;
    if (!(margin >= 0) || !(farX > margin) || !(farY < printer.machine_depth_y)) {
        throw new Error(
            `The purge line does not fit on a ${printer.machine_depth} x ${printer.machine_depth_y} mm bed ` +
            `with a ${margin} mm margin. Check the machine dimensions or turn the purge line off.`
        );
    }

    const rectangleContour = [
        new THREE.Vector3(margin, margin, PURGE_LINE_Z),
        new THREE.Vector3(farX, margin, PURGE_LINE_Z),
        new THREE.Vector3(farX, farY, PURGE_LINE_Z),
        new THREE.Vector3(margin, farY, PURGE_LINE_Z)
    ];

    const path = generateRectilinearInfill(rectangleContour, PURGE_LINE_SEPARATION, false, new THREE.Vector3(margin, margin, PURGE_LINE_Z));

    return path.map(point => ({
        point: point.point,
        regularSegment: true,
        role: 'purgeLine' as const,
    }));
}


/**
 * Draws a toolpath into a group: its extruding moves coloured by feature, and its travel moves,
 * as one preview (see toolpathPreview.ts). The preview is kept on the group as
 * `userData.preview`, so the preview bar can recolour it and show it layer by layer.
 *
 * @param toolpath The toolpath to draw.
 * @param visualizationGroup The group to draw into.
 * @param printColors The colour of each tool, by tool number.
 * @param travelColor The colour of travel moves.
 * @param speedOf The head speed (mm/min) of the move to a point, for colouring by speed.
 */
export function visualizeToolpath(
    toolpath: PathPoint[],
    visualizationGroup: THREE.Group,
    printColors: number[],
    travelColor: number,
    speedOf?: (point: PathPoint, extruder: number) => number | undefined,
): void {
    if (!toolpath.length) {
        return;
    }
    const preview = buildToolpathPreview(toolpath, { toolColors: printColors, travelColor, speedOf });
    visualizationGroup.add(preview.extrusion, preview.travel);
    visualizationGroup.userData.preview = preview;
}


/** Options for {@link generateAugmentFoamToolpath}. */
export interface AugmentToolpathOptions {
    /**
     * How tall the purge tower already is (mm). When several models are printed in one job the
     * tower is shared, so each model has to continue it from where the previous one stopped.
     */
    purgeTowerStartHeight?: number;
    /**
     * The lowest height (mm) the head may cross the bed at on its way to where this model's
     * toolpath starts, e.g. the top of everything printed before it plus a clearance. The top of
     * this model plus the travel clearance is always respected as well.
     */
    minimumSafeZ?: number;
}

/**
 * Generates foam toolpaths designed to augment EverydayModels based on the model's sampled points.
 *
 * This function performs the following steps:
 * 1. Removes any previous foam toolpath visualization from the scene and disposes its resources.
 * 2. Checks if sample points exist; if none, returns null.
 * 3. Constructs continuous paths from the sample points in either a rectilinear or fermat spiral pattern.
 * 4. Visualizes the generated toolpath.
 *
 * @param visualizer - The Visualizer instance, providing access to the scene and the printer.
 * @param modelObj - The model object, which must include:
 *                   - toolpathSamplePoints: Array<PointCloudPoint>
 *                   - mesh: THREE.Mesh (for positioning)
 * @param options - See {@link AugmentToolpathOptions}.
 * @returns The generated toolpath, or null if there is nothing to print (no sample points, or
 *          every sampled point was too steep).
 * @throws {Error} If a parameter cannot be sliced with (e.g. a layer thickness of 0).
 */
export function generateAugmentFoamToolpath(
    visualizer: Visualizer,
    modelObj: EverydayModel,
    options: AugmentToolpathOptions = {},
): PathPoint[] | null{
    // --- 1. Remove the previous foam toolpath visualization, if it exists.
    removeToolpathVisualization(visualizer, modelObj);

    const printer = visualizer.printer;
    const config = modelObj.toolpathConfig;
    assertPositive(config.deltaZ, 'Layer thickness (deltaZ)');

    const transformedMesh = getTransformedMesh(modelObj.mesh);

    printer.updateParameters(config);

    // With no SVG gradient loaded, a difference between the start and end values is applied as a
    // vertical gradient instead: bottom layer = start values, top layer = end values.
    const hasValidGradient = modelObj.gradient &&
                            modelObj.gradient.width > 1 &&
                            modelObj.gradient.height > 1;
    const hasGradientVariation = (config.hStar !== config.hStarEnd) || (config.vStar !== config.vStarEnd);

    // --- 2. Check if there are sample points available.
    if (!modelObj.toolpathSamplePoints || modelObj.toolpathSamplePoints.length === 0) {
        return null;
    }

    const visualizationGroup = new THREE.Group();

    const samplePointMatrix: PointCloudPoint[][] = [[]];
    let lastX = modelObj.toolpathSamplePoints[0].point.x;
    for (const point of modelObj.toolpathSamplePoints) {
        if (Math.abs(point.point.x - lastX) <= 0.0001) {
            samplePointMatrix[samplePointMatrix.length - 1].push(point);
        } else {
            samplePointMatrix.push([point]);
            lastX = point.point.x;
        }
    }
    for (const column of samplePointMatrix) {
        column.sort((a, b) => a.point.y - b.point.y);
    }

    const samplePointMatrixCopy: THREE.Vector3[][] = [];
    samplePointMatrix.forEach(column => {
        samplePointMatrixCopy.push([]);
        column.forEach(point => {
            samplePointMatrixCopy[samplePointMatrixCopy.length - 1].push(point.point.clone());
        });
    });

    const gradientMatrix = makeGradientMatrix(samplePointMatrixCopy);
    const indicesToRemove: { col: number, row: number }[] = [];

    const gradientThresholdDegrees = config.steepnessThreshold;
    const gradientThreshold = Math.tan(gradientThresholdDegrees * (Math.PI / 180));

    for (let i = 0; i < gradientMatrix.length; i++) {
        const column = gradientMatrix[i];
        for (let j = 0; j < column.length; j++) {
            const gradient = column[j];
            const magnitude = Math.sqrt(Math.pow(gradient.x, 2) + Math.pow(gradient.y, 2));
            if (Math.abs(magnitude) > gradientThreshold) {
                indicesToRemove.push({ col: i, row: j });
            }
        }
    }

    indicesToRemove.sort((a, b) => {
        if (a.col !== b.col) return b.col - a.col;
        return b.row - a.row;
    });

    for (const { col, row } of indicesToRemove) {
        gradientMatrix[col].splice(row, 1);
        samplePointMatrix[col].splice(row, 1);
    }

    const regularPoints: THREE.Vector3[] = [];
    const sensePoints: THREE.Vector3[] = [];
    samplePointMatrix.forEach(col => col.forEach(p =>
        (p.type === 'sense' ? sensePoints : regularPoints).push(p.point)));

    // A region needs at least a triangle's worth of points.
    const bumpRegions: SliceRegion[] = [];
    const cloudSliceRegions: SliceRegion[] = [
        ...(regularPoints.length >= 3 ? extractRegionsFromPointCloud(regularPoints, POINT_CLOUD_ALPHA, 0) : []),
        ...(sensePoints.length >= 3 ? extractRegionsFromPointCloud(sensePoints, POINT_CLOUD_ALPHA, 1) : []),
    ];

    if (!cloudSliceRegions.length) {
        return null;
    }

    const flatLayerNum = config.additionalCurveLayers;
    const layerCount = config.initialFoamLayerCount + modelObj.initialConfig.initialFoamLayerCount +
                       (config.curveAugment ? flatLayerNum : 0);

    if (config.generateBumps && !modelObj.bumpMesh) {
        notify('Bumps are switched on but no bump model is loaded, so no bumps were generated.', 'warning');
    } else if (config.generateBumps) {
        assertPositive(config.bumpSpacingX, 'Bump spacing X');
        assertPositive(config.bumpSpacingY, 'Bump spacing Y');
        modelObj.bumpMesh!.scale.setScalar(config.bumpScale);
        const transformedBumpMesh = getTransformedMesh(modelObj.bumpMesh!);

        // Slice the bump models into contours
        const bumpLayers = sliceMeshIntoLayers(transformedBumpMesh, config.deltaZ);
        let bumpContours: THREE.Vector3[][] = [];
        for (const { z, segments } of bumpLayers) {
            const regions = extractRegionsFromLayer(z, segments, printer.extruders[0].nozzleDiameter,0);
            pushAll(bumpContours, regions.map(region => region.contour));
        }
        bumpContours = bumpContours.filter(contour => contour.length > 0);

        bumpContours.sort((a, b) => a[0].z - b[0].z);

        bumpContours = bumpContours.map(contour => fillContour(contour, TOOLPATH_FILL_DISTANCE));

        if (bumpContours.length) {
            // Normalize heights so the bottom is at z = 0
            const firstLayerHeight = bumpContours[0][0].z;
            bumpContours.forEach(contour => contour.forEach(pt => pt.setZ(pt.z - firstLayerHeight)));
        }

        const bumpBounds = cloudSliceRegions.map(sliceRegion => getBounds(sliceRegion.contour, sliceRegion.contour[0].z));

        let max = new THREE.Vector3(-Infinity, -Infinity, 0);
        let min = new THREE.Vector3(Infinity, Infinity, 0);

        bumpBounds.forEach(bound => {
            max = new THREE.Vector3(Math.max(max.x, bound.max.x), Math.max(max.y, bound.max.y), 0);
            min = new THREE.Vector3(Math.min(min.x, bound.min.x), Math.min(min.y, bound.min.y), 0);
        });

        // Get all the points to add bumps at by scanning the model.
        const bumpPoints: THREE.Vector3[] = [];

        const remainderY = (max.y - min.y) % config.bumpSpacingY;
        const remainderX = (max.x - min.x) % config.bumpSpacingX;
        const startY = min.y + remainderY / 2;
        const startX = min.x + remainderX / 2;
        // Stepped by index rather than by repeated addition, so rounding cannot drift or stall.
        for (let iy = 0; startY + iy * config.bumpSpacingY < max.y; iy++) {
            const y = startY + iy * config.bumpSpacingY;
            for (let ix = 0; startX + ix * config.bumpSpacingX < max.x; ix++) {
                const point = new THREE.Vector3(startX + ix * config.bumpSpacingX, y, 0)
                if (cloudSliceRegions.some(region => pointInPolygon(point, region.contour))) {
                    bumpPoints.push(point);
                }
            }
        }

        // Add the bump contours to every point we want to add a bump at.
        const bumpHeight = layerCount * config.deltaZ;
        bumpPoints.forEach(p => {
            // Use .some so we can break by returning true
            bumpContours.some(contour => {
                const bumpContour = contour.map(contourPt => contourPt.clone().add(new THREE.Vector3(p.x, p.y, bumpHeight))).filter(
                    p => cloudSliceRegions.some(region => pointInPolygon(p, region.contour)));

                if (bumpContour.length > 2) {
                    const segments = getBoundarySegments(bumpContour, []);
                    bumpRegions.push({
                        id: p.x + ", " + p.y + ", " + bumpContour[0].x + ", " + bumpContour[0].y + ", " + bumpContour[0].z,
                        contour: bumpContour,
                        holes: [],
                        height: bumpContour[0].z,
                        bounds: getBounds(bumpContour, bumpContour[0].z),
                        BVH: buildSliceRegionBVH(segments),
                        extruder: 0,
                        shell: false,
                    });
                    return false;
                } else {
                    return true;
                }
            })
        })
    }

    const sliceRegions: SliceRegion[] = bumpRegions;

    for (let i = 0; i < layerCount; i++) {
        const z = i * config.deltaZ;
        pushAll(sliceRegions, cloudSliceRegions.map(region => {
            // the contour is copied up to this layer's z, so the segments have to be rebuilt
            // from the copies rather than reused from the region they came from
            const contour = region.contour.map(p => new THREE.Vector3(p.x, p.y, z));
            const holes = region.holes.map(hole => hole.map(p => new THREE.Vector3(p.x, p.y, z)));
            const segments = getBoundarySegments(contour, holes);

            return {
                id: region.id + ", " + z,
                contour: contour,
                holes: holes,
                height: z,
                bounds: region.bounds,
                segments: segments,
                BVH: buildSliceRegionBVH(segments),
                extruder: region.extruder,
                shell: false,
            }
        }));
    }

    if (!sliceRegions.length) {
        return null;
    }

    const regionTree = buildRegionTree(sliceRegions, config.deltaZ);
    const chunkTree = buildChunkTree(regionTree, printer);
    chunkTree.forEach(chunkNode => {
        chunkNode.modelObj = modelObj;
    });

    let modelHeight = -Infinity;
    regionTree.forEach(region => {
        if (region.region.height > modelHeight) {
            modelHeight = region.region.height;
        }
    });
    if (!Number.isFinite(modelHeight)) {
        return null;
    }

    transformedMesh.geometry.computeBoundingBox();
    const bbox = transformedMesh.geometry.boundingBox!;

    // The gradient is stretched over the whole selected area, and the vertical gradient over the
    // whole stack of slices, so every chunk of the model reads the same gradient.
    const gradientMin = new THREE.Vector2(Infinity, Infinity);
    const gradientMax = new THREE.Vector2(-Infinity, -Infinity);
    for (const region of cloudSliceRegions) {
        gradientMin.set(Math.min(gradientMin.x, region.bounds.min.x), Math.min(gradientMin.y, region.bounds.min.y));
        gradientMax.set(Math.max(gradientMax.x, region.bounds.max.x), Math.max(gradientMax.y, region.bounds.max.y));
    }
    let sliceMinZ = Infinity;
    let sliceMaxZ = -Infinity;
    for (const region of sliceRegions) {
        sliceMinZ = Math.min(sliceMinZ, region.height);
        sliceMaxZ = Math.max(sliceMaxZ, region.height);
    }

    const models = new Map<EverydayModel, ModelContext>();
    models.set(modelObj, {
        minZ: bbox.min.z,
        maxZ: bbox.max.z,
        gradientBounds: { min: gradientMin, max: gradientMax },
        verticalGradient: !hasValidGradient && hasGradientVariation
            ? { minZ: sliceMinZ, maxZ: sliceMaxZ }
            : undefined,
    });

    // The head starts out above the origin, clear of the top of the model (and of anything named
    // in minimumSafeZ). Starting the path from up there makes the first approach, to the purge
    // tower or to the first chunk, cross the bed at that height and only then come down, instead
    // of dropping to printing height at the origin and crossing the bed low.
    const safeZ = Math.max(
        bbox.max.z + modelObj.mesh.position.z + TRAVEL_CLEARANCE,
        options.minimumSafeZ ?? -Infinity,
    );
    const startPoint = new THREE.Vector3(0, 0, safeZ);
    // The points are lifted onto the sampled surface in makeChunkPath, layer by layer, after
    // their H* has been resolved.
    const toolpath = makeChunkTreePath(
        chunkTree,
        startPoint,
        new Set<string>(),
        modelHeight,
        {
            threadDiameters: printer.extruders.map((_, i) => printer.threadDiameter(i)),
            shellLayerHeight: printer.shellLayerHeight,
            surface: {
                samplePointMatrix: samplePointMatrixCopy,
                modelMaxZ: bbox.max.z,
            },
            models,
        },
        printer.purgeTower ? makePurgeTowerSpec(printer) : undefined,
        options.purgeTowerStartHeight ?? 0,
    );

    if (!toolpath.length) {
        return null;
    }

    // The purge tower and the travel moves to and from it are in the same toolpath but are not
    // part of the model, and they can be far above it, so the passes below that measure the model
    // leave out everything that carries a role.
    const modelPoints = toolpath.filter(tp => tp.role === undefined);

    //flat layers on top if needed
    if (config.curveAugment && modelPoints.length) {
        let maxZ = -Infinity;
        for (const tp of modelPoints) {
            if (tp.point.z > maxZ) {
                maxZ = tp.point.z;
            }
        }
        const topLayerPoints = modelPoints.filter(tp => Math.abs(tp.point.z - maxZ) < TOP_LAYER_TOLERANCE);

        for (let layer = 1; layer <= CURVE_AUGMENT_EXTRA_FLAT_LAYERS; layer++) {
            topLayerPoints.forEach(point => {
                toolpath.push({
                    ...point,
                    debug: undefined,
                    layer: point.layer === undefined ? undefined : point.layer + layer,
                    point: new THREE.Vector3(
                        point.point.x,
                        point.point.y,
                        maxZ + (layer * config.deltaZ)
                    )
                });
            });
        }
    }

    if (printer.checkCollisions && modelPoints.length) {
        // Only check the first two layers for collisions to reduce time: the head is lowest there.
        // Does two layers to reduce variance when layer sizes aren't equal.
        const checkCount = Math.ceil(modelPoints.length * Math.min(1, 2 / Math.max(1, layerCount)));
        const checkLayer = modelPoints.slice(0, checkCount).map(p => p.point);
        const collision = getRequiredZOffset(
            transformedMesh.geometry,
            modelObj.mesh.position,
            checkLayer,
            printer.extruders[0].nozzleLength,
            printer.printHeadDims,
            COLLISION_OFFSET_TOLERANCE,
        );

        if (collision.requiredOffset > 0) {
            // H = H* d, with d including die swell
            const recommendedHStar = printer.globalVTPSettings.H_star + collision.requiredOffset / printer.threadDiameter(0);
            if (collision.resolved) {
                notify(`Collision detected: the print head would hit "${modelObj.name}". Recommended H* to avoid it: ${recommendedHStar.toFixed(4)}`, 'warning');
            } else {
                notify(`Collision detected: the print head would hit "${modelObj.name}", and raising H* (even to ${recommendedHStar.toFixed(4)}) does not clear it. Choose a different area or orientation.`, 'error');
            }
        }
    }

    // Show how steep the surface is at each sample point, as a single points object.
    const steepnessPositions: number[] = [];
    const steepnessColors: number[] = [];
    const steepnessColor = new THREE.Color();
    for (let i = 0; i < samplePointMatrix.length; i++) {
        const column = samplePointMatrix[i];
        for (let j = 0; j < column.length; j++) {
            const slope = gradientMatrix[i][j];
            if (!slope) {
                continue;
            }
            const point = column[j].point;
            steepnessPositions.push(
                point.x + modelObj.mesh.position.x,
                point.y + modelObj.mesh.position.y,
                point.z + modelObj.mesh.position.z + 0.001,
            );

            const steepness = Math.floor(((Math.atan(Math.sqrt(Math.pow(slope.x, 2) + Math.pow(slope.y, 2)))) / (Math.PI / 2)) * 255) / 255;
            steepnessColor.setHex(Math.floor(0xffffff * steepness));
            steepnessColors.push(steepnessColor.r, steepnessColor.g, steepnessColor.b);
        }
    }
    if (steepnessPositions.length) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(steepnessPositions, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(steepnessColors, 3));
        visualizationGroup.add(new THREE.Points(geometry, new THREE.PointsMaterial({ vertexColors: true })));
    }

    // Lead-in: the purge line, then the boundary (with a pause) or a move above the origin, then a
    // move to above where the print starts, all clear of the top of the model.
    const fullToolpath: PathPoint[] = [];
    if (printer.purgeLine) {
        pushAll(fullToolpath, makePurgeLine(printer));
    }
    if (printer.generateBoundary) {
        const boundary = makeBoundaryPath(transformedMesh, modelObj.mesh.position, printer.machine_depth_y, 1, BOUNDARY_OFFSET, true);
        tagBoundary(boundary, modelObj);
        pushAll(fullToolpath, boundary);
    } else {
        fullToolpath.push({
            point: new THREE.Vector3(0, 0, safeZ),
            travel: true,
            role: 'approach',
        });
    }
    fullToolpath.push({
        point: new THREE.Vector3(toolpath[0].point.x, toolpath[0].point.y, safeZ),
        travel: true,
        role: 'approach',
    });
    pushAll(fullToolpath, toolpath);

    // --- 4. Visualize the toolpath
    visualizeToolpath(fullToolpath, visualizationGroup, printer.extruders.map(e => e.color), TRAVEL_PREVIEW_COLOR,
        (point, extruder) => printer.moveSpeed(point, extruder));

    visualizer.scene.add(visualizationGroup);
    modelObj.toolpathVisualizationObject = visualizationGroup;

    return fullToolpath;
}
