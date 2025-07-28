
//loadDotSTL.ts
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
/**
 * Loads the dot (sphere) STL and converts it to a point cloud with custom spacing.
 *
 * @param {number} spacing - Distance between sampled points (e.g. 1 mm).
 * @returns {Promise<THREE.Vector3[]>} - Promise that resolves to array of sampled points.
 */
export async function loadDotPointCloud(spacing: number): Promise<THREE.Vector3[]> {
    const loader = new STLLoader();
  
    const geometry = await new Promise<THREE.BufferGeometry>((resolve, reject) => {
      loader.load('/public/assets/dot.stl', resolve, undefined, reject);
    });
  
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox!;
    const points: THREE.Vector3[] = [];
  
    // this is a minimum spacing maybe, for testing, but it can bwe changed with the GUI press and such
    const effectiveSpacing = Math.max(spacing, 2.0); 
  
    // Sample points with the spacing want for 3D printing
    for (let x = bbox.min.x; x <= bbox.max.x; x += effectiveSpacing) {
      for (let y = bbox.min.y; y <= bbox.max.y; y += effectiveSpacing) {
        for (let z = bbox.min.z; z <= bbox.max.z; z += effectiveSpacing) {
          const point = new THREE.Vector3(x, y, z);
          if (pointInsideGeometry(point, geometry)) {
            points.push(point.clone());
          }
        }
      }
    }
  
    console.log(`Generated ${points.length} points from dot STL with spacing ${effectiveSpacing}mm`);
    return points;
}
/**
 * Returns true if point is inside the mesh using raycasting
 */
function pointInsideGeometry(point: THREE.Vector3, geometry: THREE.BufferGeometry): boolean {
  const raycaster = new THREE.Raycaster();
  const direction = new THREE.Vector3(1, 0, 0);
  // Create a temporary mesh for intersection testing
  const tempMesh = new THREE.Mesh(geometry);
  raycaster.set(point, direction);
  const intersects = raycaster.intersectObject(tempMesh, false);
  return intersects.length % 2 === 1;
}
