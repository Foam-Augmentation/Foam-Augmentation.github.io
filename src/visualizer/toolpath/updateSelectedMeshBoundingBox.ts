import * as THREE from 'three';
import Visualizer from '../Visualizer';

/**
 * Updates the bounding box helper and outline of the selected mesh.
 * 
 * Uses the raw geometry’s bounding box and transforms it with the model's world matrix so the
 * helpers sit over the selection on the model.
 */
export function updateSelectedMeshBoundingBox(
  visualizer: Visualizer,
  object: any
): void {
  const mesh = object.selectedRegularFoamMesh;
  if (!mesh) {
    // Nothing is selected yet, so there is nothing to outline.
    return;
  }

  // Remove old helpers if they exist
  if (object.selectedRegularFoamMeshBoundingBoxHelper) {
    visualizer.scene.remove(object.selectedRegularFoamMeshBoundingBoxHelper);
    object.selectedRegularFoamMeshBoundingBoxHelper.geometry.dispose();
    object.selectedRegularFoamMeshBoundingBoxHelper.material.dispose();
  }
  if (object.selectedRegularFoamMeshOutline) {
    visualizer.scene.remove(object.selectedRegularFoamMeshOutline);
    object.selectedRegularFoamMeshOutline.geometry.dispose();
    object.selectedRegularFoamMeshOutline.material.dispose();
  }

  // Compute geometry bounds (your original logic)
  const geometry = mesh.geometry;
  if (!geometry.getAttribute('position')) {
    // An empty selection has no geometry to outline.
    object.selectedRegularFoamMeshBoundingBoxHelper = undefined;
    object.selectedRegularFoamMeshOutline = undefined;
    return;
  }
  geometry.computeBoundingBox();

  // The selected mesh is a detached copy of part of the model, in the model's local coordinates,
  // and is never placed in the scene itself. The model's own world matrix is what puts the
  // helpers over the selection; the detached copy's matrix would leave them at the origin.
  const placement: THREE.Object3D = object.mesh ?? mesh;
  placement.updateWorldMatrix(true, false);
  const worldMatrix = placement.matrixWorld;

  const tightBox = geometry.boundingBox.clone();
  tightBox.applyMatrix4(worldMatrix);

  // Blue bounding box
  const bboxHelper = new THREE.Box3Helper(tightBox);
  bboxHelper.material = new THREE.LineBasicMaterial({ color: 0x6fa8ff });
  
  visualizer.scene.add(bboxHelper);
  object.selectedRegularFoamMeshBoundingBoxHelper = bboxHelper;

  // Outline of the actual geometry, in the foam colour (--foam in style.css)
  const outlineGeometry = new THREE.EdgesGeometry(geometry);
  const outlineMaterial = new THREE.LineBasicMaterial({
    color: 0xff0000,
    depthTest: false,
    transparent: true,
    opacity: 1.0,
  });

  const outline = new THREE.LineSegments(outlineGeometry, outlineMaterial);
  outline.applyMatrix4(worldMatrix);
  outline.position.z += 0.3; // lift above surface for visibility
  outline.renderOrder = 9999;

  visualizer.scene.add(outline);
  object.selectedRegularFoamMeshOutline = outline;
}
