import * as THREE from 'three';
import Visualizer from '../Visualizer';
import { EverydayModel } from '../types/modelTypes';

/**
 * Adds a sensing intersection geometry to an EverydayModel.
 *
 * This function creates a new THREE.Mesh (either a cylinder or a box) with the given size,
 * positions it on the surface of modelObj.mesh using a raycast from above, and orients it so that
 * its default up vector (0,1,0) is aligned with the surface normal. The object becomes draggable only
 * if the user clicks directly on it; dragging stops on pointerup. During dragging, pointermove events
 * update the object's position (and its orientation for cylinders/boxes) so that it stays on the model's surface.
 *
 * After each position update, a private helper is invoked to update the overlapping region by precisely
 * determining the portion of modelObj.mesh that lies inside the sensing object.
 *
 * @param modelObj - The EverydayModel object.
 * @param type - The type of sensing intersection object to create ('cylinder' or 'box').
 * @param size - For a box, the edge length; for a cylinder, the diameter.
 * @param visualizer - The Visualizer instance.
 */
export function addSensingIntersectionGeo(
    modelObj: EverydayModel,
    type: 'cylinder' | 'box',
    size: number,
    visualizer: Visualizer
): void {
    // Ensure the sensingIntersectModelList exists.
    if (!modelObj.sensingIntersectModelList) {
        modelObj.sensingIntersectModelList = [];
    }

    // Create geometry based on the provided type.
    let geometry: THREE.BufferGeometry;
    if (type === 'cylinder') {
        // Create a cylinder with height equal to size.
        geometry = new THREE.CylinderGeometry(size / 2, size / 2, size, 32);
    } else {
        geometry = new THREE.BoxGeometry(size, size, size);
    }
    const material = new THREE.MeshBasicMaterial({
        color: 0xffaa00,
        opacity: 0.7,
        transparent: true,
    });
    const sensingObj = new THREE.Mesh(geometry, material);

    // Position the sensingObj on the model's surface using a raycast from above.
    const bbox = new THREE.Box3().setFromObject(modelObj.mesh);
    const center = bbox.getCenter(new THREE.Vector3());
    const rayOrigin = new THREE.Vector3(center.x, center.y, bbox.max.z + 10);
    const rayDirection = new THREE.Vector3(0, 0, -1);
    const raycaster = new THREE.Raycaster(rayOrigin, rayDirection);
    const intersects = raycaster.intersectObject(modelObj.mesh);
    if (intersects.length > 0) {
        const intersect = intersects[0];
        sensingObj.position.copy(intersect.point);
        if (intersect.face) {
            const normalWorld = intersect.face.normal
                .clone()
                .transformDirection(modelObj.mesh.matrixWorld)
                .normalize();
            const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normalWorld);
            sensingObj.quaternion.copy(quaternion);
        }
    } else {
        sensingObj.position.copy(center);
    }

    // Add the sensing object to modelObj and the scene.
    modelObj.sensingIntersectModelList.push(sensingObj);
    visualizer.scene.add(sensingObj);

    // Drag control flag.
    let isDragging = false;

    const onPointerDown = (event: PointerEvent) => {
        const rect = visualizer.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, visualizer.camera);
        const intersects = raycaster.intersectObject(sensingObj);
        if (intersects.length > 0) {
            isDragging = true;
            console.log('Dragging sensing object');
            visualizer.orbitControls.enabled = false;
            event.stopPropagation();
        }
    };

    const onPointerMove = (event: PointerEvent) => {
        if (!isDragging) return;
        const rect = visualizer.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, visualizer.camera);
        const intersects = raycaster.intersectObject(modelObj.mesh);
        if (intersects.length > 0) {
            const intersect = intersects[0];
            sensingObj.position.copy(intersect.point);
            if (intersect.face) {
                const normalWorld = intersect.face.normal
                    .clone()
                    .transformDirection(modelObj.mesh.matrixWorld)
                    .normalize();
                const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normalWorld);
                sensingObj.quaternion.copy(quaternion);
            }
            // Use a refined intersection test.
            _updateSenseIntersectionRegion(visualizer, modelObj, sensingObj, type, size);
        }
    };

    const onPointerUp = () => {
        isDragging = false;
        visualizer.orbitControls.enabled = true;
    };

    visualizer.renderer.domElement.addEventListener('pointerdown', onPointerDown);
    visualizer.renderer.domElement.addEventListener('pointermove', onPointerMove);
    visualizer.renderer.domElement.addEventListener('pointerup', onPointerUp);
}

/**
 * Checks whether a world-space point lies inside the sensing volume.
 * The point is first transformed to the sensing object's local coordinate system.
 *
 * For a box, the valid region is:
 *   x, y, z in [-size/2, size/2]
 *
 * For a cylinder, the valid region is:
 *   |z| <= size/2 and sqrt(x^2 + y^2) <= size/2
 *
 * @param point - The world-space point.
 * @param sensingObj - The sensing object.
 * @param type - The shape type ('box' or 'cylinder').
 * @param size - The size parameter used when creating the sensingObj.
 */
function pointInsideSensing(
    point: THREE.Vector3,
    sensingObj: THREE.Mesh,
    type: 'box' | 'cylinder',
    size: number
): boolean {
    // Transform the point into the sensing object's local coordinates.
    const inverseMatrix = new THREE.Matrix4().copy(sensingObj.matrixWorld).invert();
    const localPoint = point.clone().applyMatrix4(inverseMatrix);
    const half = size / 2;
    if (type === 'box') {
        return Math.abs(localPoint.x) <= half &&
               Math.abs(localPoint.y) <= half &&
               Math.abs(localPoint.z) <= half;
    } else {
        // For cylinder: assume cylinder is aligned along local z-axis.
        const radial = Math.sqrt(localPoint.x * localPoint.x + localPoint.y * localPoint.y);
        return Math.abs(localPoint.z) <= half && radial <= half;
    }
}

