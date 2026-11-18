import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import Printer from '../../printer/Printer';
import { arrangeSpace, dropMeshToBed } from './placement';
import { findFreeSpot, headConflicts, type ArrangeItem } from '../utils/arrange';
import { BOUNDARY_OFFSET } from '../toolpath/toolpathConstants';

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

describe('arrangeSpace with a boundary outline (V3)', () => {
    /** A square outline of a given width, around the object's position. */
    const square = (width: number) => [
        { x: -width / 2, y: -width / 2 }, { x: width / 2, y: -width / 2 },
        { x: width / 2, y: width / 2 }, { x: -width / 2, y: width / 2 },
    ];
    // A 20 mm foam print with its front edge at y = 170, and a 30 mm regular part whose back edge
    // is 15.5 mm in front of it: the head body reaches 15 mm in front of the nozzle, so the part is
    // just out of its reach while the nozzle goes round the foam print's outline.
    const pad: ArrangeItem = { id: 1, outline: square(20), position: { x: 180, y: 180 }, top: 6, foam: true, movable: true };
    const post: ArrangeItem = { id: 2, outline: square(10), position: { x: 180, y: 149.5 }, top: 30, foam: false, movable: true };

    it('reaches as far round a foam print as its boundary outline is printed', () => {
        const printer = new Printer();
        const plain = arrangeSpace(printer).head;
        printer.generateBoundary = true;
        expect(arrangeSpace(printer).head).toEqual({
            minX: plain.minX - BOUNDARY_OFFSET,
            minY: plain.minY - BOUNDARY_OFFSET,
            maxX: plain.maxX + BOUNDARY_OFFSET,
            maxY: plain.maxY + BOUNDARY_OFFSET,
        });
    });

    it('counts a tall part the head would hit while the boundary prints as in the way', () => {
        const printer = new Printer();
        expect(headConflicts([pad, post], arrangeSpace(printer))).toEqual([]);
        printer.generateBoundary = true;
        expect(headConflicts([pad, post], arrangeSpace(printer))).toEqual([[1, 2]]);
    });

    it('places a new tall part clear of the head while the boundary prints', () => {
        const printer = new Printer();
        printer.generateBoundary = true;
        const space = arrangeSpace(printer);
        const spot = findFreeSpot(post, [pad], space, post.position);

        expect(spot).not.toBeNull();
        expect(headConflicts([pad, { ...post, position: spot! }], space)).toEqual([]);
    });
});
