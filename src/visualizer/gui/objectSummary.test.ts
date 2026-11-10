import { describe, expect, it } from 'vitest';
import { countObjects, objectStatus } from './objectSummary';
import type { EverydayModel } from '../types/modelTypes';

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
