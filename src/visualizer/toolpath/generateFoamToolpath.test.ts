import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import Printer from '../../printer/Printer';
import type Visualizer from '../Visualizer';
import type { EverydayModel, PointCloudPoint, ToolpathConfig } from '../types/modelTypes';
import { FEATURE, type PathPoint } from './pathTypes';
import { generateAugmentFoamToolpath, generateFoamToolpath } from './generateFoamToolpath';
import { buildPrintGcode, getPurgeTowerHeight } from './buildGcode';
import { sampleSelectedMesh } from './sampleSelectedMesh';
import { pointInsideSensing } from './addSensingIntersectionGeo';
import { DEFAULT_REGULAR_CONFIG } from './regularSlicer';

/** Just enough of a Visualizer for the toolpath generators: a scene to draw into and a printer. */
function fakeVisualizer(printer: Printer = new Printer()): Visualizer {
    return { scene: new THREE.Scene(), printer, config: {} } as unknown as Visualizer;
}

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

/** A 40 x 40 x 10 mm block at (100, 100) with a flat 32 x 32 mm area sampled on its top. */
function blockModel(config: Partial<ToolpathConfig> = {}, initial: Partial<ToolpathConfig> = {}): EverydayModel {
    const geometry = new THREE.BoxGeometry(40, 40, 10).translate(0, 0, 5);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.position.set(100, 100, 0);

    const samplePoints: PointCloudPoint[] = [];
    for (let x = -16; x <= 16; x += 4) {
        for (let y = -16; y <= 16; y += 4) {
            samplePoints.push({ point: new THREE.Vector3(x, y, 10), type: 'foam' });
        }
    }

    return {
        objectId: 1,
        kind: 'augment',
        regularConfig: { ...DEFAULT_REGULAR_CONFIG },
        name: 'block',
        mesh,
        geometry,
        transformType: 'move',
        transformX: { x: 0 }, transformY: { y: 0 }, transformZ: { z: 0 },
        gradient: { width: 1, height: 1, sampleColor: () => ({ r: 255, g: 255, b: 255, a: 255 }) },
        toolpathConfig: toolpathConfig(config),
        initialConfig: toolpathConfig({ initialFoamLayerCount: 0, ...initial }),
        initialOffset: 0,
        toolpathSamplePoints: samplePoints,
    };
}

const isFinitePoint = (p: PathPoint) => Number.isFinite(p.point.x) && Number.isFinite(p.point.y) && Number.isFinite(p.point.z);
const isModelExtrusion = (p: PathPoint) => p.role === undefined && !p.travel;

