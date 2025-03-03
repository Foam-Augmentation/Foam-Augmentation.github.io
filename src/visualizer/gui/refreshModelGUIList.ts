import * as THREE from 'three';
import { updateEscDiv } from './bottomTooltip';
import { visualize_All_Layers, generateFoamToolpath } from '../toolpath/generateFoamToolpath';
import { sampleSelectedMesh } from '../toolpath/sampleSelectedMesh';

// Extend Object3D to include highlightFoamMesh and highlightSenseMesh properties
declare module 'three' {
    interface Object3D {
        highlightFoamMesh?: THREE.Mesh;
        highlightSenseMesh?: THREE.Mesh;
    }
}

import { MeshBVH } from 'three-mesh-bvh';

// Extend BufferGeometry to include boundsTree property
declare module 'three' {
    interface BufferGeometry {
        boundsTree?: MeshBVH;
    }
}

import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import Visualizer from '../Visualizer';
import { EverydayModel, FoamModel } from '../types/modelTypes';

/**
 * Creates a delete button element for a given model object.
 * When clicked, it removes the model from the scene and refreshes both GUI lists.
 *
 * @param modelObj - The model object to delete.
 * @param index - The index of the model object in the list.
 * @param visualizer - The Visualizer instance.
 * @param itemClass - The CSS class used to identify the model type folder.
 * @returns The HTML span element acting as the delete button.
 */
function createDeleteBtn(
    modelObj: EverydayModel | FoamModel,
    index: number,
    visualizer: Visualizer,
    itemClass: string
): HTMLSpanElement {
    const deleteBtn = document.createElement('span');
    deleteBtn.innerHTML = `<img src="./assets/icons/delete.svg" alt="delete" class="delete-icon" />`;
    deleteBtn.style.cursor = 'pointer';
    deleteBtn.style.marginRight = '10px';
    deleteBtn.style.marginLeft = '10px';
    deleteBtn.title = 'delete';
    deleteBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation(); // Prevent event bubbling to GUI selection events

        // If TransformControls is attached to this model, detach it.
        if (visualizer.transformControls.object === modelObj.mesh) {
            visualizer.transformControls.detach();
            updateEscDiv(visualizer.transformControls);
        }

        // Remove the model's mesh and any associated highlights or auxiliary meshes.
        visualizer.scene.remove(modelObj.mesh);
        if ('highlightFoamMesh' in modelObj && modelObj.highlightFoamMesh) {
            visualizer.scene.remove(modelObj.highlightFoamMesh);
        }
        if ('highlightSenseMesh' in modelObj && modelObj.highlightSenseMesh) {
            visualizer.scene.remove(modelObj.highlightSenseMesh);
        }
        if ('pointsMesh_foam' in modelObj && modelObj.pointsMesh_foam) {
            visualizer.scene.remove(modelObj.pointsMesh_foam);
        }
        if ('pointsMesh_sense' in modelObj && modelObj.pointsMesh_sense) {
            visualizer.scene.remove(modelObj.pointsMesh_sense);
        }
        if ('toolpathVisualizationObject' in modelObj && modelObj.toolpathVisualizationObject) {
            visualizer.scene.remove(modelObj.toolpathVisualizationObject);
        }

        // Remove the model from the corresponding list.
        if (itemClass === 'foam-model-item') {
            visualizer.foamModelList.splice(index, 1);
        } else {
            visualizer.everydayModelList.splice(index, 1);
        }

        // Refresh both GUI lists.
        refreshModelGUIList(visualizer, 'foam');
        refreshModelGUIList(visualizer, 'everyday');
    });
    return deleteBtn;
}

/**
 * Adds a transform folder to a model's GUI item.
 * This folder includes a dropdown to select the transform type and controllers for the X, Y, and Z values.
 *
 * @param modelGUIitem - The GUI folder for the model.
 * @param modelObj - The model object.
 * @param visualizer - The Visualizer instance.
 */
