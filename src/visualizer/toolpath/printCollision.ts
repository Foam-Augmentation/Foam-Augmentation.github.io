// ---------------------------------------------------------------------------------------------
// Checks a finished toolpath for the print head running into what the same print has already
// laid down.
//
// collision.ts checks an augmentation's path against the object it is printed on. A Foam Print or
// a Regular Print has no such object: what can be in the head's way is its own earlier parts and
// the other objects on the plate, and which of those are there depends on the order things are
// printed in. So the path is walked in print order. Every extrusion raises a height map of the
// plate (how high the material stands at each spot), and at every step the footprint of the head
// body is looked up in it. The head is the same box as in collision.ts: its footprint in x and y,
// from the bottom of the head body (nozzle tip plus nozzle length) upwards.
//
// The map is a grid, but each cell also keeps where exactly its highest material lies, so a head
// that stops right at the edge of a part (which is where Arrange puts a foam print) is told apart
// from one that reaches into it. Material is taken to lie under the nozzle's path, one thread
// wide. The nozzle itself is treated as a thin needle and is not checked.
//
// No DOM here, so it can be unit-tested under Node.
// ---------------------------------------------------------------------------------------------
import * as THREE from 'three';
import type { PathPoint, PathRole } from './pathTypes';
import type { PrintHeadBox } from './collision';

/** The size (mm) of a cell of the height map. Also twice the distance between the places a move is checked at. */
export const HEAD_COLLISION_CELL = 0.5;
/** The height map never has more cells than this; on a bigger plate the cells grow instead. */
const MAX_CELLS = 1_000_000;
/** Material this little (mm) above the bottom of the head body is taken to touch it, not to hit it. */
const HEIGHT_TOLERANCE = 1e-6;
/** Material this little (mm) inside the head's footprint is taken to touch it, not to be under it. */
const FOOTPRINT_TOLERANCE = 1e-3;

/** The print head, as far as hitting things goes. */
export interface PrintHeadModel {
    /** The head body's footprint in x and y, with the nozzle at (0, 0). */
    box: PrintHeadBox;
    /** How far each extruder's nozzle sticks out below the head body (mm), by extruder index. */
    nozzleLengths: number[];
    /**
     * Each extruder's thread diameter (nozzle diameter times die swell), by extruder index: the d
     * in H = H* d, which is how far above its layer the nozzle rides while it prints foam, and the
     * width of the line it leaves.
     */
    threadDiameters: number[];
}

/** What laid down the material the head would hit. */
export interface MaterialOwner {
    /** The object it is part of (`EverydayModel.objectId`). Undefined if it belongs to no object. */
    objectId?: number;
    /** What it is when it is not part of an object: the purge tower, the purge line, a boundary. */
    role?: PathRole;
}

/** Every move where the head would hit one thing while one object is printed. */
export interface HeadCollision {
    /** The object being printed (`EverydayModel.objectId`). Undefined on a move that belongs to none. */
    objectId?: number;
    /** What a move that belongs to no object is for: an approach, the purge tower, the purge line. */
    role?: PathRole;
    /** What the head would hit. */
    obstacle: MaterialOwner;
    /** How many moves of the toolpath collide. */
    moves: number;
    /** The furthest (mm) the material reaches above the bottom of the head body. */
    depth: number;
    /** Where the nozzle is when it does. */
    at: THREE.Vector3;
    /** The index in the toolpath of the first move that collides. */
    index: number;
}

/** What {@link findHeadCollisions} found. */
export interface HeadCollisionReport {
    /** The collisions, deepest first. Empty if the head stays clear. */
    collisions: HeadCollision[];
    /** How many moves of the toolpath collide with anything. */
    moves: number;
    /** The furthest (mm) any material reaches above the bottom of the head body. 0 if none does. */
    depth: number;
}

/**
 * How high the material stands over the plate, on a grid, with the highest cell of every block of
 * 2 x 2, 4 x 4, ... cells kept alongside. Looking for material above a height in a rectangle then
 * only has to open the blocks that have some, so it costs next to nothing where there is none.
 *
 * Each cell also keeps the box around its highest material, so whether a rectangle reaches that
 * material does not depend on where the grid lines happen to fall. Lower material that shares a
 * cell with higher material is not kept: at most a cell's width of it, next to something taller.
 */
