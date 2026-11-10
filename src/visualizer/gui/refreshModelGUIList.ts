import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { GUI, Controller } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import Visualizer from '../Visualizer';
import { EverydayModel } from '../types/modelTypes';
import { visualize_All_Layers } from '../toolpath/generateFoamToolpath';
import { addSensingIntersectionGeo } from '../toolpath/addSensingIntersectionGeo';
import { importAugmentSTL, importBumpMesh, importSvgGradient } from '../loaders/modelLoader';
import { AnyModel, disposeModel, syncAuxTransforms } from './modelActions';
import { addButton, addFolderWithTip, addParam, createDeleteButton, folderTitleElement, hideTooltips, setTip } from './guiHelpers';
import { INITIAL_OFFSET_SPEC, INITIAL_SPECS, KIND_SPEC, MODEL_SPECS, REGULAR_SPECS, InitialKey, ModelKey, RegularKey } from './paramSpecs';
import { notify } from './notify';

// Extend BufferGeometry to include boundsTree property
declare module 'three' {
    interface BufferGeometry {
        boundsTree?: MeshBVH;
    }
}

/** CSS class put on a control whose value differs from the matching foam parameter. */
const DIFFERS_CLASS = 'differs-from-foam';

/** Size of the box added by "Add Sensing Box", in mm. */
const SENSING_BOX_SIZE = 20;

/** Sensing parameter → the foam parameter it overrides. */
const SENSE_TO_FOAM: [ModelKey, ModelKey][] = [
    ['senseDeltaZ', 'deltaZ'],
    ['senseDeltaL', 'deltaL'],
    ['senseDeltaLEnd', 'deltaLEnd'],
    ['senseVStar', 'vStar'],
    ['SenseVStarEnd', 'vStarEnd'],
    ['senseHStar', 'hStar'],
    ['senseHStarEnd', 'hStarEnd'],
    ['senseEdot', 'edot'],
];

/** Initial-layer parameters that override the foam parameter of the same name. */
const INITIAL_OVERRIDES: InitialKey[] = [
    'deltaZ', 'deltaL', 'deltaLEnd', 'gridSize', 'vStar', 'vStarEnd', 'hStar', 'hStarEnd', 'edot',
];

/** Per model: re-evaluates which controls differ from the foam parameters. */
const differenceMarkUpdaters = new WeakMap<AnyModel, () => void>();

/**
 * Deletes a model after asking for confirmation, then refreshes both GUI lists.
 *
 * @param visualizer - The Visualizer instance.
 * @param modelObj - The model object to delete.
 */
