import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import Printer from '../../printer/Printer';
import type Visualizer from '../Visualizer';
import type { EverydayModel, ToolpathConfig } from '../types/modelTypes';
import type { PathPoint } from './pathTypes';
import { describeHeadCollision, describeHeadCollisions, findHeadCollisions, type PrintHeadModel } from './printCollision';
import { generateFoamToolpath } from './generateFoamToolpath';
import { DEFAULT_REGULAR_CONFIG } from './regularSlicer';

/** The default print head: 4.5 mm nozzles, a 0.4 mm thread. */
const HEAD: PrintHeadModel = {
    box: { min: new THREE.Vector2(-40, -15), max: new THREE.Vector2(35, 70) },
    nozzleLengths: [4.5, 4.5],
    threadDiameters: [0.4, 0.4],
};

/** A 4 x 4 mm post of regular extrusion around (x, y), printed in 0.5 mm layers up to `top`. */
function post(x: number, y: number, top: number, objectId: number, extra: Partial<PathPoint> = {}): PathPoint[] {
    const path: PathPoint[] = [];
    for (let layer = 1; layer * 0.5 <= top + 1e-9; layer++) {
        [[-2, -2], [2, -2], [2, 2], [-2, 2], [-2, -2]].forEach(([dx, dy], k) => {
            path.push({
                point: new THREE.Vector3(x + dx, y + dy, layer * 0.5),
                travel: k === 0, regularSegment: k !== 0, objectId, ...extra,
            });
        });
    }
    return path;
}

/** Comes down from far above and prints 1 mm of regular extrusion from (x, y, z) in +x. */
function dab(x: number, y: number, z: number, objectId: number, extra: Partial<PathPoint> = {}): PathPoint[] {
    return [
        { point: new THREE.Vector3(x, y, 100), travel: true, role: 'approach' },
        { point: new THREE.Vector3(x, y, z), travel: true, objectId, ...extra },
        { point: new THREE.Vector3(x + 1, y, z), regularSegment: true, objectId },
    ];
}

/** Lifts the head straight up, clear of everything, from where a path ends. */
function liftOff(path: PathPoint[]): PathPoint {
    const last = path[path.length - 1].point;
    return { point: new THREE.Vector3(last.x, last.y, 100), travel: true, role: 'approach' };
}

