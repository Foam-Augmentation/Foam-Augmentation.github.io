import * as THREE from 'three';
import ClipperLib from 'clipper-lib';
import type Printer from '../../printer/Printer';
import type { PathPoint } from './pathTypes';
import {
    CLIPPER_SCALE,
    connectSegments,
    getHolesAndOuters,
    offsetRegion,
    sliceMeshIntoLayers,
    PolygonWithHoles,
} from '../utils/TreeSlicer';
import { TRAVEL_CLEARANCE } from './toolpathConstants';
import type { InfillPattern, SupportMode, SupportStyle } from './regularPrintOptions';

// ---------------------------------------------------------------------------------------------
// Regular (solid plastic) slicer: perimeters, solid top/bottom layers and rectilinear infill.
//
// This module is pure: it only needs a Printer and meshes, never the scene or the DOM, so it can
// run under Node. All lengths are in mm unless a name says "scaled" (Clipper's integer units).
// ---------------------------------------------------------------------------------------------

/** The infill of even layers runs at this angle (radians); odd layers use the negative of it. */
const INFILL_ANGLE = Math.PI / 4;
/** An infill density (%) at or above this fills every layer solid. */
const SOLID_INFILL_DENSITY = 100;
/** Fraction of an extrusion width by which the ends of infill lines overlap the innermost perimeter, so the two bond. */
const INFILL_PERIMETER_OVERLAP = 0.15;
/**
 * Exposed (top/bottom) areas narrower than this many extrusion widths are dropped. A vertical wall
 * leaves hair-thin differences between neighbouring layers that no infill line fits into.
 */
const MIN_SOLID_WIDTH_FACTOR = 1;
/** Infill lines shorter than this many extrusion widths are dropped: they would only leave blobs. */
const MIN_INFILL_LINE_FACTOR = 0.5;
/**
 * Two neighbouring infill lines are joined by an extrusion along the wall when their ends are at
 * most this many line spacings apart. Lines at 45 degrees to a wall end about 1.41 spacings apart.
 */
const INFILL_LINK_FACTOR = 2;
/**
 * A link between two infill lines runs along the edge of the area, so its own midpoint sits right
 * on the boundary. The check that it stays in the material is made this far (mm) into the area
 * instead, measured along the two lines. Well above Clipper's 1 micron grid, well below any hole.
 */
const INFILL_LINK_PROBE_DEPTH = 0.01;
/** Layers of different parts whose nozzle heights differ by less than this (mm) are printed as one layer. */
const LAYER_Z_TOLERANCE = 1e-6;
/** Moves shorter than this (mm) are not emitted: they would be zero-length G-code lines. */
const MIN_MOVE_LENGTH = 1e-6;
/** How far (mm) a rounded offset corner may deviate from a true arc. Matches the slicer's offsets. */
const OFFSET_ARC_TOLERANCE = 0.01;
/** Clipper's miter limit. Only applies to mitered joins, but the offsetter still needs a value. */
const OFFSET_MITER_LIMIT = 2;

/** How one model is printed as an ordinary solid plastic part. */
export interface RegularPrintConfig {
    /** Layer height (mm). */
    layerHeight: number;
    /** Number of wall loops around every island and hole. */
    perimeters: number;
    /** Sparse infill density, 0-100 (%). 0 leaves the inside empty, 100 fills every layer solid. */
    infillDensity: number;
    /** Number of solid layers under every top surface and over every bottom surface. */
    topBottomLayers: number;
    /** Index into `printer.extruders` of the extruder that prints the part. */
    extruder: number;
    /** Head speed (mm/min) of extrusion moves. Travel moves use the extruder's travel speed. */
    printSpeed: number;

    // The settings below are only used when the desktop app slices with PrusaSlicer (see
    // prusaGcode.ts). The built-in slicer ignores them.

    /** Thickness (mm) of the first layer. */
    firstLayerHeight: number;
    /** Head speed (mm/min) of every move on the first layer. Ignored while `useProfileSpeeds` is set. */
    firstLayerSpeed: number;
    /**
     * Use the speeds of the user's PrusaSlicer profile (or PrusaSlicer's defaults) instead of
     * `printSpeed` and `firstLayerSpeed`.
     */
    useProfileSpeeds: boolean;
    /** Pattern of the sparse infill. */
    infillPattern: InfillPattern;
    /** Where supports are printed. */
    supports: SupportMode;
    /** What the supports look like. */
    supportStyle: SupportStyle;
    /**
     * Surfaces flatter than this angle (degrees from the bed) get support. 0 lets PrusaSlicer
     * decide from how far each layer overhangs the one below.
     */
    supportThreshold: number;
    /** Width (mm) of the brim around the part's first layer. 0 prints none. */
    brimWidth: number;
}