export function confirmAndDeleteModel(visualizer: Visualizer, modelObj: AnyModel): void {
    const confirmed = window.confirm(
        `Delete “${modelObj.name}”?\n\nIts selections, parameters and generated toolpath are removed too. This cannot be undone.`
    );
    if (!confirmed) return;

    disposeModel(visualizer, modelObj);
    refreshModelGUIList(visualizer, 'foam');
    refreshModelGUIList(visualizer, 'everyday');
    notify(`Deleted “${modelObj.name}”.`, 'info');
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
    modelObj: AnyModel,
    visualizer: Visualizer
): void {
    const transformFolder = addFolderWithTip(modelGUIitem, 'Transform', 'Move, rotate or scale the model on the bed.');
    transformFolder.domElement.classList.add('transform-folder');

    const mesh = modelObj.mesh;

    // The X/Y/Z fields show whichever quantity the current mode edits.
    const transformX = modelObj.transformX ?? (modelObj.transformX = { x: mesh.position.x });
    const transformY = modelObj.transformY ?? (modelObj.transformY = { y: mesh.position.y });
    const transformZ = modelObj.transformZ ?? (modelObj.transformZ = { z: mesh.position.z });

    /** Copies the mesh's position, rotation or scale (per the current mode) into the fields. */
    const showCurrentValues = (): void => {
        switch (modelObj.transformType) {
            case 'move':
                transformX.x = mesh.position.x;
                transformY.y = mesh.position.y;
                transformZ.z = mesh.position.z;
                break;
            case 'rotate':
                transformX.x = THREE.MathUtils.radToDeg(mesh.rotation.x);
                transformY.y = THREE.MathUtils.radToDeg(mesh.rotation.y);
                transformZ.z = THREE.MathUtils.radToDeg(mesh.rotation.z);
                break;
            case 'scale':
                transformX.x = mesh.scale.x;
                transformY.y = mesh.scale.y;
                transformZ.z = mesh.scale.z;
                break;
        }
    };

    /** Writes one field back to the mesh and moves the auxiliary meshes along with it. */
    const applyAxis = (axis: 'x' | 'y' | 'z', value: number): void => {
        switch (modelObj.transformType) {
            case 'move':
                mesh.position[axis] = value;
                break;
            case 'rotate':
                mesh.rotation[axis] = THREE.MathUtils.degToRad(value);
                break;
            case 'scale':
                mesh.scale[axis] = value;
                break;
        }
        syncAuxTransforms(modelObj);
    };

    const modeController = transformFolder
        .add(modelObj, 'transformType', { 'Move (mm)': 'move', 'Rotate (°)': 'rotate', 'Scale (Factor)': 'scale' })
        .name('Mode');
    setTip(modeController.domElement, 'What the X, Y and Z fields and the on-canvas gizmo change: position, rotation or scale.');
    modeController.onChange((value: 'move' | 'rotate' | 'scale') => {
        showCurrentValues();
        // Only switch the gizmo if it is on this model; another model keeps its own mode.
        if (visualizer.transformControls.object === mesh) {
            visualizer.transformControls.setMode(value === 'move' ? 'translate' : value);
        }
    });

    const axisTip = 'Position in mm, rotation in degrees or scale factor, depending on Mode.';
    const xController = transformFolder.add(transformX, 'x').name('X').listen();
    const yController = transformFolder.add(transformY, 'y').name('Y').listen();
    const zController = transformFolder.add(transformZ, 'z').name('Z').listen();
    xController.onChange((value: number) => applyAxis('x', value));
    yController.onChange((value: number) => applyAxis('y', value));
    zController.onChange((value: number) => applyAxis('z', value));
    [xController, yController, zController].forEach(controller => setTip(controller.domElement, axisTip));

    addButton(transformFolder, 'Snap Model to Plate', 'Move the model down (or up) so it rests on the print bed.', () => {
        mesh.geometry.computeBoundingBox();
        const bbox = mesh.geometry.boundingBox!;
        mesh.position.setZ((bbox.max.z - bbox.min.z) * mesh.scale.z / 2);
        syncAuxTransforms(modelObj);
        showCurrentValues();
    });
    addButton(transformFolder, 'Center Model', 'Move the model to the middle of the print bed.', () => {
        mesh.position.setX(visualizer.printer.machine_depth / 2);
        mesh.position.setY(visualizer.printer.machine_depth_y / 2);
        syncAuxTransforms(modelObj);
        showCurrentValues();
    });

    showCurrentValues();
    transformFolder.close();
}

/**
 * Makes sure the model has the overlay mesh used to highlight a selected area, creating it
 * (lined up with the model, with nothing highlighted yet) if needed.
 *
 * @param visualizer - The Visualizer instance.
 * @param modelObj - The everyday model object.
 * @param kind - Which overlay: the foam area or the sensing area.
 */
function ensureHighlightMesh(visualizer: Visualizer, modelObj: EverydayModel, kind: 'foam' | 'sense'): void {
    if (!modelObj.mesh.geometry.boundsTree) {
        modelObj.mesh.geometry.boundsTree = new MeshBVH(modelObj.geometry);
    }
    if (kind === 'foam' ? modelObj.highlightFoamMesh : modelObj.highlightSenseMesh) {
        return;
    }

    const geometry = modelObj.mesh.geometry.clone();
    geometry.drawRange.count = 0;
    const material = new THREE.MeshBasicMaterial({
        opacity: kind === 'foam' ? 0.3 : 0.6,
        transparent: true,
        depthWrite: false,
        wireframe: false,
    });
    material.color.set(kind === 'foam' ? 0xff9800 : 0x000000).convertSRGBToLinear();

    const highlight = new THREE.Mesh(geometry, material);
    highlight.renderOrder = kind === 'foam' ? 2 : 1;
    if (kind === 'foam') {
        modelObj.highlightFoamMesh = highlight;
    } else {
        modelObj.highlightSenseMesh = highlight;
    }
    syncAuxTransforms(modelObj);
    visualizer.scene.add(highlight);
}

