import * as THREE from 'three';
import type { PathPoint } from './pathTypes';
import type { EverydayModel } from '../types/modelTypes';

/**
 * Facts about one model that the chunk path generator needs but that depend on how the model is
 * placed (scaled, rotated), so they cannot be read off its raw geometry.
 */
export interface ModelContext {
    /** Lowest z of the transformed mesh, in model-local coordinates. Layer 0 starts here. */
    minZ: number;
    /** Highest z of the transformed mesh, in model-local coordinates. */
    maxZ: number;
    /** The XY area the model's SVG gradient is stretched over, in model-local coordinates. */
    gradientBounds: { min: THREE.Vector2; max: THREE.Vector2 };
    /**
     * Set when H* and V* should ramp from their start values at the bottom layer to their end
     * values at the top layer instead of following the SVG gradient. The range is in slice heights,
     * i.e. before any ZOffset or surface draping is applied.
     */
    verticalGradient?: { minZ: number; maxZ: number };
}

/**
 * How a chunk's z values get finished off once every point's hStar is known. Every point is raised
 * by its own ZOffset; when a surface is given the layers are also draped over it rather than being
 * left level with the bed.
 */
export interface LayerHeights {
    /** Nozzle diameter times die swelling for each extruder (by index), which turns a point's hStar into its ZOffset. */
    threadDiameters: number[];
    /** The layer height (mm) shell regions were sliced at. */
    shellLayerHeight: number;
    /** The surface to drape the layers over. Leave it out for flat layers. */
    surface?: {
        /** The surface itself, as columns of sampled points. */
        samplePointMatrix: THREE.Vector3[][];
        /** The top of the model's bounding box, the plane the layers flatten out towards. */
        modelMaxZ: number;
    };
    /** Placement-dependent facts for each model being printed. */
    models: Map<EverydayModel, ModelContext>;
}

/**
 * The part of a model's configuration that decides how a draped stack of layers is spaced.
 */
export interface LayerStack {
    /** Where the model sits on the bed. */
    meshPosition: THREE.Vector3;
    /** Thickness of one layer (mm). Must be positive. */
    deltaZ: number;
    /** Whether the stack flattens out from the surface's curve to a flat plane. */
    curveAugment: boolean;
    /** How many layers the flattening is spread over. */
    totalLayers: number;
    /** With no augment surface, how far above the model's top the flat plane sits. */
    flatLayerZOffset: number;
    /** The surface the stack flattens out to, if one was sampled. */
    augmentSamplePoints?: THREE.Vector3[][];
}

