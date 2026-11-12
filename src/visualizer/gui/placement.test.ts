import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { dropMeshToBed } from './placement';

describe('dropMeshToBed', () => {
    it('rests the lowest vertex on the bed when the mesh is turned at an angle', () => {
        // An octahedron's bounding box corners stick out well past its vertices once it is turned.
        const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(10));
        mesh.rotation.x = Math.PI / 4;
        mesh.scale.set(1, 1, 2);
        mesh.position.set(30, 40, 50);

        dropMeshToBed(mesh);

        mesh.updateMatrixWorld(true);
        const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
        const vertex = new THREE.Vector3();
        let lowest = Infinity;
        for (let i = 0; i < position.count; i++) {
            lowest = Math.min(lowest, vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).z);
        }
        expect(lowest).toBeCloseTo(0, 6);
        expect(mesh.position.x).toBe(30);
        expect(mesh.position.y).toBe(40);
    });
});