function addTransformFolder(
    modelGUIitem: GUI,
    modelObj: EverydayModel | FoamModel,
    visualizer: Visualizer
): void {
    const transformFolder = modelGUIitem.addFolder('transform');
    transformFolder.domElement.classList.add('transform-folder');

    const transformType = { type: 'move' };
    modelObj.transformType = 'move';
    const transformTypeController = transformFolder.add(transformType, 'type', ['move', 'rotate', 'scale']);

    // Create objects for transform values.
    const transformX = { x: modelObj.mesh.position.x };
    const transformY = { y: modelObj.mesh.position.y };
    const transformZ = { z: modelObj.mesh.position.z };
    modelObj.transformX = transformX;
    modelObj.transformY = transformY;
    modelObj.transformZ = transformZ;
    const transformXController = transformFolder.add(transformX, 'x').name('X').listen();
    const transformYController = transformFolder.add(transformY, 'y').name('Y').listen();
    const transformZController = transformFolder.add(transformZ, 'z').name('Z').listen();

    // Update the transform type and corresponding controller values on change.
    transformTypeController.onChange((value: string) => {
        modelObj.transformType = value as 'move' | 'rotate' | 'scale';
        switch (value) {
            case 'move':
                transformX.x = modelObj.mesh.position.x;
                transformY.y = modelObj.mesh.position.y;
                transformZ.z = modelObj.mesh.position.z;
                visualizer.transformControls.setMode('translate');
                break;
            case 'rotate':
                transformX.x = modelObj.mesh.rotation.x;
                transformY.y = modelObj.mesh.rotation.y;
                transformZ.z = modelObj.mesh.rotation.z;
                visualizer.transformControls.setMode('rotate');
                break;
            case 'scale':
                transformX.x = modelObj.mesh.scale.x;
                transformY.y = modelObj.mesh.scale.y;
                transformZ.z = modelObj.mesh.scale.z;
                visualizer.transformControls.setMode('scale');
                break;
        }
    });

    // Update model's mesh properties when the controllers change.
    transformXController.onChange((value: number) => {
        if (transformType.type === 'move') {
            modelObj.mesh.position.x = value;
        } else if (transformType.type === 'rotate') {
            modelObj.mesh.rotation.x = value;
        } else if (transformType.type === 'scale') {
            modelObj.mesh.scale.x = value;
        }
    });
    transformYController.onChange((value: number) => {
        if (transformType.type === 'move') {
            modelObj.mesh.position.y = value;
        } else if (transformType.type === 'rotate') {
            modelObj.mesh.rotation.y = value;
        } else if (transformType.type === 'scale') {
            modelObj.mesh.scale.y = value;
        }
    });
    transformZController.onChange((value: number) => {
        if (transformType.type === 'move') {
            modelObj.mesh.position.z = value;
        } else if (transformType.type === 'rotate') {
            modelObj.mesh.rotation.z = value;
        } else if (transformType.type === 'scale') {
            modelObj.mesh.scale.z = value;
        }
    });
    transformFolder.close();
}

/**
 * Adds a mesh selection folder to a model's GUI item.
 * This folder provides buttons for selecting either the regular foam area or the sense area.
 *
 * @param modelGUIitem - The GUI folder for the model.
 * @param modelObj - The everyday model object.
 * @param visualizer - The Visualizer instance.
 */