describe('findHeadCollisions', () => {
    it('finds nothing in a print that goes up layer by layer', () => {
        expect(findHeadCollisions(post(100, 100, 30, 1), HEAD)).toEqual({ collisions: [], moves: 0, depth: 0 });
    });

    it('finds the head hitting a part that was printed before, next to where it prints now', () => {
        const tall = post(100, 100, 30, 1);
        const report = findHeadCollisions([...tall, liftOff(tall), ...dab(110, 100, 1, 2)], HEAD);

        expect(report.collisions).toHaveLength(1);
        const [collision] = report.collisions;
        expect(collision.objectId).toBe(2);
        expect(collision.obstacle).toEqual({ objectId: 1, role: undefined });
        // The post reaches 30 mm; the head body starts at 1 + 4.5 mm.
        expect(collision.depth).toBeCloseTo(24.5, 6);
        expect(collision.at.z).toBeCloseTo(1, 6);
        // The move down to the start of the dab and the dab itself.
        expect(collision.moves).toBe(2);
        expect(report.moves).toBe(2);
        expect(report.depth).toBeCloseTo(24.5, 6);
        // The first colliding move is the one that comes down beside the post.
        expect(collision.index).toBe(tall.length + 2);
    });

    it('only counts what is printed before a move', () => {
        // The same two parts, the low one first: by the time the post is tall, the head is above it.
        const low = dab(110, 100, 1, 2);
        expect(findHeadCollisions([...low, liftOff(low), ...post(100, 100, 30, 1)], HEAD).collisions).toEqual([]);
    });

    it('follows the footprint of the head, which reaches further on one side than on the other', () => {
        const tall = post(100, 100, 30, 1);
        const at = (x: number, y: number) => findHeadCollisions([...tall, liftOff(tall), ...dab(x, y, 1, 2)], HEAD).moves;

        // The head reaches 35 mm in +x and 40 mm in -x from the nozzle. The post's lines are 0.4 mm
        // wide around x = 98..102, so it spans 97.8..102.2, and the dab ends 1 mm further in +x.
        expect(at(61.7, 100)).toBe(0);
        expect(at(61.9, 100)).toBeGreaterThan(0);
        expect(at(142.3, 100)).toBe(0);
        expect(at(142.1, 100)).toBeGreaterThan(0);
        // And 70 mm in +y, 15 mm in -y; the post spans y = 97.8..102.2.
        expect(at(100, 27.7)).toBe(0);
        expect(at(100, 27.9)).toBeGreaterThan(0);
        expect(at(100, 117.3)).toBe(0);
        expect(at(100, 117.1)).toBeGreaterThan(0);
    });

    it('tells a head that stops at the edge of a part from one that reaches into it, wherever the grid falls', () => {
        // Arrange puts a foam print where the head's reach just touches the part next to it, so a
        // fraction of a millimetre decides. Shifting the plate moves the parts across the grid.
        for (const shift of [0, 0.13, 0.27, 0.41, 0.5]) {
            const tall = post(100 + shift, 100 + shift, 30, 1);
            const beside = (y: number) =>
                findHeadCollisions([...tall, liftOff(tall), ...dab(100 + shift, y + shift, 1, 2)], HEAD).moves;
            // The back of the head is 15 mm behind the nozzle; the post ends at y = 102.2.
            expect(beside(117.25)).toBe(0);
            expect(beside(117.15)).toBeGreaterThan(0);
        }
    });

    it('does not count material that only reaches the bottom of the head body', () => {
        const short = post(100, 100, 5.5, 1);
        expect(findHeadCollisions([...short, liftOff(short), ...dab(110, 100, 1, 2)], HEAD).moves).toBe(0);
        const taller = post(100, 100, 6, 1);
        const report = findHeadCollisions([...taller, liftOff(taller), ...dab(110, 100, 1, 2)], HEAD);
        expect(report.depth).toBeCloseTo(0.5, 6);
    });

    it('checks travel moves along their whole length', () => {
        const tall = post(100, 100, 30, 1);
        const report = findHeadCollisions([
            ...tall,
            liftOff(tall),
            { point: new THREE.Vector3(40, 100, 100), travel: true, role: 'approach' },
            { point: new THREE.Vector3(40, 100, 2), travel: true, role: 'approach' },
            // Straight past the post, 2 mm above the bed. Both ends are clear of it.
            { point: new THREE.Vector3(160, 100, 2), travel: true, role: 'approach' },
        ], HEAD);

        expect(report.collisions).toHaveLength(1);
        expect(report.collisions[0].objectId).toBeUndefined();
        expect(report.collisions[0].role).toBe('approach');
        expect(report.collisions[0].obstacle.objectId).toBe(1);
        expect(report.collisions[0].moves).toBe(1);
        expect(report.collisions[0].depth).toBeCloseTo(30 - 6.5, 6);
        // Where the head first reaches the post: its +x edge, 35 mm ahead of the nozzle, at x = 98.
        expect(report.collisions[0].at.x).toBeGreaterThan(62);
        expect(report.collisions[0].at.x).toBeLessThan(64);
    });

    it('takes foam to lie one layer thick on its layer, below the nozzle that dropped it', () => {
        // A foam line printed with the nozzle at z = 10: H = 6 x 0.4 = 2.4 mm above its layer at 7.6,
        // which it fills to 8.2 mm.
        const foam: PathPoint[] = [
            { point: new THREE.Vector3(100, 100, 10), travel: true, objectId: 1 },
            { point: new THREE.Vector3(104, 100, 10), hStar: 6, deltaZ: 0.6, vStar: 0.15, edot: 50, objectId: 1 },
        ];
        const beside = (z: number) => findHeadCollisions([...foam, liftOff(foam), ...dab(110, 100, z, 2)], HEAD);

        // Head body at 3.6 + 4.5 = 8.1 mm: 0.1 mm into the foam.
        expect(beside(3.6).depth).toBeCloseTo(0.1, 6);
        // At 8.3 mm it is clear, although the nozzle that printed the foam was at 10.
        expect(beside(3.8).moves).toBe(0);
    });

    it('takes foam thinned under a roof to lie only as thick as its own layer', () => {
        // Under a roof H* is lowered to 3: the nozzle at z = 8.8 is 1.2 mm over its layer at 7.6,
        // and the layer comes out 0.5 mm thick (its deltaZ), to 8.1 mm.
        const foam: PathPoint[] = [
            { point: new THREE.Vector3(100, 100, 8.8), travel: true, objectId: 1 },
            { point: new THREE.Vector3(104, 100, 8.8), hStar: 3, deltaZ: 0.5, vStar: 0.15, edot: 50, objectId: 1 },
        ];
        const beside = (z: number) => findHeadCollisions([...foam, liftOff(foam), ...dab(110, 100, z, 2)], HEAD);

        // Head body at 3.7 + 4.5 = 8.2 mm: clear of the thinned foam. A whole 1.7 mm layer would
        // reach 9.3 mm.
        expect(beside(3.7).moves).toBe(0);
        // At 8.0 mm it is 0.1 mm into it.
        expect(beside(3.5).depth).toBeCloseTo(0.1, 6);
    });

    it('uses the nozzle length of the extruder that is picked', () => {
        const head: PrintHeadModel = { ...HEAD, nozzleLengths: [4.5, 40] };
        const tall = post(100, 100, 30, 1);
        const withTool = (extruder: number) =>
            findHeadCollisions([...tall, liftOff(tall), ...dab(110, 100, 1, 2, { extruder })], head).moves;

        expect(withTool(0)).toBeGreaterThan(0);
        expect(withTool(1)).toBe(0);
    });

    it('names the purge tower when that is what is in the way', () => {
        const tower = post(100, 100, 30, 1, { objectId: undefined, role: 'purgeTower' });
        const report = findHeadCollisions([...tower, liftOff(tower), ...dab(110, 100, 1, 2)], HEAD);
        expect(report.collisions[0].obstacle).toEqual({ objectId: undefined, role: 'purgeTower' });
    });

    it('keeps apart what is printed and what is hit, deepest first', () => {
        const tall = post(100, 100, 30, 1);
        const medium = post(100, 140, 20, 2);
        const report = findHeadCollisions([
            ...tall, liftOff(tall),
            ...medium, liftOff(medium),
            // Next to the 20 mm post only: the 30 mm one is behind the head, out of its reach.
            ...dab(100, 150, 1, 3), liftOff(dab(100, 150, 1, 3)),
            // Next to both: the deeper one is reported.
            ...dab(110, 110, 1, 4),
        ], HEAD);

        // The 20 mm post itself printed clear of the 30 mm one: the head only reaches 15 mm in -y.
        expect(report.collisions.map(c => [c.objectId, c.obstacle.objectId])).toEqual([[4, 1], [3, 2]]);
        expect(report.collisions[0].depth).toBeCloseTo(24.5, 6);
        expect(report.collisions[1].depth).toBeCloseTo(14.5, 6);
        expect(report.moves).toBe(report.collisions.reduce((sum, c) => sum + c.moves, 0));
    });

    it('handles toolpaths with nothing to hit', () => {
        const empty = { collisions: [], moves: 0, depth: 0 };
        expect(findHeadCollisions([], HEAD)).toEqual(empty);
        expect(findHeadCollisions([{ point: new THREE.Vector3(1, 1, 1), travel: true }], HEAD)).toEqual(empty);
        expect(findHeadCollisions([{ point: new THREE.Vector3(1, 1, 1) }, { point: new THREE.Vector3(NaN, 1, 1) }], HEAD)).toEqual(empty);
    });

    it('gives the same answer on a coarser grid', () => {
        const tall = post(100, 100, 30, 1);
        const path = [...tall, liftOff(tall), ...dab(110, 100, 1, 2)];
        expect(findHeadCollisions(path, HEAD, 2).depth).toBeCloseTo(24.5, 6);
        expect(findHeadCollisions(path, HEAD, 0).moves).toBe(0); // no grid to check on
    });
});

