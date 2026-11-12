import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { EverydayModel } from '../types/modelTypes';
import type { PathPoint } from './pathTypes';
import { plateFingerprint, summarizePlate } from './plateSlice';
import { DEFAULT_REGULAR_CONFIG } from './regularSlicer';

function at(z: number, extra: Partial<PathPoint> = {}): PathPoint {
    return { point: new THREE.Vector3(10, 10, z), ...extra };
}

describe('summarizePlate', () => {
    const toolpath: PathPoint[] = [
        at(0.2, { role: 'purgeLine', regularSegment: true, extruder: 0 }),
        at(0.2, { objectId: 1, layer: 0, extruder: 0 }),
        at(0.4, { objectId: 1, layer: 1 }),
        at(0.4, { objectId: 1, layer: 1 }),
        at(9, { objectId: 1, layer: 5, travel: true }),
        at(0.6, { objectId: 1, layer: 2 }),
        at(50, { role: 'purgeTower', extruder: 1 }),
        at(3, { objectId: 2, layer: 0, extruder: 1 }),
    ];
    const summary = summarizePlate(toolpath, 'G1 X1 ; é\n', { regularSlicer: 'prusaslicer', filamentDiameter: 1.75, densities: [1.21] });

    it('counts the layers each object prints in, leaving travel out', () => {
        expect([...summary.objects]).toEqual([[1, { layers: 3 }], [2, { layers: 1 }]]);
    });

    it('measures the height of the objects, not of the purge tower', () => {
        expect(summary.height).toBe(3);
    });

    it('lists the tools and the file size in bytes', () => {
        expect(summary.tools).toEqual([0, 1]);
        expect(summary.bytes).toBe(11);
        expect(summary.regularSlicer).toBe('prusaslicer');
    });
});

describe('summarizePlate: time and filament', () => {
    it('estimates the G-code, and weighs each tool\'s filament with its own density', () => {
        // 1000 mm of 1.75 mm filament is 2.405 cm³.
        const gcode = 'M83\nG1 X10 E1000 F1200\nT1 S1 L0 D0\nG1 X20 E1000';
        const summary = summarizePlate([], gcode, { filamentDiameter: 1.75, densities: [1, 2] });
        expect(summary.estimate.filament).toEqual([1000, 1000]);
        expect(summary.filamentGrams[0]).toBeCloseTo(2.405, 3);
        expect(summary.filamentGrams[1]).toBeCloseTo(4.811, 3);
        expect(summary.estimate.seconds).toBeGreaterThan(0);
    });

    it('takes an estimate it is given instead of working it out again', () => {
        const estimate = { seconds: 60, filament: [500], stops: 1, toolChanges: 0 };
        expect(summarizePlate([], '', { estimate, filamentDiameter: 1.75, densities: [1.21] }).estimate).toBe(estimate);
    });
});

describe('plateFingerprint', () => {
    function model(kind: EverydayModel['kind'], objectId: number): EverydayModel {
        return {
            objectId,
            kind,
            name: `m${objectId}`,
            mesh: new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10)),
            regularConfig: { ...DEFAULT_REGULAR_CONFIG },
            toolpathConfig: { deltaZ: 1 },
            initialConfig: { deltaZ: 1 },
            initialOffset: 0,
        } as unknown as EverydayModel;
    }
    const settings = () => ({ bedTemp: 60, purgeLine: true, extruders: [{ nozzleDiameter: 0.4 }] });

    it('stays the same while nothing changes', () => {
        const models = [model('regular', 1), model('foam', 2)];
        expect(plateFingerprint(settings(), models)).toBe(plateFingerprint(settings(), models));
    });

    it('changes when a print moves, its settings change, or a global setting changes', () => {
        const models = [model('regular', 1), model('foam', 2)];
        const before = plateFingerprint(settings(), models);

        models[0].mesh.position.x += 1;
        const moved = plateFingerprint(settings(), models);
        expect(moved).not.toBe(before);

        models[0].regularConfig.supports = 'everywhere';
        expect(plateFingerprint(settings(), models)).not.toBe(moved);

        expect(plateFingerprint({ ...settings(), bedTemp: 65 }, models)).not.toBe(plateFingerprint(settings(), models));
        const extruders = settings();
        extruders.extruders[0].nozzleDiameter = 0.6;
        expect(plateFingerprint(extruders, models)).not.toBe(plateFingerprint(settings(), models));
    });

    it('changes when a print loads another gradient image', () => {
        const models = [model('foam', 2)];
        models[0].gradient = { width: 2, height: 2 } as EverydayModel['gradient'];
        const before = plateFingerprint(settings(), models);
        models[0].gradient = { width: 2, height: 2 } as EverydayModel['gradient'];
        expect(plateFingerprint(settings(), models)).not.toBe(before);
    });

    it('ignores augmentations, which the print file does not contain', () => {
        const regular = model('regular', 1);
        const augment = model('augment', 3);
        const before = plateFingerprint(settings(), [regular, augment]);
        augment.mesh.position.y += 5;
        expect(plateFingerprint(settings(), [regular, augment])).toBe(before);
    });

    it('reads only the settings it knows, so other things on the config cannot break it', () => {
        const config: Record<string, unknown> = settings();
        config.currentSelectedModel = config; // circular, as a model reference can be
        expect(() => plateFingerprint(config, [model('regular', 1)])).not.toThrow();
    });
});
