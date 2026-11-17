import { describe, expect, it } from 'vitest';
import {
    arrange,
    circlePolygon,
    clearOf,
    convexHull,
    findFreeSpot,
    headConflicts,
    headReach,
    polygonArea,
    separated,
    translate,
    type ArrangeItem,
    type ArrangeSpace,
    type Point2,
} from './arrange';

/** A square outline of side `size`, centred on 0, 0. */
const square = (size: number) => [
    { x: -size / 2, y: -size / 2 }, { x: size / 2, y: -size / 2 },
    { x: size / 2, y: size / 2 }, { x: -size / 2, y: size / 2 },
];

function item(id: number, size: number, at: Point2, extra: Partial<ArrangeItem> = {}): ArrangeItem {
    return { id, outline: square(size), position: at, top: 10, foam: false, movable: true, ...extra };
}

const space: ArrangeSpace = {
    width: 200, depth: 200, margin: 5, spacing: 6,
    head: { minX: -40, minY: -15, maxX: 35, maxY: 70 },
    nozzleLength: 4.5,
    reserved: [],
    step: 2.5,
};

/** Every pair of items is clear of each other at the given positions. */
function allClear(items: ArrangeItem[], positions: Map<number, Point2>): boolean {
    const at = (i: ArrangeItem) => positions.get(i.id) ?? i.position;
    return items.every((a, i) => items.slice(i + 1).every(b => clearOf(a, at(a), b, at(b), space)));
}

describe('geometry', () => {
    it('finds the convex hull of a point cloud', () => {
        const hull = convexHull([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }, { x: 2, y: 8 }]);
        expect(hull).toHaveLength(4);
        expect(polygonArea(hull)).toBeCloseTo(100, 9);
    });

    it('tells polygons apart by a gap', () => {
        const a = square(10);
        const b = translate(square(10), { x: 15, y: 0 });
        expect(separated(a, b, 0)).toBe(true);
        expect(separated(a, b, 5)).toBe(true);
        expect(separated(a, b, 6)).toBe(false);
        expect(separated(a, translate(square(10), { x: 5, y: 5 }), 0)).toBe(false);
    });

    it('grows an outline by the print head in each direction', () => {
        const reach = headReach(square(10), space.head);
        const xs = reach.map(p => p.x);
        const ys = reach.map(p => p.y);
        expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([-45, 40, -20, 75]);
    });

    it('draws a circle around the whole circle', () => {
        const circle = circlePolygon({ x: 0, y: 0 }, 10);
        circle.forEach(p => expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(10));
    });
});