describe('describeHeadCollisions', () => {
    const names = (id: number) => ['zero', 'post', 'pad'][id] ?? 'object';
    const collision = (objectId: number | undefined, obstacle: { objectId?: number, role?: PathPoint['role'] }, moves = 1200, depth = 1.5) =>
        ({ objectId, obstacle, moves, depth, at: new THREE.Vector3(10, 10, 9.1), index: 0 });

    it('says what was printing, what is in the way, how often and by how much', () => {
        expect(describeHeadCollision(collision(2, { objectId: 1 }), names)).toBe(
            'While “pad” prints, the print head would hit “post”, which is already printed: 1,200 moves, the head up to 1.50 mm too low (nozzle at z = 9.10 mm).');
        expect(describeHeadCollision(collision(1, { objectId: 1 }, 1), names)).toMatch(
            /^While “post” prints, the print head would hit a part of it that is already printed: 1 move,/);
        expect(describeHeadCollision(collision(undefined, { objectId: 1 }), names)).toMatch(
            /^On a move between parts, the print head would hit “post”/);
        expect(describeHeadCollision({ ...collision(undefined, { objectId: 1 }), role: 'purgeTower' }, names)).toMatch(
            /^While the purge tower prints, the print head would hit “post”/);
        expect(describeHeadCollision(collision(2, { role: 'purgeTower' }), names)).toMatch(/would hit the purge tower:/);
        expect(describeHeadCollision(collision(2, { objectId: 1, role: 'boundary' }), names)).toMatch(/would hit the boundary of “post”:/);
    });

    it('returns nothing when the head stays clear', () => {
        expect(describeHeadCollisions({ collisions: [], moves: 0, depth: 0 }, names)).toBeNull();
    });

    it('spells out the deepest three and counts the rest', () => {
        const collisions = [
            collision(2, { objectId: 1 }, 10, 4), collision(1, { objectId: 2 }, 10, 3),
            collision(1, { objectId: 1 }, 10, 2), collision(2, { objectId: 2 }, 10, 1),
        ];
        const message = describeHeadCollisions({ collisions, moves: 40, depth: 4 }, names)!;
        expect(message).toMatch(/^Collision detected: while “pad” prints, the print head would hit “post”/);
        expect(message.match(/would hit/g)).toHaveLength(3);
        expect(message).toMatch(/\(and 1 more\) Move the objects apart, or press Arrange\.$/);
    });

    it('does not tell the user to move objects apart when an object only hits itself', () => {
        const message = describeHeadCollisions({ collisions: [collision(1, { objectId: 1 })], moves: 1200, depth: 1.5 }, names)!;
        expect(message).not.toMatch(/Arrange/);
    });
});

