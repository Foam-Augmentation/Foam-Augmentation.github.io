import * as THREE from 'three';
import Visualizer from '../Visualizer';
import { EverydayModel } from '../types/modelTypes';
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
} from '../utils/TreeSlicer';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';

export interface PathPoint {
    point: THREE.Vector3;
    travel: boolean;
    purge?: boolean;
    hStar?: number;
    vStar?: number;
}

/**
     * Private helper function that constructs continuous paths from a filtered set of sample points.
     *
     * The function groups points into rows (based on a y-tolerance), then further splits each row into
     * segments if points are too far apart. It then connects segments from consecutive rows to form continuous paths.
     *
     * @param filteredPoints - An array of sample points with structure { point: THREE.Vector3, type: string }.
     * @returns An array of continuous segments, where each segment is an array of sample points.
     */
function _generatePath(filteredPoints: { point: THREE.Vector3, type: string }[], modelObj: EverydayModel): { point: THREE.Vector3, type: string }[][] {
    const maxConnectDist = modelObj.toolpathConfig.gridSize * 3;  // Maximum distance allowed to connect points in the same row.
    const rowTol = modelObj.toolpathConfig.gridSize * 0.5;        // Tolerance in the y-direction to group points into one row.

    // Sort the sample points by their y coordinate.
    let sortedPoints = filteredPoints.slice().sort((a, b) => a.point.y - b.point.y);
    let rows: { point: THREE.Vector3, type: string }[][] = [];
    let currentRow: { point: THREE.Vector3, type: string }[] = [sortedPoints[0]];
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
    let rowSegments: { points: { point: THREE.Vector3, type: string }[]; connected: boolean }[][] = [];
    rows.forEach((row, rowIndex) => {
        rowSegments[rowIndex] = [];
        row.sort((a, b) => a.point.x - b.point.x);
        let segs: { point: THREE.Vector3, type: string }[][] = [];
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
    const globalSegments: { point: THREE.Vector3, type: string }[][] = [];
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
function _visualizeSegments(globalSegments: { point: THREE.Vector3, type: string }[][], type: 'sensing' | 'regular', zOffset: number): THREE.Object3D | null {
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

    const zOffset = modelObj.toolpathConfig.hStar * (visualizer.printer.nozzleDiameter * visualizer.printer.dieSwelling);

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
        if (modelObj.mesh && modelObj.mesh.position) {
            visualizationGroup.position.copy(modelObj.mesh.position);
        }
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


function foamGradient(
    position: THREE.Vector3,
    bounds: { min: THREE.Vector3, max: THREE.Vector3 }
): number {
    return 1 - (bounds.max.y - position.y) / (bounds.max.y - bounds.min.y)
}


function contourDistToPoint(
    point: THREE.Vector3,
    contour: THREE.Vector3[]
): number {
    let lowestDist = Infinity
    for (const contourPoint of contour) {
        const dist = point.distanceTo(contourPoint);
        if (dist < lowestDist) {
            lowestDist = dist;
        }
    }
    return lowestDist;
}


function printTree(
    root: ChunkNode
): void {
    console.log("Children num: " + root.children.length);
    for (const child of root.children) {
        printTree(child);
    }
}


function fillToolpath(
    toolpath: PathPoint[],
    fillDist: number
): PathPoint[] {
    const newPath: PathPoint[] = [];
    for (let i = 0; i < toolpath.length - 1; i++) {
        const point = toolpath[i];
        const nextPoint = toolpath[i + 1]
        newPath.push(point);
        const dist = point.point.distanceTo(nextPoint.point);

        if (dist > fillDist) {
            for (let i = 1; i < Math.floor(dist / fillDist); i++) {
                newPath.push({ point: pointAlongLine(point.point, nextPoint.point, i * fillDist), travel: point.travel });
            }
        }
    }

    newPath.push(toolpath[toolpath.length - 1])
    return newPath;
}


function generateRectilinearInfill(
    contour: THREE.Vector3[],
    deltaL: number,
    scanX: boolean,
    lastLayerPoint: THREE.Vector3,
): THREE.Vector3[] {
    const toolpath: THREE.Vector3[] = [];
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
            toolpath.push(...intersections);
            console.log("Num Intersections: " + intersections.length);
            continue;
        }

        intersections.sort((a, b) => scanX ? (atTop ? b.y - a.y : a.y - b.y) : (atTop ? b.x - a.x : a.x - b.x));

        toolpath.push(intersections[0]);
        toolpath.push(intersections[intersections.length - 1]);
        atTop = !atTop;
    }

    return toolpath;
}


function makeChunkPath(
    chunk: ChunkNode,
    deltaL: number,
    lastLayerPoint: THREE.Vector3,
    useFermatSpirals: boolean,
    startHStar: number,
    endHStar: number,
    startVStar: number,
    endVStar: number,
    fillDist: number = 0.5,
): PathPoint[] {
    let lastLayerEndPoint = lastLayerPoint;
    let chunkPath: PathPoint[] = [];
    let scanX = false;
    for (const region of chunk.regions) {
        let path: THREE.Vector3[];
        if (useFermatSpirals) {
            const insetContoursRoot = generateInsetContourTree(region.contour, region.holes, deltaL);

            // printTree(insetContoursRoot);
            // console.log("Tree done");

            path = connectIsocontours(insetContoursRoot, deltaL, lastLayerEndPoint);
        } else {
            path = generateRectilinearInfill(region.contour, deltaL, scanX, lastLayerEndPoint);
            scanX = !scanX;
        }

        chunkPath.push(...path.map(point => {
            return {
                point: point,
                travel: false,
            }
        }));

        lastLayerEndPoint = chunkPath[chunkPath.length - 1].point;
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
    })

    chunkPath = fillToolpath(chunkPath, fillDist);

    chunkPath.forEach(point => {
        const percent = foamGradient(point.point, bounds);
        point.hStar = startHStar + percent * (endHStar - startHStar);
        point.vStar = startVStar + percent * (endVStar - startVStar);
    })
    return chunkPath;
}


/**
 * Makes a toolpath that minimizes travel movements given a tree of printable chunk regions.
 * 
 * @param {ChunkNode[]} roots The root nodes of the chunk tree.
 * @param {number} deltaL How far apart the infill should be.
 * @param {number} nozzleHeight The printer's nozzle height.
 * @param {boolean} useFermatSpirals Whether it should make infill with fermat spirals. If false will use a rectilinear path.
 * @param {THREE.Vector3} lastLayerPoint It will try to start the print as close to this point as possible.
 *                                       It's mostly here for recursive calls and defaults to (0, 0, 0).
 * @returns {THREE.Vector3[]} The toolpath that minimizes travel movements as a list of points.
 */
function makeChunkTreePath(
    roots: ChunkNode[],
    deltaL: number,
    nozzleHeight: number,
    useFermatSpirals: boolean,
    startHStar: number,
    endHStar: number,
    startVStar: number,
    endVStar: number,
    lastLayerPoint: THREE.Vector3 = new THREE.Vector3,
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

    // for now it just prints the closest one. In the future can make hamiltonian path to find the most efficient path.
    let printIndex = 0;
    let lowestDist = Infinity;
    for (const i of printableChunkIndices) {
        const dist = contourDistToPoint(lastLayerPoint, roots[i].regions[0].contour);
        if (dist < lowestDist) {
            lowestDist = dist;
            printIndex = i;
        }
    }
    const chunkPath = makeChunkPath(roots[printIndex], deltaL, lastLayerPoint, useFermatSpirals, startHStar, endHStar, startVStar, endVStar);

    // avoid collissions by only moving to the x and y first, then the z.
    const toolpath: PathPoint[] = chunkPath.length === 0 ? [] : [{
        point: new THREE.Vector3(chunkPath[0].point.x, chunkPath[0].point.y, lastLayerPoint.z),
        travel: true,
        hStar: chunkPath[0].hStar,
        vStar: chunkPath[0].vStar,
    }];

    roots.splice(printIndex, 1, ...roots[printIndex].children);

    let restOfPath: PathPoint[] = [];
    if (roots.length) {
        restOfPath = makeChunkTreePath(roots, deltaL, nozzleHeight, useFermatSpirals, startHStar, endHStar, startVStar, endVStar, chunkPath.length === 0 ? lastLayerPoint : chunkPath[chunkPath.length - 1].point);
    }

    // add the path in a for loop to avoid maximum call stack error for super long paths
    for (const point of chunkPath) {
        toolpath.push(point);
    }
    for (const point of restOfPath) {
        toolpath.push(point);
    }

    return toolpath
}


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
        console.log("Visualizing Chunk");
        console.log("Chunk path length");
        console.log("Num vertices: " + vertices.length);
        visualizeChunks(root.children, colorArray, currentColorIndex, visualizationGroup);
    }
}


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


