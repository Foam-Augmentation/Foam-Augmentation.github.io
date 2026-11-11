// src/visualizer/gui/presetFormat.ts
/**
 * Reading and writing preset files.
 *
 * A preset is plain text with one `key value` pair per line; `#` starts a comment line.
 *
 *     # AugPrint Foam Slicer preset
 *     presetVersion 3
 *     bedTemp 60                     <- global setting (Visualizer.config)
 *     extruderCount 2
 *     extruder0.nozzleDiameter 0.4   <- per-extruder setting
 *     hStar 9                        <- model parameter (toolpathConfig)
 *     initial.hStar 9                <- model initial-layer parameter (initialConfig)
 *     initialOffset 0
 *     regular.layerHeight 0.2        <- model regular-print setting (regularConfig)
 *
 * Older files still import: version 2 has no `regular.*` lines, and version 1 (written before
 * the version line existed) also has no `presetVersion`, `initial.*` and `initialOffset` lines.
 *
 * Import is parse → validate → commit: `parsePreset` never touches application state, and a
 * preset with any invalid line is rejected as a whole, so a bad file cannot leave the
 * settings half-applied.
 *
 * Everything here is pure (no DOM, no three.js) so it can be unit-tested under Node.
 */
import {
  EXTRUDER_SPECS,
  INITIAL_OFFSET_SPEC,
  INITIAL_SPECS,
  MODEL_SPECS,
  SETTING_SPECS,
  ExtruderKey,
  InitialKey,
  ModelKey,
  ParamSpec,
  REGULAR_SPECS,
  RegularKey,
  SettingKey,
} from './paramSpecs';

/** Version written by `serializePreset`. Bump when the format changes incompatibly. */
export const PRESET_VERSION = 3;

/** Upper bound on the extruder count a preset may ask for. */
export const MAX_EXTRUDERS = 16;

export type PresetValue = number | boolean | string;

/** The extruder fields a preset stores. Structurally matches `Extruder` in Printer.ts. */
export type ExtruderValues = Record<ExtruderKey, number>;

/** The global settings object a preset reads from and writes to (`Visualizer.config`). */
export type SettingsTarget = { extruders: ExtruderValues[] } & { [key: string]: unknown };

/** The parts of an everyday model a preset reads from and writes to. */
export interface ModelTarget {
  name?: string;
  /** The model's `ToolpathConfig`. */
  toolpathConfig: object;
  /** The model's initial-layer `ToolpathConfig`. */
  initialConfig: object;
  initialOffset: number;
  /** The model's regular-print settings (`RegularPrintSettings`), if it has them. */
  regularConfig?: object;
}

/** The result of parsing a preset file. Nothing is applied until `errors` is empty. */
export interface ParsedPreset {
  /** Format version of the file; 1 when the file has no version line. */
  version: number;
  /** Validated global settings. */
  settings: Partial<Record<SettingKey, PresetValue>>;
  /** Number of extruders the preset asks for, if it says. */
  extruderCount?: number;
  /** Validated per-extruder values, keyed by extruder index. */
  extruders: Record<number, Partial<ExtruderValues>>;
  /** Validated model parameters (toolpathConfig). */
  model: Partial<Record<ModelKey, number | boolean>>;
  /** Validated initial-layer parameters (initialConfig). */
  initial: Partial<Record<InitialKey, number | boolean>>;
  /** Validated initial-layer offset. */
  initialOffset?: number;
  /** Validated regular-print settings (regularConfig). */
  regular: Partial<Record<RegularKey, PresetValue>>;
  /** Lines that were ignored (unknown keys). The preset can still be applied. */
  warnings: string[];
  /** Lines that are invalid. The preset must not be applied if there are any. */
  errors: string[];
}

/**
 * True if the parsed preset carries any per-model parameter.
 *
 * @param preset - A parsed preset.
 * @returns Whether there is anything to apply to a model.
 */
export function hasModelSection(preset: ParsedPreset): boolean {
  return (
    Object.keys(preset.model).length > 0 ||
    Object.keys(preset.initial).length > 0 ||
    preset.initialOffset !== undefined ||
    Object.keys(preset.regular).length > 0
  );
}

/**
 * Converts the raw text of one value into a typed value and checks it against its spec.
 *
 * @param spec - The parameter's spec (type, range or allowed values).
 * @param raw - The text after the key on a preset line.
 * @returns The typed value, or a description of what is wrong with it.
 */