describe('generateAugmentFoamToolpath', () => {
    it('produces a printable toolpath with a purge tower placed from the printer config', () => {
        const printer = new Printer();
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(printer), blockModel())!;

        expect(toolpath).not.toBeNull();
        expect(toolpath.every(isFinitePoint)).toBe(true);
        expect(toolpath[0].role).toBe('purgeLine');

        const tower = toolpath.filter(p => p.role === 'purgeTower');
        expect(tower.length).toBeGreaterThan(0);
        const center = printer.purgeTowerCenter();
        tower.forEach(p => {
            expect(Math.hypot(p.point.x - center.x, p.point.y - center.y)).toBeLessThanOrEqual(printer.purgeTowerRadius + 1e-6);
        });

        // Three layers of foam on top of the block: 10 + layer * 1.7 + H* d.
        const foamZ = [...new Set(toolpath.filter(isModelExtrusion).map(p => p.point.z.toFixed(3)))].map(Number).sort((a, b) => a - b);
        expect(foamZ).toEqual([12.4, 14.1, 15.8]);

        const gcode = buildPrintGcode(printer, [toolpath]);
        expect(gcode).not.toMatch(/NaN|Infinity|undefined/);
    });

    it('crosses the bed above the model on its way to where the print starts', () => {
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(), blockModel())!;
        const safeZ = 10 + 10; // top of the block plus the travel clearance
        const firstPrinted = toolpath.findIndex(p => !p.travel && p.role !== 'purgeLine');
        const firstTarget = toolpath[firstPrinted].point;
        const leadIn = toolpath.slice(0, firstPrinted).filter(p => p.role !== 'purgeLine');

        expect(leadIn.length).toBeGreaterThan(2);
        leadIn.forEach(p => {
            // Either up at the safe height, or already coming straight down next to where printing starts.
            const nearTarget = Math.hypot(p.point.x - firstTarget.x, p.point.y - firstTarget.y) < 1;
            expect(p.point.z >= safeZ - 1e-6 || nearTarget).toBe(true);
        });

        // A later model is told to stay above what was printed before it.
        const later = generateAugmentFoamToolpath(fakeVisualizer(), blockModel(), { minimumSafeZ: 60 })!;
        const laterFirstPrinted = later.findIndex(p => !p.travel && p.role !== 'purgeLine');
        const laterTarget = later[laterFirstPrinted].point;
        later.slice(0, laterFirstPrinted).filter(p => p.role !== 'purgeLine').forEach(p => {
            const nearTarget = Math.hypot(p.point.x - laterTarget.x, p.point.y - laterTarget.y) < 1;
            expect(p.point.z >= 60 - 1e-6 || nearTarget).toBe(true);
        });
    });

    it('moves the purge tower and purge line with the bed size', () => {
        const printer = new Printer();
        printer.machine_depth = 300;
        printer.machine_depth_y = 300;
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(printer), blockModel())!;

        const tower = toolpath.filter(p => p.role === 'purgeTower');
        const towerX = tower.map(p => p.point.x);
        expect(Math.min(...towerX)).toBeGreaterThan(270);
        expect(Math.max(...towerX)).toBeLessThanOrEqual(295 + 1e-6);

        const purgeX = toolpath.filter(p => p.role === 'purgeLine').map(p => p.point.x);
        expect(Math.min(...purgeX)).toBeCloseTo(5, 6);
        expect(Math.max(...purgeX)).toBeCloseTo(295, 6);
    });

    it('has no NaN with curve augment and a single layer (G3)', () => {
        const printer = new Printer();
        const model = blockModel({ curveAugment: true, initialFoamLayerCount: 1 });
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(printer), model)!;

        expect(toolpath).not.toBeNull();
        expect(toolpath.every(isFinitePoint)).toBe(true);
        expect(buildPrintGcode(printer, [toolpath])).not.toMatch(/NaN/);
    });

    it('prints the extra flat layers of a curve augment instead of travelling them (G7)', () => {
        const model = blockModel({ curveAugment: true, initialFoamLayerCount: 2 });
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(), model)!;

        // Two stacked layers plus three flat ones on top, each with real extrusions.
        const layerZ = [...new Set(toolpath.filter(isModelExtrusion).map(p => p.point.z.toFixed(3)))].map(Number).sort((a, b) => a - b);
        expect(layerZ.length).toBe(5);
        expect(layerZ[4] - layerZ[1]).toBeCloseTo(3 * 1.7, 6);
        for (const z of layerZ) {
            const extrusions = toolpath.filter(p => isModelExtrusion(p) && Math.abs(p.point.z - z) < 1e-3);
            expect(extrusions.length).toBeGreaterThan(10);
        }
        // The tower is taller than the model at times, but none of it is copied into the flat layers.
        const topZ = layerZ[4];
        expect(toolpath.filter(p => p.point.z > topZ + 1e-6 && !p.travel && p.role === undefined)).toEqual([]);
    });

    it('lets a vertical H* gradient change the layer heights (G8)', () => {
        const model = blockModel({ hStar: 6, hStarEnd: 9, initialFoamLayerCount: 3 });
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(), model)!;
        const extrusions = toolpath.filter(isModelExtrusion);

        const byHStar = new Map<string, Set<string>>();
        extrusions.forEach(p => {
            const key = p.hStar!.toFixed(3);
            if (!byHStar.has(key)) byHStar.set(key, new Set());
            byHStar.get(key)!.add(p.point.z.toFixed(3));
        });

        // Bottom layer H* = 6, middle 7.5, top 9, and each layer's Z follows its own H*.
        expect([...byHStar.keys()].sort()).toEqual(['6.000', '7.500', '9.000']);
        expect([...byHStar.get('6.000')!]).toEqual([(10 + 6 * 0.4).toFixed(3)]);
        expect([...byHStar.get('7.500')!]).toEqual([(10 + 1.7 + 7.5 * 0.4).toFixed(3)]);
        expect([...byHStar.get('9.000')!]).toEqual([(10 + 3.4 + 9 * 0.4).toFixed(3)]);
    });

    it('continues the purge tower from the height an earlier model left it at', () => {
        const printer = new Printer();
        const visualizer = fakeVisualizer(printer);
        const first = generateAugmentFoamToolpath(visualizer, blockModel())!;
        const firstTowerHeight = getPurgeTowerHeight(first);
        expect(firstTowerHeight).toBeGreaterThan(0);

        const second = generateAugmentFoamToolpath(visualizer, blockModel({ initialFoamLayerCount: 5 }), { purgeTowerStartHeight: firstTowerHeight })!;
        const secondTower = second.filter(p => p.role === 'purgeTower');
        expect(secondTower.length).toBeGreaterThan(0);
        secondTower.forEach(p => expect(p.point.z).toBeGreaterThan(firstTowerHeight));

        // Together they make one valid print with a single purge line.
        const gcode = buildPrintGcode(printer, [first, second]);
        expect(gcode.split('lift off the purge line').length - 1).toBe(1);
    });

    it('marks the initial layers so the emitter can ask for the material swap (G2)', () => {
        const model = blockModel({ initialFoamLayerCount: 2 }, { initialFoamLayerCount: 1 });
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(), model)!;
        const extrusions = toolpath.filter(isModelExtrusion);
        const lowestZ = Math.min(...extrusions.map(p => p.point.z));

        extrusions.forEach(p => {
            expect(p.initialMaterial).toBe(Math.abs(p.point.z - lowestZ) < 1e-6);
        });
    });

    it('cuts the initial layers at the initial offset contour (G9)', () => {
        const model = blockModel({ initialFoamLayerCount: 1 }, { initialFoamLayerCount: 1 });
        model.initialOffset = -4; // 4 mm inwards
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(), model)!;
        const extrusions = toolpath.filter(isModelExtrusion);

        const reach = (points: PathPoint[]) => Math.max(...points.map(p => Math.max(Math.abs(p.point.x - 100), Math.abs(p.point.y - 100))));
        const initialReach = reach(extrusions.filter(p => p.initialMaterial === true));
        const mainReach = reach(extrusions.filter(p => p.initialMaterial === false));

        // The sampled area reaches 16 mm from the centre; the initial layer stops 4 mm short of that.
        expect(mainReach).toBeGreaterThan(15);
        expect(initialReach).toBeLessThanOrEqual(mainReach - 4 + 0.5);
        expect(initialReach).toBeGreaterThan(mainReach - 4 - 2);
    });

    it('returns null instead of crashing when there is nothing to print (G6)', () => {
        const visualizer = fakeVisualizer();
        const noPoints = blockModel();
        noPoints.toolpathSamplePoints = [];
        expect(generateAugmentFoamToolpath(visualizer, noPoints)).toBeNull();

        const twoPoints = blockModel();
        twoPoints.toolpathSamplePoints = twoPoints.toolpathSamplePoints!.slice(0, 2);
        expect(generateAugmentFoamToolpath(visualizer, twoPoints)).toBeNull();
    });

    it('throws a readable error for a layer thickness of 0 instead of hanging (G13)', () => {
        expect(() => generateAugmentFoamToolpath(fakeVisualizer(), blockModel({ deltaZ: 0 }))).toThrow(/Layer thickness/);
        expect(() => generateAugmentFoamToolpath(fakeVisualizer(), blockModel({ deltaL: 0, deltaLEnd: 0 }))).toThrow(/Line spacing/);
    });
});

