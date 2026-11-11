import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import Printer from '../../printer/Printer';
import type Visualizer from '../Visualizer';
import type { EverydayModel } from '../types/modelTypes';
import { FEATURE, type PathPoint } from './pathTypes';
import { generateFoamToolpath, getTransformedMesh, makePurgeLine, visualizeToolpath } from './generateFoamToolpath';
import { buildPrintGcode, validateToolpath } from './buildGcode';
import {
    DEFAULT_REGULAR_CONFIG,
    generateRegularToolpath,
    RegularPart,
    RegularPrintConfig,
} from './regularSlicer';

/** Slack (mm) for comparing heights and positions. */
const EPSILON = 1e-6;
/** The default printer's extrusion width (0.4 mm nozzle, no die swell). */
const LINE_WIDTH = 0.4;

/** A regular print config, the defaults with some values replaced. */
function config(overrides: Partial<RegularPrintConfig> = {}): RegularPrintConfig {
    return { ...DEFAULT_REGULAR_CONFIG, ...overrides };
}

/** A box part standing on the bed, centred on (cx, cy). */
function boxPart(
    cx: number, cy: number, sizeX: number, sizeY: number, height: number,
    overrides: Partial<RegularPrintConfig> = {},
): RegularPart {
    const geometry = new THREE.BoxGeometry(sizeX, sizeY, height).translate(cx, cy, height / 2);
    return { mesh: new THREE.Mesh(geometry), config: config(overrides) };
}

/** A 20 mm cube centred on (100, 100). */
function cubePart(overrides: Partial<RegularPrintConfig> = {}): RegularPart {
    return boxPart(100, 100, 20, 20, 20, overrides);
}

/** A 30 x 30 x 4 mm plate centred on (100, 100) with a round through-hole of the given radius. */
function platePartWithHole(holeRadius: number, overrides: Partial<RegularPrintConfig> = {}): RegularPart {
    const shape = new THREE.Shape();
    shape.moveTo(-15, -15);
    shape.lineTo(15, -15);
    shape.lineTo(15, 15);
    shape.lineTo(-15, 15);
    shape.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0, holeRadius, 0, Math.PI * 2, true);
    shape.holes.push(hole);

    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 4, bevelEnabled: false, curveSegments: 48 })
        .translate(100, 100, 0);
    return { mesh: new THREE.Mesh(geometry), config: config(overrides) };
}

