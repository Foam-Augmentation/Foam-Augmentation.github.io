import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import Printer from '../../printer/Printer';
import type { PathPoint } from './pathTypes';
import {
    assertPrintable,
    buildPrintGcode,
    combineToolpaths,
    getExtruderUsage,
    validatePrinter,
    validateToolpath,
} from './buildGcode';

/** A foam (VTP) extrusion point. */
function foam(x: number, y: number, z: number, extruder: number, extra: Partial<PathPoint> = {}): PathPoint {
    return { point: new THREE.Vector3(x, y, z), extruder, hStar: 6, vStar: 0.15, edot: 50, ...extra };
}

/** A travel point. */
function travel(x: number, y: number, z: number, extra: Partial<PathPoint> = {}): PathPoint {
    return { point: new THREE.Vector3(x, y, z), travel: true, ...extra };
}

/** The purge line every model's toolpath starts with. Its points name no extruder. */
function purgeLine(): PathPoint[] {
    return [
        { point: new THREE.Vector3(5, 5, 0.3), regularSegment: true, role: 'purgeLine' },
        { point: new THREE.Vector3(245, 5, 0.3), regularSegment: true, role: 'purgeLine' },
    ];
}

/** A small single-extruder model toolpath: purge line, lead-in, then a few foam moves. */
function modelToolpath(extruder: number, originX: number, topZ: number): PathPoint[] {
    return [
        ...purgeLine(),
        travel(0, 0, topZ + 10, { role: 'approach' }),
        travel(originX, 50, topZ + 10, { role: 'approach' }),
        travel(originX, 50, topZ, { extruder, role: 'approach' }),
        foam(originX + 10, 50, topZ, extruder),
        foam(originX + 10, 60, topZ, extruder),
    ];
}