/**
 * Private helper to update the sensing intersection region.
 *
 * This version uses a refined intersection test:
 * For each triangle of modelObj.mesh (using its BufferGeometry),
 * transform its vertices into sensingObj's local space and check if they are inside.
 * If all three vertices of a triangle lie inside, then the triangle is included.
 *
 * The collected triangles are then used to build a new BufferGeometry,
 * which updates modelObj.highlightSenseMesh and modelObj.selectedSenseFoamMesh.
 *
 * @param visualizer - The Visualizer instance.
 * @param modelObj - The EverydayModel object.
 * @param sensingObj - The sensing intersection THREE.Mesh.
 * @param type - The shape type ('box' or 'cylinder').
 * @param size - The size parameter.
 */
function _updateSenseIntersectionRegion(
    visualizer: Visualizer,
    modelObj: EverydayModel,
    sensingObj: THREE.Mesh,
    type: 'box' | 'cylinder',
    size: number
): void {
    const originalGeom = modelObj.mesh.geometry;
    const posAttr = originalGeom.getAttribute('position');
    const indexAttr = originalGeom.index;
    const insidePositions: number[] = [];

    // Function to check if a vertex (world coordinates) is inside sensing volume.
    const isInside = (vertex: THREE.Vector3): boolean => {
        return pointInsideSensing(vertex, sensingObj, type, size);
    };

    // If geometry is indexed, iterate over faces.
    if (indexAttr) {
        for (let i = 0; i < indexAttr.count; i += 3) {
            const idx0 = indexAttr.getX(i);
            const idx1 = indexAttr.getX(i + 1);
            const idx2 = indexAttr.getX(i + 2);
            const v0 = new THREE.Vector3(
                posAttr.getX(idx0),
                posAttr.getY(idx0),
                posAttr.getZ(idx0)
            ).applyMatrix4(modelObj.mesh.matrixWorld);
            const v1 = new THREE.Vector3(
                posAttr.getX(idx1),
                posAttr.getY(idx1),
                posAttr.getZ(idx1)
            ).applyMatrix4(modelObj.mesh.matrixWorld);
            const v2 = new THREE.Vector3(
                posAttr.getX(idx2),
                posAttr.getY(idx2),
                posAttr.getZ(idx2)
            ).applyMatrix4(modelObj.mesh.matrixWorld);
            // 只有当整个三角形都在 sensing 内部时才考虑
            if (isInside(v0) && isInside(v1) && isInside(v2)) {
                insidePositions.push(...v0.toArray(), ...v1.toArray(), ...v2.toArray());
            }
        }
    } else {
        // 如果没有索引，则每连续三个顶点构成一个三角形
        for (let i = 0; i < posAttr.count; i += 3) {
            const v0 = new THREE.Vector3(
                posAttr.getX(i),
                posAttr.getY(i),
                posAttr.getZ(i)
            ).applyMatrix4(modelObj.mesh.matrixWorld);
            const v1 = new THREE.Vector3(
                posAttr.getX(i + 1),
                posAttr.getY(i + 1),
                posAttr.getZ(i + 1)
            ).applyMatrix4(modelObj.mesh.matrixWorld);
            const v2 = new THREE.Vector3(
                posAttr.getX(i + 2),
                posAttr.getY(i + 2),
                posAttr.getZ(i + 2)
            ).applyMatrix4(modelObj.mesh.matrixWorld);
            if (isInside(v0) && isInside(v1) && isInside(v2)) {
                insidePositions.push(...v0.toArray(), ...v1.toArray(), ...v2.toArray());
            }
        }
    }

    // Update highlightSenseMesh and selectedSenseFoamMesh if any geometry is found.
    if (insidePositions.length > 0) {
        const highlightGeometry = new THREE.BufferGeometry();
        highlightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(insidePositions, 3));

        if (modelObj.highlightSenseMesh) {
            visualizer.scene.remove(modelObj.highlightSenseMesh);
        }
        const highlightMaterial = new THREE.MeshBasicMaterial({
            color: 0xff0000,
            wireframe: true,
        });
        const highlightMesh = new THREE.Mesh(highlightGeometry, highlightMaterial);
        modelObj.highlightSenseMesh = highlightMesh;
        visualizer.scene.add(highlightMesh);

        // Generate selectedSenseFoamMesh using a similar approach (这里直接克隆作为示例)
        if (modelObj.selectedSenseFoamMesh) {
            visualizer.scene.remove(modelObj.selectedSenseFoamMesh);
        }
        const selectedMesh = highlightMesh.clone();
        modelObj.selectedSenseFoamMesh = selectedMesh;
        visualizer.scene.add(selectedMesh);
    } else {
        // 若无交集，则清除已有的高亮区域
        if (modelObj.highlightSenseMesh) {
            visualizer.scene.remove(modelObj.highlightSenseMesh);
            modelObj.highlightSenseMesh = undefined;
        }
        if (modelObj.selectedSenseFoamMesh) {
            visualizer.scene.remove(modelObj.selectedSenseFoamMesh);
            modelObj.selectedSenseFoamMesh = undefined;
        }
    }
}