class HeightMap {
    /** The height of the highest cell. -Infinity while the map is empty. */
    public highest = -Infinity;

    private readonly cell: number;
    private readonly originX: number;
    private readonly originY: number;
    /** levels[0] is the grid itself; each level after it halves the one before. */
    private readonly levels: Float64Array[] = [];
    private readonly widths: number[] = [];
    private readonly heights: number[] = [];
    /** For each cell, the index of the owner of the material that reaches highest there. */
    private readonly owners: Int32Array;
    /** For each cell, the box around its highest material: min x, max x, min y, max y. */
    private readonly extents: Float32Array;
    /** The furthest any material reaches beyond the spot it was recorded at (half its width). */
    private reach = 0;

    // The rectangle being searched (in mm and in cells), and the best found so far.
    private minX = 0;
    private maxX = 0;
    private minY = 0;
    private maxY = 0;
    private cellMinX = 0;
    private cellMaxX = 0;
    private cellMinY = 0;
    private cellMaxY = 0;
    private best = -Infinity;
    private bestIndex = -1;

    /**
     * @param {THREE.Box2} bounds The area the material covers.
     * @param {number} cell The size (mm) of a cell. Grown if the area would need too many.
     */
    constructor(bounds: THREE.Box2, cell: number) {
        const sizeX = Math.max(0, bounds.max.x - bounds.min.x);
        const sizeY = Math.max(0, bounds.max.y - bounds.min.y);
        this.cell = Math.max(cell, Math.sqrt((sizeX * sizeY) / MAX_CELLS));
        this.originX = bounds.min.x;
        this.originY = bounds.min.y;

        let width = Math.floor(sizeX / this.cell) + 1;
        let height = Math.floor(sizeY / this.cell) + 1;
        this.owners = new Int32Array(width * height).fill(-1);
        this.extents = new Float32Array(width * height * 4);
        for (;;) {
            this.levels.push(new Float64Array(width * height).fill(-Infinity));
            this.widths.push(width);
            this.heights.push(height);
            if (width === 1 && height === 1) break;
            width = (width + 1) >> 1;
            height = (height + 1) >> 1;
        }
    }

    /** The column (or row) a coordinate falls in, kept inside the grid. */
    private cellOf(value: number, origin: number, count: number): number {
        return Math.min(count - 1, Math.max(0, Math.floor((value - origin) / this.cell)));
    }

    /**
     * Records material at a spot, if it reaches at least as high as what is there.
     *
     * @param {number} x Where it is (mm).
     * @param {number} y Where it is (mm).
     * @param {number} top How high it reaches (mm).
     * @param {number} halfWidth How far it reaches to every side of the spot (mm).
     * @param {number} owner The index of what laid it down.
     */
    public raise(x: number, y: number, top: number, halfWidth: number, owner: number): void {
        const ix = this.cellOf(x, this.originX, this.widths[0]);
        const iy = this.cellOf(y, this.originY, this.heights[0]);
        const index = iy * this.widths[0] + ix;
        const current = this.levels[0][index];
        if (top < current - HEIGHT_TOLERANCE) return;
        if (halfWidth > this.reach) this.reach = halfWidth;

        const e = index * 4;
        if (top <= current + HEIGHT_TOLERANCE) {
            // More of the same layer: the box around it grows.
            this.extents[e] = Math.min(this.extents[e], x - halfWidth);
            this.extents[e + 1] = Math.max(this.extents[e + 1], x + halfWidth);
            this.extents[e + 2] = Math.min(this.extents[e + 2], y - halfWidth);
            this.extents[e + 3] = Math.max(this.extents[e + 3], y + halfWidth);
            return;
        }
        this.extents[e] = x - halfWidth;
        this.extents[e + 1] = x + halfWidth;
        this.extents[e + 2] = y - halfWidth;
        this.extents[e + 3] = y + halfWidth;
        this.levels[0][index] = top;
        this.owners[index] = owner;
        if (top > this.highest) this.highest = top;
        for (let level = 1; level < this.levels.length; level++) {
            const block = (iy >> level) * this.widths[level] + (ix >> level);
            // A block that is already this high has blocks around it that are too.
            if (!(top > this.levels[level][block])) break;
            this.levels[level][block] = top;
        }
    }

