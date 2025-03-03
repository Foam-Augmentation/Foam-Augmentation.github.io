import * as THREE from 'three';
import Visualizer from '../Visualizer';

/**
 * Updates the bounding box helper of the selected mesh.
 *
 * This function removes and disposes of any existing bounding box helper associated with the model object,
 * then creates a new Box3 helper based on the object's selectedRegularFoamMesh.
 *
 * @param visualizer - An instance of Visualizer, which provides access to the scene.
 * @param modelObj - The model object which should have:
 *                   - selectedRegularFoamMesh: THREE.Mesh (the mesh to compute the bounding box for)
 *                   - selectedRegularFoamMeshBoundingBoxHelper: (optional) THREE.Box3Helper to be replaced.
 */
export function updateSelectedMeshBoundingBox(visualizer: Visualizer, modelObj: any): void {
    // If a previous bounding box helper exists, remove it from the scene and dispose of its resources.
    if (modelObj.selectedRegularFoamMeshBoundingBoxHelper) {
        visualizer.scene.remove(modelObj.selectedRegularFoamMeshBoundingBoxHelper);
        modelObj.selectedRegularFoamMeshBoundingBoxHelper.geometry.dispose();
        modelObj.selectedRegularFoamMeshBoundingBoxHelper.material.dispose();
    }

    // Create a new Box3 based on the selected mesh.
    const box = new THREE.Box3().setFromObject(modelObj.selectedRegularFoamMesh);
    // Create a new Box3Helper with a red color.
    modelObj.selectedRegularFoamMeshBoundingBoxHelper = new THREE.Box3Helper(box, 0xff0000);
    // (Optionally) You may add the helper back to the scene if needed.
    // visualizer.scene.add(modelObj.selectedRegularFoamMeshBoundingBoxHelper);
}