export function parseValue(spec: ParamSpec, raw: string): { value: PresetValue } | { error: string } {
  const text = raw.trim();

  if (spec.type === 'boolean') {
    const lower = text.toLowerCase();
    if (lower === 'true') return { value: true };
    if (lower === 'false') return { value: false };
    return { error: `expected true or false, got "${text}"` };
  }

  if (spec.type === 'enum') {
    if (spec.options.indexOf(text) !== -1) return { value: text };
    return { error: `expected one of ${spec.options.join(', ')}, got "${text}"` };
  }

  // Number("") is 0 and Number("abc") is NaN; neither may reach the G-code.
  const value = text === '' ? NaN : Number(text);
  if (!Number.isFinite(value)) {
    return { error: `expected a number, got "${text}"` };
  }
  if (spec.integer && !Number.isInteger(value)) {
    return { error: `expected a whole number, got ${text}` };
  }
  if (value < spec.min || value > spec.max) {
    return { error: `${text} is outside the allowed range ${spec.min} to ${spec.max}` };
  }
  return { value };
}

/**
 * Looks up a spec without picking up inherited properties such as `constructor`.
 *
 * @param specs - A spec table.
 * @param key - The key to look up.
 * @returns The spec, or undefined if the key is not in the table.
 */
function specFor(specs: { readonly [key: string]: ParamSpec }, key: string): ParamSpec | undefined {
  return Object.prototype.hasOwnProperty.call(specs, key) ? specs[key] : undefined;
}

/**
 * Parses and validates the text of a preset file. Does not modify any application state.
 *
 * @param text - The file contents.
 * @returns The validated values plus any warnings (ignored lines) and errors (invalid lines).
 */
export function parsePreset(text: string): ParsedPreset {
  const preset: ParsedPreset = {
    version: 1,
    settings: {},
    extruders: {},
    model: {},
    initial: {},
    regular: {},
    warnings: [],
    errors: [],
  };

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const where = `line ${index + 1}`;
    const split = trimmed.search(/\s/);
    if (split === -1) {
      preset.errors.push(`${where}: "${trimmed}" has no value`);
      return;
    }
    const key = trimmed.slice(0, split);
    const raw = trimmed.slice(split + 1).trim();

    /** Validates `raw` against `spec` and hands the typed value to `store`. */
    const take = (spec: ParamSpec, store: (value: PresetValue) => void) => {
      const result = parseValue(spec, raw);
      if ('error' in result) {
        preset.errors.push(`${where}: ${key}: ${result.error}`);
      } else {
        store(result.value);
      }
    };

    if (key === 'presetVersion') {
      const version = Number(raw);
      if (!Number.isInteger(version) || version < 1) {
        preset.errors.push(`${where}: presetVersion: expected a whole number of 1 or more, got "${raw}"`);
      } else if (version > PRESET_VERSION) {
        preset.errors.push(
          `${where}: this preset is version ${version}, but this app only reads up to version ${PRESET_VERSION}`
        );
      } else {
        preset.version = version;
      }
      return;
    }

    if (key === 'extruderCount') {
      const count = Number(raw);
      if (!Number.isInteger(count) || count < 1 || count > MAX_EXTRUDERS) {
        preset.errors.push(`${where}: extruderCount: expected a whole number from 1 to ${MAX_EXTRUDERS}, got "${raw}"`);
      } else {
        preset.extruderCount = count;
      }
      return;
    }

    const extruderMatch = key.match(/^extruder(\d+)\.(.+)$/);
    if (extruderMatch) {
      const extruderIndex = Number(extruderMatch[1]);
      const field = extruderMatch[2];
      const spec = specFor(EXTRUDER_SPECS, field);
      if (!spec) {
        preset.warnings.push(`${where}: unknown extruder field "${field}" ignored`);
      } else if (extruderIndex >= MAX_EXTRUDERS) {
        preset.errors.push(`${where}: ${key}: extruder index must be below ${MAX_EXTRUDERS}`);
      } else {
        take(spec, value => {
          const extruder = preset.extruders[extruderIndex] ?? (preset.extruders[extruderIndex] = {});
          extruder[field as ExtruderKey] = value as number;
        });
      }
      return;
    }

    if (key.startsWith('initial.')) {
      const field = key.slice('initial.'.length);
      const spec = specFor(INITIAL_SPECS, field);
      if (!spec) {
        preset.warnings.push(`${where}: unknown initial-layer parameter "${field}" ignored`);
      } else {
        take(spec, value => { preset.initial[field as InitialKey] = value as number | boolean; });
      }
      return;
    }

    if (key.startsWith('regular.')) {
      const field = key.slice('regular.'.length);
      const spec = specFor(REGULAR_SPECS, field);
      if (!spec) {
        preset.warnings.push(`${where}: unknown regular-print setting "${field}" ignored`);
      } else {
        take(spec, value => { preset.regular[field as RegularKey] = value; });
      }
      return;
    }

    if (key === 'initialOffset') {
      take(INITIAL_OFFSET_SPEC, value => { preset.initialOffset = value as number; });
      return;
    }

    const settingSpec = specFor(SETTING_SPECS, key);
    if (settingSpec) {
      take(settingSpec, value => { preset.settings[key as SettingKey] = value; });
      return;
    }

    const modelSpec = specFor(MODEL_SPECS, key);
    if (modelSpec) {
      take(modelSpec, value => { preset.model[key as ModelKey] = value as number | boolean; });
      return;
    }

    preset.warnings.push(`${where}: unknown key "${key}" ignored`);
  });

  // Every extruder line must refer to an extruder the preset actually declares.
  if (preset.extruderCount !== undefined) {
    for (const indexText of Object.keys(preset.extruders)) {
      if (Number(indexText) >= preset.extruderCount) {
        preset.errors.push(
          `extruder${indexText}: the preset declares only ${preset.extruderCount} extruder(s)`
        );
      }
    }
  }

  return preset;
}

