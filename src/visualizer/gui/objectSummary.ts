// src/visualizer/gui/objectSummary.ts
/**
 * The words and counts the Objects panel shows about the objects on the plate.
 *
 * Kept free of DOM and three.js imports so it can be unit-tested under Node.
 */
import type { EverydayModel } from '../types/modelTypes';
import type { PlateSlice } from '../toolpath/plateSlice';
import type { PrintEstimate } from '../toolpath/printEstimate';

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
 * Writes a print time the way people read it.
 *
 * @param seconds - The time.
 * @returns E.g. "45 s", "27 min", "3 h 05 min".
 */
export function formatDuration(seconds: number): string {
  if (seconds < 59.5) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/**
 * Describes how long a print takes and how much filament it uses.
 *
 * @param estimate - The estimate.
 * @param grams - The weight of each tool's filament (g), by tool number, if known.
 * @returns E.g. "About 27 min · 2.85 m of filament (8.4 g) · 1 pause".
 */
export function describeEstimate(estimate: PrintEstimate, grams: number[] = []): string {
  const used = estimate.filament
    .map((length, tool) => ({ tool, length, grams: grams[tool] }))
    .filter(entry => entry.length > 0.5);
  const meters = (entry: { length: number }) => `${(entry.length / 1000).toFixed(2)} m`;
  const weight = (entry: { grams?: number }) => entry.grams !== undefined ? ` (${entry.grams.toFixed(1)} g)` : '';
  const filament = used.length === 0
    ? 'no filament'
    : used.length === 1
      ? `${meters(used[0])} of filament${weight(used[0])}`
      : used.map(entry => `T${entry.tool} ${meters(entry)}${weight(entry)}`).join(', ');
  const parts = [`About ${formatDuration(estimate.seconds)}`, filament];
  if (estimate.stops) parts.push(plural(estimate.stops, 'pause'));
  return parts.join(' · ');
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
    describeEstimate(summary.estimate, summary.filamentGrams),
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
