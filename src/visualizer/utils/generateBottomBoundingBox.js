// // generate the base constraints based on the bottom boundary of the model
// sliceMeshBelow(z_threshold = 0.1) {
//     const geometry = this.mesh.geometry;
//     const material = this.mesh.material.clone(); // Clone material if necessary to avoid side effects

//     // 使用BVH进行几何裁剪
//     const slicedGeometry = new THREE.BufferGeometry();

//     // 只包含 z < z_threshold 的部分
//     const positionAttribute = geometry.attributes.position;
//     const indices = [];
//     const positions = [];

//     for (let i = 0; i < positionAttribute.count; i += 3) {
//         const z1 = positionAttribute.getZ(i);
//         const z2 = positionAttribute.getZ(i + 1);
//         const z3 = positionAttribute.getZ(i + 2);

//         // Check if all vertices of the face are below the threshold
//         if (z1 < z_threshold && z2 < z_threshold && z3 < z_threshold) {
//             indices.push(positions.length / 3, positions.length / 3 + 1, positions.length / 3 + 2);
//             positions.push(
//                 positionAttribute.getX(i), positionAttribute.getY(i), positionAttribute.getZ(i),
//                 positionAttribute.getX(i + 1), positionAttribute.getY(i + 1), positionAttribute.getZ(i + 1),
//                 positionAttribute.getX(i + 2), positionAttribute.getY(i + 2), positionAttribute.getZ(i + 2)
//             );
//         }
//     }

//     slicedGeometry.setIndex(indices);
//     slicedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

//     // Generate the mesh
//     const slicedMesh = new THREE.Mesh(slicedGeometry, material);

//     // translate the sliced mesh
//     slicedMesh.position.set(this.targetX, this.targetY, this.targetZ);

//     // Calculate bounding box and visualize it
//     const bbox = new THREE.Box3().setFromObject(slicedMesh);
//     const bboxHelper = new THREE.Box3Helper(bbox, 0xff0000); // Red bounding box
//     this.scene.add(bboxHelper);

//     // store the four corner points of the bounding box to this.constrainBounding
//     this.constrainBounding = [
//         new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.min.z),
//         new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.min.z),
//         new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.min.z),
//         new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.min.z)
//     ];

//     return slicedMesh;
// }