/**
 * Adds the area selection folder to a model's GUI item.
 * Its buttons arm selection of the foam area or the sensing area, or add a sensing box.
 *
 * @param modelGUIitem - The GUI folder for the model.
 * @param modelObj - The everyday model object.
 * @param visualizer - The Visualizer instance.
 */
function addSelectedMeshFolder(
    modelGUIitem: GUI,
    modelObj: EverydayModel,
    visualizer: Visualizer,
): void {
    const selectionFolder = addFolderWithTip(
        modelGUIitem,
        'Area Selection',
        'Choose which part of the model gets foam. The toolpath is generated from the current parameters as soon as an area is drawn.'
    );
    selectionFolder.domElement.classList.add('mesh-selection-folder');

    /** Sensing areas are sampled inside the foam area, so one has to exist first. */
    const hasFoamArea = (): boolean => {
        if (modelObj.selectedRegularFoamMesh) return true;
        notify('Select a foam area on this model first; sensing areas are placed inside it.', 'warning');
        return false;
    };

    const foamAreaButton = addButton(
        selectionFolder,
        'Select Foam Area',
        'Goes to the top view of the model and arms selection: drag over the model to mark where foam is printed. Press Esc when done.',
        () => {
            ensureHighlightMesh(visualizer, modelObj, 'foam');
            visualizer.armSelection(modelObj, 'foam');
        }
    );
    // The step that starts an augmentation, in the colour of the foam area it draws.
    foamAreaButton.domElement.classList.add('foam-action');
    addButton(
        selectionFolder,
        'Select Sensing Area',
        'Goes to the top view of the model and arms selection of a sensing area inside the foam area: drag over the model. Printed with the Sensing Parameters.',
        () => {
            if (!hasFoamArea()) return;
            ensureHighlightMesh(visualizer, modelObj, 'sense');
            visualizer.armSelection(modelObj, 'sense');
        }
    );
    addButton(
        selectionFolder,
        `Add Sensing Box (${SENSING_BOX_SIZE} mm)`,
        'Adds a box on top of the model. Drag it across the surface: the triangles inside it become sensing area.',
        () => {
            if (!hasFoamArea()) return;
            ensureHighlightMesh(visualizer, modelObj, 'sense');
            addSensingIntersectionGeo(modelObj, 'box', SENSING_BOX_SIZE, visualizer);
        }
    );
}

