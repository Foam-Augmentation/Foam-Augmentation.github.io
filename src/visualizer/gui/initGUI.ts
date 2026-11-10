// src/visualizer/gui/initGUI.ts
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import Visualizer from '../Visualizer';
import { importSTLModel } from '../loaders/modelLoader';
import { exportPresetToFile, importPresetFromFile } from './presetManager';
import { addExtrudersFolder, refreshExtruderFolders } from './extruderSettings';
import { refreshModelControls } from './refreshModelGUIList';
import { addButton, addFolderWithTip, addParam, folderTitleElement, initTooltips, setTip } from './guiHelpers';
import { SETTING_SPECS, SettingKey } from './paramSpecs';

/**
 * Represents the GUI elements created by initGUI.
 */
export interface InitGUIResult {
  gui: GUI;
  foamModelListFolder: GUI;        // Folder for foam models list.
  everydayModelListFolder: GUI;    // Folder the settings of each object are built into.
  presetFolder: GUI;
}

/**
 * Adds an icon in front of a top-level folder's title and gives the title its heading style.
 *
 * @param folder - The folder to decorate.
 * @param iconUrl - URL of the icon image.
 */
function decorateSectionTitle(folder: GUI, iconUrl: string): void {
  const title = folderTitleElement(folder);
  if (!title) return;
  title.classList.add('lil-gui-2nd-title');
  const icon = document.createElement('img');
  icon.src = iconUrl;
  icon.alt = '';
  icon.className = 'lil-gui-icon';
  title.prepend(icon);
}

/**
 * Initializes the GUI for the visualizer.
 *
 * The panel is the settings side of the window: it shows the settings of the object that is
 * selected in the object list (see objectList.ts), followed by presets and the global
 * printer and slicer settings. Adding objects and exporting G-code live in the object list.
 *
 * @param visualizer - An instance of Visualizer (exported as default from Visualizer.ts).
 * @returns The GUI instance and the folders other code needs to reach.
 */
