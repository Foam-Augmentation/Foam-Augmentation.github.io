// ---------------------------------------------------------------------------------------------
// Where objects can stand on the bed: their outlines seen from above, the gaps between them, and
// the room the print head needs. Used to arrange the plate, to place new objects and copies in
// free space, and to warn about a plate where printing foam would drive the head into a part.
//
// Every outline is a convex polygon (the convex hull of the object seen from above), so two
// outlines can be tested with the separating axis theorem. The gap between two outlines is
// measured along their edge normals, which never overstates it: a placement that passes keeps at
// least the asked-for gap.
//
// No DOM and no three.js here, so it can be unit-tested under Node.
// ---------------------------------------------------------------------------------------------

/** A point in mm. */
export interface Point2 {
    x: number;
    y: number;
}

/** A convex polygon, its points in order around it. */
export type Polygon = Point2[];

/** One object as the arranger sees it. */
export interface ArrangeItem {
    /** The object's id (`EverydayModel.objectId`). */
    id: number;
    /** Its outline seen from above, relative to `position`. Convex. */
    outline: Polygon;
    /** Where it stands (its mesh's x and y). */
    position: Point2;
    /** The height of its top above the bed (mm). */
    top: number;
    /** True if foam is printed at it (a Foam Print, or an Augmentation). */
    foam: boolean;
    /** False for objects that must stay where they are: an Augmentation is a real object on the bed. */
    movable: boolean;
}

/** The bed and the printer, as far as placing objects goes. */
export interface ArrangeSpace {
    /** Bed size (mm) and the margin kept free along its edges. */
    width: number;
    depth: number;
    margin: number;
    /** The smallest gap (mm) between two objects. */
    spacing: number;
    /**
     * Where the print head body reaches around the nozzle (mm, nozzle at 0, 0). While foam is
     * printed at an object, nothing taller than `nozzleLength` may stand in that reach.
     */
    head: { minX: number, minY: number, maxX: number, maxY: number };
    /** How far the nozzle reaches below the head body (mm). */
    nozzleLength: number;
    /** Areas nothing may stand on, in bed coordinates: the purge line, the purge tower. */
    reserved: Polygon[];
    /** The grid (mm) candidate positions are tried on. */
    step: number;
}

/** The convex hull of a set of points (Andrew's monotone chain), counter-clockwise. */
export function convexHull(points: Point2[]): Polygon {
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    if (sorted.length < 3) return sorted;
    const cross = (o: Point2, a: Point2, b: Point2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower: Point2[] = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-12) lower.pop();
        lower.push(p);
    }
    const upper: Point2[] = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-12) upper.pop();
        upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
}

/** A polygon moved by an offset. */
export function translate(polygon: Polygon, offset: Point2): Polygon {
    return polygon.map(p => ({ x: p.x + offset.x, y: p.y + offset.y }));
}

/** The area (mm²) of a polygon. */
export function polygonArea(polygon: Polygon): number {
    let sum = 0;
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
}

/** A circle as a polygon with `sides` corners, drawn around it so it covers the whole circle. */
export function circlePolygon(center: Point2, radius: number, sides = 16): Polygon {
    const r = radius / Math.cos(Math.PI / sides);
    return Array.from({ length: sides }, (_, i) => {
        const angle = (2 * Math.PI * i) / sides;
        return { x: center.x + r * Math.cos(angle), y: center.y + r * Math.sin(angle) };
    });
}

/** Where the projection of a polygon onto an axis starts and ends. */
function project(polygon: Polygon, axis: Point2): [number, number] {
    let min = Infinity;
    let max = -Infinity;
    for (const p of polygon) {
        const d = p.x * axis.x + p.y * axis.y;
        if (d < min) min = d;
        if (d > max) max = d;
    }
    return [min, max];
}

/**
 * Whether two convex polygons are at least `gap` apart along one of their edge normals.
 * A single point or a segment works as a polygon too.
 */
export function separated(a: Polygon, b: Polygon, gap = 0): boolean {
    if (!a.length || !b.length) return true;
    for (const polygon of [a, b]) {
        for (let i = 0; i < polygon.length; i++) {
            const p = polygon[i];
            const q = polygon[(i + 1) % polygon.length];
            const length = Math.hypot(q.x - p.x, q.y - p.y);
            if (length < 1e-12) continue;
            const axis = { x: -(q.y - p.y) / length, y: (q.x - p.x) / length };
            const [minA, maxA] = project(a, axis);
            const [minB, maxB] = project(b, axis);
            if (minB - maxA >= gap - 1e-9 || minA - maxB >= gap - 1e-9) return true;
        }
    }
    return false;
}

/**
 * Where the print head body reaches while the nozzle moves over an outline: the outline grown
 * by the head's extent in each direction.
 */
export function headReach(outline: Polygon, head: ArrangeSpace['head']): Polygon {
    const corners = [
        { x: head.minX, y: head.minY }, { x: head.maxX, y: head.minY },
        { x: head.maxX, y: head.maxY }, { x: head.minX, y: head.maxY },
    ];
    return convexHull(outline.flatMap(p => corners.map(c => ({ x: p.x + c.x, y: p.y + c.y }))));
}