/**
 * Adds the three parameter folders to an everyday model's GUI item: the foam parameters, the
 * initial-layer parameters and the sensing parameters. Controls in the last two that differ
 * from the matching foam parameter are highlighted.
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
    const redrawLayers = (): void => visualize_All_Layers(visualizer, modelObj);

    // ----- foam parameters -----
    const paramsFolder = addFolderWithTip(
        modelGUIitem,
        'Foam Parameters',
        'The main print parameters, used for every foam layer after the initial layers.'
    );
    paramsFolder.domElement.classList.add('params-folder');

    const foamKeys: ModelKey[] = ['deltaZ', 'deltaL', 'deltaLEnd', 'gridSize', 'vStar', 'vStarEnd', 'hStar', 'hStarEnd', 'edot'];
    foamKeys.forEach(key => {
        const controller = addParam(paramsFolder, modelObj.toolpathConfig, key, MODEL_SPECS[key]);
        if (key === 'deltaZ') controller.onChange(redrawLayers);
    });

    // Controls that override a foam parameter, paired with a check for "differs from foam".
    const overrides: { controller: Controller; differs: () => boolean }[] = [];

    // ----- initial-layer parameters -----
    const paramsFolderInitial = addFolderWithTip(
        modelGUIitem,
        'Initial Layer Parameters',
        'Used instead of the Foam Parameters for the first few layers (see Initial Foam Layers). Highlighted values differ from the Foam Parameters.'
    );
    paramsFolderInitial.domElement.classList.add('params-folder-initial');

    addParam(paramsFolderInitial, modelObj.initialConfig, 'initialFoamLayerCount', INITIAL_SPECS.initialFoamLayerCount)
        .onChange(redrawLayers);
    addParam(paramsFolderInitial, modelObj, 'initialOffset', INITIAL_OFFSET_SPEC);
    INITIAL_OVERRIDES.forEach(key => {
        const controller = addParam(paramsFolderInitial, modelObj.initialConfig, key, INITIAL_SPECS[key]);
        if (key === 'deltaZ') controller.onChange(redrawLayers);
        overrides.push({ controller, differs: () => modelObj.initialConfig[key] !== modelObj.toolpathConfig[key] });
    });

    // ----- sensing parameters -----
    const paramsFolderSense = addFolderWithTip(
        modelGUIitem,
        'Sensing Parameters',
        'Used instead of the Foam Parameters inside areas selected as sensing area. Highlighted values differ from the Foam Parameters.'
    );
    paramsFolderSense.domElement.classList.add('params-folder-sense');

    SENSE_TO_FOAM.forEach(([senseKey, foamKey]) => {
        const controller = addParam(paramsFolderSense, modelObj.toolpathConfig, senseKey, MODEL_SPECS[senseKey]);
        if (senseKey === 'senseDeltaZ') controller.onChange(redrawLayers);
        overrides.push({
            controller,
            differs: () => modelObj.toolpathConfig[senseKey] !== modelObj.toolpathConfig[foamKey],
        });
    });

    const updateDifferenceMarks = (): void => {
        overrides.forEach(({ controller, differs }) => {
            controller.domElement.classList.toggle(DIFFERS_CLASS, differs());
        });
    };
    differenceMarkUpdaters.set(modelObj, updateDifferenceMarks);
    updateDifferenceMarks();

    paramsFolder.close();
    paramsFolderInitial.close();
    paramsFolderSense.close();
}

/**
 * Adds the augmentation folder to an everyday model's GUI item: the augment model and the
 * parameters that shape a (curved) augmentation.
 *
 * @param modelGUIitem - The GUI folder for the model.
 * @param modelObj - The everyday model object.
 */
export function addAugmentFolder(
    modelGUIitem: GUI,
    modelObj: EverydayModel,
): void {
    const augmentFolder = addFolderWithTip(
        modelGUIitem,
        'Augmentation Settings',
        'How many layers an augmentation gets and what shape its top surface takes.'
    );
    augmentFolder.domElement.classList.add('augment-folder');

    addButton(
        augmentFolder,
        'Select Augment Model',
        'Choose an STL whose shape the top of the augmentation follows. Only used when Curved Augmentation is on.',
        () => importAugmentSTL(modelObj)
    );
    const keys: ModelKey[] = ['curveAugment', 'initialFoamLayerCount', 'steepnessThreshold', 'flatLayerZOffset', 'additionalCurveLayers'];
    keys.forEach(key => addParam(augmentFolder, modelObj.toolpathConfig, key, MODEL_SPECS[key]));

    augmentFolder.close();
}

/**
 * Adds the bump folder to an everyday model's GUI item: the bump model and how the bumps
 * are spread over the surface of an augmentation.
 *
 * @param modelGUIitem - The GUI folder for the model.
 * @param modelObj - The everyday model object.
 */
