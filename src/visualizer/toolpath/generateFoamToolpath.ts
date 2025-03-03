import * as THREE from 'three';
import Visualizer from '../Visualizer';
import { EverydayModel } from '../types/modelTypes';

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
            }
            for (let i = 0; i < modelObj.toolpathConfig.middleSenseLayerCount; i++) {
                const toolpathSense = _visualizeSegments(modelObj.sense_area_segments, 'sensing', modelObj.toolpathConfig.zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                const toolpathFoam = _visualizeSegments(modelObj.regular_area_segments, 'regular', modelObj.toolpathConfig.zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
                if (toolpathSense) visualizationGroup.add(toolpathSense);
                if (toolpathFoam) visualizationGroup.add(toolpathFoam);
                layerCount++;
            }
            for (let i = 0; i < modelObj.toolpathConfig.finalFoamLayerCount; i++) {
                const toolpathAll = _visualizeSegments(modelObj.all_area_segments, 'regular', modelObj.toolpathConfig.zOffset + layerCount * modelObj.toolpathConfig.deltaZ);
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


/**
 * Generates foam toolpaths based on the model's sampled points.
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
export function generateFoamToolpath(visualizer: Visualizer, modelObj: EverydayModel): { all: any, foam: any, sense: any } {
    // --- 1. Remove the previous foam toolpath visualization, if it exists.
    if (modelObj.toolpathVisualizationObject) {
        visualizer.scene.remove(modelObj.toolpathVisualizationObject);
        modelObj.toolpathVisualizationObject.traverse((child: any) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }
    // --- 2. Check if there are sample points available.
    if (!modelObj.toolpathSamplePoints || modelObj.toolpathSamplePoints.length === 0) {
        console.warn("No sample points available. Cannot generate toolpath.");
        return { all: null, foam: null, sense: null };
    }

    // --- 3. Define offsets for toolpath visualization.
    const offsets = {
        all: 10,
        foam: 20,
        sense: 30
    };

    // --- 5. Generate three sets of toolpath segments.
    const allPoints = modelObj.toolpathSamplePoints;  // All sample points.
    const foamPoints = modelObj.toolpathSamplePoints.filter((item: any) => item.type === 'foam');
    const sensePoints = modelObj.toolpathSamplePoints.filter((item: any) => item.type === 'sense');

    const all_area_segments = _generatePath(allPoints, modelObj);
    const regular_area_segments = _generatePath(foamPoints, modelObj);
    const sense_area_segments = _generatePath(sensePoints, modelObj);

    // save the generated segments to the model object
    modelObj.all_area_segments = all_area_segments;
    modelObj.regular_area_segments = regular_area_segments;
    modelObj.sense_area_segments = sense_area_segments;

    // --- 6. Visualize the segments.
    visualize_All_Layers(visualizer, modelObj);
    // let visualizationGroup: THREE.Group | undefined;
    // if (modelObj.toolpathSamplePoints.every((item: any) => item.type === 'foam')) {
    //     visualizationGroup = visualizeSegments(regular_area_segments, 0x00ff00, offsets.foam) as THREE.Group;
    // } else {
    //     const toolpathAll = visualizeSegments(all_area_segments, 0xff00ff, offsets.all);
    //     const toolpathFoam = visualizeSegments(regular_area_segments, 0x00ff00, offsets.foam);
    //     const toolpathSense = visualizeSegments(sense_area_segments, 0x0000ff, offsets.sense);
    //     visualizationGroup = new THREE.Group() as THREE.Group;
    //     if (toolpathAll) visualizationGroup.add(toolpathAll);
    //     if (toolpathFoam) visualizationGroup.add(toolpathFoam);
    //     if (toolpathSense) visualizationGroup.add(toolpathSense);
    // }
    // // Position the parent group at the model's mesh position.
    // if (visualizationGroup) {
    //     if (modelObj.mesh && modelObj.mesh.position) {
    //         visualizationGroup.position.copy(modelObj.mesh.position);
    //     }
    //     // Add the toolpath visualization to the scene.
    //     visualizer.scene.add(visualizationGroup);
    //     // Save the generated toolpath visualization to the model object.
    //     modelObj.toolpathVisualizationObject = visualizationGroup as THREE.Group;
    // }
    // modelObj.toolpathVisualizationObject = visualizationGroup as THREE.Group | undefined;

    return {
        all: all_area_segments,
        foam: regular_area_segments,
        sense: sense_area_segments
    };
}