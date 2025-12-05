import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import Visualizer from '../Visualizer';
import { 
  isValidGeometry, 
  hasValidBoundingBox, 
  validateGeometryWithLogging 
} from '../utils/geometryValidation';

/**
 * Samples the selected mesh using a simple grid sampling method (scanning in X and Y).
 *
 * This function uses the bounding box of the model's selected regular foam mesh (stored in 
 * modelObj.selectedRegularFoamMesh) and the grid size defined by modelObj.toolpathConfig.gridSize 
 * to perform a raycast from above the bounding box. It creates two sets of points:
 * one for foam and one for sense. The results are stored in modelObj.toolpathSamplePoints,
 * and two THREE.Points meshes are created and added to the scene.
 *
 * @param visualizer - The Visualizer instance which provides access to the scene.
 * @param modelObj - The model object that should include:
 *                   - selectedRegularFoamMesh: THREE.Mesh
 *                   - selectedSenseFoamMesh: THREE.Mesh (optional)
 *                   - toolpathConfig.gridSize: number
 *                   - mesh: THREE.Mesh
 *                   - (optionally) pointsMesh_foam, pointsMesh_sense (which will be replaced)
 *                   - toolpathSamplePoints: any[] (an array to store sample points)
 */
export function sampleSelectedMesh(visualizer: Visualizer, modelObj: any): void {
  // GUARD 1: Check if selected mesh exists
  if (!modelObj.selectedRegularFoamMesh) {
    console.warn("sampleSelectedMesh: No selected foam mesh available");
    return;
  }

  // GUARD 2: Validate the selected mesh geometry
  if (!validateGeometryWithLogging(modelObj.selectedRegularFoamMesh, 'sampleSelectedMesh')) {
    console.warn("sampleSelectedMesh: Selected mesh has invalid geometry — skipping sampling");
    return;
  }

  // GUARD 3: Check if bounding box is valid
  if (!hasValidBoundingBox(modelObj.selectedRegularFoamMesh)) {
    console.warn("sampleSelectedMesh: Invalid bounding box for selected mesh");
    return;
  }

  try {
    // Get the grid size from config
    const gridSize: number = modelObj.toolpathConfig?.gridSize ?? 5;
    
    // Arrays for foam and sense vertices.
    const vertices_foam: number[] = [];
    const vertices_sense: number[] = [];
    
    // Clear previous sample points.
    modelObj.toolpathSamplePoints = [];

    // Apply scale, rotation to the selected mesh geometry
    if (modelObj.mesh.scale.x && modelObj.mesh.scale.y && modelObj.mesh.scale.z) {
      modelObj.selectedRegularFoamMesh.geometry.scale(
        modelObj.mesh.scale.x,
        modelObj.mesh.scale.y,
        modelObj.mesh.scale.z
      );
    }

    const e = new THREE.Euler(
      modelObj.mesh.rotation.x,
      modelObj.mesh.rotation.y,
      modelObj.mesh.rotation.z,
      'XYZ'
    );
    const q = new THREE.Quaternion().setFromEuler(e);
    modelObj.selectedRegularFoamMesh.geometry.applyQuaternion(q);

    // Compute and retrieve bounding box
    modelObj.selectedRegularFoamMesh.geometry.computeBoundingBox();
    const bbox: THREE.Box3 | null = modelObj.selectedRegularFoamMesh.geometry.boundingBox;

    // GUARD 4: Validate bounding box is not null after computation
    if (!bbox) {
      console.warn("sampleSelectedMesh: Failed to compute bounding box");
      return;
    }

    // GUARD 5: Check bounding box dimensions are valid
    if (
      !isFinite(bbox.min.x) || !isFinite(bbox.min.y) || !isFinite(bbox.min.z) ||
      !isFinite(bbox.max.x) || !isFinite(bbox.max.y) || !isFinite(bbox.max.z)
    ) {
      console.error("sampleSelectedMesh: Bounding box contains non-finite values", {
        min: { x: bbox.min.x, y: bbox.min.y, z: bbox.min.z },
        max: { x: bbox.max.x, y: bbox.max.y, z: bbox.max.z }
      });
      return;
    }

    // Create materials for foam and sense points.
    const pointsMaterialFoam = new THREE.PointsMaterial({
      size: 4,
      color: 0xff0000 // red points for foam
    });
    const pointsMaterialSense = new THREE.PointsMaterial({
      size: 4,
      color: 0x000000 // black points for sense
    });

    // Create new buffer geometries for foam and sense points.
    const pointsGeometry_foam = new THREE.BufferGeometry();
    const pointsGeometry_sense = new THREE.BufferGeometry();

    // Grid sample the selected mesh by scanning over the bounding box in X and Y.
    for (let x = bbox.min.x; x <= bbox.max.x; x += gridSize) {
      for (let y = bbox.min.y; y <= bbox.max.y; y += gridSize) {
        // Create a ray from above the bounding box.
        const rayOrigin = new THREE.Vector3(x, y, bbox.max.z + 10);
        const rayDirection = new THREE.Vector3(0, 0, -1);
        const raycaster = new THREE.Raycaster(rayOrigin, rayDirection);

        // Check intersections with the selected foam and sense meshes.
        const intersectsFoam = modelObj.selectedRegularFoamMesh ?
          raycaster.intersectObject(modelObj.selectedRegularFoamMesh) : [];
        const intersectsSense = modelObj.selectedSenseFoamMesh ?
          raycaster.intersectObject(modelObj.selectedSenseFoamMesh) : [];

        if (intersectsFoam.length > 0 && intersectsSense.length > 0) {
          // If both foam and sense meshes are intersected, treat the point as a sense point.
          const point = intersectsFoam[0].point;
          modelObj.toolpathSamplePoints.push({ point, type: 'sense' });
          vertices_sense.push(point.x, point.y, point.z);
        } else if (intersectsFoam.length > 0 && intersectsSense.length === 0) {
          // Otherwise, if only foam mesh is intersected, treat the point as a foam point.
          const point = intersectsFoam[0].point;
          modelObj.toolpathSamplePoints.push({ point, type: 'foam' });
          vertices_foam.push(point.x, point.y, point.z);
        }
      }
    }

    // GUARD 6: Check if any sample points were generated
    if (vertices_foam.length === 0 && vertices_sense.length === 0) {
      console.warn("sampleSelectedMesh: No sample points generated from raycast grid");
      // Don't return — still create empty geometries but log the warning
    }

    // Set the vertex positions to the buffer geometries.
    pointsGeometry_foam.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(vertices_foam, 3)
    );
    pointsGeometry_sense.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(vertices_sense, 3)
    );

    // Create Points meshes for foam and sense vertices.
    const pointsMesh_foam = new THREE.Points(pointsGeometry_foam, pointsMaterialFoam);
    const pointsMesh_sense = new THREE.Points(pointsGeometry_sense, pointsMaterialSense);

    // Add the points meshes to the scene.
    visualizer.scene.add(pointsMesh_foam);
    visualizer.scene.add(pointsMesh_sense);

    // Remove previous foam points mesh if exists.
    if (modelObj.pointsMesh_foam) {
      visualizer.scene.remove(modelObj.pointsMesh_foam);
      modelObj.pointsMesh_foam.geometry.dispose();
      modelObj.pointsMesh_foam.material.dispose();
    }
    // Save the new foam points mesh.
    modelObj.pointsMesh_foam = pointsMesh_foam;
    // Position it to match the model's mesh.
    modelObj.pointsMesh_foam.position.copy(modelObj.mesh.position);

    // Remove previous sense points mesh if exists.
    if (modelObj.pointsMesh_sense) {
      visualizer.scene.remove(modelObj.pointsMesh_sense);
      modelObj.pointsMesh_sense.geometry.dispose();
      modelObj.pointsMesh_sense.material.dispose();
    }
    // Save the new sense points mesh.
    modelObj.pointsMesh_sense = pointsMesh_sense;
    modelObj.pointsMesh_sense.position.copy(modelObj.mesh.position);

    console.log(
      `sampleSelectedMesh: Generated ${vertices_foam.length / 3} foam points, ` +
      `${vertices_sense.length / 3} sense points`
    );

  } catch (error) {
    console.error("Error in sampleSelectedMesh:", error);
    // Fail gracefully — don't crash the renderer
    return;
  }
}