function getRequiredZOffset(
    mesh: THREE.Mesh,
    toolpath: THREE.Vector3[],
    nozzleLength: number,
    printHeadBox: { min: THREE.Vector2, max: THREE.Vector2 },
    offsetStep: number = 0.1,
    // samplePointMatrix: THREE.Vector3[][],
    // gradientMatrix: THREE.Vector2[][]
): number {
    let maxHeight = 0;

    mesh.geometry.computeBoundingBox();
    const stepMax = mesh.geometry.boundingBox!.max.z - mesh.geometry.boundingBox!.min.z - nozzleLength;

    for (const point of toolpath) {
        let zOffset = maxHeight;
        while (zOffset < stepMax) {
            const squareMin = new THREE.Vector3(point.x + printHeadBox.min.x, point.y + printHeadBox.min.y, point.z + nozzleLength + zOffset);
            const squareMax = new THREE.Vector3(point.x + printHeadBox.max.x, point.y + printHeadBox.max.y, point.z + nozzleLength + zOffset);
            squareMin.add(mesh.position);
            squareMax.add(mesh.position);
            if (meshIntersectsSquareAtZ(mesh, squareMin, squareMax)) {
                zOffset += offsetStep;
            } else {
                if (zOffset > maxHeight) maxHeight = zOffset;
                break;
            }
        }

        if (maxHeight >= stepMax) {
            break;
        }
        // const squareMin = new THREE.Vector3(point.x + printHeadBox.min.x, point.y + printHeadBox.min.y, point.z + nozzleLength);
        // const squareMax = new THREE.Vector3(point.x + printHeadBox.max.x, point.y + printHeadBox.max.y, point.z + nozzleLength);
        // squareMin.add(mesh.position);
        // squareMax.add(mesh.position);
        // if (meshIntersectsSquareAtZ(mesh, squareMin, squareMax)) {
        //     const gradients = getMaxGradients(samplePointMatrix, gradientMatrix, squareMin.clone().sub(mesh.position), squareMax.clone().sub(mesh.position));
        //     const possibleHeights = [
        //         Math.abs(gradients.maxGradient.x * printHeadBox.max.x), 
        //         Math.abs(gradients.maxGradient.y * printHeadBox.max.y), 
        //         Math.abs(gradients.minGradient.x * printHeadBox.min.x),
        //         Math.abs(gradients.minGradient.y * printHeadBox.min.y)
        //     ];

        //     for (const height of possibleHeights) {
        //         if (height > maxHeight) {
        //             maxHeight = height;
        //         }
        //     }
        // }
    }

    return maxHeight; //- nozzleLength;
}


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

            if (closestDist > 2 && i > 0 && i < pointMatrix.length - 1) {
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
 * Generates foam toolpaths based on region-based slicing and zigzag infill.
 *
 * Requires modelObj to have either:
 *   - a getAllRegions(mesh, deltaZ) method that returns SliceRegion[], or
 *   - a regions: SliceRegion[] property (populated externally)
 *
 * @param visualizer - The Visualizer instance
 * @param modelObj - The model object (must have regions or getAllRegions)
 * @param zOffset - Z offset for the first layer
 * @param deltaZ - Layer height
 * @param layerNum - Number of layers (not used in region-based mode)
 * @returns Toolpaths for all, foam, and sense (currently only all/foam)
 */
export function generateFoamToolpath(
    visualizer: Visualizer,
    modelObj: EverydayModel & { regions?: SliceRegion[] },
    // zOffset: number = visualizer.config.zOffset,
    // deltaZ: number = visualizer.config.deltaZ,
    // layerNum: number = visualizer.config.foamLayers
): { all: PathPoint[]; foam: PathPoint[]; sense: PathPoint[] } {
    modelObj.geometry.scale(modelObj.mesh.scale.x, modelObj.mesh.scale.y, modelObj.mesh.scale.z);
    modelObj.mesh.scale.setScalar(1);
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
    const layers = sliceMeshIntoLayers(modelObj.mesh, modelObj.toolpathConfig.deltaZ);
    console.log('Sliced layers:', layers.length, layers);
    let allRegions: SliceRegion[] = [];
    for (const { z, segments } of layers) {
        const regions = extractRegionsFromLayer(z, segments);
        allRegions.push(...regions);
    }
    console.log('Extracted regions:', allRegions.length, allRegions.slice(0, 5));

    // Debug: Log contours for each region
    allRegions.forEach((region, idx) => {
        console.log(`Region ${idx} at Z=${region.height}:`, region.contour.length, 'points');
        if (region.contour.length > 0) {
            console.log('  First point:', region.contour[0]);
            console.log('  Last point:', region.contour[region.contour.length - 1]);
        }
    });

    // --- 2. Chunk regions by overlap/support ---
    // const regionGroups = splitRegionsByOverlapOrSupport(allRegions);
    // --- 3. Build dependency tree and print order ---
    console.log("Zoffset: " + visualizer.printer.ZOffset);
    const regionTree = buildRegionTree(allRegions, modelObj.toolpathConfig.deltaZ);
    const chunkTree = buildChunkTree(regionTree, visualizer.printer.nozzleLength + visualizer.printer.ZOffset);

    const visualizationGroup = new THREE.Group();

    // const colors: number[] = [0xff0000, 0x00ff00, 0x0000ff, 0x00aaaa];
    // visualizeChunks(chunkTree, colors, 0, visualizationGroup);

    visualizationGroup.position.copy(modelObj.mesh.position);
    visualizer.scene.add(visualizationGroup);

    // const chunks = buildChunksWithDependencies(regionGroups, regionTree);
    // const orderedChunks = topologicalSortChunks(chunks);
    // --- 4. For each chunk, for each region, generate zigzag toolpath ---
    // const toolpaths: THREE.Vector3[][] = [];
    // console.log(orderedChunks.length);
    // if (chunkTree[0]) {
    //     printTree(chunkTree[0]);
    // }

    const startPoint = new THREE.Vector3(0, 0, regionTree[0].region.height);
    const toolpath = makeChunkTreePath(chunkTree, modelObj.toolpathConfig.gridSize, visualizer.printer.nozzleLength + visualizer.printer.ZOffset,
        visualizer.printer.useFermatSpirals, modelObj.toolpathConfig.hStar, modelObj.toolpathConfig.hStarEnd,
        modelObj.toolpathConfig.vStar, modelObj.toolpathConfig.vStarEnd, startPoint);

    toolpath.forEach(point => point.point.setZ(point.point.z + point.hStar! * (visualizer.printer.nozzleDiameter * visualizer.printer.dieSwelling)));
    console.log("Created toolpath");

    // for (const chunk of orderedChunks) {
    //     // flip the y direction every layer to minimize travel time between layers
    //     // let flipY = false;

    //     let lastLayerEndPoint = new THREE.Vector3(100, 200, 0);
    //     for (const region of chunk.regions) {
    //         if (!region.contour || region.contour.length === 0) continue;
    //         const contours: THREE.Vector3[][] = [];

    //         const holes: THREE.Vector3[][] = [];
    //         // holes.push(baseContours[1]);

    //         contours.push(region.contour);

    //         const twoDimInsetContours = generateInsetContours(region.contour, holes, modelObj.toolpathConfig.gridSize);

    //         twoDimInsetContours.forEach(contour => {
    //             const threeDimContour: THREE.Vector3[] = [];
    //             contour.forEach(point => {
    //                 threeDimContour.push(new THREE.Vector3(point.x, point.y, region.height));
    //             });
    //             contours.push(threeDimContour);
    //         });

    //         const path = connectIsocontours(contours, modelObj.toolpathConfig.gridSize, lastLayerEndPoint);
    //         lastLayerEndPoint = path[path.length - 1];
    //         // const zigzag = generateZigzagInfill(region.contour, region.height, { spacing: modelObj.toolpathConfig.gridSize }, flipY);
    //         toolpaths.push(path);
    //         // toolpaths.push(zigzag);
    //         // flipY = !flipY;
    //         // break;
    //     }
    // }
    // --- 5. Visualize toolpaths ---
    // for (const path of toolpaths) {
    //     if (path.length < 2) continue;
    //     const vertices: number[] = [];
    //     for (const pt of path) {
    //         vertices.push(pt.x, pt.y, pt.z);
    //     }
    //     const geometry = new THREE.BufferGeometry();
    //     geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    //     const material = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2, opacity: 0.8, transparent: true });
    //     const line = new THREE.Line(geometry, material);
    //     visualizationGroup.add(line);
    // }

    if (toolpath.length >= 2) {
        const vertices: number[] = [];
        for (const pt of toolpath) {
            vertices.push(pt.point.x, pt.point.y, pt.point.z);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        const material = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2, opacity: 0.8, transparent: true });
        const line = new THREE.Line(geometry, material);
        visualizationGroup.add(line);
    }

    // visualize contours
    // for (const region of allRegions) {
    //     const path = region.contour;
    //     if (path.length < 2) continue;
    //     const vertices: number[] = [];
    //     for (const pt of path) {
    //         vertices.push(pt.x, pt.y, pt.z);
    //     }
    //     const geometry = new THREE.BufferGeometry();
    //     geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    //     const material = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2, opacity: 0.8, transparent: true });
    //     const line = new THREE.Line(geometry, material);
    //     visualizationGroup.add(line);
    // }

    // const contours: THREE.Vector3[][] = [];

    // const baseContours = generateBoundaryContours(modelObj.mesh, 0);

    // const holes: THREE.Vector3[][] = [];
    // // holes.push(baseContours[1]);

    // contours.push(...baseContours);

    // const twoDimInsetContours = generateInsetContours(baseContours[0], holes, 3);

    // twoDimInsetContours.forEach(contour => {
    //     const threeDimContour: THREE.Vector3[] = [];
    //     contour.forEach(point => {
    //         threeDimContour.push(new THREE.Vector3(point.x, point.y, 0.01));
    //     });
    //     contours.push(threeDimContour);
    // });

    // const path = connectIsocontours(contours, 3, new THREE.Vector3);

    // const vertices: number[] = [];
    // for (const pt of path) {
    //     vertices.push(pt.x, pt.y, pt.z);
    // }
    // const geometry = new THREE.BufferGeometry();
    // geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    // const material = new THREE.PointsMaterial({ color: 0x0000ff, opacity: 0.8, transparent: true });
    // const line = new THREE.Line(geometry, material);
    // visualizationGroup.add(line);


    // for (const contour of contours) {
    //     const path = contour;
    //     if (path.length < 2) continue;
    //     const vertices: number[] = [];
    //     for (const pt of path) {
    //         vertices.push(pt.x, pt.y, pt.z);
    //     }
    //     const geometry = new THREE.BufferGeometry();
    //     geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    //     const material = new THREE.PointsMaterial({ color: 0x00ff00, opacity: 0.8, transparent: true });
    //     const line = new THREE.Points(geometry, material);
    //     visualizationGroup.add(line);
    // }


    visualizationGroup.position.copy(modelObj.mesh.position);
    visualizer.scene.add(visualizationGroup);
    modelObj.toolpathVisualizationObject = visualizationGroup;
    return {
        all: toolpath,
        foam: toolpath,
        sense: []
    };
}


