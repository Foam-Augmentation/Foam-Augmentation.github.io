import { describe, expect, it } from 'vitest';
import { countObjects, formatBytes, objectStatus, plateSummaryLines } from './objectSummary';
import type { EverydayModel } from '../types/modelTypes';
import type { PlateSlice } from '../toolpath/plateSlice';

/** Builds just enough of a model for the summary helpers. */
function model(partial: Partial<EverydayModel>): EverydayModel {
  return {
    kind: 'augment',
    regularConfig: { layerHeight: 0.2, perimeters: 2, infillDensity: 20, topBottomLayers: 4, extruder: 0, printSpeed: 1800 },
    ...partial,
  } as EverydayModel;
}

const samplePoints = [{ point: {}, type: 'foam' }] as unknown as EverydayModel['toolpathSamplePoints'];

describe('objectStatus', () => {
  it('says an augmentation still needs a foam area', () => {
    expect(objectStatus(model({ kind: 'augment' }))).toBe('No foam area selected yet');
  });

  it('says which areas an augmentation has', () => {
    expect(objectStatus(model({ kind: 'augment', toolpathSamplePoints: samplePoints }))).toBe('Foam area selected');
    expect(objectStatus(model({
      kind: 'augment',
      toolpathSamplePoints: samplePoints,
      selectedSenseFoamMesh: {} as EverydayModel['selectedSenseFoamMesh'],
    }))).toBe('Foam area and sensing area selected');
  });

  it('describes foam and regular prints', () => {
    expect(objectStatus(model({ kind: 'foam' }))).toBe('Whole model printed as foam');
    expect(objectStatus(model({ kind: 'regular' }))).toBe('Solid part, 20% infill');
  });
});

describe('countObjects', () => {
  it('counts each kind, and only augmentations with an area as ready', () => {
    const counts = countObjects([
      model({ kind: 'augment' }),
      model({ kind: 'augment', toolpathSamplePoints: samplePoints }),
      model({ kind: 'foam' }),
      // sample points left over from when this object was an augmentation do not count
      model({ kind: 'regular', toolpathSamplePoints: samplePoints }),
    ]);
    expect(counts).toEqual({ augment: 2, augmentReady: 1, foam: 1, regular: 1 });
  });

  it('is all zero for an empty plate', () => {
    expect(countObjects([])).toEqual({ augment: 0, augmentReady: 0, foam: 0, regular: 0 });
  });
});

describe('the plate slice in the object list', () => {
  /** A slice of objects 1 (40 layers) and 2 (1 layer). */
  function slice(stale = false, regularSlicer?: 'prusaslicer' | 'builtin'): PlateSlice {
    return {
      gcode: '',
      fileName: 'toolpath.gcode',
      fingerprint: '',
      previews: [],
      stale,
      summary: { regularSlicer, objects: new Map([[1, { layers: 40 }], [2, { layers: 1 }]]), tools: [0, 1], height: 8, bytes: 2_400_000 },
    };
  }

  it('adds the layer count of a sliced print to its status', () => {
    expect(objectStatus(model({ kind: 'regular', objectId: 1 }), slice())).toBe('Solid part, 20% infill · 40 layers');
    expect(objectStatus(model({ kind: 'foam', objectId: 2 }), slice())).toBe('Whole model printed as foam · 1 layer');
  });

  it('leaves it out for an object that is not in the slice, or a slice that is out of date', () => {
    expect(objectStatus(model({ kind: 'regular', objectId: 3 }), slice())).toBe('Solid part, 20% infill');
    expect(objectStatus(model({ kind: 'regular', objectId: 1 }), slice(true))).toBe('Solid part, 20% infill');
  });

  it('sums the slice up in two lines', () => {
    expect(plateSummaryLines(slice(false, 'prusaslicer'))).toEqual([
      'Sliced 2 objects, regular parts with PrusaSlicer',
      'Tools T0, T1 · 8.0 mm tall · 2.4 MB',
    ]);
    expect(plateSummaryLines(slice())[0]).toBe('Sliced 2 objects');
  });

  it('says when the slice is out of date', () => {
    expect(plateSummaryLines(slice(true))).toEqual([expect.stringMatching(/^Out of date/)]);
  });
});

describe('formatBytes', () => {
  it('writes bytes, kB and MB', () => {
    expect(formatBytes(820)).toBe('820 B');
    expect(formatBytes(14_200)).toBe('14.2 kB');
    expect(formatBytes(3_100_000)).toBe('3.1 MB');
  });
});
