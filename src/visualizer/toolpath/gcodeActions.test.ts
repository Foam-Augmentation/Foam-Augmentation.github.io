import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { exportPlateGcode, leadInFromAbove } from './gcodeActions';
import type { PathPoint } from './pathTypes';
import type Visualizer from '../Visualizer';
import type { EverydayModel } from '../types/modelTypes';
import { plateFingerprint, type PlateSlice } from './plateSlice';
import { DEFAULT_REGULAR_CONFIG } from './regularSlicer';
import { notify } from '../gui/notify';
import { saveGcodeToFile } from './saveGcodeToFile';

// Both touch the DOM; only whether and how they are called matters here.
vi.mock('../gui/notify', () => ({ notify: vi.fn(), withBusy: vi.fn() }));
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
      summary: { objects: new Map([[1, { layers: 1 }]]), tools: [0], height: 1, bytes: 6 },
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