/** Whether an outline, at a position, lies on the bed inside its margin. */
function onBed(outline: Polygon, position: Point2, space: ArrangeSpace): boolean {
    return outline.every(p => {
        const x = p.x + position.x;
        const y = p.y + position.y;
        return x >= space.margin - 1e-9 && x <= space.width - space.margin + 1e-9
            && y >= space.margin - 1e-9 && y <= space.depth - space.margin + 1e-9;
    });
}

/**
 * Whether two objects, each at its position, are far enough apart: the spacing between them, and
 * if foam is printed at one and the other is taller than the nozzle, the other clear of the head.
 */
export function clearOf(a: ArrangeItem, aAt: Point2, b: ArrangeItem, bAt: Point2, space: ArrangeSpace): boolean {
    const aOutline = translate(a.outline, aAt);
    const bOutline = translate(b.outline, bAt);
    if (!separated(aOutline, bOutline, space.spacing)) return false;
    if (a.foam && b.top > space.nozzleLength && !separated(headReach(aOutline, space.head), bOutline, 0)) return false;
    if (b.foam && a.top > space.nozzleLength && !separated(headReach(bOutline, space.head), aOutline, 0)) return false;
    return true;
}

/** Whether an object fits at a position, given the objects already placed and the reserved areas. */
function fits(item: ArrangeItem, at: Point2, placed: { item: ArrangeItem, at: Point2 }[], space: ArrangeSpace): boolean {
    if (!onBed(item.outline, at, space)) return false;
    const outline = translate(item.outline, at);
    if (space.reserved.some(area => !separated(outline, area, space.spacing))) return false;
    return placed.every(other => clearOf(item, at, other.item, other.at, space));
}

/** Candidate positions on the step grid, nearest to `near` first. */
function candidates(near: Point2, space: ArrangeSpace): Point2[] {
    const points: Point2[] = [];
    for (let x = space.margin; x <= space.width - space.margin + 1e-9; x += space.step) {
        for (let y = space.margin; y <= space.depth - space.margin + 1e-9; y += space.step) {
            points.push({ x, y });
        }
    }
    const distance = (p: Point2) => (p.x - near.x) ** 2 + (p.y - near.y) ** 2;
    return points.sort((a, b) => distance(a) - distance(b));
}

/**
 * Finds the free position nearest to `near` where an object fits among others that stay put.
 *
 * @param {ArrangeItem} item The object to place. Its own position is ignored.
 * @param {ArrangeItem[]} others The objects that stay where they are.
 * @param {ArrangeSpace} space The bed and the printer.
 * @param {Point2} near Where to look first.
 * @returns {Point2 | null} The position, or null if it fits nowhere.
 */
export function findFreeSpot(item: ArrangeItem, others: ArrangeItem[], space: ArrangeSpace, near: Point2): Point2 | null {
    const placed = others.filter(o => o.id !== item.id).map(o => ({ item: o, at: o.position }));
    if (fits(item, near, placed, space)) return { ...near };
    return candidates(near, space).find(at => fits(item, at, placed, space)) ?? null;
}

/** The result of arranging a plate. */
export interface ArrangeResult {
    /** The new position of every movable object that fits. */
    positions: Map<number, Point2>;
    /** Movable objects that fit nowhere; they stay where they were. */
    unplaced: number[];
}

/**
 * Arranges the movable objects around the middle of the bed, largest first, each where it is
 * clear of everything placed before it (and of the objects that stay put).
 *
 * @param {ArrangeItem[]} items Every object on the plate.
 * @param {ArrangeSpace} space The bed and the printer.
 * @returns {ArrangeResult} Where each movable object goes.
 */
export function arrange(items: ArrangeItem[], space: ArrangeSpace): ArrangeResult {
    const placed = items.filter(i => !i.movable).map(i => ({ item: i, at: i.position }));
    const movable = items.filter(i => i.movable).sort((a, b) => polygonArea(b.outline) - polygonArea(a.outline));
    const center = { x: space.width / 2, y: space.depth / 2 };
    const grid = candidates(center, space);
    const positions = new Map<number, Point2>();
    const unplaced: number[] = [];
    for (const item of movable) {
        const at = grid.find(p => fits(item, p, placed, space));
        if (at) {
            positions.set(item.id, at);
            placed.push({ item, at });
        } else {
            unplaced.push(item.id);
        }
    }
    return { positions, unplaced };
}

/**
 * Finds the pairs of objects where printing foam at one would bring the print head into the other.
 *
 * @param {ArrangeItem[]} items Every object on the plate, at its position.
 * @param {ArrangeSpace} space The printer.
 * @returns {[number, number][]} Pairs of ids: the object foam is printed at, and the one in the way.
 */
export function headConflicts(items: ArrangeItem[], space: ArrangeSpace): [number, number][] {
    const conflicts: [number, number][] = [];
    for (const foam of items.filter(i => i.foam)) {
        const reach = headReach(translate(foam.outline, foam.position), space.head);
        for (const other of items) {
            if (other === foam || other.top <= space.nozzleLength) continue;
            if (!separated(reach, translate(other.outline, other.position), 0)) conflicts.push([foam.id, other.id]);
        }
    }
    return conflicts;
}