describe('generateFoamToolpath (Slice Plate)', () => {
    it('returns an empty toolpath for an empty plate (G6)', () => {
        expect(generateFoamToolpath(fakeVisualizer(), [])).toEqual([]);
    });

    it('throws a readable error for a layer thickness of 0 instead of hanging (G13)', () => {
        expect(() => generateFoamToolpath(fakeVisualizer(), [blockModel({ deltaZ: 0 })])).toThrow(/Layer thickness/);
    });

    it('counts layers from the bottom of the mesh as it is placed, not of its raw geometry (G10)', () => {
        // Flipped upside down, the block spans z = -10..0 although its raw geometry spans 0..10.
        const model = blockModel({}, { initialFoamLayerCount: 1 });
        model.mesh.rotation.x = Math.PI;
        const toolpath = generateFoamToolpath(fakeVisualizer(), [model]);
        const foam = toolpath.filter(p => p.role === undefined && !p.travel && !p.regularSegment && !p.ironing);

        expect(foam.length).toBeGreaterThan(0);
        const lowestZ = Math.min(...foam.map(p => p.point.z));
        const initial = foam.filter(p => p.initialMaterial === true);
        const main = foam.filter(p => p.initialMaterial === false);
        // Exactly the first layer is an initial layer; everything above it is not.
        expect(initial.length).toBeGreaterThan(0);
        expect(main.length).toBeGreaterThan(0);
        initial.forEach(p => expect(p.point.z).toBeCloseTo(lowestZ, 6));
        main.forEach(p => expect(p.point.z).toBeGreaterThan(lowestZ + 1));
    });

    it('slices a block into a printable toolpath', () => {
        const printer = new Printer();
        const toolpath = generateFoamToolpath(fakeVisualizer(printer), [blockModel()]);

        expect(toolpath.length).toBeGreaterThan(0);
        expect(toolpath.every(isFinitePoint)).toBe(true);
        const gcode = buildPrintGcode(printer, [toolpath]);
        expect(gcode).not.toMatch(/NaN|Infinity|undefined/);
    });
});

