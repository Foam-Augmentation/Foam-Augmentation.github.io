import * as THREE from 'three';
import Visualizer from '../Visualizer';
import { EverydayModel, PointCloudPoint, ToolpathConfig } from '../types/modelTypes';
import { Gradient, RGBA } from '../loaders/modelLoader';
import { sampleSelectedMesh } from './sampleSelectedMesh';
import {
    sliceMeshIntoLayers,
    extractRegionsFromLayer,
    buildRegionTree,
    SliceRegion,
    generateBoundaryContours,
    generateInsetContourTree,
    getWindingOrder,
    getBounds,
    connectIsocontours,
    RegionNode,
    buildChunkTree,
    ChunkNode,
    ContourNode,
    extractRegionsFromPointCloud,
    pointAlongLine,
    pointInPolygon,
    offsetContour,
    getBoundarySegments,
    buildSliceRegionBVH,
    LineSegment,
    SliceRegionBVHNode,
} from '../utils/TreeSlicer';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';

export interface PathPoint {
    point: THREE.Vector3;
    travel?: boolean;
    extruder?: number
    switchFilament?: boolean;
    pause?: boolean;
    regularSegment?: boolean;
    hStar?: number;
    vStar?: number;
    edot?: number;
    deltaL?: number; // added this
}

/**
     * Private helper function that constructs continuous paths from a filtered set of sample points.
     *
     * The function groups points into rows (based on a y-tolerance), then further splits each row into
     * segments if points are too far apart. It then connects segments from consecutive rows to form continuous paths.
     *
     * @param filteredPoints - An array of sample points with structure PointCloudPoint.
     * @returns An array of continuous segments, where each segment is an array of sample points.
     */