/**
 * Writes a validated preset's global settings and extruders into a settings object.
 * Call only when `preset.errors` is empty.
 *
 * Without an `extruderCount` line the number of extruders is left alone and values for
 * extruders that do not exist are skipped.
 *
 * @param preset - A parsed preset with no errors.
 * @param settings - The settings object to update (`Visualizer.config`).
 * @param createExtruder - Makes a default extruder; used when the preset needs more extruders
 *                         than exist and there is none to copy.
 */
export function applyPresetToSettings(
  preset: ParsedPreset,
  settings: SettingsTarget,
  createExtruder: () => ExtruderValues
): void {
  for (const key of Object.keys(preset.settings) as SettingKey[]) {
    settings[key] = preset.settings[key];
  }

  const extruders = settings.extruders;
  if (preset.extruderCount !== undefined) {
    while (extruders.length > preset.extruderCount) extruders.pop();
    while (extruders.length < preset.extruderCount) {
      const last = extruders[extruders.length - 1];
      extruders.push(last ? { ...last } : createExtruder());
    }
  }
  for (const indexText of Object.keys(preset.extruders)) {
    const extruder = extruders[Number(indexText)];
    if (extruder) {
      Object.assign(extruder, preset.extruders[Number(indexText)]);
    }
  }
}

/**
 * Writes a validated preset's model parameters into one model.
 * Call only when `preset.errors` is empty.
 *
 * @param preset - A parsed preset with no errors.
 * @param model - The model to update.
 */
export function applyPresetToModel(preset: ParsedPreset, model: ModelTarget): void {
  Object.assign(model.toolpathConfig, preset.model);
  Object.assign(model.initialConfig, preset.initial);
  if (preset.initialOffset !== undefined) {
    model.initialOffset = preset.initialOffset;
  }
  if (model.regularConfig) {
    Object.assign(model.regularConfig, preset.regular);
  }
}

/**
 * Serialises settings, extruders and (optionally) one model's parameters as preset text.
 *
 * Every key in the spec tables is written, so importing the result restores every
 * parameter. Keys missing from the given objects are skipped.
 *
 * @param settings - The global settings (`Visualizer.config`).
 * @param model - The model whose parameters to include, or null/undefined for none.
 * @returns The preset file contents.
 */
export function serializePreset(settings: SettingsTarget, model?: ModelTarget | null): string {
  const lines: string[] = ['# AugPrint Foam Slicer preset', `presetVersion ${PRESET_VERSION}`];

  lines.push('', '# Settings');
  for (const key of Object.keys(SETTING_SPECS)) {
    if (settings[key] !== undefined) lines.push(`${key} ${settings[key]}`);
  }

  lines.push('', '# Extruders', `extruderCount ${settings.extruders.length}`);
  settings.extruders.forEach((extruder, index) => {
    for (const key of Object.keys(EXTRUDER_SPECS) as ExtruderKey[]) {
      if (extruder[key] !== undefined) lines.push(`extruder${index}.${key} ${extruder[key]}`);
    }
  });

  if (model) {
    // Keep the name on one line so it cannot inject extra preset lines.
    const name = (model.name ?? '').replace(/\s+/g, ' ').trim();
    lines.push('', name ? `# Model parameters (from ${name})` : '# Model parameters');
    const toolpathConfig = model.toolpathConfig as { [key: string]: unknown };
    const initialConfig = model.initialConfig as { [key: string]: unknown };
    for (const key of Object.keys(MODEL_SPECS)) {
      if (toolpathConfig[key] !== undefined) lines.push(`${key} ${toolpathConfig[key]}`);
    }
    lines.push('', '# Initial-layer parameters');
    for (const key of Object.keys(INITIAL_SPECS)) {
      if (initialConfig[key] !== undefined) lines.push(`initial.${key} ${initialConfig[key]}`);
    }
    lines.push(`initialOffset ${model.initialOffset}`);

    if (model.regularConfig) {
      const regularConfig = model.regularConfig as { [key: string]: unknown };
      lines.push('', '# Regular-print settings');
      for (const key of Object.keys(REGULAR_SPECS)) {
        if (regularConfig[key] !== undefined) lines.push(`regular.${key} ${regularConfig[key]}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}