/** A 20 x 20 x 5 mm base with a 10 x 10 x 10 mm tower on its middle, centred on (100, 100). */
function steppedPart(overrides: Partial<RegularPrintConfig> = {}): RegularPart {
    const base = new THREE.BoxGeometry(20, 20, 5).translate(100, 100, 2.5).toNonIndexed();
    const tower = new THREE.BoxGeometry(10, 10, 10).translate(100, 100, 10).toNonIndexed();
    const positions = new Float32Array([
        ...(base.attributes.position.array as Float32Array),
        ...(tower.attributes.position.array as Float32Array),
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return { mesh: new THREE.Mesh(geometry), config: config(overrides) };
}

/** One extrusion move: where it starts, where it ends and how long it is. */
interface Extrusion {
    from: THREE.Vector3;
    to: THREE.Vector3;
    length: number;
    point: PathPoint;
}

/** Every extrusion move of a toolpath, in order. */
function extrusions(path: PathPoint[]): Extrusion[] {
    const moves: Extrusion[] = [];
    for (let i = 1; i < path.length; i++) {
        if (path[i].regularSegment) {
            const from = path[i - 1].point, to = path[i].point;
            moves.push({ from, to, length: from.distanceTo(to), point: path[i] });
        }
    }
    return moves;
}

/** The total extruded length (mm) of the moves that pass a filter. */
function extrudedLength(moves: Extrusion[], filter: (move: Extrusion) => boolean = () => true): number {
    return moves.filter(filter).reduce((sum, move) => sum + move.length, 0);
}

/** Distance (mm) between the samples taken along a move when measuring how much of it lies in an area. */
const SAMPLE_STEP = 0.05;

/**
 * The extruded length (mm) that lies inside an area, measured by sampling along every move, so
 * a long line that only passes through the area counts for the part that is inside.
 */
function extrudedLengthInside(moves: Extrusion[], inside: (x: number, y: number) => boolean): number {
    let total = 0;
    for (const move of moves) {
        const steps = Math.max(1, Math.ceil(move.length / SAMPLE_STEP));
        for (let s = 0; s < steps; s++) {
            const t = (s + 0.5) / steps;
            const x = move.from.x + (move.to.x - move.from.x) * t;
            const y = move.from.y + (move.to.y - move.from.y) * t;
            if (inside(x, y)) {
                total += move.length / steps;
            }
        }
    }
    return total;
}

/** A filter for the extrusions printed at a height. */
function atZ(z: number): (move: Extrusion) => boolean {
    return move => Math.abs(move.to.z - z) < 1e-4;
}

/** The distinct heights extrusions are printed at, lowest first. */
function layerHeights(moves: Extrusion[]): number[] {
    const heights: number[] = [];
    for (const move of moves) {
        if (!heights.some(z => Math.abs(z - move.to.z) < 1e-4)) {
            heights.push(move.to.z);
        }
    }
    return heights.sort((a, b) => a - b);
}

/** The amount of filament (mm) every extruding G1 line of a G-code file pushes, in order. */
function extrudedAmounts(gcode: string): number[] {
    const amounts: number[] = [];
    for (const line of gcode.split('\n')) {
        const match = /^G1 X\S+ Y\S+ Z\S+ E(\S+) F\S+/.exec(line);
        if (match) {
            amounts.push(Number(match[1]));
        }
    }
    return amounts;
}

describe('generateRegularToolpath on a 20 mm cube', () => {
    const printer = new Printer();
    const path = generateRegularToolpath(printer, [cubePart()]);
    const moves = extrusions(path);

    it('prints one layer per layer height, the last one at the top of the cube', () => {
        const heights = layerHeights(moves);
        expect(heights.length).toBe(100);
        expect(heights[0]).toBeCloseTo(0.2, 6);
        expect(heights[99]).toBeCloseTo(20, 6);
    });

    it('keeps every point finite and every extrusion inside the footprint', () => {
        for (const point of path) {
            expect(Number.isFinite(point.point.x) && Number.isFinite(point.point.y) && Number.isFinite(point.point.z)).toBe(true);
        }
        // The outer wall's centre line runs half a line width inside the surface.
        const min = 90 + LINE_WIDTH / 2 - 1e-3, max = 110 - LINE_WIDTH / 2 + 1e-3;
        for (const move of moves) {
            for (const p of [move.from, move.to]) {
                expect(p.x).toBeGreaterThanOrEqual(min);
                expect(p.x).toBeLessThanOrEqual(max);
                expect(p.y).toBeGreaterThanOrEqual(min);
                expect(p.y).toBeLessThanOrEqual(max);
            }
        }
    });

    it('never moves down once it has reached the first layer', () => {
        // Only the lead-in comes from above; after it z may only stay or rise.
        expect(path[0].role).toBe('approach');
        expect(path[0].point.z).toBeGreaterThan(path[1].point.z);
        for (let i = 2; i < path.length; i++) {
            expect(path[i].point.z).toBeGreaterThanOrEqual(path[i - 1].point.z - EPSILON);
        }
        for (const move of moves) {
            expect(Math.abs(move.from.z - move.to.z)).toBeLessThan(EPSILON);
        }
    });

    it('prints the top and bottom layers solid and the middle sparse', () => {
        const middle = extrudedLength(moves, atZ(10));
        for (const z of [0.2, 0.8, 19.4, 20]) {
            expect(extrudedLength(moves, atZ(z))).toBeGreaterThan(2.5 * middle);
        }
        // The fifth layer from either end is no longer within four layers of a surface.
        // (Sparse lines sit on a bed-fixed grid, so layers differ by a line end here and there.)
        expect(extrudedLength(moves, atZ(1.0)) / middle).toBeCloseTo(1, 1);
        expect(extrudedLength(moves, atZ(19.2)) / middle).toBeCloseTo(1, 1);
    });

    it('fills a solid layer with about as much plastic as the layer holds', () => {
        // length x line width should cover the 20 x 20 mm layer, give or take overlaps and corners.
        const coverage = extrudedLength(moves, atZ(0.2)) * LINE_WIDTH / (20 * 20);
        expect(coverage).toBeGreaterThan(0.9);
        expect(coverage).toBeLessThan(1.15);
    });

    it('joins the infill lines of a layer into one zigzag instead of travelling between them', () => {
        for (const z of [0.2, 0.4, 10, 10.2]) {
            const travels = path.filter(point => point.travel && Math.abs(point.point.z - z) < 1e-4).length;
            // A lift (or lead-in) to the layer and one travel to each perimeter, then the infill:
            // at most two zigzags, as the first line printed is the nearest one, not a corner one.
            // A solid layer has about 65 lines, so unlinked lines would show up as dozens of travels.
            expect(travels).toBeLessThanOrEqual(7);
        }
    });

    it('handles a dome whose tip collapses to a point', () => {
        const dome = new THREE.SphereGeometry(10, 32, 24).rotateX(Math.PI / 2).translate(100, 100, 10);
        const domePath = generateRegularToolpath(printer, [{ mesh: new THREE.Mesh(dome), config: config() }]);
        const domeMoves = extrusions(domePath);
        expect(layerHeights(domeMoves).length).toBeGreaterThanOrEqual(98);
        for (const move of domeMoves) {
            expect(Math.hypot(move.to.x - 100, move.to.y - 100)).toBeLessThanOrEqual(10);
        }
        expect(validateToolpath(printer, domePath)).toEqual([]);
    });

    it('alternates the infill direction between layers', () => {
        // Direction of the longest move of a layer, folded into [0, 180) degrees.
        const direction = (z: number) => {
            const longest = moves.filter(atZ(z)).reduce((a, b) => (b.length > a.length ? b : a));
            const angle = Math.atan2(longest.to.y - longest.from.y, longest.to.x - longest.from.x) * 180 / Math.PI;
            return ((angle % 180) + 180) % 180;
        };
        expect(direction(0.2)).toBeCloseTo(45, 3);
        expect(direction(0.4)).toBeCloseTo(135, 3);
        expect(direction(10.2)).toBeCloseTo(45, 3);
        expect(direction(10.4)).toBeCloseTo(135, 3);
    });

    it('tags every extrusion with the layer height, speed and extruder of its part', () => {
        for (const move of moves) {
            expect(move.point.layerHeight).toBe(0.2);
            expect(move.point.speed).toBe(1800);
            expect(move.point.extruder).toBe(0);
            expect(move.point.travel).toBeFalsy();
        }
        expect(path.every(point => point.travel || point.regularSegment)).toBe(true);
    });
});

describe('generateRegularToolpath infill density', () => {
    const printer = new Printer();

    it('prints only perimeters in the middle at 0 % and still closes the top and bottom', () => {
        const moves = extrusions(generateRegularToolpath(printer, [cubePart({ infillDensity: 0 })]));
        // Two square loops, 0.2 mm and 0.6 mm inside the 20 mm outline.
        expect(extrudedLength(moves, atZ(10))).toBeCloseTo(4 * 19.6 + 4 * 18.8, 3);
        expect(extrudedLength(moves, atZ(0.2))).toBeGreaterThan(900);
        expect(extrudedLength(moves, atZ(20))).toBeGreaterThan(900);
    });

    it('prints every layer solid at 100 %', () => {
        const moves = extrusions(generateRegularToolpath(printer, [cubePart({ infillDensity: 100, topBottomLayers: 0 })]));
        const bottom = extrudedLength(moves, atZ(0.2));
        expect(bottom).toBeGreaterThan(900);
        for (const z of [0.4, 10, 10.2, 19.8, 20]) {
            expect(extrudedLength(moves, atZ(z)) / bottom).toBeCloseTo(1, 2);
        }
    });

    it('leaves the top and bottom sparse when top/bottom layers are 0', () => {
        const moves = extrusions(generateRegularToolpath(printer, [cubePart({ topBottomLayers: 0 })]));
        expect(extrudedLength(moves, atZ(0.2)) / extrudedLength(moves, atZ(10.2))).toBeCloseTo(1, 1);
        expect(extrudedLength(moves, atZ(20)) / extrudedLength(moves, atZ(10.2))).toBeCloseTo(1, 1);
    });

    it('scales the sparse infill with the density', () => {
        const infillAt = (density: number) => {
            const moves = extrusions(generateRegularToolpath(printer, [cubePart({ infillDensity: density })]));
            return extrudedLength(moves, atZ(10)) - (4 * 19.6 + 4 * 18.8);
        };
        const ratio = infillAt(40) / infillAt(20);
        expect(ratio).toBeGreaterThan(1.7);
        expect(ratio).toBeLessThan(2.3);
    });

    it('prints infill without perimeters when perimeters are 0', () => {
        const moves = extrusions(generateRegularToolpath(printer, [cubePart({ perimeters: 0 })]));
        expect(extrudedLength(moves, atZ(10))).toBeGreaterThan(0);
        expect(extrudedLength(moves, atZ(0.2))).toBeGreaterThan(900);
    });
});

describe('generateRegularToolpath with a through-hole', () => {
    const printer = new Printer();
    const holeRadius = 6;

    it.each([20, 100])('extrudes nothing inside the hole at %i %% infill', density => {
        const moves = extrusions(generateRegularToolpath(printer, [platePartWithHole(holeRadius, { infillDensity: density })]));
        expect(moves.length).toBeGreaterThan(0);

        const centre = new THREE.Vector2(100, 100);
        // The wall around the hole runs half a line width outside it; allow for the hole being a polygon.
        const clear = holeRadius + LINE_WIDTH / 2 - 0.05;
        let closest = Infinity;
        for (const move of moves) {
            // Sample along the move, so a line crossing the hole is caught even if its ends are outside.
            const steps = Math.max(1, Math.ceil(move.length / 0.25));
            for (let s = 0; s <= steps; s++) {
                const p = move.from.clone().lerp(move.to, s / steps);
                closest = Math.min(closest, centre.distanceTo(new THREE.Vector2(p.x, p.y)));
            }
        }
        expect(closest).toBeGreaterThan(clear);
        // ...and the hole does get its own wall, right next to it.
        expect(closest).toBeLessThan(holeRadius + LINE_WIDTH);
    });
});

describe('generateRegularToolpath on a stepped part', () => {
    const printer = new Printer();
    const moves = extrusions(generateRegularToolpath(printer, [steppedPart()]));

    /** How far a point is from the part's axis, measured the way a square grows. */
    const fromAxis = (x: number, y: number) => Math.max(Math.abs(x - 100), Math.abs(y - 100));
    /** On the shoulder: clear of the tower (half-width 5) and inside the base's perimeters. */
    const onShoulder = (x: number, y: number) => fromAxis(x, y) > 5.5 && fromAxis(x, y) < 8.5;
    /** Well under the tower. */
    const underTower = (x: number, y: number) => fromAxis(x, y) < 3.5;
    const lengthAt = (z: number, where: (x: number, y: number) => boolean) =>
        extrudedLengthInside(moves.filter(atZ(z)), where);

    it('prints the exposed shoulder solid for the top layers of the base', () => {
        const sparseShoulder = lengthAt(2.4, onShoulder);
        expect(sparseShoulder).toBeGreaterThan(0);
        // The base ends at z = 5: its last four layers are 4.4 to 5.0.
        for (const z of [4.4, 4.6, 4.8, 5.0]) {
            expect(lengthAt(z, onShoulder)).toBeGreaterThan(2.5 * sparseShoulder);
        }
        expect(lengthAt(4.2, onShoulder)).toBeLessThan(1.5 * sparseShoulder);
    });

    it('keeps the base sparse where the tower covers it', () => {
        const solidCentre = lengthAt(0.2, underTower);
        expect(lengthAt(5.0, underTower)).toBeLessThan(0.5 * solidCentre);
        expect(lengthAt(4.6, underTower)).toBeLessThan(0.5 * solidCentre);
    });

    it('does not treat the foot of the tower as a bottom surface, but closes its top', () => {
        const towerMiddle = extrudedLength(moves, atZ(10));
        expect(extrudedLength(moves, atZ(5.2))).toBeLessThan(1.5 * towerMiddle);
        expect(extrudedLength(moves, atZ(15))).toBeGreaterThan(2 * towerMiddle);
    });
});

describe('generateRegularToolpath with several parts', () => {
    it('interleaves two parts layer by layer', () => {
        const printer = new Printer();
        const path = generateRegularToolpath(printer, [
            boxPart(50, 100, 10, 10, 4),
            boxPart(150, 100, 10, 10, 4),
        ]);
        const moves = extrusions(path);
        const partOf = (move: Extrusion) => (move.to.x < 100 ? 0 : 1);

        // Collapse the extrusions into runs of (part, height).
        const runs: { part: number, z: number }[] = [];
        for (const move of moves) {
            const last = runs[runs.length - 1];
            if (!last || last.part !== partOf(move) || Math.abs(last.z - move.to.z) > 1e-4) {
                runs.push({ part: partOf(move), z: move.to.z });
            }
        }
        // 20 layers, each visiting both parts exactly once.
        expect(runs.length).toBe(40);
        for (let layer = 0; layer < 20; layer++) {
            const [first, second] = [runs[2 * layer], runs[2 * layer + 1]];
            expect(first.z).toBeCloseTo((layer + 1) * 0.2, 6);
            expect(second.z).toBeCloseTo((layer + 1) * 0.2, 6);
            expect(first.part).not.toBe(second.part);
        }
    });

    it('merges parts with different layer heights by height', () => {
        const printer = new Printer();
        const path = generateRegularToolpath(printer, [
            boxPart(50, 100, 10, 10, 3, { layerHeight: 0.2 }),
            boxPart(150, 100, 10, 10, 3, { layerHeight: 0.3 }),
        ]);
        const moves = extrusions(path);
        for (let i = 1; i < moves.length; i++) {
            expect(moves[i].to.z).toBeGreaterThanOrEqual(moves[i - 1].to.z - EPSILON);
        }
        const thin = moves.filter(move => move.to.x < 100);
        const thick = moves.filter(move => move.to.x > 100);
        expect(layerHeights(thin).length).toBe(15);
        expect(layerHeights(thick).length).toBe(10);
        expect(thin.every(move => move.point.layerHeight === 0.2)).toBe(true);
        expect(thick.every(move => move.point.layerHeight === 0.3)).toBe(true);
    });

    it('changes tool once per layer when two parts use different extruders', () => {
        const printer = new Printer();
        const path = generateRegularToolpath(printer, [
            boxPart(50, 100, 10, 10, 2, { extruder: 0 }),
            boxPart(150, 100, 10, 10, 2, { extruder: 1 }),
        ]);
        let changes = 0;
        for (let i = 1; i < path.length; i++) {
            if (path[i].extruder !== path[i - 1].extruder) changes++;
        }
        // 10 layers: one change within every layer, none between layers.
        expect(changes).toBe(10);
        const gcode = buildPrintGcode(printer, [path]);
        expect(gcode.split('; Change Tool').length - 1).toBe(10);
    });

    it('adds a part\'s offset to every point', () => {
        const printer = new Printer();
        const atOrigin: RegularPart = {
            mesh: new THREE.Mesh(new THREE.BoxGeometry(10, 10, 2).translate(0, 0, 1)),
            config: config(),
            offset: new THREE.Vector3(60, 70, 1),
        };
        const moves = extrusions(generateRegularToolpath(printer, [atOrigin]));
        expect(moves.length).toBeGreaterThan(0);
        for (const move of moves) {
            expect(Math.abs(move.to.x - 60)).toBeLessThanOrEqual(5);
            expect(Math.abs(move.to.y - 70)).toBeLessThanOrEqual(5);
        }
        expect(layerHeights(moves)[0]).toBeCloseTo(1.2, 6);
    });
});

describe('object, layer and feature tags', () => {
    const printer = new Printer();
    const toolpath = generateRegularToolpath(printer, [{ ...cubePart(), objectId: 5 }]);
    const extrusions = toolpath.filter(p => p.regularSegment);

    it('puts the object on every extrusion and on the travel between them', () => {
        expect(extrusions.length).toBeGreaterThan(0);
        expect(extrusions.every(p => p.objectId === 5)).toBe(true);
        // Only the approach moves that lift the head clear are nobody's.
        expect(toolpath.filter(p => p.travel && p.role === undefined).every(p => p.objectId === 5)).toBe(true);
        expect(toolpath.filter(p => p.role === 'approach').every(p => p.objectId === undefined)).toBe(true);
    });

    it('numbers the layers from 0 at the bottom', () => {
        // Layer n of a part standing on the bed prints at (n + 1) layer heights.
        extrusions.forEach(p => expect(p.point.z).toBeCloseTo((p.layer! + 1) * DEFAULT_REGULAR_CONFIG.layerHeight, 6));
        expect(Math.min(...extrusions.map(p => p.layer!))).toBe(0);
    });

    it('names the features as PrusaSlicer does', () => {
        expect(new Set(extrusions.map(p => p.feature))).toEqual(new Set([
            FEATURE.externalPerimeter, FEATURE.perimeter, FEATURE.solidInfill, FEATURE.internalInfill,
        ]));
        // The bottom layer is solid: walls and solid infill only.
        const bottom = new Set(extrusions.filter(p => p.layer === 0).map(p => p.feature));
        expect(bottom).toEqual(new Set([FEATURE.externalPerimeter, FEATURE.perimeter, FEATURE.solidInfill]));
    });
});

describe('generateRegularToolpath input checks', () => {
    const printer = new Printer();

    it.each([
        ['a zero layer height', { layerHeight: 0 }],
        ['a negative layer height', { layerHeight: -0.2 }],
        ['a NaN layer height', { layerHeight: NaN }],
        ['a layer taller than the nozzle', { layerHeight: 0.5 }],
        ['negative perimeters', { perimeters: -1 }],
        ['fractional perimeters', { perimeters: 1.5 }],
        ['a negative infill density', { infillDensity: -1 }],
        ['an infill density over 100', { infillDensity: 101 }],
        ['negative top/bottom layers', { topBottomLayers: -1 }],
        ['an extruder that does not exist', { extruder: 5 }],
        ['a zero print speed', { printSpeed: 0 }],
    ] as [string, Partial<RegularPrintConfig>][])('throws for %s', (_, overrides) => {
        expect(() => generateRegularToolpath(printer, [cubePart(overrides)])).toThrow(/Regular print settings/);
    });

    it('returns an empty toolpath when nothing is printable', () => {
        expect(generateRegularToolpath(printer, [])).toEqual([]);
        expect(generateRegularToolpath(printer, [{ mesh: new THREE.Mesh(new THREE.BufferGeometry()), config: config() }])).toEqual([]);
        expect(generateRegularToolpath(printer, [cubePart({ perimeters: 0, infillDensity: 0, topBottomLayers: 0 })])).toEqual([]);
    });

    it('does not modify the mesh or the config', () => {
        const part = cubePart();
        const before = Array.from(part.mesh.geometry.attributes.position.array);
        const configBefore = { ...part.config };
        generateRegularToolpath(printer, [part]);
        expect(Array.from(part.mesh.geometry.attributes.position.array)).toEqual(before);
        expect(part.config).toEqual(configBefore);
    });
});

describe('regular toolpath through the G-code pipeline', () => {
    it('gives G-code without NaN whose extrusion matches the toolpath', () => {
        const printer = new Printer();
        const path = generateRegularToolpath(printer, [cubePart()]);
        expect(validateToolpath(printer, path)).toEqual([]);

        const gcode = buildPrintGcode(printer, [path]);
        expect(gcode).not.toContain('NaN');
        expect(gcode).not.toContain('undefined');
        expect(gcode).not.toContain('Infinity');

        // The emitter runs in relative extrusion (M83): every extruding move pushes a positive amount.
        expect(gcode).toContain('M83');
        const moves = extrusions(path);
        const amounts = extrudedAmounts(gcode);
        expect(amounts.length).toBe(moves.length);
        expect(amounts.every(amount => Number.isFinite(amount) && amount > 0)).toBe(true);

        // Filament in = bead cross-section (line width x layer height) x length / filament cross-section.
        const filamentArea = Math.PI * (printer.diameter_filament / 2) ** 2;
        const expected = extrudedLength(moves) * LINE_WIDTH * 0.2 / filamentArea;
        const total = amounts.reduce((sum, amount) => sum + amount, 0);
        expect(total / expected).toBeCloseTo(1, 3);

        // Travel moves never extrude, and the only retractions are the pipeline's own (end G-code).
        for (const line of gcode.split('\n')) {
            if (line.startsWith('G0 ')) {
                expect(line).not.toMatch(/ E/);
            }
        }
        // Extrusion moves run at the print speed, travels at the extruder's travel speed.
        expect(gcode).toMatch(/^G1 X\S+ Y\S+ Z\S+ E\S+ F1800$/m);
        expect(gcode).not.toMatch(/^G1 X\S+ Y\S+ Z\S+ E\S+ F1000$/m);
    });

    it('puts about the volume of a solid cube through the nozzle at 100 % infill', () => {
        const printer = new Printer();
        const path = generateRegularToolpath(printer, [boxPart(100, 100, 20, 20, 4, { infillDensity: 100 })]);
        const filamentArea = Math.PI * (printer.diameter_filament / 2) ** 2;
        const total = extrudedAmounts(buildPrintGcode(printer, [path])).reduce((sum, amount) => sum + amount, 0);
        const volumeRatio = (total * filamentArea) / (20 * 20 * 4);
        expect(volumeRatio).toBeGreaterThan(0.9);
        expect(volumeRatio).toBeLessThan(1.15);
    });

    it('is rejected by the bounds check when the part hangs off the bed', () => {
        const printer = new Printer();
        const path = generateRegularToolpath(printer, [boxPart(5, 100, 20, 20, 2)]);
        expect(() => buildPrintGcode(printer, [path])).toThrow(/not safe to print/);
    });
});

describe('PathPoint.speed in the G-code emitter', () => {
    const segment = (extra: Partial<PathPoint>): PathPoint[] => [
        { point: new THREE.Vector3(10, 10, 0.2), travel: true, extruder: 0 },
        { point: new THREE.Vector3(20, 10, 0.2), regularSegment: true, extruder: 0, ...extra },
    ];

    it('keeps the extruder\'s travel speed for regular segments without a speed', () => {
        const printer = new Printer();
        expect(printer.generate_foam_gcode(segment({}))).toMatch(/^G1 X20\.000000 .* F1000$/m);
    });

    it('uses the point\'s speed for a regular segment that has one', () => {
        const printer = new Printer();
        const gcode = printer.generate_foam_gcode(segment({ speed: 2400 }));
        expect(gcode).toMatch(/^G1 X20\.000000 .* F2400$/m);
        // The amount extruded does not depend on the speed.
        const amount = (text: string) => /E(\S+)/.exec(text.split('\n').find(line => line.startsWith('G1 X20'))!)![1];
        expect(amount(gcode)).toBe(amount(printer.generate_foam_gcode(segment({}))));
    });

    it('reports a speed that is not a positive number', () => {
        const printer = new Printer();
        expect(validateToolpath(printer, segment({ speed: 0 })).join(' ')).toMatch(/Speed must be a positive number/);
        expect(validateToolpath(printer, segment({ speed: NaN })).join(' ')).toMatch(/Speed must be a positive number/);
        expect(validateToolpath(printer, segment({ speed: 1800 }))).toEqual([]);
    });
});

describe('helpers shared with the foam generator', () => {
    /** A 20 mm foam cube at (100, 100), with just enough of a model around it to be sliced. */
    const foamModel = (): EverydayModel => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20).translate(0, 0, 10), new THREE.MeshBasicMaterial());
        mesh.position.set(100, 100, 0);
        const toolpathConfig = {
            deltaZ: 1.7, hStar: 6, hStarEnd: 6, vStar: 0.15, vStarEnd: 0.15, deltaL: 1.7, deltaLEnd: 1.7,
            senseDeltaZ: 1.7, senseHStar: 6, senseHStarEnd: 6, senseVStar: 0.15, SenseVStarEnd: 0.15,
            senseDeltaL: 1.7, senseDeltaLEnd: 1.7,
            gridSize: 4, initialFoamLayerCount: 0, middleSenseLayerCount: 0, finalFoamLayerCount: 0,
            edot: 50, senseEdot: 50, bumpSpacingX: 10, bumpSpacingY: 10, bumpScale: 1, generateBumps: false,
            curveAugment: false, steepnessThreshold: 60, flatLayerZOffset: 3, additionalCurveLayers: 0,
        };
        return {
            name: 'foam cube',
            mesh,
            geometry: mesh.geometry,
            gradient: { width: 1, height: 1, sampleColor: () => ({ r: 255, g: 255, b: 255, a: 255 }) },
            toolpathConfig,
            initialConfig: { ...toolpathConfig },
            initialOffset: 0,
        } as unknown as EverydayModel;
    };
    const visualizer = (printer: Printer) => ({ scene: new THREE.Scene(), printer, config: {} }) as unknown as Visualizer;
    const hasPurgeLine = (path: PathPoint[]) => path.some(point => point.role === 'purgeLine');

    it('lets generateFoamToolpath skip its purge line, and follows the printer by default', () => {
        const printer = new Printer();
        expect(printer.purgeLine).toBe(true);
        const withDefault = generateFoamToolpath(visualizer(printer), [foamModel()]);
        const withEmptyOptions = generateFoamToolpath(visualizer(printer), [foamModel()], {});
        const without = generateFoamToolpath(visualizer(printer), [foamModel()], { purgeLine: false });

        expect(hasPurgeLine(withDefault)).toBe(true);
        expect(withEmptyOptions.length).toBe(withDefault.length);
        expect(hasPurgeLine(without)).toBe(false);
        // Nothing but the purge line is left out.
        expect(without.length).toBe(withDefault.filter(point => point.role !== 'purgeLine').length);

        printer.purgeLine = false;
        expect(hasPurgeLine(generateFoamToolpath(visualizer(printer), [foamModel()]))).toBe(false);
    });

    it('combines a purge line, a regular toolpath and a foam toolpath into one printable file', () => {
        const printer = new Printer();
        const regular = [
            ...makePurgeLine(printer),
            ...generateRegularToolpath(printer, [boxPart(40, 100, 10, 10, 2)]),
        ];
        const foam = generateFoamToolpath(visualizer(printer), [foamModel()], { purgeLine: false });
        const gcode = buildPrintGcode(printer, [regular, foam]);

        expect(gcode).not.toContain('NaN');
        expect(gcode.split('lift off the purge line').length - 1).toBe(1);
        expect(gcode.split('G28 XY').length - 1).toBe(1);
    });

    it('exports getTransformedMesh, which bakes rotation and scale but not position', () => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
        mesh.position.set(100, 50, 5);
        mesh.scale.set(2, 1, 1);
        const transformed = getTransformedMesh(mesh);
        transformed.geometry.computeBoundingBox();
        const box = transformed.geometry.boundingBox!;
        expect(box.min.x).toBeCloseTo(-10, 6);
        expect(box.max.x).toBeCloseTo(10, 6);
        expect(box.min.z).toBeCloseTo(-5, 6);
        // The position has to be passed on as the part's offset.
        const moves = extrusions(generateRegularToolpath(new Printer(), [
            { mesh: transformed, config: config(), offset: mesh.position.clone() },
        ]));
        expect(moves.every(move => Math.abs(move.to.x - 100) <= 10 && Math.abs(move.to.y - 50) <= 5)).toBe(true);
        expect(layerHeights(moves)[0]).toBeCloseTo(0.2, 6);
    });

    it('exports visualizeToolpath, which draws a regular toolpath without a scene', () => {
        const printer = new Printer();
        const group = new THREE.Group();
        visualizeToolpath(generateRegularToolpath(printer, [boxPart(40, 100, 10, 10, 1)]), group, printer.extruders.map(e => e.color), 0x7f8fa6);
        expect(group.children.length).toBeGreaterThan(0);
    });
});