/**
 * A sensible starting point for a regular print: 0.2 mm layers, 2 walls, 20 % infill, 4 solid layers.
 * The PrusaSlicer-only settings follow PrusaSlicer's own profile for the Prusa XL.
 */
export const DEFAULT_REGULAR_CONFIG: RegularPrintConfig = {
    layerHeight: 0.2,
    perimeters: 2,
    infillDensity: 20,
    topBottomLayers: 4,
    extruder: 0,
    printSpeed: 1800,
    firstLayerHeight: 0.2,
    firstLayerSpeed: 1500,
    useProfileSpeeds: false,
    infillPattern: 'grid',
    supports: 'none',
    supportStyle: 'snug',
    supportThreshold: 45,
    brimWidth: 0,
};

/** One model to print as a regular part. */
export interface RegularPart {
    /**
     * The mesh to slice. Only its geometry is read, as it is: the mesh's own position, rotation
     * and scale are NOT applied here, so bake them into the geometry first (getTransformedMesh
     * bakes rotation and scale but leaves the position out; pass that as `offset`).
     */
    mesh: THREE.Mesh;
    /** How to print it. */
    config: RegularPrintConfig;
    /** Added to every point of the part's toolpath (mm). Defaults to no offset. */
    offset?: THREE.Vector3;
    /** What to call the part in error messages. Defaults to "Part N". */
    name?: string;
}

/** A 2D point in mm. */
interface Point2 {
    x: number;
    y: number;
}

/** A closed loop of 2D points (the last point connects back to the first). */
type Loop = Point2[];

/** One layer of one part, sliced and waiting to be turned into a path. */
interface PartLayer {
    /** Index of the part in the list passed to generateRegularToolpath. */
    partIndex: number;
    /** Index of the layer within its part, 0 being the lowest. */
    layerIndex: number;
    /** The height (mm) the nozzle prints this layer at, offset included. */
    nozzleZ: number;
    /** The separate pieces of material in this layer, each with its holes. */
    islands: PolygonWithHoles[];
    /** The whole layer's material as Clipper paths, used to compare it with other layers. */
    outline: ClipperLib.Paths;
}

/** Everything about a part that stays the same for all of its layers. */
interface PartContext {
    config: RegularPrintConfig;
    /** The width (mm) of one extruded line: the thread diameter of the part's extruder. */
    lineWidth: number;
    /** The x/y offset (mm) added to every point. */
    offset: Point2;
}

/** Where the print head is while a toolpath is being built. Null before the first move. */
interface HeadState {
    position: THREE.Vector3 | null;
}

/** A straight infill line, and which scan row it was cut from. */
interface InfillLine {
    row: number;
    start: Point2;
    end: Point2;
    used: boolean;
}

/**
 * Throws a readable error if a part's configuration cannot be printed.
 *
 * @param {Printer} printer The printer, for its extruders.
 * @param {RegularPrintConfig} config The configuration to check.
 * @param {string} name What to call the part in the error message.
 * @throws {Error} If any value is missing, not finite or out of range.
 */
export function validateRegularConfig(printer: Printer, config: RegularPrintConfig, name: string): void {
    const fail = (problem: string): never => {
        throw new Error(`Regular print settings of "${name}": ${problem}`);
    };
    const isWholeNumber = (value: number) => Number.isInteger(value) && value >= 0;

    if (!Number.isInteger(config.extruder) || !printer.extruders[config.extruder]) {
        fail(`extruder ${config.extruder} does not exist (the printer has ${printer.extruders.length}).`);
    }
    if (!Number.isFinite(config.layerHeight) || config.layerHeight <= 0) {
        fail(`layer height must be greater than 0 (it is ${config.layerHeight}).`);
    }
    // A layer taller than the nozzle is wide cannot be squashed onto the layer below it.
    const nozzleDiameter = printer.extruders[config.extruder].nozzleDiameter;
    if (config.layerHeight > nozzleDiameter) {
        fail(`layer height (${config.layerHeight} mm) cannot be more than the nozzle diameter (${nozzleDiameter} mm).`);
    }
    if (!isWholeNumber(config.perimeters)) {
        fail(`perimeters must be a whole number of 0 or more (it is ${config.perimeters}).`);
    }
    if (!isWholeNumber(config.topBottomLayers)) {
        fail(`top/bottom layers must be a whole number of 0 or more (it is ${config.topBottomLayers}).`);
    }
    if (!Number.isFinite(config.infillDensity) || config.infillDensity < 0 || config.infillDensity > SOLID_INFILL_DENSITY) {
        fail(`infill density must be between 0 and ${SOLID_INFILL_DENSITY} % (it is ${config.infillDensity}).`);
    }
    if (!Number.isFinite(config.printSpeed) || config.printSpeed <= 0) {
        fail(`print speed must be greater than 0 (it is ${config.printSpeed}).`);
    }
    if (!(printer.threadDiameter(config.extruder) > 0)) {
        fail(`extruder ${config.extruder} has no usable nozzle diameter / die swelling.`);
    }
}

