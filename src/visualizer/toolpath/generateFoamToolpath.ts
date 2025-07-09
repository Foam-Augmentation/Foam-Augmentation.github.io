import * as THREE from 'three';
import Visualizer from '../Visualizer';
import { EverydayModel } from '../types/modelTypes';
import { sampleSelectedMesh } from './sampleSelectedMesh';
import {
  sliceMeshIntoLayers,
  extractRegionsFromLayer,
  splitRegionsByOverlapOrSupport,
  buildRegionTree,
  buildChunksWithDependencies,
  topologicalSortChunks,
  SliceRegion
} from '../utils/TreeSlicer';

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
 * visualize and organize all layers of segments (based on toolpathConfig.deltaZ, toolpathConfig.zOffset, and sandwiched strcuture layer counts), call visualzieSegments for each layer
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

    let visualizationGroup: THREE.Group | undefined;
    if (modelObj.toolpathSamplePoints && modelObj.toolpathSamplePoints.every((item: any) => item.type === 'foam')) {
        if (modelObj.regular_area_segments) {
            // visualizationGroup = visualizeSegments(modelObj.regular_area_segments, 0x00ff00, 20) as THREE.Group;
            let layerCount = 0;
            visualizationGroup = new THREE.Group() as THREE.Group;
            for (let i = 0; i < modelObj.toolpathConfig.initialFoamLayerCount; i++) {
                const toolpathFoam = _visualizeSegments(modelObj.regular_area_segments, 'regular', modelObj.toolpathConfig.zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                if (toolpathFoam) visualizationGroup.add(toolpathFoam);
                layerCount++;
                console.log(`Layer ${layerCount}: Adding toolpath at zOffset = ${modelObj.toolpathConfig.zOffset + layerCount * modelObj.toolpathConfig.deltaZ}`);

            }
        }
    } else {
        if (modelObj.all_area_segments && modelObj.regular_area_segments && modelObj.sense_area_segments) {
            let layerCount = 0;
            visualizationGroup = new THREE.Group() as THREE.Group;
            for (let i = 0; i < modelObj.toolpathConfig.initialFoamLayerCount; i++) {
                const toolpathAll = _visualizeSegments(modelObj.all_area_segments, 'regular', modelObj.toolpathConfig.zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                if (toolpathAll) visualizationGroup.add(toolpathAll);
                layerCount++;
                console.log(`Layer ${layerCount}: Adding toolpath at zOffset = ${modelObj.toolpathConfig.zOffset + layerCount * modelObj.toolpathConfig.deltaZ}`);

            }
            for (let i = 0; i < modelObj.toolpathConfig.middleSenseLayerCount; i++) {
                const toolpathSense = _visualizeSegments(modelObj.sense_area_segments, 'sensing', modelObj.toolpathConfig.zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                const toolpathFoam = _visualizeSegments(modelObj.regular_area_segments, 'regular', modelObj.toolpathConfig.zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                if (toolpathSense) visualizationGroup.add(toolpathSense);
                if (toolpathFoam) visualizationGroup.add(toolpathFoam);
                layerCount++;
                console.log(`Layer ${layerCount}: Adding toolpath at zOffset = ${modelObj.toolpathConfig.zOffset + layerCount * modelObj.toolpathConfig.deltaZ}`);

            }
            for (let i = 0; i < modelObj.toolpathConfig.finalFoamLayerCount; i++) {
                const toolpathAll = _visualizeSegments(modelObj.all_area_segments, 'regular', modelObj.toolpathConfig.zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                if (toolpathAll) visualizationGroup.add(toolpathAll);
                layerCount++;
                console.log(`Layer ${layerCount}: Adding toolpath at zOffset = ${modelObj.toolpathConfig.zOffset + layerCount * modelObj.toolpathConfig.deltaZ}`);

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
function generateZigzagInfill(contour: THREE.Vector3[], z: number, params: { spacing: number }): THREE.Vector3[] {
    // Project contour to 2D (XY)
    const points2D = contour.map(pt => new THREE.Vector2(pt.x, pt.y));
    // Find bounds
    let minY = Infinity, maxY = -Infinity;
    for (const pt of points2D) {
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
    }
    const lines: THREE.Vector3[] = [];
    // For each horizontal line at spacing, find intersections with the polygon
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
            if (y % (2 * params.spacing) < params.spacing) {
                lines.push(new THREE.Vector3(x0, y, z));
                lines.push(new THREE.Vector3(x1, y, z));
            } else {
                lines.push(new THREE.Vector3(x1, y, z));
                lines.push(new THREE.Vector3(x0, y, z));
            }
        }
    }
    return lines;
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
    zOffset: number = visualizer.config.zOffset,
    deltaZ: number = visualizer.config.deltaZ,
    layerNum: number = visualizer.config.foamLayers
): { all: any; foam: any; sense: any } {
    // Remove previous visualization
    if (modelObj.toolpathVisualizationObject) {
        visualizer.scene.remove(modelObj.toolpathVisualizationObject);
        modelObj.toolpathVisualizationObject.traverse((child: any) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }
    // --- 1. Slice mesh into layers and extract regions ---
    const layers = sliceMeshIntoLayers(modelObj.mesh, deltaZ);
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
    const regionGroups = splitRegionsByOverlapOrSupport(allRegions);
    // --- 3. Build dependency tree and print order ---
    const regionTree = buildRegionTree(allRegions, deltaZ);
    const chunks = buildChunksWithDependencies(regionGroups, regionTree);
    const orderedChunks = topologicalSortChunks(chunks);
    // --- 4. For each chunk, for each region, generate zigzag toolpath ---
    const toolpaths: THREE.Vector3[][] = [];
    for (const chunk of orderedChunks) {
        for (const region of chunk.regions) {
            if (!region.contour || region.contour.length === 0) continue;
            const zigzag = generateZigzagInfill(region.contour, region.height, { spacing: modelObj.toolpathConfig.gridSize });
            toolpaths.push(zigzag);
        }
    }
    // --- 5. Visualize toolpaths ---
    const visualizationGroup = new THREE.Group();
    for (const path of toolpaths) {
        if (path.length < 2) continue;
        const vertices: number[] = [];
        for (const pt of path) {
            vertices.push(pt.x, pt.y, pt.z);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        const material = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2, opacity: 0.8, transparent: true });
        const line = new THREE.Line(geometry, material);
        visualizationGroup.add(line);
    }
    visualizationGroup.position.copy(modelObj.mesh.position);
    visualizer.scene.add(visualizationGroup);
    modelObj.toolpathVisualizationObject = visualizationGroup;
    return {
        all: toolpaths,
        foam: toolpaths,
        sense: []
    };
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