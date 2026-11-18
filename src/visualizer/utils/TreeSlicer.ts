import * as THREE from 'three';
import ClipperLib from 'clipper-lib';
import Delaunator from 'delaunator';
import type { EverydayModel } from '../types/modelTypes';
import type { PathPoint } from '../toolpath/pathTypes';
import type Printer from '../../printer/Printer';
import { nozzleRadiusAt } from '../../printer/Printer';
import { coilReach } from '../toolpath/coilModel';
import type { Extruder, VTPSettings } from '../../printer/Printer';


// ---------------------------------------------------------------------------------------------
// Tolerances and other fixed numbers used by the slicer. All lengths are in mm.
// ---------------------------------------------------------------------------------------------

// Clipper works on integers, so points are multiplied by this going in and divided coming out (1 unit = 1 micron).
export const CLIPPER_SCALE = 1000;
// Smallest area (mm^2) an inset contour may have; anything smaller is a sliver and is dropped.
const MIN_AREA = 3;
// MIN_AREA in Clipper's scaled integer units, which is what Clipper path areas are measured in.
const MIN_AREA_SCALED = MIN_AREA * CLIPPER_SCALE * CLIPPER_SCALE;
// How far (mm) a rounded offset corner may deviate from a true arc; sets how many vertices an arc gets.
const ARC_TOLERANCE = 0.01;
// Clipper's miter limit. Only applies to mitered joins, but the offsetter still needs a value.
const CLIPPER_MITER_LIMIT = 2;
// The first and last slicing planes sit this far inside the mesh, so no plane lies exactly on a flat top or bottom.
const SLICE_Z_EPSILON = 0.00001;
// Segment endpoints closer than this are treated as the same point when stitching segments into contours.
const SEGMENT_CONNECT_TOLERANCE = 0.00001;
// Contours are closed loops, so edges shorter than this are degenerate and get dropped when
// turning a contour into line segments. Matches SEGMENT_CONNECT_TOLERANCE.
const MIN_SEGMENT_LENGTH = 0.00001;
// Slack used when comparing two heights, or when turning a height into a layer index.
const HEIGHT_EPSILON = 0.0001;
// Room (mm) left between the side of the nozzle and printed material that stands above its tip.
const NOZZLE_CLEARANCE = 0.1;
// How far (mm) to the side of the shell line below it a shell line is still held up by it, when
// the caller does not say: half the width of a line from a 0.4 mm nozzle.
const DEFAULT_WALL_OVERHANG = 0.2;
// Shell lines are checked for what is under them at their corners and this often (mm) in between.
const WALL_SAMPLE_SPACING = 1;
// A region can only be the parent of a region that is less than this many layers above it.
const MAX_PARENT_GAP_LAYERS = 1.5;
// Extra inset added to the foam region inside a shell so the two never share an edge exactly.
const SHELL_OFFSET_PADDING = 0.0001;
// The base contour used for brims is cut this far above the lowest point of the mesh.
const BASE_CONTOUR_Z_OFFSET = 0.01;
// Boundary (brim) contours are lifted by this much after being moved to the model's position.
const BOUNDARY_CONTOUR_Z_LIFT = 0.09;
// The most line segments a leaf of a chunk BVH will hold before it gets split in two.
const CHUNK_BVH_LEAF_SIZE = 4;
// Refuse to slice into more layers than this; a step this small is always a mistake and would hang the tab.
const MAX_LAYERS = 1000000;


// basic data structures for slicing
export interface SliceRegion {
    id: string;
    height: number;
    contour: THREE.Vector3[];
    holes: THREE.Vector3[][];
    bounds: { min: THREE.Vector3; max: THREE.Vector3 };
    BVH: SliceRegionBVHNode;
    extruder: number; // 0 for left, 1 for right. We can add more extruders later if we want to support more than 2.
    shell: boolean,
    /**
     * The outline of the model this region was cut from, before any shell inset was applied.
     * Used when deciding which regions are stacked on top of each other. When it is missing the
     * region's own contour and holes are used instead.
     */
    footprint?: PolygonWithHoles;
    /** For a shell region: where its wall is (see ShellWall). */
    wall?: ShellWall;
}

/**
 * Where the wall of one outline of a slice is: from the outline, which the outer shell line runs
 * along, to the middle of the innermost shell line.
 */
export interface ShellWall {
    /** The outline, holes included. */
    outline: PolygonWithHoles;
    /** The area inside the middle of the innermost shell line. */
    inside: PolygonWithHoles[];
}

/** An outer contour together with the hole contours that are directly inside of it. */
export interface PolygonWithHoles {
  outer: THREE.Vector3[];
  holes: THREE.Vector3[][];
}

export interface SliceRegionBVHNode{
  min: THREE.Vector3;
  max: THREE.Vector3;
  left?: SliceRegionBVHNode;
  right?: SliceRegionBVHNode
  leafSegments: LineSegment[]; //CHUNK_BVH_LEAF_SIZE in max length
}

export interface LineSegment {
  start: THREE.Vector3;
  end: THREE.Vector3
}

export interface RegionNode {
    region: SliceRegion;
    children: RegionNode[];
    parent: RegionNode | null;
    layer: number;
    visited: boolean;
    shell: boolean;
    shellDependentRegions?: Set<string>;
    shellHeight?: number;
}

export interface ChunkNode {
  regions: SliceRegion[];
  children: ChunkNode[];
  parent: ChunkNode | null;
  modelObj?: EverydayModel;
  VTPSettings: VTPSettings;
  shell: boolean;
  /**
   * The round the chunk is printed in. Chunks are printed in increasing order; the ones that
   * share a number can be printed in any order. See buildChunkForest.
   */
  order: number;
  dependentRegions?: Set<string>;
  regionDependencies?: Map<string, Set<string>>;
}

export interface ContourNode {
  contour: THREE.Vector3[];
  children: ContourNode[];
  parent: ContourNode | null;
}


/**
 * Throws if a step size (layer thickness, layer height...) can't be used to walk through a model.
 * A zero, negative or non-finite step would otherwise loop forever or divide by zero.
 *
 * @param {number} value The step to check.
 * @param {string} name What the step is called, for the error message.
 */