/** Helper for findNearestPoints: index of the first column whose x is not below tx. */
function lowerBoundXs(matrix: THREE.Vector3[][], tx: number): number {
    let lo = 0, hi = matrix.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (matrix[mid][0] && matrix[mid][0].x < tx) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** Helper for findNearestPoints: index of the first point in a column whose y is not below ty. */
function lowerBoundYs(row: THREE.Vector3[], ty: number): number {
    let lo = 0, hi = row.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (row[mid].y < ty) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** Helper for findNearestPoints: squared distance between two points, ignoring z. */
function squaredXYDist(a: THREE.Vector3, b: THREE.Vector3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

/**
 * Finds the k closest points from a sorted matrix to a given point.
 * Will only return up to 4 points, even if K is higher than 4.
 * Won't always return K points even if K is <= 4.
 *
 * @param matrix The sorted matrix of points
 * @param target The point to find the closest points to.
 * @param k How many points should be returned.
 * @returns {THREE.Vector3[]} The nearest points to the target, sorted from lowest to highest distance.
 */
function findNearestPoints(
    matrix: THREE.Vector3[][],
    target: THREE.Vector3,
    k: number
): THREE.Vector3[] {
    const N = matrix.length;
    if (N === 0) return [];

    const xi = lowerBoundXs(matrix, target.x);

    // collect every candidate we check, with its squared distance
    const candidates: { point: THREE.Vector3; dist: number }[] = [];

    // check the two candidate x-slices
    for (const sliceIdx of [xi - 1, xi]) {
        if (sliceIdx < 0 || sliceIdx >= N) continue;
        const column = matrix[sliceIdx];

        // within that column find the y bracket
        const yj = lowerBoundYs(column, target.y);
        for (const rowIdx of [yj - 1, yj]) {
            if (rowIdx < 0 || rowIdx >= column.length) continue;
            const pt = column[rowIdx];
            const d = squaredXYDist(pt, target);
            candidates.push({ point: pt, dist: d });
        }
    }

    return candidates
        .sort((a, b) => a.dist - b.dist)
        .slice(0, k)
        .map(c => c.point);
}

/**
 * Given a plane defined by 3 points, determines the z value at a given x y value.
 *
 * @param p1 The first point of the plane.
 * @param p2 The second point of the plane.
 * @param p3 The third point of the plane.
 * @param x The x value of the point to find the z value of.
 * @param y The y value of the point to find the z value of.
 * @returns {number} The z value at the given x y coordinates. Will return NaN if the given points
 *                   defining the plane are all on a line (meaning no clear plane is made).
 */
function getPlaneHeightAtXY(
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    x: number,
    y: number,
): number {
    const plane = new THREE.Plane().setFromCoplanarPoints(p1, p2, p3).normalize();

    const { x: nx, y: ny, z: nz } = plane.normal;
    const d = plane.constant;

    if (!(Math.abs(nz) > 0.0001)) {
        return NaN;
    }

    return -(nx * x + ny * y + d) / nz;
}

/**
 * Given a sorted matrix of points making up a surface, finds the
 * height of a point if projected downwards onto that matrix.
 *
 * @param {THREE.Vector3[][]} matrix The sorted matrix of points, with columns having a constant x value.
 * @param {THREE.Vector3} point The point to find the height of.
 * @returns {number} The height of the point when projected onto the given point matrix. Always finite;
 *                   0 if the matrix holds no points.
 */
export function getPointHeight(
    matrix: THREE.Vector3[][],
    point: THREE.Vector3
): number {
    const nearestPoints = findNearestPoints(matrix, point, 3);
    const closest = new THREE.Vector3();

    if (nearestPoints.length >= 3) {
        const height = getPlaneHeightAtXY(nearestPoints[0], nearestPoints[1], nearestPoints[2], point.x, point.y);
        if (Number.isFinite(height)) {
            return height;
        }
        // The three points are (nearly) on one line, so fall back to the nearest point of that line.
        new THREE.Line3(nearestPoints[0], nearestPoints[2]).closestPointToPoint(point, true, closest);
        return closest.z;
    } else if (nearestPoints.length >= 2) {
        new THREE.Line3(nearestPoints[0], nearestPoints[1]).closestPointToPoint(point, true, closest);
        return closest.z;
    } else if (nearestPoints.length >= 1) {
        return nearestPoints[0].z;
    }

    return 0;
}

/**
 * Finishes off a single point's z, raising it by its own ZOffset and, if a surface was given,
 * lifting it out of its flat slice plane and onto that surface first.
 *
 * With curveAugment on, the layers start out following the curve of the surface and are flattened a
 * little more each layer until the top one is a flat plane; every layer above that stack is spaced a
 * plain deltaZ apart. With it off, the whole stack just follows the surface. A stack of a single
 * layer has nothing to flatten over, so that one layer follows the surface.
 *
 * @param {PathPoint} point The point to raise. Its position must already be in model-placed
 *                          coordinates, and its hStar must already be resolved (gradients included),
 *                          because H* is what sets the height.
 * @param {number} threadDiameter Nozzle diameter times die swelling of the extruder printing the point.
 * @param {LayerStack} stack How the model's layers are stacked and where the model sits.
 * @param {LayerHeights['surface']} surface The surface to drape over, if there is one.
 */
export function applyLayerHeight(
    point: PathPoint,
    threadDiameter: number,
    stack: LayerStack,
    surface?: LayerHeights['surface'],
): void {
    const position = point.point;
    const pointZOffset = point.hStar! * threadDiameter;

    if (!surface) {
        position.setZ(position.z + pointZOffset);
        return;
    }

    const localPosition = position.clone().sub(stack.meshPosition);

    // Height of the surface directly under this point, which the bottom layer sits on.
    const curvedBottomHeight = getPointHeight(surface.samplePointMatrix, localPosition);

    if (!stack.curveAugment) {
        position.setZ(position.z + curvedBottomHeight + pointZOffset);
        return;
    }

    // At least one layer, so the division below can never be 0 / 0 or flip sign.
    const totalLayers = Math.max(1, stack.totalLayers);

    // The plane the stack flattens out to: either the augment surface or a fixed clearance above the model.
    const flatTopHeight = stack.augmentSamplePoints
        ? getPointHeight(stack.augmentSamplePoints, localPosition) + surface.modelMaxZ
        : surface.modelMaxZ + stack.flatLayerZOffset;

    // Split the gap between the two surfaces evenly over the stack, so each layer is a little
    // flatter than the one below it and the last one lands on the flat plane.
    const incrementPerLayer = totalLayers > 1
        ? (flatTopHeight - curvedBottomHeight) / (totalLayers - 1)
        : 0;
    const layerNumber = Math.round(localPosition.z / stack.deltaZ);

    const heightIncrement = layerNumber < totalLayers
        ? incrementPerLayer * layerNumber
        : incrementPerLayer * (totalLayers - 1) + stack.deltaZ * (layerNumber - totalLayers + 1);

    position.setZ(stack.meshPosition.z + curvedBottomHeight + heightIncrement + pointZOffset);
}
