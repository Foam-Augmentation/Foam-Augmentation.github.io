import * as THREE from 'three';
import Visualizer from '../Visualizer';

/**
 * Updates the bounding box helper and outline of the selected mesh.
 * 
 * Uses the raw geometry’s bounding box and transforms it using 
 * selectedFoamRegularMesh.matrixWorld for proper world-space alignment.
 */
export function updateSelectedMeshBoundingBox(
  visualizer: Visualizer,
  object: any
): void {

  console.log("Entered updateSelectedMeshBoundingBox");

  const mesh = object.selectedRegularFoamMesh;
  if (!mesh) {
    console.warn("Missing mesh references on object:", object);
    return;
  }

  // Remove old helpers if they exist
  if (object.selectedRegularFoamMeshBoundingBoxHelper) {
    visualizer.scene.remove(object.selectedRegularFoamMeshBoundingBoxHelper);
    object.selectedRegularFoamMeshBoundingBoxHelper.geometry.dispose();
    object.selectedRegularFoamMeshBoundingBoxHelper.material.dispose();
    console.log("Disposing of old");
  }
  if (object.selectedRegularFoamMeshOutline) {
    visualizer.scene.remove(object.selectedRegularFoamMeshOutline);
    object.selectedRegularFoamMeshOutline.geometry.dispose();
    object.selectedRegularFoamMeshOutline.material.dispose();
  }

  // Compute geometry bounds (your original logic)
  const geometry = mesh.geometry;
  geometry.computeBoundingBox();

  const tightBox = geometry.boundingBox.clone();
  mesh.updateWorldMatrix(true, false);
  tightBox.applyMatrix4(mesh.matrixWorld);

  // Blue bounding box
  const bboxHelper = new THREE.Box3Helper(tightBox);
  bboxHelper.material = new THREE.LineBasicMaterial({ color: 0x0000ff });
  
  visualizer.scene.add(bboxHelper);
  console.log("added to visualizer");
  object.selectedRegularFoamMeshBoundingBoxHelper = bboxHelper;

  // Red outline of actual geometry
  const outlineGeometry = new THREE.EdgesGeometry(geometry);
  const outlineMaterial = new THREE.LineBasicMaterial({
    color: 0xff0000,
    depthTest: false,
    transparent: true,
    opacity: 1.0,
  });

  const outline = new THREE.LineSegments(outlineGeometry, outlineMaterial);
  outline.applyMatrix4(mesh.matrixWorld);
  outline.position.z += 0.3; // lift above surface for visibility
  outline.renderOrder = 9999;

  visualizer.scene.add(outline);
  object.selectedRegularFoamMeshOutline = outline;
}


// import * as THREE from 'three';
// import Visualizer from '../Visualizer';

// /**
//  * Updates the bounding box helper (blue) and first-layer outline (red) of the selected mesh.
//  */
// export function updateSelectedMeshBoundingBox(
//   visualizer: Visualizer,
//   object: any
// ): void {
//   console.log("Entered updateSelectedMeshBoundingBox");

//   const mesh = object.selectedRegularFoamMesh;
//   if (!mesh) {
//     console.warn("No selectedRegularFoamMesh found on object:", Object.keys(object));
//     return;
//   }

//   // 🧹 Remove old helpers
//   if (object.selectedRegularFoamMeshBoundingBoxHelper) {
//     visualizer.scene.remove(object.selectedRegularFoamMeshBoundingBoxHelper);
//     object.selectedRegularFoamMeshBoundingBoxHelper.geometry.dispose();
//     object.selectedRegularFoamMeshBoundingBoxHelper.material.dispose();
//   }
//   if (object.selectedRegularFoamMeshOutline) {
//     visualizer.scene.remove(object.selectedRegularFoamMeshOutline);
//     object.selectedRegularFoamMeshOutline.geometry.dispose();
//     object.selectedRegularFoamMeshOutline.material.dispose();
//   }

//   // 🧱 Compute geometry bounds
//   const geometry = mesh.geometry;
//   geometry.computeBoundingBox();

//   // Update world matrix to ensure matrixWorld is valid
//   mesh.updateWorldMatrix(true, false);

//   const tightBox = geometry.boundingBox.clone();
//   tightBox.applyMatrix4(mesh.matrixWorld);

//   // 🟦 Blue bounding box (force color override)
//   const bboxHelper = new THREE.Box3Helper(tightBox);
//   bboxHelper.material = new THREE.LineBasicMaterial({ color: 0x0000ff });
//   visualizer.scene.add(bboxHelper);
//   object.selectedRegularFoamMeshBoundingBoxHelper = bboxHelper;

