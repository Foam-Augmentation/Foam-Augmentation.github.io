import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { exportPlateGcode, leadInFromAbove, slicePlate } from './gcodeActions';
import type { PathPoint } from './pathTypes';
import type Visualizer from '../Visualizer';
import Printer from '../../printer/Printer';
import type { EverydayModel, ToolpathConfig } from '../types/modelTypes';
import { plateFingerprint, type PlateSlice } from './plateSlice';
import { DEFAULT_REGULAR_CONFIG } from './regularSlicer';
import { notify } from '../gui/notify';
import { saveGcodeToFile } from './saveGcodeToFile';

// Both touch the DOM; only whether and how they are called matters here. The busy overlay just
// runs the work.
vi.mock('../gui/notify', () => ({
  notify: vi.fn(),
  withBusy: vi.fn(async (_message: string, work: () => unknown) => work()),
}));
vi.mock('./saveGcodeToFile', () => ({ saveGcodeToFile: vi.fn() }));

/** A travel point. */
function travel(x: number, y: number, z: number, extra: Partial<PathPoint> = {}): PathPoint {
  return { point: new THREE.Vector3(x, y, z), travel: true, ...extra };
}

/** A printing point. */
function print(x: number, y: number, z: number): PathPoint {
  return { point: new THREE.Vector3(x, y, z) };
}

describe('leadInFromAbove', () => {
  it('replaces the opening travel across the bed by an approach from above', () => {
    // As the foam slicer does: start at the origin and cross the bed at printing height.
    const toolpath = [travel(0, 0, 0.2), travel(25, 20, 0.2), travel(50, 40, 0.2), print(60, 40, 0.2), print(60, 50, 0.2)];
    const result = leadInFromAbove(toolpath, 16);

    expect(result.map(p => p.point.toArray())).toEqual([
      [50, 40, 16],   // arrive above the start of printing
      [50, 40, 0.2],  // straight down
      [60, 40, 0.2],
      [60, 50, 0.2],
    ]);
    expect(result[0].travel).toBe(true);
    expect(result[0].role).toBe('approach');
    // nothing below the safe height is crossed before the head is over the landing point
    expect(result.slice(0, 1).every(p => p.point.z >= 16)).toBe(true);
  });

  it('keeps the tool choice of a dropped point', () => {
    const toolpath = [travel(0, 0, 0.2, { extruder: 1 }), travel(50, 40, 0.2), print(60, 40, 0.2)];
    expect(leadInFromAbove(toolpath, 16)[0].extruder).toBe(1);
  });

  it('never approaches below the landing point', () => {
    const toolpath = [travel(0, 0, 30), travel(50, 40, 30), print(60, 40, 30)];
    expect(leadInFromAbove(toolpath, 16)[0].point.z).toBe(30);
  });

  it('leaves the input and paths without an opening travel alone', () => {
    const toolpath = [travel(0, 0, 0.2), travel(50, 40, 0.2), print(60, 40, 0.2)];
    const copy = toolpath.map(p => p.point.clone());
    leadInFromAbove(toolpath, 16);
    expect(toolpath.map(p => p.point)).toEqual(copy);
    expect(toolpath).toHaveLength(3);

    const printsFirst = [print(1, 1, 0.2), print(2, 1, 0.2)];
    expect(leadInFromAbove(printsFirst, 16)).toBe(printsFirst);
    const onlyTravel = [travel(0, 0, 0.2), travel(5, 5, 0.2)];
    expect(leadInFromAbove(onlyTravel, 16)).toBe(onlyTravel);
    expect(leadInFromAbove([], 16)).toEqual([]);
  });
});