function addSelectedMeshFolder(
    modelGUIitem: GUI,
    modelObj: EverydayModel,
    visualizer: Visualizer
): void {
    const selectedMeshFolder = modelGUIitem.addFolder('mesh selection');
    selectedMeshFolder.domElement.classList.add('mesh-selection-folder');

    /**
     * Selects the regular foam mesh for the model.
     *
     * @param modelObj - The everyday model object.
     */
    const selectFoamMesh = (modelObj: EverydayModel): void => {
        if (!modelObj.mesh.geometry.boundsTree) {
            modelObj.mesh.geometry.boundsTree = new MeshBVH(modelObj.geometry);
        }
        visualizer.current_Obj = modelObj;
        visualizer.current_selection_type = 'foam';
        if (!modelObj.highlightFoamMesh) {
            modelObj.highlightFoamMesh = new THREE.Mesh();
            modelObj.highlightFoamMesh.geometry = modelObj.mesh.geometry.clone();
            modelObj.highlightFoamMesh.geometry.drawRange.count = 0;
            modelObj.highlightFoamMesh.material = new THREE.MeshBasicMaterial({
                opacity: 0.3,
                transparent: true,
                depthWrite: false,
                wireframe: false,
            });
            (modelObj.highlightFoamMesh.material as THREE.MeshBasicMaterial)
                .color.set(0xff9800)
                .convertSRGBToLinear();
            modelObj.highlightFoamMesh.renderOrder = 2;
            modelObj.highlightFoamMesh.position.copy(modelObj.mesh.position);
            modelObj.highlightFoamMesh.rotation.copy(modelObj.mesh.rotation);
            modelObj.highlightFoamMesh.scale.copy(modelObj.mesh.scale);
            visualizer.scene.add(modelObj.highlightFoamMesh);
        }
    };

    /**
     * Selects the sense mesh for the model.
     *
     * @param modelObj - The everyday model object.
     */
    const selectSenseMesh = (modelObj: EverydayModel): void => {
        if (!modelObj.mesh.geometry.boundsTree) {
            modelObj.mesh.geometry.boundsTree = new MeshBVH(modelObj.geometry);
        }
        visualizer.current_Obj = modelObj;
        visualizer.current_selection_type = 'sense';
        if (!modelObj.highlightSenseMesh) {
            modelObj.highlightSenseMesh = new THREE.Mesh();
            modelObj.highlightSenseMesh.geometry = modelObj.mesh.geometry.clone();
            modelObj.highlightSenseMesh.geometry.drawRange.count = 0;
            modelObj.highlightSenseMesh.material = new THREE.MeshBasicMaterial({
                opacity: 0.6,
                transparent: true,
                depthWrite: false,
                wireframe: false,
            });
            (modelObj.highlightSenseMesh.material as THREE.MeshBasicMaterial)
                .color.set(0x000000)
                .convertSRGBToLinear();
            modelObj.highlightSenseMesh.renderOrder = 1;
            modelObj.highlightSenseMesh.position.copy(modelObj.mesh.position);
            modelObj.highlightSenseMesh.rotation.copy(modelObj.mesh.rotation);
            modelObj.highlightSenseMesh.scale.copy(modelObj.mesh.scale);
            visualizer.scene.add(modelObj.highlightSenseMesh);
        }
    };

    const selectMeshBtn = {
        selectFoamMesh: () => selectFoamMesh(modelObj),
        selectSenseMesh: () => selectSenseMesh(modelObj)
    };

    /** select regular foam mesh folder */
    const selectRegularFoamMeshFolder = selectedMeshFolder.addFolder('select regular foam mesh');
    selectRegularFoamMeshFolder.add(selectMeshBtn, 'selectFoamMesh').name('Select Regular Foam Area');

    /** select sense foam mesh folder */
    const selectSenseMeshFolder = selectedMeshFolder.addFolder('select sense foam mesh');
    // add a drop down to selectSenseMeshFolder: selected mesh / geometry intersection
    const selectionType = { type: 'selected mesh' };
    const selectionTypeController = selectSenseMeshFolder.add(selectionType, 'type', ['selected mesh', 'geometry intersection']);

    selectionTypeController.onChange((value: string) => {
        if (value === 'selected mesh') {
            // Handle selected mesh logic
        } else if (value === 'geometry intersection') {
            // Handle geometry intersection logic
        }
    });

    selectSenseMeshFolder.add(selectMeshBtn, 'selectSenseMesh').name('Select Sense Foam Area');
    // selectSenseMeshFolder.add
}

/**
 * Adds a parameters folder to an everyday model's GUI item for toolpath configuration.
 * This folder includes controllers for various toolpath parameters such as deltaZ, zOffset, gridSize,
 * dieSwell, foam layer counts, extrusion speeds, print head speeds, temperatures, and nozzle sizes.
 *
 * @param modelGUIitem - The GUI folder for the model.
 * @param modelObj - The everyday model object.
 * @param visualizer - The Visualizer instance.
 */