    /**
     * Finds the highest material above a height that a rectangle reaches into.
     *
     * @param {number} minX The rectangle (mm).
     * @param {number} maxX The rectangle (mm).
     * @param {number} minY The rectangle (mm).
     * @param {number} maxY The rectangle (mm).
     * @param {number} above Only material higher than this counts (mm).
     * @returns {{ top: number, owner: number } | null} How high it reaches and what laid it down,
     *          or null if nothing in the rectangle is higher than `above`.
     */
    public highestIn(minX: number, maxX: number, minY: number, maxY: number, above: number): { top: number, owner: number } | null {
        if (!(this.highest > above)) return null;
        // Material is recorded in the cell its middle is in, and reaches up to `reach` beyond it.
        const reachX = this.originX + this.widths[0] * this.cell + this.reach;
        const reachY = this.originY + this.heights[0] * this.cell + this.reach;
        if (maxX < this.originX - this.reach || minX >= reachX || maxY < this.originY - this.reach || minY >= reachY) return null;

        this.minX = minX + FOOTPRINT_TOLERANCE;
        this.maxX = maxX - FOOTPRINT_TOLERANCE;
        this.minY = minY + FOOTPRINT_TOLERANCE;
        this.maxY = maxY - FOOTPRINT_TOLERANCE;
        this.cellMinX = this.cellOf(minX - this.reach, this.originX, this.widths[0]);
        this.cellMaxX = this.cellOf(maxX + this.reach, this.originX, this.widths[0]);
        this.cellMinY = this.cellOf(minY - this.reach, this.originY, this.heights[0]);
        this.cellMaxY = this.cellOf(maxY + this.reach, this.originY, this.heights[0]);
        this.best = above;
        this.bestIndex = -1;
        this.search(this.levels.length - 1, 0, 0);
        return this.bestIndex < 0 ? null : { top: this.best, owner: this.owners[this.bestIndex] };
    }

    /** Looks through one block for a cell the rectangle reaches into that is higher than the best so far. */
    private search(level: number, i: number, j: number): void {
        const value = this.levels[level][j * this.widths[level] + i];
        if (!(value > this.best)) return;
        const x = i << level;
        const y = j << level;
        const span = (1 << level) - 1;
        if (x > this.cellMaxX || y > this.cellMaxY || x + span < this.cellMinX || y + span < this.cellMinY) return;
        if (level === 0) {
            const index = j * this.widths[0] + i;
            const e = index * 4;
            if (this.extents[e] < this.maxX && this.extents[e + 1] > this.minX
                && this.extents[e + 2] < this.maxY && this.extents[e + 3] > this.minY) {
                this.best = value;
                this.bestIndex = index;
            }
            return;
        }
        const below = level - 1;
        const moreX = 2 * i + 1 < this.widths[below];
        const moreY = 2 * j + 1 < this.heights[below];
        this.search(below, 2 * i, 2 * j);
        if (moreX) this.search(below, 2 * i + 1, 2 * j);
        if (moreY) this.search(below, 2 * i, 2 * j + 1);
        if (moreX && moreY) this.search(below, 2 * i + 1, 2 * j + 1);
    }
}

/**
 * How far below the nozzle tip the top of the material is that a move lays down.
 *
 * A regular extrusion (a shell, a regular print, the purge tower) is pressed onto its layer, so
 * its top is at the tip. Foam falls from H = H* d above the layer it lands on and builds up one
 * layer thickness there.
 *
 * @param {PathPoint} step The point the move ends at. Not a travel.
 * @param {number} threadDiameter The thread diameter of the extruder that prints it.
 * @returns {number} The distance (mm). 0 or more.
 */
function materialDrop(step: PathPoint, threadDiameter: number): number {
    const foam = !step.regularSegment && !step.ironing && step.hStar !== undefined && Number.isFinite(step.hStar);
    if (!foam) return 0;
    return Math.max(0, step.hStar! * threadDiameter - (step.deltaZ ?? 0));
}