/**
 * Turns contours in mm into Clipper paths.
 *
 * @param {Point2[][]} loops The contours. Only x and y are read, so 3D points work too.
 * @returns {ClipperLib.Paths} The contours in Clipper's scaled integer units.
 */
function toClipperPaths(loops: Point2[][]): ClipperLib.Paths {
    return loops
        .filter(loop => loop.length >= 3)
        .map(loop => loop.map(point => ({
            X: Math.round(point.x * CLIPPER_SCALE),
            Y: Math.round(point.y * CLIPPER_SCALE),
        })));
}

/**
 * Turns Clipper paths back into closed loops in mm.
 *
 * @param {ClipperLib.Paths} paths The paths in Clipper's scaled integer units.
 * @returns {Loop[]} The loops in mm.
 */
function fromClipperPaths(paths: ClipperLib.Paths): Loop[] {
    return paths
        .filter(path => path.length >= 3)
        .map(path => path.map(point => ({ x: point.X / CLIPPER_SCALE, y: point.Y / CLIPPER_SCALE })));
}

/**
 * Runs one boolean operation on two shapes. Both are read with the even-odd rule, so a contour
 * inside another is a hole whichever way it winds.
 *
 * @param {ClipperLib.ClipType} operation Which operation to run.
 * @param {ClipperLib.Paths} subject The shape operated on.
 * @param {ClipperLib.Paths} clip The shape it is combined with.
 * @returns {ClipperLib.Paths} The result: outers wind counter clockwise, holes clockwise, nothing overlaps.
 * @throws {Error} If Clipper cannot process the shapes.
 */
function clipShapes(
    operation: ClipperLib.ClipType,
    subject: ClipperLib.Paths,
    clip: ClipperLib.Paths,
): ClipperLib.Paths {
    const clipper = new ClipperLib.Clipper();
    // AddPaths reports whether it kept anything: paths that collapse to a point or a line once
    // rounded to Clipper's grid (the tip of a dome, say) are dropped.
    const hasSubject = clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
    const hasClip = clipper.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
    if (!hasSubject && !hasClip) {
        return []; // Clipper reports failure for an empty input, but the answer is simply "nothing"
    }

    const solution: ClipperLib.Paths = [];
    const succeeded = clipper.Execute(
        operation,
        solution,
        ClipperLib.PolyFillType.pftEvenOdd,
        ClipperLib.PolyFillType.pftEvenOdd,
    );
    if (!succeeded) {
        throw new Error('The regular slicer could not combine two layer outlines.');
    }
    return solution;
}

/**
 * Grows (or, with a negative distance, shrinks) a shape that came out of {@link clipShapes}.
 *
 * @param {ClipperLib.Paths} paths The shape; outers must wind opposite to holes.
 * @param {number} distance How far to grow the material, in mm.
 * @returns {ClipperLib.Paths} The offset shape.
 */
function offsetShape(paths: ClipperLib.Paths, distance: number): ClipperLib.Paths {
    const offsetter = new ClipperLib.ClipperOffset(OFFSET_MITER_LIMIT, OFFSET_ARC_TOLERANCE * CLIPPER_SCALE);
    for (const path of paths) {
        offsetter.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    }
    const solution: ClipperLib.Paths = [];
    offsetter.Execute(solution, distance * CLIPPER_SCALE);
    return solution;
}

/**
 * Turns regions (outer contour plus holes) into one Clipper shape.
 *
 * @param {PolygonWithHoles[]} polygons The regions.
 * @returns {ClipperLib.Paths} Every outer and hole contour as Clipper paths.
 */
function polygonsToShape(polygons: PolygonWithHoles[]): ClipperLib.Paths {
    const loops: Point2[][] = [];
    for (const polygon of polygons) {
        loops.push(polygon.outer, ...polygon.holes);
    }
    return toClipperPaths(loops);
}

/**
 * Slices one part into layers. Layer k covers the band from k to k + 1 layer heights above the
 * bottom of the mesh; its outline is cut at the bottom of that band (where sliceMeshIntoLayers
 * cuts) and it is printed with the nozzle at the top of the band.
 *
 * @param {RegularPart} part The part to slice.
 * @param {number} partIndex The part's index in the list being printed.
 * @returns {PartLayer[]} The layers that contain any material, lowest first.
 * @throws {Error} If the layer height would give an absurd number of layers.
 */
