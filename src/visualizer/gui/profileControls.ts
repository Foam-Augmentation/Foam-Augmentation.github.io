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
import { printerMachine, profileChoices, type VendorBundle } from '../toolpath/prusaProfiles';
import { forgetVendorBundle, loadVendorBundle } from '../toolpath/prusaSlicer';
import { setTip } from './guiHelpers';
import { notify } from './notify';
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
  /**
   * Counts the PrusaSlicer installs the bundle was read for. A read that ends after another
   * install was located is of the old one, and is dropped.
   */
  install: 0,
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
    applyPrinterMachine(visualizer, visualizer.config.prusaPrinterProfile);
    visualizer.syncConfigToPrinter();
    refreshProfileControls(visualizer);
  };
  controller.onChange(onChange);
  printerDropdown = { controller, builtFor: '', tip: spec.tip, onChange };
  refreshProfileControls(visualizer);
}

/**
 * Makes Printer Settings match a printer profile the user picked: the bed size and print height,
 * each extruder's nozzle, and whether the printer is a tool changer (an XL; that also picks the
 * XL's start G-code and machine limits). Says what changed, and warns where the app cannot follow
 * the printer. Only a pick does this: a preset brings its own Printer Settings.
 *
 * @param visualizer - The Visualizer instance.
 * @param name - The printer profile.
 */
function applyPrinterMachine(visualizer: Visualizer, name: string): void {
  const machine = state.bundle && name ? printerMachine(state.bundle, name) : undefined;
  if (!machine) return;
  const config = visualizer.config;
  config.machineDepth = machine.bed.x;
  config.machineDepthY = machine.bed.y;
  config.machineHeight = machine.bed.height;
  // An extruder past the printer's last tool gets the last tool's nozzle.
  config.extruders.forEach((extruder, i) => {
    extruder.nozzleDiameter = machine.nozzles[Math.min(i, machine.nozzles.length - 1)];
  });
  if (machine.family) config.multipleToolheads = machine.family === 'XL';
  visualizer.syncConfigToPrinter();
  visualizer.rebuildPrintBase();
  visualizer.gui?.controllersRecursive().forEach(controller => controller.updateDisplay());
  visualizer.scheduleToolpathRefresh();

  const tools = machine.nozzles.length;
  const sizes = [...new Set(machine.nozzles)].join(' and ');
  const nozzles = tools === 1 ? `a ${sizes} mm nozzle` : `${tools} tools with ${sizes} mm nozzles`;
  notify(`Printer Settings now match “${name}”: a ${machine.bed.x} × ${machine.bed.y} mm bed, ${machine.bed.height} mm high, and ${nozzles}.`, 'info');
  if (!machine.family) {
    notify(`The app's own G-code (start, foam, purge and end) is written for the Prusa XL or MK3S, not for “${name}”. Multiple Toolheads was left as it was; check the G-code before printing.`, 'warning');
  } else if (machine.family === 'XL' && config.extruders.length > tools) {
    notify(`“${name}” has ${tools === 1 ? 'one tool' : `${tools} tools`}, but Printer Settings has ${config.extruders.length} extruders. Remove the extra extruders, or pick the XL with more tools.`, 'warning');
  }
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
 * Tells the dropdowns whether PrusaSlicer is available (they are greyed out without it), and
 * brings them up to date.
 *
 * @param visualizer - The Visualizer instance.
 * @param available - Whether PrusaSlicer is available now.
 */
export function setProfileControlsAvailable(visualizer: Visualizer, available: boolean): void {
  state.available = available;
  refreshProfileControls(visualizer);
}

/**
 * Reads PrusaSlicer's profiles again and brings the dropdowns up to date. For when another
 * PrusaSlicer was located: the choices are the ones of the install that is used now.
 *
 * @param visualizer - The Visualizer instance.
 */
export function reloadProfileControls(visualizer: Visualizer): void {
  forgetVendorBundle();
  state.bundle = null;
  // A read that is still under way is of the old install: it is dropped when it ends, and the
  // refresh below starts one of the new install right away.
  state.install++;
  state.loading = false;
  refreshProfileControls(visualizer);
}

/**
 * Brings the dropdowns up to date: greyed out or not, and their choices for the printer profile.
 * Reads the bundle the first time PrusaSlicer is available.
 *
 * @param visualizer - The Visualizer instance.
 */
export function refreshProfileControls(visualizer: Visualizer): void {
  if (state.available && !state.bundle && !state.loading) {
    state.loading = true;
    const install = state.install;
    void loadVendorBundle().then(bundle => {
      if (install !== state.install) return;
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