describe('findFreeSpot', () => {
    it('keeps the spot asked for when it is free', () => {
        expect(findFreeSpot(item(1, 20, { x: 0, y: 0 }), [], space, { x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
    });

    it('moves next to an object in the way, with the spacing between them', () => {
        const other = item(2, 20, { x: 100, y: 100 });
        const spot = findFreeSpot(item(1, 20, { x: 0, y: 0 }), [other], space, { x: 100, y: 100 })!;
        const newItem = item(1, 20, spot);
        expect(clearOf(newItem, spot, other, other.position, space)).toBe(true);
        // Nearest free spot: 20 + 6 mm from the other centre along one axis, give or take a grid step.
        expect(Math.hypot(spot.x - 100, spot.y - 100)).toBeLessThanOrEqual(26 + space.step);
    });

    it('stays off the reserved areas and inside the margin', () => {
        const reserved = [translate(square(60), { x: 100, y: 100 })];
        const spot = findFreeSpot(item(1, 20, { x: 0, y: 0 }), [], { ...space, reserved }, { x: 100, y: 100 })!;
        expect(separated(translate(square(20), spot), reserved[0], space.spacing)).toBe(true);
        const edge = findFreeSpot(item(1, 20, { x: 0, y: 0 }), [], space, { x: 0, y: 0 })!;
        expect(edge.x - 10).toBeGreaterThanOrEqual(space.margin);
        expect(edge.y - 10).toBeGreaterThanOrEqual(space.margin);
    });

    it('keeps a tall part out of the reach of the print head while foam is printed', () => {
        const foam = item(2, 20, { x: 100, y: 100 }, { foam: true, movable: false });
        const spot = findFreeSpot(item(1, 20, { x: 0, y: 0 }, { top: 30 }), [foam], space, { x: 100, y: 100 })!;
        // The head reaches 40 mm left, 35 right, 15 in front and 70 behind; in front is nearest.
        expect(spot.y).toBeLessThanOrEqual(100 - 10 - 15 - 10 + 1e-9);
        // A part lower than the nozzle can stand closer.
        const low = findFreeSpot(item(1, 20, { x: 0, y: 0 }, { top: 3 }), [foam], space, { x: 100, y: 100 })!;
        expect(Math.hypot(low.x - 100, low.y - 100)).toBeLessThanOrEqual(26 + space.step);
    });

    it('says when nothing fits', () => {
        expect(findFreeSpot(item(1, 300, { x: 0, y: 0 }), [], space, { x: 100, y: 100 })).toBeNull();
    });
});

describe('arrange', () => {
    it('packs every movable object clear of the others, and leaves the fixed ones alone', () => {
        const items = [
            item(1, 40, { x: 100, y: 100 }),
            item(2, 30, { x: 100, y: 100 }),
            item(3, 20, { x: 100, y: 100 }),
            item(4, 25, { x: 60, y: 60 }, { movable: false, foam: true, top: 3 }),
        ];
        const { positions, unplaced } = arrange(items, space);
        expect(unplaced).toEqual([]);
        expect(positions.has(4)).toBe(false);
        expect([...positions.keys()].sort()).toEqual([1, 2, 3]);
        expect(allClear(items, positions)).toBe(true);
    });

    it('reports what does not fit', () => {
        const items = [item(1, 150, { x: 100, y: 100 }), item(2, 150, { x: 100, y: 100 })];
        const { positions, unplaced } = arrange(items, space);
        expect(positions.size).toBe(1);
        expect(unplaced).toHaveLength(1);
    });
});

describe('headConflicts', () => {
    it('finds a tall part within the reach of the head over a foam print, and nothing else', () => {
        const foam = item(1, 20, { x: 100, y: 100 }, { foam: true });
        const behind = item(2, 20, { x: 100, y: 150 }, { top: 20 });
        const lowBehind = item(3, 20, { x: 140, y: 150 }, { top: 2 });
        const farAway = item(4, 20, { x: 20, y: 20 }, { top: 20 });
        expect(headConflicts([foam, behind, lowBehind, farAway], space)).toEqual([[1, 2]]);
    });
});

describe('objects that do not fit', () => {
    it('keeps later objects clear of one that stayed where it was', () => {
        // Wider than the bed inside its margins, so it fits nowhere and stays in the middle.
        const wide = item(1, 10, { x: 100, y: 100 }, { outline: [{ x: -130, y: -50 }, { x: 130, y: -50 }, { x: 130, y: 50 }, { x: -130, y: 50 }] });
        const small = item(2, 20, { x: 20, y: 20 });
        const { positions, unplaced } = arrange([wide, small], space);

        expect(unplaced).toEqual([1]);
        const at = positions.get(2)!;
        expect(at).toBeDefined();
        expect(clearOf(small, at, wide, wide.position, space)).toBe(true);
    });

    it('does not search the whole bed again for each of many objects that cannot fit', () => {
        // A foam print with a tall neighbour everywhere within the reach of the head: none fits
        // next to another. Fifty of them used to take most of a minute.
        const pucks = Array.from({ length: 50 }, (_, i) =>
            item(i + 1, 10, { x: 100, y: 100 }, { outline: circlePolygon({ x: 0, y: 0 }, 30, 64), foam: true, top: 20 }));
        const started = Date.now();
        const { positions, unplaced } = arrange(pucks, space);
        expect(positions.size + unplaced.length).toBe(50);
        expect(unplaced.length).toBeGreaterThan(40);
        expect(Date.now() - started).toBeLessThan(5000);
    });
});

describe('separated, far apart and close by', () => {
    it('agrees with itself whether or not the bounding boxes settle it', () => {
        const a = square(10);
        // Far apart along x: settled by the boxes.
        expect(separated(a, translate(square(10), { x: 40, y: 0 }), 6)).toBe(true);
        // Boxes overlap along both axes once the gap is counted: the edges decide.
        expect(separated(a, translate(square(10), { x: 15.9, y: 0 }), 6)).toBe(false);
        expect(separated(a, translate(square(10), { x: 16, y: 0 }), 6)).toBe(true);
        expect(separated(a, translate(square(10), { x: 5, y: 5 }), 0)).toBe(false);
    });
});