function slicePart(part: RegularPart, partIndex: number): PartLayer[] {
    const geometry = part.mesh.geometry as THREE.BufferGeometry;
    if (!geometry.attributes.position) {
        return [];
    }
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox!;
    if (bounds.isEmpty() || !Number.isFinite(bounds.min.z) || !Number.isFinite(bounds.max.z)) {
        return []; // a mesh without (usable) vertices has nothing to slice
    }

    const layerHeight = part.config.layerHeight;
    const baseZ = bounds.min.z + (part.offset?.z ?? 0);
    const layers: PartLayer[] = [];

    sliceMeshIntoLayers(part.mesh, layerHeight).forEach((slice, layerIndex) => {
        const contours = connectSegments(slice.segments).filter(contour => contour.length >= 3);
        if (!contours.length) {
            return;
        }
        // Normalised with a union, so later boolean operations get clean, non-overlapping paths.
        const outline = clipShapes(ClipperLib.ClipType.ctUnion, toClipperPaths(contours), []);
        if (!outline.length) {
            return;
        }
        layers.push({
            partIndex,
            layerIndex,
            // From the layer index rather than the slicing plane, so rounding does not build up.
            nozzleZ: baseZ + (layerIndex + 1) * layerHeight,
            islands: getHolesAndOuters(contours),
            outline,
        });
    });

    return layers;
}

/**
 * Finds the part of a layer that has material both in every one of the `count` layers below it
 * and in every one of the `count` layers above it. Whatever of the layer is NOT in here is within
 * `count` layers of a bottom or top surface and has to be printed solid.
 *
 * Layers are matched by their index, so a gap in the model (a layer with no material) counts as
 * empty, as does anything below the first or above the last layer.
 *
 * @param {Map<number, PartLayer>} layersByIndex The part's layers by layer index.
 * @param {PartLayer} layer The layer being looked at.
 * @param {number} count How many layers each way to look. Must be at least 1.
 * @returns {ClipperLib.Paths} The covered area. Empty if nothing is covered.
 */
function coveredByNeighbours(
    layersByIndex: Map<number, PartLayer>,
    layer: PartLayer,
    count: number,
): ClipperLib.Paths {
    let covered = layer.outline;
    for (let distance = 1; distance <= count; distance++) {
        for (const index of [layer.layerIndex - distance, layer.layerIndex + distance]) {
            const neighbour = layersByIndex.get(index);
            if (!neighbour) {
                return [];
            }
            covered = clipShapes(ClipperLib.ClipType.ctIntersection, covered, neighbour.outline);
            if (!covered.length) {
                return [];
            }
        }
    }
    return covered;
}

/**
 * Splits the area infill may be printed in into the part that has to be solid and the part that
 * gets sparse infill.
 *
 * @param {ClipperLib.Paths} infillArea Where the centre lines of infill may run.
 * @param {ClipperLib.Paths | null} covered The area with material in all nearby layers
 *        (see {@link coveredByNeighbours}), or null if top/bottom layers are switched off.
 * @param {RegularPrintConfig} config The part's configuration.
 * @param {number} lineWidth The extrusion width in mm.
 * @returns {{ solid: ClipperLib.Paths, sparse: ClipperLib.Paths }} The two areas. Sparse is empty at 0 % density.
 */
function splitInfillArea(
    infillArea: ClipperLib.Paths,
    covered: ClipperLib.Paths | null,
    config: RegularPrintConfig,
    lineWidth: number,
): { solid: ClipperLib.Paths, sparse: ClipperLib.Paths } {
    if (config.infillDensity >= SOLID_INFILL_DENSITY) {
        return { solid: infillArea, sparse: [] };
    }

    let solid: ClipperLib.Paths = [];
    if (covered !== null) {
        const exposed = covered.length
            ? clipShapes(ClipperLib.ClipType.ctDifference, infillArea, covered)
            : infillArea;
        // Shrinking and growing back removes strips too thin to hold a line, which vertical walls
        // leave behind because neighbouring layers never match to the last micron.
        const radius = (MIN_SOLID_WIDTH_FACTOR * lineWidth) / 2;
        solid = covered.length ? offsetShape(offsetShape(exposed, -radius), radius) : exposed;
        // Growing back can round a corner slightly past the infill area, so trim it again.
        if (covered.length && solid.length) {
            solid = clipShapes(ClipperLib.ClipType.ctIntersection, solid, infillArea);
        }
    }

    if (config.infillDensity <= 0) {
        return { solid, sparse: [] };
    }
    const sparse = solid.length ? clipShapes(ClipperLib.ClipType.ctDifference, infillArea, solid) : infillArea;
    return { solid, sparse };
}

/**
 * Tests whether a point is inside a shape made of loops, using the even-odd rule: a point inside
 * a hole is outside the shape.
 *
 * @param {Point2} point The point to test.
 * @param {Loop[]} loops The shape's outer and hole loops.
 * @returns {boolean} Whether the point is in the material of the shape.
 */
