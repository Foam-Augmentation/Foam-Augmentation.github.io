import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/** The print head's footprint in x and y, with the nozzle at (0, 0). */
export interface PrintHeadBox {
    min: THREE.Vector2;
    max: THREE.Vector2;
}

/** What the collision check found. */
export interface CollisionCheckResult {
    /** Extra height (mm) to add to the toolpath so the print head clears the mesh. 0 when nothing collides. */
    requiredOffset: number;
    /**
     * False when the head still collides even at the highest offset that was tried, in which case
     * requiredOffset is only a lower bound and raising H* alone will not fix it.
     */
    resolved: boolean;
}

/**
 * Gets the additional z offset a toolpath needs for the print head not to collide with a mesh.
 *
 * The head is modelled as a box: its footprint in x and y, from the bottom of the head body
 * (nozzle tip plus nozzle length) upwards. A point collides when any triangle of the mesh reaches
 * into that box. Raising the toolpath only ever shrinks the box, so the smallest clear offset can
 * be found by bisection.
 *
 * @param {THREE.BufferGeometry} geometry The mesh's geometry with its scale and rotation applied,
 *                                        in model-local coordinates. A BVH is built from it.
 * @param {THREE.Vector3} meshPosition Where the mesh sits on the bed.
 * @param {THREE.Vector3[]} toolpath The nozzle positions to check, in bed coordinates.
 * @param {number} nozzleLength How far the nozzle sticks out below the head body (mm).
 * @param {PrintHeadBox} printHeadBox The head's footprint with the nozzle at (0, 0).
 * @param {number} offsetTolerance How close (mm) the result should be to the true required offset.
 * @returns {CollisionCheckResult} The required offset, and whether it actually clears the mesh.
 */
export function getRequiredZOffset(
    geometry: THREE.BufferGeometry,
    meshPosition: THREE.Vector3,
    toolpath: THREE.Vector3[],
    nozzleLength: number,
    printHeadBox: PrintHeadBox,
    offsetTolerance: number
): CollisionCheckResult {
    if (!toolpath.length || !geometry.getAttribute('position') || geometry.getAttribute('position').count < 3) {
        return { requiredOffset: 0, resolved: true };
    }

    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox!;
    const bvh = new MeshBVH(geometry);
    const identity = new THREE.Matrix4();
    const headBox = new THREE.Box3();

    const collidesAt = (zOffset: number): boolean => toolpath.some(point => {
        const headBottom = point.z + nozzleLength + zOffset - meshPosition.z;
        if (headBottom > bbox.max.z) {
            return false; // the whole head is above the mesh
        }
        headBox.min.set(
            point.x + printHeadBox.min.x - meshPosition.x,
            point.y + printHeadBox.min.y - meshPosition.y,
            headBottom,
        );
        headBox.max.set(
            point.x + printHeadBox.max.x - meshPosition.x,
            point.y + printHeadBox.max.y - meshPosition.y,
            bbox.max.z,
        );
        return bvh.intersectsBox(headBox, identity);
    });

    if (!collidesAt(0)) {
        return { requiredOffset: 0, resolved: true };
    }

    // The full vertical range available before the head body is above the mesh entirely.
    let high = Math.max(0, bbox.max.z - bbox.min.z - nozzleLength);
    if (collidesAt(high)) {
        return { requiredOffset: high, resolved: false };
    }

    // Invariant: the head collides at `low` and is clear at `high`.
    let low = 0;
    const tolerance = Math.max(offsetTolerance, 1e-6);
    while (high - low > tolerance) {
        const mid = (high + low) / 2;
        if (collidesAt(mid)) {
            low = mid;
        } else {
            high = mid;
        }
    }

    return { requiredOffset: high, resolved: true };
}
