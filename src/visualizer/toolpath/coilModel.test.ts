import { describe, expect, it } from 'vitest';
import {
    COIL_MEASURED_RANGE,
    COIL_MEASUREMENTS,
    COIL_MEASUREMENT_THREAD_DIAMETER,
    LOOP_OVERLAP_FIT,
    LOOP_SIZE_FIT,
    coilDiameter,
    coilOverlap,
    coilPitch,
    coilReach,
    coilWallInset,
    fitLine,
    isCoilMeasured,
} from './coilModel';

const d = COIL_MEASUREMENT_THREAD_DIAMETER;

describe('fitLine', () => {
    it('finds the line through points that lie on one', () => {
        const fit = fitLine([0, 1, 2, 3], [1, 3, 5, 7]);
        expect(fit.slope).toBeCloseTo(2, 9);
        expect(fit.intercept).toBeCloseTo(1, 9);
        expect(fit.largestMiss).toBeCloseTo(0, 9);
    });

    it('reports the furthest point from the line', () => {
        // the middle point is 3 above the line through the outer two, which pulls the line up by 1
        const fit = fitLine([0, 1, 2], [0, 4, 2]);
        expect(fit.slope).toBeCloseTo(1, 9);
        expect(fit.intercept).toBeCloseTo(1, 9);
        expect(fit.largestMiss).toBeCloseTo(2, 9);
    });
});

describe('the measurements', () => {
    it('are the 42 roads of the sweep: seven H*, six V* each', () => {
        expect(COIL_MEASUREMENTS).toHaveLength(42);
        expect(new Set(COIL_MEASUREMENTS.map(m => m.hStar)).size).toBe(7);
        expect(new Set(COIL_MEASUREMENTS.map(m => m.vStar)).size).toBe(6);
        for (const m of COIL_MEASUREMENTS) {
            expect(isCoilMeasured(m.hStar, m.vStar)).toBe(true);
            expect(m.loopOverlap).toBeLessThan(m.loopSize);
        }
        expect(COIL_MEASURED_RANGE.hStar).toEqual({ min: 17.5, max: 47.5 });
    });

    it('show a loop size that follows H* and not V*', () => {
        expect(LOOP_SIZE_FIT.slope).toBeCloseTo(0.1655, 3);
        expect(LOOP_SIZE_FIT.intercept).toBeCloseTo(1.003, 2);
        // read to the nearest 0.25 mm, on loops of 4 to 9 mm
        expect(LOOP_SIZE_FIT.largestMiss).toBeLessThan(0.55);

        // What the line leaves unexplained does not depend on V*: under 0.1 mm across the sweep.
        const left = COIL_MEASUREMENTS.map(m => m.loopSize - (LOOP_SIZE_FIT.slope * m.hStar + LOOP_SIZE_FIT.intercept));
        const { vStar } = COIL_MEASURED_RANGE;
        expect(Math.abs(fitLine(COIL_MEASUREMENTS.map(m => m.vStar), left).slope) * (vStar.max - vStar.min)).toBeLessThan(0.1);
    });

    it('show loops that overlap less the faster the head moves', () => {
        expect(LOOP_OVERLAP_FIT.slope).toBeCloseTo(-5.086, 2);
        expect(LOOP_OVERLAP_FIT.intercept).toBeCloseTo(0.997, 2);
        expect(LOOP_OVERLAP_FIT.largestMiss).toBeLessThan(0.1);
    });
});

describe('coilDiameter and coilReach', () => {
    it('agrees with the coil sizes in the AugPrint paper', () => {
        // "An H* of 20 ... a coil diameter of roughly 4 mm", "An H* of 40 ... roughly 8 mm"
        expect(coilDiameter(20, d)).toBeGreaterThan(3.8);
        expect(coilDiameter(20, d)).toBeLessThan(4.5);
        expect(coilDiameter(40, d)).toBeGreaterThan(7.5);
        expect(coilDiameter(40, d)).toBeLessThan(8.2);
    });

    it('is within its stated miss of every measured loop, and the reach covers them all', () => {
        for (const m of COIL_MEASUREMENTS) {
            expect(Math.abs(coilDiameter(m.hStar, d) - m.loopSize)).toBeLessThanOrEqual(LOOP_SIZE_FIT.largestMiss + 1e-9);
            expect(coilReach(m.hStar, d)).toBeGreaterThanOrEqual(m.loopSize / 2 - 1e-9);
        }
    });

    it('carries the line on below what was measured', () => {
        // The slicer's usual H* of 6 is outside the sweep: about 2 mm loops, 1.3 mm of reach.
        expect(isCoilMeasured(6)).toBe(false);
        expect(coilDiameter(6, d)).toBeCloseTo(2.0, 1);
        expect(coilReach(6, d)).toBeCloseTo(1.26, 1);
        expect(coilDiameter(10, d)).toBeGreaterThan(coilDiameter(6, d));
    });

    it('keeps the loop the same number of thread diameters across for another nozzle', () => {
        expect(coilDiameter(20, 2 * d)).toBeCloseTo(2 * coilDiameter(20, d), 9);
        expect(coilReach(20, 2 * d)).toBeCloseTo(2 * coilReach(20, d), 9);
    });

    it('is never narrower than the thread itself', () => {
        expect(coilDiameter(-100, d)).toBe(d);
    });
});

describe('coilWallInset', () => {
    it('moves the path in by what a loop is wider than the room there is', () => {
        // 2 mm loops with 0.6 mm between the path and the wall: 0.4 mm short on that side
        expect(coilWallInset(6, d, 0.6)).toBeCloseTo(coilDiameter(6, d) / 2 - 0.6, 9);
        expect(coilWallInset(6, d, 0.6)).toBeCloseTo(0.4, 1);
        // the loop as fitted, without the allowance the reach carries
        expect(coilWallInset(6, d, 0)).toBeLessThan(coilReach(6, d));
        expect(coilWallInset(20, d, 0.6)).toBeGreaterThan(coilWallInset(6, d, 0.6));
    });

    it('never moves the path towards the wall', () => {
        expect(coilWallInset(6, d, 5)).toBe(0);
    });
});

describe('coilOverlap and coilPitch', () => {
    it('goes from loops piled on one spot to loops that only just touch', () => {
        expect(coilOverlap(0)).toBeCloseTo(1, 1);
        expect(coilOverlap(0.1)).toBeCloseTo(0.49, 1);
        // past V* of about 0.2 the loops no longer overlap
        expect(coilOverlap(0.2)).toBe(0);
        expect(coilOverlap(1)).toBe(0);
        expect(coilOverlap(-1)).toBe(1);
    });

    it('spaces the loops by the part of each that is not over the one before', () => {
        expect(coilPitch(20, 0.1, d)).toBeCloseTo(coilDiameter(20, d) * (1 - coilOverlap(0.1)), 9);
        // loops that do not overlap are one loop apart
        expect(coilPitch(20, 0.5, d)).toBeCloseTo(coilDiameter(20, d), 9);
        // within a quarter of a loop of every measured road
        for (const m of COIL_MEASUREMENTS) {
            expect(Math.abs(coilPitch(m.hStar, m.vStar, d) - (m.loopSize - m.loopOverlap))).toBeLessThan(0.25 * m.loopSize);
        }
    });

    it('knows what was measured and what was not', () => {
        expect(isCoilMeasured(30)).toBe(true);
        expect(isCoilMeasured(30, 0.1)).toBe(true);
        expect(isCoilMeasured(30, 0.5)).toBe(false);
        expect(isCoilMeasured(60)).toBe(false);
    });
});