function lowerBoundXs(matrix: THREE.Vector3[][], tx: number): number {
    let lo = 0, hi = matrix.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (matrix[mid][0].x < tx) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function lowerBoundYs(row: THREE.Vector3[], ty: number): number {
    let lo = 0, hi = row.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (row[mid].y < ty) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function squaredXYDist(a: THREE.Vector3, b: THREE.Vector3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}


export function generateTrialToolpath(
    deltaL: number,
    position: THREE.Vector3,
    lineLength: number,
    numLines: number,
    purgeDistance: number,
    startHStar: number,
    endHStar: number,
    startVStar: number,
    endVStar: number,
): PathPoint[] {
    // const squareContour = [
    //     position.clone().add(new THREE.Vector3(-size, -size, 0)),
    //     position.clone().add(new THREE.Vector3(size, -size, 0)),
    //     position.clone().add(new THREE.Vector3(size, size, 0)),
    //     position.clone().add(new THREE.Vector3(-size, size, 0))
    // ]

    // const toolpath = [{point: position.clone().add(new THREE.Vector3(-2 * size, -size, 0)), travel: false}];
    // toolpath.push(...fillToolpath(generateRectilinearInfill(squareContour, deltaL, false, new THREE.Vector3).map(p => {
    //     return {
    //         point: p,
    //         travel: false
    //     };
    // }), 0.1));
    // return toolpath;

    const toolpath: PathPoint[] = [];

    let lineStartHStar = startHStar;
    let lineStartVStar = startVStar;

    for (let i = 0; i < numLines; i++) {
        const y = i * deltaL - (numLines * deltaL) / 2;

        // Purge at the start
        toolpath.push({
            point: new THREE.Vector3((-lineLength / 2) - purgeDistance, y, 0),
            travel: true,
            purge: false,
            hStar: lineStartHStar,
            vStar: lineStartVStar,
        })

        const lineEndHStar = lineStartHStar + 2 * (endHStar - startHStar) / (numLines)
        const lineEndVStar = lineStartVStar + 2 * (endVStar - startVStar) / (numLines)

        let x = -lineLength / 2;
        while (x < lineLength / 2) {
            toolpath.push({
                point: new THREE.Vector3(x, y, 0),
                travel: false,
                purge: false,
                hStar: lineStartHStar + x * ((lineEndHStar - lineStartHStar) / lineLength),
                vStar: lineStartVStar + x * ((lineEndVStar - lineStartVStar) / lineLength),
            })
            x += 0.1;
        }

        toolpath.push({
            point: new THREE.Vector3(lineLength / 2, y, 0),
            travel: false,
            purge: false,
            hStar: lineEndHStar,
            vStar: lineEndVStar,
        })

        // Purge at end
        toolpath.push({
            point: new THREE.Vector3((lineLength / 2) + purgeDistance, y, 0),
            travel: false,
            purge: true,
            hStar: lineEndHStar,
            vStar: lineEndVStar,
        })

        toolpath.push({
            point: new THREE.Vector3((lineLength / 2) + purgeDistance * 1.5, y, 0),
            travel: false,
            purge: true,
            hStar: lineEndHStar,
            vStar: lineEndVStar,
        })

        lineStartHStar = lineStartHStar + (endHStar - startHStar) / (numLines);
        lineStartVStar = lineStartVStar + (endVStar - startVStar) / (numLines);
    }

    toolpath.forEach(pt => pt.point.add(position));

    return toolpath;
}


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

    if (nz === 0) {
        return NaN;
    }

    return -(nx * x + ny * y + d) / nz;
}


/**
 * Generates foam toolpaths designed to augment EverydayModels based on the model's sampled points.
 *
 * This function performs the following steps:
 * 1. Removes any previous foam toolpath visualization from the scene and disposes its resources.
 * 2. Checks if sample points exist; if none, logs a warning and returns.
 * 3. Defines offset values for different toolpath types.
 * 4. Constructs continuous paths from the sample points using a grid-based method.
 *    (This is done via the private helper function generatePath.)
 * 5. Visualizes the generated segments by converting them into THREE.Line or THREE.Group objects,
 *    applying a given z offset. (This is done via the private helper function visualizeSegments.)
 * 6. Adds the resulting visualization to the scene and stores it in modelObj.foamToolpathLine.
 * 7. Returns an object containing the generated toolpath segments for all, foam, and sense.
 *
 * @param visualizer - The Visualizer instance, providing access to the scene and sampleStep.
 * @param modelObj - The model object, which must include:
 *                   - toolpathSamplePoints: Array<{ point: THREE.Vector3, type: string }>
 *                   - mesh: THREE.Mesh (for positioning)
 *                   - foamToolpathLine: (optional) previous toolpath visualization.
 * @returns An object with properties 'all', 'foam', and 'sense' containing the generated segments.
 */
export function generateAugmentFoamToolpath(
    visualizer: Visualizer,
    modelObj: EverydayModel,
    // zOffset: number = visualizer.config.zOffset,
    // deltaZ: number = visualizer.config.deltaZ,
    // layerNum: number = visualizer.config.foamLayers
): { all: any; foam: any; sense: any } {
    // --- 1. Remove the previous foam toolpath visualization, if it exists.
    if (modelObj.toolpathVisualizationObject) {
        visualizer.scene.remove(modelObj.toolpathVisualizationObject);
        modelObj.toolpathVisualizationObject.traverse((child: any) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }

    visualizer.printer.updateParameters(modelObj.toolpathConfig);

    // --- 2. Check if there are sample points available.
    if (!modelObj.toolpathSamplePoints || modelObj.toolpathSamplePoints.length === 0) {
        console.warn("No sample points available. Cannot generate toolpath.");
        return { all: null, foam: null, sense: null };
    }

    // --- 3. Generate Zigzag Path
    // const toolpathZigzagPath: THREE.Vector3[][] = [];
    // let currentLayer = 1;


    // Arrange sample points into a matrix (Used later for elevating toolpath)
    // modelObj.toolpathSamplePoints.sort((a, b) => a.point.x - b.point.x);

    // let maxPoints: THREE.Vector3[] = [];
    // let minPoints: THREE.Vector3[] = [];
    // for (const column of samplePointMatrix) {
    //     maxPoints.push(column[column.length - 1]);
    //     minPoints.push(column[0]);
    // }

    // const samplePointsContour: THREE.Vector3[] = [];

    // samplePointsContour.push(...maxPoints);
    // samplePointsContour.push(...minPoints.reverse());


    const visualizationGroup = new THREE.Group();

    // const vertices: number[] = [];

    // samplePointsContour.forEach(p => vertices.push(p.x, p.y, p.z));

    // const geometry = new THREE.BufferGeometry();
    // geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

    // const material = new THREE.LineBasicMaterial({ 
    //     color: 0x0000ff,
    //     linewidth: 2
    // });

    // const line = new THREE.Line(geometry, material);
    // visualizationGroup.add(line);

    // for (const region of sliceRegions) {
    //     const vertices: number[] = [];
    //     region.contour.forEach(p => vertices.push(p.x, p.y, p.z));
    //     const geometry = new THREE.BufferGeometry();
    //     geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    //     const line = new THREE.Line(geometry, material);
    //     visualizationGroup.add(line);

    //     for (const hole of region.holes) {
    //         const vertices: number[] = [];
    //         hole.forEach(p => vertices.push(p.x, p.y, p.z));
    //         const geometry = new THREE.BufferGeometry();
    //         geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    //         const line = new THREE.Line(geometry, material);
    //         visualizationGroup.add(line);
    //     }
    // }

    const samplePointMatrix: THREE.Vector3[][] = [[]];
    let lastX = modelObj.toolpathSamplePoints[0].point.x;
    for (const point of modelObj.toolpathSamplePoints) {
        if (Math.abs(point.point.x - lastX) <= 0.0001) {
            samplePointMatrix[samplePointMatrix.length - 1].push(point.point);
        } else {
            samplePointMatrix.push([point.point]);
            lastX = point.point.x;
        }
    }
    for (const column of samplePointMatrix) {
        column.sort((a, b) => a.y - b.y)
    }


    console.log("Started gradient");
    const gradientMatrix = makeGradientMatrix(samplePointMatrix);
    const indicesToRemove: { col: number, row: number }[] = [];

    const gradientThresholdDegrees = 75;
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

    console.log("Finished Gradient");

    const samplePoints: THREE.Vector3[] = [];
    samplePointMatrix.forEach(col => samplePoints.push(...col));

    console.log("Bump Mesh: " + modelObj.bumpMesh);
    // const bumpContours: THREE.Vector3[][] = [[
    //     new THREE.Vector3(-4, -4, 0),
    //     new THREE.Vector3(-4, 4, 0),
    //     new THREE.Vector3(4, 4, 0),
    //     new THREE.Vector3(4, -4, 0),
    // ],
    // [
    //     new THREE.Vector3(-3, -3, modelObj.toolpathConfig.deltaZ), 
    //     new THREE.Vector3(-3, 3, modelObj.toolpathConfig.deltaZ),
    //     new THREE.Vector3(3, 3, modelObj.toolpathConfig.deltaZ),
    //     new THREE.Vector3(3, -3, modelObj.toolpathConfig.deltaZ),
    // ],
    // [
    //     new THREE.Vector3(-2, -2, modelObj.toolpathConfig.deltaZ * 2), 
    //     new THREE.Vector3(-2, 2, modelObj.toolpathConfig.deltaZ * 2),
    //     new THREE.Vector3(2, 2, modelObj.toolpathConfig.deltaZ * 2),
    //     new THREE.Vector3(2, -2, modelObj.toolpathConfig.deltaZ * 2),
    // ]
    // ]

    modelObj.bumpMesh!.geometry.scale(modelObj.toolpathConfig.bumpScale, modelObj.toolpathConfig.bumpScale, modelObj.toolpathConfig.bumpScale);

    const bumpLayers = sliceMeshIntoLayers(modelObj.bumpMesh!, modelObj.toolpathConfig.deltaZ);
    let bumpContours: THREE.Vector3[][] = [];
    for (const { z, segments } of bumpLayers) {
        const regions = extractRegionsFromLayer(z, segments);
        bumpContours.push(...regions.map(region => region.contour));
    }

    bumpContours.sort((a, b) => a[0].z - b[0].z);
    // Normalize heights so the bottom is at z = 0
    const firstLayerHeight = bumpContours[0][0].z;
    bumpContours.forEach(contour => contour.forEach(pt => pt.setZ(pt.z - firstLayerHeight)));
    console.log("Num bump contours: " + bumpContours.length);

    const cloudSliceRegions: SliceRegion[] = extractRegionsFromPointCloud(samplePoints, 5);

    const bumpBounds = cloudSliceRegions.map(sliceRegion => getBounds(sliceRegion.contour, sliceRegion.contour[0].z));

    let max = new THREE.Vector3(-Infinity, -Infinity, 0);
    let min = new THREE.Vector3(Infinity, Infinity, 0);

    bumpBounds.forEach(bound => {
        max = new THREE.Vector3(Math.max(max.x, bound.max.x), Math.max(max.y, bound.max.y), 0);
        min = new THREE.Vector3(Math.min(min.x, bound.min.x), Math.min(min.y, bound.min.y), 0);
    });

    const bumpPoints: THREE.Vector3[] = [];

    const remainderY = (max.y - min.y) % modelObj.toolpathConfig.bumpSpacing;
    const remainderX = (max.x - min.x) % modelObj.toolpathConfig.bumpSpacing;
    let y = min.y + remainderY / 2;
    while (y < max.y) {
        let x = min.x + remainderX / 2;
        while (x < max.x) {
            const point = new THREE.Vector3(x, y, 0)
            if (cloudSliceRegions.some(region => pointInPolygon(point, region.contour))) {
                bumpPoints.push(point);
            }
            x += modelObj.toolpathConfig.bumpSpacing;
        }
        y += modelObj.toolpathConfig.bumpSpacing;
    }

    const bumpRegions: SliceRegion[] = []
    const bumpHeight = modelObj.toolpathConfig.initialFoamLayerCount * modelObj.toolpathConfig.deltaZ;
    bumpPoints.forEach(p => {
        // Use .some so we can break by returning true
        bumpContours.some(contour => {
            const bumpContour = contour.map(contourPt => contourPt.clone().add(new THREE.Vector3(p.x, p.y, bumpHeight))).filter(
                p => cloudSliceRegions.some(region => pointInPolygon(p, region.contour)));
            if (bumpContour.length > 2) {
                bumpRegions.push({
                    id: p.x + ", " + p.y + ", " + bumpContour[0].x + ", " + bumpContour[0].y + ", " + bumpContour[0].z,
                    contour: bumpContour,
                    holes: [],
                    height: bumpContour[0].z,
                    bounds: getBounds(bumpContour, bumpContour[0].z),
                });
                return false;
            } else {
                return true;
            }
        })
    })


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
                    const topHeight = (modelObj.toolpathConfig.initialFoamLayerCount - 1) * modelObj.toolpathConfig.deltaZ;
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
    



    //

    for (let i = 0; i < modelObj.toolpathConfig.initialFoamLayerCount; i++) {
        const z = i * modelObj.toolpathConfig.deltaZ;
        sliceRegions.push(...cloudSliceRegions.map(region => {
            return {
                id: region.id + ", " + z,
                contour: region.contour.map(p => new THREE.Vector3(p.x, p.y, z)),
                holes: region.holes.map(hole => hole.map(p => new THREE.Vector3(p.x, p.y, z))),
                height: z,
                bounds: region.bounds,
            }
        }))
    }

    const regionTree = buildRegionTree(sliceRegions, modelObj.toolpathConfig.deltaZ);
    // printTree(regionTree[0]);
    const chunkTree = buildChunkTree(regionTree, visualizer.printer.nozzleLength + visualizer.printer.ZOffset);
    // printTree(chunkTree[0]);

    const startPoint = new THREE.Vector3(0, 0, regionTree[0].region.height);
    const toolpath = makeChunkTreePath(chunkTree, modelObj.toolpathConfig.gridSize, visualizer.printer.nozzleLength + visualizer.printer.ZOffset,
        visualizer.printer.useFermatSpirals, visualizer.printer.H_star, visualizer.printer.hStarEnd,
        visualizer.printer.V_Star, visualizer.printer.vStarEnd, startPoint);


    // let indicesToRemove: number[] = [];
    for (let i = 0; i < toolpath.length; i++) {
        const point = toolpath[i].point;
        const nearestPoints = findNearestPoints(samplePointMatrix, point, 3);

        const pointZOffset = toolpath[i].hStar! * (visualizer.printer.nozzleDiameter * visualizer.printer.dieSwelling);

        if (nearestPoints.length >= 3) {
            let addZ = getPlaneHeightAtXY(nearestPoints[0], nearestPoints[1], nearestPoints[2], point.x, point.y);
            if (!addZ) {
                addZ = nearestPoints[0].z;
                // indicesToRemove.push(i);
            }
            point.setZ(point.z + addZ + pointZOffset);
        } else if (nearestPoints.length >= 1) {
            point.setZ(point.z + nearestPoints[0].z + pointZOffset);
            // indicesToRemove.push(i);
        } else {
            console.warn("Not able to find any points");
            // indicesToRemove.push(i);
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

    console.log("Gradient Matrix Length: " + gradientMatrix.length);
    console.log("Point matrix length: " + samplePointMatrix.length);


    for (let i = 0; i < samplePointMatrix.length; i++) {
        const column = samplePointMatrix[i];
        for (let j = 0; j < column.length; j++) {
            const point = column[j];
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(point, 3));

            const color = Math.floor(((Math.atan(Math.sqrt(Math.pow(gradientMatrix[i][j].x, 2) + Math.pow(gradientMatrix[i][j].y, 2)))) / (Math.PI / 2)) * 255) / 255;
            // console.log("AngleX: " + angleX + ", AngleY: " + angleY);
            const material = new THREE.PointsMaterial({
                color: 0xffffff * color, //+ 0x0000ff * ((angleY + 90) / 180),
            });

            const line = new THREE.Points(geometry, material);
            visualizationGroup.add(line);
        }
    }

    // --- 4. Decide what to visualize based on the boolean
    let pathToVisualize: THREE.Vector3[] = [];
    if (visualizer.config.showGcodeVisualization && visualizer.printer.toolpathGcode) {
        // Parse G-code and visualize actual G-code path
        const gcodePath = parseGcodeToPath(visualizer.printer.toolpathGcode);
        gcodePath.forEach(layer => pathToVisualize.push(...layer));
        console.log("Visualizing G-code path");
    } else {
        // Visualize the intended zigzag path
        pathToVisualize = toolpath.map(pt => pt.point);
        console.log("Visualizing intended toolpath");
    }

    // --- 5. Visualize the chosen path
    // const visualizationGroup = new THREE.Group();

    if (pathToVisualize.length === 0) {
        console.warn("No path to visualize");
        return {
            all: toolpath,
            foam: toolpath,
            sense: []
        };
    }

    if (visualizer.config.showGcodeVisualization) {
        // For G-code: Create one continuous line connecting all points across all layers
        const allVertices: number[] = [];
        pathToVisualize.forEach(point => allVertices.push(point.x, point.y, point.z));

        if (allVertices.length > 0) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(allVertices, 3));

            const material = new THREE.LineBasicMaterial({
                color: 0x00ff00,
                linewidth: 2
            });

            const line = new THREE.Line(geometry, material);
            visualizationGroup.add(line);
            console.log(`Added G-code visualization with ${allVertices.length / 3} total points`);
        }
    } else {
        const allVertices: number[] = [];
        pathToVisualize.forEach(point => allVertices.push(point.x, point.y, point.z));

        if (allVertices.length > 0) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(allVertices, 3));

            const material = new THREE.LineBasicMaterial({
                color: 0x00ff00,
                linewidth: 2
            });

            const line = new THREE.Line(geometry, material);
            visualizationGroup.add(line);
            console.log(`Added G-code visualization with ${allVertices.length / 3} total points`);
        }
        // For intended toolpath: Create separate lines for each layer (original behavior)
        // pathToVisualize.forEach((layer, layerIndex) => {
        //     if (layer.length === 0) return;

        //     const vertices: number[] = [];
        //     layer.forEach(point => {
        //         vertices.push(point.x, point.y, point.z);
        //     });

        //     if (vertices.length === 0) return;

        //     const geometry = new THREE.BufferGeometry();
        //     geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

        //     const material = new THREE.LineBasicMaterial({ 
        //         color: 0x0075ff,
        //         linewidth: 2
        //     });

        //     const line = new THREE.Line(geometry, material);
        //     visualizationGroup.add(line);
        //     console.log(`Added intended toolpath layer ${layerIndex} with ${layer.length} points`);
        // });
    }

    if (visualizer.printer.checkCollisions) {
        const requiredZOffsetAdditional = getRequiredZOffset(modelObj.mesh, toolpath.map(p => p.point), visualizer.printer.nozzleLength, visualizer.printer.printHeadDims);
        console.log("Required Height: " + requiredZOffsetAdditional);
        if (requiredZOffsetAdditional > 0) {
            const recommendedHStar = visualizer.printer.H_star + requiredZOffsetAdditional / visualizer.printer.nozzleDiameter;
            console.warn("Collision detected! Recommended H* to avoid collision: " + recommendedHStar.toFixed(4));
        }
    }

    console.log(`Total visualization objects: ${visualizationGroup.children.length}`);

    // Add the visualization to the scene
    // Don't apply model position again since G-code already includes it
    if (visualizer.config.showGcodeVisualization) {
        // G-code coordinates are already in world space, don't add model position
        visualizationGroup.position.set(0, 0, 0);
    } else {
        // Intended toolpath needs model position applied
        visualizationGroup.position.copy(modelObj.mesh.position);
    }

    visualizer.scene.add(visualizationGroup);
    modelObj.toolpathVisualizationObject = visualizationGroup;

    return {
        all: toolpath,
        foam: toolpath,
        sense: []
    };
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




// NEW FUNCTION: Parse G-code to extract path points
function parseGcodeToPath(gcode: string): THREE.Vector3[][] {
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