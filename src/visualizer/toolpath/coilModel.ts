// ---------------------------------------------------------------------------------------------
// The coils of viscous thread printing (VTP): how big a loop the thread lays down, how much each
// loop overlaps the one before it, and so how far foam reaches to the side of the nozzle's path.
//
// The thread falls from the nozzle and buckles into loops as it lands (liquid rope coiling). A
// foam "line" is therefore not a line but a road of overlapping loops, as wide as one loop. The
// slicer needs that width wherever it asks what printed foam is in the way of.
//
// The numbers come from the lab's own measurements (SensiPrint shared drive, Foam Classification /
// "high hstar data.csv", photos 17.5.jpg to 47.5.jpg): single roads of NinjaFlex 85A TPU from a
// 0.4 mm nozzle, at H* from 17.5 to 47.5 and V* from 0.067 to 0.15, with the loop size and the
// overlap between loops read off each photo to the nearest 0.25 mm. They show what the lab notes
// say: H* sets the loop size, linearly, and V* does not; V* sets how much the loops overlap.
//
// No DOM here, so it can be unit-tested under Node.
// ---------------------------------------------------------------------------------------------

/** One measured road: the settings it was printed at, and what its loops looked like. */
export interface CoilMeasurement {
    /** H*: nozzle height over the surface, in thread diameters. */
    hStar: number;
    /** V*: print head speed over the speed the thread leaves the nozzle at. */
    vStar: number;
    /** Diameter of a loop (mm), which is also the width of the road. */
    loopSize: number;
    /** How far each loop reaches back over the loop before it (mm). */
    loopOverlap: number;
}

/** The thread diameter (mm) the measurements were made at: a 0.4 mm nozzle with no die swell. */
export const COIL_MEASUREMENT_THREAD_DIAMETER = 0.4;

/** The lab's measurements, as [H*, V*, loop size (mm), loop overlap (mm)]. */
const MEASURED: [number, number, number, number][] = [
    [17.5, 0.0667, 4, 3], [17.5, 0.0833, 4, 2.5], [17.5, 0.1, 3.75, 2], [17.5, 0.1167, 3.75, 1.5], [17.5, 0.1333, 3.75, 1], [17.5, 0.15, 4, 0.75],
    [22.5, 0.0667, 4.5, 3], [22.5, 0.0833, 5, 2.75], [22.5, 0.1, 5, 2.25], [22.5, 0.1167, 4.5, 2], [22.5, 0.1333, 4.75, 1.5], [22.5, 0.15, 4.75, 1],
    [27.5, 0.0667, 5.75, 4], [27.5, 0.0833, 5.5, 3.25], [27.5, 0.1, 5.5, 2.75], [27.5, 0.1167, 5.75, 2.5], [27.5, 0.1333, 5.75, 1.75], [27.5, 0.15, 6, 1.5],
    [32.5, 0.0667, 6.25, 4.25], [32.5, 0.0833, 6.5, 3.5], [32.5, 0.1, 6.25, 3.25], [32.5, 0.1167, 6.5, 2.75], [32.5, 0.1333, 6.25, 2.25], [32.5, 0.15, 6, 1.5],
    [37.5, 0.0667, 7.25, 4.5], [37.5, 0.0833, 7, 4.25], [37.5, 0.1, 6.75, 3.5], [37.5, 0.1167, 7.25, 3], [37.5, 0.1333, 7, 2.5], [37.5, 0.15, 7.25, 1.5],
    [42.5, 0.0667, 8, 4.5], [42.5, 0.0833, 8, 4], [42.5, 0.1, 8, 3.75], [42.5, 0.1167, 8, 3.25], [42.5, 0.1333, 7.5, 2.5], [42.5, 0.15, 8.25, 1.75],
    [47.5, 0.0667, 8.75, 5.25], [47.5, 0.0833, 8.75, 4.75], [47.5, 0.1, 9, 4.5], [47.5, 0.1167, 9.25, 3.75], [47.5, 0.1333, 9.25, 2.75], [47.5, 0.15, 9, 2.25],
];

/** The lab's measurements of single VTP roads. */
export const COIL_MEASUREMENTS: readonly CoilMeasurement[] = MEASURED.map(
    ([hStar, vStar, loopSize, loopOverlap]) => ({ hStar, vStar, loopSize, loopOverlap }),
);

/** The H* and V* the measurements cover. Outside of it the model is the fitted lines carried on. */
export const COIL_MEASURED_RANGE = {
    hStar: { min: 17.5, max: 47.5 },
    vStar: { min: 0.0667, max: 0.15 },
} as const;

/** A straight line through measurements, and how well it fits them. */
export interface LineFit {
    slope: number;
    intercept: number;
    /** The furthest any measurement is from the line. */
    largestMiss: number;
}

/**
 * Fits a straight line to points by least squares.
 *
 * @param {number[]} xs The x of each point.
 * @param {number[]} ys The y of each point.
 * @returns {LineFit} The line, and the furthest any point is from it.
 */
export function fitLine(xs: number[], ys: number[]): LineFit {
    const n = xs.length;
    const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
    const meanY = ys.reduce((sum, y) => sum + y, 0) / n;
    let covariance = 0, variance = 0;
    for (let i = 0; i < n; i++) {
        covariance += (xs[i] - meanX) * (ys[i] - meanY);
        variance += (xs[i] - meanX) ** 2;
    }
    const slope = covariance / variance;
    const intercept = meanY - slope * meanX;
    let largestMiss = 0;
    for (let i = 0; i < n; i++) {
        largestMiss = Math.max(largestMiss, Math.abs(ys[i] - (slope * xs[i] + intercept)));
    }
    return { slope, intercept, largestMiss };
}

