import * as THREE from 'three';
import Visualizer from '../Visualizer';
import { createSelectedMeshFromHighlight } from './createSelectedMeshFromHighlight';
import { updateSelectedMeshBoundingBox } from '../toolpath/updateSelectedMeshBoundingBox';
import { sampleSelectedMesh } from '../toolpath/sampleSelectedMesh';
import { generateFoamToolpath } from '../toolpath/generateFoamToolpath';
import { INTERSECTED, NOT_INTERSECTED, CONTAINED } from 'three-mesh-bvh';
import { getConvexHull, pointRayCrossesSegments, lineCrossesLine } from '../utils/geometryUtils';
import { EverydayModel } from '../types/modelTypes';

/**
 * Updates the selection for a given model object based on the current lasso selection.
 *
 * This function uses the lasso state (stored in visualizer.lassoState) and the mesh's boundsTree
 * to determine which faces are selected by the lasso. It updates the highlight mesh's geometry
 * drawRange, creates a new selected mesh, updates the bounding box of the selected mesh, samples the
 * selected mesh, and finally generates a foam toolpath.
 *
 * @param visualizer - The Visualizer instance providing access to the scene, camera, etc.
 * @param modelObj - The model object to update. It should include:
 *                   - mesh: THREE.Mesh,
 *                   - toolpathSamplePoints: Array,
 *                   - highlightFoamMesh and highlightSenseMesh: THREE.Mesh,
 *                   - (others as required by the selection logic)
 * @returns An object containing the generated toolpaths with keys 'all', 'foam', and 'sense'.
 */