/** Counts how often a piece of text occurs in a string. */
function count(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

describe('buildPrintGcode across several models (G1)', () => {
    it('changes tool before the second body when the models use different extruders', () => {
        const printer = new Printer();
        const gcode = buildPrintGcode(printer, [modelToolpath(1, 40, 8), modelToolpath(0, 120, 5)]);

        // The print starts on the first model's tool...
        expect(gcode).toContain('T1 S1 L0 D0 ; pick the first tool');
        // ...and switches to the second model's tool before any of its extrusions.
        const toolchange = gcode.indexOf('; Change Tool1 -> Tool0');
        const secondBodyFirstExtrusion = gcode.indexOf('G1 X130.000000 Y50.000000 Z5.000000');
        expect(toolchange).toBeGreaterThan(-1);
        expect(secondBodyFirstExtrusion).toBeGreaterThan(-1);
        expect(toolchange).toBeLessThan(secondBodyFirstExtrusion);
        expect(count(gcode, '; Change Tool')).toBe(1);
    });

    it('emits the start sequence, the purge line and the end sequence exactly once', () => {
        const printer = new Printer();
        const gcode = buildPrintGcode(printer, [modelToolpath(1, 40, 8), modelToolpath(0, 120, 5)]);

        expect(count(gcode, 'G28 XY')).toBe(1);
        expect(count(gcode, 'lift off the purge line')).toBe(1);
        // The purge line itself: one extrusion along the front of the bed.
        expect(count(gcode, 'G1 X245.000000 Y5.000000 Z0.300000')).toBe(1);
        expect(count(gcode, 'M84 ; disable motors')).toBe(1);
        expect(count(gcode, '; move to start point')).toBe(1);
    });

    it('lifts above everything printed so far before crossing to the next model', () => {
        const combined = combineToolpaths([modelToolpath(1, 40, 8), modelToolpath(0, 120, 5)]);
        const liftIndex = combined.findIndex(p => p.debug !== undefined && p.debug.startsWith('NEXT MODEL'));
        expect(liftIndex).toBeGreaterThan(0);

        const before = combined[liftIndex - 1].point;
        const lift = combined[liftIndex];
        const cross = combined[liftIndex + 1];
        // Straight up from where the first model ended, to above its lead-in height (8 + 10) plus clearance...
        expect(lift.point.x).toBe(before.x);
        expect(lift.point.y).toBe(before.y);
        expect(lift.point.z).toBeGreaterThanOrEqual(28);
        // ...then across at that height.
        expect(cross.point.z).toBe(lift.point.z);
        expect(lift.travel && cross.travel).toBe(true);
    });

    it('does not depend on what the printer did before', () => {
        const printer = new Printer();
        printer.activeExtruder = 1; // left over from an earlier toolpath
        const gcode = buildPrintGcode(printer, [modelToolpath(0, 40, 8)]);
        expect(gcode).toContain('T0 S1 L0 D0 ; pick the first tool');
        expect(gcode).not.toContain('; Change Tool');
    });

    it('rejects a purge tower that restarts below its current height', () => {
        const tower = (z: number): PathPoint => ({
            point: new THREE.Vector3(235, 195, z), regularSegment: true, role: 'purgeTower', extruder: 0,
        });
        const first = [...modelToolpath(0, 40, 8), tower(0.2), tower(0.4)];
        const restarting = [...modelToolpath(0, 120, 5), tower(0.2)];
        const continuing = [...modelToolpath(0, 120, 5), tower(0.6)];

        expect(() => combineToolpaths([first, restarting])).toThrow(/purge tower/i);
        expect(() => combineToolpaths([first, continuing])).not.toThrow();
    });

    it('throws when there is nothing to print', () => {
        expect(() => buildPrintGcode(new Printer(), [])).toThrow(/no toolpath/i);
        expect(() => buildPrintGcode(new Printer(), [[]])).toThrow(/no toolpath/i);
    });
});

describe('first tool and heaters (G4)', () => {
    it('takes the first tool from the first point that names an extruder', () => {
        const toolpath = modelToolpath(1, 40, 8);
        expect(toolpath[0].extruder).toBeUndefined();
        expect(getExtruderUsage(toolpath)).toEqual({ first: 1, used: [1] });
        expect(getExtruderUsage([travel(0, 0, 1)])).toEqual({ first: 0, used: [] });
    });

    it('never heats or picks tool 0 in a T1-only print, and turns every heater off at the end', () => {
        const printer = new Printer();
        const gcode = buildPrintGcode(printer, [modelToolpath(1, 40, 8)]);
        const end = gcode.slice(gcode.lastIndexOf('G4 S5'));

        expect(gcode).toContain('T1 S1 L0 D0 ; pick the first tool');
        expect(gcode).not.toContain('T0 S1 L0 D0');
        // Tool 0 is only ever set to 0 degrees.
        const tool0Temps = gcode.split('\n').filter(line => /^M10[49] .*T0\b/.test(line));
        expect(tool0Temps.length).toBeGreaterThan(0);
        tool0Temps.forEach(line => expect(line).toMatch(/S0\b/));

        expect(end).toContain('M104 T0 S0');
        expect(end).toContain('M104 T1 S0');
        expect(end).toContain('M140 S0');
    });

    it('turns off every heated extruder even when the print used only some of them', () => {
        const printer = new Printer();
        printer.extruders.push({ ...printer.extruders[0] });
        const end = printer.build_end_gcode();
        expect(end).toContain('M104 T0 S0');
        expect(end).toContain('M104 T1 S0');
        expect(end).toContain('M104 T2 S0');
    });

    it('turns the single nozzle off on a single-head machine', () => {
        const printer = new Printer();
        printer.multipleToolheads = false;
        expect(printer.build_end_gcode()).toContain('M104 S0 ; turn off temperature');
    });
});

describe('validation before emission (G5)', () => {
    it('accepts a toolpath inside the machine', () => {
        const printer = new Printer();
        expect(validateToolpath(printer, modelToolpath(0, 40, 8))).toEqual([]);
        expect(validatePrinter(printer)).toEqual([]);
        expect(() => assertPrintable(printer, modelToolpath(0, 40, 8))).not.toThrow();
    });

    it('rejects coordinates that are not numbers', () => {
        const printer = new Printer();
        const toolpath = [travel(10, 10, 5), foam(20, 10, NaN, 0)];
        expect(validateToolpath(printer, toolpath).join('\n')).toMatch(/not a number/);
        expect(() => buildPrintGcode(printer, [toolpath])).toThrow(/not a number/);
    });

    it('rejects points outside the configured bed and height', () => {
        const printer = new Printer();
        const problems = validateToolpath(printer, [
            foam(-1, 10, 5, 0),
            foam(10, printer.machine_depth_y + 1, 5, 0),
            foam(10, 10, printer.machine_height + 1, 0),
            foam(printer.machine_depth, printer.machine_depth_y, 0, 0), // exactly on the edge is fine
        ]).join('\n');
        expect(problems).toMatch(/X is below 0: 1 point/);
        expect(problems).toMatch(/Y is beyond the machine's 360 mm: 1 point/);
        expect(problems).toMatch(/Z is beyond the machine's 360 mm: 1 point/);
    });

    it('follows the configured machine size', () => {
        const printer = new Printer();
        const toolpath = [foam(400, 10, 5, 0)];
        expect(validateToolpath(printer, toolpath)).not.toEqual([]);
        printer.machine_depth = 450;
        expect(validateToolpath(printer, toolpath)).toEqual([]);
    });

    it('rejects foam extrusions without positive V*, H* and Edot', () => {
        const printer = new Printer();
        expect(validateToolpath(printer, [foam(10, 10, 5, 0, { vStar: 0 })]).join('\n')).toMatch(/V\* must be a positive number/);
        expect(validateToolpath(printer, [foam(10, 10, 5, 0, { hStar: undefined })]).join('\n')).toMatch(/H\* must be a positive number/);
        expect(validateToolpath(printer, [foam(10, 10, 5, 0, { edot: NaN })]).join('\n')).toMatch(/Edot must be a positive number/);
        // Travel moves do not need them.
        expect(validateToolpath(printer, [travel(10, 10, 5)])).toEqual([]);
    });

    it('rejects extruders the printer does not have', () => {
        const printer = new Printer();
        expect(validateToolpath(printer, [foam(10, 10, 5, 7)]).join('\n')).toMatch(/Extruder 7 does not exist/);
    });

    it('rejects non-positive printer parameters', () => {
        const printer = new Printer();
        printer.extruders[0].nozzleDiameter = 0;
        printer.diameter_filament = NaN;
        const problems = validatePrinter(printer).join('\n');
        expect(problems).toMatch(/Extruder 0 nozzle diameter/);
        expect(problems).toMatch(/Filament diameter/);
        expect(() => buildPrintGcode(printer, [modelToolpath(0, 40, 8)])).toThrow(/not safe to print/);
    });

    it('never writes NaN into the G-code of a valid print', () => {
        const gcode = buildPrintGcode(new Printer(), [modelToolpath(1, 40, 8), modelToolpath(0, 120, 5)]);
        expect(gcode).not.toMatch(/NaN|Infinity|undefined/);
    });
});

describe('purge positions follow the printer config (G5)', () => {
    it('puts the purge tower in the far corner of the configured bed', () => {
        const printer = new Printer();
        // The default bed is a Prusa XL's 360 x 360 mm.
        expect(printer.purgeTowerCenter().toArray()).toEqual([345, 345]);
        printer.machine_depth = 250;
        printer.machine_depth_y = 210;
        expect(printer.purgeTowerCenter().toArray()).toEqual([235, 195]);
    });
});

describe('initial-layer material is tracked for the whole print (G2)', () => {
    /** One island: two initial-layer moves, then two main-material moves. */
    const island = (x: number): PathPoint[] => [
        travel(x, 50, 6, { extruder: 0, initialMaterial: true }),
        foam(x + 10, 50, 6, 0, { initialMaterial: true }),
        travel(x, 50, 8, { extruder: 0, initialMaterial: false }),
        foam(x + 10, 50, 8, 0, { initialMaterial: false }),
    ];

    it('asks for a swap back when a second island starts its initial layers', () => {
        const printer = new Printer();
        const gcode = printer.generate_foam_gcode([...island(20), ...island(80)], printer.createEmitterState(0));

        // initial -> main, main -> initial (second island), initial -> main.
        expect(count(gcode, 'M600')).toBe(3);
        const swaps = gcode.split('\n').filter(line => line.startsWith('; Swap filament'));
        expect(swaps.map(line => (line.includes('initial-layer') ? 'initial' : 'main'))).toEqual(['main', 'initial', 'main']);
    });

    it('keeps the tool, its temperature and its nozzle profile across the swap', () => {
        const printer = new Printer();
        const state = printer.createEmitterState(0);
        const gcode = printer.generate_foam_gcode(island(20), state);

        expect(gcode).not.toContain('Change filament to extruder');
        expect(gcode).not.toContain('Change Tool');
        expect(gcode).not.toMatch(/M10[49]/);
        expect(state.extruder).toBe(0);
    });

    it('does not pause when the feature is not used', () => {
        const printer = new Printer();
        const gcode = printer.generate_foam_gcode([travel(20, 50, 6, { extruder: 0 }), foam(30, 50, 6, 0)], printer.createEmitterState(0));
        expect(gcode).not.toContain('M600');
    });

    it('tracks each tool of a toolchanger separately', () => {
        const printer = new Printer();
        const toolpath: PathPoint[] = [
            travel(20, 50, 6, { extruder: 0, initialMaterial: true }),
            foam(30, 50, 6, 0, { initialMaterial: true }),
            travel(60, 50, 6, { extruder: 1, initialMaterial: true }),
            foam(70, 50, 6, 1, { initialMaterial: true }),
            travel(20, 50, 8, { extruder: 0, initialMaterial: false }),
            foam(30, 50, 8, 0, { initialMaterial: false }),
            travel(60, 50, 8, { extruder: 1, initialMaterial: false }),
            foam(70, 50, 8, 1, { initialMaterial: false }),
        ];
        const gcode = printer.generate_foam_gcode(toolpath, printer.createEmitterState(0));
        const swaps = gcode.split('\n').filter(line => line.startsWith('; Swap filament'));
        expect(swaps).toEqual([
            '; Swap filament in extruder 0: load the main material',
            '; Swap filament in extruder 1: load the main material',
        ]);
    });
});

describe('extrusion details', () => {
    it('keeps a test sweep cold through tool changes (G19)', () => {
        const printer = new Printer();
        printer.testSweep = true;
        const change = printer.changeTool(1, 0);
        expect(change).toContain('M104 S20 T1');
        expect(change).toContain('M109 S20 T1');
        expect(change).not.toContain('S240');
    });

    it('scales a regular extrusion with the layer height it was sliced at (G16)', () => {
        const printer = new Printer();
        const extrusionOf = (layerHeight?: number): number => {
            const gcode = printer.generate_foam_gcode([
                travel(10, 10, 0.2, { extruder: 0 }),
                { point: new THREE.Vector3(20, 10, 0.2), regularSegment: true, extruder: 0, layerHeight },
            ], printer.createEmitterState(0));
            const match = gcode.match(/G1 X20\.000000 .* E([\d.]+)/);
            return parseFloat(match![1]);
        };

        // Default is half the nozzle diameter: 0.2 mm on a 0.4 mm nozzle.
        expect(extrusionOf(undefined)).toBeCloseTo(extrusionOf(0.2), 6);
        expect(extrusionOf(0.3)).toBeCloseTo(extrusionOf(0.2) * 1.5, 5);

        // A bigger nozzle extrudes for its own width and its own default layer height.
        const small = extrusionOf(undefined);
        printer.extruders[0].nozzleDiameter = 0.6;
        expect(extrusionOf(undefined)).toBeCloseTo(small * (0.6 * 0.3) / (0.4 * 0.2), 5);
    });

    it('fails loudly on a foam extrusion without parameters instead of crashing mid-file', () => {
        const printer = new Printer();
        const toolpath = [travel(10, 10, 5, { extruder: 0 }), { point: new THREE.Vector3(20, 10, 5) }];
        expect(() => printer.generate_foam_gcode(toolpath, printer.createEmitterState(0))).toThrow(/missing V\*, H\* or Edot/);
    });
});

describe('first-layer bounds in the start G-code', () => {
    it('limits probing (M555) to what touches the bed and the lowest layer above it', () => {
        const printer = new Printer();
        const above = 8 + printer.globalVTPSettings.deltaZ + 1;
        const toolpath: PathPoint[] = [
            travel(40, 50, 0.2, { extruder: 0 }),
            // On the bed, e.g. a purge line or the first regular layer.
            { point: new THREE.Vector3(60, 50, 0.2), regularSegment: true },
            { point: new THREE.Vector3(60, 80, 0.2), regularSegment: true },
            // The lowest layer above the bed (foam starts H* up): counts.
            { point: new THREE.Vector3(100, 90, 8), regularSegment: true },
            // Any layer above that: does not widen the probed area.
            { point: new THREE.Vector3(300, 300, above), regularSegment: true },
        ];
        const gcode = buildPrintGcode(printer, [toolpath]);
        expect(gcode).toContain('M555 X60 Y50 W40 H40');
    });
});