function assertPositiveStep(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive, finite number (got ${value}).`);
  }
}


/**
 * Adds the line segment where a triangle crosses a plane to a list, if it crosses at all.
 *
 * A vertex lying exactly on the plane counts as being above it. That way every triangle is
 * crossed along either zero or two of its edges, so contours stay closed even when the plane
 * passes exactly through vertices of the mesh.
 *
 * @param {number} ax x of the first vertex (and so on for ay..cz).
 * @param {number} da Signed distance from the plane to the first vertex.
 * @param {number} db Signed distance from the plane to the second vertex.
 * @param {number} dc Signed distance from the plane to the third vertex.
 * @param {LineSegment[]} out The list to add the segment to.
 */
function pushTrianglePlaneSegment(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  da: number, db: number, dc: number,
  out: LineSegment[],
): void {
  const aAbove = da >= 0, bAbove = db >= 0, cAbove = dc >= 0;
  if (aAbove === bAbove && bAbove === cAbove) return;

  let first: THREE.Vector3 | null = null;
  let second: THREE.Vector3 | null = null;

  if (aAbove !== bAbove) {
    const t = da / (da - db);
    first = new THREE.Vector3(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
  }
  if (bAbove !== cAbove) {
    const t = db / (db - dc);
    const p = new THREE.Vector3(bx + (cx - bx) * t, by + (cy - by) * t, bz + (cz - bz) * t);
    if (first) second = p; else first = p;
  }
  if (cAbove !== aAbove) {
    const t = dc / (dc - da);
    second = new THREE.Vector3(cx + (ax - cx) * t, cy + (ay - cy) * t, cz + (az - cz) * t);
  }

  if (!first || !second) return;

  // A triangle that only touches the plane with one corner gives a segment with no length.
  if ((da === 0 || db === 0 || dc === 0) && first.equals(second)) return;

  out.push({ start: first, end: second });
}


/**
 * Slices a mesh into layers represented by a list of segments.
 *
 * Each triangle is only tested against the layers that fall inside its own z range, rather than
 * every layer testing every triangle. The segments of a layer are in triangle order.
 *
 * @param {THREE.Mesh} mesh The mesh to slice into layers.
 * @param {number} deltaZ How far apart each layer should be. Must be positive.
 * @returns {{ z: number, segments: LineSegment[] }[]} The list of layers.
 * @throws {Error} If deltaZ is not a positive, finite number, or would give an absurd number of layers.
 */
export function sliceMeshIntoLayers(
  mesh: THREE.Mesh,
  deltaZ: number
): { z: number, segments: LineSegment[] }[] {
    assertPositiveStep(deltaZ, 'Layer thickness (deltaZ)');

    const geometry = mesh.geometry as THREE.BufferGeometry;
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox!;

    const minZ = bbox.min.z + SLICE_Z_EPSILON;
    const maxZ = bbox.max.z - SLICE_Z_EPSILON;
    const layers: { z: number, segments: LineSegment[] }[] = [];

    // go from bottom to top, one layer every deltaZ. z comes from the layer index so that
    // rounding errors don't build up over many layers.
    for (let k = 0; ; k++) {
        const z = minZ + k * deltaZ;
        if (!(z <= maxZ)) break;
        if (k >= MAX_LAYERS) {
            throw new Error(`Layer thickness (deltaZ) of ${deltaZ} would slice the model into more than ${MAX_LAYERS} layers.`);
        }
        layers.push({ z, segments: [] });
    }

    const positionAttribute = geometry.attributes.position;
    if (layers.length === 0 || !positionAttribute) return layers;

    const positions = positionAttribute.array;
    const index = geometry.index ? geometry.index.array : null;
    const triangleCount = Math.floor((index ? index.length : positions.length / 3) / 3);
    const lastLayer = layers.length - 1;

    for (let t = 0; t < triangleCount; t++) {
        const ia = (index ? index[3 * t] : 3 * t) * 3;
        const ib = (index ? index[3 * t + 1] : 3 * t + 1) * 3;
        const ic = (index ? index[3 * t + 2] : 3 * t + 2) * 3;

        const az = positions[ia + 2], bz = positions[ib + 2], cz = positions[ic + 2];
        const zLow = Math.min(az, bz, cz);
        const zHigh = Math.max(az, bz, cz);

        // flat triangles (and ones with NaN in them) never cross a layer
        if (!(zHigh > zLow)) continue;

        // The layers that could cut this triangle, widened by one each way to be safe against
        // rounding. The exact test happens below.
        let kLow = Math.ceil((zLow - minZ) / deltaZ) - 1;
        let kHigh = Math.floor((zHigh - minZ) / deltaZ) + 1;
        if (kLow < 0) kLow = 0;
        if (kHigh > lastLayer) kHigh = lastLayer;

        for (let k = kLow; k <= kHigh; k++) {
            const layer = layers[k];
            const z = layer.z;
            // needs one vertex below the plane and one on or above it
            if (z <= zLow || z > zHigh) continue;

            pushTrianglePlaneSegment(
                positions[ia], positions[ia + 1], az,
                positions[ib], positions[ib + 1], bz,
                positions[ic], positions[ic + 1], cz,
                az - z, bz - z, cz - z,
                layer.segments,
            );
        }
    }

    return layers;
}


/**
 * Checks to see if a point is in a polygon/contour represented by an ordered list of points.
 *
 * @param point The point to check.
 * @param polygon The polygon to check if the point is inside.
 * @returns {boolean} Whether or not the point is inside the polygon
 */
export function pointInPolygon(point: THREE.Vector3, polygon: THREE.Vector3[]): boolean {
  let inside = false;
  const x = point.x, y = point.y;
  const n = polygon.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;

    const intersect = ((yi > y) !== (yj > y)) &&
                      (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);

    if (intersect) inside = !inside;
  }

  return inside;
}


/**
 * Determines whether contour2 is inside of contour1.
 * Doesn't work for contours that intersect each other.
 *
 * @param {THREE.Vector3[]} contour1 The contour to check if it contains the other.
 * @param {THREE.Vector3[]} contour2 The contour to check if it is inside the other.
 * @returns {boolean} Whether or not contour1 contains contour2.
 */
function contourContainsContour(
  contour1: THREE.Vector3[],
  contour2: THREE.Vector3[],
): boolean {
  if (contour1.length < 3 || contour2.length === 0) return false;
  return pointInPolygon(contour2[0], contour1);
}


/**
 * From a list of contours, groups them into outer contours and hole contours, then
 * returns the list of outer contours and the hole contours for each outer.
 *
 * Contours can be nested to any depth, e.g. a ring with a post standing in its bore. A contour
 * that is inside an even number of other contours is the outside of some material, so it is an
 * outer. Its holes are only the contours directly inside of it (one level deeper); anything
 * deeper than that belongs to another outer.
 *
 * @param contours The list of contours to group.
 * @returns {{outer: THREE.Vector3[], holes: THREE.Vector3[][]}[]} A list of outer contours and hole contours.
 *          Outers that have holes come first, then the ones without, each in their original order.
 */
export function getHolesAndOuters(
  contours: THREE.Vector3[][],
): {outer: THREE.Vector3[], holes: THREE.Vector3[][]}[] {
  const count = contours.length;

  // depth[i] is how many other contours contour i is inside of
  const depth: number[] = new Array(count).fill(0);
  // inside[i] lists every contour that is somewhere inside contour i
  const inside: number[][] = [];
  for (let i = 0; i < count; i++) inside.push([]);

  for (let i = 0; i < count; i++) {
    for (let j = 0; j < count; j++) {
      if (i !== j && contourContainsContour(contours[i], contours[j])) {
        inside[i].push(j);
        depth[j]++;
      }
    }
  }

  const withHoles: {outer: THREE.Vector3[], holes: THREE.Vector3[][]}[] = [];
  const withoutHoles: {outer: THREE.Vector3[], holes: THREE.Vector3[][]}[] = [];

  for (let i = 0; i < count; i++) {
    if (depth[i] % 2 !== 0) continue; // odd depth is a hole

    const holes = inside[i]
      .filter(j => depth[j] === depth[i] + 1)
      .map(j => contours[j]);

    (holes.length ? withHoles : withoutHoles).push({ outer: contours[i], holes });
  }

  return withHoles.concat(withoutHoles);
}



/**
 * Gets the line segments making up the entire boundary of a region: the edges of its outer
 * contour followed by the edges of each of its holes. Each contour is treated as a closed loop,
 * so an edge is added from its last point back to its first. Degenerate edges are skipped, which
 * covers the repeated first/last point that connectSegments leaves on its contours.
 *
 * The segments reference the contour's points rather than copying them, so reordering a contour
 * is safe, but moving its points would move the segments with them.
 *
 * @param {THREE.Vector3[]} outer The outer contour of the region.
 * @param {THREE.Vector3[][]} holes The hole contours of the region.
 * @returns {LineSegment[]} The edges of the outer contour and of every hole.
 */
export function getBoundarySegments(
  outer: THREE.Vector3[],
  holes: THREE.Vector3[][],
): LineSegment[] {
  const segments: LineSegment[] = [];

  for (const contour of [outer, ...holes]) {
    for (let i = 0; i < contour.length; i++) {
      const start = contour[i];
      const end = contour[(i + 1) % contour.length];

      if (start.distanceToSquared(end) < MIN_SEGMENT_LENGTH * MIN_SEGMENT_LENGTH) continue;

      segments.push({ start, end });
    }
  }

  return segments;
}


/**
 * Takes in a layer represented by a list of segments and finds separate regions in it.
 * Separate regions are parts of the layer that are not connected to each other by any segment.
 *
 * When there is a shell, the region is what is left after insetting the outline by the shell's
 * thickness. The outer contour and the holes are inset together, so holes are clipped against the
 * inset outer, and an outline that splits apart when inset gives one region per piece.
 *
 * @param z The z position of the layer
 * @param segments The list of segments to find the regions from.
 * @param linewidth The width of one shell line (mm).
 * @param shellLayers How many shell lines surround the region. 0 means no shell and no inset.
 * @returns {SliceRegion[]} A list of slice regions each with an outer contour, hole contours, boundary segments, bounds, an id, and a height.
 */
export function extractRegionsFromLayer(z: number, segments: LineSegment[], linewidth: number, shellLayers: number): SliceRegion[] {
    if (segments.length === 0) return [];

    const contours = connectSegments(segments);

    const holeContours = getHolesAndOuters(contours);

    const regions: SliceRegion[] = [];

    // make a region for each contour we found
    for (let i = 0; i < holeContours.length; i++) {
        const outline = holeContours[i];

        let pieces: PolygonWithHoles[];
        if (shellLayers != 0) {
          const shellOffset = linewidth * (shellLayers + 1) + SHELL_OFFSET_PADDING; //TODO: Unhardcode.
          pieces = offsetRegion(outline.outer, outline.holes, -shellOffset);
        } else {
          pieces = [outline];
        }

        // A piece of a split outline only has its own contour to go on. An outline that stayed
        // whole keeps its original bounds and remembers the outline it was inset from.
        const split = pieces.length > 1;

        pieces.forEach((piece, pieceIndex) => {
            if (piece.outer.length < 3) return;

            regions.push({
                id: pieceIndex === 0 ? `region_${z.toFixed(3)}_${i}` : `region_${z.toFixed(3)}_${i}_${pieceIndex}`,
                height: z,
                contour: piece.outer,
                holes: piece.holes,
                bounds: getBounds(split ? piece.outer : outline.outer, z),
                extruder: 0, // Default to left extruder
                BVH: buildSliceRegionBVH(getBoundarySegments(piece.outer, piece.holes)),
                shell: false,
                footprint: split ? undefined : { outer: outline.outer, holes: outline.holes },
            });
        });
    }

    return regions;
}

/**
 * Takes in a layer represented by a list of segments and makes a shell region for each separate
 * outline in it. A shell region's contour is the outline itself and its "holes" are every other
 * line of the shell: the inner shell lines, the walls of the holes and the shell lines around those.
 *
 * The inner shell lines come from insetting the outer contour and the holes together, so they
 * never cross each other in thin walls, and every piece is kept if the outline splits apart.
 *
 * @param z The z position of the layer
 * @param segments The list of segments to find the regions from.
 * @param linewidth The width of one shell line (mm).
 * @param shellLayers How many shell lines to make, counting the outline itself.
 * @returns {SliceRegion[]} A list of shell regions.
 */
export function extractShellRegionsFromLayer(z: number, segments: LineSegment[], linewidth: number, shellLayers: number): SliceRegion[] {
    if (segments.length === 0) return [];

    const contours = connectSegments(segments);

    const holeContours = getHolesAndOuters(contours);

    const regions: SliceRegion[] = [];

    // make a region for each contour we found
    for (let i = 0; i < holeContours.length; i++) {
        const outline = holeContours[i];
        const bounds = getBounds(outline.outer, z);

        // shell lines inside the outer wall, and shell lines around the holes
        const outerRings: THREE.Vector3[][] = [];
        const holeRings: THREE.Vector3[][] = [];
        let inside: PolygonWithHoles[] = [outline];
        for (let n = 1; n < shellLayers; n++) {
          inside = offsetRegion(outline.outer, outline.holes, -(linewidth * n));
          for (const piece of inside) {
            outerRings.push(piece.outer);
            holeRings.push(...piece.holes);
          }
        }

        const shellLines = [...outerRings, ...outline.holes, ...holeRings];

        //push shell
        regions.push({
            id: `region_${z.toFixed(3)}_${i}_S`,
            height: z,
            contour: outline.outer,
            holes: shellLines,
            bounds: bounds,
            extruder: 0, // Default to left extruder
            BVH: buildSliceRegionBVH(getBoundarySegments(outline.outer, shellLines)),
            shell: true,
            wall: { outline: { outer: outline.outer, holes: outline.holes }, inside },
        });
    }

    return regions;
}

/**
 * Gets the line segments where a mesh crosses a plane.
 *
 * @param {THREE.Mesh} mesh - The mesh to get segments from.
 * @param {THREE.Plane} plane - The plane on which to extract segments from the mesh on.
 * @returns {{ start: THREE.Vector3; end: THREE.Vector3 }[]} A list of line segments that make up the contour.
 */
export function getSegmentsFromMesh(mesh: THREE.Mesh, plane: THREE.Plane): { start: THREE.Vector3; end: THREE.Vector3 }[] {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const segments: LineSegment[] = [];

    const positionAttribute = geometry.attributes.position;
    if (!positionAttribute) return segments;

    const positions = positionAttribute.array;
    const index = geometry.index ? geometry.index.array : null;
    const triangleCount = Math.floor((index ? index.length : positions.length / 3) / 3);

    const nx = plane.normal.x, ny = plane.normal.y, nz = plane.normal.z;
    const constant = plane.constant;

    // check each triangle
    for (let t = 0; t < triangleCount; t++) {
        const ia = (index ? index[3 * t] : 3 * t) * 3;
        const ib = (index ? index[3 * t + 1] : 3 * t + 1) * 3;
        const ic = (index ? index[3 * t + 2] : 3 * t + 2) * 3;

        const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
        const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
        const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];

        pushTrianglePlaneSegment(
            ax, ay, az, bx, by, bz, cx, cy, cz,
            nx * ax + ny * ay + nz * az + constant,
            nx * bx + ny * by + nz * bz + constant,
            nx * cx + ny * cy + nz * cz + constant,
            segments,
        );
    }

    return segments;
}

/**
 * Gets the intersection points between a triangle and a plane. A vertex exactly on the plane
 * counts as being above it, so the result always has either zero or two points.
 *
 * @param {THREE.Vector3} a - First vertex of the triangle.
 * @param {THREE.Vector3} b - Second vertex of the triangle.
 * @param {THREE.Vector3} c - Third vertex of the triangle.
 * @param {THREE.Plane} plane - The plane to check intersections with.
 * @returns {THREE.Vector3[]} The list of intersection points.
 */
export function getTrianglePlaneIntersection(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, plane: THREE.Plane): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    const edges = [[a, b], [b, c], [c, a]];

    for (const [p1, p2] of edges) {
        const d1 = plane.distanceToPoint(p1);
        const d2 = plane.distanceToPoint(p2);

        // if points are on different sides of plane, edge crosses it
        if ((d1 >= 0) !== (d2 >= 0)) {
            const t = d1 / (d1 - d2);
            const intersection = new THREE.Vector3();
            intersection.lerpVectors(p1, p2, t);
            points.push(intersection);
        }
    }

    return points;
}

/**
 * Takes in a list of line segments and connects the line segments to create contours,
 * returning a matrix of points representing the contours.
 *
 * A contour starts at the first segment that hasn't been used yet and keeps growing from its end:
 * the next segment is the lowest numbered unused one with an endpoint within the connection
 * tolerance of the current point. Endpoints are kept in a grid of small cells, so finding the next
 * segment only looks at the endpoints near the current point rather than at every segment.
 *
 * @param {{ start: THREE.Vector3; end: THREE.Vector3 }[]} segments - The contour in the form of line segments.
 * @returns {THREE.Vector3[][]} The ordered lists of points making up the contour.
 */
export function connectSegments(
  segments: { start: THREE.Vector3; end: THREE.Vector3 }[]
): THREE.Vector3[][] {
    const segmentCount = segments.length;
    if (segmentCount === 0) return [];

    const contours: THREE.Vector3[][] = [];
    const tolerance = SEGMENT_CONNECT_TOLERANCE; // how close endpoints need to be to connect

    // Cells are twice the tolerance wide, so two points within the tolerance of each other are
    // always in the same cell or in neighbouring ones.
    const cellSize = tolerance * 2;
    const cellKey = (ix: number, iy: number) => (ix * 73856093) ^ (iy * 19349663);

    // Endpoint ids are 2 * segment for a segment's start and 2 * segment + 1 for its end.
    const grid = new Map<number, number[]>();
    const addEndpoint = (point: THREE.Vector3, id: number) => {
        const key = cellKey(Math.floor(point.x / cellSize), Math.floor(point.y / cellSize));
        const cell = grid.get(key);
        if (cell) cell.push(id); else grid.set(key, [id]);
    };
    for (let i = 0; i < segmentCount; i++) {
        addEndpoint(segments[i].start, 2 * i);
        addEndpoint(segments[i].end, 2 * i + 1);
    }

    const used = new Uint8Array(segmentCount);
    let usedCount = 0;

    // Finds the lowest unused endpoint id within the tolerance of a point, or -1 if there is none.
    const findConnection = (point: THREE.Vector3): number => {
        const ix = Math.floor(point.x / cellSize);
        const iy = Math.floor(point.y / cellSize);
        let best = -1;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const cell = grid.get(cellKey(ix + dx, iy + dy));
                if (!cell) continue;
                for (let c = 0; c < cell.length; c++) {
                    const id = cell[c];
                    if (best !== -1 && id >= best) continue;
                    const segmentIndex = id >> 1;
                    if (used[segmentIndex]) continue;
                    const candidate = (id & 1) ? segments[segmentIndex].end : segments[segmentIndex].start;
                    if (point.distanceTo(candidate) < tolerance) best = id;
                }
            }
        }
        return best;
    };

    let startIdx = 0;
    while (usedCount < segmentCount) {
        // find unused segment to start new contour
        while (startIdx < segmentCount && used[startIdx]) startIdx++;
        if (startIdx >= segmentCount) break;

        const contour: THREE.Vector3[] = [];
        const startSegment = segments[startIdx];
        let currentPoint = startSegment.end;

        used[startIdx] = 1;
        usedCount++;
        contour.push(startSegment.start.clone());
        contour.push(startSegment.end.clone());

        // try to keep connecting more segments
        while (usedCount < segmentCount) {
            const id = findConnection(currentPoint);
            if (id === -1) break;

            const segment = segments[id >> 1];
            used[id >> 1] = 1;
            usedCount++;

            // connected at the segment's start, so carry on from its end, and the other way round
            currentPoint = (id & 1) ? segment.start : segment.end;
            contour.push(currentPoint.clone());
        }

        if (contour.length > 2) {
            contours.push(contour);
        }
    }

    return contours;
}

/**
 * Gets the x and y bounds of a contour, and returns a 3d bounding square with a given z.
 *
 * @param {THREE.Vector3[]} contour The contour to find the bounds of
 * @param {number} z The height of the returned bounding box
 * @returns {{min: THREE.Vector3, max: THREE.Vector3}} The bounding box for the contour
 */
export function getBounds(
  contour: THREE.Vector3[],
  z: number
): { min: THREE.Vector3; max: THREE.Vector3 } {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const point of contour) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
    }

    return {
        min: new THREE.Vector3(minX, minY, z),
        max: new THREE.Vector3(maxX, maxY, z)
    };
}


/**
 * Determines if two regions overlap when only considering x and y dimensions.
 * Only uses a regions bounding box so is not perfectly accurate; see checkPolygonOverlap
 * for an exact test.
 *
 * @param {SliceRegion} regionA The first region.
 * @param {SliceRegion} regionB The second region.
 * @returns {boolean} Whether or not the two regions overlap.
 */
export function checkOverlap(
  regionA: SliceRegion,
  regionB: SliceRegion
): boolean {
    return !(
        regionA.bounds.max.x < regionB.bounds.min.x ||
        regionA.bounds.min.x > regionB.bounds.max.x ||
        regionA.bounds.max.y < regionB.bounds.min.y ||
        regionA.bounds.min.y > regionB.bounds.max.y
    );
}


/**
 * Determines if the material of two regions really overlaps when looking straight down, rather
 * than just their bounding boxes. Holes count as empty, so a post standing in the bore of a ring
 * does not overlap the ring. Regions that only touch along an edge do not overlap.
 *
 * Uses each region's footprint (the outline it had before any shell inset) when it has one.
 *
 * @param {SliceRegion} regionA The first region.
 * @param {SliceRegion} regionB The second region.
 * @returns {boolean} Whether or not the two regions overlap.
 */
export function checkPolygonOverlap(
  regionA: SliceRegion,
  regionB: SliceRegion
): boolean {
    // Fast bounding box check
    if (!checkOverlap(regionA, regionB)) return false;

    const a = regionA.footprint ?? { outer: regionA.contour, holes: regionA.holes };
    const b = regionB.footprint ?? { outer: regionB.contour, holes: regionB.holes };

    // Not real polygons, so the bounding boxes are the best information there is.
    if (a.outer.length < 3 || b.outer.length < 3) return true;

    const toPaths = (polygon: PolygonWithHoles) =>
      [polygon.outer, ...polygon.holes].filter(c => c.length >= 3).map(toClipperPath);

    // Intersect the two with the even-odd rule, which treats holes as empty whichever way they wind.
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths(toPaths(a), ClipperLib.PolyType.ptSubject, true);
    clipper.AddPaths(toPaths(b), ClipperLib.PolyType.ptClip, true);

    const solution: ClipperLib.Paths = [];
    const succeeded = clipper.Execute(
      ClipperLib.ClipType.ctIntersection,
      solution,
      ClipperLib.PolyFillType.pftEvenOdd,
      ClipperLib.PolyFillType.pftEvenOdd
    );
    if (!succeeded) return true;

    // holes in the intersection have negative area, so this is the true overlapping area
    let area = 0;
    for (const path of solution) {
      area += clipperArea(path);
    }
    return area > 0;
}

/**
 * Determines if a shell region overlaps with the solid area of a regular (non-shell) region.
 * The solid area of a regular region is the space inside its outer contour but outside all its holes.
 *
 * @param {SliceRegion} shellRegion The shell region.
 * @param {SliceRegion} regularRegion The regular region to check against.
 * @param {number} maxDz The most the shell may be above the regular region and still count.
 * @param {SliceRegionBVHNode} [regularBVH] A BVH of the regular region's boundary segments, if the caller already has one.
 * @returns {boolean} Whether or not the shell overlaps the regular region's solid area.
 */
export function checkShellRegularOverlap(
  shellRegion: SliceRegion,
  regularRegion: SliceRegion,
  maxDz: number = Infinity, //TODO: unhardcode.
  regularBVH?: SliceRegionBVHNode,
): boolean {
    const dz = shellRegion.height - regularRegion.height;
    if (dz < -HEIGHT_EPSILON || dz > maxDz + HEIGHT_EPSILON) {
        return false;
    }
    return shellCrossesRegion(shellRegion, regularRegion, regularBVH);
}

/**
 * Determines if the lines of a shell region run over the solid area of a regular (non-shell)
 * region when looking straight down, whatever their heights are. The solid area of a regular
 * region is the space inside its outer contour but outside all its holes.
 *
 * @param {SliceRegion} shellRegion The shell region.
 * @param {SliceRegion} regularRegion The regular region to check against.
 * @param {SliceRegionBVHNode} [regularBVH] A BVH of the regular region's boundary segments (its
 *                                          contour and holes), if the caller already has one.
 *                                          Saves building it when one region is checked many times.
 * @returns {boolean} Whether or not the shell's lines cross the regular region's solid area.
 */
export function shellCrossesRegion(
  shellRegion: SliceRegion,
  regularRegion: SliceRegion,
  regularBVH?: SliceRegionBVHNode,
): boolean {
    // Fast bounding box check
    if (!checkOverlap(shellRegion, regularRegion)) {
        return false;
    }
    const boundaryBVH = regularBVH ?? buildSliceRegionBVH(getBoundarySegments(regularRegion.contour, regularRegion.holes));

    // How many boundary segments a ray from (x, y) towards +x crosses. Same rule as pointInPolygon,
    // but only the segments near the ray are looked at.
    const crossingsRightOf = (node: SliceRegionBVHNode, x: number, y: number): number => {
        if (node.max.y < y || node.min.y > y || node.max.x < x) {
            return 0;
        }
        let count = 0;
        for (const { start, end } of node.leafSegments) {
            if ((start.y > y) !== (end.y > y) && x < ((end.x - start.x) * (y - start.y)) / (end.y - start.y) + start.x) {
                count++;
            }
        }
        if (node.left) count += crossingsRightOf(node.left, x, y);
        if (node.right) count += crossingsRightOf(node.right, x, y);
        return count;
    };

    // Helper to check if a single point is inside the regular region's solid area: inside its
    // contour and outside its holes, so an odd number of boundary crossings away from the outside.
    // A point outside the box around the boundary can't be inside it.
    const isPointInRegularRegion = (pt: THREE.Vector3) =>
        pt.x >= boundaryBVH.min.x && pt.x <= boundaryBVH.max.x && pt.y >= boundaryBVH.min.y && pt.y <= boundaryBVH.max.y
        && crossingsRightOf(boundaryBVH, pt.x, pt.y) % 2 === 1;

    // Gather all contours from the shell (outer contour + inner shell layers stored in holes)
    const shellContours = [shellRegion.contour, ...shellRegion.holes];

    // 1. Vertex Inclusion Check
    // See if any vertex of the shell's contours lies inside the regular region's solid space
    for (const contour of shellContours) {
        for (const pt of contour) {
            if (isPointInRegularRegion(pt)) {
                return true;
            }
        }
    }

    // 2. Edge Intersection Check
    // Fallback in case a shell segment crosses entirely over a regular region
    // without any of its vertices falling inside the area.
    const shellSegments = getBoundarySegments(shellRegion.contour, shellRegion.holes);

    const ccw = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
        return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
    };

    // Two segments can only cross where their bounding boxes overlap, so walk a BVH of the regular
    // region's segments and only test a shell segment against the ones near it.
    const crossesAny = (
      node: SliceRegionBVHNode,
      sSeg: LineSegment,
      minX: number, maxX: number, minY: number, maxY: number
    ): boolean => {
        if (node.max.x < minX || node.min.x > maxX || node.max.y < minY || node.min.y > maxY) {
            return false;
        }
        for (const rSeg of node.leafSegments) {
            if (
                ccw(sSeg.start, rSeg.start, rSeg.end) !== ccw(sSeg.end, rSeg.start, rSeg.end) &&
                ccw(sSeg.start, sSeg.end, rSeg.start) !== ccw(sSeg.start, sSeg.end, rSeg.end)
            ) {
                return true;
            }
        }
        return (node.left !== undefined && crossesAny(node.left, sSeg, minX, maxX, minY, maxY))
            || (node.right !== undefined && crossesAny(node.right, sSeg, minX, maxX, minY, maxY));
    };

    for (const sSeg of shellSegments) {
        if (crossesAny(
            boundaryBVH,
            sSeg,
            Math.min(sSeg.start.x, sSeg.end.x), Math.max(sSeg.start.x, sSeg.end.x),
            Math.min(sSeg.start.y, sSeg.end.y), Math.max(sSeg.start.y, sSeg.end.y),
        )) {
            return true;
        }
    }

    return false;
}

/**
 * Determines if a shell region rests on a regular (non-shell) region: whether any of its lines
 * runs over the regular region's solid area at a spot where the shell layer below does not hold
 * it up. A wall that leans is held up by the wall under it, a little to the side, so it does not
 * rest on the foam it leans over and can be printed before that foam. The first wall of a part
 * that starts on top of foam has nothing but the foam under it.
 *
 * The lines are checked at their corners and every {@link WALL_SAMPLE_SPACING} mm in between.
 *
 * @param {SliceRegion} shellRegion The shell region.
 * @param {SliceRegion} regularRegion The regular region it may rest on.
 * @param {SliceRegion[]} wallsBelow The shell regions one shell layer below the shell region.
 * @param {number} wallOverhang How far (mm) to the side of a line of the shell layer below a
 *                              shell line can be and still be held up by it.
 * @param {SliceRegionBVHNode} [regularBVH] A BVH of the regular region's boundary segments, if the caller already has one.
 * @returns {boolean} Whether or not the shell rests on the regular region.
 */
export function shellRestsOnRegion(
  shellRegion: SliceRegion,
  regularRegion: SliceRegion,
  wallsBelow: SliceRegion[],
  wallOverhang: number,
  regularBVH?: SliceRegionBVHNode,
): boolean {
    // Fast bounding box check
    if (!checkOverlap(shellRegion, regularRegion)) {
        return false;
    }
    const boundaryBVH = regularBVH ?? buildSliceRegionBVH(getBoundarySegments(regularRegion.contour, regularRegion.holes));

    const restsAt = (x: number, y: number): boolean => {
        // over the regular region's solid area: inside its contour and outside its holes
        if (x < boundaryBVH.min.x || x > boundaryBVH.max.x || y < boundaryBVH.min.y || y > boundaryBVH.max.y
            || boundaryCrossingsRightOf(boundaryBVH, x, y) % 2 === 0) {
            return false;
        }
        // and with no line of the shell layer below close enough under it
        return !wallsBelow.some(wall => segmentNearBoundary(wall.BVH, x, y, x, y, wallOverhang));
    };

    for (const line of [shellRegion.contour, ...shellRegion.holes]) {
        for (let i = 0; i < line.length; i++) {
            const from = line[i], to = line[(i + 1) % line.length];
            const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / WALL_SAMPLE_SPACING));
            for (let k = 0; k < steps; k++) {
                const t = k / steps;
                if (restsAt(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)) {
                    return true;
                }
            }
        }
    }
    return false;
}

/**
 * Build a tree of RegionNodes that encode hiearchy of slice regions. The tree starts from the bottom
 * of the model and goes upwards. If a region could have two parents, it just chooses the first it finds.
 *
 * A regular (foam) region's parent is a region in the layer below it (compared by height, so
 * rounding can't put neighbouring layers in the wrong order) whose material it really overlaps.
 * Regions in the same layer are never each other's parent.
 *
 * Shell regions are printed layer by layer, so they are simply chained in order of height, each
 * one the child of the one before it, whether or not they overlap. Each shell region also records
 * which regular regions it rests on (see shellRestsOnRegion): the foam under it that has to be
 * printed first, because the shell layer below does not hold it up there.
 *
 * @param {SliceRegion[]} regions The list of slice regions to build the tree from.
 * @param {number} layerHeight The layer height of the slice regions. Must be positive.
 * @param {number} [wallOverhang] How far (mm) to the side of a line of the shell layer below a
 *                                shell line can be and still be held up by it: about half the
 *                                width of a shell line.
 * @returns {RegionNode[]} The root nodes of the tree.
 * @throws {Error} If layerHeight is not a positive, finite number.
 */
export function buildRegionTree(
  regions: SliceRegion[],
  layerHeight: number,
  wallOverhang: number = DEFAULT_WALL_OVERHANG,
): RegionNode[] {
    assertPositiveStep(layerHeight, 'Layer height');

    // create nodes for each region
    const nodes: RegionNode[] = regions.map(region => ({
        region,
        children: [],
        parent: null,
        layer: Math.floor((region.height + HEIGHT_EPSILON) / layerHeight),
        visited: false,
        shell: region.shell,
        shellDependentRegions: (region.shell ? new Set<string>() : undefined),
        shellHeight: (region.shell ? region.height : undefined),
    }));

    const regularNodes = nodes.filter(node => !node.shell);
    const shellNodes = nodes.filter(node => node.shell);

    // --- regular regions ---
    // sort in ascending order to start from the bottom of the tree
    const sortedRegular = regularNodes.slice().sort((a, b) => a.region.height - b.region.height);

    // figure out parent-child relationships
    for (let i = 0; i < sortedRegular.length; i++) {
        const node = sortedRegular[i];
        for (let j = i + 1; j < sortedRegular.length; j++) {
            const otherNode = sortedRegular[j];
            const heightAbove = otherNode.region.height - node.region.height;
            // break out of for loop after checking all nodes in the next layer up.
            if (heightAbove >= MAX_PARENT_GAP_LAYERS * layerHeight) {
              break;
            }
            // nodes in the same layer sit side by side, not on top of each other
            if (heightAbove <= HEIGHT_EPSILON) {
              continue;
            }
            if (otherNode.parent === null && checkPolygonOverlap(node.region, otherNode.region)) {
                node.children.push(otherNode);
                otherNode.parent = node;
            }
        }
    }

    // --- shell regions ---
    // A shell's only parent is the shell before it, in order of height. No overlap check: the
    // shell is printed a whole layer at a time, across every island of the model.
    const sortedShell = shellNodes.slice().sort((a, b) => a.region.height - b.region.height);
    for (let i = 0; i + 1 < sortedShell.length; i++) {
        const node = sortedShell[i];
        const next = sortedShell[i + 1];
        // a gap of more than a foam layer starts a new chain
        if (next.layer - node.layer > 1) continue;
        node.children.push(next);
        next.parent = node;
    }

    // --- which regular regions each shell region rests on ---
    const shellsByLayer = new Map<number, RegionNode[]>();
    for (const shellNode of sortedShell) {
        const list = shellsByLayer.get(shellNode.layer);
        if (list) list.push(shellNode); else shellsByLayer.set(shellNode.layer, [shellNode]);
    }

    // The shell regions one shell layer below each shell region: the walls that can hold it up.
    // Shell layers are evenly spaced, so anything further down than that is not right below it.
    let shellSpacing = Infinity;
    for (let i = 0; i + 1 < sortedShell.length; i++) {
        const step = sortedShell[i + 1].region.height - sortedShell[i].region.height;
        if (step > HEIGHT_EPSILON) shellSpacing = Math.min(shellSpacing, step);
    }
    const wallsBelow = new Map<RegionNode, SliceRegion[]>();
    let levelBelow: RegionNode[] = [];
    let level: RegionNode[] = [];
    for (const shellNode of sortedShell) {
        if (level.length && shellNode.region.height - level[0].region.height > HEIGHT_EPSILON) {
            levelBelow = level;
            level = [];
        }
        level.push(shellNode);
        const rightBelow = levelBelow.length > 0
            && shellNode.region.height - levelBelow[0].region.height <= shellSpacing * 1.5;
        wallsBelow.set(shellNode, rightBelow ? levelBelow.map(below => below.region) : []);
    }

    for (const node of regularNodes) {
        // Built once for the region, and only if a shell comes near it.
        let boundaryBVH: SliceRegionBVHNode | undefined;
        for (const layer of [node.layer, node.layer + 1]) {
            const shells = shellsByLayer.get(layer);
            if (!shells) continue;
            for (const shellNode of shells) {
                if (!checkOverlap(shellNode.region, node.region)) continue;
                const dz = shellNode.region.height - node.region.height;
                if (dz < -HEIGHT_EPSILON || dz > layerHeight + HEIGHT_EPSILON) continue;
                boundaryBVH ??= buildSliceRegionBVH(getBoundarySegments(node.region.contour, node.region.holes));
                //check to see if the shell depends on this region
                if (shellRestsOnRegion(shellNode.region, node.region, wallsBelow.get(shellNode)!, wallOverhang, boundaryBVH)) {
                    shellNode.shellDependentRegions!.add(node.region.id);
                }
            }
        }
    }

    // return root nodes (ones with no parent)
    return nodes.filter(node => node.parent === null);
}


/**
 * Gets the axis aligned bounding box of a list of line segments. An empty list gives an inverted
 * box, so that nothing is ever found inside of it.
 *
 * @param {LineSegment[]} segments The segments to bound.
 * @returns {{min: THREE.Vector3, max: THREE.Vector3}} The bounding box of the segments.
 */
function getSegmentBounds(
  segments: LineSegment[],
): { min: THREE.Vector3; max: THREE.Vector3 } {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  for (const segment of segments) {
    min.min(segment.start).min(segment.end);
    max.max(segment.start).max(segment.end);
  }

  return { min, max };
}


/**
 * Builds a BVH over the boundary segments of a single region, so that queries against the region's
 * boundary don't have to walk every segment. A region is planar, so unlike a chunk BVH this only
 * ever splits along x or y.
 *
 * The leaves hold references to the same segments that were passed in, so the tree goes stale if
 * the region's contours are moved after it is built.
 *
 * @param {LineSegment[]} segments The boundary segments of the region.
 * @returns {SliceRegionBVHNode} The root node of the region's BVH.
 */
export function buildSliceRegionBVH(
  segments: LineSegment[],
): SliceRegionBVHNode {
  const bounds = getSegmentBounds(segments);

  // few enough segments left that splitting further costs more than it saves
  if (segments.length <= CHUNK_BVH_LEAF_SIZE) {
    return {
      min: bounds.min,
      max: bounds.max,
      leafSegments: segments,
    };
  }

  // split along whichever of x and y the segments are most spread out on
  const axis: 'x' | 'y' =
    bounds.max.y - bounds.min.y > bounds.max.x - bounds.min.x ? 'y' : 'x';

  // Sort by midpoint along that axis and split at the median. Splitting at the centre of the
  // bounds instead would leave every segment on one side whenever they are unevenly spread,
  // which would never terminate.
  const sorted = segments.slice().sort((a, b) =>
    (a.start[axis] + a.end[axis]) - (b.start[axis] + b.end[axis])
  );

  const mid = Math.floor(sorted.length / 2);

  return {
    min: bounds.min,
    max: bounds.max,
    left: buildSliceRegionBVH(sorted.slice(0, mid)),
    right: buildSliceRegionBVH(sorted.slice(mid)),
    leafSegments: [],
  };
}

/**
 * What the chunk builder needs to know about one model's regions. Everything but the roots has a
 * default, so a single model at the origin only needs its region tree.
 */
export interface ChunkSource {
  /** The root nodes of the model's region tree. */
  roots: RegionNode[];
  /** Where the model sits on the bed. Region coordinates are relative to it. Defaults to the origin. */
  position?: THREE.Vector3;
  /** The settings a chunk printed by an extruder is created with. Defaults to the printer's current ones. */
  settings?: (extruder: number) => VTPSettings;
  /** The model the regions were sliced from. Set on every chunk. */
  modelObj?: EverydayModel;
  /**
   * How far (mm) above a region's slice plane the nozzle tip is at its lowest while the region is
   * printed. Defaults to the shell layer height for a shell and to H = H* d for foam.
   */
  tipOffset?: (region: SliceRegion) => number;
  /**
   * How far (mm) above its slice plane a region's material reaches once it is printed. Defaults
   * to the shell layer height for a shell and to the layer thickness (deltaZ) for foam.
   */
  thickness?: (region: SliceRegion) => number;
  /**
   * How far (mm) a region's material reaches past the path the nozzle takes to print it. Defaults
   * to half a line for a shell, and for foam to the reach of its coils at the largest H* its
   * settings give (see coilReach).
   */
  reach?: (region: SliceRegion) => number;
}

/** A region as the chunk builder sees it: where it is on the bed, and which chunk it ended up in. */
interface ChunkSlot {
  node: RegionNode;
  region: SliceRegion;
  source: ChunkSource;
  /** Where the region's model sits on the bed, which its coordinates are relative to. */
  dx: number;
  dy: number;
  /** Height of the slice plane above the bed. */
  z: number;
  /** Height the region's material reaches once printed. */
  top: number;
  /** Height of the nozzle tip, at its lowest, while the region is printed. */
  tipZ: number;
  /** The extruder that prints the region, for the shape of its nozzle. */
  extruder: Extruder;
  /** How far the region's material reaches past its outline: half a shell line, or the reach of foam's coils. */
  margin: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  chunk: ChunkNode | null;
  /** The printing round of the chunk it is in (see ChunkNode.order). */
  order: number;
  /** The region's boundary, as segments and as a BVH of them. Made when first needed. */
  segments?: LineSegment[];
  bvh?: SliceRegionBVHNode;
}

/**
 * How many boundary segments a ray from (x, y) towards +x crosses. An odd number means the point
 * is inside the boundary's contour and outside its holes. Same rule as pointInPolygon, but only
 * the segments near the ray are looked at.
 */
function boundaryCrossingsRightOf(node: SliceRegionBVHNode, x: number, y: number): number {
  if (node.max.y < y || node.min.y > y || node.max.x < x) {
    return 0;
  }
  let count = 0;
  for (const { start, end } of node.leafSegments) {
    if ((start.y > y) !== (end.y > y) && x < ((end.x - start.x) * (y - start.y)) / (end.y - start.y) + start.x) {
      count++;
    }
  }
  if (node.left) count += boundaryCrossingsRightOf(node.left, x, y);
  if (node.right) count += boundaryCrossingsRightOf(node.right, x, y);
  return count;
}

/** Squared distance in x and y from a point to a segment. */
function pointSegmentDistanceSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax, aby = by - ay;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq > 0 ? Math.min(1, Math.max(0, ((px - ax) * abx + (py - ay) * aby) / lengthSq)) : 0;
  const dx = px - (ax + t * abx), dy = py - (ay + t * aby);
  return dx * dx + dy * dy;
}

/**
 * Whether the segment from (ax, ay) to (bx, by) comes closer than `distance` to any boundary
 * segment in a BVH, looking straight down. Segments that cross are closer than any distance.
 */
function segmentNearBoundary(
  node: SliceRegionBVHNode,
  ax: number, ay: number, bx: number, by: number,
  distance: number,
): boolean {
  if (node.max.x < Math.min(ax, bx) - distance || node.min.x > Math.max(ax, bx) + distance
      || node.max.y < Math.min(ay, by) - distance || node.min.y > Math.max(ay, by) + distance) {
    return false;
  }
  const distanceSq = distance * distance;
  for (const { start, end } of node.leafSegments) {
    if (pointSegmentDistanceSq(ax, ay, start.x, start.y, end.x, end.y) < distanceSq
        || pointSegmentDistanceSq(bx, by, start.x, start.y, end.x, end.y) < distanceSq
        || pointSegmentDistanceSq(start.x, start.y, ax, ay, bx, by) < distanceSq
        || pointSegmentDistanceSq(end.x, end.y, ax, ay, bx, by) < distanceSq) {
      return true;
    }
    // Neither end of one is near the other, so they are only this close if they cross.
    const side1 = (end.x - start.x) * (ay - start.y) - (end.y - start.y) * (ax - start.x);
    const side2 = (end.x - start.x) * (by - start.y) - (end.y - start.y) * (bx - start.x);
    const side3 = (bx - ax) * (start.y - ay) - (by - ay) * (start.x - ax);
    const side4 = (bx - ax) * (end.y - ay) - (by - ay) * (end.x - ax);
    if ((side1 > 0) !== (side2 > 0) && (side3 > 0) !== (side4 > 0)) {
      return true;
    }
  }
  return (node.left !== undefined && segmentNearBoundary(node.left, ax, ay, bx, by, distance))
      || (node.right !== undefined && segmentNearBoundary(node.right, ax, ay, bx, by, distance));
}

/**
 * Builds the tree of printable chunks of one model that sits at the origin. See
 * {@link buildChunkForest}, which this is a shorthand for.
 *
 * @param {RegionNode[]} roots The root nodes of the region tree.
 * @param {Printer} printer The printer, for its head and nozzle dimensions and current settings.
 * @returns {ChunkNode[]} The root nodes of the printable chunk tree.
 */
export function buildChunkTree(
  roots: RegionNode[],
  printer: Printer,
): ChunkNode[] {
  return buildChunkForest([{ roots }], printer);
}

/**
 * Builds the trees of printable chunks for everything on the plate. A chunk is a run of regions
 * stacked on top of each other that is printed in one go, without leaving for another part of the
 * print, which is what saves travel moves.
 *
 * This follows TRAvel Slicer (Gould, Friedman-Gerlicz and Buechley, UIST 2024), with one change.
 * TRAvel Slicer cuts every stack at fixed multiples of the nozzle height. Here a chunk is as tall
 * as the nozzle and the print head allow at that spot: it keeps growing until its next region
 * would be in the way of something that is printed after it. That depends on what is still to be
 * printed nearby, on how far away it is, and on how high the nozzle rides there (on the layer for
 * a shell, H = H* d above it for foam). A stack with nothing near it is one chunk.
 *
 * The chunks are cut in the order they are printed in, a round at a time, and each gets the
 * number of its round (ChunkNode.order). A round is the stacks that can go next, with the lowest
 * nozzle first; they are printed in any order. A region goes into a chunk only if it can be
 * printed before every region that is not in an earlier round. For each of those:
 *  - it does not cover the other region from above, which the nozzle could then not reach. A
 *    shell counts as covering foam only where it rests on it (see shellRestsOnRegion): a wall
 *    that leans over foam goes first, and the foam nozzle passes over it;
 *  - it stays below the nozzle tip where the nozzle comes right next to it, and further away it
 *    stays clear of the nozzle, which widens upwards (see nozzleRadiusAt);
 *  - it stays below the head body, one nozzle length above the nozzle tip, wherever it lies
 *    inside the head's footprint while the other region is printed.
 * A stack starts a round only when its first region passes the same test. If none does (a shell
 * that is printed into the foam under it, say), the one with the lowest nozzle goes anyway.
 *
 * Stacks that never come within reach of each other, nozzle or head, are done one group after
 * the other, so that parts far apart on the plate are each finished in one visit.
 *
 * A chunk also ends where the stack branches, where the extruder changes, and where a shell goes
 * from resting on foam to not resting on foam or back.
 *
 * @param {ChunkSource[]} sources The region trees to build chunks from, one per model.
 * @param {Printer} printer The printer, for its head and nozzle dimensions and current settings.
 * @returns {ChunkNode[]} The root nodes of the chunk trees, in the order of the sources' roots.
 */
export function buildChunkForest(
  sources: ChunkSource[],
  printer: Printer,
): ChunkNode[] {
  const head = printer.printHeadDims;
  const slots: ChunkSlot[] = [];
  const slotOf = new Map<RegionNode, ChunkSlot>();
  // Chunks waiting to be cut: the region each one starts with, and where it goes in the tree.
  type Pending = { slot: ChunkSlot; siblings: ChunkNode[]; index: number; parent: ChunkNode | null };
  let pending: Pending[] = [];
  const rootChunks: ChunkNode[] = [];
  const settingsOf = (source: ChunkSource, extruder: number): VTPSettings =>
    source.settings ? source.settings(extruder) : printer.getVTPSettings(extruder);

  for (const source of sources) {
    const position = source.position ?? new THREE.Vector3();
    const tipOffset = source.tipOffset ?? ((region: SliceRegion) => {
      if (region.shell) return printer.shellLayerHeight;
      const vtp = settingsOf(source, region.extruder);
      return Math.min(vtp.H_star, vtp.hStarEnd ?? vtp.H_star) * printer.threadDiameter(region.extruder);
    });
    const thickness = source.thickness ?? ((region: SliceRegion) =>
      region.shell ? printer.shellLayerHeight : settingsOf(source, region.extruder).deltaZ);
    const reach = source.reach ?? ((region: SliceRegion) => {
      if (region.shell) return (printer.extruders[region.extruder] ?? printer.extruders[0]).nozzleDiameter / 2;
      const vtp = settingsOf(source, region.extruder);
      return coilReach(Math.max(vtp.H_star, vtp.hStarEnd ?? vtp.H_star), printer.threadDiameter(region.extruder));
    });

    // Walked with a stack rather than by recursion: a tall model's regions are one long chain.
    const stack = [...source.roots];
    while (stack.length) {
      const node = stack.pop()!;
      const region = node.region;
      const z = region.height + position.z;
      const extruder = printer.extruders[region.extruder] ?? printer.extruders[0];
      const tip = tipOffset(region);
      const slot: ChunkSlot = {
        node,
        region,
        source,
        dx: position.x,
        dy: position.y,
        z,
        // Material cannot stand higher than the nozzle that laid it.
        top: z + Math.min(thickness(region), tip),
        tipZ: z + tip,
        extruder,
        margin: reach(region),
        minX: region.bounds.min.x + position.x,
        maxX: region.bounds.max.x + position.x,
        minY: region.bounds.min.y + position.y,
        maxY: region.bounds.max.y + position.y,
        chunk: null,
        order: Infinity,
      };
      slots.push(slot);
      slotOf.set(node, slot);
      for (const child of node.children) stack.push(child);
    }

    for (const root of source.roots) {
      pending.push({ slot: slotOf.get(root)!, siblings: rootChunks, index: rootChunks.length, parent: null });
      rootChunks.length++;
    }
  }

  // Sorted by height, so the regions below a height are the start of the list.
  const byHeight = slots.slice().sort((a, b) => a.z - b.z);
  // Everything before this index is in a chunk of an earlier round, so it is already printed.
  let firstOpen = 0;

  const boundaryOf = (slot: ChunkSlot): SliceRegionBVHNode => {
    slot.segments ??= getBoundarySegments(slot.region.contour, slot.region.holes);
    return slot.bvh ??= buildSliceRegionBVH(slot.segments);
  };

  // Whether the material of two regions overlaps when looking straight down. Worked out once per pair.
  const overlaps = new Map<ChunkSlot, Map<ChunkSlot, boolean>>();
  const materialOverlaps = (a: ChunkSlot, b: ChunkSlot): boolean => {
    if (a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY) return false;
    // Regions of two models are in different coordinates, so their boxes are all there is to compare.
    if (a.source !== b.source) return true;
    let known = overlaps.get(a);
    if (!known) overlaps.set(a, known = new Map());
    let result = known.get(b);
    if (result === undefined) {
      if (a.region.shell === b.region.shell) {
        result = checkPolygonOverlap(a.region, b.region);
      } else {
        // A shell is lines, not an area: it overlaps foam where its lines run over the foam.
        const [shell, foam] = a.region.shell ? [a, b] : [b, a];
        result = shellCrossesRegion(shell.region, foam.region, boundaryOf(foam));
      }
      known.set(b, result);
    }
    return result;
  };

  /**
   * Whether two regions come closer to each other than a distance, looking straight down. A shell
   * is its lines; anything else is the area inside its contour and outside its holes.
   */
  const closerThan = (a: ChunkSlot, b: ChunkSlot, distance: number): boolean => {
    const bBoundary = boundaryOf(b);
    boundaryOf(a);
    // a's coordinates, moved to where b's are.
    const ox = a.dx - b.dx, oy = a.dy - b.dy;
    for (const { start, end } of a.segments!) {
      if (segmentNearBoundary(bBoundary, start.x + ox, start.y + oy, end.x + ox, end.y + oy, distance)) return true;
    }
    // No two boundary lines are near each other, so they are only this close if one is inside the other.
    const inside = (point: THREE.Vector3 | undefined, area: ChunkSlot, shiftX: number, shiftY: number) =>
      point !== undefined && !area.region.shell
      && boundaryCrossingsRightOf(area.bvh!, point.x + shiftX, point.y + shiftY) % 2 === 1;
    return inside(a.region.contour[0], b, ox, oy) || inside(b.region.contour[0], a, -ox, -oy);
  };

  // What is known about how far apart two regions are: closer than `under`, and not closer than `atLeast`.
  const gaps = new Map<ChunkSlot, Map<ChunkSlot, { under: number; atLeast: number }>>();
  const isCloserThan = (a: ChunkSlot, b: ChunkSlot, distance: number): boolean => {
    const gapX = Math.max(b.minX - a.maxX, a.minX - b.maxX, 0);
    const gapY = Math.max(b.minY - a.maxY, a.minY - b.maxY, 0);
    if (gapX * gapX + gapY * gapY >= distance * distance) return false;
    let known = gaps.get(a);
    if (!known) gaps.set(a, known = new Map());
    let gap = known.get(b);
    if (!gap) known.set(b, gap = { under: Infinity, atLeast: 0 });
    if (distance >= gap.under) return true;
    if (distance <= gap.atLeast) return false;
    const closer = closerThan(a, b, distance);
    if (closer) gap.under = distance; else gap.atLeast = distance;
    return closer;
  };

  /**
   * Whether a region can be printed in a round, before every region that is not in an earlier
   * round: the rest of its own chunk aside, those are printed after it, or in the same round in
   * either order.
   */
  const canPrint = (slot: ChunkSlot, own: ChunkNode | null, round: number): boolean => {
    // Only a region lower than the top of this one can be covered by it or have the nozzle or head reach it.
    for (let i = firstOpen; i < byHeight.length && byHeight[i].z < slot.top; i++) {
      const other = byHeight[i];
      if (other === slot || (own !== null && other.chunk === own)) continue;
      // In a chunk of an earlier round: printed before this one is.
      if (other.order < round) continue;

      // A shell only has to wait for foam it rests on. A wall that leans over foam is held up by
      // the wall under it and goes first: the foam nozzle then passes over it.
      const covers = slot.region.shell && !other.region.shell
        ? slot.source === other.source && (slot.node.shellDependentRegions?.has(other.region.id) ?? false)
        : other.z < slot.z - HEIGHT_EPSILON && materialOverlaps(slot, other);
      if (covers) return false;

      // How far this region would stand above the nozzle tip while the other one is printed.
      const above = slot.top - other.tipZ;
      if (above <= HEIGHT_EPSILON) continue;
      if (above > other.extruder.nozzleLength + HEIGHT_EPSILON
          && other.minX + head.min.x <= slot.maxX && other.maxX + head.max.x >= slot.minX
          && other.minY + head.min.y <= slot.maxY && other.maxY + head.max.y >= slot.minY) {
        return false;
      }
      if (isCloserThan(slot, other, nozzleRadiusAt(other.extruder, above) + slot.margin + NOZZLE_CLEARANCE)) return false;
    }
    return true;
  };

  // Stacks that never come within reach of each other, nozzle or head, cannot get in each
  // other's way. They are grouped by reach, and each group is finished before the next is
  // started, so the head does not go back and forth between parts that are far apart.
  const reachOf = new Map<Pending, { minX: number; maxX: number; minY: number; maxY: number }>();
  for (const entry of pending) {
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    const stack = [entry.slot.node];
    while (stack.length) {
      const node = stack.pop()!;
      const slot = slotOf.get(node)!;
      box.minX = Math.min(box.minX, slot.minX); box.maxX = Math.max(box.maxX, slot.maxX);
      box.minY = Math.min(box.minY, slot.minY); box.maxY = Math.max(box.maxY, slot.maxY);
      for (const child of node.children) stack.push(child);
    }
    reachOf.set(entry, box);
  }
  let widestNozzle = 0;
  for (const extruder of printer.extruders) widestNozzle = Math.max(widestNozzle, nozzleRadiusAt(extruder, Infinity));
  // How far the head, or the widest nozzle with its clearance, reaches from where the nozzle is.
  const reach = {
    minX: Math.min(head.min.x, -widestNozzle) - 1, maxX: Math.max(head.max.x, widestNozzle) + 1,
    minY: Math.min(head.min.y, -widestNozzle) - 1, maxY: Math.max(head.max.y, widestNozzle) + 1,
  };
  const reaches = (from: Pending, to: Pending): boolean => {
    const a = reachOf.get(from)!, b = reachOf.get(to)!;
    return a.minX + reach.minX <= b.maxX && a.maxX + reach.maxX >= b.minX
        && a.minY + reach.minY <= b.maxY && a.maxY + reach.maxY >= b.minY;
  };
  const groups: Pending[][] = [];
  const ungrouped = new Set(pending);
  for (const entry of pending) {
    if (!ungrouped.delete(entry)) continue;
    const group = [entry];
    for (let i = 0; i < group.length; i++) {
      for (const other of ungrouped) {
        if (reaches(group[i], other) || reaches(other, group[i])) {
          ungrouped.delete(other);
          group.push(other);
        }
      }
    }
    groups.push(group);
  }

  let round = 0;
  for (const group of groups) {
    pending = group;
    while (pending.length) {
      round++;
      while (firstOpen < byHeight.length && byHeight[firstOpen].order < round) firstOpen++;

      // The stacks that can go next, lowest nozzle first. If none can go without getting in the
      // way of something, the lowest nozzle goes anyway.
      const free = pending.filter(entry => canPrint(entry.slot, null, round));
      const candidates = free.length ? free : pending;
      let lowestTip = Infinity;
      for (const entry of candidates) lowestTip = Math.min(lowestTip, entry.slot.tipZ);
      const starting = free.length
        ? free.filter(entry => entry.slot.tipZ <= lowestTip + HEIGHT_EPSILON)
        : [candidates.find(entry => entry.slot.tipZ <= lowestTip)!];
      pending = pending.filter(entry => !starting.includes(entry));

      for (const { slot: first, siblings, index, parent } of starting) {
        const shell = first.node.shell;
        const chunk: ChunkNode = {
          regions: [],
          children: [],
          parent,
          modelObj: first.source.modelObj,
          // A copy, so later updateParameters calls (e.g. for the next model) don't change this chunk.
          VTPSettings: { ...settingsOf(first.source, first.region.extruder) },
          shell,
          order: round,
          dependentRegions: shell ? new Set<string>() : undefined,
          regionDependencies: shell ? new Map<string, Set<string>>() : undefined,
        };
        siblings[index] = chunk;

        const add = (slot: ChunkSlot) => {
          slot.chunk = chunk;
          slot.order = round;
          chunk.regions.push(slot.region);
          if (shell) {
            slot.node.shellDependentRegions?.forEach(id => chunk.dependentRegions!.add(id));
            chunk.regionDependencies!.set(slot.region.id, new Set(slot.node.shellDependentRegions));
          }
        };
        add(first);

        let node = first.node;
        while (node.children.length === 1) {
          const next = slotOf.get(node.children[0])!;
          // A chunk is printed without a tool change, so it can only ever hold one extruder's regions.
          if (next.region.extruder !== first.region.extruder) break;
          // A shell on top of foam is ironed and has to wait for that foam; one that is not, is not.
          if (shell && ((next.node.shellDependentRegions?.size ?? 0) > 0) !== (chunk.dependentRegions!.size > 0)) break;
          if (!canPrint(next, chunk, round)) break;
          add(next);
          node = next.node;
        }

        chunk.children.length = node.children.length;
        node.children.forEach((child, i) => {
          pending.push({ slot: slotOf.get(child)!, siblings: chunk.children, index: i, parent: chunk });
        });
      }
    }
  }

  return rootChunks;
}

/**
 * Returns a list with another list's items inserted at an index. Used instead of
 * `list.splice(index, 0, ...items)`, which passes every item as a call argument and overflows the
 * stack on a long path.
 *
 * @param {T[]} list The list. It is not modified.
 * @param {number} index Where the items go.
 * @param {T[]} items The items to insert.
 * @returns {T[]} The new list.
 */
function insertAt<T>(list: T[], index: number, items: T[]): T[] {
  return list.slice(0, index).concat(items, list.slice(index));
}


/**
 * Makes a 2D contour into a path readable by clipper, while scaling it up.
 * 
 * @param {{ x: number, y: number }[]} loop The contour. Only x and y are used, so 3D points work too.
 * @returns {ClipperLib.IntPoint[]} The clipper path.
 */
function toClipperPath(
  loop: { x: number; y: number }[]
): ClipperLib.IntPoint[] {
  return loop.map(pt => ({
    X: Math.round(pt.x * CLIPPER_SCALE),
    Y: Math.round(pt.y * CLIPPER_SCALE),
  }));
}


/**
 * Makes a clipper path into a 2D contour while scaling it down.
 * 
 * @param {ClipperLib.IntPoint[]} loop The clipper path.
 * @returns {THREE.Vector2[]} The 2D contour.
 */
function fromClipperPath(path: ClipperLib.IntPoint[]) {
  return path.map(pt =>
    new THREE.Vector2(pt.X / CLIPPER_SCALE, pt.Y / CLIPPER_SCALE)
  );
}


/**
 * Gets the signed area of a clipper path.
 * 
 * @param {ClipperLib.IntPoint[]} path The clipper path.
 * @returns {number} The signed area.
 */
function clipperArea(
  path: ClipperLib.IntPoint[]
): number {
  let area = 0;
  for (let i = 0; i < path.length; i++) {
    const p1 = path[i], p2 = path[(i + 1) % path.length];
    area += p1.X * p2.Y - p2.X * p1.Y;
  }
  return area / 2;
}


/**
 * Helper function for generateInsetContourTree that prepares the outer contours and hole contours
 * by making them a consistent winding order (CCW for holes, CW for outer) and making them 2D.
 * The contours passed in are left untouched; the reordering happens on the 2D copies.
 *
 * @param {THREE.Vector3[]} outer The outer contour.
 * @param {THREE.Vector3[][]} holes The hole contours.
 * @returns {THREE.Vector2[][]} All of the 2D paths (outer and holes).
 */
function preparePaths(
  outer: THREE.Vector3[],
  holes: THREE.Vector3[][]
): THREE.Vector2[][] {
  const toLoop = (contour: THREE.Vector3[], counterClockwise: boolean): THREE.Vector2[] => {
    const loop = contour.map(point => new THREE.Vector2(point.x, point.y));
    if (getWindingOrder(contour) !== counterClockwise) {
      loop.reverse();
    }
    return loop;
  };

  return [toLoop(outer, false), ...holes.map(hole => toLoop(hole, true))];
}



/**
 * Gets a point a certain distance along a line.
 * 
 * @param {THREE.Vector3} a The start point of the line.
 * @param {THREE.Vector3} b The end point of the line.
 * @param {number} distance The distance, from the start point, along the line to get the point at.
 * @returns {THREE.Vector3} The point along the line.
 */
export function pointAlongLine(
  a: THREE.Vector3,
  b: THREE.Vector3,
  distance: number
): THREE.Vector3 {
  const totalLen = a.distanceTo(b);
  if (totalLen === 0) return a.clone();
  const t = distance / totalLen;
  return a.clone().lerp(b, t);
}


/**
 * Helper function for connectIsocontours
 * Spirals a list of contours towards the center, only connecting contours in the indicesToSpiral
 * 
 * @param {THREE.Vector3[][]} isocontours The inset isocontours to spiral.
 * @param {number[]} indicesToSpiral The indices of the isocontours array to spiral.
 * @param {number} initialStartIndex Where to start spiralling from in the outermost isocontour.
 * @param {number} step How far apart each isocontour is.
 * @returns {THREE.Vector3[]} A list of points representing the inwards spiral.
 */
function spiralContours(
  isocontours: THREE.Vector3[][],
  indicesToSpiral: number[],
  initialStartIndex: number,
  step: number,
  edot: number
): PathPoint[] {
  let path: PathPoint[] = [];

  let startIndex = initialStartIndex;
  let initialDist = 0;
  for (const i of indicesToSpiral) {
    let totalDist = initialDist;
    let endIndex = 0;
    let lastPointIndex = startIndex
    let endPoint = new THREE.Vector3;
    const offsetAmount = i + 1 >= isocontours.length ? step : 2 * step;
    for (let j = 1; totalDist < offsetAmount; j++) {
      endIndex = startIndex - j;
      while (endIndex < 0) {
        endIndex += isocontours[i].length;
      }
      endIndex = endIndex % isocontours[i].length;
      const dist = isocontours[i][lastPointIndex].distanceTo(isocontours[i][endIndex]);
      if (totalDist + dist >= offsetAmount) {
        endPoint = pointAlongLine(isocontours[i][lastPointIndex], isocontours[i][endIndex], offsetAmount - totalDist);
      }
      totalDist += dist;
      lastPointIndex = endIndex;
    }
    let curIndex = startIndex;
    while(curIndex != endIndex) {
      path.push({point: isocontours[i][curIndex], travel: false, edot});
      curIndex++;
      if (curIndex >= isocontours[i].length) {
        curIndex -= isocontours[i].length;
      }
    }
    path.push({point: isocontours[i][endIndex], travel: false, edot});

    path.push({point: endPoint, travel: false, edot});

    const checkContourIndex = i + 2;
    if (checkContourIndex < isocontours.length) {
      let lowestDist = Infinity;
      let closestIndex = 0;
      let closestPoint = new THREE.Vector3;
      let lastPoint = isocontours[checkContourIndex][isocontours[checkContourIndex].length - 1];
      for (let j = 0; j < isocontours[checkContourIndex].length; j++) {
        const point = isocontours[checkContourIndex][j];
        const line = new THREE.Line3(lastPoint, point);
        let closestPointOnLine = new THREE.Vector3;
        line.closestPointToPoint(endPoint, true, closestPointOnLine);
        const dist = endPoint.distanceTo(closestPointOnLine);
        if (dist < lowestDist) {
          lowestDist = dist;
          closestIndex = j;
          closestPoint = closestPointOnLine;
        }

        lastPoint = point;
      }
      
      path.push({point: closestPoint, travel: false, edot});
      startIndex = closestIndex;
      initialDist = -isocontours[checkContourIndex][startIndex].distanceTo(closestPoint);
    }
  }

  return path;
}

/**
 * Work in progress and buggy, mostly has a bug when the path splits into multiple branches.
 * Connects a tree of inset isocontours into a continous fermat sprial.
 * 
 * @param {ContourNode} isocontoursRoot The root node of the inset contour tree.
 * @param {number} step How far away each inset contour is from each other.
 * @param {THREE.Vector3} lastLayerEndPoint The endpoint of the last layer, this is included so it starts as close
 *                          as possible to the last layer to minimize travel time.
 * @returns {THREE.Vector3[]} A list of points making up the fermat spiral.
 */
export function connectIsocontours(
  isocontoursRoot: ContourNode,
  step: number,
  lastLayerEndPoint: THREE.Vector3,
  edot: number,
  reverse: boolean = false,
): PathPoint[] {
  if (isocontoursRoot.contour.length === 0) {
    return [];
  }

  const isocontours: THREE.Vector3[][] = [];

  let currentNode = isocontoursRoot;
  while (currentNode.children.length === 1) {
    // work on copies: contours get reversed and have points spliced into them below, and the
    // tree's own contours (which can be the caller's region contours) must not change
    if (reverse) {
      isocontours.push(currentNode.contour.slice().reverse());
    } else {
      isocontours.push(currentNode.contour.slice());
    }
    currentNode = currentNode.children[0];
  }
  isocontours.push(currentNode.contour.slice());

  let startIndex = 0;
  let startPoint = new THREE.Vector3;
  let lowestDist = Infinity;
  let lastPointIndex = isocontours[0].length - 1;
  for (let i = 0; i < isocontours[0].length; i++) {
    const point = isocontours[0][i];
    const line = new THREE.Line3(isocontours[0][lastPointIndex], point);
    let closestPointOnLine = new THREE.Vector3;
    line.closestPointToPoint(lastLayerEndPoint, true, closestPointOnLine);
    const dist = lastLayerEndPoint.distanceTo(closestPointOnLine);
    if (dist < lowestDist) {
      lowestDist = dist;
      startIndex = i;
      startPoint = closestPointOnLine;
    }
    lastPointIndex = i;
  }

  isocontours[0].splice(startIndex, 0, startPoint);


  const oddIndices: number[] = [];
  const evenIndices: number[] = [];

  for (let i = 0; i < isocontours.length; i++) {
    if (i % 2  === 0) {
      evenIndices.push(i);
    } else {
      oddIndices.push(i);
    }
  }

  // make inwards path
  let path = spiralContours(isocontours, evenIndices, startIndex, step, edot);

  // make paths for children nodes before spiralling outwards only if the most inward contour is spiralled inwards
  if (isocontours.length % 2 === 1 && currentNode.children.length > 0) {
    const childPaths: {path: PathPoint[], index: number}[] = [];
    for (const child of currentNode.children) {
      lowestDist = Infinity;
      let closestIndexOuter = 0;
      for (let i = 0; i < path.length; i++) {
        const point = path[path.length - 1 - i];
        for (let j = 0; j < child.contour.length; j++) {
          const otherPoint = child.contour[j];
          const dist = point.point.distanceTo(otherPoint);
          if (dist < lowestDist) {
            lowestDist = dist;
            closestIndexOuter = path.length - 1 - i;
          }
        }
      }

      const childPath = connectIsocontours(child, step, path[closestIndexOuter].point, edot, !reverse);
      childPaths.push({path: childPath, index: closestIndexOuter});
    }

    childPaths.sort((a, b) => b.index - a.index);

    for (let i = 0; i < childPaths.length; i++) {
      path = insertAt(path, childPaths[i].index, childPaths[i].path);
    }
  }

  // make outwards path
  if (isocontours.length > 1) {
    let totalDist = 0;
    let endIndex = 0;
    let lastPointIndex = startIndex
    let endPoint = new THREE.Vector3;
    const offsetAmount = step;
    for (let j = 1; totalDist < offsetAmount; j++) {
      endIndex = startIndex - j;
      while (endIndex < 0) {
        endIndex += isocontours[0].length;
      }
      endIndex = endIndex % isocontours[0].length;
      const dist = isocontours[0][lastPointIndex].distanceTo(isocontours[0][endIndex]);
      if (totalDist + dist >= offsetAmount) {
        endPoint = pointAlongLine(isocontours[0][lastPointIndex], isocontours[0][endIndex], offsetAmount - totalDist);
      }
      totalDist += dist;
      lastPointIndex = endIndex;
    }

    let lowestDist = Infinity;
    startIndex = 0;
    let lastPoint = isocontours[1][isocontours[1].length - 1];
    let closestPoint = new THREE.Vector3;
    for (let j = 0; j < isocontours[1].length; j++) {
      const point = isocontours[1][j];
      const line = new THREE.Line3(lastPoint, point);
      let closestPointOnLine = new THREE.Vector3;
      line.closestPointToPoint(endPoint, true, closestPointOnLine);
      const dist = endPoint.distanceTo(closestPointOnLine);
      if (dist < lowestDist) {
        lowestDist = dist;
        startIndex = j;
        closestPoint = closestPointOnLine;
      }
      lastPoint = point;
    }

    isocontours[1].splice(startIndex, 0, closestPoint);

    let inwardSpiralPath = spiralContours(isocontours, oddIndices, startIndex, step, edot);

    if (isocontours.length % 2 === 0 && currentNode.children.length > 0) {
      const childPaths: {path: PathPoint[], index: number}[] = [];
      for (const child of currentNode.children) {
        lowestDist = Infinity;
        let closestIndexOuter = 0;
        for (let i = 0; i < inwardSpiralPath.length; i++) {
          const point = inwardSpiralPath[inwardSpiralPath.length - 1 - i];
          for (let j = 0; j < child.contour.length; j++) {
            const otherPoint = child.contour[j];
            const dist = point.point.distanceTo(otherPoint);
            if (dist < lowestDist) {
              lowestDist = dist;
              closestIndexOuter = inwardSpiralPath.length - 1 - i;
            }
          }
        }

        const childPath = connectIsocontours(child, step, inwardSpiralPath[closestIndexOuter].point, edot, reverse);
        childPaths.push({path: childPath, index: closestIndexOuter});
      }

      childPaths.sort((a, b) => b.index - a.index);

      for (let i = 0; i < childPaths.length; i++) {
        inwardSpiralPath = insertAt(inwardSpiralPath, childPaths[i].index, childPaths[i].path);
      }
    }

    // One by one rather than `push(...path)`: a spread passes every element as an argument, and a
    // long spiral has more points than a call can take.
    for (let i = inwardSpiralPath.length - 1; i >= 0; i--) {
      path.push(inwardSpiralPath[i]);
    }
    path.push({point: endPoint,travel: false, edot});
  }
  return path
}


/**
 * Makes a tree of inset contours, with the children of each node being the contours
 * contained within it.
 * 
 * @param {THREE.Vector3[]} outer The outer contour to start insetting from.
 * @param {THREE.Vector3[][]} holes Holes in the region to not generate inset contours inside.
 * @param {number} step How far away each inset contour should be.
 * @returns {ContourNode} The root node of the inset contour tree.
 */
export function generateInsetContourTree(
  outer: THREE.Vector3[],
  holes: THREE.Vector3[][],
  step: number
): ContourNode {
  assertPositiveStep(step, 'Inset contour spacing');

  // nothing to inset, and connectIsocontours treats an empty root as "no path"
  if (outer.length < 3) {
    return { contour: [], children: [], parent: null };
  }

  // The tree gets its own copies of the contours, so the caller's arrays keep their order.
  // The root ends up counter clockwise, like every contour Clipper produces below it.
  const rootContour = outer.slice();
  if (!getWindingOrder(rootContour)) {
    rootContour.reverse();
  }
  const holeContourCopies = holes.filter(hole => hole.length >= 3).map(hole => {
    const copy = hole.slice();
    if (!getWindingOrder(copy)) {
      copy.reverse();
    }
    return copy;
  });

  const inputLoops = preparePaths(rootContour, holeContourCopies);
  const co = new ClipperLib.ClipperOffset(
    CLIPPER_MITER_LIMIT,
    ARC_TOLERANCE * CLIPPER_SCALE
  );

  // convert input loops to clipper format
  let current: ClipperLib.IntPoint[][] = inputLoops.map(toClipperPath);

  const rootNode: ContourNode = {
    contour: rootContour,
    children: [],
    parent: null
  };
  let currentNodes: ContourNode[] = [rootNode];
  let holeNodes: ContourNode[] = holeContourCopies.map(hole => {
    return {
      contour: hole,
      children: [],
      parent: null,
    };
  });

  const allHoleNodes: ContourNode[] = [...holeNodes];

  // iteratively inset until nothing remains
  while (current.length) {
    co.Clear();
    // add all loops (outer and holes), ClipperOffset will handle each
    current.forEach(path =>
      co.AddPath(
        path,
        ClipperLib.JoinType.jtRound,
        ClipperLib.EndType.etClosedPolygon
      )
    );

    const next: ClipperLib.Paths = [];
    co.Execute(next, -step * CLIPPER_SCALE);

    // drop slivers. Clipper path areas are in scaled units, so compare against the scaled minimum.
    const filtered = next.filter(p => Math.abs(clipperArea(p)) > MIN_AREA_SCALED);
    if (!filtered.length) break;

    const contours = filtered.map(p => fromClipperPath(p).map(point => new THREE.Vector3(point.x, point.y, outer[0].z)));

    const windingOrders = contours.map(contour => getWindingOrder(contour));
    const holeContours = contours.filter((c, idx) => !windingOrders[idx]);
    const normalContours = contours.filter((c, idx) => windingOrders[idx]);

    const nextHoleNodes: ContourNode[] = [];
    // extend hole nodes
    for (const holeContour of holeContours) {
      const containedHoleNodes: ContourNode[] = [];
      for (const holeNode of holeNodes) {
        if (contourContainsContour(holeContour, holeNode.contour)) {
          containedHoleNodes.push(holeNode);
        }
      }
      const newNode = {
        contour: holeContour.reverse(),
        children: containedHoleNodes,
        parent: null
      }

      for (const holeNode of containedHoleNodes) {
        holeNode.parent = newNode;
      }

      nextHoleNodes.push(newNode);
    }

    const nextNodes: ContourNode[] = [];

    // extend regular nodes
    for (const node of currentNodes) {
      for (const contour of normalContours) {
        if (contourContainsContour(node.contour, contour)) {
          const newNode: ContourNode = {
            contour: contour,
            children: [],
            parent: node,
          }
          node.children.push(newNode);
          nextNodes.push(newNode);
        }
      }
    }

    currentNodes = nextNodes;
    holeNodes = nextHoleNodes;

    allHoleNodes.push(...holeNodes);

    current = filtered;
  }

  const outerHoleNodes: ContourNode[] = allHoleNodes.filter(holeNode => !holeNode.parent);
  currentNodes = [rootNode];

  // push hole nodes to where they belong in the tree
  function assignHoleChildren(
    rootNodes: ContourNode[],
    holes: ContourNode[],
  ): void {
    const allChildren: ContourNode[] = [];
    for (const root of rootNodes) {
      const toRemoveIndices: number[] = [];

      for (let i = 0; i < holes.length; i++) {
        const hole = holes[i];

        if (contourContainsContour(root.contour, hole.contour)) {
          let containedByChild = false;
          for (const child of root.children) {
            if (contourContainsContour(child.contour, hole.contour)) {
              containedByChild = true;
              break;
            }
          }
          if (!containedByChild) {
            root.children.push(hole);
            toRemoveIndices.push(i);
          }
        }
      }

      if (toRemoveIndices.length > 0) {
        toRemoveIndices.sort((a, b) => b - a).forEach(i => {
          if (i >= 0 && i < holes.length) {
            holes.splice(i, 1);
          }
        }); 
      }

      allChildren.push(...root.children);
    }

    if (allChildren.length > 0 && holes.length > 0) {
      assignHoleChildren(allChildren, holes);
    }
  }

  assignHoleChildren(currentNodes, outerHoleNodes);

  return rootNode;
}



/**
 * Generates the contours for a boundary/brim around a mesh.
 *
 * @param {THREE.Mesh} mesh - The mesh to make the contours for.
 * @param {number} offset - How offset the contours should be from the mesh.
 * @returns {THREE.Vector3[][]} A matrix containing the contours as a list of ordered points.
 */
export function generateBoundaryContours(
  mesh: THREE.Mesh,
  offset: number
): THREE.Vector3[][] {
  // get ordered set of points representing the boundary of the bottom layer
  const baseContours: THREE.Vector3[][] = connectSegments(getBaseContour(mesh));

  // Only the outside of each piece of the base is outlined. A hole's contour pushed out by the
  // offset would land under the material around the hole, where the object has to sit flat.
  const outers = getHolesAndOuters(baseContours.filter(contour => contour.length >= 3)).map(piece => piece.outer);

  // push the contours out by offset
  const expandedContours: THREE.Vector3[][] = outers
    .map(contour => offsetContour(contour, offset))
    .filter(contour => contour.length >= 3);

  // align contour with model
  expandedContours.forEach(contour => contour.forEach(p => {
    p.add(mesh.position);
    p.setZ(p.z + BOUNDARY_CONTOUR_Z_LIFT);
  }));

  return expandedContours;
}


/**
 * Gets the contour of the bottom of a mesh.
 *
 * @param {THREE.Mesh} mesh - The mesh to get the base contour from.
 * @returns {{ start: THREE.Vector3; end: THREE.Vector3 }[]} The contour in the form of a list of line segments.
 */
export function getBaseContour(mesh: THREE.Mesh): { start: THREE.Vector3; end: THREE.Vector3 }[] {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const positions = geometry.attributes.position.array;

  // find the minimum z value
  let minZ = Infinity;
  for (let i = 2; i < positions.length; i += 3) {
      minZ = Math.min(minZ, positions[i]);
  }
  minZ += BASE_CONTOUR_Z_OFFSET; // add a small amount to avoid issues with being exactly at the bottom of the mesh

  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -minZ);

  return getSegmentsFromMesh(mesh, plane);
}


/**
 * Offsets a set of closed Clipper paths with rounded corners. Outer paths and hole paths must
 * wind in opposite directions; they are then offset together as one shape, so a positive offset
 * grows the material (outers grow, holes shrink) and a negative offset shrinks it.
 *
 * @param {ClipperLib.Path[]} paths The paths to offset, in Clipper's scaled units.
 * @param {number} offset How far to offset by, in mm.
 * @returns {ClipperLib.Paths} Every resulting path. Outers have a positive area, holes a negative one.
 */
function executeOffset(
  paths: ClipperLib.Path[],
  offset: number
): ClipperLib.Paths {
  const co = new ClipperLib.ClipperOffset(
    CLIPPER_MITER_LIMIT,
    ARC_TOLERANCE * CLIPPER_SCALE
  );

  for (const path of paths) {
    co.AddPath(
      path,
      ClipperLib.JoinType.jtRound,
      ClipperLib.EndType.etClosedPolygon
    );
  }

  const solution: ClipperLib.Paths = [];
  co.Execute(solution, offset * CLIPPER_SCALE);
  return solution;
}


/**
 * Expands a contour outwards (or inwards if offset is negative) by a given amount.
 *
 * Only ever returns one contour. If the contour splits into several pieces when it is inset,
 * just the largest piece is returned; use offsetContourAll or offsetRegion to get all of them.
 *
 * @param {THREE.Vector3[]} contour The contour to be offset. It is not modified.
 * @param {number} offset How much to offset the contour outwards by.
 * @returns {THREE.Vector3[]} The offset contour, or an empty list if nothing is left.
 */
export function offsetContour(
  contour: THREE.Vector3[],
  offset: number
): THREE.Vector3[] {
  if (contour.length < 3) return [];

  const solution = executeOffset([toClipperPath(contour)], offset);

  if (!solution.length) {
    return [];
  }

  let best = solution[0];
  let bestArea = Math.abs(clipperArea(best));
  for (let i = 1; i < solution.length; i++) {
    const a = Math.abs(clipperArea(solution[i]));
    if (a > bestArea) {
      bestArea = a;
      best = solution[i];
    }
  }

  const result2D = fromClipperPath(best);
  return result2D.map(pt =>
    new THREE.Vector3(pt.x, pt.y, contour[0].z)
  );
}


/**
 * Expands a contour outwards (or inwards if offset is negative) by a given amount, and returns
 * every polygon that results. A dumbbell shape that is inset by more than half the width of its
 * bar, for example, comes back as two separate polygons.
 *
 * Holes that open up inside the result (which can happen when growing a C shape until it closes)
 * are not returned; use offsetRegion to get those as well.
 *
 * @param {THREE.Vector3[]} contour The contour to be offset. It is not modified.
 * @param {number} offset How much to offset the contour outwards by.
 * @returns {THREE.Vector3[][]} The outer contour of each resulting polygon, wound counter clockwise.
 */
export function offsetContourAll(
  contour: THREE.Vector3[],
  offset: number
): THREE.Vector3[][] {
  return offsetRegion(contour, [], offset).map(polygon => polygon.outer);
}


/**
 * Offsets a whole region: an outer contour together with its holes. A positive offset grows the
 * material and a negative one shrinks it, so with a negative offset the outer moves inwards while
 * the holes get bigger. Everything is offset together, which means holes are clipped against the
 * outer (a hole that grows through the wall just takes a bite out of the outer contour), holes
 * that grow into each other are merged, and a region that splits apart gives several polygons.
 *
 * @param {THREE.Vector3[]} outer The outer contour of the region. It is not modified.
 * @param {THREE.Vector3[][]} holes The hole contours of the region. They are not modified.
 * @param {number} offset How much to grow the region by (negative to shrink it).
 * @returns {PolygonWithHoles[]} Each resulting polygon with the holes inside of it. Every
 *          contour, holes included, is wound counter clockwise.
 */
export function offsetRegion(
  outer: THREE.Vector3[],
  holes: THREE.Vector3[][],
  offset: number
): PolygonWithHoles[] {
  if (outer.length < 3) return [];

  const z = outer[0].z;

  // Clipper tells outers and holes apart by their winding, so make the outer CCW and holes CW
  const orient = (contour: THREE.Vector3[], counterClockwise: boolean): ClipperLib.Path => {
    const path = toClipperPath(contour);
    if ((clipperArea(path) > 0) !== counterClockwise) {
      path.reverse();
    }
    return path;
  };

  const paths = [orient(outer, true)];
  for (const hole of holes) {
    if (hole.length >= 3) paths.push(orient(hole, false));
  }

  const solution = executeOffset(paths, offset);

  const toContour = (path: ClipperLib.Path) =>
    fromClipperPath(path).map(pt => new THREE.Vector3(pt.x, pt.y, z));

  const polygons: PolygonWithHoles[] = [];
  const holePaths: ClipperLib.Path[] = [];
  for (const path of solution) {
    if (path.length < 3) continue;
    if (clipperArea(path) > 0) {
      polygons.push({ outer: toContour(path), holes: [] });
    } else {
      holePaths.push(path);
    }
  }

  // give each hole to the polygon it is inside of
  for (const path of holePaths) {
    const hole = toContour(path).reverse();
    const owner = polygons.find(polygon => pointInPolygon(hole[0], polygon.outer));
    if (owner) owner.holes.push(hole);
  }

  return polygons;
}


/**
 * Takes the area of some regions away from other regions, so that nothing is printed twice where
 * the two overlap. A region the others do not touch is returned as it is.
 *
 * @param {SliceRegion[]} regions The regions to cut. They are not modified.
 * @param {SliceRegion[]} cutters The regions whose area is taken away.
 * @returns {SliceRegion[]} What is left of each region; one region can come back as several
 *          pieces, or not at all.
 */
export function subtractRegions(regions: SliceRegion[], cutters: SliceRegion[]): SliceRegion[] {
  const toPaths = (region: SliceRegion) =>
    [region.contour, ...region.holes].filter(contour => contour.length >= 3).map(toClipperPath);
  const cutterPaths = cutters.flatMap(toPaths);
  if (!cutterPaths.length) return regions;

  const result: SliceRegion[] = [];
  for (const region of regions) {
    const touched = cutters.some(cutter =>
      cutter.bounds.min.x <= region.bounds.max.x && cutter.bounds.max.x >= region.bounds.min.x &&
      cutter.bounds.min.y <= region.bounds.max.y && cutter.bounds.max.y >= region.bounds.min.y);
    if (!touched) {
      result.push(region);
      continue;
    }

    // Even-odd fill: a hole is a path inside its outer, whichever way either of them winds.
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths(toPaths(region), ClipperLib.PolyType.ptSubject, true);
    clipper.AddPaths(cutterPaths, ClipperLib.PolyType.ptClip, true);
    const solution: ClipperLib.Paths = [];
    clipper.Execute(
      ClipperLib.ClipType.ctDifference,
      solution,
      ClipperLib.PolyFillType.pftEvenOdd,
      ClipperLib.PolyFillType.pftEvenOdd,
    );

    const toContour = (path: ClipperLib.Path) =>
      fromClipperPath(path).map(pt => new THREE.Vector3(pt.x, pt.y, region.height));
    const pieces: PolygonWithHoles[] = [];
    const holePaths: ClipperLib.Path[] = [];
    for (const path of solution) {
      if (path.length < 3) continue;
      if (clipperArea(path) > 0) {
        pieces.push({ outer: toContour(path), holes: [] });
      } else {
        holePaths.push(path);
      }
    }
    for (const path of holePaths) {
      const hole = toContour(path).reverse();
      const owner = pieces.find(piece => pointInPolygon(hole[0], piece.outer));
      if (owner) owner.holes.push(hole);
    }

    pieces.forEach((piece, i) => {
      result.push({
        ...region,
        id: `${region.id}-cut${i}`,
        contour: piece.outer,
        holes: piece.holes,
        bounds: getBounds(piece.outer, 0),
        BVH: buildSliceRegionBVH(getBoundarySegments(piece.outer, piece.holes)),
      });
    });
  }
  return result;
}


/**
 * Turns polygons into Clipper paths that the non-zero rule reads as their area: each outer
 * counter clockwise and each hole clockwise, so that polygons which overlap add up.
 *
 * @param {PolygonWithHoles[]} polygons The polygons. They are not modified.
 * @returns {ClipperLib.Paths} Their paths, in Clipper's scaled units.
 */
function areaPaths(polygons: PolygonWithHoles[]): ClipperLib.Paths {
  const paths: ClipperLib.Paths = [];
  const add = (contour: THREE.Vector3[], counterClockwise: boolean) => {
    if (contour.length < 3) return;
    const path = toClipperPath(contour);
    if ((clipperArea(path) > 0) !== counterClockwise) path.reverse();
    paths.push(path);
  };
  for (const polygon of polygons) {
    if (polygon.outer.length < 3) continue;
    add(polygon.outer, true);
    polygon.holes.forEach(hole => add(hole, false));
  }
  return paths;
}


/**
 * Whether two sets of Clipper paths are the same, point for point and in the same order.
 *
 * @param {ClipperLib.Paths} a One set of paths.
 * @param {ClipperLib.Paths} b The other.
 * @returns {boolean} True if they are the same.
 */
function samePaths(a: ClipperLib.Paths, b: ClipperLib.Paths): boolean {
  return a.length === b.length && a.every((path, i) =>
    path.length === b[i].length && path.every((pt, j) => pt.X === b[i][j].X && pt.Y === b[i][j].Y));
}


/**
 * Turns the paths Clipper gives back into polygons with holes. Each hole goes to the smallest
 * outer around it, so an island inside the hole of another polygon keeps its own holes.
 *
 * @param {ClipperLib.Paths} solution Clipper's paths: outers with a positive area, holes with a negative one.
 * @param {number} z The height to give the points.
 * @returns {PolygonWithHoles[]} The polygons. Every contour, holes included, is wound counter clockwise.
 */
function polygonsFromPaths(solution: ClipperLib.Paths, z: number): PolygonWithHoles[] {
  const toContour = (path: ClipperLib.Path) =>
    fromClipperPath(path).map(pt => new THREE.Vector3(pt.x, pt.y, z));
  const polygons: { polygon: PolygonWithHoles; area: number }[] = [];
  const holePaths: ClipperLib.Path[] = [];
  for (const path of solution) {
    if (path.length < 3) continue;
    const area = clipperArea(path);
    if (area > 0) {
      polygons.push({ polygon: { outer: toContour(path), holes: [] }, area });
    } else if (area < 0) {
      holePaths.push(path);
    }
  }
  for (const path of holePaths) {
    const hole = toContour(path).reverse();
    let owner: { polygon: PolygonWithHoles; area: number } | undefined;
    for (const candidate of polygons) {
      if ((!owner || candidate.area < owner.area) && pointInPolygon(hole[0], candidate.polygon.outer)) {
        owner = candidate;
      }
    }
    owner?.polygon.holes.push(hole);
  }
  return polygons.map(({ polygon }) => polygon);
}


/**
 * Where the walls of one layer of a Foam Print lean over the layer's foam: the parts of the walls
 * higher up in the layer that lie inside the wall at the bottom of the layer. A wall is taken from
 * its outline to the middle of its innermost line (see ShellWall). A vertical wall gives nothing,
 * as long as the outlines of its slices are the same.
 *
 * @param {ShellWall[]} bottom The walls at the bottom of the layer.
 * @param {ShellWall[]} above The walls higher up in the layer that the foam has to keep clear of.
 * @returns {PolygonWithHoles[]} The area those walls cover inside the middle of the innermost line
 *          at the bottom of the layer. Empty where they cover none of it.
 */
export function wallOverhang(bottom: ShellWall[], above: ShellWall[]): PolygonWithHoles[] {
  if (!bottom.length || !above.length) return [];
  const z = bottom[0].outline.outer[0]?.z ?? 0;
  const clear = areaPaths(bottom.flatMap(wall => wall.inside));
  if (!clear.length) return [];

  const covered: ClipperLib.Paths = [];
  let previousInside: ClipperLib.Paths | undefined;
  for (const wall of above) {
    const inside = areaPaths(wall.inside);
    // A wall the same as the one before it covers nothing new.
    if (previousInside && samePaths(inside, previousInside)) continue;
    previousInside = inside;

    // Even-odd: the outline with the area inside the wall taken out is the wall.
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths(areaPaths([wall.outline]), ClipperLib.PolyType.ptSubject, true);
    clipper.AddPaths(inside, ClipperLib.PolyType.ptSubject, true);
    clipper.AddPaths(clear, ClipperLib.PolyType.ptClip, true);
    const solution: ClipperLib.Paths = [];
    clipper.Execute(
      ClipperLib.ClipType.ctIntersection,
      solution,
      ClipperLib.PolyFillType.pftEvenOdd,
      ClipperLib.PolyFillType.pftNonZero,
    );
    for (const path of solution) covered.push(path);
  }
  if (!covered.length) return [];

  // The walls of different heights overlap: add them up.
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(covered, ClipperLib.PolyType.ptSubject, true);
  const union: ClipperLib.Paths = [];
  clipper.Execute(ClipperLib.ClipType.ctUnion, union, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return polygonsFromPaths(union, z);
}


/**
 * Takes away from some polygons everything within a distance of an area. Parts of the area
 * narrower than `noise` are ignored: they are what rounding leaves where two outlines that should
 * be the same are not quite.
 *
 * @param {PolygonWithHoles[]} polygons The polygons to cut. They are not modified.
 * @param {PolygonWithHoles[]} area The area to keep away from.
 * @param {number} distance How far (mm) to keep away from it.
 * @param {number} noise How wide (mm) a part of the area has to be to count.
 * @returns {PolygonWithHoles[]} What is left. A polygon the area does not come near is returned
 *          as it is; one can also come back as several pieces, or not at all.
 */
export function keepAwayFrom(polygons: PolygonWithHoles[], area: PolygonWithHoles[], distance: number, noise: number): PolygonWithHoles[] {
  // Shrinking by half the noise width and growing back by as much plus the distance drops the
  // thin parts and grows the rest by the distance.
  const keepOut = executeOffset(executeOffset(areaPaths(area), -noise / 2), noise / 2 + distance);
  if (!keepOut.length) return polygons;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of keepOut) {
    for (const pt of path) {
      minX = Math.min(minX, pt.X); maxX = Math.max(maxX, pt.X);
      minY = Math.min(minY, pt.Y); maxY = Math.max(maxY, pt.Y);
    }
  }

  const result: PolygonWithHoles[] = [];
  for (const polygon of polygons) {
    const paths = areaPaths([polygon]);
    const outer = paths[0];
    if (!outer || outer.every(pt => pt.X < minX) || outer.every(pt => pt.X > maxX)
        || outer.every(pt => pt.Y < minY) || outer.every(pt => pt.Y > maxY)) {
      result.push(polygon);
      continue;
    }
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
    clipper.AddPaths(keepOut, ClipperLib.PolyType.ptClip, true);
    const solution: ClipperLib.Paths = [];
    clipper.Execute(ClipperLib.ClipType.ctDifference, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);

    const before = paths.reduce((sum, path) => sum + clipperArea(path), 0);
    const after = solution.reduce((sum, path) => sum + clipperArea(path), 0);
    if (after >= before) {
      result.push(polygon); // the area only comes near it, and takes nothing away
      continue;
    }
    for (const piece of polygonsFromPaths(solution, polygon.outer[0].z)) result.push(piece);
  }
  return result;
}


/**
 * Determines if a contour winds Counter clock wise or clock wise.
 *
 * @param {THREE.Vector3[]} contour The contour to determine the winding order of.
 * @returns {boolean} True if counter clockwise, false if clockwise. A contour with fewer than
 *          three points has no winding order and gives false.
 */
export function getWindingOrder(
  contour: THREE.Vector3[]
): boolean {
  if (contour.length < 3) return false;

  let signedArea = 0;
  for (let i = 1; i < contour.length; i++) {
    signedArea += contour[i - 1].x * contour[i].y - contour[i].x * contour[i - 1].y;
  }
  signedArea += contour[contour.length - 1].x * contour[0].y - contour[0].x * contour[contour.length - 1].y;
  return signedArea > 0;
}


/**
 * Turns a point cloud into slice regions with an outer contour and hole contours.
 *
 * @param {THREE.Vector3[]} points The point cloud.
 * @param {number} alpha The circumradius threshold for triangles. Infinity will include all triangles,
 *                       while a lower alpha will remove triangles that stretch a long distsance, allowing
 *                       the capturing of holes.
 * @param {number} extruder The extruder the regions are printed with.
 * @returns {SliceRegion[]} The extracted slice regions.
 */
export function extractRegionsFromPointCloud(
  points: THREE.Vector3[],
  alpha: number = Infinity,
  extruder: number = 0
): SliceRegion[] {
  if (points.length === 0) return [];

  const height = points[0].z;

  const coords = points.map(p => [p.x, p.y] as [number, number]);

  const delaunay = Delaunator.from(coords);
  const { triangles } = delaunay;

  // select only triangles with circumradius <= alpha
  const goodTris = new Set<number>();
  for (let t = 0; t < triangles.length; t += 3) {
    const [i0, i1, i2] = [triangles[t], triangles[t+1], triangles[t+2]];
    const [ax, ay] = coords[i0], [bx, by] = coords[i1], [cx, cy] = coords[i2];
    // side lengths
    const ab = Math.hypot(ax - bx, ay - by),
          bc = Math.hypot(bx - cx, by - cy),
          ca = Math.hypot(cx - ax, cy - ay);
    // triangle area via cross product
    const area = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
    if (area === 0) continue;
    // circumradius formula
    const R = (ab * bc * ca) / (4 * area);
    if (R <= alpha) goodTris.add(t / 3);
  }

  // build undirected edge‑count map for good triangles
  type EdgeKey = string;
  const edgeCount = new Map<EdgeKey, number>();
  for (const t of goodTris) {
    const base = 3 * t;
    const idxs = [triangles[base], triangles[base+1], triangles[base+2]];
    for (let k = 0; k < 3; k++) {
      const a = idxs[k], b = idxs[(k + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
    }
  }

  // extract boundary edges (those seen exactly once)
  const boundaryEdges: [number, number][] = [];
  for (const [key, cnt] of edgeCount.entries()) {
    if (cnt === 1) {
      const [sa, sb] = key.split(',').map(Number);
      boundaryEdges.push([sa, sb]);
    }
  }

  const loops = traceBoundaryLoops(boundaryEdges).map(idxs =>
    idxs.map(i => new THREE.Vector3(coords[i][0], coords[i][1], height))
  );

  const holeContours = getHolesAndOuters(loops);

  // build SliceRegion for each contour
  const regions: SliceRegion[] = holeContours.map((holeContour, i) => {
    const segments = getBoundarySegments(holeContour.outer, holeContour.holes);
    return {
      id:      `region-${extruder}-${height.toFixed(3)}-${i}`,
      height: height,
      contour: holeContour.outer,
      holes:   holeContour.holes,
      bounds: getBounds(holeContour.outer, 0),
      BVH: buildSliceRegionBVH(segments),
      extruder: extruder,
      shell: false,
    };
  });

  return regions;
}


/**
 * Walks a set of undirected boundary edges and joins them up into closed loops of vertices.
 *
 * Every edge is used exactly once. At a pinch vertex, where more than two boundary edges meet,
 * the walk carries on along any edge that hasn't been used yet, and a loop ends as soon as the
 * walk gets back to where it started or runs out of unused edges. So the walk always terminates.
 *
 * @param {[number, number][]} edges The boundary edges, as pairs of vertex indices.
 * @returns {number[][]} The loops, each an ordered list of vertex indices with at least 3 entries.
 */
export function traceBoundaryLoops(
  edges: [number, number][]
): number[][] {
  // build adjacency list of the edges
  const neigh = new Map<number, number[]>();
  for (const [u, v] of edges) {
    if (!neigh.has(u)) neigh.set(u, []);
    if (!neigh.has(v)) neigh.set(v, []);
    neigh.get(u)!.push(v);
    neigh.get(v)!.push(u);
  }

  // traverse edges to form loops
  const visited = new Set<string>();
  const loops: number[][] = [];
  const mark = (u: number, v: number) => {
    visited.add(`${u}_${v}`);
    visited.add(`${v}_${u}`);
  };

  for (const [u, vs] of neigh.entries()) {
    for (const v of vs) {
      if (visited.has(`${u}_${v}`)) continue;
      // start a new loop
      const loop = [u, v];
      mark(u, v);
      let curr = v;
      while (true) {
        const next = neigh.get(curr)!.find(w => !visited.has(`${curr}_${w}`));
        if (next === undefined) break;
        mark(curr, next);
        if (next === loop[0]) break;
        loop.push(next);
        curr = next;
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }

  return loops;
}
