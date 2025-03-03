// src/visualizer/interactions/createSelectedMeshFromHighlight.ts
import * as THREE from 'three';

/**
 * Returns a new mesh that highlights the selected portion of the geometry.
 *
 * This function extracts the vertices defined by the current drawRange from the highlight mesh's geometry
 * and creates a new BufferGeometry using only those vertices. A new Mesh is then created with a red
 * wireframe material to visually indicate the selection.
 *
 * @param highlightMesh - The THREE.Mesh used for highlighting; its geometry must have a defined drawRange and index.
 * @returns A new THREE.Mesh containing only the vertices specified in the drawRange, or an empty mesh if no vertices are selected.
 */
export function createSelectedMeshFromHighlight(highlightMesh: THREE.Mesh): THREE.Mesh {
    // If the drawRange count is 0, return an empty mesh.
    if (highlightMesh.geometry.drawRange.count === 0) {
        return new THREE.Mesh();
    }

    const geometry = highlightMesh.geometry;
    const drawRange = geometry.drawRange;

    // Create a new BufferGeometry for the selected mesh.
    const selectedGeometry = new THREE.BufferGeometry();

    // Get the position attribute from the geometry.
    const positionAttribute = geometry.attributes.position;

    // Ensure that geometry.index is available.
    if (!geometry.index) {
        return new THREE.Mesh();
    }

    // Extract the indices corresponding to the current drawRange.
    const indicesArray = geometry.index.array.slice(drawRange.start, drawRange.start + drawRange.count);
    const positions: number[] = [];

    // For each index, retrieve the corresponding vertex coordinates.
    for (let i = 0; i < indicesArray.length; i++) {
        const vertexIndex = indicesArray[i];
        positions.push(
            positionAttribute.getX(vertexIndex),
            positionAttribute.getY(vertexIndex),
            positionAttribute.getZ(vertexIndex)
        );
    }

    // Set the new geometry's position attribute using the extracted positions.
    selectedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

    // Create a new MeshBasicMaterial with a red color and wireframe enabled.
    const selectedMeshMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true });

    // Return the new mesh built from the selected geometry and material.
    return new THREE.Mesh(selectedGeometry, selectedMeshMaterial);
}
