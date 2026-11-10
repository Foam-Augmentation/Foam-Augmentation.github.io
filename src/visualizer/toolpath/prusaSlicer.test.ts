import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import Printer from '../../printer/Printer';
import { DEFAULT_REGULAR_CONFIG, type RegularPart } from './regularSlicer';
import { sliceRegularParts, type PrusaSlicerBridge } from './prusaSlicer';

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
});
