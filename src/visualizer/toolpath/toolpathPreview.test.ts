import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import Printer from '../../printer/Printer';
import { FEATURE, type PathPoint } from './pathTypes';
import {
    buildToolpathPreview,
    colorPreview,
    FEATURE_GROUPS,
    featureGroupOf,
    NOT_APPLICABLE_COLOR,
    scaleColor,
    SCALE_STOPS,
    showPreviewSteps,
} from './toolpathPreview';

const at = (x: number, z: number, extra: Partial<PathPoint> = {}): PathPoint => ({ point: new THREE.Vector3(x, 0, z), ...extra });

/** Purge line, then object 1 layer 0, a travel, object 2 layer 0, object 1 layer 1, a tower block. */
const toolpath: PathPoint[] = [
    at(0, 0.2, { travel: true, extruder: 0 }),
    at(10, 0.2, { role: 'purgeLine', regularSegment: true }),
    at(20, 0.2, { travel: true }),
    at(21, 0.2, { objectId: 1, layer: 0, regularSegment: true, feature: FEATURE.externalPerimeter, speed: 1200 }),
    at(22, 0.2, { objectId: 1, layer: 0, regularSegment: true, feature: 'Support material', speed: 2400 }),
    at(40, 0.2, { travel: true, objectId: 2, layer: 0 }),
    at(41, 0.2, { objectId: 2, layer: 0, vStar: 0.2, hStar: 6, edot: 50, feature: FEATURE.foam }),
    at(21, 0.4, { travel: true }),
    at(22, 0.4, { objectId: 1, layer: 1, regularSegment: true, feature: FEATURE.internalInfill, speed: 1800 }),
    at(60, 3, { travel: true, extruder: 1 }),
    at(61, 3, { role: 'purgeTower', regularSegment: true }),
];
const preview = buildToolpathPreview(toolpath, {
    toolColors: [0x111111, 0x222222],
    travelColor: 0x7f8fa6,
    speedOf: point => point.speed ?? (point.vStar ? 999 : undefined),
});

describe('buildToolpathPreview: steps', () => {
    it('makes a step of each layer of each object, and of each helper, in print order', () => {
        expect(preview.steps.map(s => [s.role ?? s.objectId, s.layer])).toEqual([
            ['purgeLine', undefined], [1, 0], [2, 0], [1, 1], ['purgeTower', undefined],
        ]);
        expect(preview.steps[3]).toMatchObject({ zMin: 0.4, zMax: 0.4 });
    });

    it('draws each move once, extrusions and travels apart', () => {
        expect(preview.extrusion.geometry.getAttribute('position').count).toBe(6 * 2);
        expect(preview.travel.geometry.getAttribute('position').count).toBe(4 * 2);
    });

    it('puts a travel in the step it leads into', () => {
        // Travel 1 (before object 1) is in step 1; travel 2 in step 2; travel 3 in step 3; travel 4 in step 4.
        expect(Array.from(preview.travelEnd)).toEqual([0, 1, 2, 3, 4]);
        expect(Array.from(preview.extrusionEnd)).toEqual([1, 3, 4, 5, 6]);
    });

    it('shows the print up to a step, or that step alone', () => {
        showPreviewSteps(preview, 2);
        expect(preview.extrusion.geometry.drawRange).toEqual({ start: 0, count: 8 });
        expect(preview.travel.geometry.drawRange).toEqual({ start: 0, count: 4 });
        showPreviewSteps(preview, 2, true);
        expect(preview.extrusion.geometry.drawRange).toEqual({ start: 6, count: 2 });
        expect(preview.travel.geometry.drawRange).toEqual({ start: 2, count: 2 });
        showPreviewSteps(preview, 99);
        expect(preview.extrusion.geometry.drawRange).toEqual({ start: 0, count: 12 });
    });
});

/** The RGB of the first vertex of an extruding move. */
function colorOf(segment: number): number[] {
    const array = preview.extrusion.geometry.getAttribute('color').array as Float32Array;
    return Array.from(array.slice(segment * 6, segment * 6 + 3));
}
const rgba = (hex: number) => new THREE.Color(hex).toArray();
/** How long an extruding move is drawn. */
function drawnLength(segment: number): number {
    const p = preview.extrusion.geometry.getAttribute('position').array as Float32Array;
    const o = segment * 6;
    return Math.hypot(p[o + 3] - p[o], p[o + 4] - p[o + 1], p[o + 5] - p[o + 2]);
}

