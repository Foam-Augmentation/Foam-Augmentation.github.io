// src/visualizer/gui/presetManager.ts
/**
 * Exporting presets to, and importing them from, a file.
 *
 * The file format, validation and (de)serialisation live in presetFormat.ts, which is pure
 * and unit-tested; this module only deals with the browser (file dialogs, downloads) and
 * with committing a validated preset to the Visualizer.
 */
import Visualizer from '../Visualizer';
import { EverydayModel } from '../types/modelTypes';
import { createDefaultExtruder } from '../../printer/Printer';
import { defaultDownloadName } from './downloadName';
import { notify } from './notify';
import {
  ParsedPreset,
  applyPresetToModel,
  applyPresetToSettings,
  hasModelSection,
  parsePreset,
  serializePreset,
} from './presetFormat';

/** How many problem lines to quote in a message before summarising the rest. */
const MAX_LISTED_PROBLEMS = 3;

/**
 * Joins the first few problems into one message.
 *
 * @param problems - The individual problem descriptions.
 * @returns The first few problems, plus a count of the rest.
 */
function summarize(problems: string[]): string {
  const listed = problems.slice(0, MAX_LISTED_PROBLEMS).join('; ');
  const rest = problems.length - MAX_LISTED_PROBLEMS;
  return rest > 0 ? `${listed}; and ${rest} more` : listed;
}

/**
 * Exports the current settings as a preset file.
 *
 * Global settings and extruders are always written. Model parameters come from the selected
 * everyday model, or the first everyday model if none is selected; with no everyday model
 * loaded the preset simply has no model section.
 *
 * @param visualizer - The Visualizer instance.
 * @param baseName - Start of the filename; a timestamp and `.txt` are appended.
 */
export function exportPresetToFile(visualizer: Visualizer, baseName: string = 'augprint-preset'): void {
  const model: EverydayModel | null = visualizer.currentSelectedModel ?? visualizer.everydayModelList[0] ?? null;
  const content = serializePreset(visualizer.config, model);
  const filename = defaultDownloadName(baseName, 'txt');

  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Give the browser a moment to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  notify(
    model
      ? `Preset saved as ${filename} (model parameters from “${model.name}”).`
      : `Preset saved as ${filename}. No everyday model is loaded, so it holds printer and slicer settings only.`,
    'success'
  );
}

/**
 * Commits a validated preset: global settings and extruders, the printer mirror, the print
 * space outline, and the model parameters.
 *
 * Model parameters go to the selected everyday model, or to every everyday model if none is
 * selected. With no everyday model loaded they are kept and applied to models imported later.
 *
 * @param visualizer - The Visualizer instance.
 * @param preset - A parsed preset with no errors.
 * @returns A short description of where the model parameters went, for the user.
 */
export function commitPreset(visualizer: Visualizer, preset: ParsedPreset): string {
  applyPresetToSettings(preset, visualizer.config, createDefaultExtruder);
  visualizer.syncConfigToPrinter();
  visualizer.rebuildPrintBase();

  if (!hasModelSection(preset)) {
    return 'It has no model parameters.';
  }

  const selected = visualizer.currentSelectedModel;
  const targets = selected ? [selected] : visualizer.everydayModelList;
  if (targets.length === 0) {
    visualizer.pendingModelPreset = (model: EverydayModel) => applyPresetToModel(preset, model);
    return 'Its model parameters will be applied to everyday models you import from now on.';
  }

  visualizer.pendingModelPreset = null;
  targets.forEach(model => applyPresetToModel(preset, model));
  if (selected) {
    return `Model parameters applied to the selected model “${selected.name}”.`;
  }
  return targets.length === 1
    ? `Model parameters applied to “${targets[0].name}”.`
    : `Model parameters applied to all ${targets.length} everyday models.`;
}

/**
 * Parses, validates and (only if everything is valid) applies the text of a preset file,
 * telling the user what happened.
 *
 * @param visualizer - The Visualizer instance.
 * @param content - The file contents.
 * @param filename - The file's name, for messages.
 * @returns True if the preset was applied; false if it was rejected and nothing changed.
 */
export function applyPresetText(visualizer: Visualizer, content: string, filename: string): boolean {
  const preset = parsePreset(content);

  if (preset.errors.length > 0) {
    notify(`Preset ${filename} was not applied. ${summarize(preset.errors)}.`, 'error');
    return false;
  }

  const modelNote = commitPreset(visualizer, preset);
  notify(`Preset ${filename} applied. ${modelNote}`, 'success');
  if (preset.warnings.length > 0) {
    notify(`Preset ${filename}: ${summarize(preset.warnings)}.`, 'warning');
  }
  return true;
}

/**
 * Lets the user pick a preset file and applies it.
 *
 * @param visualizer - The Visualizer instance.
 * @returns The name of the applied file, or null if the dialog was cancelled, the file could
 *          not be read, or the preset was rejected. The promise always settles.
 */
export function importPresetFromFile(visualizer: Visualizer): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,text/plain';

    // Closing the dialog without choosing a file fires `cancel`, not `change`.
    input.addEventListener('cancel', () => resolve(null));

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => {
        notify(`Could not read ${file.name}.`, 'error');
        resolve(null);
      };
      reader.onload = () => {
        try {
          const applied = applyPresetText(visualizer, String(reader.result ?? ''), file.name);
          resolve(applied ? file.name : null);
        } catch (error) {
          notify(
            `Preset ${file.name} could not be applied: ${error instanceof Error ? error.message : String(error)}`,
            'error'
          );
          resolve(null);
        }
      };
      reader.readAsText(file);
    });

    input.click();
  });
}
