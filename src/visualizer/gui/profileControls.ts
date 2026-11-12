// src/visualizer/gui/profileControls.ts
/**
 * The dropdowns that pick Prusa's own profiles for PrusaSlicer: the printer profile (Slicer
 * Settings) and each Regular Print object's print and filament profiles. Their choices come from
 * the profile bundle of the PrusaSlicer install, which the desktop app reads once PrusaSlicer is
 * found; the object lists follow the printer profile. Without PrusaSlicer they are greyed out.
 *
 * lil-gui can only change a dropdown's choices by building a new one, which it adds at the end of
 * the folder; the new one is moved back into the old one's place.
 */
import type { GUI, Controller } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import type Visualizer from '../Visualizer';
import type { EverydayModel } from '../types/modelTypes';
import type { VendorBundle } from '../toolpath/prusaProfiles';
import { loadVendorBundle, profileChoices } from '../toolpath/prusaSlicer';
import { setTip } from './guiHelpers';
import { REGULAR_SPECS, SETTING_SPECS } from './paramSpecs';

/**
 * Adds a dropdown. lil-gui's typings key the value type on the property, which a dropdown of
 * names built at run time cannot satisfy, so this goes through one loose signature.
 */
function addDropdown(folder: GUI, target: object, property: string, options: Record<string, string>): Controller {
  const add = folder.add.bind(folder) as unknown as (object: object, property: string, options: Record<string, string>) => Controller;
  return add(target, property, options);
}

/** The choice that leaves a profile out. */
const NONE = 'None (PrusaSlicer defaults)';

const state = {
  /** The bundle, once read. */
  bundle: null as VendorBundle | null,
  /** Whether PrusaSlicer is available (so the dropdowns do something). */
  available: false,
  loading: false,
};

/** A dropdown, what it was last built for, and what to do when it changes. */
interface Dropdown {
  controller: Controller;
  builtFor: string;
  tip: string;
  onChange?: () => void;
}

let printerDropdown: Dropdown | null = null;
const objectDropdowns = new Map<EverydayModel, { print: Dropdown, filament: Dropdown }>();

/** lil-gui writes option names as HTML; a profile name must show as the text it is. */
function asText(name: string): string {
  return name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The choices of a dropdown: none, the names offered, and the current value if it is not among
 * them (so a value from a preset or another printer is kept, and says why it is odd).
 */
function choicesOf(names: string[], current: string, missing: string): Record<string, string> {
  const options: Record<string, string> = { [NONE]: '' };
  for (const name of names) options[asText(name)] = name;
  if (current && !names.includes(current)) options[asText(state.bundle ? `${current} (${missing})` : current)] = current;
  return options;
}

/** Builds a dropdown's choices again, in its place, if what they depend on changed. */
function rebuild(dropdown: Dropdown, names: string[], current: string, missing: string, printer: string): void {
  const key = `${Boolean(state.bundle)}|${state.available}|${current}|${printer}`;
  if (key !== dropdown.builtFor) {
    const element = dropdown.controller.domElement;
    const parent = element.parentElement;
    const next = element.nextSibling;
    const fresh = dropdown.controller.options(choicesOf(names, current, missing));
    if (parent) parent.insertBefore(fresh.domElement, next);
    setTip(fresh.domElement, dropdown.tip);
    if (dropdown.onChange) fresh.onChange(dropdown.onChange);
    dropdown.controller = fresh;
    dropdown.builtFor = key;
  }
  dropdown.controller.enable(state.available);
}

/**
 * Adds the printer profile dropdown to a folder (Slicer Settings).
 *
 * @param folder - The folder.
 * @param visualizer - The Visualizer instance; its config holds the choice.
 */
export function addPrinterProfileControl(folder: GUI, visualizer: Visualizer): void {
  const spec = SETTING_SPECS.prusaPrinterProfile;
  const controller = addDropdown(folder, visualizer.config, 'prusaPrinterProfile', choicesOf([], visualizer.config.prusaPrinterProfile, ''))
    .name(spec.label);
  setTip(controller.domElement, spec.tip);
  const onChange = () => {
    visualizer.syncConfigToPrinter();
    refreshProfileControls(visualizer);
  };
  controller.onChange(onChange);
  printerDropdown = { controller, builtFor: '', tip: spec.tip, onChange };
  refreshProfileControls(visualizer);
}

/**
 * Adds an object's print and filament profile dropdowns to a folder (its Regular Print Settings).
 *
 * @param folder - The folder.
 * @param model - The object; its regular-print settings hold the choices.
 * @param visualizer - The Visualizer instance.
 */
export function addObjectProfileControls(folder: GUI, model: EverydayModel, visualizer: Visualizer): void {
  const make = (key: 'printProfile' | 'filamentProfile'): Dropdown => {
    const spec = REGULAR_SPECS[key];
    const controller = addDropdown(folder, model.regularConfig, key, choicesOf([], model.regularConfig[key], '')).name(spec.label);
    setTip(controller.domElement, spec.tip);
    return { controller, builtFor: '', tip: spec.tip };
  };
  objectDropdowns.set(model, { print: make('printProfile'), filament: make('filamentProfile') });
  refreshProfileControls(visualizer);
}

/**
 * Brings the dropdowns up to date: greyed out or not, and their choices for the printer profile.
 * Reads the bundle the first time PrusaSlicer is available.
 *
 * @param visualizer - The Visualizer instance.
 * @param available - Whether PrusaSlicer is available now. Left out, it stays as last told.
 */
export function refreshProfileControls(visualizer: Visualizer, available?: boolean): void {
  if (available !== undefined) state.available = available;
  if (state.available && !state.bundle && !state.loading) {
    state.loading = true;
    void loadVendorBundle().then(bundle => {
      state.loading = false;
      if (bundle) {
        state.bundle = bundle;
        refreshProfileControls(visualizer);
      }
    });
  }

  const printer = visualizer.config.prusaPrinterProfile;
  const choices = state.bundle ? profileChoices(state.bundle, printer) : { printers: [], prints: [], filaments: [] };
  if (printerDropdown) rebuild(printerDropdown, choices.printers, printer, "not in PrusaSlicer's profiles", '');

  for (const [model, dropdowns] of objectDropdowns) {
    if (!visualizer.everydayModelList.includes(model)) {
      objectDropdowns.delete(model);
      continue;
    }
    rebuild(dropdowns.print, choices.prints, model.regularConfig.printProfile, 'not for this printer', printer);
    rebuild(dropdowns.filament, choices.filaments, model.regularConfig.filamentProfile, 'not for this printer', printer);
  }
}
