import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyLayerHeight, getPointHeight, LayerStack } from './layerHeights';
import type { PathPoint } from './pathTypes';

/** A gently sloped surface sampled on a 5 mm grid: z = 2 + 0.1 * x. Columns have constant x. */
function slopedSurface(): THREE.Vector3[][] {
    const columns: THREE.Vector3[][] = [];
    for (let x = 0; x <= 20; x += 5) {
        const column: THREE.Vector3[] = [];
        for (let y = 0; y <= 20; y += 5) {
            column.push(new THREE.Vector3(x, y, 2 + 0.1 * x));
        }
        columns.push(column);
    }
    return columns;
}

function stackOf(totalLayers: number, extra: Partial<LayerStack> = {}): LayerStack {
    return {
        meshPosition: new THREE.Vector3(100, 100, 0),
        deltaZ: 1.7,
        curveAugment: true,
        totalLayers,
        flatLayerZOffset: 3,
        ...extra,
    };
}

/** A point of the given layer, in bed coordinates, as makeChunkPath hands it over. */
function pointOnLayer(layer: number, hStar = 6): PathPoint {
    return { point: new THREE.Vector3(107, 108, layer * 1.7), hStar, vStar: 0.15, edot: 50 };
}

const surface = { samplePointMatrix: slopedSurface(), modelMaxZ: 4 };
const THREAD_DIAMETER = 0.4;

describe('applyLayerHeight', () => {
    it('gives a finite height for curve augment with a single layer (G3)', () => {
        const point = pointOnLayer(0);
        applyLayerHeight(point, THREAD_DIAMETER, stackOf(1), surface);

        expect(Number.isFinite(point.point.z)).toBe(true);
        // One layer has nothing to flatten over: it follows the surface (2 + 0.1 * 7) plus its ZOffset.
        expect(point.point.z).toBeCloseTo(2.7 + 6 * THREAD_DIAMETER, 6);
    });

    it('gives finite heights for a stack of zero layers and for layers above the stack', () => {
        for (const totalLayers of [0, 1, 2]) {
            for (const layer of [0, 1, 2, 3]) {
                const point = pointOnLayer(layer);
                applyLayerHeight(point, THREAD_DIAMETER, stackOf(totalLayers), surface);
                expect(Number.isFinite(point.point.z)).toBe(true);
            }
        }
    });

    it('flattens from the surface to the flat plane over the stack', () => {
        const bottom = pointOnLayer(0);
        const top = pointOnLayer(2);
        applyLayerHeight(bottom, THREAD_DIAMETER, stackOf(3), surface);
        applyLayerHeight(top, THREAD_DIAMETER, stackOf(3), surface);

        expect(bottom.point.z).toBeCloseTo(2.7 + 2.4, 6);
        // The top layer lands on modelMaxZ + flatLayerZOffset.
        expect(top.point.z).toBeCloseTo(4 + 3 + 2.4, 6);
    });

    it('raises a point by its own H*, so a gradient in H* changes Z (G8)', () => {
        const low = pointOnLayer(1, 6);
        const high = pointOnLayer(1, 9);
        applyLayerHeight(low, THREAD_DIAMETER, stackOf(3), surface);
        applyLayerHeight(high, THREAD_DIAMETER, stackOf(3), surface);
        expect(high.point.z - low.point.z).toBeCloseTo(3 * THREAD_DIAMETER, 6);

        // Without a surface as well.
        const flatLow = pointOnLayer(1, 6);
        const flatHigh = pointOnLayer(1, 9);
        applyLayerHeight(flatLow, THREAD_DIAMETER, stackOf(3));
        applyLayerHeight(flatHigh, THREAD_DIAMETER, stackOf(3));
        expect(flatLow.point.z).toBeCloseTo(1.7 + 2.4, 6);
        expect(flatHigh.point.z - flatLow.point.z).toBeCloseTo(3 * THREAD_DIAMETER, 6);
    });
});

describe('getPointHeight', () => {
    it('interpolates the surface under a point', () => {
        expect(getPointHeight(slopedSurface(), new THREE.Vector3(7, 8, 0))).toBeCloseTo(2.7, 6);
    });

    it('returns a finite height for degenerate surfaces', () => {
        expect(getPointHeight([], new THREE.Vector3(1, 1, 0))).toBe(0);
        expect(getPointHeight([[new THREE.Vector3(0, 0, 3)]], new THREE.Vector3(1, 1, 0))).toBe(3);
        // A single column: every candidate point is on one line.
        const column = [[new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 5, 2), new THREE.Vector3(0, 10, 3)]];
        expect(Number.isFinite(getPointHeight(column, new THREE.Vector3(2, 4, 0)))).toBe(true);
        // A surface at height 0 is a valid height, not a missing one.
        const flat = [
            [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 5, 0)],
            [new THREE.Vector3(5, 0, 0), new THREE.Vector3(5, 5, 0)],
        ];
        expect(getPointHeight(flat, new THREE.Vector3(2, 2, 0))).toBeCloseTo(0, 9);
    });
});