//   // 🔴 First-layer outline
//   const minZ = geometry.boundingBox.min.z;
//   const tolerance = 0.05; // include triangles near base

//   const pos = geometry.attributes.position;
//   const indices = geometry.index ? geometry.index.array : null;

//   const layerEdges: number[] = [];
//   const addEdge = (a: number, b: number) => {
//     layerEdges.push(a, b);
//   };

//   // Collect triangle edges near the first layer
//   if (indices) {
//     for (let i = 0; i < indices.length; i += 3) {
//       const i1 = indices[i], i2 = indices[i + 1], i3 = indices[i + 2];
//       const z1 = pos.getZ(i1), z2 = pos.getZ(i2), z3 = pos.getZ(i3);
//       if (
//         Math.abs(z1 - minZ) < tolerance ||
//         Math.abs(z2 - minZ) < tolerance ||
//         Math.abs(z3 - minZ) < tolerance
//       ) {
//         addEdge(i1, i2);
//         addEdge(i2, i3);
//         addEdge(i3, i1);
//       }
//     }
//   } else {
//     // Fallback for non-indexed geometry
//     for (let i = 0; i < pos.count; i += 3) {
//       const z1 = pos.getZ(i), z2 = pos.getZ(i + 1), z3 = pos.getZ(i + 2);
//       if (
//         Math.abs(z1 - minZ) < tolerance ||
//         Math.abs(z2 - minZ) < tolerance ||
//         Math.abs(z3 - minZ) < tolerance
//       ) {
//         addEdge(i, i + 1);
//         addEdge(i + 1, i + 2);
//         addEdge(i + 2, i);
//       }
//     }
//   }

//   // Build geometry for those edges
//   const layerOutlineGeom = new THREE.BufferGeometry();
//   const positions = new Float32Array(layerEdges.length * 3);
//   for (let i = 0; i < layerEdges.length; i++) {
//     const idx = layerEdges[i];
//     positions[i * 3] = pos.getX(idx);
//     positions[i * 3 + 1] = pos.getY(idx);
//     positions[i * 3 + 2] = pos.getZ(idx);
//   }
//   layerOutlineGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

//   const layerOutlineMat = new THREE.LineBasicMaterial({
//     color: 0xff0000,
//     depthTest: false,
//     transparent: true,
//     opacity: 1.0,
//   });

//   const layerOutline = new THREE.LineSegments(layerOutlineGeom, layerOutlineMat);
//   layerOutline.applyMatrix4(mesh.matrixWorld);
//   layerOutline.position.z += 0.05; // lift slightly above base
//   layerOutline.renderOrder = 9999;

//   visualizer.scene.add(layerOutline);
//   object.selectedRegularFoamMeshOutline = layerOutline;

//   console.log(`✅ First-layer outline drawn with ${layerEdges.length / 2} edges`);
// }





// // import * as THREE from 'three';
// // import Visualizer from '../Visualizer';

// // /**
// //  * Updates the bounding box helper of the selected mesh.
// //  *
// //  * This function removes and disposes of any existing bounding box helper associated with the model object,
// //  * then creates a new Box3 helper based on the object's selectedRegularFoamMesh.
// //  *
// //  * @param visualizer - An instance of Visualizer, which provides access to the scene.
// //  * @param modelObj - The model object which should have:
// //  *                   - selectedRegularFoamMesh: THREE.Mesh (the mesh to compute the bounding box for)
// //  *                   - selectedRegularFoamMeshBoundingBoxHelper: (optional) THREE.Box3Helper to be replaced.
// //  */
// // export function updateSelectedMeshBoundingBox(visualizer: Visualizer, modelObj: any): void {
// //     // // If a previous bounding box helper exists, remove it from the scene and dispose of its resources.
// //     // if (modelObj.selectedRegularFoamMeshBoundingBoxHelper) {
// //     //     visualizer.scene.remove(modelObj.selectedRegularFoamMeshBoundingBoxHelper);
// //     //     modelObj.selectedRegularFoamMeshBoundingBoxHelper.geometry.dispose();
// //     //     modelObj.selectedRegularFoamMeshBoundingBoxHelper.material.dispose();
// //     // }

// //     // // Create a new Box3 based on the selected mesh.
// //     // const box = new THREE.Box3().setFromObject(modelObj.selectedRegularFoamMesh);
// //     // // Create a new Box3Helper with a red color.
// //     // modelObj.selectedRegularFoamMeshBoundingBoxHelper = new THREE.Box3Helper(box, 0xff0000);
// //     // // (Optionally) You may add the helper back to the scene if needed.
// //     // // visualizer.scene.add(modelObj.selectedRegularFoamMeshBoundingBoxHelper);
// // }