/**
 * Finds every move of a toolpath where the body of the print head would be inside material that
 * was printed earlier in the same toolpath.
 *
 * The toolpath has to be the whole print in the order it runs, moves between objects included, as
 * {@link combineToolpaths} returns it: only what comes before a move can be in its way. Travel
 * moves are checked like printing moves, along their whole length.
 *
 * @param {PathPoint[]} toolpath The print, in print order.
 * @param {PrintHeadModel} head The print head.
 * @param {number} cellSize The size (mm) of a cell of the height map.
 * @returns {HeadCollisionReport} The collisions, grouped by what is printed and what is hit.
 */
export function findHeadCollisions(
    toolpath: PathPoint[],
    head: PrintHeadModel,
    cellSize: number = HEAD_COLLISION_CELL,
): HeadCollisionReport {
    const report: HeadCollisionReport = { collisions: [], moves: 0, depth: 0 };
    const usable = (point: THREE.Vector3) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);

    // The height map only has to cover where material ends up: both ends of every extrusion.
    const bounds = new THREE.Box2();
    const corner = new THREE.Vector2();
    for (let i = 1; i < toolpath.length; i++) {
        if (toolpath[i].travel || !usable(toolpath[i].point) || !usable(toolpath[i - 1].point)) continue;
        bounds.expandByPoint(corner.set(toolpath[i].point.x, toolpath[i].point.y));
        bounds.expandByPoint(corner.set(toolpath[i - 1].point.x, toolpath[i - 1].point.y));
    }
    if (bounds.isEmpty() || !(cellSize > 0)) {
        return report;
    }
    const map = new HeightMap(bounds, cellSize);
    // Half a cell between samples, so an extrusion leaves no gaps in the map. The end of every
    // move is a sample of its own, so the corners of a path are where they really are.
    const sampleSpacing = cellSize / 2;

    const owners: MaterialOwner[] = [];
    const ownerIndices = new Map<string, number>();
    const ownerOf = (step: PathPoint): number => {
        const key = `${step.objectId ?? ''}|${step.role ?? ''}`;
        let index = ownerIndices.get(key);
        if (index === undefined) {
            index = owners.length;
            owners.push({ objectId: step.objectId, role: step.role });
            ownerIndices.set(key, index);
        }
        return index;
    };

    const groups = new Map<string, HeadCollision>();
    let extruder = toolpath.find(step => step.extruder !== undefined)?.extruder ?? 0;
    let previous: THREE.Vector3 | undefined;

    for (let i = 0; i < toolpath.length; i++) {
        const step = toolpath[i];
        // The tool is changed before the move to a point that names one.
        if (step.extruder !== undefined) extruder = step.extruder;
        const to = step.point;
        if (!usable(to)) {
            previous = undefined;
            continue;
        }
        const nozzleLength = head.nozzleLengths[extruder] ?? head.nozzleLengths[0] ?? 0;
        const threadDiameter = head.threadDiameters[extruder] ?? head.threadDiameters[0] ?? 0;
        // Where the head is before the first point is not part of the toolpath.
        const from = previous ?? to;
        const extrudes = !step.travel && previous !== undefined;
        const owner = extrudes ? ownerOf(step) : -1;
        const drop = extrudes ? materialDrop(step, threadDiameter) : 0;
        const halfWidth = threadDiameter / 2;
        if (extrudes) {
            map.raise(from.x, from.y, from.z - drop, halfWidth, owner);
        }

        let deepest = 0;
        let deepestOwner = -1;
        let deepestT = 1;
        const samples = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / sampleSpacing));
        for (let s = 1; s <= samples; s++) {
            const t = s / samples;
            const x = s === samples ? to.x : from.x + (to.x - from.x) * t;
            const y = s === samples ? to.y : from.y + (to.y - from.y) * t;
            const z = s === samples ? to.z : from.z + (to.z - from.z) * t;
            const headBottom = z + nozzleLength;
            const hit = map.highestIn(
                x + head.box.min.x, x + head.box.max.x,
                y + head.box.min.y, y + head.box.max.y,
                headBottom + HEIGHT_TOLERANCE,
            );
            if (hit && hit.top - headBottom > deepest) {
                deepest = hit.top - headBottom;
                deepestOwner = hit.owner;
                deepestT = t;
            }
            if (extrudes) {
                map.raise(x, y, z - drop, halfWidth, owner);
            }
        }
        previous = to;

        if (deepestOwner < 0) continue;
        report.moves++;
        report.depth = Math.max(report.depth, deepest);
        const role = step.objectId === undefined ? step.role : undefined;
        const key = `${step.objectId ?? ''}|${role ?? ''}|${deepestOwner}`;
        const group = groups.get(key);
        if (!group) {
            groups.set(key, {
                objectId: step.objectId,
                ...(role ? { role } : {}),
                obstacle: owners[deepestOwner],
                moves: 1,
                depth: deepest,
                at: from.clone().lerp(to, deepestT),
                index: i,
            });
        } else {
            group.moves++;
            if (deepest > group.depth) {
                group.depth = deepest;
                group.at = from.clone().lerp(to, deepestT);
            }
        }
    }

    report.collisions = [...groups.values()].sort((a, b) => b.depth - a.depth);
    return report;
}

