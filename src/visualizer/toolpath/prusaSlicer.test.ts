import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import Printer from '../../printer/Printer';
import { DEFAULT_REGULAR_CONFIG, type RegularPart } from './regularSlicer';
import { isPrusaSlicerAvailable, sliceRegularParts, type PrusaSlicerBridge } from './prusaSlicer';

function cube(x: number, config = DEFAULT_REGULAR_CONFIG): RegularPart {
    return {
        mesh: new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10).translate(0, 0, 5)),
        offset: new THREE.Vector3(x, 50, 0),
        config,
    };
}

const GCODE = 'G1 Z.2\nG1 X1 Y1\nG1 X2 Y1 E.1\nG1 Z5\nG1 X3 Y1 E.1\n';

function fakeBridge(available: boolean): PrusaSlicerBridge & { slice: ReturnType<typeof vi.fn> } {
    return {
        status: async () => ({ available }),
        slice: vi.fn(async () => ({ gcode: GCODE })),
    };
}

describe('sliceRegularParts', () => {
    it('uses PrusaSlicer when it is available, sending STL in printer coordinates', async () => {
        const bridge = fakeBridge(true);
        const result = await sliceRegularParts(new Printer(), [cube(40), cube(80)], bridge);
        expect(result.slicer).toBe('prusaslicer');
        expect(bridge.slice).toHaveBeenCalledTimes(1);
        const request = bridge.slice.mock.calls[0][0];
        expect(request.parts).toHaveLength(2);
        expect(request.ini).toContain('use_relative_e_distances = 1');

        // Binary STL: 80-byte header, triangle count, then 50 bytes per triangle. Check the first
        // vertex of part 2 lies inside its placed cube (x 75..85, y 45..55, z 0..10).
        const view = new DataView(request.parts[1].stl.buffer, request.parts[1].stl.byteOffset);
        expect(view.getUint32(80, true)).toBe(12);
        const [vx, vy, vz] = [0, 4, 8].map(o => view.getFloat32(84 + 12 + o, true));
        expect(vx).toBeGreaterThanOrEqual(75 - 1e-4); expect(vx).toBeLessThanOrEqual(85 + 1e-4);
        expect(vy).toBeGreaterThanOrEqual(45 - 1e-4); expect(vy).toBeLessThanOrEqual(55 + 1e-4);
        expect(vz).toBeGreaterThanOrEqual(-1e-4); expect(vz).toBeLessThanOrEqual(10 + 1e-4);

        expect(result.toolpath.filter(p => p.extrusion! > 0)).toHaveLength(2);
        expect(result.notes).toEqual([]);
    });

    it('slices parts with different settings separately and lifts clear between them', async () => {
        const bridge = fakeBridge(true);
        const result = await sliceRegularParts(new Printer(), [cube(40), cube(80, { ...DEFAULT_REGULAR_CONFIG, perimeters: 3 })], bridge);
        expect(bridge.slice).toHaveBeenCalledTimes(2);
        const approach = result.toolpath.filter(p => p.role === 'approach');
        expect(approach).toHaveLength(2);
        expect(approach[0].point.z).toBeGreaterThan(5);
        expect(result.notes[0]).toMatch(/one group after another/);
    });

    it('falls back to the built-in slicer when PrusaSlicer is missing, and says so', async () => {
        const bridge = fakeBridge(false);
        const result = await sliceRegularParts(new Printer(), [cube(40)], bridge);
        expect(result.slicer).toBe('builtin');
        expect(bridge.slice).not.toHaveBeenCalled();
        expect(result.toolpath.length).toBeGreaterThan(0);
        expect(result.notes[0]).toMatch(/not found/);
    });

    it('uses the built-in slicer quietly in a plain browser', async () => {
        const result = await sliceRegularParts(new Printer(), [cube(40)], undefined);
        expect(result).toMatchObject({ slicer: 'builtin', notes: [] });
    });

    it('sends the part\'s supports and brim to PrusaSlicer', async () => {
        const bridge = fakeBridge(true);
        await sliceRegularParts(new Printer(), [cube(40, { ...DEFAULT_REGULAR_CONFIG, supports: 'buildplate', brimWidth: 4 })], bridge);
        const { ini } = bridge.slice.mock.calls[0][0];
        expect(ini).toContain('support_material = 1');
        expect(ini).toContain('support_material_buildplate_only = 1');
        expect(ini).toContain('brim_width = 4');
    });

    it('checks the PrusaSlicer-only settings before running PrusaSlicer, and only then', async () => {
        const bad = { ...DEFAULT_REGULAR_CONFIG, firstLayerHeight: 0.9 };
        const bridge = fakeBridge(true);
        await expect(sliceRegularParts(new Printer(), [cube(40, bad)], bridge)).rejects.toThrow(/first layer height/);
        expect(bridge.slice).not.toHaveBeenCalled();

        // The built-in slicer does not use them, so they cannot stop it.
        const result = await sliceRegularParts(new Printer(), [cube(40, bad)], undefined);
        expect(result.slicer).toBe('builtin');
    });
});