function isInsideLoops(point: Point2, loops: Loop[]): boolean {
    let inside = false;
    for (const loop of loops) {
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
            const a = loop[i], b = loop[j];
            if ((a.y > point.y) !== (b.y > point.y) &&
                point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
                inside = !inside;
            }
        }
    }
    return inside;
}

/**
 * Cuts parallel infill lines out of a shape. The lines lie on a grid that is fixed to the bed
 * rather than to the shape, so sparse infill lines of different layers stack on top of each other.
 * Lines are clipped with the even-odd rule, so they stop at holes.
 *
 * @param {Loop[]} loops The shape's outer and hole loops.
 * @param {number} spacing The distance between neighbouring lines in mm. Must be positive.
 * @param {number} angle The direction of the lines in radians, counter clockwise from +x.
 * @param {number} minLength Lines shorter than this (mm) are left out.
 * @returns {InfillLine[]} The lines, row by row.
 */
function cutInfillLines(loops: Loop[], spacing: number, angle: number, minLength: number): InfillLine[] {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    // Turn the shape by -angle, so that the infill lines become horizontal scan lines.
    const turned = loops.map(loop => loop.map(point => ({
        x: point.x * cos + point.y * sin,
        y: -point.x * sin + point.y * cos,
    })));
    const turnBack = (x: number, y: number): Point2 => ({ x: x * cos - y * sin, y: x * sin + y * cos });

    let minY = Infinity, maxY = -Infinity;
    for (const loop of turned) {
        for (const point of loop) {
            if (point.y < minY) minY = point.y;
            if (point.y > maxY) maxY = point.y;
        }
    }

    const lines: InfillLine[] = [];
    for (let row = Math.ceil(minY / spacing); row * spacing <= maxY; row++) {
        const y = row * spacing;
        const crossings: number[] = [];
        for (const loop of turned) {
            for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
                const a = loop[j], b = loop[i];
                // A vertex exactly on the scan line counts as below it, so every loop is crossed
                // an even number of times.
                if ((a.y <= y) !== (b.y <= y)) {
                    crossings.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
                }
            }
        }
        crossings.sort((a, b) => a - b);
        for (let i = 0; i + 1 < crossings.length; i += 2) {
            if (crossings[i + 1] - crossings[i] >= minLength) {
                lines.push({ row, start: turnBack(crossings[i], y), end: turnBack(crossings[i + 1], y), used: false });
            }
        }
    }
    return lines;
}

/**
 * Puts infill lines into print order and joins neighbouring ones into zigzags.
 *
 * After a line, the nearest end of an unprinted line in the row above or below is looked for. If
 * it is close enough and the straight link to it stays in the material, the two are joined by an
 * extrusion along the wall. Otherwise the head travels to the nearest remaining line.
 *
 * @param {InfillLine[]} lines The lines to order. Their `used` flags are set.
 * @param {Point2} from Where the head is coming from.
 * @param {number} maxLinkLength The longest link (mm) that may be extruded between two lines.
 * @param {Loop[]} loops The shape the lines were cut from, to keep links out of holes.
 * @returns {Point2[][]} Polylines to extrude; the head travels between them.
 */
