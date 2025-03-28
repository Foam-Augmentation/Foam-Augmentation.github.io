// src/visualizer/gui/initGUI.ts
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import tippy from 'tippy.js';
import initScene from '../renderer/initScene';
import Visualizer from '../Visualizer';
import * as THREE from 'three';
import { importSTLModel } from '../loaders/modelLoader';

/**
 * Represents the GUI elements created by initGUI.
 */
export interface InitGUIResult {
  gui: GUI;
  foamModelListFolder: GUI;        // Folder for foam models list.
  everydayModelListFolder: GUI;    // Folder for everyday models list.
  saveFolder: GUI;
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
  printerFolder.add(visualizer.config, 'machineHeight', 0, 2000, 1)
    .onChange((v: number) => {
      visualizer.printer.machine_height = v;
      initScene(visualizer.scene, visualizer.printer, visualizer.printBaseObjects, { setLight: false, setPrintBase: true });
    });
    printerFolder.add(visualizer.config, 'nozzleDiameter', 0, 2, 0.1)
    .onChange((v: number) => { visualizer.printer.nozzleDiameter = v; });


  
  printerFolder.close();
  // Update parameter calculation.
  // const updateParamCalculation = () => {
  //   visualizer.config.VStar = (visualizer.config.printHead_speed_when_foam / visualizer.config.extrusion_speed_when_foam).toFixed(2);
  //   visualizer.config.HStar = (visualizer.config.zOffset / (visualizer.config.nozzleDiameter * visualizer.config.dieSwelling)).toFixed(2);
  // };
  // updateParamCalculation();

  // adding a save folder for the save gcode for the toolpath output

  const paramsFolder = settingFolder.addFolder('parameters');
  paramsFolder.add(visualizer.config, 'VStar', 0, 2000, 0.01)
    .onChange((v: number) => {
      visualizer.printer.V_Star = v;
      visualizer.config.VStar = v;
    });
  paramsFolder.add(visualizer.config, 'Edot', 0, 2000, 0.01)
    .onChange((v: number) => {
      visualizer.printer.Edot = v;
      visualizer.config.Edot = v;
  });
  paramsFolder.add(visualizer.config, 'diameter_filament', 0, 2000, 0.01)
  .onChange((v: number) => {
    visualizer.printer.diameter_filament = v;
    visualizer.config.diameter_filament = v;
});

paramsFolder.add(visualizer.config, 'zOffset', 0, 2000, 0.01)
.onChange((v: number) => {
  visualizer.printer.ZOffset = v;
  visualizer.config.zOffset = v;
});

paramsFolder.add(visualizer.config, 'deltaZ', 0, 2000, 0.01)
.onChange((v: number) => {
  visualizer.printer.deltaZ = v;
  visualizer.config.deltaZ = v;
});
// layer height
// H Star
// Z Offset

paramsFolder.add(visualizer.config, 'extrusion_m', 0, 2000, 0.01)
.onChange((v: number) => {
  visualizer.printer.extrusion_m = v;
  visualizer.config.extrusion_m = v;
});

paramsFolder.add(visualizer.config, 'HStar', 0, 2000, 0.01)
.onChange((v: number) => {
  visualizer.printer.H_star = v;
  visualizer.config.HStar = v;
});

  
  const saveFolder = gui.addFolder('Saving');
  saveFolder.add({ saveGcode: () => visualizer.saveToolpathGcodeToFile() }, 'saveGcode').name('Save Toolpath G-Code');
  saveFolder.close();
  

  // Open the GUI.
  gui.open();

  return {
    gui,
    foamModelListFolder,
    everydayModelListFolder,
    saveFolder
  };
}