export default function initGUI(visualizer: Visualizer): InitGUIResult {
  // Create a new GUI instance.
  const gui = new GUI({ title: 'AugPrint Foam Slicer' });
  folderTitleElement(gui)?.classList.add('lil-gui-1st-title');

  const importControls = {
    importFoamModel: () => importSTLModel(visualizer, 'foam'),
  };

  // ----- 1. Selected Object: the settings of the object picked in the object list -----
  // Every object's folder is built into this folder (see refreshModelGUIList); only the
  // selected one is shown (see style.css).
  const everydayModelFolder = addFolderWithTip(
    gui,
    'Selected Object',
    'Settings of the object that is selected in the Objects list on the right, or by clicking it in the 3D view.'
  );
  decorateSectionTitle(everydayModelFolder, './assets/icons/bottle.svg');
  const everydayModelListFolder = everydayModelFolder;

  // Shown in place of the settings while no object is selected.
  const noSelectionNote = document.createElement('div');
  noSelectionNote.className = 'no-selection-note';
  noSelectionNote.textContent = 'Select an object in the Objects list on the right, or click it in the 3D view, to edit its settings.';
  everydayModelFolder.$children.prepend(noSelectionNote);

  // ----- 2. Models for Foam Slicing -----
  // Hidden: nothing reads this list (slicing uses the objects above), so showing it only
  // offered an import that led nowhere. The folder is kept because the model code refers to it.
  const modelFolder = addFolderWithTip(
    gui,
    'Models for Foam Slicing',
    'Models to be printed with a foam structure.'
  );
  decorateSectionTitle(modelFolder, './assets/icons/foam_model.svg');
  const foamModelListFolder = modelFolder;
  addButton(
    modelFolder,
    'Import Foam STL Model',
    'Load an STL file. It is placed in the middle of the print bed.',
    importControls.importFoamModel
  );
  modelFolder.close();
  modelFolder.hide();

  // ----- 3. Presets -----
  // Assigned further down, once the printer settings folder exists. Importing a preset can change
  // the extruder count, so the import handler needs to be able to rebuild these folders.
  let extrudersFolder: GUI | undefined;

  const presetFolder = addFolderWithTip(
    gui,
    'Presets',
    'Save every setting and model parameter to a file, or load them back.'
  );
  addButton(
    presetFolder,
    'Export Preset',
    'Download all settings, plus the parameters of the selected (or first) everyday model, as a text file.',
    () => exportPresetToFile(visualizer)
  );
  addButton(
    presetFolder,
    'Import Preset',
    'Load a preset file. Model parameters go to the selected everyday model, or to all of them if none is selected. A file with any invalid value is rejected as a whole.',
    async () => {
      const filename = await importPresetFromFile(visualizer);
      if (!filename) return;

      // The preset may have added or removed extruders, so rebuild those folders before refreshing.
      if (extrudersFolder) {
        refreshExtruderFolders(visualizer, extrudersFolder);
      }
      gui.controllersRecursive().forEach(controller => {
        controller.updateDisplay();
      });
      refreshModelControls(visualizer);

      const titleElement = folderTitleElement(presetFolder);
      if (titleElement) {
        titleElement.textContent = `Presets (Applied: ${filename})`;
      }
    }
  );
  presetFolder.close();

  // ----- 4. Settings -----
  const settingFolder = addFolderWithTip(gui, 'Settings', 'Selection, printer and slicer settings.');

  // Every setting is edited on visualizer.config and then mirrored onto the printer in one go.
  const syncPrinter = () => visualizer.syncConfigToPrinter();
  const syncPrinterAndRedrawBed = () => {
    visualizer.syncConfigToPrinter();
    visualizer.rebuildPrintBase();
  };
  /** Adds controls for the given config keys, each with the given change handler. */
  const addSettings = (folder: GUI, keys: SettingKey[], onChange?: () => void) => {
    keys.forEach(key => {
      const controller = addParam(folder, visualizer.config, key, SETTING_SPECS[key]);
      if (onChange) controller.onChange(onChange);
    });
  };

  const selectionFolder = addFolderWithTip(
    settingFolder,
    'Selection Settings',
    'How drawing on the canvas selects part of a model, once “Select Foam Area” or “Select Sensing Area” is pressed.'
  );
  addSettings(selectionFolder, ['toolMode', 'selectionMode', 'selectModel', 'liveUpdate', 'selectWireframe']);
  selectionFolder.close();

  const printerFolder = addFolderWithTip(
    settingFolder,
    'Printer Settings',
    'The printer: bed, print space, filament, print head and extruders.'
  );
  // Printer and slicer settings shape the toolpath, so an edit refreshes the previews.
  const refreshPreviews = () => visualizer.scheduleToolpathRefresh();
  printerFolder.onFinishChange(refreshPreviews);
  addSettings(printerFolder, ['bedTemp'], syncPrinter);
  addSettings(printerFolder, ['machineDepth', 'machineDepthY', 'machineHeight'], syncPrinterAndRedrawBed);
  addSettings(
    printerFolder,
    ['filamentDiameter', 'printHeadMinX', 'printHeadMinY', 'printHeadMaxX', 'printHeadMaxY', 'multipleToolheads', 'purgeTower'],
    syncPrinter
  );

  // Per-extruder parameters, plus the button to add another extruder.
  extrudersFolder = addExtrudersFolder(visualizer, printerFolder);

  printerFolder.close();

  const slicerFolder = addFolderWithTip(
    settingFolder,
    'Slicer Settings',
    'How toolpaths and G-code are generated.'
  );
  addSettings(
    slicerFolder,
    ['useFermatSpirals', 'generateBoundary', 'purgeLine', 'checkCollisions', 'bedLeveling', 'testSweep'],
    syncPrinter
  );
  slicerFolder.onFinishChange(refreshPreviews);
  slicerFolder.close();
  settingFolder.close();

  // Turn on tooltips for every control in the panel, including ones added later.
  initTooltips(gui.domElement);

  // Open the GUI.
  gui.open();

  return {
    gui,
    foamModelListFolder,
    everydayModelListFolder,
    presetFolder
  };
}