export function updateSelection(
    visualizer: Visualizer,
    modelObj: EverydayModel
): { all: any; foam: any; sense: any } {
    // Create temporary matrices and vectors.
    const invWorldMatrix = new THREE.Matrix4();
    const camLocalPosition = new THREE.Vector3();
    const tempRay = new THREE.Ray();
    const centroid = new THREE.Vector3();
    const screenCentroid = new THREE.Vector3();
    const faceNormal = new THREE.Vector3();
    const toScreenSpaceMatrix = new THREE.Matrix4();
    // Using Vector4 for homogeneous coordinates.
    const boxPoints: THREE.Vector4[] = new Array(8).fill(null).map(() => new THREE.Vector4());
    const boxLines: THREE.Line3[] = new Array(12).fill(null).map(
        () => new THREE.Line3(new THREE.Vector3(), new THREE.Vector3())
    );
    const lassoSegments: THREE.Line3[] = [];
    const perBoundsSegments: any = {};

    // Transform the mesh's world matrix into screen space.
    toScreenSpaceMatrix.copy(modelObj.mesh.matrixWorld)
        .premultiply(visualizer.camera.matrixWorldInverse)
        .premultiply(visualizer.camera.projectionMatrix);

    // Build lassoSegments from the selection points stored in visualizer.lassoState.
    const sp = visualizer.lassoState.selectionPoints;
    while (lassoSegments.length < sp.length) {
        lassoSegments.push(new THREE.Line3(new THREE.Vector3(), new THREE.Vector3()));
    }
    lassoSegments.length = sp.length;
    for (let s = 0, len = sp.length; s < len; s += 3) {
        const line = lassoSegments[s];
        const sNext = (s + 3) % len;
        line.start.x = sp[s];
        line.start.y = sp[s + 1];
        // Z coordinate is assumed zero.
        line.end.x = sp[sNext];
        line.end.y = sp[sNext + 1];
    }

    // Compute the camera's local position relative to the mesh.
    invWorldMatrix.copy(modelObj.mesh.matrixWorld).invert();
    camLocalPosition.set(0, 0, 0)
        .applyMatrix4(visualizer.camera.matrixWorld)
        .applyMatrix4(invWorldMatrix);

    const indices: number[] = []; // Store the indices of selected faces.
    // Perform a shapecast on the mesh's boundsTree.
    if (!modelObj.mesh.geometry.boundsTree) {
        throw new Error('Bounds tree is undefined');
    }
    modelObj.mesh.geometry.boundsTree.shapecast({
        intersectsBounds: (box: THREE.Box3, _isLeaf: boolean, _score: number | undefined, depth: number) => {
            if (!(visualizer.config as any).useBoundsTree) {
                return INTERSECTED;
            }
            const { min, max } = box;
            let index = 0;
            let minY = Infinity;
            let maxY = -Infinity;
            let minX = Infinity;
            // Iterate over the eight corners of the box.
            for (let x = 0; x <= 1; x++) {
                for (let y = 0; y <= 1; y++) {
                    for (let z = 0; z <= 1; z++) {
                        const v = boxPoints[index];
                        v.x = x === 0 ? min.x : max.x;
                        v.y = y === 0 ? min.y : max.y;
                        v.z = z === 0 ? min.z : max.z;
                        v.w = 1;
                        v.applyMatrix4(toScreenSpaceMatrix);
                        index++;
                        if (v.y < minY) minY = v.y;
                        if (v.y > maxY) maxY = v.y;
                        if (v.x < minX) minX = v.x;
                    }
                }
            }
            const parentSegments = perBoundsSegments[depth - 1] || lassoSegments;
            const segmentsToCheck = perBoundsSegments[depth] || [];
            segmentsToCheck.length = 0;
            perBoundsSegments[depth] = segmentsToCheck;
            for (let i = 0, len = parentSegments.length; i < len; i++) {
                const line = parentSegments[i];
                const sx = line.start.x;
                const sy = line.start.y;
                const ex = line.end.x;
                const ey = line.end.y;
                if (sx < minX && ex < minX) continue;
                const startAbove = sy > maxY;
                const endAbove = ey > maxY;
                if (startAbove && endAbove) continue;
                const startBelow = sy < minY;
                const endBelow = ey < minY;
                if (startBelow && endBelow) continue;
                segmentsToCheck.push(line);
            }
            if (segmentsToCheck.length === 0) {
                return NOT_INTERSECTED;
            }
            const hull = getConvexHull(boxPoints.map(p => new THREE.Vector2(p.x, p.y)));
            if (!hull) return NOT_INTERSECTED;
            const lines = hull.map((p, i) => {
                const nextP = hull[(i + 1) % hull.length];
                const line = boxLines[i];
                // Note: we cast Vector4 to Vector3 for copying.
                line.start.copy(new THREE.Vector3(p.x, p.y, 0));
                line.end.copy(new THREE.Vector3(nextP.x, nextP.y, 0));
                return line;
            });
            if (pointRayCrossesSegments(new THREE.Vector2(segmentsToCheck[0].start.x, segmentsToCheck[0].start.y), lines.map(line => ({ start: new THREE.Vector2(line.start.x, line.start.y), end: new THREE.Vector2(line.end.x, line.end.y) }))) % 2 === 1) {
                return INTERSECTED;
            }
            let crossings = 0;
            for (let i = 0, len = hull.length; i < len; i++) {
                const v = hull[i];
                const pCrossings = pointRayCrossesSegments(v, segmentsToCheck);
                if (i === 0) {
                    crossings = pCrossings;
                }
                if (crossings !== pCrossings) {
                    return INTERSECTED;
                }
            }
            for (let i = 0, len = lines.length; i < len; i++) {
                const boxLine = lines[i];
                for (let s = 0, ls = segmentsToCheck.length; s < ls; s++) {
                    if (lineCrossesLine({ start: new THREE.Vector2(boxLine.start.x, boxLine.start.y), end: new THREE.Vector2(boxLine.end.x, boxLine.end.y) }, segmentsToCheck[s])) {
                        return INTERSECTED;
                    }
                }
            }
            return crossings % 2 === 0 ? NOT_INTERSECTED : CONTAINED;
        },

        intersectsTriangle: (tri: THREE.Triangle, index: number, contained: boolean, depth: number) => {
            const i3 = index * 3;
            const a = i3;
            const b = i3 + 1;
            const c = i3 + 2;

            const segmentsToCheck = (visualizer.config as any).useBoundsTree ? perBoundsSegments[depth] : lassoSegments;
            if (visualizer.config.selectionMode === 'centroid' || visualizer.config.selectionMode === 'centroid-visible') {
                centroid.copy(tri.a).add(tri.b).add(tri.c).multiplyScalar(1 / 3);
                screenCentroid.copy(centroid).applyMatrix4(toScreenSpaceMatrix);
                if (contained || pointRayCrossesSegments(new THREE.Vector2(screenCentroid.x, screenCentroid.y), segmentsToCheck) % 2 === 1) {
                    if (visualizer.config.selectionMode === 'centroid-visible') {
                        tri.getNormal(faceNormal);
                        tempRay.origin.copy(centroid).addScaledVector(faceNormal, 1e-6);
                        tempRay.direction.subVectors(camLocalPosition, centroid);
                        const res = modelObj.mesh.geometry.boundsTree?.raycastFirst(tempRay, THREE.DoubleSide);
                        if (res) {
                            return false;
                        }
                    }
                    indices.push(a, b, c);
                    return visualizer.config.selectModel;
                }
            } else if (visualizer.config.selectionMode === 'intersection') {
                if (contained) {
                    indices.push(a, b, c);
                    return visualizer.config.selectModel;
                }
                const vertices = [tri.a, tri.b, tri.c];
                for (let j = 0; j < 3; j++) {
                    const v = vertices[j];
                    v.applyMatrix4(toScreenSpaceMatrix);
                    const crossings = pointRayCrossesSegments(new THREE.Vector2(v.x, v.y), segmentsToCheck);
                    if (crossings % 2 === 1) {
                        indices.push(a, b, c);
                        return visualizer.config.selectModel;
                    }
                }
                const lines = [
                    { start: new THREE.Vector2(tri.a.x, tri.a.y), end: new THREE.Vector2(tri.b.x, tri.b.y) },
                    { start: new THREE.Vector2(tri.b.x, tri.b.y), end: new THREE.Vector2(tri.c.x, tri.c.y) },
                    { start: new THREE.Vector2(tri.c.x, tri.c.y), end: new THREE.Vector2(tri.a.x, tri.a.y) }
                ];
                for (let i = 0; i < 3; i++) {
                    const l = lines[i];
                    for (let s = 0, ls = segmentsToCheck.length; s < ls; s++) {
                        if (lineCrossesLine(l, { start: new THREE.Vector2(segmentsToCheck[s].start.x, segmentsToCheck[s].start.y), end: new THREE.Vector2(segmentsToCheck[s].end.x, segmentsToCheck[s].end.y) })) {
                            indices.push(a, b, c);
                            return visualizer.config.selectModel;
                        }
                    }
                }
            }
            return false;
        }
    });

    const indexAttr = modelObj.mesh.geometry.index;
    const newIndexAttr = (visualizer.current_selection_type === 'foam')
        ? modelObj.highlightFoamMesh?.geometry.index ?? new THREE.BufferAttribute(new Float32Array(), 1)
        : modelObj.highlightSenseMesh?.geometry.index ?? new THREE.BufferAttribute(new Float32Array(), 1);
    if (indices.length && visualizer.config.selectModel) {
        if (indexAttr) {
            for (let i = 0, l = indexAttr.count; i < l; i++) {
                const i2 = indexAttr.getX(i);
                newIndexAttr.setX(i, i2);
            }
        }
        if (visualizer.current_selection_type === 'foam') {
            if (modelObj.highlightFoamMesh) {
                modelObj.highlightFoamMesh.geometry.drawRange.count = Infinity;
            }
        } else {
            if (modelObj.highlightSenseMesh) {
                modelObj.highlightSenseMesh.geometry.drawRange.count = Infinity;
            }
        }
        newIndexAttr.needsUpdate = true;
    } else {
        for (let i = 0, l = indices.length; i < l; i++) {
            if (indexAttr) {
                const i2 = indexAttr.getX(indices[i]);
                newIndexAttr.setX(i, i2);
            }
        }
        if (visualizer.current_selection_type === 'foam') {
            if (modelObj.highlightFoamMesh) {
                modelObj.highlightFoamMesh.geometry.drawRange.count = indices.length;
            }
        } else {
            if (modelObj.highlightSenseMesh) {
                modelObj.highlightSenseMesh.geometry.drawRange.count = indices.length;
            }
        }
        newIndexAttr.needsUpdate = true;
    }

    if (visualizer.current_selection_type === 'foam') {
        if (modelObj.highlightFoamMesh) {
            modelObj.selectedRegularFoamMesh = createSelectedMeshFromHighlight(modelObj.highlightFoamMesh);
        }
    } else {
        if (modelObj.highlightSenseMesh) {
            modelObj.selectedSenseFoamMesh = createSelectedMeshFromHighlight(modelObj.highlightSenseMesh);
        }
    }

    updateSelectedMeshBoundingBox(visualizer, modelObj);
    sampleSelectedMesh(visualizer, modelObj);
    console.log(modelObj);
    const toolpaths = generateFoamToolpath(visualizer, modelObj);
    return {
        all: toolpaths.all,
        foam: toolpaths.foam,
        sense: toolpaths.sense
    };
}