function chainInfillLines(lines: InfillLine[], from: Point2, maxLinkLength: number, loops: Loop[]): Point2[][] {
    const rows = new Map<number, InfillLine[]>();
    for (const line of lines) {
        const row = rows.get(line.row);
        if (row) row.push(line); else rows.set(line.row, [line]);
    }

    const distanceSquared = (a: Point2, b: Point2) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

    /** The unused line among `candidates` with an end nearest to `position`, and whether that end is its `end`. */
    const nearest = (candidates: InfillLine[], position: Point2) => {
        let best: { line: InfillLine, fromEnd: boolean, distanceSquared: number } | null = null;
        for (const line of candidates) {
            if (line.used) continue;
            const toStart = distanceSquared(position, line.start);
            const toEnd = distanceSquared(position, line.end);
            const candidate = toEnd < toStart
                ? { line, fromEnd: true, distanceSquared: toEnd }
                : { line, fromEnd: false, distanceSquared: toStart };
            if (!best || candidate.distanceSquared < best.distanceSquared) {
                best = candidate;
            }
        }
        return best;
    };

    const polylines: Point2[][] = [];
    /** The point a short way from `end` towards `other`, i.e. just inside the area on a line. */
    const stepInto = (end: Point2, other: Point2): Point2 => {
        const length = Math.sqrt(distanceSquared(end, other));
        const t = length > 0 ? Math.min(1, INFILL_LINK_PROBE_DEPTH / length) : 0;
        return { x: end.x + (other.x - end.x) * t, y: end.y + (other.y - end.y) * t };
    };

    let position = from;
    /** The end of the current line the head entered it at (its far end, now that it has been printed). */
    let currentEntry = from;
    let current: InfillLine | null = null;
    let polyline: Point2[] = [];

    for (let remaining = lines.length; remaining > 0; remaining--) {
        let next: ReturnType<typeof nearest> = null;
        let linked = false;

        if (current) {
            const neighbours = [...(rows.get(current.row - 1) ?? []), ...(rows.get(current.row + 1) ?? [])];
            next = nearest(neighbours, position);
            if (next && next.distanceSquared <= maxLinkLength * maxLinkLength) {
                const entry = next.fromEnd ? next.line.end : next.line.start;
                const exit = next.fromEnd ? next.line.start : next.line.end;
                // A link across a hole or a notch has its middle outside the material.
                const a = stepInto(position, currentEntry);
                const b = stepInto(entry, exit);
                linked = isInsideLoops({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, loops);
            }
        }
        if (!linked) {
            next = nearest(lines, position);
            polyline = [];
            polylines.push(polyline);
        }

        const chosen = next!;
        chosen.line.used = true;
        const entry = chosen.fromEnd ? chosen.line.end : chosen.line.start;
        const exit = chosen.fromEnd ? chosen.line.start : chosen.line.end;
        polyline.push(entry, exit);
        currentEntry = entry;
        position = exit;
        current = chosen.line;
    }

    return polylines;
}

/**
 * Appends a travel move to a path, following the conventions of the foam generators: a plain
 * `travel` point, with no retraction (the G-code emitter has none).
 *
 * - The very first move of the toolpath arrives from above: a point one travel clearance over
 *   the target, then straight down, so the head never slides in at bed height from wherever it was.
 * - A move to a higher layer climbs straight up first and only then crosses over.
 * - A move within a layer goes straight there.
 *
 * @param {PathPoint[]} path The path to append to.
 * @param {HeadState} head Where the head is; updated to the target.
 * @param {THREE.Vector3} target Where to move to.
 * @param {number} extruder The extruder that must be active from here on.
 */
function travelTo(path: PathPoint[], head: HeadState, target: THREE.Vector3, extruder: number): void {
    const from = head.position;
    if (from === null) {
        path.push({
            point: new THREE.Vector3(target.x, target.y, target.z + TRAVEL_CLEARANCE),
            travel: true,
            role: 'approach',
            extruder,
        });
        path.push({ point: target.clone(), travel: true, role: 'approach', extruder });
    } else {
        if (target.z > from.z + MIN_MOVE_LENGTH) {
            path.push({
                point: new THREE.Vector3(from.x, from.y, target.z),
                travel: true,
                role: 'approach',
                extruder,
            });
        }
        // The extruder is named even when the head is already in place, so a tool change still happens here.
        path.push({ point: target.clone(), travel: true, extruder });
    }
    head.position = target.clone();
}

/**
 * Appends a polyline to a path: a travel to its first point, then extrusions through the rest.
 *
 * @param {PathPoint[]} path The path to append to.
 * @param {HeadState} head Where the head is; updated to the end of the polyline.
 * @param {Point2[]} polyline The points to print through, in the part's own coordinates.
 * @param {PartContext} part The part being printed, for its offset, extruder, layer height and speed.
 * @param {number} z The height (mm) the nozzle prints at.
 */
function printPolyline(path: PathPoint[], head: HeadState, polyline: Point2[], part: PartContext, z: number): void {
    if (polyline.length < 2) {
        return;
    }
    const toBed = (point: Point2) => new THREE.Vector3(point.x + part.offset.x, point.y + part.offset.y, z);

    travelTo(path, head, toBed(polyline[0]), part.config.extruder);
    for (let i = 1; i < polyline.length; i++) {
        const point = toBed(polyline[i]);
        if (point.distanceTo(head.position!) < MIN_MOVE_LENGTH) {
            continue;
        }
        path.push({
            point,
            regularSegment: true,
            extruder: part.config.extruder,
            // The emitter works the extrusion amount out from the line width and this height.
            layerHeight: part.config.layerHeight,
            speed: part.config.printSpeed,
        });
        head.position = point.clone();
    }
}

/**
 * Finds the vertex of a loop that is nearest to a point.
 *
 * @param {Point2[]} loop The loop to search.
 * @param {Point2} point The point to measure from.
 * @returns {{ index: number, distanceSquared: number }} The vertex's index and its squared distance.
 */
function nearestVertex(loop: Point2[], point: Point2): { index: number, distanceSquared: number } {
    let best = { index: 0, distanceSquared: Infinity };
    for (let i = 0; i < loop.length; i++) {
        const distanceSquared = (loop[i].x - point.x) ** 2 + (loop[i].y - point.y) ** 2;
        if (distanceSquared < best.distanceSquared) {
            best = { index: i, distanceSquared };
        }
    }
    return best;
}

/**
 * Takes the loop nearest to a point out of a list, together with the vertex to start it at.
 *
 * @param {Point2[][]} loops The loops to choose from. The chosen one is removed. Must not be empty.
 * @param {Point2} point The point to measure from.
 * @returns {{ loop: Point2[], startIndex: number }} The nearest loop and its vertex nearest the point.
 */
function takeNearestLoop(loops: Point2[][], point: Point2): { loop: Point2[], startIndex: number } {
    let bestLoop = 0;
    let best = nearestVertex(loops[0], point);
    for (let i = 1; i < loops.length; i++) {
        const candidate = nearestVertex(loops[i], point);
        if (candidate.distanceSquared < best.distanceSquared) {
            best = candidate;
            bestLoop = i;
        }
    }
    return { loop: loops.splice(bestLoop, 1)[0], startIndex: best.index };
}

/**
 * Where the head is, in a part's own coordinates. Before the first move it counts as being at the
 * bed's origin, which is where the printer homes to.
 *
 * @param {HeadState} head The head state.
 * @param {PartContext} part The part whose coordinates to express the position in.
 * @returns {Point2} The head position relative to the part.
 */
function headInPart(head: HeadState, part: PartContext): Point2 {
    return {
        x: (head.position?.x ?? 0) - part.offset.x,
        y: (head.position?.y ?? 0) - part.offset.y,
    };
}

/**
 * Prints the infill of one area: parallel lines at the given spacing, joined into zigzags.
 *
 * @param {PathPoint[]} path The path to append to.
 * @param {HeadState} head Where the head is; updated as the infill is printed.
 * @param {ClipperLib.Paths} area The area to fill.
 * @param {number} spacing The distance between lines in mm.
 * @param {number} angle The direction of the lines in radians.
 * @param {PartContext} part The part being printed.
 * @param {number} z The height (mm) the nozzle prints at.
 */
function printInfill(
    path: PathPoint[],
    head: HeadState,
    area: ClipperLib.Paths,
    spacing: number,
    angle: number,
    part: PartContext,
    z: number,
): void {
    const loops = fromClipperPaths(area);
    if (!loops.length) {
        return;
    }
    const lines = cutInfillLines(loops, spacing, angle, MIN_INFILL_LINE_FACTOR * part.lineWidth);
    const polylines = chainInfillLines(lines, headInPart(head, part), INFILL_LINK_FACTOR * spacing, loops);
    for (const polyline of polylines) {
        printPolyline(path, head, polyline, part, z);
    }
}

/**
 * Prints one island of a layer: its perimeters, innermost loop first and the outer wall last,
 * then solid infill where a top or bottom surface is near, then sparse infill in what is left.
 *
 * Perimeter n runs n + 0.5 line widths inside the outline, so the outside of the outer wall lies
 * on the model's surface. A wall too thin for a perimeter to fit simply gets none.
 *
 * @param {PathPoint[]} path The path to append to.
 * @param {HeadState} head Where the head is; updated as the island is printed.
 * @param {PolygonWithHoles} island The island's outline and holes.
 * @param {PartLayer} layer The layer the island belongs to.
 * @param {PartContext} part The part being printed.
 * @param {ClipperLib.Paths | null} covered The layer's area with material in all nearby layers,
 *        or null if top/bottom layers are switched off.
 */
function printIsland(
    path: PathPoint[],
    head: HeadState,
    island: PolygonWithHoles,
    layer: PartLayer,
    part: PartContext,
    covered: ClipperLib.Paths | null,
): void {
    const { config, lineWidth } = part;
    const z = layer.nozzleZ;

    for (let n = config.perimeters - 1; n >= 0; n--) {
        const loops: Point2[][] = [];
        for (const piece of offsetRegion(island.outer, island.holes, -(n + 0.5) * lineWidth)) {
            for (const loop of [piece.outer, ...piece.holes]) {
                if (loop.length >= 3) loops.push(loop);
            }
        }
        while (loops.length) {
            const { loop, startIndex } = takeNearestLoop(loops, headInPart(head, part));
            const closed: Point2[] = [];
            for (let k = 0; k <= loop.length; k++) {
                closed.push(loop[(startIndex + k) % loop.length]);
            }
            printPolyline(path, head, closed, part, z);
        }
    }

    // Infill centre lines stop half a line width short of the innermost perimeter's inner edge,
    // less a small overlap so the two fuse. Without perimeters there is nothing to overlap with.
    const overlap = config.perimeters > 0 ? INFILL_PERIMETER_OVERLAP * lineWidth : 0;
    const inset = config.perimeters * lineWidth + lineWidth / 2 - overlap;
    const infillArea = polygonsToShape(offsetRegion(island.outer, island.holes, -inset));
    if (!infillArea.length) {
        return;
    }

    const { solid, sparse } = splitInfillArea(infillArea, covered, config, lineWidth);
    const angle = layer.layerIndex % 2 === 0 ? INFILL_ANGLE : -INFILL_ANGLE;

    if (solid.length) {
        printInfill(path, head, solid, lineWidth, angle, part, z);
    }
    if (sparse.length) {
        // At 100 % the lines touch (spacing = line width); at 20 % they are five line widths apart.
        const spacing = lineWidth / (config.infillDensity / SOLID_INFILL_DENSITY);
        printInfill(path, head, sparse, spacing, angle, part, z);
    }
}

/**
 * Prints one layer of one part, island by island, always carrying on with the island nearest to
 * the head.
 *
 * @param {PathPoint[]} path The path to append to.
 * @param {HeadState} head Where the head is; updated as the layer is printed.
 * @param {PartLayer} layer The layer to print.
 * @param {PartContext} part The part the layer belongs to.
 * @param {Map<number, PartLayer>} layersByIndex The part's layers by layer index.
 */
function printLayer(
    path: PathPoint[],
    head: HeadState,
    layer: PartLayer,
    part: PartContext,
    layersByIndex: Map<number, PartLayer>,
): void {
    const { config } = part;
    // Only worked out when it can make a difference: not when everything is solid anyway.
    const needsCoverage = config.topBottomLayers > 0 && config.infillDensity < SOLID_INFILL_DENSITY;
    const covered = needsCoverage ? coveredByNeighbours(layersByIndex, layer, config.topBottomLayers) : null;

    const remaining = layer.islands.filter(island => island.outer.length >= 3);
    while (remaining.length) {
        const outers = remaining.map(island => island.outer as Point2[]);
        const { loop } = takeNearestLoop(outers, headInPart(head, part));
        const island = remaining.splice(remaining.findIndex(candidate => candidate.outer === loop), 1)[0];
        printIsland(path, head, island, layer, part, covered);
    }
}

/**
 * Slices models into the toolpath of an ordinary solid plastic print: perimeters, solid top and
 * bottom layers and rectilinear infill, as regular (non-foam) extrusions.
 *
 * The parts are printed together, layer by layer in ascending z: every layer of every part at a
 * height is finished before anything higher is started, so the nozzle never has to pass a taller,
 * finished part. Parts may have different layer heights; their layers are merged by height. Among
 * layers at the same height, parts on the extruder that is already active go first.
 *
 * No purge line, skirt, brim, support or retraction is generated.
 *
 * @param {Printer} printer The printer, for its extruders' line widths.
 * @param {RegularPart[]} parts The parts to print. Their meshes are not modified.
 * @returns {PathPoint[]} The toolpath. Empty if there is nothing to print.
 * @throws {Error} If a part's configuration is invalid.
 */
export function generateRegularToolpath(printer: Printer, parts: RegularPart[]): PathPoint[] {
    const contexts: PartContext[] = [];
    const layersByIndex: Map<number, PartLayer>[] = [];
    const allLayers: PartLayer[] = [];

    parts.forEach((part, partIndex) => {
        validateRegularConfig(printer, part.config, part.name ?? `Part ${partIndex + 1}`);

        const layers = slicePart(part, partIndex);
        contexts.push({
            config: part.config,
            lineWidth: printer.threadDiameter(part.config.extruder),
            offset: { x: part.offset?.x ?? 0, y: part.offset?.y ?? 0 },
        });
        layersByIndex.push(new Map(layers.map(layer => [layer.layerIndex, layer])));
        for (const layer of layers) {
            allLayers.push(layer);
        }
    });

    // Lowest first; a stable sort keeps parts in the order they were given within a height.
    allLayers.sort((a, b) => a.nozzleZ - b.nozzleZ);

    const path: PathPoint[] = [];
    const head: HeadState = { position: null };
    let activeExtruder: number | null = null;

    for (let start = 0; start < allLayers.length;) {
        // Everything at (practically) the same height is one print layer.
        let end = start + 1;
        while (end < allLayers.length && allLayers[end].nozzleZ - allLayers[start].nozzleZ < LAYER_Z_TOLERANCE) {
            end++;
        }
        const group = allLayers.slice(start, end);
        start = end;

        // Parts on the active extruder first, so a layer needs as few tool changes as possible.
        while (group.length) {
            let next = group.findIndex(layer => contexts[layer.partIndex].config.extruder === activeExtruder);
            if (next === -1) next = 0;
            const layer = group.splice(next, 1)[0];
            const part = contexts[layer.partIndex];

            const lengthBefore = path.length;
            printLayer(path, head, layer, part, layersByIndex[layer.partIndex]);
            if (path.length > lengthBefore) {
                activeExtruder = part.config.extruder;
            }
        }
    }

    return path;
}