describe('isPrusaSlicerAvailable', () => {
    it('is false in a plain browser', async () => {
        expect(await isPrusaSlicerAvailable(undefined)).toBe(false);
    });

    it('follows what the desktop app reports', async () => {
        expect(await isPrusaSlicerAvailable(fakeBridge(true))).toBe(true);
        expect(await isPrusaSlicerAvailable(fakeBridge(false))).toBe(false);
    });

    it('is false when the desktop app cannot be asked', async () => {
        const bridge = { ...fakeBridge(true), status: async () => { throw new Error('no answer'); } };
        expect(await isPrusaSlicerAvailable(bridge)).toBe(false);
    });
});

describe('Prusa profiles in the slicing request', () => {
    const BUNDLE = [
        '[printer:Original Prusa XL Input Shaper 0.4 nozzle]',
        'printer_technology = FFF',
        'nozzle_diameter = 0.4',
        'retract_length = 0.8',
        '[print:0.20mm SPEED @XLIS 0.4]',
        'perimeter_acceleration = 3000',
        'compatible_printers_condition = nozzle_diameter[0]==0.4',
        '[filament:Generic PLA @XLIS]',
        'start_filament_gcode = "M572 S0.036"',
    ].join('\n');

    function bridgeWithBundle(): PrusaSlicerBridge & { slice: ReturnType<typeof vi.fn> } {
        return { ...fakeBridge(true), vendorProfiles: async () => ({ text: BUNDLE }) };
    }

    it('sends the chosen printer, print and filament profiles to be loaded under the app\'s settings', async () => {
        const printer = new Printer();
        printer.prusaPrinterProfile = 'Original Prusa XL Input Shaper 0.4 nozzle';
        const bridge = bridgeWithBundle();
        const config = { ...DEFAULT_REGULAR_CONFIG, printProfile: '0.20mm SPEED @XLIS 0.4', filamentProfile: 'Generic PLA @XLIS' };
        await sliceRegularParts(printer, [cube(40, config)], bridge);
        const { profileIni, ini } = bridge.slice.mock.calls[0][0];
        expect(profileIni).toContain('retract_length = 0.8');
        expect(profileIni).toContain('perimeter_acceleration = 3000');
        expect(profileIni).toContain('start_filament_gcode = "M572 S0.036"');
        expect(profileIni).not.toContain('compatible_printers_condition');
        // The app's own settings stay in their own file, loaded last.
        expect(ini).toContain('layer_height = ');
        expect(ini).not.toContain('retract_length');
    });

    it('leaves out a profile the bundle does not have, and says so', async () => {
        const printer = new Printer();
        printer.prusaPrinterProfile = 'Original Prusa XL Input Shaper 0.4 nozzle';
        const bridge = bridgeWithBundle();
        const result = await sliceRegularParts(printer, [cube(40, { ...DEFAULT_REGULAR_CONFIG, printProfile: 'Gone' })], bridge);
        expect(bridge.slice.mock.calls[0][0].profileIni).toContain('retract_length = 0.8');
        expect(result.notes.some(note => /print profile “Gone”/.test(note))).toBe(true);
    });

    it('sends no profile file when none is chosen', async () => {
        const bridge = bridgeWithBundle();
        await sliceRegularParts(new Printer(), [cube(40)], bridge);
        expect(bridge.slice.mock.calls[0][0].profileIni).toBeUndefined();
    });
});
