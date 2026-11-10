import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { getRequiredZOffset } from './collision';

const HEAD = { min: new THREE.Vector2(-40, -15), max: new THREE.Vector2(35, 70) };
const NOZZLE_LENGTH = 4.5;
const TOLERANCE = 0.02;

/** A 20 x 20 x 10 mm block with a 10 x 10 x 30 mm post beside it, all sitting on z = 0. */
function blockWithPost(): THREE.BufferGeometry {
    const block = new THREE.BoxGeometry(20, 20, 10).translate(0, 0, 5).toNonIndexed();
    const post = new THREE.BoxGeometry(10, 10, 30).translate(25, 0, 15).toNonIndexed();
    const positions = new Float32Array([
        ...(block.getAttribute('position').array as Float32Array),
        ...(post.getAttribute('position').array as Float32Array),
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
}

describe('getRequiredZOffset (G12)', () => {
    const meshPosition = new THREE.Vector3(100, 100, 0);

    it('reports no offset when the head clears the mesh', () => {
        // Printing well above everything: nozzle at z = 40, post top at 30.
        const result = getRequiredZOffset(blockWithPost(), meshPosition, [new THREE.Vector3(100, 100, 40)], NOZZLE_LENGTH, HEAD, TOLERANCE);
        expect(result).toEqual({ requiredOffset: 0, resolved: true });
    });

    it('finds how far to raise the path so the head clears a taller neighbour', () => {
        // Nozzle on top of the block (z = 12); the head body (from z = 16.5 up) would hit the post (top at 30).
        const result = getRequiredZOffset(blockWithPost(), meshPosition, [new THREE.Vector3(100, 100, 12)], NOZZLE_LENGTH, HEAD, TOLERANCE);
        expect(result.resolved).toBe(true);
        // Clear once 12 + 4.5 + offset > 30.
        expect(result.requiredOffset).toBeGreaterThanOrEqual(13.5);
        expect(result.requiredOffset).toBeLessThanOrEqual(13.5 + 2 * TOLERANCE);
    });

    it('does not report "no collision" when every probe collides', () => {
        // The nozzle is far below the top of the post, further than the search range can lift it.
        const result = getRequiredZOffset(blockWithPost(), meshPosition, [new THREE.Vector3(100, 100, -20)], NOZZLE_LENGTH, HEAD, TOLERANCE);
        expect(result.resolved).toBe(false);
        expect(result.requiredOffset).toBeGreaterThan(0);
    });

    it('ignores a mesh that is outside the head footprint', () => {
        // 200 mm away in x: nothing of the mesh is under the head.
        const result = getRequiredZOffset(blockWithPost(), meshPosition, [new THREE.Vector3(300, 100, 2)], NOZZLE_LENGTH, HEAD, TOLERANCE);
        expect(result).toEqual({ requiredOffset: 0, resolved: true });
    });

    it('handles empty input', () => {
        expect(getRequiredZOffset(blockWithPost(), meshPosition, [], NOZZLE_LENGTH, HEAD, TOLERANCE).requiredOffset).toBe(0);
        expect(getRequiredZOffset(new THREE.BufferGeometry(), meshPosition, [new THREE.Vector3()], NOZZLE_LENGTH, HEAD, TOLERANCE).requiredOffset).toBe(0);
    });
});
