import { describe, expect, it } from 'vitest';
import { hStarForLayerHeight, layerHeightAt, lowestHStar, thinnestLayer, type NominalLayer } from './layerModel';

/** The defaults: H* 6, ΔZ 1.7 mm, a 0.4 mm thread. */
const NOMINAL: NominalLayer = { hStar: 6, deltaZ: 1.7 };
const D = 0.4;
const DEFAULT_LAYER = { minHStar: 3, response: 1 };
/** A wall line and the nozzle clearance. */
const GAP = 0.2;

describe('layerHeightAt', () => {
    it('gives a whole layer at the nominal H*', () => {
        expect(layerHeightAt(6, NOMINAL, D, 1)).toBeCloseTo(1.7, 9);
        expect(layerHeightAt(6, NOMINAL, D, 0.5)).toBeCloseTo(1.7, 9);
    });

    it('thins the layer by g′ times what the nozzle is lowered', () => {
        // H* 3 lowers the nozzle 1.2 mm: the plan's thinnest layer, 0.5 mm, at g′ = 1.
        expect(layerHeightAt(3, NOMINAL, D, 1)).toBeCloseTo(0.5, 9);
        expect(layerHeightAt(3, NOMINAL, D, 0.5)).toBeCloseTo(1.1, 9);
    });
});

describe('hStarForLayerHeight', () => {
    const lowest = lowestHStar(NOMINAL, D, DEFAULT_LAYER, GAP);

    it('leaves H* alone where there is a whole layer of room or more', () => {
        expect(hStarForLayerHeight(1.7, NOMINAL, D, 1, lowest)).toBe(6);
        expect(hStarForLayerHeight(5, NOMINAL, D, 1, lowest)).toBe(6);
    });

    it('gives the H* whose layer is as thick as the room', () => {
        // 1.1 mm of room: H* 4.5, as in the plan.
        expect(hStarForLayerHeight(1.1, NOMINAL, D, 1, lowest)).toBeCloseTo(4.5, 9);
        for (const room of [0.5, 0.8, 1.3, 1.69]) {
            const hStar = hStarForLayerHeight(room, NOMINAL, D, 1, lowest);
            expect(layerHeightAt(hStar, NOMINAL, D, 1)).toBeCloseTo(room, 9);
        }
    });

    it('does not go below the lowest H*', () => {
        expect(hStarForLayerHeight(0.2, NOMINAL, D, 1, lowest)).toBe(3);
        expect(hStarForLayerHeight(-1, NOMINAL, D, 1, lowest)).toBe(3);
    });

    it('lowers the nozzle further for the same room when the layer responds less', () => {
        const half = { minHStar: 0, response: 0.5 };
        const halfLowest = lowestHStar(NOMINAL, D, half, GAP);
        // 0.4 mm thinner at g′ = 0.5 takes 0.8 mm of nozzle, not 0.4.
        const hStar = hStarForLayerHeight(1.3, NOMINAL, D, 0.5, halfLowest);
        expect(hStar).toBeCloseTo(4, 9);
        expect(layerHeightAt(hStar, NOMINAL, D, 0.5)).toBeCloseTo(1.3, 9);
    });
});

describe('lowestHStar', () => {
    it('is the extruder\'s Lowest H* when the layer follows the nozzle', () => {
        // At g′ = 1 the nozzle keeps 2.4 − 1.7 = 0.7 mm above the foam however low it goes.
        expect(lowestHStar(NOMINAL, D, DEFAULT_LAYER, GAP)).toBe(3);
    });

    it('stops where the nozzle would come closer than the gap to the foam it lays', () => {
        // At g′ = 0.5 the gap shrinks by 0.2 mm per H*: from 0.7 mm to 0.2 mm at H* 3.5.
        const lowest = lowestHStar(NOMINAL, D, { minHStar: 0, response: 0.5 }, GAP);
        expect(lowest).toBeCloseTo(3.5, 9);
        expect(lowest * D - layerHeightAt(lowest, NOMINAL, D, 0.5)).toBeCloseTo(GAP, 9);
    });

    it('does not thin a layer whose nozzle is already that close, unless the layer follows the nozzle', () => {
        const close: NominalLayer = { hStar: 4.5, deltaZ: 1.7 };
        expect(lowestHStar(close, D, { minHStar: 3, response: 0.5 }, GAP)).toBe(4.5);
        expect(lowestHStar(close, D, { minHStar: 3, response: 1 }, GAP)).toBe(3);
    });

    it('is never above the nominal H*', () => {
        expect(lowestHStar({ hStar: 2, deltaZ: 1.7 }, D, DEFAULT_LAYER, GAP)).toBe(2);
    });
});

describe('thinnestLayer', () => {
    it('is the layer the lowest H* gives', () => {
        expect(thinnestLayer(NOMINAL, D, 1, 3)).toBeCloseTo(0.5, 9);
    });

    it('is never thinner than a thread, nor thicker than a layer', () => {
        // H* 12 lowered to 3 would give a layer thinner than nothing.
        expect(thinnestLayer({ hStar: 12, deltaZ: 1.7 }, D, 1, 3)).toBe(D);
        expect(thinnestLayer({ hStar: 2, deltaZ: 1.7 }, D, 1, 2)).toBe(1.7);
    });
});