describe('colorPreview', () => {
    it('colours by feature group, and lists only the groups that are there', () => {
        const legend = colorPreview(preview, 'feature');
        expect(legend.kind === 'categories' && legend.items.map(i => i.label)).toEqual(['Foam', 'Walls', 'Infill', 'Support', 'Purge, brim and boundary']);
        const walls = FEATURE_GROUPS.find(g => g.id === 'walls')!.color;
        expect(colorOf(1)).toEqual(rgba(walls).map(v => expect.closeTo(v, 5)));
    });

    it('leaves hidden groups out of the drawing, and puts them back', () => {
        colorPreview(preview, 'feature', new Set(['support']));
        expect(drawnLength(2)).toBe(0);
        expect(drawnLength(1)).toBeCloseTo(1, 6);
        colorPreview(preview, 'feature');
        expect(drawnLength(2)).toBeCloseTo(1, 6);
    });

    it('colours by tool with the tools\' own colours', () => {
        const legend = colorPreview(preview, 'tool');
        expect(legend.kind === 'categories' && legend.items.map(i => i.label)).toEqual(['T0', 'T1']);
        expect(colorOf(5)).toEqual(rgba(0x222222).map(v => expect.closeTo(v, 5)));
    });

    it('spreads a numeric scale from the lowest to the highest value', () => {
        const legend = colorPreview(preview, 'speed');
        expect(legend).toMatchObject({ kind: 'scale', min: 999, max: 2400, notApplicableCount: 2 });
        expect(colorOf(2)).toEqual(rgba(SCALE_STOPS[SCALE_STOPS.length - 1]).map(v => expect.closeTo(v, 5)));
        // The purge line has no speed here.
        expect(colorOf(0)).toEqual(rgba(NOT_APPLICABLE_COLOR).map(v => expect.closeTo(v, 5)));
    });

    it('gives V* only to foam moves', () => {
        const legend = colorPreview(preview, 'vStar');
        expect(legend).toMatchObject({ kind: 'scale', min: expect.closeTo(0.2, 6), max: expect.closeTo(0.2, 6), notApplicableCount: 5 });
    });
});

describe('featureGroupOf', () => {
    it('groups PrusaSlicer\'s feature names the way the legend shows them', () => {
        const group = (feature: string) => featureGroupOf({ point: new THREE.Vector3(), regularSegment: true, feature });
        expect(group('Overhang perimeter')).toBe('walls');
        expect(group('Top solid infill')).toBe('solid');
        expect(group('Bridge infill')).toBe('solid');
        expect(group('Ironing')).toBe('solid');
        expect(group('Support material interface')).toBe('support');
        expect(group('Skirt/Brim')).toBe('helpers');
        expect(group(FEATURE.ironing)).toBe('shell');
        expect(featureGroupOf({ point: new THREE.Vector3(), vStar: 1 })).toBe('foam');
    });
});

describe('scaleColor', () => {
    it('runs from the first stop to the last', () => {
        expect(scaleColor(0).getHex()).toBe(SCALE_STOPS[0]);
        expect(scaleColor(1).getHex()).toBe(SCALE_STOPS[SCALE_STOPS.length - 1]);
        expect(scaleColor(-5).getHex()).toBe(SCALE_STOPS[0]);
    });
});

describe('Printer.moveSpeed', () => {
    it('gives a foam move the head speed the G-code is written with', () => {
        const printer = new Printer();
        const point: PathPoint = { point: new THREE.Vector3(10, 0, 1), vStar: 0.2, hStar: 6, edot: 50 };
        const line = (printer as unknown as { extrudeSingleSegment: (...args: unknown[]) => string })
            .extrudeSingleSegment(new THREE.Vector3(0, 0, 1), point.point, 0.2, 50, 0);
        const written = Number(/F(\d+)/.exec(line)![1]);
        expect(printer.moveSpeed(point, 0)).toBeCloseTo(written, -0.5);
    });

    it('uses a regular move\'s own speed, or the travel speed', () => {
        const printer = new Printer();
        expect(printer.moveSpeed({ point: new THREE.Vector3(), regularSegment: true, speed: 1234 }, 0)).toBe(1234);
        expect(printer.moveSpeed({ point: new THREE.Vector3(), regularSegment: true }, 0)).toBe(printer.extruders[0].printHead_speed_when_free_move);
        expect(printer.moveSpeed({ point: new THREE.Vector3(), regularSegment: true }, 9)).toBeUndefined();
    });
});
