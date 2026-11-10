// src/visualizer/gui/initGUI.ts
import { GUI, Controller } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import Visualizer from '../Visualizer';
import { importSTLModel } from '../loaders/modelLoader';
import { saveAugmentGcode, slicePlateAndSave } from '../toolpath/gcodeActions';
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
  everydayModelListFolder: GUI;    // Folder for everyday models list.
  saveFolder: GUI;                 // Folder for the "Save Toolpath G-Code" action.
  treeSlicerFolder: GUI;          // Folder for the "Slice Plate" action.
  presetFolder: GUI;
  saveButton: Controller;          // The "Save Toolpath G-Code" button.
  sliceButton: Controller;         // The "Slice Plate" button.
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
 * The panel starts with the job (augment an object, or print a model as foam). Below it the
 * folders follow the order of the workflow: import models (and, inside each model, set its
 * parameters and select the area to cover), then the one action that finishes the chosen job
 * (save the G-code, or slice the plate), and finally presets and settings.
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
    importEverydayModel: () => importSTLModel(visualizer, 'everyday'),
  };

  // ----- 0. Job: which of the two workflows the panel shows -----
  const jobController = gui
    .add(visualizer, 'job', { 'Augment an Object': 'augment', 'Print a Foam Model': 'foam' })
    .name('Job')
    .onChange(() => visualizer.applyJob());
  setTip(
    jobController.domElement,
    'Augment an Object: print foam onto part of an existing object. Select an area on the model, then save the G-code. ' +
    'Print a Foam Model: print the whole model as foam with Slice Plate.'
  );

  // ----- 1. Models: import, parameters and area selection per model -----
  // The model folders are added straight into this folder (see refreshModelGUIList).
  const everydayModelFolder = addFolderWithTip(
    gui,
    'Models',
    'The object to print foam on, or the model to print as foam. Import an STL (or drop one on the window), then set its parameters.'
  );
  decorateSectionTitle(everydayModelFolder, './assets/icons/bottle.svg');
  const everydayModelListFolder = everydayModelFolder;
  const importButton = addButton(
    everydayModelFolder,
    'Import STL Model',
    'Load an STL file. It is placed in the middle of the print bed. STL files can also be dropped on the window.',
    importControls.importEverydayModel
  );

  // ----- 2. Models for Foam Slicing -----
  // Hidden: nothing reads this list (Slice Plate slices the models above), so showing it only
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

  // ----- 3. Foam Slicing and 4. Save G-Code -----
  // Created here so they sit in workflow order; their buttons are added further down.
  const treeSlicerFolder = addFolderWithTip(
    gui,
    'Foam Slicing',
    'Slice the models on the plate into a foam toolpath.'
  );
  const saveFolder = addFolderWithTip(
    gui,
    'Save G-Code',
    'Download the G-code of the toolpaths generated by selecting areas.'
  );

  // ----- 5. Presets -----
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

  // ----- 6. Settings -----
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

  // ----- Save G-Code button (folder created above) -----
  // Every model's toolpath and G-code body is generated at save time, in one pass (see gcodeActions.ts).
  const saveButton = saveFolder
    .add({ saveGcode: () => saveAugmentGcode(visualizer) }, 'saveGcode')
    .name('Save Toolpath G-Code') as unknown as Controller;

  // ----- Slice Plate button (folder created above) -----
  const sliceButton = treeSlicerFolder
    .add({ sliceModel: () => slicePlateAndSave(visualizer) }, 'sliceModel')
    .name('Slice Plate') as unknown as Controller;

  // The action that finishes each job, and importing a model, are the panel's main buttons.
  saveButton.domElement.classList.add('primary-action');
  sliceButton.domElement.classList.add('primary-action');
  importButton.domElement.classList.add('primary-action');

  // Tooltips for the two buttons above (looked up by position so their handlers stay untouched).
  setTip(
    saveFolder.controllers[0]?.domElement,
    'Download one G-code file with the toolpath of every model that has a selected area. Enabled once an area is selected.'
  );
  setTip(
    treeSlicerFolder.controllers[0]?.domElement,
    'Slice every model on the plate, show the toolpath and download the G-code. Enabled once a model is imported. Large models can take a while.'
  );

  // Turn on tooltips for every control in the panel, including ones added later.
  initTooltips(gui.domElement);

  // Open the GUI.
  gui.open();

  return {
    gui,
    foamModelListFolder,
    everydayModelListFolder,
    saveFolder,
    treeSlicerFolder,
    presetFolder,
    saveButton,
    sliceButton
  };
}