describe('object, layer and feature tags', () => {
    it('tags an augmentation by object and by layer of its stack, counted from 0', () => {
        const model = { ...blockModel({ initialFoamLayerCount: 2 }, { initialFoamLayerCount: 1 }), objectId: 7 };
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(), model)!;
        const extrusions = toolpath.filter(isModelExtrusion);

        expect(extrusions.every(p => p.objectId === 7)).toBe(true);
        // Three layers (2 foam + 1 initial), each at its own height: layer n is the n-th lowest.
        const heights = [...new Set(extrusions.map(p => p.point.z.toFixed(3)))].map(Number).sort((a, b) => a - b);
        expect(heights).toHaveLength(3);
        extrusions.forEach(p => {
            expect(p.layer).toBe(heights.findIndex(z => Math.abs(z - p.point.z) < 1e-3));
            expect(p.feature).toBe(p.layer === 0 ? FEATURE.initialFoam : FEATURE.foam);
        });

        // The purge line and tower belong to no object.
        const helpers = toolpath.filter(p => p.role === 'purgeTower' || p.role === 'purgeLine');
        expect(helpers.length).toBeGreaterThan(0);
        expect(helpers.every(p => p.objectId === undefined && p.feature === undefined)).toBe(true);
    });

    it('counts the extra flat layers of a curve augment on from the stack', () => {
        const model = { ...blockModel({ curveAugment: true, initialFoamLayerCount: 2 }), objectId: 3 };
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(), model)!;
        const layers = [...new Set(toolpath.filter(isModelExtrusion).map(p => p.layer))].sort();
        expect(layers).toEqual([0, 1, 2, 3, 4]);
    });

    it('tags a foam print, its shell and its boundary', () => {
        const printer = new Printer();
        printer.generateBoundary = true;
        const model = { ...blockModel(), objectId: 12 };
        const toolpath = generateFoamToolpath(fakeVisualizer(printer), [model]);

        const extrusions = toolpath.filter(isModelExtrusion);
        expect(extrusions.length).toBeGreaterThan(0);
        expect(extrusions.every(p => p.objectId === 12 && p.layer !== undefined && p.layer >= 0)).toBe(true);
        const features = new Set(extrusions.map(p => p.feature));
        expect(features).toContain(FEATURE.foam);
        expect(features).toContain(FEATURE.shell);
        expect([...features].every(f => Object.values(FEATURE).includes(f as never))).toBe(true);
        // A 10 mm block in 1.7 mm layers: the first layer is 0 and none is skipped.
        const layers = [...new Set(extrusions.map(p => p.layer!))].sort((a, b) => a - b);
        expect(layers[0]).toBe(0);
        expect(layers).toEqual(layers.map((_, i) => i));

        const boundary = toolpath.filter(p => p.role === 'boundary');
        expect(boundary.length).toBeGreaterThan(0);
        expect(boundary.every(p => p.objectId === 12)).toBe(true);
    });
});

