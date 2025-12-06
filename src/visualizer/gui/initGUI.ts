// src/visualizer/gui/initGUI.ts
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import tippy from 'tippy.js';
import initScene from '../renderer/initScene';
import Visualizer from '../Visualizer';
import * as THREE from 'three';
import { importSTLModel } from '../loaders/modelLoader';
import { generateFoamToolpath, generateNonplanarFoamToolpath, generateTrialToolpath } from '../toolpath/generateFoamToolpath';
import { sliceMeshIntoLayers } from '../utils/TreeSlicer';
import { exportPresetToFile, importPresetFromFile } from './presetManager';
import {EverydayModel} from '../types/modelTypes';
import { saveGcodeToFile } from '../toolpath/saveGcodeToFile';

/**
 * Represents the GUI elements created by initGUI.
 */
export interface InitGUIResult {
  gui: GUI;
  foamModelListFolder: GUI;        // Folder for foam models list.
  everydayModelListFolder: GUI;    // Folder for everyday models list.
  saveFolder: GUI;
  treeSlicerFolder: GUI;          // New folder for TreeSlicer operations
  presetFolder: GUI;    
}

/**
 * Initializes the GUI for the visualizer.
 *
 * This function creates a new GUI, sets a custom title, adds folders for foam models and everyday models,
 * and sets up various parameter folders. It returns an object containing the new GUI instance along with
 * references to the foam and everyday model list folders.
 *
 * @param visualizer - An instance of Visualizer (exported as default from Visualizer.ts).
 * @returns An object containing { gui, foamModelListFolder, everydayModelListFolder }.
 */