/**
 * Says in a sentence what one collision is: what was being printed, what the head would hit, how
 * often and by how much.
 *
 * @param {HeadCollision} collision The collision.
 * @param {(objectId: number) => string} nameOf The name of an object on the plate.
 * @returns {string} The sentence.
 */
export function describeHeadCollision(collision: HeadCollision, nameOf: (objectId: number) => string): string {
    const { objectId, obstacle } = collision;
    const during = objectId !== undefined ? `While “${nameOf(objectId)}” prints`
        : collision.role === 'purgeTower' ? 'While the purge tower prints'
        : collision.role === 'purgeLine' ? 'While the purge line prints'
        // An approach: from one part of the print to the next, within an object or between two.
        : 'On a move between parts';
    let hit: string;
    if (obstacle.role === 'purgeTower') {
        hit = 'the purge tower';
    } else if (obstacle.role === 'purgeLine') {
        hit = 'the purge line';
    } else if (obstacle.objectId === undefined) {
        hit = 'material that is already printed';
    } else if (obstacle.role === 'boundary') {
        hit = `the boundary of “${nameOf(obstacle.objectId)}”`;
    } else if (obstacle.objectId === objectId) {
        hit = 'a part of it that is already printed';
    } else {
        hit = `“${nameOf(obstacle.objectId)}”, which is already printed`;
    }
    const moves = `${collision.moves.toLocaleString('en-US')} move${collision.moves === 1 ? '' : 's'}`;
    return `${during}, the print head would hit ${hit}: ${moves}, the head up to ${collision.depth.toFixed(2)} mm too low ` +
        `(nozzle at z = ${collision.at.z.toFixed(2)} mm).`;
}

/** At most this many collisions are spelled out in a message; the rest are counted. */
const MAX_DESCRIBED_COLLISIONS = 3;

/**
 * Puts what the check found into one message for the user, deepest collisions first.
 *
 * @param {HeadCollisionReport} report What {@link findHeadCollisions} found.
 * @param {(objectId: number) => string} nameOf The name of an object on the plate.
 * @returns {string | null} The message, or null if the head stays clear.
 */
export function describeHeadCollisions(report: HeadCollisionReport, nameOf: (objectId: number) => string): string | null {
    if (!report.collisions.length) return null;
    const described = report.collisions.slice(0, MAX_DESCRIBED_COLLISIONS);
    const more = report.collisions.length - described.length;
    const betweenObjects = described.some(c =>
        c.obstacle.objectId !== undefined && c.objectId !== undefined && c.obstacle.objectId !== c.objectId);
    return 'Collision detected: ' +
        described.map((collision, i) => {
            const sentence = describeHeadCollision(collision, nameOf);
            return i === 0 ? sentence.charAt(0).toLowerCase() + sentence.slice(1) : sentence;
        }).join(' ') +
        (more > 0 ? ` (and ${more} more)` : '') +
        (betweenObjects ? ' Move the objects apart, or press Arrange.' : '');
}