describe('sampleSelectedMesh', () => {
    /** A model whose selected foam area is a 10 x 10 mm square facing up at z = 5. */
    function selectionModel(gridSize: number, scale = 1): EverydayModel {
        const model = blockModel({ gridSize });
        model.mesh.scale.setScalar(scale);
        model.selectedRegularFoamMesh = new THREE.Mesh(new THREE.PlaneGeometry(10, 10).translate(0, 0, 5));
        return model;
    }

    it('samples a grid over the selection', () => {
        const model = selectionModel(2);
        sampleSelectedMesh(fakeVisualizer(), model);
        const points = model.toolpathSamplePoints!;
        expect(points.length).toBeGreaterThanOrEqual(25);
        points.forEach(p => {
            expect(p.type).toBe('foam');
            expect(p.point.z).toBeCloseTo(5, 6);
        });
    });

    it('applies the model scale once, however often the selection is sampled (G11)', () => {
        const model = selectionModel(2, 2);
        const visualizer = fakeVisualizer();
        const extentOf = () => Math.max(...model.toolpathSamplePoints!.map(p => Math.abs(p.point.x)));

        sampleSelectedMesh(visualizer, model);
        const firstCount = model.toolpathSamplePoints!.length;
        const firstExtent = extentOf();
        sampleSelectedMesh(visualizer, model);
        sampleSelectedMesh(visualizer, model);

        expect(firstExtent).toBeLessThanOrEqual(10 + 1e-6);
        expect(firstExtent).toBeGreaterThan(5);
        expect(model.toolpathSamplePoints!.length).toBe(firstCount);
        expect(extentOf()).toBe(firstExtent);
        // The selected mesh itself is untouched.
        model.selectedRegularFoamMesh!.geometry.computeBoundingBox();
        expect(model.selectedRegularFoamMesh!.geometry.boundingBox!.max.x).toBeCloseTo(5, 6);
    });

    it('transforms the sense selection too (G11)', () => {
        const model = selectionModel(2, 2);
        // The sense area covers the +x half of the foam area.
        model.selectedSenseFoamMesh = new THREE.Mesh(new THREE.PlaneGeometry(5, 10).translate(2.5, 0, 5));
        sampleSelectedMesh(fakeVisualizer(), model);

        const sense = model.toolpathSamplePoints!.filter(p => p.type === 'sense');
        expect(sense.length).toBeGreaterThan(0);
        // Scaled by 2 like the foam area: it reaches out to x = 10, not 5.
        expect(Math.max(...sense.map(p => p.point.x))).toBeGreaterThan(5);
        sense.forEach(p => expect(p.point.x).toBeGreaterThanOrEqual(-1e-6));
    });

    it('throws for a grid size of 0 instead of looping forever (G13)', () => {
        expect(() => sampleSelectedMesh(fakeVisualizer(), selectionModel(0))).toThrow(/Grid size/);
        expect(() => sampleSelectedMesh(fakeVisualizer(), selectionModel(-1))).toThrow(/Grid size/);
    });

    it('leaves no sample points when no foam area is selected (G6)', () => {
        const model = blockModel();
        model.selectedSenseFoamMesh = new THREE.Mesh(new THREE.PlaneGeometry(5, 5));
        expect(() => sampleSelectedMesh(fakeVisualizer(), model)).not.toThrow();
        expect(model.toolpathSamplePoints).toEqual([]);
    });
});

describe('pointInsideSensing (G15)', () => {
    it('treats a cylinder as running along its local Y axis', () => {
        const size = 10;
        const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(size / 2, size / 2, size, 16));
        cylinder.updateMatrixWorld();

        // Inside along the axis, outside beyond its ends.
        expect(pointInsideSensing(new THREE.Vector3(0, 4.9, 0), cylinder, 'cylinder', size)).toBe(true);
        expect(pointInsideSensing(new THREE.Vector3(0, 5.1, 0), cylinder, 'cylinder', size)).toBe(false);
        // Radially: a corner of the bounding box is outside the round cross-section.
        expect(pointInsideSensing(new THREE.Vector3(4.9, 0, 0), cylinder, 'cylinder', size)).toBe(true);
        expect(pointInsideSensing(new THREE.Vector3(4, 0, 4), cylinder, 'cylinder', size)).toBe(false);
        expect(pointInsideSensing(new THREE.Vector3(4, 4, 0), cylinder, 'cylinder', size)).toBe(true);
    });
});