/**
 * Loop size (mm) against H*, at the thread diameter of the measurements:
 * about 0.165 mm per H* plus 1.0 mm, within 0.54 mm of every measurement.
 */
export const LOOP_SIZE_FIT: LineFit = fitLine(
    COIL_MEASUREMENTS.map(m => m.hStar),
    COIL_MEASUREMENTS.map(m => m.loopSize),
);

/**
 * The share of a loop that lies over the loop before it, against V*: about 1 - 5.1 V*. It
 * reaches 0 near V* = 0.2, where the loops no longer overlap.
 */
export const LOOP_OVERLAP_FIT: LineFit = fitLine(
    COIL_MEASUREMENTS.map(m => m.vStar),
    COIL_MEASUREMENTS.map(m => m.loopOverlap / m.loopSize),
);

/**
 * The diameter of the loops the thread lays down, which is the width of a foam road.
 *
 * The measurements were all made with one thread diameter. For another one, the loop is taken to
 * keep its size in thread diameters at the same H*: with H = H* d, both the fall height and the
 * thread scale together. That is an assumption, not something that was measured.
 *
 * @param {number} hStar H*: nozzle height over the surface, in thread diameters.
 * @param {number} threadDiameter The thread diameter (mm): nozzle diameter times die swell.
 * @returns {number} The loop diameter (mm). Never less than the thread itself.
 */
export function coilDiameter(hStar: number, threadDiameter: number): number {
    const scale = threadDiameter / COIL_MEASUREMENT_THREAD_DIAMETER;
    return Math.max(threadDiameter, scale * (LOOP_SIZE_FIT.slope * hStar + LOOP_SIZE_FIT.intercept));
}

/**
 * How far foam reaches to the side of the nozzle's path: half a loop, plus half of the furthest
 * any measured loop was from the fitted size, so that a loop on the large side is still covered.
 *
 * @param {number} hStar H*: nozzle height over the surface, in thread diameters.
 * @param {number} threadDiameter The thread diameter (mm): nozzle diameter times die swell.
 * @returns {number} The distance (mm) from the path to the edge of the foam road.
 */
export function coilReach(hStar: number, threadDiameter: number): number {
    const scale = threadDiameter / COIL_MEASUREMENT_THREAD_DIAMETER;
    return (coilDiameter(hStar, threadDiameter) + scale * LOOP_SIZE_FIT.largestMiss) / 2;
}

/**
 * How much further in from a wall the nozzle's path has to stay for the coils to end at the wall
 * instead of landing on it: what a loop's radius is short of the room there already is. This is
 * the loop as fitted, without the allowance {@link coilReach} adds, as pulling the foam in too
 * far leaves it loose from the wall.
 *
 * @param {number} hStar H*: nozzle height over the surface, in thread diameters.
 * @param {number} threadDiameter The thread diameter (mm): nozzle diameter times die swell.
 * @param {number} wallGap How far (mm) the path already is from the face of the wall.
 * @returns {number} How far (mm) to move the path away from the wall. Never negative.
 */
export function coilWallInset(hStar: number, threadDiameter: number, wallGap: number): number {
    return Math.max(0, coilDiameter(hStar, threadDiameter) / 2 - wallGap);
}

/**
 * The share of each loop that lies over the loop before it: 1 for loops piled on one spot, 0 for
 * loops that only just touch.
 *
 * @param {number} vStar V*: print head speed over the speed the thread leaves the nozzle at.
 * @returns {number} The overlap, from 0 to 1.
 */
export function coilOverlap(vStar: number): number {
    return Math.min(1, Math.max(0, LOOP_OVERLAP_FIT.slope * vStar + LOOP_OVERLAP_FIT.intercept));
}

/**
 * How far along the path one loop is from the next: the part of a loop that does not lie over
 * the loop before it.
 *
 * @param {number} hStar H*: nozzle height over the surface, in thread diameters.
 * @param {number} vStar V*: print head speed over the speed the thread leaves the nozzle at.
 * @param {number} threadDiameter The thread diameter (mm): nozzle diameter times die swell.
 * @returns {number} The distance (mm) between successive loops.
 */
export function coilPitch(hStar: number, vStar: number, threadDiameter: number): number {
    return coilDiameter(hStar, threadDiameter) * (1 - coilOverlap(vStar));
}

/**
 * Whether settings lie inside what was measured. Outside of it the sizes above are the fitted
 * lines carried on, which nothing has checked: the slicer's usual H* of about 6 is one such.
 *
 * @param {number} hStar H*: nozzle height over the surface, in thread diameters.
 * @param {number} [vStar] V*, if the overlap or the pitch is what is being asked about.
 * @returns {boolean} True if H* (and V*, if given) is within the measured range.
 */
export function isCoilMeasured(hStar: number, vStar?: number): boolean {
    const { hStar: h, vStar: v } = COIL_MEASURED_RANGE;
    return hStar >= h.min && hStar <= h.max && (vStar === undefined || (vStar >= v.min && vStar <= v.max));
}