describe('findHeadCollisions on a sliced foam print', () => {
    function toolpathConfig(overrides: Partial<ToolpathConfig> = {}): ToolpathConfig {
        return {
            deltaZ: 1.7, hStar: 6, hStarEnd: 6, vStar: 0.15, vStarEnd: 0.15, deltaL: 1.7, deltaLEnd: 1.7,
            senseDeltaZ: 1.7, senseHStar: 6, senseHStarEnd: 6, senseVStar: 0.15, SenseVStarEnd: 0.15,
            senseDeltaL: 1.7, senseDeltaLEnd: 1.7,
            gridSize: 4, initialFoamLayerCount: 3, middleSenseLayerCount: 0, finalFoamLayerCount: 0,
            edot: 50, senseEdot: 50, bumpSpacingX: 10, bumpSpacingY: 10, bumpScale: 1, generateBumps: false,
            curveAugment: false, steepnessThreshold: 60, flatLayerZOffset: 3, additionalCurveLayers: 0,
            ...overrides,
        };
    }

    /** A box-shaped Foam Print standing on the bed. */
    function foamBox(objectId: number, x: number, y: number, size: [number, number, number]): EverydayModel {
        const geometry = new THREE.BoxGeometry(...size).translate(0, 0, size[2] / 2);
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
        mesh.position.set(x, y, 0);
        return {
            objectId,
            kind: 'foam',
            regularConfig: { ...DEFAULT_REGULAR_CONFIG },
            name: `box ${objectId}`,
            mesh,
            geometry,
            transformType: 'move',
            transformX: { x: 0 }, transformY: { y: 0 }, transformZ: { z: 0 },
            gradient: { width: 1, height: 1, sampleColor: () => ({ r: 255, g: 255, b: 255, a: 255 }) },
            toolpathConfig: toolpathConfig(),
            initialConfig: toolpathConfig({ initialFoamLayerCount: 0 }),
            initialOffset: 0,
        };
    }

    function headOf(printer: Printer): PrintHeadModel {
        return {
            box: printer.printHeadDims,
            nozzleLengths: printer.extruders.map(extruder => extruder.nozzleLength),
            threadDiameters: printer.extruders.map((_, i) => printer.threadDiameter(i)),
        };
    }

    it('finds nothing wrong with a single box, whose head is always above what it has printed', () => {
        const printer = new Printer();
        const visualizer = { scene: new THREE.Scene(), printer, config: {} } as unknown as Visualizer;
        const toolpath = generateFoamToolpath(visualizer, [foamBox(1, 100, 100, [20, 20, 20])], { preview: false });

        expect(toolpath.some(point => !point.travel && point.hStar !== undefined)).toBe(true);
        expect(findHeadCollisions(toolpath, headOf(printer))).toEqual({ collisions: [], moves: 0, depth: 0 });
    });

    it('finds a foam print that starts at the foot of a regular part printed before it', () => {
        const printer = new Printer();
        const visualizer = { scene: new THREE.Scene(), printer, config: {} } as unknown as Visualizer;
        const foam = generateFoamToolpath(visualizer, [foamBox(2, 120, 100, [10, 10, 6])], { preview: false, purgeLine: false });
        // As Slice Prints orders them: the regular part first, then up and over to the foam print.
        const regular = post(100, 100, 30, 1);
        const start = foam.findIndex(point => !point.travel);
        const report = findHeadCollisions([
            ...regular,
            liftOff(regular),
            { point: new THREE.Vector3(foam[start - 1].point.x, foam[start - 1].point.y, 100), travel: true, role: 'approach' },
            ...foam.slice(start - 1),
        ], headOf(printer));

        expect(report.collisions.length).toBeGreaterThan(0);
        expect(report.collisions.every(c => c.obstacle.objectId === 1)).toBe(true);
        expect(report.collisions.some(c => c.objectId === 2)).toBe(true);
        // The lowest the head body gets is a shell layer (0.1 mm) plus the nozzle above the bed.
        expect(report.depth).toBeGreaterThan(30 - printer.extruders[0].nozzleLength - 1);
        expect(report.depth).toBeLessThanOrEqual(30 - printer.extruders[0].nozzleLength);
    });
});