function _generatePath(filteredPoints: PointCloudPoint[], modelObj: EverydayModel): PointCloudPoint[][] {
    const maxConnectDist = modelObj.toolpathConfig.gridSize * 3;  // Maximum distance allowed to connect points in the same row.
    const rowTol = modelObj.toolpathConfig.gridSize * 0.5;        // Tolerance in the y-direction to group points into one row.

    // Sort the sample points by their y coordinate.
    let sortedPoints = filteredPoints.slice().sort((a, b) => a.point.y - b.point.y);
    let rows: PointCloudPoint[][] = [];
    let currentRow: PointCloudPoint[] = [sortedPoints[0]];
    for (let i = 1; i < sortedPoints.length; i++) {
        const prev = sortedPoints[i - 1];
        const cur = sortedPoints[i];
        if (Math.abs(cur.point.y - prev.point.y) <= rowTol) {
            currentRow.push(cur);
        } else {
            rows.push(currentRow);
            currentRow = [cur];
        }
    }
    rows.push(currentRow);

    // For each row, sort by x coordinate and split the row into segments if necessary.
    let rowSegments: { points: PointCloudPoint[]; connected: boolean }[][] = [];
    rows.forEach((row, rowIndex) => {
        rowSegments[rowIndex] = [];
        row.sort((a, b) => a.point.x - b.point.x);
        let segs: PointCloudPoint[][] = [];
        let currentSeg = [row[0]];
        for (let i = 1; i < row.length; i++) {
            const prev = row[i - 1];
            const cur = row[i];
            if ((cur.point.x - prev.point.x) <= maxConnectDist) {
                currentSeg.push(cur);
            } else {
                segs.push(currentSeg);
                currentSeg = [cur];
            }
        }
        if (currentSeg.length > 0) {
            segs.push(currentSeg);
        }
        // For zigzag effect, reverse segments on odd rows.
        if (rowIndex % 2 === 1) {
            segs = segs.map(segment => segment.slice().reverse());
        }
        segs.forEach(seg => {
            rowSegments[rowIndex].push({ points: seg, connected: false });
        });
    });
    const maxRow = rows.length;

    // Build the global segments by connecting segments from each row.
    const globalSegments: PointCloudPoint[][] = [];
    function existUnconnected(): boolean {
        for (let r = 0; r < maxRow; r++) {
            if (rowSegments[r].some(seg => seg.connected === false)) return true;
        }
        return false;
    }

    while (existUnconnected()) {
        let startRow: number | null = null;
        let startSeg: any = null;
        for (let r = 0; r < maxRow; r++) {
            for (let seg of rowSegments[r]) {
                if (!seg.connected) {
                    startRow = r;
                    startSeg = seg;
                    break;
                }
            }
            if (startRow !== null) break;
        }
        if (startRow === null) break;

        let currentGlobal = (startRow % 2 === 0) ? startSeg.points.slice() : startSeg.points.slice().reverse();
        startSeg.connected = true;
        let currentPt = currentGlobal[currentGlobal.length - 1];
        let currentOrder = (startRow % 2 === 0) ? "normal" : "reverse";
        let currentRow = startRow;

        // Attempt to connect segments from subsequent rows.
        for (let r = currentRow + 1; r < maxRow; r++) {
            let candidates = rowSegments[r].filter(seg => !seg.connected);
            if (candidates.length === 0) break;
            let bestCandidate: any = null, bestDist = Infinity, candidateOrder: "normal" | "reverse" | null = null;
            candidates.forEach(seg => {
                let head = seg.points[0];
                let tail = seg.points[seg.points.length - 1];
                let dHead = Math.abs(currentPt.point.x - head.point.x) + Math.abs(currentPt.point.y - head.point.y);
                let dTail = Math.abs(currentPt.point.x - tail.point.x) + Math.abs(currentPt.point.y - tail.point.y);
                if (dHead < bestDist) {
                    bestCandidate = seg;
                    bestDist = dHead;
                    candidateOrder = "normal";
                }
                if (dTail < bestDist) {
                    bestCandidate = seg;
                    bestDist = dTail;
                    candidateOrder = "reverse";
                }
            });
            if (bestCandidate) {
                let segPts = bestCandidate.points.slice();
                if (candidateOrder === "reverse") {
                    segPts.reverse();
                }
                currentGlobal = currentGlobal.concat(segPts);
                currentPt = currentGlobal[currentGlobal.length - 1];
                currentOrder = candidateOrder!;
                bestCandidate.connected = true;
            } else {
                let chosen: any = null;
                if (currentOrder === "normal") {
                    let segs = rowSegments[r];
                    if (segs.length > 0 && !segs[segs.length - 1].connected) {
                        chosen = segs[segs.length - 1];
                        candidateOrder = "reverse";
                    }
                } else {
                    let segs = rowSegments[r];
                    if (segs.length > 0 && !segs[0].connected) {
                        chosen = segs[0];
                        candidateOrder = "normal";
                    }
                }
                if (chosen) {
                    let segPts = chosen.points.slice();
                    if (candidateOrder === "reverse") {
                        segPts.reverse();
                    }
                    currentGlobal = currentGlobal.concat(segPts);
                    currentPt = currentGlobal[currentGlobal.length - 1];
                    currentOrder = candidateOrder!;
                    chosen.connected = true;
                } else {
                    break;
                }
            }
        }
        globalSegments.push(currentGlobal);
    }
    return globalSegments;
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
                console.log(`Layer ${layerCount}: Adding toolpath at zOffset = ${zOffset + layerCount * modelObj.toolpathConfig.deltaZ}`);
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
                console.log(`Layer ${layerCount}: Adding toolpath at zOffset = ${zOffset + layerCount * modelObj.toolpathConfig.deltaZ}`);

            }
            for (let i = 0; i < modelObj.toolpathConfig.middleSenseLayerCount; i++) {
                const toolpathSense = _visualizeSegments(modelObj.sense_area_segments, 'sensing', zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                const toolpathFoam = _visualizeSegments(modelObj.regular_area_segments, 'regular', zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                if (toolpathSense) visualizationGroup.add(toolpathSense);
                if (toolpathFoam) visualizationGroup.add(toolpathFoam);
                layerCount++;
                console.log(`Layer ${layerCount}: Adding toolpath at zOffset = ${zOffset + layerCount * modelObj.toolpathConfig.deltaZ}`);

            }
            for (let i = 0; i < modelObj.toolpathConfig.finalFoamLayerCount; i++) {
                const toolpathAll = _visualizeSegments(modelObj.all_area_segments, 'regular', zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                if (toolpathAll) visualizationGroup.add(toolpathAll);
                layerCount++;
                console.log(`Layer ${layerCount}: Adding toolpath at zOffset = ${zOffset + layerCount * modelObj.toolpathConfig.deltaZ}`);

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

// --- Add zigzag infill generator for a 2D polygon (contour) ---
function generateZigzagInfill(contour: THREE.Vector3[], z: number, params: { spacing: number }, flipY: boolean): THREE.Vector3[] {
    // Project contour to 2D (XY)
    const points2D = contour.map(pt => new THREE.Vector2(pt.x, pt.y));
    // Find bounds
    let minY = Infinity, maxY = -Infinity;
    for (const pt of points2D) {
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
    }
    const lines: THREE.Vector3[] = [];
    // Flip the y direction to go from maxY to minY instead if passed in
    if (flipY) {
        let temp = minY;
        minY = maxY;
        maxY = temp;
    }
    // For each horizontal line at spacing, find intersections with the polygon
    let atTop = false;
    for (let y = minY; y <= maxY; y += params.spacing) {
        // Find intersections with contour edges
        const intersections: number[] = [];
        for (let i = 0; i < points2D.length; i++) {
            const a = points2D[i];
            const b = points2D[(i + 1) % points2D.length];
            if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
                // Edge crosses the scanline
                const t = (y - a.y) / (b.y - a.y);
                const x = a.x + t * (b.x - a.x);
                intersections.push(x);
            }
        }
        intersections.sort((a, b) => a - b);
        // Pair up intersections to form zigzag lines
        for (let i = 0; i + 1 < intersections.length; i += 2) {
            const x0 = intersections[i], x1 = intersections[i + 1];
            if (atTop) {
                lines.push(new THREE.Vector3(x0, y, z));
                lines.push(new THREE.Vector3(x1, y, z));
            } else {
                lines.push(new THREE.Vector3(x1, y, z));
                lines.push(new THREE.Vector3(x0, y, z));
            }
        }
        atTop = !atTop;
    }
    return lines;
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
    for (let i = 0; i < toolpath.length - 1; i++) {
        const point = toolpath[i];
        const nextPoint = toolpath[i + 1];
        newPath.push(point);
        const dist = point.point.distanceTo(nextPoint.point);

        if (dist > fillDist) {
            for (let i = 1; i < Math.floor(dist / fillDist); i++) {
                newPath.push({
                    point: pointAlongLine(point.point, nextPoint.point, i * fillDist),
                    travel: nextPoint.travel,
                    regularSegment: nextPoint.regularSegment,
                    extruder: point.extruder,
                    hStar: point.hStar,
                    vStar: point.vStar,
                    edot: point.edot,
                   deltaL: point.deltaL //added this
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
            console.log("Num Intersections: " + intersections.length);
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

function generateRectilinearInfillWithHoles(
    boundaryBVH: SliceRegionBVHNode,
    outContour: THREE.Vector3[],
    deltaL: number,
    scanX: boolean,
    lastLayerPoint: THREE.Vector3,
    edot?: number,
): PathPoint[] {
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

    const printLines: LineSegment[] = [];
    let cutposition = startPoint[axis];

    while(bounds.min[axis] <= cutposition && cutposition <=bounds.max[axis]){
        const points = sliceSegments(boundaryBVH,axis,cutposition);
        if(points.length % 2 != 0){
            throw new Error("Mesh is not watertight");
        }
        for(let i = 0; i < points.length; i+=2){
            printLines.push({start:points[i], end:points[i+1]})
        }
        cutposition += deltaL * (atRight ? -1 : 1);
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
        let bestDist = 999;
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
 * How a chunk's z values get finished off once every point's hStar is known. Every point is raised
 * by its own ZOffset; when a surface is given the layers are also draped over it rather than being
 * left level with the bed.
 */
interface LayerHeights {
    /** Nozzle diameter times die swelling, which turns a point's hStar into its ZOffset. */
    threadDiameter: number;
    /** The surface to drape the layers over. Leave it out for flat layers. */
    surface?: {
        /** The surface itself, as columns of sampled points. */
        samplePointMatrix: THREE.Vector3[][];
        /** The top of the model's bounding box, the plane the layers flatten out towards. */
        modelMaxZ: number;
    };
}

function addPurgeTowerToolpathAtZ(extruder: number, z: number): PathPoint[]{
    //TEMPORARY!!
    //TODO: Curved toolpath (for better acceleration), maybe nearest position
    console.log("WEEEE");
    const points = [new THREE.Vector3(240,200,z), new THREE.Vector3(240,190,z), new THREE.Vector3(230,190,z),new THREE.Vector3(240,200,z)]
    const toolpath: PathPoint[] = [];
    toolpath.push({point: points[0], extruder: extruder, travel: true})
    for(const p of points){
        toolpath.push({point: p, extruder: extruder, regularSegment: true})
    }
    return toolpath
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
        hStar: to.hStar,
        vStar: to.vStar,
        edot: to.edot,
    };
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
 * @returns {{ path: PathPoint[], height: number }} The layers' toolpath, and the tower's new height.
 */
function makePurgeTowerBlock(
    extruder: number,
    fromHeight: number,
    toHeight: number,
    lastPoint: THREE.Vector3,
    purgeTowerLayerHeight: number
): { path: PathPoint[], height: number } {
    const layerCount = Math.max(0, Math.ceil((toHeight - fromHeight) / purgeTowerLayerHeight));
    const path: PathPoint[] = [];

    for (let i = 1; i <= layerCount; i++) {
        path.push(...addPurgeTowerToolpathAtZ(extruder, fromHeight + i * purgeTowerLayerHeight));
    }

    if (path.length) {
        path.unshift(approachTravelPoint(lastPoint, path[0]));
    }

    return { path: path, height: fromHeight + layerCount * purgeTowerLayerHeight };
}


/**
 * Generates the toolpath for a single chunk.
 *
 * @param {ChunkNode} chunk The chunk to print the toolpath for. This should have a modelObj with the
 *                          config to print this chunk with.
 * @param {THREE.Vector3} lastLayerPoint The last point printed so far.
 * @param {number} height The distance between the base of the model object and the print bed.
 * @param {boolean} initialScanX If true, the first layer scans the x direction, alternating every layer.
 *                               Only applicable for rectilinear infill.
 * @param {number} fillDist Controls the maximum distance points can be from the last in the toolpath. Lowering this
 *                          means more points are generated in the same space, leading to higher accuracy with gradients.
 * @param {LayerHeights} layerHeights How to finish off each point's z. Leave it out only if the caller applies the
 *                                    ZOffset to the finished path itself.
 * @returns {PathPoint[]} The generated toolpath. All points will have an hStar, vStar, and edot parameter.
 */
function makeChunkPath(
    chunk: ChunkNode,
    lastLayerPoint: THREE.Vector3,
    height?: number,
    initialScanX: boolean = false,
    fillDist: number = 0.5,
    layerHeights?: LayerHeights,
): PathPoint[] {
    let lastLayerEndPoint = lastLayerPoint;
    let chunkPath: PathPoint[] = [];
    let scanX = initialScanX;
    let lastUseInitial = false;
    const initialConfig = chunk.modelObj!.initialConfig;
    const VTPSettings = chunk.VTPSettings;
    chunk.modelObj!.geometry.computeBoundingBox();
    const modelHeight = height ?? chunk.modelObj!.geometry.boundingBox!.min.z;
    const initialOffset = chunk.modelObj!.initialOffset;
    const gradient = chunk.modelObj!.gradient;
    let count = 0;
    for (const region of chunk.regions) {
        let regionLayer = Math.floor((region.height - modelHeight + 0.0001) / VTPSettings.deltaZ);
        const useInitial = regionLayer < initialConfig.initialFoamLayerCount;
        if (count === 0 && useInitial) {
            lastUseInitial = true;
        }

        const configToUse = useInitial ? initialConfig : VTPSettings;
       

        // does vertical gradient for deltaL only right now
        // comment out from here to end mark if dont want deltaL vertical gradient
        chunk.modelObj!.geometry.computeBoundingBox();
        const modelMinZ = chunk.modelObj!.geometry.boundingBox!.min.z;
        const modelMaxZ = chunk.modelObj!.geometry.boundingBox!.max.z;
        
        // Calculate height percentage (0 = bottom, 1 = top)
        const totalHeight = modelMaxZ - modelMinZ;
        let heightPercent = 0;
        if (totalHeight > 0) {
            heightPercent = Math.min(1, Math.max(0, (region.height - modelMinZ) / totalHeight));
        }
        
        // bottom = deltaL, top = deltaLEnd
        const currentDeltaL = configToUse.deltaL + heightPercent * (configToUse.deltaLEnd - configToUse.deltaL);
    

        console.log(`Region Layer: ${regionLayer}, Using DeltaL: ${currentDeltaL}`);
        // end mark
        let path: PathPoint[];
        if (VTPSettings.useFermatSpirals) {
            const insetContoursRoot = generateInsetContourTree(
                useInitial ? offsetContour(region.contour, initialOffset) : region.contour, 
                region.holes,
                //configToUse.deltaL 
                currentDeltaL,
            );

            //path = connectIsocontours(insetContoursRoot, configToUse.deltaL, lastLayerEndPoint);
            path = connectIsocontours(insetContoursRoot, currentDeltaL, lastLayerEndPoint, useInitial ? initialConfig.edot : VTPSettings.Edot);  
        } else {
            path = generateRectilinearInfillWithHoles(
                region.BVH,
                useInitial ? offsetContour(region.contour, initialOffset) : region.contour,
                //configToUse.deltaL, 
                currentDeltaL, 
                scanX,
                lastLayerEndPoint,
                useInitial ? initialConfig.edot : VTPSettings.Edot
            );
            scanX = !scanX;
        }

        if (!path.length) {
            continue;
        }

        const prevPathLen = chunkPath.length;

        chunkPath.push(...path);
        /*path.map(point => {
            return {
                point: point,
                travel: false,
                edot: useInitial ? initialConfig.edot : config.edot,
            }
        }) */

        if (chunkPath[prevPathLen]) {
            chunkPath[prevPathLen].travel = true;
        }

        if (useInitial != lastUseInitial) {
            chunkPath[prevPathLen].switchFilament = true;
        }
        lastUseInitial = useInitial;

        lastLayerEndPoint = chunkPath[chunkPath.length - 1].point;
        count++;
    }

    if (!chunkPath.length) {
        return chunkPath;
    }
    chunkPath[0].travel = true;

    const bounds = { min: new THREE.Vector3(Infinity, Infinity, Infinity), max: new THREE.Vector3(-Infinity, -Infinity, -Infinity) };
    chunkPath.forEach(point => {
        const pt = point.point;
        if (pt.x > bounds.max.x) {
            bounds.max.setX(pt.x);
        }
        if (pt.y > bounds.max.y) {
            bounds.max.setY(pt.y);
        }
        if (pt.z > bounds.max.z) {
            bounds.max.setZ(pt.z);
        }
        if (pt.x < bounds.min.x) {
            bounds.min.setX(pt.x);
        }
        if (pt.y < bounds.min.y) {
            bounds.min.setY(pt.y);
        }
        if (pt.z < bounds.min.z) {
            bounds.min.setZ(pt.z);
        }
    });

    chunkPath = fillToolpath(chunkPath, fillDist);

    // Apply gradient
    chunkPath.forEach(point => {
        let pointLayer = Math.floor((point.point.z - modelHeight + 0.0001) / VTPSettings.deltaZ);

        const configToUse = pointLayer < initialConfig.initialFoamLayerCount ? initialConfig : VTPSettings;
        const hStar = pointLayer < initialConfig.initialFoamLayerCount ? initialConfig.hStar : VTPSettings.H_star
        const vStar = pointLayer < initialConfig.initialFoamLayerCount ? initialConfig.vStar : VTPSettings.V_Star

        const scaledX = ((point.point.x - bounds.min.x) / (bounds.max.x - bounds.min.x)) * gradient.width;
        const scaledY = ((point.point.y - bounds.min.y) / (bounds.max.y - bounds.min.y)) * gradient.height;
        const sampledColor = gradient.sampleColor(scaledX, scaledY);
        // Black is 1 white is 0
        const percent = 1 - (sampledColor.r + sampledColor.g + sampledColor.b) / (3 * 255);
        point.hStar = hStar + percent * (configToUse.hStarEnd - hStar);
        point.vStar = vStar + percent * (configToUse.vStarEnd - vStar);
        point.edot = VTPSettings.Edot;
        point.point.add(chunk.modelObj!.mesh.position);

        if (layerHeights) {
            applyLayerHeight(point, chunk, layerHeights);
        }
    });

    return chunkPath;
}


/**
 * Finishes off a single point's z, raising it by its own ZOffset and, if a surface was given,
 * lifting it out of its flat slice plane and onto that surface first.
 *
 * With curveAugment on, the layers start out following the curve of the surface and are flattened a
 * little more each layer until the top one is a flat plane; every layer above that stack is spaced a
 * plain deltaZ apart. With it off, the whole stack just follows the surface.
 *
 * @param {PathPoint} point The point to raise. Its position must already be in model-placed
 *                          coordinates, and its hStar must already be resolved.
 * @param {ChunkNode} chunk The chunk the point belongs to, for its model's config and placement.
 * @param {LayerHeights} layerHeights The ZOffset scale, and the surface to drape over if there is one.
 */
function applyLayerHeight(
    point: PathPoint,
    chunk: ChunkNode,
    layerHeights: LayerHeights,
): void {
    const modelObj = chunk.modelObj!;
    const config = modelObj.toolpathConfig;
    const position = point.point;

    const pointZOffset = point.hStar! * layerHeights.threadDiameter;
    const surface = layerHeights.surface;

    if (!surface) {
        position.setZ(position.z + pointZOffset);
        return;
    }

    const localPosition = position.clone().sub(modelObj.mesh.position);

    // Height of the surface directly under this point, which the bottom layer sits on.
    const curvedBottomHeight = getPointHeight(surface.samplePointMatrix, localPosition);

    if (!config.curveAugment) {
        position.setZ(position.z + curvedBottomHeight + pointZOffset);
        return;
    }

    const totalLayers = config.initialFoamLayerCount + modelObj.initialConfig.initialFoamLayerCount;

    // The plane the stack flattens out to: either the augment surface or a fixed clearance above the model.
    const flatTopHeight = modelObj.augmentSamplePoints
        ? getPointHeight(modelObj.augmentSamplePoints, localPosition) + surface.modelMaxZ
        : surface.modelMaxZ + config.flatLayerZOffset;

    // Split the gap between the two surfaces evenly over the stack, so each layer is a little
    // flatter than the one below it and the last one lands on the flat plane.
    const incrementPerLayer = (flatTopHeight - curvedBottomHeight) / (totalLayers - 1);
    const layerNumber = Math.round(localPosition.z / config.deltaZ);

    const heightIncrement = layerNumber < totalLayers
        ? incrementPerLayer * layerNumber
        : incrementPerLayer * (totalLayers - 1) + config.deltaZ * (layerNumber - totalLayers + 1);

    position.setZ(modelObj.mesh.position.z + curvedBottomHeight + heightIncrement + pointZOffset);
}


/**
 * Makes a toolpath that minimizes travel movements given a tree of printable chunk regions.
 * Expects the roots to have a modelObj object.
 * 
 * @param {ChunkNode[]} roots The root nodes of the chunk tree.
 * @param {THREE.Vector3} lastLayerPoint It will try to start the print as close to this point as possible.
 *                                       It's mostly here for recursive calls and defaults to (0, 0, 0).
 * @param {number} modelHeight The distance from the base of the model to the print bed.
 * @param {boolean} scanX Whether the initial layer in the toolpath scans the x or y axis. Only applies to rectilinear paths.
 * @param {number} currentExtruder The extruder that is currently picked, so chunks that need it are preferred over ones that would force a tool change. It's mostly here for recursive calls.
 * @param {LayerHeights} layerHeights Passed straight through to makeChunkPath, so that each chunk's points carry their real heights by the time the travel moves between chunks are worked out.
 * @returns {THREE.Vector3[]} The toolpath that minimizes travel movements as a list of points.
 */
function makeChunkTreePath(
    roots: ChunkNode[],
    lastLayerPoint: THREE.Vector3 = new THREE.Vector3,
    modelHeight?: number,
    scanX: boolean = false,
    currentExtruder?: number,
    layerHeights?: LayerHeights,
    purgeTowerHeight?: number,
    purgeTowerLayerHeight?: number,
): PathPoint[] {
    let lowestHeight = Infinity;
    for (const root of roots) {
        const height = root.regions[0].height;
        if (height < lowestHeight) {
            lowestHeight = height;
        }
    }

    const printableChunkIndices: number[] = [];

    // This could be more efficient, but then we would have to figure out a different way to deal with overlap.
    // for (let i = 0; i < roots.length; i++) {
    //     const root = roots[i];
    //     if (root.regions[root.regions.length - 1].height - lowestHeight <= nozzleHeight) {
    //         printableChunkIndices.push(i);
    //     }
    // }

    for (let i = 0; i < roots.length; i++) {
        const root = roots[i];
        if (root.regions[0].height <= lowestHeight + 0.001) {
            printableChunkIndices.push(i);
        }
    }

    const sameExtruderIndices = printableChunkIndices.filter(
        i => roots[i].regions[0].extruder === currentExtruder
    );
    const candidateIndices = sameExtruderIndices.length ? sameExtruderIndices : printableChunkIndices;

    // for now it just prints the closest one. In the future can make hamiltonian path to find the most efficient path.
    let printIndex = candidateIndices[0];
    let lowestDist = Infinity;
    for (const i of candidateIndices) {
        const dist = contourDistToPoint(lastLayerPoint.clone().sub(roots[i].modelObj!.mesh.position), roots[i].regions[0].contour);
        if (dist < lowestDist) {
            lowestDist = dist;
            printIndex = i;
        }
    }
    const printExtruder = roots[printIndex].regions[0].extruder;
    const chunkPath = makeChunkPath(roots[printIndex], lastLayerPoint, modelHeight, scanX, undefined, layerHeights);
    chunkPath.forEach(p => p.extruder = printExtruder);

    if (roots[printIndex].regions.length % 2 === 1) {
        scanX = !scanX;
    }

    let towerPath: PathPoint[] = [];
    let nextPurgeTowerHeight = purgeTowerHeight;
    if (purgeTowerHeight !== undefined && chunkPath.length) {
        let chunkTopZ = -Infinity;
        for (const point of chunkPath) {
            if (point.point.z > chunkTopZ) {
                chunkTopZ = point.point.z;
            }
        }

        const levelHeight = Math.max(purgeTowerHeight, chunkTopZ); //go at least as far as the top of the chunk
        const toolChanging = currentExtruder !== undefined && printExtruder !== currentExtruder;

        const block = makePurgeTowerBlock(
            printExtruder,
            purgeTowerHeight,
            toolChanging ? Math.max(levelHeight, purgeTowerHeight + purgeTowerLayerHeight!) : levelHeight,
            lastLayerPoint,
            purgeTowerLayerHeight!
        );

        towerPath = block.path;
        nextPurgeTowerHeight = block.height;
    }

    let toolpath: PathPoint[] = [];
    for (const point of towerPath) {
        toolpath.push(point);
    }
    if (chunkPath.length) {
        toolpath.push(approachTravelPoint( //to avoid collissions due to the relatively rapid change in z
            towerPath.length ? towerPath[towerPath.length - 1].point : lastLayerPoint,
            chunkPath[0],
        ));
    }


    roots[printIndex].children.forEach(child => {
        child.modelObj = roots[printIndex].modelObj;
    })

    roots.splice(printIndex, 1, ...roots[printIndex].children);

    let restOfPath: PathPoint[] = [];
    if (roots.length) {
        const restStartPoint = chunkPath.length
            ? chunkPath[chunkPath.length - 1].point
            : (towerPath.length ? towerPath[towerPath.length - 1].point : lastLayerPoint);

        restOfPath = makeChunkTreePath(
            roots,
            restStartPoint,
            modelHeight,
            scanX,
            printExtruder,
            layerHeights,
            nextPurgeTowerHeight,
            purgeTowerLayerHeight
        );
    }

    // add the path in a for loop to avoid maximum call stack error for super long paths
    for (const point of chunkPath) {
        toolpath.push(point);
    }
    for (const point of restOfPath) {
        toolpath.push(point);
    }

    toolpath = fillToolpath(toolpath, 0.5);

    return toolpath
}


/**
 * Visualizes the contours of the chunks of a model by coloring them differently.
 * 
 * @param {ChunkNode[]} roots The root nodes of the chunks to visualize.
 * @param {number[]} colorArray The colors the chunks will be visualized as. It will cycle through these for each chunk.
 * @param {number} currentColorIndex The index of the color of the first chunk.
 * @param {THREE.Group} visualizationGroup The visualization group to add the visualization to.
 */
function visualizeChunks(
    roots: ChunkNode[],
    colorArray: number[],
    currentColorIndex: number,
    visualizationGroup: THREE.Group,
): void {
    for (const root of roots) {
        const vertices: number[] = [];
        for (const region of root.regions) {
            for (const pt of region.contour) {
                vertices.push(pt.x, pt.y, pt.z);
            }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        const material = new THREE.LineBasicMaterial({ color: colorArray[currentColorIndex], linewidth: 2, opacity: 0.8, transparent: true });
        const line = new THREE.Line(geometry, material);
        currentColorIndex++;
        currentColorIndex %= colorArray.length;
        visualizationGroup.add(line);

        visualizeChunks(root.children, colorArray, currentColorIndex, visualizationGroup);
    }
}


/**
 * Determines whether a square intersects with a given mesh.
 * 
 * @param mesh The mesh to check intersections with.
 * @param squareMin The lower corner of the square. This should have the same z as squareMax.
 * @param squareMax The upper corner of the square. This should have the same z as squareMin.
 * @returns {boolean} Whether or not there is an intersection.
 */
function meshIntersectsSquareAtZ(
    mesh: THREE.Mesh,
    squareMin: THREE.Vector3,
    squareMax: THREE.Vector3,
): boolean {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const positionAttr = geometry.getAttribute("position");
    const matrixWorld = mesh.matrixWorld;

    const triangle = new THREE.Triangle();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();

    for (let i = 0; i < positionAttr.count; i += 3) {
        a.fromBufferAttribute(positionAttr, i).applyMatrix4(matrixWorld);
        b.fromBufferAttribute(positionAttr, i + 1).applyMatrix4(matrixWorld);
        c.fromBufferAttribute(positionAttr, i + 2).applyMatrix4(matrixWorld);

        // Check if triangle intersects with the plane z = zPlane
        if ((a.z - squareMin.z) * (b.z - squareMin.z) <= 0 ||
            (b.z - squareMin.z) * (c.z - squareMin.z) <= 0 ||
            (c.z - squareMin.z) * (a.z - squareMin.z) <= 0) {

            // Intersect triangle with plane
            const segments = intersectTriangleWithZPlane(a, b, c, squareMin.z);

            for (const segment of segments) {
                // Check if segment is inside square
                if (segmentIntersectsSquare(segment[0], segment[1], squareMin, squareMax)) {
                    return true;
                }
            }
        }
    }

    return false;
}


/**
 * Gets the intersecting segments of a triangle with a plane at a specific z value.
 * 
 * @param {THREE.Vector3} a The first vertice of the triangle.
 * @param {THREE.Vector3} b The second vertice of the triangle.
 * @param {THREE.Vector3} c The third vertice of the triangle.
 * @param {number} z The z of the plane to check intersections with.
 * @returns {[THREE.Vector3, THREE.Vector3][]} The list of segments that intersect with the plane.
 */
function intersectTriangleWithZPlane(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    z: number
): [THREE.Vector3, THREE.Vector3][] {
    const points = [a, b, c];
    const intersections: THREE.Vector3[] = [];

    for (let i = 0; i < 3; i++) {
        const p1 = points[i];
        const p2 = points[(i + 1) % 3];

        if ((p1.z - z) * (p2.z - z) < 0) {
            const t = (z - p1.z) / (p2.z - p1.z);
            const point = new THREE.Vector3().lerpVectors(p1, p2, t);
            intersections.push(point);
        } else if (p1.z === z) {
            intersections.push(p1.clone());
        }
    }

    if (intersections.length === 2) {
        return [[intersections[0], intersections[1]]];
    } else {
        return [];
    }
}


/**
 * Gets whether a line segment intersects with a square.
 * This is only in 2D even though it takes in THREE.Vector3s.
 * 
 * @param {THREE.Vector3} p1 The line segment start pont.
 * @param {THREE.Vector3} p2 The line segment end pont.
 * @param {THREE.Vector3} min The lower corner of the square.
 * @param {THREE.Vector3} max The upper corner of the square.
 * @returns 
 */
function segmentIntersectsSquare(
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    min: THREE.Vector3,
    max: THREE.Vector3
): boolean {
    const lineMin = new THREE.Vector2(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y));
    const lineMax = new THREE.Vector2(Math.max(p1.x, p2.x), Math.max(p1.y, p2.y));

    const overlapX = !(lineMax.x < min.x || lineMin.x > max.x);
    const overlapY = !(lineMax.y < min.y || lineMin.y > max.y);

    return overlapX && overlapY;
}

/**
 * Gets the required additional z offset for the toolpath to not collide with a given mesh.
 * 
 * @param {THREE.Mesh} mesh The mesh to detect collisions for.
 * @param {THREE.Vector3[]} toolpath The printhead toolpath.
 * @param {number} nozzleLength The length off the printer's nozzle.
 * @param {{ min: THREE.Vector2, max: THREE.Vector2 }} printHeadBox The box representing the printheads x and y 
 *                                                                  dimensions with the nozzle being at 0, 0
 * @param {number} offsetTolerance Controls the accuracy of the returned height. If 0.1, the accuracy of the required
 *                            height will be within 0.1 of the true required height.
 * @returns {number} The required additional z offset for the toolpath. This will never be negative.
 */
function getRequiredZOffset(
    mesh: THREE.Mesh,
    toolpath: THREE.Vector3[],
    nozzleLength: number,
    printHeadBox: { min: THREE.Vector2, max: THREE.Vector2 },
    offsetTolerance: number
): number {
    // new binary search O(logn) implementation
    let bestZOffset = 0;
    mesh.geometry.computeBoundingBox();
    // where step max is the full vertical range available before the nozzle would be above the mesh
    const stepMax = mesh.geometry.boundingBox!.max.z - mesh.geometry.boundingBox!.min.z - nozzleLength;

    let low = 0;
    let high = stepMax;

    while (high - low > offsetTolerance) {
        let mid = (high + low) / 2;

        // any collision with this current zOffset?
        const anyCollision = toolpath.some(point => pointHasCollision(mesh, point, nozzleLength, printHeadBox, mid));

        if (anyCollision) {
            // low = mid + offsetTolerance;
            low = mid;
        } else {
            // high = mid - offsetTolerance;
            high = mid;
            bestZOffset = mid;
        }
    }

    // return minimum non-colliding zOffset
    return bestZOffset;


    // // OLD CODE: O(n) collision detection implementation
    // let maxHeight = 0;

    // mesh.geometry.computeBoundingBox();
    // const stepMax = mesh.geometry.boundingBox!.max.z - mesh.geometry.boundingBox!.min.z - nozzleLength;

    // for (const point of toolpath) {
    //     let zOffset = maxHeight;
    //     while (zOffset < stepMax) {
    //         const squareMin = new THREE.Vector3(point.x + printHeadBox.min.x, point.y + printHeadBox.min.y, point.z + nozzleLength + zOffset);
    //         const squareMax = new THREE.Vector3(point.x + printHeadBox.max.x, point.y + printHeadBox.max.y, point.z + nozzleLength + zOffset);
    //         squareMin.sub(mesh.position);
    //         squareMax.sub(mesh.position);
    //         if (meshIntersectsSquareAtZ(mesh, squareMin, squareMax)) {
    //             zOffset += offsetTolerance;
    //         } else {
    //             if (zOffset > maxHeight) maxHeight = zOffset;
    //             break;
    //         }
    //     }

    //     if (maxHeight >= stepMax) {
    //         break;
    //     }
    // }

    // return maxHeight;
}

/**
 * Checks if the printhead at a given point and zOffset collides with the given mesh.
 * 
 * @param {THREE.Mesh} mesh The mesh to detect collisions for.
 * @param {THREE.Vector3} point The printhead toolpath point.
 * @param {number} nozzleLength The length off the printer's nozzle.
 * @param {{ min: THREE.Vector2, max: THREE.Vector2 }} printHeadBox The box representing the printheads x and y 
 *                                                                  dimensions with the nozzle being at 0, 0
 * @param {number} zOffset The vertical offset being evaluated (mm), where larger means higher.
 * 
 * @returns {boolean} Whether the given point collides with the nozzle tip/printhead collides with the mesh at this zOffset
 */

function pointHasCollision(
    mesh: THREE.Mesh,
    point: THREE.Vector3,
    nozzleLength: number,
    printHeadBox: { min: THREE.Vector2, max: THREE.Vector2 },
    zOffset: number
): boolean {
    const squareMin = new THREE.Vector3(point.x + printHeadBox.min.x, point.y + printHeadBox.min.y, point.z + nozzleLength + zOffset);
    const squareMax = new THREE.Vector3(point.x + printHeadBox.max.x, point.y + printHeadBox.max.y, point.z + nozzleLength + zOffset);
    squareMin.sub(mesh.position);
    squareMax.sub(mesh.position);
    return meshIntersectsSquareAtZ(mesh, squareMin, squareMax);
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

        const columnDist = Math.abs(column[0].x - nextColumn[0].x);

        gradientMatrix.push([]);
        if (column.length <= 1) {
            continue;
        }
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
function getTransformedMesh(
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



/**
 * Creates a horizontal linear gradient SVG programmatically and applies it to the model object.
 * White (start values) on the left, black (end values) on the right, with gray gradient in between.
 * This method silently creates the gradient without requiring user input.
 * 
 * @param {EverydayModel} modelObj The model object to apply the gradient to
 * @param {number} width The width of the gradient SVG (default: 1000)
 * @param {number} height The height of the gradient SVG (default: 1000)
 */
function createLinearSVG(modelObj: EverydayModel, width: number = 1000, height: number = 1000): void {
    // Create SVG string with horizontal linear gradient
    const svgString = `
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="horizontalGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" style="stop-color:white;stop-opacity:1" />
                    <stop offset="100%" style="stop-color:black;stop-opacity:1" />
                </linearGradient>
            </defs>
            <rect width="100%" height="100%" fill="url(#horizontalGradient)" />
        </svg>
    `;

    // Convert SVG string to blob and create object URL
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);

    //create img andf load svg
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;

    img.onload = () => {
        // Create canvas to rasterize the SVG
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        
        // Clear canvas and draw the SVG
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);

        //applies the gradient to the model object, uses same code essentially as importSvgGradient in modelloader.ts
        modelObj.gradient = {
            width: canvas.width,
            height: canvas.height,
            sampleColor(x: number, y: number): RGBA {
                const ix = Math.min(canvas.width - 1, Math.max(0, Math.floor(x)));
                const iy = Math.min(canvas.height - 1, Math.max(0, Math.floor(y)));
                const d = ctx.getImageData(ix, iy, 1, 1).data;
                return { r: d[0], g: d[1], b: d[2], a: d[3] };
            }
        };

        // Clean up the object URL
        URL.revokeObjectURL(url);
        
        console.log('Linear horizontal gradient applied to model object');
        console.log(" gradient:", modelObj.gradient);
    };

    img.onerror = (err) => {
        console.error('Failed to load generated SVG for gradient', err);
        URL.revokeObjectURL(url);
    };
}



/**
 * Creates a vertical gradient effect by directly interpolating h* and v* values based on layer height.
 * Bottom layers use start values, top layers use end values, with linear interpolation in between.
 * 
 * @param {PathPoint[]} chunkPath The toolpath points to apply vertical gradient to
 * @param {number} modelHeight The base height of the model (lowest Z value)
 * @param {number} maxHeight The maximum height of the model (highest Z value)  
 * @param {any} config The configuration object containing hStar, vStar, hStarEnd, vStarEnd values
 */
function applyVerticalGradient(
    chunkPath: PathPoint[], 
    modelHeight: number, 
    maxHeight: number, 
    config: any
): void {
    const totalHeight = maxHeight - modelHeight;
    
    if (totalHeight <= 0) {
        console.warn('Invalid height range for vertical gradient');
        return;
    }
    
    chunkPath.forEach(point => {
        // Calculate the relative position in the height range (0 = bottom, 1 = top)
        const heightPercent = Math.min(1, Math.max(0, (point.point.z - modelHeight) / totalHeight));
        
        // Linear interpolation: start + percent * (end - start)
        point.hStar = config.hStar + heightPercent * (config.hStarEnd - config.hStar);
        point.vStar = config.vStar + heightPercent * (config.vStarEnd - config.vStar);
        //point.deltaL = config.deltaL + heightPercent * (config.deltaLEnd - config.deltaL);
    });
    
    console.log(`Applied vertical gradient: bottom(${config.hStar}, ${config.vStar}, ${config.deltaL}) -> top(${config.hStarEnd}, ${config.vStarEnd}, ${config.deltaLEnd})`);
}




/**
 * Slices a model for foam printing, using travel slicer outer reductions to reduce travel movements
 * and uses either rectilinear or fermat spiral infill.
 
 * @param {Visualizer} visualizer The Visualizer instance
 * @param {EverydayModel[]} modelObjs A list of model objects to slice.
 * @returns Toolpaths for all, foam, and sense (currently only all/foam)
 */
export function generateFoamToolpath(
    visualizer: Visualizer,
    modelObjs: EverydayModel[],
): PathPoint[] {
    console.log('generating foam toolpath');
    const chunkRoots: ChunkNode[] = [];
    let highestStartHeight = -Infinity;
    const boundaryPath: PathPoint[] = [];
    modelObjs.forEach(modelObj => {
        if (modelObj.toolpathVisualizationObject) {
            visualizer.scene.remove(modelObj.toolpathVisualizationObject);
            modelObj.toolpathVisualizationObject.traverse((child: any) => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) child.material.dispose();
            });
        }

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
        if (visualizer.printer.generateBoundary) {
            addBoundary(boundaryPath, transformedMesh, modelObj.mesh.position, visualizer.printer.machine_depth_y, 1, 1, false);
        }
        

        // Remove previous visualization
        if (modelObj.toolpathVisualizationObject) {
            visualizer.scene.remove(modelObj.toolpathVisualizationObject);
            modelObj.toolpathVisualizationObject.traverse((child: any) => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) child.material.dispose();
            });
        }

        // Update parameters for printing
        visualizer.printer.updateParameters(modelObj.toolpathConfig);

        // --- 1. Slice mesh into layers and extract regions ---
        const layers = sliceMeshIntoLayers(transformedMesh, modelObj.toolpathConfig.deltaZ);
        console.log('Sliced layers:', layers.length, layers);
        let allRegions: SliceRegion[] = [];
        let lowestHeight = Infinity;
        for (const { z, segments } of layers) {
            const regions = extractRegionsFromLayer(z, segments);
            regions.forEach(region => {
                if (region.height < lowestHeight) {
                    lowestHeight = region.height;
                }
            })
            allRegions.push(...regions);
        }
        
        const regionTree = buildRegionTree(allRegions, modelObj.toolpathConfig.deltaZ);
        regionTree.forEach(root => {
            const height = root.region.height + modelObj.mesh.position.z
            if (height > highestStartHeight) {
                highestStartHeight = height;
            }
        });

        const chunkTree = buildChunkTree(regionTree, visualizer.printer);

        chunkTree.forEach(chunkNode => {
            chunkNode.modelObj = modelObj;
        });

        chunkRoots.push(...chunkTree);
        
        // const colors: number[] = [0xff0000, 0x00ff00, 0x0000ff, 0x00aaaa];
        // visualizeChunks(chunkTree, colors, 0, visualizationGroup);
    });

 

    // Horizontal Gradient if no svg exiists
    // Comment out from here to end mark
    // modelObjs.forEach(modelObj => {
    // console.log("Checking gradient:", modelObj.gradient);
    // // Check if gradient is the default placeholder (1x1) or doesn't exist
    // const config = modelObj.toolpathConfig;
    // const hasGradientVariation = (config.hStar !== config.hStarEnd) || (config.vStar !== config.vStarEnd);
    
    // const hasValidGradient = modelObj.gradient && 
    //                         modelObj.gradient.width > 1 && 
    //                         modelObj.gradient.height > 1;
    
    //     if (!hasValidGradient && hasGradientVariation) {
    //         console.log("No valid SVG gradient loaded, creating horizontal gradient fallback");
    //         createLinearSVG(modelObj);
    //     } else {
    //         console.log("Using existing SVG gradient:", modelObj.gradient.width, "x", modelObj.gradient.height);
    //     }
    // });
    // End mark


    const visualizationGroup = new THREE.Group();

    visualizer.scene.add(visualizationGroup);

    const firstExtruder = visualizer.printer.extruders[0];
    const startPoint = new THREE.Vector3(0, 0, highestStartHeight);
    const toolpath = makeChunkTreePath(
        chunkRoots,
        startPoint,
        undefined,
        false,
        undefined,
        { threadDiameter: firstExtruder.nozzleDiameter * firstExtruder.dieSwelling },
    );

    /*
    // comment out from here till end mark if dont want vertical gradient
    // vertical testing for vertical gradient 
    modelObjs.forEach(modelObj => {
        const config = modelObj.toolpathConfig;
        const hasGradientVariation = (config.hStar !== config.hStarEnd) || (config.vStar !== config.vStarEnd);
    
        const hasValidGradient = modelObj.gradient && 
                            modelObj.gradient.width > 1 && 
                            modelObj.gradient.height > 1;
        if (!hasValidGradient && hasGradientVariation) {
            // Calculate model bounds for vertical gradient
            modelObj.geometry.computeBoundingBox();
            const modelHeight = modelObj.geometry.boundingBox!.min.z;
            const maxHeight = modelObj.geometry.boundingBox!.max.z + modelObj.mesh.position.z;
            console.log("applying vertical gradiet  to model from", modelHeight, "to", maxHeight);
            // Apply vertical gradient using the toolpath config
            applyVerticalGradient(toolpath, modelHeight, maxHeight, modelObj.toolpathConfig);
        }
    });
    // end mark
    */

    // Each point's ZOffset was applied back in makeChunkPath, where its hStar was resolved. The
    // boundary and purge line are added below on purpose: neither has an hStar to offset by.

    boundaryPath.reverse();
    boundaryPath.forEach(point => toolpath.unshift(point));

    if (visualizer.printer.purgeLine) {
        addPurgeLine(toolpath, visualizer.printer.machine_depth, 2, 2);
    }

    visualizeToolpath(toolpath, visualizationGroup, visualizer.printer.extruders.map(e => e.color), 0x0000ff);

    visualizer.scene.add(visualizationGroup);
    modelObjs[0].toolpathVisualizationObject = visualizationGroup;
    return toolpath;
}


/**
 * Not in use
 * Generates a test path for classifying foams. The first half of each line has
 * the same parameters as the second half of the previous line.
 * 
 * @param {number} deltaL How far apart each line is.
 * @param {THREE.Vector3} position The position of the test print.
 * @param {number} lineLength How long each line should be.
 * @param {number} numLines How many lines there should be.
 * @param {number} purgeDistance How long the purges should be.
 * @param {number} threadDiameter The diameter of the thread (die swell * nozzle diameter).
 * @param {number} startHStar The H* at the start of the test.
 * @param {number} endHStar The H* at the end of the test.
 * @param {number} startVStar The V* at the start of the test.
 * @param {number} endVStar The V* at the end of the test.
 * @returns {PathPoint[]} The generated test path.
 */
export function generateTrialToolpath(
    deltaL: number,
    position: THREE.Vector3,
    lineLength: number,
    numLines: number,
    purgeDistance: number,
    threadDiameter: number,
    startHStar: number,
    endHStar: number,
    startVStar: number,
    endVStar: number,
): PathPoint[] {
    const toolpath: PathPoint[] = [];

    let lineStartHStar = startHStar;
    let lineStartVStar = startVStar;

    for (let i = 0; i < numLines; i++) {
        const y = i * deltaL - (numLines * deltaL) / 2;

        // Purge at the start
        toolpath.push({
            point: new THREE.Vector3((-lineLength / 2) - purgeDistance, y, lineStartHStar * threadDiameter),
            travel: true,
            hStar: lineStartHStar,
            vStar: lineStartVStar,
        })

        const lineEndHStar = lineStartHStar + 2 * (endHStar - startHStar) / (numLines)
        const lineEndVStar = lineStartVStar + 2 * (endVStar - startVStar) / (numLines)

        let x = -lineLength / 2;
        while (x < lineLength / 2) {
            const pointHStar = lineStartHStar + x * ((lineEndHStar - lineStartHStar) / lineLength);
            const pointVStar = lineStartVStar + x * ((lineEndVStar - lineStartVStar) / lineLength);
            const zOffset = pointHStar * threadDiameter;
            toolpath.push({
                point: new THREE.Vector3(x, y, zOffset),
                travel: false,
                hStar: pointHStar,
                vStar: pointVStar,
            })
            x += 0.1;
        }

        const endZOffset = lineEndHStar * threadDiameter;

        toolpath.push({
            point: new THREE.Vector3(lineLength / 2, y, endZOffset),
            travel: false,
            hStar: lineEndHStar,
            vStar: lineEndVStar,
        })

        // Purge at end
        toolpath.push({
            point: new THREE.Vector3((lineLength / 2) + purgeDistance, y, 0),
            travel: false,
            hStar: lineEndHStar,
            vStar: lineEndVStar,
        })

        toolpath.push({
            point: new THREE.Vector3((lineLength / 2) + purgeDistance * 1.5, y, 0),
            travel: false,
            hStar: lineEndHStar,
            vStar: lineEndVStar,
        })

        lineStartHStar = lineStartHStar + (endHStar - startHStar) / (numLines);
        lineStartVStar = lineStartVStar + (endVStar - startVStar) / (numLines);
    }

    toolpath.forEach(pt => pt.point.add(position));

    return toolpath;
}


/**
 * Adds the boundary of a mesh's base to the start of a given toolpath.
 * 
 * @param {PathPoint[]} toolpath The toolpath to add the boundary to.
 * @param {THREE.Mesh} mesh The mesh to get the boundary of.
 * @param {THREE.Vector3} position The position of the boundary.
 * @param {number} machineDepthY The Y dimension of the print bed.
 * @param {number} layerNum How many layers the boundary should be (work in progress for more than 1).
 * @param {number} offset How far offset the boundary should be.
 * @param {boolean} pause Whether it should park and pause after printing the boundary.
 */
function addBoundary(
    toolpath: PathPoint[],
    mesh: THREE.Mesh,
    position: THREE.Vector3,
    machineDepthY: number,
    layerNum: number,
    offset: number,
    pause: boolean,
): void {
    const expandedContours = generateBoundaryContours(mesh, offset);

    if (pause) {
        toolpath.unshift({
            point: new THREE.Vector3(0, machineDepthY, mesh.geometry.boundingBox!.max.z + position.z + 10),
            travel: true,
            pause: true,
        });
    }
    
    for (let i = 0; i < layerNum; i++) {
        expandedContours.forEach(contour => {
            contour.forEach(pt => {
                const point = pt.clone().add(position);
                point.setZ(0.1 + i * 0.2);
                toolpath.unshift({
                    point: point,
                    regularSegment: true,
                })
            });
        });
    }

    toolpath[0].travel = true;
    toolpath[0].regularSegment = false;
}


/**
 * Adds a purge line to the start of a toolpath.
 * 
 * @param {PathPoint[]} toolpath The toolpath to add the purge line to.
 * @param {number} machineDepth The X dimension of the printer.
 * @param {number} lineSeparation How far apart the purge lines should be.
 * @param {number} lineNum How many purge lines should be generated.
 */
function addPurgeLine(
    toolpath: PathPoint[],
    machineDepth: number,
    lineSeparation: number,
    lineNum: number,
): void {
    const rectangleContour = [
        new THREE.Vector3(5, 5, 0.1),
        new THREE.Vector3(machineDepth - 5, 5, 0.1),
        new THREE.Vector3(machineDepth - 5, 5 + lineSeparation * (lineNum - 1) + 0.001, 0.1),
        new THREE.Vector3(5, 5 + lineSeparation * (lineNum - 1) + 0.001, 0.1)
    ];

    const path = generateRectilinearInfill(rectangleContour, lineSeparation, false, new THREE.Vector3(5, 5, 0.1));

    path.reverse();
    path.forEach(point => {
        toolpath.unshift({
            point: point.point,
            regularSegment: true,
        });
    });
}

// Helper function for find nearest point.
function lowerBoundXs(matrix: THREE.Vector3[][], tx: number): number {
    let lo = 0, hi = matrix.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (matrix[mid][0] && matrix[mid][0].x < tx) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}


// Helper function for find nearest point.
function lowerBoundYs(row: THREE.Vector3[], ty: number): number {
    let lo = 0, hi = row.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (row[mid].y < ty) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}


// Helper function for find nearest point.
function squaredXYDist(a: THREE.Vector3, b: THREE.Vector3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}


/**
 * Finds the k closest points from a sorted matrix to a given point.
 * Will only return up to 4 points, even if K is higher than 4.
 * Won't always return K points even if K is <= 4.
 * 
 * @param matrix The sorted matrix of points
 * @param target The point to find the closest points to.
 * @param k How many points should be returned.
 * @returns {THREE.Vector3[]} The nearest points to the target, sorted from lowest to highest distance.
 */
function findNearestPoints(
    matrix: THREE.Vector3[][],
    target: THREE.Vector3,
    k: number
): THREE.Vector3[] {
    const N = matrix.length;
    if (N === 0) return [];

    const xi = lowerBoundXs(matrix, target.x);

    // collect every candidate we check, with its squared distance
    const candidates: { point: THREE.Vector3; dist: number }[] = [];

    // check the two candidate x‑slices
    for (const sliceIdx of [xi - 1, xi]) {
        if (sliceIdx < 0 || sliceIdx >= N) continue;
        const column = matrix[sliceIdx];

        // within that column find the y bracket
        const yj = lowerBoundYs(column, target.y);
        for (const rowIdx of [yj - 1, yj]) {
            if (rowIdx < 0 || rowIdx >= column.length) continue;
            const pt = column[rowIdx];
            const d = squaredXYDist(pt, target);
            candidates.push({ point: pt, dist: d });
        }
    }

    return candidates
        .sort((a, b) => a.dist - b.dist)
        .slice(0, k)
        .map(c => c.point);
}


/**
 * Given a plane defined by 3 points, determines the z value at a given x y value.
 * 
 * @param p1 The first point of the plane.
 * @param p2 The second point of the plane.
 * @param p3 The third point of the plane.
 * @param x The x value of the point to find the z value of.
 * @param y The y value of the point to find the z value of.
 * @returns {number} The z value at the given x y coordinates. Will return NaN if the given points
 *                   defining the plane are all on a line (meaning no clear plane is made).
 */
function getPlaneHeightAtXY(
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    x: number,
    y: number,
): number {
    const plane = new THREE.Plane().setFromCoplanarPoints(p1, p2, p3).normalize();

    const { x: nx, y: ny, z: nz } = plane.normal;
    const d = plane.constant;

    if (Math.abs(nz) <= 0.0001) {
        return NaN;
    }

    return -(nx * x + ny * y + d) / nz;
}


/**
 * Given a sorted matrix of points making up a surface, finds the 
 * height of a point if projected downwards onto that matrix.
 * 
 * @param {THREE.Vector3[][]} matrix The sorted matrix of points, with columns having a constant x value.
 * @param {THREE.Vector3} point The point to find the height of.
 * @returns {number} The height of the point when projected onto the given point matrix.
 */
function getPointHeight(
    matrix: THREE.Vector3[][],
    point: THREE.Vector3
): number {
    const nearestPoints = findNearestPoints(matrix, point, 3);

    if (nearestPoints.length >= 3) {
        let height = getPlaneHeightAtXY(nearestPoints[0], nearestPoints[1], nearestPoints[2], point.x, point.y);
        if (!height) {
            const line = new THREE.Line3(nearestPoints[0], nearestPoints[2]);

            const closest = new THREE.Vector3();
            line.closestPointToPoint(point, true, closest);
            height = closest.z;
        }
        return height
    } else if (nearestPoints.length >= 2) {
        const line = new THREE.Line3(nearestPoints[0], nearestPoints[1]);

        const closest = new THREE.Vector3();
        line.closestPointToPoint(point, true, closest);
        return closest.z;
    } else if (nearestPoints.length >= 1) {
        return nearestPoints[0].z;
    }

    console.warn("Not able to find any points");
    return 0;
}


/**
 * Not in use
 * Slices a model to print it by slowly curving a toolpath until it reaches the desired shape of the model.
 * Requires that the model has toolpathSampelPoints to work.
 * 
 * @param {Visualizer} visualizer The visualizer object.
 * @param {EverydayModel} modelObj The model to slice, requiring toolpathSamplePoints.
 * @param {number} layerNum How many layers should be generated.
 * @returns {all: any; foam: any; sense: any} The generated toolpath.
 */
export function generateNonplanarFoamToolpath(
    visualizer: Visualizer,
    modelObj: EverydayModel,
    layerNum: number,
): { all: any; foam: any; sense: any } {
    visualizer.printer.updateParameters(modelObj.toolpathConfig);

    const pointMatrix: THREE.Vector3[][] = [];

    const samplePoints = modelObj.toolpathSamplePoints!;

    modelObj.geometry.computeBoundingBox();
    const bbox = modelObj.geometry.boundingBox!;

    for (const samplePoint of samplePoints) {
        const point = samplePoint.point;
        
        const bottomHeight = bbox.min.z;

        if (!bottomHeight) {
            continue;
        }

        const heightDif = point.z - bottomHeight;

        const columnDeltaZ = Math.max(heightDif / (layerNum - 1), modelObj.toolpathConfig.deltaZ);
        let z = bottomHeight;
        const columnPoints: THREE.Vector3[] = [];
        while (z <= point.z) {
            columnPoints.push(new THREE.Vector3(point.x, point.y, z));
            z += columnDeltaZ;
        }
        pointMatrix.push(columnPoints);
    }

    // Turn each layer into a contour, generate rectilinear path, then curve it back.
    let scanX = false;
    let lastLayerEndPoint = new THREE.Vector3();
    const toolpath: PathPoint[] = [];
    for (let i = 0; i < layerNum; i++) {
        const pointCloud: THREE.Vector3[] = [];
        for (const column of pointMatrix) {
            if (column[i]) {
                pointCloud.push(column[i]);
            }
        }

        if (!pointCloud.length) {
            continue;
        }

        const samplePointMatrix: THREE.Vector3[][] = [[]];
        let lastX = pointCloud[0].x;
        for (const point of pointCloud) {
            if (Math.abs(point.x - lastX) <= 0.0001) {
                samplePointMatrix[samplePointMatrix.length - 1].push(point);
            } else {
                samplePointMatrix.push([point]);
                lastX = point.x;
            }
        }
        for (const column of samplePointMatrix) {
            column.sort((a, b) => a.y - b.y);
        }

        const cloudSliceRegions: SliceRegion[] = extractRegionsFromPointCloud(pointCloud, 5);


        for (const region of cloudSliceRegions) {
            const infill = generateRectilinearInfill(region.contour, modelObj.toolpathConfig.deltaL, scanX, lastLayerEndPoint);
            let regionToolpath: PathPoint[] = [];
            const beforeLength = regionToolpath.length;
            regionToolpath.push(...infill.map(p => {
                return {
                    point: p.point.clone().add(modelObj.mesh.position),
                    travel: false,
                }
            }));
            regionToolpath[beforeLength].travel = true;

            regionToolpath = fillToolpath(regionToolpath, 0.5);

            const gradient = modelObj.gradient;
            for (const point of regionToolpath) {
                const scaledX = ((point.point.x - bbox.min.x) / (bbox.max.x - bbox.min.x)) * gradient.width;
                const scaledY = ((point.point.y - bbox.min.y) / (bbox.max.y - bbox.min.y)) * gradient.height;
                const sampledColor = gradient.sampleColor(scaledX, scaledY);
                // Black is 1 white is 0
                const percent = 1 - (sampledColor.r + sampledColor.g + sampledColor.b) / (3 * 255);
                point.hStar = modelObj.toolpathConfig.hStar + percent * (modelObj.toolpathConfig.hStarEnd - modelObj.toolpathConfig.hStar);
                point.vStar = modelObj.toolpathConfig.vStar + percent * (modelObj.toolpathConfig.vStarEnd - modelObj.toolpathConfig.vStar);
                point.edot = modelObj.toolpathConfig.edot;
            }

            // Curve infill
            for (let i = 0; i < regionToolpath.length; i++) {
                const point = regionToolpath[i].point;

                const pointZOffset = modelObj.toolpathConfig.hStar * (visualizer.printer.extruders[0].nozzleDiameter * visualizer.printer.extruders[0].dieSwelling);

                const pointHeight = getPointHeight(samplePointMatrix, point.clone().sub(modelObj.mesh.position))

                point.setZ(pointHeight + pointZOffset);
            }

            lastLayerEndPoint = infill[infill.length - 1].point;

            toolpath.push(...regionToolpath);
        }
        scanX = !scanX;
    }

    for (const point of toolpath) {
        point.point.setZ(point.point.z - bbox.min.z);
    }

    return {
        all: toolpath,
        foam: null,
        sense: null,
    }
}


/**
 * Visualizes a toolpath, showing travel movements and print movements
 * as separate colors.
 * 
 * @param toolpath The toolpath to visualize
 * @param visualizationGroup The visualization group to add the visualization to.
 * @param printColors The colors for print extrusions, indexed by extruder.
 * @param travelColor The color the visualization should be for travel movements.
 */
function visualizeToolpath(
    toolpath: PathPoint[],
    visualizationGroup: THREE.Group,
    printColors: number[],
    travelColor: number
): void {
    let allVertices: number[] = [];
    let lastPoint = toolpath[0];

    const visualizeSegment = () => {
        if (allVertices.length > 0) {
            const geometry = new THREE.BufferGeometry();

            geometry.setAttribute(
                'position',
                new THREE.Float32BufferAttribute(new Float32Array(allVertices), 3)
            );

            // Print moves are colored per extruder so material changes are visible.
            // Anything past the end of the palette falls back to the first color.
            const printColor = printColors[lastPoint.extruder ?? 0] ?? printColors[0];
            const material = new THREE.LineBasicMaterial({
                color: lastPoint.travel ? travelColor : printColor,
                linewidth: 2,
            });

            const line = new THREE.Line(geometry, material);
            visualizationGroup.add(line);
        }
        allVertices = [];
    };

    for (const point of toolpath) {   
        if ((lastPoint.travel as boolean) != (point.travel as boolean)) {
            visualizeSegment();
            if (point.travel) {
                allVertices.push(lastPoint.point.x, lastPoint.point.y, lastPoint.point.z);
            }
        }
        allVertices.push(point.point.x, point.point.y, point.point.z);

        lastPoint = point;
    }

    visualizeSegment()
}


/**
 * Generates foam toolpaths designed to augment EverydayModels based on the model's sampled points.
 *
 * This function performs the following steps:
 * 1. Removes any previous foam toolpath visualization from the scene and disposes its resources.
 * 2. Checks if sample points exist; if none, logs a warning and returns.
 * 3. Constructs continuous paths from the sample points in either a rectilinear or fermat spiral pattern.
 * 4. Visualizes the generated segments
 * 5. Returns an object containing the generated toolpath segments for all, foam, and sense.
 *
 * @param visualizer - The Visualizer instance, providing access to the scene and sampleStep.
 * @param modelObj - The model object, which must include:
 *                   - toolpathSamplePoints: Array<PointCloudPoint>
 *                   - mesh: THREE.Mesh (for positioning)
 *                   - foamToolpathLine: (optional) previous toolpath visualization.
 * @returns An object with properties 'all', 'foam', and 'sense' containing the generated segments.
 */
export function generateAugmentFoamToolpath(
    visualizer: Visualizer,
    modelObj: EverydayModel,
): PathPoint[] | null{
    // --- 1. Remove the previous foam toolpath visualization, if it exists.
    if (modelObj.toolpathVisualizationObject) {
        visualizer.scene.remove(modelObj.toolpathVisualizationObject);
        modelObj.toolpathVisualizationObject.traverse((child: any) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }

    const transformedMesh = getTransformedMesh(modelObj.mesh);
    
    visualizer.printer.updateParameters(modelObj.toolpathConfig);

    // HORIZTONAL gradient creation if no svg
    // Check if svg exists, if not create horizontal linear svg for gradient

    console.log("Checking gradient:", modelObj.gradient);
    const hasValidGradient = modelObj.gradient && 
                            modelObj.gradient.width > 1 && 
                            modelObj.gradient.height > 1;
    const config = modelObj.toolpathConfig;
    const hasGradientVariation = (config.hStar !== config.hStarEnd) || (config.vStar !== config.vStarEnd);
    
    // Comment out from here to end mark if dont want hori gradient
    // Applies the horixontal gradient (comment out if want to use vertical and vertical is not commented out)
    // if (!hasValidGradient && hasGradientVariation) {
    //     console.log("No valid SVG gradient loaded, creating horizontal gradient fallback");
    //     createLinearSVG(modelObj);

    // } else {
    //     console.log("Using existing SVG gradient:", modelObj.gradient.width, "x", modelObj.gradient.height);
    // }
    // end mark

    // --- 2. Check if there are sample points available.
    if (!modelObj.toolpathSamplePoints || modelObj.toolpathSamplePoints.length === 0) {
        console.warn("No sample points available. Cannot generate toolpath.");
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

    const gradientThresholdDegrees = modelObj.toolpathConfig.steepnessThreshold;
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

    console.log("Bump Mesh: " + modelObj.bumpMesh);

    const bumpRegions: SliceRegion[] = [];
    const cloudSliceRegions: SliceRegion[] = [
        ...extractRegionsFromPointCloud(regularPoints, 5,0),
        ...extractRegionsFromPointCloud(sensePoints, 5, 1)
    ];

    const flatLayerNum = modelObj.toolpathConfig.additionalCurveLayers;

    if (modelObj.toolpathConfig.generateBumps) {
        modelObj.bumpMesh!.scale.setScalar(modelObj.toolpathConfig.bumpScale);
        const transformedBumpMesh = getTransformedMesh(modelObj.bumpMesh!);

        // Slice the bump models into contours
        const bumpLayers = sliceMeshIntoLayers(transformedBumpMesh, modelObj.toolpathConfig.deltaZ);
        let bumpContours: THREE.Vector3[][] = [];
        for (const { z, segments } of bumpLayers) {
            const regions = extractRegionsFromLayer(z, segments);
            bumpContours.push(...regions.map(region => region.contour));
        }

        bumpContours.sort((a, b) => a[0].z - b[0].z);

        bumpContours = bumpContours.map(contour => fillContour(contour, 0.5));

        // Normalize heights so the bottom is at z = 0
        const firstLayerHeight = bumpContours[0][0].z;
        bumpContours.forEach(contour => contour.forEach(pt => pt.setZ(pt.z - firstLayerHeight)));
        console.log("Num bump contours: " + bumpContours.length);

        const bumpBounds = cloudSliceRegions.map(sliceRegion => getBounds(sliceRegion.contour, sliceRegion.contour[0].z));

        let max = new THREE.Vector3(-Infinity, -Infinity, 0);
        let min = new THREE.Vector3(Infinity, Infinity, 0);

        bumpBounds.forEach(bound => {
            max = new THREE.Vector3(Math.max(max.x, bound.max.x), Math.max(max.y, bound.max.y), 0);
            min = new THREE.Vector3(Math.min(min.x, bound.min.x), Math.min(min.y, bound.min.y), 0);
        });

        // Get all the points to add bumps at by scanning the model.
        const bumpPoints: THREE.Vector3[] = [];

        const remainderY = (max.y - min.y) % modelObj.toolpathConfig.bumpSpacingY;
        const remainderX = (max.x - min.x) % modelObj.toolpathConfig.bumpSpacingX;
        let y = min.y + remainderY / 2;
        while (y < max.y) {
            let x = min.x + remainderX / 2;
            while (x < max.x) {
                const point = new THREE.Vector3(x, y, 0)
                if (cloudSliceRegions.some(region => pointInPolygon(point, region.contour))) {
                    bumpPoints.push(point);
                }
                x += modelObj.toolpathConfig.bumpSpacingX;
            }
            y += modelObj.toolpathConfig.bumpSpacingY;
        }

        // Add the bump contours to every point we want to add a bump at.
        const bumpHeight = (modelObj.toolpathConfig.initialFoamLayerCount + modelObj.initialConfig.initialFoamLayerCount + flatLayerNum) * modelObj.toolpathConfig.deltaZ;
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
                        extruder: 0
                    });
                    return false;
                } else {
                    return true;
                }
            })
        })
    }

    const sliceRegions: SliceRegion[] = bumpRegions;


    // Create a mesh from toolpath top surface AND bump contours for exporting, needs to be edited since the result isnt great
    // and has some non-manifold edges when taking just directly 
    // not complete yet, need to have vertical connection and then  be curved (toolpath part needs to be fixed)
    if (bumpRegions.length > 0 || cloudSliceRegions.length > 0) {
        const bumpGeometry = new THREE.BufferGeometry();
        const bumpVertices: number[] = [];
        const bumpIndices: number[] = [];
        let vertexIndex = 0;

        // First add the toolpath surface
        cloudSliceRegions.forEach(region => {
            if (region.contour.length >= 3) {
                const startIndex = vertexIndex;
                region.contour.forEach(point => {
                    // top surface
                    const topHeight = (modelObj.toolpathConfig.initialFoamLayerCount + modelObj.initialConfig.initialFoamLayerCount - 1) * modelObj.toolpathConfig.deltaZ;
                    bumpVertices.push(point.x, point.y, topHeight);
                    vertexIndex++;
                });

                // Create triangles
                for (let i = 1; i < region.contour.length - 1; i++) {
                    bumpIndices.push(startIndex, startIndex + i, startIndex + i + 1);
                }
            }
        });

        //add each bump
        bumpRegions.forEach(region => {
            if (region.contour.length >= 3) {
                // Add vertices for this contour
                const startIndex = vertexIndex;
                region.contour.forEach(point => {
                    bumpVertices.push(point.x, point.y, point.z);
                    vertexIndex++;
                });

                // Create triangles
                for (let i = 1; i < region.contour.length - 1; i++) {
                    bumpIndices.push(startIndex, startIndex + i, startIndex + i + 1);
                }
            }
        });

        if (bumpVertices.length > 0) {
            bumpGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bumpVertices, 3));
            bumpGeometry.setIndex(bumpIndices);
            bumpGeometry.computeVertexNormals();

            // Create a mesh with basic material
            const bumpMaterial = new THREE.MeshBasicMaterial({
                color: 0x888888,
                side: THREE.DoubleSide,
                wireframe: false
            });
            const bumpMesh = new THREE.Mesh(bumpGeometry, bumpMaterial);

            // Export the combined mesh as an STL
            // still get non manifold edges ugh so should take a look again 
            // maybe new way of takig the gemoetry 
            //exportAsSTL(bumpMesh, `foam_toolpath_with_bumps_${Date.now()}`);

            console.log(`Exported toolpath surface with ${bumpRegions.length} bump regions as STL`);
        }
    }
    

    for (let i = 0; i < modelObj.toolpathConfig.initialFoamLayerCount + modelObj.initialConfig.initialFoamLayerCount + 
                        (modelObj.toolpathConfig.curveAugment ? flatLayerNum : 0); i++) {
        const z = i * modelObj.toolpathConfig.deltaZ;
        sliceRegions.push(...cloudSliceRegions.map(region => {
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
                extruder: region.extruder
            }
        }))
    }


    const regionTree = buildRegionTree(sliceRegions, modelObj.toolpathConfig.deltaZ);
    const chunkTree = buildChunkTree(regionTree, visualizer.printer);
    chunkTree.forEach(chunkNode => {
        chunkNode.modelObj = modelObj;
    });

    let modelHeight = -Infinity  //modelObj.geometry.boundingBox!.min.z;
    regionTree.forEach(region => {
        if (region.region.height > modelHeight) {
            modelHeight = region.region.height;
        }
    });

    transformedMesh.geometry.computeBoundingBox();
    const bbox = transformedMesh.geometry.boundingBox!;

    const firstExtruder = visualizer.printer.extruders[0];
    const startPoint = new THREE.Vector3(0, 0, modelObj.mesh.position.z);
    const toolpath = makeChunkTreePath(
        chunkTree,
        startPoint,
        modelHeight,
        false,
        undefined,
        {
            threadDiameter: firstExtruder.nozzleDiameter * firstExtruder.dieSwelling,
            surface: {
                samplePointMatrix: samplePointMatrixCopy,
                modelMaxZ: bbox.max.z,
            },
        },
        (visualizer.printer.purgeTower ? 0 : undefined),
        (visualizer.printer.purgeTower ? config.deltaZ : undefined)
    );

    // The purge tower is in the same toolpath but is not part of the model, and it can end up taller
    // than the model is, so the passes below that measure the print's height have to leave it out.
    // It is the only thing here printed as regular segments, which is what tells the two apart.
    const modelPoints = toolpath.filter(tp => !tp.regularSegment);

    // comment out from here if no vertical gradient wanted till end mark
    // Apply vertical gradient if no SVG gradient is loaded
    if (!hasValidGradient && hasGradientVariation) {
        // Calculate bounds from the toolpath itself
        const zValues = modelPoints.map(tp => tp.point.z);
        const minZ = Math.min(...zValues);
        const maxZ = Math.max(...zValues);
        console.log("applying vertical gradiet  to model from", modelHeight, "to", maxZ);

        // Apply vertical gradient using the toolpath config
        applyVerticalGradient(modelPoints, minZ, maxZ, modelObj.toolpathConfig);
    }
    // end mark

    // The points were lifted onto the sampled surface back in makeChunkPath, layer by layer.

    //flat layers on top if needed
    const maxZ = Math.max(...modelPoints.map(tp => tp.point.z));


    if (modelObj.toolpathConfig.curveAugment) {
        const additionalFlatLayers = 3;
        const topLayerPoints = modelPoints.filter(tp => Math.abs(tp.point.z - maxZ) < 0.01);

        for (let layer = 1; layer <= additionalFlatLayers; layer++) {
            topLayerPoints.forEach(point => {
                toolpath.push({
                    ...point,
                    point: new THREE.Vector3(
                        point.point.x,
                        point.point.y,
                        maxZ + (layer * modelObj.toolpathConfig.deltaZ)
                    )
                });
            });
        }
    }

    // indicesToRemove.sort((a, b) => b - a);
    // indicesToRemove.forEach(i => toolpath.splice(i, 1));

    // const toolpathZigzagPath: THREE.Vector3[][] = [];

    // if (!visualizer.printer.useFermatSpirals) {
    //     while (currentLayer <= modelObj.toolpathConfig.initialFoamLayerCount) {
    //         const scanDirection = currentLayer % 2 === 1 ? 'x' : 'y'; // Odd layers scan in x, even layers in y
    //         let tempPoints: THREE.Vector3[] = [];
    //         let yDirection = 1;
    //         let xDirection = 1;
    //         let currentX: number | undefined, currentY: number | undefined;

    //         toolpathZigzagPath.push([]); // Add a new layer
    //         console.log("In zig zag path code");

    //         if (scanDirection === 'x') {
    //             // X-direction scan
    //             modelObj.toolpathSamplePoints.sort((a, b) => a.point.x - b.point.x || a.point.y - b.point.y);
    //             currentX = modelObj.toolpathSamplePoints[0].point.x;

    //             modelObj.toolpathSamplePoints.forEach(point => {
    //                 if (point.point.x === currentX) {
    //                     tempPoints.push(
    //                         new THREE.Vector3(
    //                             point.point.x,
    //                             point.point.y,
    //                             point.point.z + zOffset + (currentLayer - 1) * modelObj.toolpathConfig.deltaZ
    //                         )
    //                     );
    //                 } else {
    //                     tempPoints.sort((a, b) => (yDirection > 0 ? a.y - b.y : b.y - a.y));
    //                     toolpathZigzagPath[toolpathZigzagPath.length - 1].push(...tempPoints);
    //                     currentX = point.point.x;
    //                     tempPoints = [
    //                         new THREE.Vector3(
    //                             point.point.x,
    //                             point.point.y,
    //                             point.point.z + zOffset + (currentLayer - 1) * modelObj.toolpathConfig.deltaZ
    //                         )
    //                     ];
    //                     yDirection = -yDirection;
    //                 }
    //             });
    //         } else {
    //             // Y-direction scan
    //             modelObj.toolpathSamplePoints.sort((a, b) => a.point.y - b.point.y || a.point.x - b.point.x);
    //             currentY = modelObj.toolpathSamplePoints[0].point.y;

    //             modelObj.toolpathSamplePoints.forEach(point => {
    //                 if (point.point.y === currentY) {
    //                     tempPoints.push(
    //                         new THREE.Vector3(
    //                             point.point.x,
    //                             point.point.y,
    //                             point.point.z + zOffset + (currentLayer - 1) * modelObj.toolpathConfig.deltaZ
    //                         )
    //                     );
    //                 } else {
    //                     tempPoints.sort((a, b) => (xDirection > 0 ? a.x - b.x : b.x - a.x));
    //                     toolpathZigzagPath[toolpathZigzagPath.length - 1].push(...tempPoints);
    //                     currentY = point.point.y;
    //                     tempPoints = [
    //                         new THREE.Vector3(
    //                             point.point.x,
    //                             point.point.y,
    //                             point.point.z + zOffset + (currentLayer - 1) * modelObj.toolpathConfig.deltaZ
    //                         )
    //                     ];
    //                     xDirection = -xDirection;
    //                 }
    //             });
    //         }
    //         // Add remaining points to the path
    //         if (tempPoints.length > 0) {
    //             tempPoints.sort((a, b) =>
    //                 scanDirection === 'x' ? (yDirection > 0 ? a.y - b.y : b.y - a.y) : (xDirection > 0 ? a.x - b.x : b.x - a.x)
    //             );
    //             toolpathZigzagPath[toolpathZigzagPath.length - 1].push(...tempPoints);
    //         }

    //         currentLayer++;
    //     }
    // }

    // console.log("Generated Zigzag Toolpath:", toolpathZigzagPath);

    // if (!visualizer.printer.useFermatSpirals) {
    //     toolpathZigzagPath.forEach(layer => toolpath.push(... layer));
    // }


    console.log("Checking visualizer.printer.checkCollisions");
    // Only check the first two layer for collisions to reduce time.
    // Does two layers to reduce variance when layer sizes aren't equal.
    const checkLayer = toolpath.slice(0, toolpath.length / (modelObj.toolpathConfig.initialFoamLayerCount 
        + modelObj.initialConfig.initialFoamLayerCount - 1)).map(p => p.point);
    transformedMesh.position.set(modelObj.mesh.position.x, modelObj.mesh.position.y, modelObj.mesh.position.z);
    const requiredZOffsetAdditional = getRequiredZOffset(transformedMesh, checkLayer, visualizer.printer.extruders[0].nozzleLength, visualizer.printer.printHeadDims, 0.02);

    console.log("Print head dims ", visualizer.printer.printHeadDims);

    console.log("Required additional offset: " + requiredZOffsetAdditional);
    const recommendedHStar = visualizer.printer.globalVTPSettings.H_star + requiredZOffsetAdditional / visualizer.printer.extruders[0].nozzleDiameter;
    console.log("Recommended H*: " + recommendedHStar);
    if (requiredZOffsetAdditional > 0) {
        alert("Collision detected! Recommended H* to avoid collision: " + recommendedHStar.toFixed(4));
        console.warn("Collision detected! Recommended H* to avoid collision: " + recommendedHStar.toFixed(4))
    } else {
        console.log("No collisions detected!");
    }

    for (let i = 0; i < samplePointMatrix.length; i++) {
        const column = samplePointMatrix[i];
        for (let j = 0; j < column.length; j++) {
            const point = column[j].point.clone().add(modelObj.mesh.position);
            point.setZ(point.z + 0.001);
            if (!point) {
                continue;
            }
            if (!gradientMatrix[i][j]) {
                continue;
            }
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(point, 3));

            const color = Math.floor(((Math.atan(Math.sqrt(Math.pow(gradientMatrix[i][j].x, 2) + Math.pow(gradientMatrix[i][j].y, 2)))) / (Math.PI / 2)) * 255) / 255;
            const material = new THREE.PointsMaterial({
                color: 0xffffff * color
            });

            const line = new THREE.Points(geometry, material);
            visualizationGroup.add(line);
        }
    }
    
    toolpath.unshift({
        point: new THREE.Vector3(toolpath[0].point.x, toolpath[0].point.y, bbox.max.z + modelObj.mesh.position.z + 10),
        travel: true,
    });

    if (visualizer.printer.generateBoundary) {
        addBoundary(toolpath, transformedMesh, modelObj.mesh.position, visualizer.printer.machine_depth_y, 1, 1, true);
    } else {
        toolpath.unshift({
            point: new THREE.Vector3(0, 0, bbox.max.z + modelObj.mesh.position.z + 10),
            travel: true,
        });
    }

    if (visualizer.printer.purgeLine) {
        addPurgeLine(toolpath, visualizer.printer.machine_depth, 2, 2);
    }

    // --- 4. Decide what to visualize based on the boolean
    const pathToVisualize: PathPoint[] = toolpath;
    let gcodePathToVisualize: THREE.Vector3[] = [];
    if (visualizer.config.showGcodeVisualization && modelObj.gcode) {
        // Parse G-code and visualize actual G-code path
        const gcodePath = parseGcodeToPath(modelObj.gcode!);
        gcodePath.forEach(layer => gcodePathToVisualize.push(...layer));
        console.log("Visualizing G-code path");
    }

    // --- 5. Visualize the chosen path
    if (pathToVisualize.length === 0 && gcodePathToVisualize.length === 0) {
        console.warn("No path to visualize");
        return toolpath
    }

    if (visualizer.config.showGcodeVisualization) {
        let allVertices: number[] = [];
        gcodePathToVisualize.forEach(point => allVertices.push(point.x, point.y, point.z));
        if (allVertices.length > 0) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(allVertices, 3));

            const material = new THREE.LineBasicMaterial({
                color: 0x00ff00,
                linewidth: 2
            });

            const line = new THREE.Line(geometry, material);
            visualizationGroup.add(line);
        }
    } else {
        visualizeToolpath(pathToVisualize, visualizationGroup, visualizer.printer.extruders.map(e => e.color), 0x0000ff);
    }

    // console.log(`Total visualization objects: ${visualizationGroup.children.length}`);

    // Add the visualization to the scene
    // Don't apply model position again since G-code already includes it
    // if (visualizer.config.showGcodeVisualization) {
    //     visualizationGroup.position.set(0, 0, 0);
    // }


    visualizer.scene.add(visualizationGroup);
    modelObj.toolpathVisualizationObject = visualizationGroup;

    return toolpath;
}