export function addBumpsFolder(
    modelGUIitem: GUI,
    modelObj: EverydayModel,
): void {
    const bumpFolder = addFolderWithTip(
        modelGUIitem,
        'Bump Settings',
        'Add a pattern of bumps to the surface of an augmentation to improve grip.'
    );
    bumpFolder.domElement.classList.add('bump-folder');

    addButton(
        bumpFolder,
        'Select Bump Model',
        'Choose the STL that is repeated across the surface as a bump.',
        () => importBumpMesh(modelObj)
    );
    const keys: ModelKey[] = ['generateBumps', 'bumpSpacingX', 'bumpSpacingY', 'bumpScale'];
    keys.forEach(key => addParam(bumpFolder, modelObj.toolpathConfig, key, MODEL_SPECS[key]));

    bumpFolder.close();
}

/**
 * Adds the settings of a regular (solid plastic) print to an everyday model's GUI item.
 *
 * @param modelGUIitem - The GUI folder for the model.
 * @param modelObj - The everyday model object.
 */
export function addRegularPrintFolder(
    modelGUIitem: GUI,
    modelObj: EverydayModel,
): void {
    const regularFolder = addFolderWithTip(
        modelGUIitem,
        'Regular Print Settings',
        'How the model is printed as an ordinary solid part: layers, walls and infill.'
    );
    regularFolder.domElement.classList.add('regular-folder');

    const keys: RegularKey[] = ['layerHeight', 'perimeters', 'infillDensity', 'topBottomLayers', 'extruder', 'printSpeed'];
    keys.forEach(key => addParam(regularFolder, modelObj.regularConfig, key, REGULAR_SPECS[key]));
}

/**
 * Adds the gradient folder to an everyday model's GUI item.
 *
 * @param modelGUIitem - The GUI folder for the model.
 * @param modelObj - The everyday model object.
 */
export function addGradientFolder(
    modelGUIitem: GUI,
    modelObj: EverydayModel,
): void {
    const gradientFolder = addFolderWithTip(
        modelGUIitem,
        'Gradient Settings',
        'Vary the foam across X and Y with an SVG image.'
    );
    gradientFolder.domElement.classList.add('gradient-folder');

    addButton(
        gradientFolder,
        'Select Gradient SVG',
        'Choose an SVG that sets the foam properties by position: white uses V* and H*, black uses Gradient End V* and Gradient End H*, greys blend between them.',
        () => importSvgGradient(modelObj)
    );
    gradientFolder.close();
}

/**
 * Builds the GUI folder for one model: title bar with a delete button, the transform folder
 * and, for everyday models, the parameter, feature and area selection folders.
 *
 * @param visualizer - The Visualizer instance.
 * @param guiFolder - The list folder to add the model's folder to.
 * @param modelObj - The model.
 * @param listType - Which list the model belongs to.
 * @param itemClass - The CSS class that marks a model folder of this list.
 */