export function addParamsFolder_EverydayModel(
    modelGUIitem: GUI,
    modelObj: EverydayModel,
    visualizer: Visualizer
): void {
    const paramsFolder = modelGUIitem.addFolder('params');
    paramsFolder.domElement.classList.add('params-folder');

    paramsFolder.add(modelObj.toolpathConfig, 'deltaZ', 0, 20, 0.1).name('Layer Thickness (deltaZ)').onChange(() => {
        visualize_All_Layers(visualizer, modelObj);
    });
    paramsFolder.add(modelObj.toolpathConfig, 'zOffset', 0, 50, 1).name('Nozzle Z Offset').onChange(() => {
        visualize_All_Layers(visualizer, modelObj);
    });
    paramsFolder.add(modelObj.toolpathConfig, 'gridSize', 1, 20, 1).name('Grid Size').onChange(() => {
        sampleSelectedMesh(visualizer, modelObj);
        generateFoamToolpath(visualizer, modelObj);
    });
    paramsFolder.add(modelObj.toolpathConfig, 'dieSwell', 1, 2, 0.01).name('Die Swell');
    paramsFolder.add(modelObj.toolpathConfig, 'initialFoamLayerCount', 0, 10, 1).name('Initial Foam Layers').onChange(() => {
        visualize_All_Layers(visualizer, modelObj);
    });
    paramsFolder.add(modelObj.toolpathConfig, 'middleSenseLayerCount', 0, 10, 1).name('Middle Sense Layers').onChange(() => {
        visualize_All_Layers(visualizer, modelObj);
    });
    paramsFolder.add(modelObj.toolpathConfig, 'finalFoamLayerCount', 0, 10, 1).name('Final Foam Layers').onChange(() => {
        visualize_All_Layers(visualizer, modelObj);
    });
    paramsFolder.add(modelObj.toolpathConfig, 'extrusionSpeedRegularFoam', 0, 1000, 1).name('Regular Foam Extrusion Speed');
    paramsFolder.add(modelObj.toolpathConfig, 'printHeadSpeedRegularFoam', 0, 1000, 1).name('Regular Foam Print Head Speed');
    paramsFolder.add(modelObj.toolpathConfig, 'printHeadTempRegularFoam', 0, 300, 1).name('Regular Foam Print Head Temp');
    paramsFolder.add(modelObj.toolpathConfig, 'nozzleSizeRegularFoam', 0, 5, 0.1).name('Regular Foam Nozzle Size');
    paramsFolder.add(modelObj.toolpathConfig, 'extrusionSpeedSensingFoam', 0, 1000, 1).name('Sensing Foam Extrusion Speed');
    paramsFolder.add(modelObj.toolpathConfig, 'printHeadSpeedSensingFoam', 0, 1000, 1).name('Sensing Foam Print Head Speed');
    paramsFolder.add(modelObj.toolpathConfig, 'printHeadTempSensingFoam', 0, 300, 1).name('Sensing Foam Print Head Temp');
    paramsFolder.add(modelObj.toolpathConfig, 'nozzleSizeSensingFoam', 0, 5, 0.1).name('Sensing Foam Nozzle Size');

    paramsFolder.close();
}


/**
 * Refreshes the model list displayed in the GUI.
 *
 * This function clears the existing GUI items for the specified model type and
 * creates new GUI folders and controllers for each model in the corresponding list.
 * It sets up delete buttons, transform folders, and—for everyday models—mesh selection
 * and parameter folders.
 *
 * @param visualizer - An instance of Visualizer that contains properties such as:
 *                     foamModelList, everydayModelList, foamModelListFolder, everydayModelListFolder,
 *                     scene, transformControls, uuid_to_modelObj_Map, etc.
 * @param listType - The type of model list to refresh; either 'foam' or 'everyday'.
 */
export function refreshModelGUIList(visualizer: Visualizer, listType: 'foam' | 'everyday'): void {
    let modelList: (EverydayModel | FoamModel)[] = [];
    let guiFolder: GUI;
    let itemClass: string = '';
    if (listType === 'foam') {
        modelList = visualizer.foamModelList;
        guiFolder = visualizer.foamModelListFolder;
        itemClass = 'foam-model-item';
    } else if (listType === 'everyday') {
        modelList = visualizer.everydayModelList;
        guiFolder = visualizer.everydayModelListFolder;
        itemClass = 'everyday-model-item';
    }

    // Clear existing GUI items with the specified item class.
    const items = document.querySelectorAll('.' + itemClass);
    items.forEach(item => item.remove());

    // Iterate over each model in the list and create a corresponding GUI folder.
    modelList.forEach((modelObj: EverydayModel | FoamModel, index: number) => {
        const modelGUIitem = guiFolder.addFolder(modelObj.name);
        modelGUIitem.domElement.classList.add(itemClass);
        // Bind the GUI item to the model object.
        modelObj.guiItem = modelGUIitem;

        // Append the delete button to the GUI title element.
        const titleElem = modelGUIitem.domElement.querySelector('.title');
        if (titleElem) {
            titleElem.appendChild(createDeleteBtn(modelObj, index, visualizer, itemClass));
        }

        // Add the transform folder.
        addTransformFolder(modelGUIitem, modelObj, visualizer);

        // For everyday models, add additional folders for mesh selection and parameters.
        if (listType === 'everyday') {
            addSelectedMeshFolder(modelGUIitem, modelObj as EverydayModel, visualizer);
            addParamsFolder_EverydayModel(modelGUIitem, modelObj as EverydayModel, visualizer);
        }
    });
}
