import * as THREE from 'three';

/**
 * Computes the convex hull of a set of 2D points using the Graham scan algorithm.
 *
 * The hull starts at the lowest point (the leftmost one if several are equally low) and goes
 * round counter clockwise. Points lying on an edge of the hull are left out. The input array
 * is not modified; the hull holds references to the input's points.
 *
 * @param points - An array of THREE.Vector2 representing the input points.
 * @returns The convex hull as an array of THREE.Vector2, or null if the points don't span an
 *          area (fewer than three distinct points, or all of them on one line).
 */
export function getConvexHull(points: THREE.Vector2[]): THREE.Vector2[] | null {
    // Helper: returns orientation of triplet (p, q, r).
    function orientation(p: THREE.Vector2, q: THREE.Vector2, r: THREE.Vector2): number {
        const val = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
        if (val === 0) return 0; // colinear
        return (val > 0) ? 1 : 2; // 1: clockwise, 2: counterclockwise
    }

    // Helper: squared distance between two points.
    function distSq(p1: THREE.Vector2, p2: THREE.Vector2): number {
        return (p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2;
    }

    if (points.length < 3) return null;

    // Choose p0 as the lowest y (and then lowest x if needed)
    let p0 = points[0];
    for (let i = 1, l = points.length; i < l; i++) {
        const p = points[i];
        if (p.y < p0.y || (p.y === p0.y && p.x < p0.x)) {
            p0 = p;
        }
    }

    // Sort the other points by polar angle around p0, on a copy so the caller's array is left
    // alone. Copies of p0 itself are dropped: they have no angle and would confuse the sort.
    const others = points.filter(p => p !== p0 && distSq(p0, p) > 0);
    others.sort((p1, p2) => {
        const o = orientation(p0, p1, p2);
        if (o === 0) {
            // If colinear, the closer point comes first.
            return distSq(p0, p1) - distSq(p0, p2);
        }
        return o === 2 ? -1 : 1;
    });

    // Of the points on the same ray from p0, keep only the farthest.
    const candidates: THREE.Vector2[] = [p0];
    for (let i = 0; i < others.length; i++) {
        while (i < others.length - 1 && orientation(p0, others[i], others[i + 1]) === 0) {
            i++;
        }
        candidates.push(others[i]);
    }

    if (candidates.length < 3) return null; // Not enough points for a hull.

    // Build the convex hull using a stack.
    const hull: THREE.Vector2[] = [candidates[0], candidates[1], candidates[2]];
    for (let i = 3; i < candidates.length; i++) {
        while (hull.length >= 2 && orientation(hull[hull.length - 2], hull[hull.length - 1], candidates[i]) !== 2) {
            hull.pop();
        }
        hull.push(candidates[i]);
    }
    return hull;
}

/**
 * Determines if a ray (represented by a point) crosses a line segment.
 *
 * @param point - A THREE.Vector2 representing the point (ray origin).
 * @param line - An object with 'start' and 'end' as THREE.Vector2.
 * @param prevDirection - A boolean representing the previous segment direction (start.y > end.y).
 * @param thisDirection - A boolean representing the current segment direction.
 * @returns True if the ray crosses the line segment, otherwise false.
 */
export function pointRayCrossesLine(
    point: THREE.Vector2,
    line: { start: THREE.Vector2; end: THREE.Vector2 },
    prevDirection: boolean,
    thisDirection: boolean
): boolean {
    const { start, end } = line;
    const px = point.x, py = point.y;
    const sy = start.y, ey = end.y;

    if (sy === ey) return false; // Horizontal line, no crossing.

    // If point is completely above or below the segment.
    if (py > sy && py > ey) return false;
    if (py < sy && py < ey) return false;

    const sx = start.x, ex = end.x;
    if (px > sx && px > ex) return false; // Right of both endpoints.
    if (px < sx && px < ex) {
        if (py === sy && prevDirection !== thisDirection) return false;
        return true;
    }

    // Check the side using perpendicular projection.
    const dx = ex - sx, dy = ey - sy;
    const perpx = dy, perpy = -dx;
    const pdx = px - sx, pdy = py - sy;
    const dot = perpx * pdx + perpy * pdy;
    return Math.sign(dot) !== Math.sign(perpx);
}

/**
 * Counts how many segments from an array are crossed by a ray at the given point.
 *
 * @param point - A THREE.Vector2 representing the point (ray origin).
 * @param segments - An array of line segments, each with a 'start' and 'end' property (THREE.Vector2).
 * @returns The number of segments that the ray crosses. Zero if there are no segments.
 */
export function pointRayCrossesSegments(
    point: THREE.Vector2,
    segments: { start: THREE.Vector2; end: THREE.Vector2 }[]
): number {
    if (segments.length === 0) return 0;

    let crossings = 0;
    const firstSeg = segments[segments.length - 1];
    let prevDirection = firstSeg.start.y > firstSeg.end.y;
    for (let s = 0, l = segments.length; s < l; s++) {
        const line = segments[s];
        const thisDirection = line.start.y > line.end.y;
        if (pointRayCrossesLine(point, line, prevDirection, thisDirection)) {
            crossings++;
        }
        prevDirection = thisDirection;
    }
    return crossings;
}

/**
 * Checks if two line segments intersect.
 * 
 * Uses the concept of counter-clockwise order (ccw) to determine intersection.
 *
 * @param l1 - The first line segment with properties 'start' and 'end' (THREE.Vector2).
 * @param l2 - The second line segment with properties 'start' and 'end' (THREE.Vector2).
 * @returns True if the line segments intersect, false otherwise.
 */
export function lineCrossesLine(
    l1: { start: THREE.Vector2; end: THREE.Vector2 },
    l2: { start: THREE.Vector2; end: THREE.Vector2 }
): boolean {
    // Helper function to test counter-clockwise order.
    function ccw(A: THREE.Vector2, B: THREE.Vector2, C: THREE.Vector2): boolean {
        return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
    }

    const A = l1.start, B = l1.end, C = l2.start, D = l2.end;
    return ccw(A, C, D) !== ccw(B, C, D) && ccw(A, B, C) !== ccw(A, B, D);
}
