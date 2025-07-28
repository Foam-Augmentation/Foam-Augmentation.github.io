
// projectdotcloud.ts
// Working July 13th
import * as THREE from 'three';
/**
 * Projects points from a dot cloud onto a mesh surface along a direction.
 * Shifts points above mesh top before casting rays down.
 * @param dotPoints Array of THREE.Vector3 points (the dot cloud)
 * @param surfaceMesh THREE.Mesh to project onto
 * @param direction Ray direction (default: downwards in -Z)
 * @returns Array of projected THREE.Vector3 points on the surface
 */
export function projectDotCloudOntoSurface(
  dotPoints: THREE.Vector3[],
  surfaceMesh: THREE.Mesh,
  direction: THREE.Vector3 = new THREE.Vector3(0, 0, -1)
): THREE.Vector3[] {
  const raycaster = new THREE.Raycaster();
  const projectedPoints: THREE.Vector3[] = [];
  // Ensure bounding box is computed
  surfaceMesh.geometry.computeBoundingBox();
  const bbox = surfaceMesh.geometry.boundingBox!;
  
  // Calculate offset height: mesh position.z + bbox max.z + some margin (e.g., 10)
  const offsetZ = surfaceMesh.position.z + bbox.max.z + 10;
  for (const point of dotPoints) {
    // Shift point in X and Y by mesh position to align horizontally,
    // shift point in Z to be above the mesh top
    const origin = new THREE.Vector3(
      point.x + surfaceMesh.position.x,
      point.y + surfaceMesh.position.y,
      offsetZ
    );
    raycaster.set(origin, direction);
    const intersects = raycaster.intersectObject(surfaceMesh, true);
    if (intersects.length > 0) {
      projectedPoints.push(intersects[0].point.clone());
    }
  }
  return projectedPoints;
}