export default function initGUI(visualizer: Visualizer): InitGUIResult {

  console.log('initGUI function called');
  // Create a new GUI instance.
  const gui = new GUI();
  // Change the top-level GUI title.
  const titleElement = gui.domElement.querySelector('.title');
  console.log('Title Element:', titleElement);
  if (titleElement) {
    titleElement.textContent = 'SMART FOAM SOFTWARE';
    titleElement.classList.add('lil-gui-1st-title');
  }

  // ----- Foam Slicing Model Folder -----
  const modelFolder = gui.addFolder('Models for Foam Slicing');
  const modelFolderTitle = modelFolder.domElement.querySelector('.title') as HTMLElement;
  if (modelFolderTitle) {
    // cast to HTMLElement
    modelFolderTitle.classList.add('lil-gui-2nd-title');
    // Add an icon to the title.
    modelFolderTitle.innerHTML = `<img src="./assets/icons/foam_model.svg" alt="icon" class="lil-gui-icon" />` + modelFolderTitle.innerHTML;
    modelFolderTitle.style.pointerEvents = 'auto';
    // Initialize tooltip using Tippy.js.
    tippy(modelFolderTitle, {
      content: 'models to be printed with foam structure',
      placement: 'right',
      theme: 'light-border',
      interactive: true,
      arrow: true,
    });
  }
  const foamModelListFolder = modelFolder.addFolder('foam model list');
  const importControls = {
    importFoamModel: () => importSTLModel(visualizer, 'foam'),
    importEverydayModel: () => importSTLModel(visualizer, 'everyday'),
  };
  foamModelListFolder.add(importControls, 'importFoamModel').name('Import Foam STL Model');

  const foamModelSliceParamFolder = modelFolder.addFolder('slice params');
  foamModelSliceParamFolder.close();
  modelFolder.close();
  // (Additional slice parameter controls can be added here.)

  // ----- Everyday Object Model Folder -----
  const everydayModelFolder = gui.addFolder('Everyday Object Models');
  const everydayModelFolderTitle = everydayModelFolder.domElement.querySelector('.title') as HTMLElement;
  if (everydayModelFolderTitle) {
    everydayModelFolderTitle.classList.add('lil-gui-2nd-title');
    everydayModelFolderTitle.innerHTML = `<img src="./assets/icons/bottle.svg" alt="icon" class="lil-gui-icon" />` + everydayModelFolderTitle.innerHTML;
    everydayModelFolderTitle.style.pointerEvents = 'auto';
    tippy(everydayModelFolderTitle, {
      content: 'models to be printed with foam structure',
      placement: 'right',
      theme: 'light-border',
      interactive: true,
      arrow: true,
    });
  }
  const everydayModelListFolder = everydayModelFolder.addFolder('everyday object model list');
  everydayModelListFolder.add(importControls, 'importEverydayModel').name('Import Everyday STL Model!');



  // const displayFolder = everydayModelFolder.addFolder('display');
  // displayFolder.add(visualizer.config, 'objectWireframe');
  // displayFolder.add(visualizer.config, 'objectBoundingBox')
  //   .onChange(toggleObjectBoundingBoxVisibility.bind(visualizer));
  // displayFolder.add(visualizer.config, 'selectBoundingBox')
  //   .onChange((v: boolean) => {
  //     if (v) {
  //       visualizer.scene.add(visualizer.selectedRegularFoamMeshBoundingBoxHelper);
  //     } else {
  //       visualizer.scene.remove(visualizer.selectedRegularFoamMeshBoundingBoxHelper);
  //     }
  //   });
  // displayFolder.close();

  const presetFolder = gui.addFolder('Presets');
  presetFolder.add({ exportPreset: () => {
    if (!visualizer.currentSelectedModel) {
      visualizer.currentSelectedModel = visualizer.everydayModelList[0];
      console.log("Set selected model to first model in list");
    }

    exportPresetToFile(visualizer)
  } }, 'exportPreset').name('Export Preset');


  presetFolder.add({ 
    importPreset: async () => {
      if (!visualizer.currentSelectedModel) {
        visualizer.currentSelectedModel = visualizer.everydayModelList[0];
        console.log("Set selected model to first model in list");
      }

      const filename = await importPresetFromFile(visualizer);
      gui.controllersRecursive().forEach(controller => {
        controller.updateDisplay();
      });
      
      const titleElement = presetFolder.domElement.querySelector('.title');
      if (titleElement && filename) {
        titleElement.textContent = `Presets (applied: ${filename})`;
      }
    }
  }, 'importPreset').name('Import Preset');

  // -----  Settings Folder -----
  const settingFolder = gui.addFolder('Settings');

  // Add additional folders for selection, display, printer settings, etc.
  const selectionFolder = settingFolder.addFolder('selection settings');
  selectionFolder.add(visualizer.config, 'toolMode', ['lasso', 'box']);
  selectionFolder.add(visualizer.config, 'selectionMode', ['centroid-visible', 'intersection', 'centroid']);
  selectionFolder.add(visualizer.config, 'selectModel');
  selectionFolder.add(visualizer.config, 'liveUpdate');
  selectionFolder.add(visualizer.config, 'selectWireframe');
  selectionFolder.close();

  const printerFolder = settingFolder.addFolder('printer settings');
  printerFolder.add(visualizer.config, 'bedTemp', 0, 110, 1)
    .onChange((v: number) => { visualizer.printer.material_bed_temperature = v; });
  printerFolder.add(visualizer.config, 'nozzleLeftTemp', 0, 260, 1)
    .onChange((v: number) => { visualizer.printer.print_temp_left_extruder = v; });
  printerFolder.add(visualizer.config, 'nozzleRightTemp', 0, 260, 1)
    .onChange((v: number) => { visualizer.printer.print_temp_right_extruder = v; });
  printerFolder.add(visualizer.config, 'machineDepth', 0, 1000, 1)
    .onChange((v: number) => {
      visualizer.printer.machine_depth = v;
      // Note: call to initScene here might need proper parameters.
      initScene(visualizer.scene, visualizer.printer, visualizer.printBaseObjects, { setLight: false, setPrintBase: true });
    });
  printerFolder.add(visualizer.config, 'machineDepthY', 0, 1000, 1)
    .onChange((v: number) => {
      visualizer.printer.machine_depth_y = v;
      // Note: call to initScene here might need proper parameters.
      initScene(visualizer.scene, visualizer.printer, visualizer.printBaseObjects, { setLight: false, setPrintBase: true });
    });
  printerFolder.add(visualizer.config, 'machineHeight', 0, 2000, 1)
    .onChange((v: number) => {
      visualizer.printer.machine_height = v;
      initScene(visualizer.scene, visualizer.printer, visualizer.printBaseObjects, { setLight: false, setPrintBase: true });
    });
  printerFolder.add(visualizer.config, 'dieSwelling', 0, 2, 0.01)
    .onChange((v: number) => { visualizer.printer.dieSwelling = v; });
  printerFolder.add(visualizer.config, 'nozzleDiameter', 0, 2, 0.01)
    .onChange((v: number) => { visualizer.printer.nozzleDiameter = v; });
  printerFolder.add(visualizer.config, 'filamentDiameter', 0, 5, 0.01)
    .onChange((v: number) => { visualizer.printer.diameter_filament = v; });
  printerFolder.add(visualizer.config, 'nozzleLength', 0, 100, 0.01)
    .onChange((v: number) => { visualizer.printer.nozzleLength = v; });
  printerFolder.add(visualizer.config, 'printHeadMinX', -100, 0, 0.01)
    .onChange((v: number) => { visualizer.printer.printHeadDims.min.setX(v); });
  printerFolder.add(visualizer.config, 'printHeadMinY', -100, 0, 0.01)
    .onChange((v: number) => { visualizer.printer.printHeadDims.min.setY(v); });
  printerFolder.add(visualizer.config, 'printHeadMaxX', 0, 100, 0.01)
    .onChange((v: number) => { visualizer.printer.printHeadDims.max.setX(v); });
  printerFolder.add(visualizer.config, 'printHeadMaxY', 0, 100, 0.01)
    .onChange((v: number) => { visualizer.printer.printHeadDims.max.setY(v); });

  printerFolder.close();

  const slicerFolder = settingFolder.addFolder('slicer settings');
  slicerFolder.add(visualizer.config, 'useFermatSpirals').onChange((v: boolean) => {visualizer.printer.useFermatSpirals = v});
  slicerFolder.add(visualizer.config, 'generateBoundary').onChange((v: boolean) => {visualizer.printer.generateBoundary = v});
  slicerFolder.add(visualizer.config, 'purgeLine').onChange((v: boolean) => {visualizer.printer.purgeLine = v});
  slicerFolder.add(visualizer.config, 'checkCollisions').onChange((v: boolean) => {visualizer.printer.checkCollisions = v});
  slicerFolder.add(visualizer.config, 'bedLeveling').onChange((v: boolean) => {visualizer.printer.bedLeveling = v});
  slicerFolder.add(visualizer.config, 'testSweep').onChange((v: boolean) => {visualizer.printer.testSweep = v});
  slicerFolder.close();
  
  const saveFolder = gui.addFolder('Saving');
  saveFolder.add({ saveGcode: () => {

    const gcode = visualizer.printer.build_start_gcode(1) + 
                  visualizer.everydayModelList.map(model => 
                    (model.outlineGcode || "") +  // Outline gcode
                    (model.gcode || "")            // Mesh gcode
                  ).join("\n; Moving to next model\n") + 
                  visualizer.printer.end_gcode;

    saveGcodeToFile(gcode, "toolpath")
  } }, 'saveGcode').name('Save Toolpath G-Code');
  
  saveFolder.close();
  

  // Create TreeSlicer folder
  const treeSlicerFolder = gui.addFolder('Foam Slicing');
  treeSlicerFolder.add({ sliceModel: () => {
    console.log('Slice Plate button clicked');

    const models: EverydayModel[] = visualizer.everydayModelList.map(model => model as EverydayModel);
    
    // Generate toolpath
    console.log('Generating toolpath...');
    const toolpath = generateFoamToolpath(visualizer, models);
    console.log('Generated toolpath:', toolpath);
    
    if (!toolpath || !toolpath.foam) {
        console.warn('Failed to generate toolpath. Please try again.');
        return;
    }
    
    // Create G-code
    console.log('Creating G-code...');
    const gcode = visualizer.printer.build_start_gcode(1) + 
                  visualizer.printer.generate_foam_gcode(toolpath.foam) + visualizer.printer.end_gcode + 
                  visualizer.printer.end_gcode;
    console.log('Generated G-code:', gcode);
    
    // Save G-code file
    console.log('Saving G-code file...');
    saveGcodeToFile(gcode, "toolpath");
    console.log('G-code file saved successfully');
  }}, 'sliceModel').name('Slice Plate');
  treeSlicerFolder.close();

  // Open the GUI.
  gui.open();

  return {
    gui,
    foamModelListFolder,
    everydayModelListFolder,
    saveFolder,
    treeSlicerFolder,
    presetFolder
  };
}
