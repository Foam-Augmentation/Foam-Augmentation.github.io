import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls';
import Visualizer from '../Visualizer';
import { syncAuxTransforms, syncTransformFields } from '../gui/modelActions';
import { layOnFace } from '../gui/placement';
import { pointerToNdc } from './pointerToNdc';

/** Gizmo mode for each transform type offered in a model's Transform folder. */
const GIZMO_MODE: Record<'move' | 'rotate' | 'scale', 'translate' | 'rotate' | 'scale'> = {
    move: 'translate',
    rotate: 'rotate',
    scale: 'scale',
};

/**
 * Private function that sets up model moving interactions.
 * This function is not exported.
 *
 * Each listener is registered exactly once, here; nothing is registered from inside another
 * handler.
 *
 * @param visualizer - An instance of Visualizer.
 * @param transformControls - The TransformControls instance.
 */
function moveModels(visualizer: Visualizer, transformControls: TransformControls): void {
    const canvas = visualizer.renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    // Click a model to select it and attach the move gizmo.
    canvas.addEventListener('pointerdown', (event: PointerEvent) => {
        // A drag that draws an area selection (any drag while armed, or an Alt-drag) must not
        // also grab the model under the cursor.
        if (event.altKey || visualizer.selectionArmed) return;

        // Convert the pointer position to normalized device coordinates (NDC) of the canvas.
        const ndc = pointerToNdc(event, canvas);
        mouse.set(ndc.x, ndc.y);
        raycaster.setFromCamera(mouse, visualizer.camera);

        // "Lay on Face" is waiting for a click on its model: lay it on the face that was hit.
        const layOnFaceModel = visualizer.layOnFaceModel;
        if (layOnFaceModel && event.button === 0) {
            const hit = raycaster.intersectObject(layOnFaceModel.mesh, false)[0];
            if (hit?.face) {
                const normalMatrix = new THREE.Matrix3().getNormalMatrix(layOnFaceModel.mesh.matrixWorld);
                const worldNormal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
                visualizer.disarmLayOnFace();
                layOnFace(visualizer, layOnFaceModel, worldNormal);
            }
            return;
        }

        // Gather interactive objects from foamModelList and everydayModelList.
        const selectableObjects: THREE.Object3D[] = [];
        visualizer.foamModelList.forEach(model => selectableObjects.push(model.mesh));
        visualizer.everydayModelList.forEach(model => selectableObjects.push(model.mesh));

        const intersects = raycaster.intersectObjects(selectableObjects, true);
        if (intersects.length === 0) return;

        const selected = intersects[0].object;
        const model = visualizer.uuid_to_modelObj_Map.get(selected.uuid);
        if (transformControls.object !== selected) {
            transformControls.detach();
            transformControls.attach(selected);
            // Keep the gizmo in the mode chosen in the model's Transform folder.
            transformControls.setMode(model ? GIZMO_MODE[model.transformType] : 'translate');
        }
        if (model) {
            visualizer.selectModel(model);
        }
        visualizer.updateModeHints();
    });

    // Esc releases the gizmo, stops area selection and deselects the model.
    document.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            visualizer.clearSelection();
        }
    });

    // While the gizmo moves a model, keep its numeric fields and auxiliary meshes in step.
    transformControls.addEventListener('change', () => {
        const mesh = transformControls.object;
        if (!mesh) return;
        const obj = visualizer.uuid_to_modelObj_Map.get(mesh.uuid);
        if (!obj) return;

        syncTransformFields(obj);
        syncAuxTransforms(obj);
    });

    // 'objectChange' (unlike 'change', which also fires on hover) means the gizmo really moved the
    // model, so a print on it no longer matches the plate slice.
    transformControls.addEventListener('objectChange', () => {
        const mesh = transformControls.object;
        const model = mesh ? visualizer.everydayModelList.find(candidate => candidate.mesh === mesh) : undefined;
        if (model) visualizer.invalidatePlateSlice(model);
    });
}

/**
 * Initializes TransformControls for the Visualizer instance.
 *
 * @param visualizer - An instance of Visualizer (exported as default from Visualizer.ts).
 * @returns The initialized TransformControls.
 */
export default function initTransformControls(visualizer: Visualizer): TransformControls {
    // Create TransformControls linked to the visualizer's camera and renderer's DOM element.
    const transformControls = new TransformControls(visualizer.camera, visualizer.renderer.domElement);

    // Listen for the "dragging-changed" event to toggle orbit controls.
    transformControls.addEventListener('dragging-changed', (event) => {
        const isDragging = event.value as boolean;
        visualizer.orbitControls.enabled = !isDragging;
    });

    // Add the transform controls to the scene.
    visualizer.scene.add(transformControls);

    moveModels(visualizer, transformControls);

    return transformControls;
}