/** A model like blockModel, with its own sample points. */
function sampledModel(samplePoints: PointCloudPoint[], config: Partial<ToolpathConfig> = {}, initial: Partial<ToolpathConfig> = {}): EverydayModel {
    const model = blockModel(config, initial);
    model.toolpathSamplePoints = samplePoints;
    return model;
}

/** Sample points on a square grid over [-half, half]², where `keep` says so. */
function gridSamples(
    half: number,
    step: number,
    keep: (x: number, y: number) => boolean = () => true,
    type: (x: number, y: number) => string = () => 'foam',
    z: (x: number, y: number) => number = () => 10,
): PointCloudPoint[] {
    const points: PointCloudPoint[] = [];
    for (let x = -half; x <= half; x += step) {
        for (let y = -half; y <= half; y += step) {
            if (keep(x, y)) points.push({ point: new THREE.Vector3(x, y, z(x, y)), type: type(x, y) });
        }
    }
    return points;
}

/** A printer with no purge line or tower, so a toolpath is only the model. */
function barePrinter(): Printer {
    const printer = new Printer();
    printer.purgeTower = false;
    printer.purgeLine = false;
    return printer;
}

describe('scan lines through the corners of an outline', () => {
    it('fills a round selection whose outline has corners exactly on the scan lines', () => {
        // Every corner of a sampled outline is on the sampling grid. With a 1 mm grid and a line
        // spacing that divides the width, scan lines run through corners and along edges.
        for (const [radius, deltaL] of [[10, 1], [10, 2], [17, 1.7]]) {
            const samples = gridSamples(radius, 1, (x, y) => x * x + y * y <= radius * radius);
            const model = sampledModel(samples, { deltaL, deltaLEnd: deltaL, gridSize: 1 });
            const toolpath = generateAugmentFoamToolpath(fakeVisualizer(barePrinter()), model)!;
            expect(toolpath).not.toBeNull();
            const extruded = toolpath.filter(isModelExtrusion);
            expect(extruded.length).toBeGreaterThan(0);
            // Nothing is printed outside the selection.
            extruded.forEach(p => {
                expect(Math.hypot(p.point.x - 100, p.point.y - 100)).toBeLessThanOrEqual(radius + 1e-6);
            });
        }
    });
});

describe('sensing areas and coarse grids', () => {
    it('does not lay foam over a small sensing area', () => {
        const inPatch = (x: number, y: number) => Math.abs(x) <= 3 && Math.abs(y) <= 3;
        const samples = gridSamples(15, 1, () => true, (x, y) => (inPatch(x, y) ? 'sense' : 'foam'));
        const model = sampledModel(samples, { gridSize: 1, initialFoamLayerCount: 1 });
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(barePrinter()), model)!;

        // Well inside the 7 mm patch only the sensing extruder prints.
        const inside = toolpath.filter(isModelExtrusion)
            .filter(p => Math.abs(p.point.x - 100) < 2.5 && Math.abs(p.point.y - 100) < 2.5);
        expect(inside.length).toBeGreaterThan(0);
        inside.forEach(p => expect(p.feature).toBe(FEATURE.sensingFoam));
        // ... and the foam around it is still there.
        expect(toolpath.some(p => isModelExtrusion(p) && p.feature === FEATURE.foam)).toBe(true);
    });

    it('still finds the area on a grid coarser than the usual outline radius', () => {
        const model = sampledModel(gridSamples(16, 8), { gridSize: 8, initialFoamLayerCount: 1 });
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(barePrinter()), model);
        expect(toolpath).not.toBeNull();
        expect(toolpath!.some(isModelExtrusion)).toBe(true);
    });

    it('numbers the layers of a sensing area by the layer thickness of the model, not its own', () => {
        const inPatch = (x: number, y: number) => Math.abs(x) <= 8 && Math.abs(y) <= 8;
        const samples = gridSamples(20, 1, () => true, (x, y) => (inPatch(x, y) ? 'sense' : 'foam'));
        const model = sampledModel(samples, { gridSize: 1, initialFoamLayerCount: 3, senseDeltaZ: 3.4 });
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(barePrinter()), model)!;
        const senseLayers = new Set(toolpath.filter(p => p.feature === FEATURE.sensingFoam).map(p => p.layer));
        expect([...senseLayers].sort()).toEqual([0, 1, 2]);
    });
});