/**
 * Immediately exports and downloads a mesh as STL using Three.js built-in exporter
 * @param mesh The mesh to export
 * @param filename Optional filename (defaults to timestamp)
 */
export function exportAsSTL(mesh: THREE.Mesh, filename?: string): void {
    if (!mesh.geometry) {
        console.warn('No geometry to export');
        return;
    }
    // Generate filename with timestamp if not provided
    const name = filename || `mesh_${Date.now()}`;

    try {
        // Create STL exporter
        const exporter = new STLExporter();

        // Export mesh to STL string 
        const stlString = exporter.parse(mesh);

        // Auto-download
        const blob = new Blob([stlString], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}.stl`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log(`✅ STL downloaded: ${name}.stl`);

    } catch (error) {
        console.error('Export failed:', error);
    }
}


/**
 * Parses a gcode and returns the path of the gcode.
 * 
 * @param {string} gcode The gcode to parse.
 * @returns {THREE.Vector3[][]} The toolpath of the gcode, arranged into layers.
 */
function parseGcodeToPath(
    gcode: string
): THREE.Vector3[][] {
    const lines = gcode.split('\n');
    const path: THREE.Vector3[][] = [];
    let currentLayer: THREE.Vector3[] = [];
    let currentPosition = new THREE.Vector3(0, 0, 0);
    let lastZ = -999999; // Track Z changes for layer detection

    console.log("Parsing G-code, total lines:", lines.length);

    for (let i = 0; i < lines.length; i++) {
        const trimmedLine = lines[i].trim();

        // Skip comments and empty lines
        if (!trimmedLine || trimmedLine.startsWith(';')) continue;

        // Check for movement commands (G0, G1) - be more flexible with spacing
        if (trimmedLine.match(/^G[01]\s/)) {
            const newPosition = parseGcodePosition(trimmedLine, currentPosition);

            // Debug first few positions
            if (i < 20) {
                console.log(`Line ${i}: ${trimmedLine} -> Position:`, newPosition);
            }

            // If Z changed significantly (more than 0.05mm), start a new layer
            if (Math.abs(newPosition.z - lastZ) > 0.05) {
                if (currentLayer.length > 0) {
                    console.log(`New layer detected at Z=${newPosition.z}, previous layer had ${currentLayer.length} points`);
                    path.push([...currentLayer]);
                    currentLayer = [];
                }
                lastZ = newPosition.z;
            }

            currentLayer.push(newPosition.clone());
            currentPosition = newPosition;
        }
    }

    // Add the last layer if it has points
    if (currentLayer.length > 0) {
        console.log(`Final layer has ${currentLayer.length} points`);
        path.push(currentLayer);
    }

    console.log(`Parsed G-code into ${path.length} layers with total points:`, path.map(layer => layer.length));

    // If no layers were created, create one layer with all points
    if (path.length === 0 && currentLayer.length === 0) {
        console.warn("No valid G-code movements found, creating single layer");
        // Try to extract any coordinates we can find
        const allPoints: THREE.Vector3[] = [];
        for (const line of lines) {
            if (line.match(/[XYZ]/)) {
                const pos = parseGcodePosition(line, currentPosition);
                if (pos.x !== 0 || pos.y !== 0 || pos.z !== 0) {
                    allPoints.push(pos);
                    currentPosition = pos;
                }
            }
        }
        if (allPoints.length > 0) {
            path.push(allPoints);
        }
    }

    return path;
}

// HELPER FUNCTION: Parse position from G-code line
function parseGcodePosition(line: string, currentPos: THREE.Vector3): THREE.Vector3 {
    const newPos = currentPos.clone();

    // Extract X, Y, Z coordinates - handle different formats and spacing
    const xMatch = line.match(/X\s*([-+]?\d*\.?\d+)/i);
    const yMatch = line.match(/Y\s*([-+]?\d*\.?\d+)/i);
    const zMatch = line.match(/Z\s*([-+]?\d*\.?\d+)/i);

    if (xMatch) {
        newPos.x = parseFloat(xMatch[1]);
    }
    if (yMatch) {
        newPos.y = parseFloat(yMatch[1]);
    }
    if (zMatch) {
        newPos.z = parseFloat(zMatch[1]);
    }

    return newPos;
}