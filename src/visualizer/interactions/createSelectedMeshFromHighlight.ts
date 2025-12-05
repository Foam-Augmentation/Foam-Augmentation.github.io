import * as THREE from 'three';

/**
 * Returns a new mesh that highlights the selected portion of the geometry.
 *
 * This function extracts the vertices defined by the current drawRange from the highlight mesh's geometry
 * and creates a new BufferGeometry using only those vertices. It properly reconstructs the index
 * to maintain triangle connectivity. A new Mesh is then created with a red wireframe material
 * to visually indicate the selection.
 *
 * @param highlightMesh - The THREE.Mesh used for highlighting; its geometry must have a defined drawRange and index.
 * @returns A new THREE.Mesh containing only the vertices specified in the drawRange, or an empty mesh if no vertices are selected.
 */
export function createSelectedMeshFromHighlight(highlightMesh: THREE.Mesh): THREE.Mesh {
    const geometry = highlightMesh.geometry;
    const drawRange = geometry.drawRange;

    // GUARD: If the drawRange count is 0, return an empty mesh.
    if (drawRange.count === 0) {
        console.warn("createSelectedMeshFromHighlight: drawRange.count is 0, returning empty mesh");
        return new THREE.Mesh();
    }

    // GUARD: Ensure that geometry.index exists
    if (!geometry.index) {
        console.warn("createSelectedMeshFromHighlight: geometry.index is undefined");
        return new THREE.Mesh();
    }

    // GUARD: Ensure position attribute exists
    const positionAttribute = geometry.attributes.position;
    if (!positionAttribute) {
        console.warn("createSelectedMeshFromHighlight: position attribute not found");
        return new THREE.Mesh();
    }

    // Create a new BufferGeometry for the selected mesh.
    const selectedGeometry = new THREE.BufferGeometry();

    // Extract the indices corresponding to the current drawRange
    // drawRange.start = where to start reading from the index
    // drawRange.count = how many indices to read
    const indexArray = geometry.index.array as Uint32Array | Uint16Array;
    const selectedIndices: number[] = [];

    for (let i = 0; i < drawRange.count; i++) {
        selectedIndices.push(indexArray[drawRange.start + i]);
    }

    // GUARD: Check if we have any indices
    if (selectedIndices.length === 0) {
        console.warn("createSelectedMeshFromHighlight: no indices extracted from drawRange");
        return new THREE.Mesh();
    }

    // Find unique vertex indices and create a mapping
    const uniqueIndices = new Set(selectedIndices);
    const indexMap = new Map<number, number>();
    let newIndex = 0;

    // Extract positions for unique vertices only
    const positions: number[] = [];
    for (const originalIndex of uniqueIndices) {
        indexMap.set(originalIndex, newIndex);
        positions.push(
            positionAttribute.getX(originalIndex),
            positionAttribute.getY(originalIndex),
            positionAttribute.getZ(originalIndex)
        );
        newIndex++;
    }

    // Create new index array with remapped indices
    const newIndices: number[] = [];
    for (const originalIndex of selectedIndices) {
        newIndices.push(indexMap.get(originalIndex)!);
    }

    // Set the position attribute
    selectedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

    // Set the index attribute (THIS WAS MISSING!)
    const indexType = indexArray instanceof Uint16Array ? Uint16Array : Uint32Array;
    selectedGeometry.setIndex(new THREE.BufferAttribute(new indexType(newIndices), 1));

    // Compute bounding box for validity checks
    selectedGeometry.computeBoundingBox();

    // GUARD: Verify the new geometry is valid
    if (!selectedGeometry.index || selectedGeometry.index.count === 0) {
        console.warn("createSelectedMeshFromHighlight: created geometry has no valid index");
        return new THREE.Mesh();
    }

    console.log(
        `createSelectedMeshFromHighlight: created mesh with ` +
        `${selectedGeometry.index.count} indices, ` +
        `${positions.length / 3} vertices`
    );

    // Create a new MeshBasicMaterial with a red color and wireframe enabled.
    const selectedMeshMaterial = new THREE.MeshBasicMaterial({
        color: 0xff0000,
        wireframe: true
    });

    // Return the new mesh built from the selected geometry and material.
    return new THREE.Mesh(selectedGeometry, selectedMeshMaterial);
}