describe('line spacing ramp and extra flat layers', () => {
    it('ramps the line spacing over the stack of layers, reaching the end value on the top one', () => {
        const model = sampledModel(gridSamples(16, 1), { deltaL: 1.7, deltaLEnd: 3.4, gridSize: 1, initialFoamLayerCount: 3 });
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(barePrinter()), model)!;
        const spacingOf = (layer: number) => {
            const points = toolpath.filter(p => isModelExtrusion(p) && p.layer === layer);
            const distinct = (values: number[]) => [...new Set(values.map(v => v.toFixed(3)))].map(Number).sort((a, b) => a - b);
            const xs = distinct(points.map(p => p.point.x));
            const ys = distinct(points.map(p => p.point.y));
            const lines = xs.length < ys.length ? xs : ys;
            return lines[1] - lines[0];
        };
        expect(spacingOf(0)).toBeCloseTo(1.7, 3);
        expect(spacingOf(1)).toBeCloseTo(2.55, 3);
        expect(spacingOf(2)).toBeCloseTo(3.4, 3);
    });

    it('copies the whole top layer for the extra flat layers of a curve augment on a dome', () => {
        const dome = (x: number, y: number) => 10 + 5 * (1 - (x * x + y * y) / 512);
        const samples = gridSamples(16, 2, () => true, () => 'foam', dome);
        const model = sampledModel(samples, { curveAugment: true, initialFoamLayerCount: 1, gridSize: 2 });
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(barePrinter()), model)!;
        const perLayer = new Map<number, number>();
        toolpath.filter(isModelExtrusion).forEach(p => perLayer.set(p.layer!, (perLayer.get(p.layer!) ?? 0) + 1));

        // One real layer and three copies of it, each about as many points as the original.
        expect([...perLayer.keys()].sort()).toEqual([0, 1, 2, 3]);
        for (const layer of [1, 2, 3]) {
            expect(perLayer.get(layer)!).toBeGreaterThan(perLayer.get(0)! * 0.9);
        }
        // Each copy is one layer thickness above the layer below it, point for point.
        const layer0 = toolpath.filter(p => p.role === undefined && p.layer === 0);
        const layer1 = toolpath.filter(p => p.role === undefined && p.layer === 1);
        expect(layer1).toHaveLength(layer0.length);
        layer1.forEach((p, i) => expect(p.point.z).toBeCloseTo(layer0[i].point.z + 1.7, 6));
        // Nothing is extruded on the way back to where a copy starts.
        expect(layer1[0].travel).toBe(true);
    });

    /** The block model with a 4 x 4 x 3.4 mm bump model: two layers of bump every 10 mm. */
    function bumpyModel(config: Partial<ToolpathConfig>): EverydayModel {
        const model = blockModel({ generateBumps: true, initialFoamLayerCount: 2, ...config });
        model.bumpMesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 3.4).translate(0, 0, 1.7), new THREE.MeshBasicMaterial());
        return model;
    }
    const zRange = (points: PathPoint[]) => ({
        min: Math.min(...points.map(p => p.point.z)),
        max: Math.max(...points.map(p => p.point.z)),
    });

    it('puts bumps right on top of a stack that has no extra flat layers', () => {
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(barePrinter()), bumpyModel({}))!;
        const printed = toolpath.filter(isModelExtrusion);
        const stackTop = zRange(printed.filter(p => p.layer === 1));
        const bumps = printed.filter(p => p.layer! >= 2);

        expect(bumps.length).toBeGreaterThan(0);
        expect(zRange(bumps).min).toBeCloseTo(stackTop.max + 1.7, 6);
    });

    it('prints the bumps of a curve augment above its extra flat layers, and after them', () => {
        // With the purge tower, so the moves to and from it are checked as well.
        const printer = new Printer();
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(printer), bumpyModel({ curveAugment: true }))!;
        const printed = toolpath.filter(isModelExtrusion);
        const layerOf = (layer: number) => printed.filter(p => p.layer === layer);

        // Two layers of stack, three extra flat layers, and the bumps from there up.
        const flatTop = zRange(layerOf(4));
        const bumps = printed.filter(p => p.layer! >= 5);
        expect(layerOf(2).length).toBe(layerOf(1).length);
        expect(bumps.length).toBeGreaterThan(0);
        expect(bumps.length).toBeLessThan(layerOf(1).length);
        expect(flatTop.max).toBeCloseTo(zRange(layerOf(1)).max + 3 * 1.7, 6);
        expect(zRange(bumps).min).toBeCloseTo(flatTop.max + 1.7, 6);

        // No layer number is shared between a flat layer and a bump: each one is at one height.
        for (const layer of new Set(printed.map(p => p.layer!))) {
            const { min, max } = zRange(layerOf(layer));
            expect(max - min).toBeLessThan(1e-6);
        }

        // The flat layers are all down before the first bump, and from then on the head never
        // comes back below the top one while it is over the area.
        const lastFlat = toolpath.lastIndexOf(layerOf(4)[layerOf(4).length - 1]);
        const firstBump = toolpath.indexOf(bumps[0]);
        expect(lastFlat).toBeLessThan(firstBump);
        toolpath.slice(lastFlat).forEach(p => {
            const overArea = Math.abs(p.point.x - 100) <= 16 && Math.abs(p.point.y - 100) <= 16;
            if (overArea) expect(p.point.z).toBeGreaterThanOrEqual(flatTop.max - 1e-6);
        });

        expect(toolpath.every(isFinitePoint)).toBe(true);
        expect(buildPrintGcode(printer, [toolpath])).not.toMatch(/NaN|Infinity|undefined/);
    });
});

