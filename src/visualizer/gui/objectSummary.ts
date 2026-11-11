// src/visualizer/gui/objectSummary.ts
/**
 * The words and counts the Objects panel shows about the objects on the plate.
 *
 * Kept free of DOM and three.js imports so it can be unit-tested under Node.
 */
import type { EverydayModel } from '../types/modelTypes';
import type { PlateSlice } from '../toolpath/plateSlice';

/**
 * Describes where an object stands, for the second line of its row.
 *
 * @param model - The object.
 * @param slice - The plate slice, if there is one. A print that is in an up-to-date slice also
 *                says how many layers it has.
 * @returns A short status, e.g. "No foam area yet".
 */
export function objectStatus(model: EverydayModel, slice?: PlateSlice | null): string {
  const sliced = slice && !slice.stale && model.kind !== 'augment' ? slice.summary.objects.get(model.objectId) : undefined;
  const layers = sliced ? ` · ${plural(sliced.layers, 'layer')}` : '';
  switch (model.kind) {
    case 'augment':
      if (!model.toolpathSamplePoints?.length) return 'No foam area selected yet';
      return model.selectedSenseFoamMesh ? 'Foam area and sensing area selected' : 'Foam area selected';
    case 'foam':
      return `Whole model printed as foam${layers}`;
    case 'regular':
      return `Solid part, ${model.regularConfig.infillDensity}% infill${layers}`;
  }
}

/** "1 layer", "2 layers". */
function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Writes a file size the way people read it.
 *
 * @param bytes - The size.
 * @returns E.g. "820 B", "14.2 kB", "3.1 MB".
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
}

/**
 * Describes a plate slice for the summary under the Slice Prints button.
 *
 * @param slice - The plate slice.
 * @returns The lines to show, most important first.
 */
export function plateSummaryLines(slice: PlateSlice): string[] {
  if (slice.stale) {
    return ['Out of date: the plate changed after it was sliced. Slice it again before exporting.'];
  }
  const { summary } = slice;
  const slicer = summary.regularSlicer === 'prusaslicer'
    ? ', regular parts with PrusaSlicer'
    : summary.regularSlicer === 'builtin' ? ', regular parts with the built-in slicer' : '';
  const tools = summary.tools.length ? summary.tools.map(tool => `T${tool}`).join(', ') : 'none';
  return [
    `Sliced ${plural(summary.objects.size, 'object')}${slicer}`,
    `Tools ${tools} · ${summary.height.toFixed(1)} mm tall · ${formatBytes(summary.bytes)}`,
  ];
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