function buildModelFolder(
    visualizer: Visualizer,
    guiFolder: GUI,
    modelObj: AnyModel,
    listType: 'foam' | 'everyday',
    itemClass: string
): void {
    // A preset imported before any everyday model existed applies to models added later.
    if (listType === 'everyday' && visualizer.pendingModelPreset) {
        visualizer.pendingModelPreset(modelObj as EverydayModel);
    }

    const modelGUIitem = guiFolder.addFolder('');
    modelGUIitem.domElement.classList.add(itemClass);
    // Bind the GUI item to the model object.
    modelObj.guiItem = modelGUIitem;
    if (visualizer.selectedModel === modelObj) {
        modelGUIitem.domElement.classList.add('selectedModel');
    }

    // Title bar: the file name (as text, never as HTML) and the delete button.
    const titleElem = folderTitleElement(modelGUIitem);
    if (titleElem) {
        const nameElem = document.createElement('span');
        nameElem.className = 'model-name';
        nameElem.textContent = modelObj.name;
        nameElem.title = modelObj.name;
        titleElem.textContent = '';
        titleElem.appendChild(nameElem);
        titleElem.appendChild(
            createDeleteButton(`Delete model “${modelObj.name}”`, () => confirmAndDeleteModel(visualizer, modelObj))
        );
    }

    // What the object is comes first: it decides which of the folders below are shown
    // (the `kind-…` class on the folder, see style.css).
    if (listType === 'everyday') {
        const everydayModel = modelObj as EverydayModel;
        const kindController = addParam(modelGUIitem, everydayModel, 'kind', KIND_SPEC);
        kindController.domElement.classList.add('kind-control');
        kindController.onChange(() => visualizer.setModelKind(everydayModel, everydayModel.kind));
        modelGUIitem.domElement.classList.add(`kind-${everydayModel.kind}`);
    }

    addTransformFolder(modelGUIitem, modelObj, visualizer);

    // Everyday models: parameters first, because drawing an area generates the toolpath
    // from whatever the parameters are at that moment.
    if (listType === 'everyday') {
        const everydayModel = modelObj as EverydayModel;
        addRegularPrintFolder(modelGUIitem, everydayModel);
        addParamsFolder_EverydayModel(modelGUIitem, everydayModel, visualizer);
        addAugmentFolder(modelGUIitem, everydayModel);
        addBumpsFolder(modelGUIitem, everydayModel);
        addGradientFolder(modelGUIitem, everydayModel);
        addSelectedMeshFolder(modelGUIitem, everydayModel, visualizer);

        // Any edit in this model's folder can change which values differ from the foam ones.
        modelGUIitem.onChange(() => differenceMarkUpdaters.get(modelObj)?.());

        // The preview is drawn from the parameters and placement, so redraw it once an edit is
        // finished (slider released, value entered); otherwise it would show an older toolpath
        // than the one that gets saved.
        modelGUIitem.onFinishChange(() => visualizer.scheduleToolpathRefresh(everydayModel));
    }
}

/**
 * Brings the model list in the GUI in line with the model list in the Visualizer.
 *
 * Only what changed is touched: folders of models that are gone are destroyed (with their
 * controllers), and folders are built for models that do not have one yet. Existing folders
 * are left alone, so their open/closed state, transform mode and selection highlight survive.
 *
 * @param visualizer - An instance of Visualizer that contains properties such as:
 *                     foamModelList, everydayModelList, foamModelListFolder, everydayModelListFolder,
 *                     scene, transformControls, uuid_to_modelObj_Map, etc.
 * @param listType - The type of model list to refresh; either 'foam' or 'everyday'.
 */
export function refreshModelGUIList(
    visualizer: Visualizer,
    listType: 'foam' | 'everyday'
): void {
    const modelList: AnyModel[] = listType === 'foam' ? visualizer.foamModelList : visualizer.everydayModelList;
    const guiFolder: GUI = listType === 'foam' ? visualizer.foamModelListFolder : visualizer.everydayModelListFolder;
    const itemClass = listType === 'foam' ? 'foam-model-item' : 'everyday-model-item';

    hideTooltips();

    // Destroy the folders of models that are no longer in the list (copy first: destroy() mutates).
    [...guiFolder.folders].forEach(folder => {
        const isModelFolder = folder.domElement.classList.contains(itemClass);
        if (isModelFolder && !modelList.some(model => model.guiItem === folder)) {
            folder.destroy();
        }
    });

    // Build folders for models that do not have one yet.
    modelList.forEach(modelObj => {
        const hasFolder = guiFolder.folders.some(folder => folder === modelObj.guiItem);
        if (!hasFolder) {
            buildModelFolder(visualizer, guiFolder, modelObj, listType, itemClass);
        }
    });

    // Models came or went: update which actions are available and the getting-started card.
    visualizer.updateActionStates();
}

/**
 * Re-reads every model control from its model, e.g. after a preset changed the values
 * behind the GUI's back.
 *
 * @param visualizer - The Visualizer instance.
 */
export function refreshModelControls(visualizer: Visualizer): void {
    const models: AnyModel[] = [...visualizer.foamModelList, ...visualizer.everydayModelList];
    models.forEach(model => {
        (model.guiItem as GUI | undefined)?.controllersRecursive().forEach(controller => controller.updateDisplay());
        differenceMarkUpdaters.get(model)?.();
    });
}
