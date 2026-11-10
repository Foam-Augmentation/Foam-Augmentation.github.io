// src/visualizer/gui/objectSummary.ts
/**
 * The words and counts the Objects panel shows about the objects on the plate.
 *
 * Kept free of DOM and three.js imports so it can be unit-tested under Node.
 */
import type { EverydayModel } from '../types/modelTypes';

/**
 * Describes where an object stands, for the second line of its row.
 *
 * @param model - The object.
 * @returns A short status, e.g. "No foam area yet".
 */
export function objectStatus(model: EverydayModel): string {
  switch (model.kind) {
    case 'augment':
      if (!model.toolpathSamplePoints?.length) return 'No foam area selected yet';
      return model.selectedSenseFoamMesh ? 'Foam area and sensing area selected' : 'Foam area selected';
    case 'foam':
      return 'Whole model printed as foam';
    case 'regular':
      return `Solid part, ${model.regularConfig.infillDensity}% infill`;
  }
}

/**
 * Counts the objects of each kind, and how many augmentations have an area to print.
 *
 * @param models - Every object on the plate.
 * @returns The counts the export buttons are labelled and enabled with.
 */
export function countObjects(models: EverydayModel[]): {
  augment: number;
  augmentReady: number;
  foam: number;
  regular: number;
} {
  const counts = { augment: 0, augmentReady: 0, foam: 0, regular: 0 };
  for (const model of models) {
    counts[model.kind]++;
    if (model.kind === 'augment' && (model.toolpathSamplePoints?.length ?? 0) > 0) counts.augmentReady++;
  }
  return counts;
}