describe('slicePlate: head collisions', () => {
  beforeEach(() => vi.clearAllMocks());

  const VTP: ToolpathConfig = {
    deltaZ: 1.7, hStar: 6, hStarEnd: 6, vStar: 0.15, vStarEnd: 0.15, deltaL: 1.7, deltaLEnd: 1.7,
    senseDeltaZ: 1.7, senseHStar: 6, senseHStarEnd: 6, senseVStar: 0.15, SenseVStarEnd: 0.15,
    senseDeltaL: 1.7, senseDeltaLEnd: 1.7,
    gridSize: 4, initialFoamLayerCount: 0, middleSenseLayerCount: 0, finalFoamLayerCount: 0,
    edot: 50, senseEdot: 50, bumpSpacingX: 10, bumpSpacingY: 10, bumpScale: 1, generateBumps: false,
    curveAugment: false, steepnessThreshold: 60, flatLayerZOffset: 3, additionalCurveLayers: 0,
  };

  /** A box standing on the bed. */
  function box(objectId: number, kind: EverydayModel['kind'], name: string, x: number, size: [number, number, number]): EverydayModel {
    const geometry = new THREE.BoxGeometry(...size).translate(0, 0, size[2] / 2);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.position.set(x, 100, 0);
    return {
      objectId, kind, name, mesh, geometry,
      regularConfig: { ...DEFAULT_REGULAR_CONFIG },
      transformType: 'move',
      transformX: { x: 0 }, transformY: { y: 0 }, transformZ: { z: 0 },
      gradient: { width: 1, height: 1, sampleColor: () => ({ r: 255, g: 255, b: 255, a: 255 }) },
      toolpathConfig: { ...VTP },
      initialConfig: { ...VTP },
      initialOffset: 0,
    };
  }

  /** A 30 mm regular post with a 6 mm foam print 5 mm beside it, well inside the head's reach. */
  function plate(checkCollisions: boolean) {
    const printer = new Printer();
    printer.checkCollisions = checkCollisions;
    const setPlateSlice = vi.fn();
    const visualizer = {
      printer, scene: new THREE.Scene(), config: {},
      everydayModelList: [box(1, 'regular', 'post', 100, [10, 10, 30]), box(2, 'foam', 'pad', 115, [10, 10, 6])],
      invalidatePlateSlice: vi.fn(), setPlateSlice,
    } as unknown as Visualizer;
    return { visualizer, setPlateSlice };
  }

  const summaryOf = (setPlateSlice: ReturnType<typeof vi.fn>) => (setPlateSlice.mock.calls[0][0] as PlateSlice).summary;

  it('checks the sliced plate when Check Collisions is on, and says what the head would hit', async () => {
    const { visualizer, setPlateSlice } = plate(true);
    await slicePlate(visualizer);

    // The regular post is finished before the foam starts at its foot.
    const { headCollisions } = summaryOf(setPlateSlice);
    expect(headCollisions!.moves).toBeGreaterThan(0);
    expect(headCollisions!.depth).toBeGreaterThan(20);
    expect(headCollisions!.collisions.every(c => c.obstacle.objectId === 1)).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(/^Collision detected: .*“pad” prints, the print head would hit “post”, which is already printed.* Move the objects apart, or press Arrange\.$/),
      'error',
    );
    // The check of the toolpath stands in for the comparison of the outlines.
    expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/would reach/), expect.anything());
  });

  it('only compares the outlines when Check Collisions is off', async () => {
    const { visualizer, setPlateSlice } = plate(false);
    await slicePlate(visualizer);

    expect(summaryOf(setPlateSlice).headCollisions).toBeUndefined();
    expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/^Collision detected/), expect.anything());
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/the print head would reach “post”/), 'warning');
  });

  it('reports a clear plate as clear', async () => {
    const { visualizer, setPlateSlice } = plate(true);
    // The foam print alone: its head is always above what it has printed.
    (visualizer as { everydayModelList: EverydayModel[] }).everydayModelList.shift();
    await slicePlate(visualizer);

    expect(summaryOf(setPlateSlice).headCollisions).toEqual({ collisions: [], moves: 0, depth: 0 });
    expect(notify).not.toHaveBeenCalledWith(expect.anything(), 'error');
  });

  it('crosses to the boundaries and the foam above the regular parts printed before them', async () => {
    const printer = new Printer();
    printer.checkCollisions = true;
    printer.generateBoundary = true;
    const setPlateSlice = vi.fn();
    // A 30 mm regular post between two foam pads, far enough from both for the head to clear it
    // while they print: only a move across the plate can hit it.
    const visualizer = {
      printer, scene: new THREE.Scene(), config: {},
      everydayModelList: [
        box(1, 'foam', 'left pad', 100, [10, 10, 6]),
        box(2, 'regular', 'post', 160, [10, 10, 30]),
        box(3, 'foam', 'right pad', 220, [10, 10, 6]),
      ],
      invalidatePlateSlice: vi.fn(), setPlateSlice,
    } as unknown as Visualizer;
    await slicePlate(visualizer);

    expect(summaryOf(setPlateSlice).headCollisions).toEqual({ collisions: [], moves: 0, depth: 0 });
  });
});

describe('exportPlateGcode', () => {
  beforeEach(() => vi.clearAllMocks());

  /** A plate with one regular print, sliced as it is now unless `slice` is false. */
  function plate(slice = true) {
    const model = {
      objectId: 1, kind: 'regular', name: 'part',
      mesh: new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10)),
      regularConfig: { ...DEFAULT_REGULAR_CONFIG }, toolpathConfig: {}, initialConfig: {}, initialOffset: 0,
    } as unknown as EverydayModel;
    const config = { bedTemp: 60, extruders: [{ nozzleDiameter: 0.4 }] };
    const plateSlice: PlateSlice | null = slice ? {
      gcode: 'G1 X1', fileName: 'part.gcode', previews: [], stale: false,
      fingerprint: plateFingerprint(config, [model]),
      summary: {
        objects: new Map([[1, { layers: 1 }]]), tools: [0], height: 1, bytes: 6,
        estimate: { seconds: 60, filament: [100], stops: 0, toolChanges: 0 }, filamentGrams: [0.3],
      },
    } : null;
    const visualizer = {
      config, everydayModelList: [model], plateSlice,
      invalidatePlateSlice: vi.fn(() => { if (plateSlice) plateSlice.stale = true; }),
    } as unknown as Visualizer;
    return { visualizer, model, plateSlice };
  }

  it('saves the sliced G-code while the plate is as it was sliced', () => {
    const { visualizer } = plate();
    exportPlateGcode(visualizer);
    expect(saveGcodeToFile).toHaveBeenCalledWith('G1 X1', 'part.gcode');
  });

  it('asks for a slice first when there is none', () => {
    exportPlateGcode(plate(false).visualizer);
    expect(saveGcodeToFile).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Slice the plate first/), 'warning');
  });

  it('refuses a slice that is known to be out of date', () => {
    const { visualizer, plateSlice } = plate();
    plateSlice!.stale = true;
    exportPlateGcode(visualizer);
    expect(saveGcodeToFile).not.toHaveBeenCalled();
  });

  it('refuses, and marks the slice out of date, when the plate changed without the app being told', () => {
    const { visualizer, model, plateSlice } = plate();
    model.mesh.position.x = 50;
    exportPlateGcode(visualizer);
    expect(saveGcodeToFile).not.toHaveBeenCalled();
    expect(plateSlice!.stale).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/changed after it was sliced/), 'warning');
  });
});