describe('boundary outline', () => {
    /** A base with two separate feet, 10 x 10 mm each, 40 mm apart, joined above the bed. */
    function twoFeetModel(): EverydayModel {
        const foot = (x: number) => new THREE.BoxGeometry(10, 10, 5).translate(x, 0, 2.5).toNonIndexed();
        const bridge = new THREE.BoxGeometry(50, 10, 5).translate(0, 0, 7.5).toNonIndexed();
        const position = [foot(-20), foot(20), bridge].flatMap(g => Array.from(g.getAttribute('position').array));
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
        const model = blockModel();
        model.mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
        model.mesh.position.set(100, 100, 0);
        model.geometry = geometry;
        return model;
    }

    it('travels between two outlines instead of printing a line from one to the other', () => {
        const printer = barePrinter();
        printer.generateBoundary = true;
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(printer), twoFeetModel())!;
        const boundary = toolpath.filter(p => p.role === 'boundary');
        expect(boundary.filter(p => p.travel)).toHaveLength(2);

        let longest = 0;
        for (let i = 1; i < boundary.length; i++) {
            if (!boundary[i].travel) longest = Math.max(longest, boundary[i].point.distanceTo(boundary[i - 1].point));
        }
        // No printed boundary move is longer than a side of a foot's outline (12 mm with the offset).
        expect(longest).toBeLessThan(13);
    });

    it('closes each outline', () => {
        const printer = barePrinter();
        printer.generateBoundary = true;
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(printer), blockModel())!;
        const boundary = toolpath.filter(p => p.role === 'boundary');
        expect(boundary[0].travel).toBe(true);
        expect(boundary[0].point.distanceTo(boundary[boundary.length - 1].point)).toBeLessThan(1e-6);
    });

    it('parks for the pause above everything printed before', () => {
        const printer = barePrinter();
        printer.generateBoundary = true;
        const toolpath = generateAugmentFoamToolpath(fakeVisualizer(printer), blockModel(), { minimumSafeZ: 95 })!;
        const pause = toolpath.find(p => p.pause)!;
        expect(pause.point.z).toBeGreaterThanOrEqual(95);
    });
});
