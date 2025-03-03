import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls';
import Visualizer from '../Visualizer';
import { updateEscDiv } from '../gui/bottomTooltip';
import { FoamModel, EverydayModel } from '../types/modelTypes';


/**
 * Private function that sets up model moving interactions.
 * This function is not exported.
 *
 * @param visualizer - An instance of Visualizer.
 * @param transformControls - The TransformControls instance.
 */
function moveModels(visualizer: Visualizer, transformControls: TransformControls): void {
    visualizer.renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
        const mouse = new THREE.Vector2();
        // Convert screen coordinates to normalized device coordinates (NDC)
        mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, visualizer.camera);

        // Gather interactive objects from foamModelList and everydayModelList.
        const selectableObjects: THREE.Object3D[] = [];
        visualizer.foamModelList.forEach(model => selectableObjects.push(model.mesh));
        visualizer.everydayModelList.forEach(model => selectableObjects.push(model.mesh));

        const intersects = raycaster.intersectObjects(selectableObjects, true);
        if (intersects.length > 0) {
            const selected = intersects[0].object;
            // console.log(intersects[0]);
            if (transformControls.object !== selected) {
                transformControls.detach();
                transformControls.attach(selected);
                transformControls.setMode('translate');
                updateEscDiv(transformControls);
            }
            // Clear previous GUI highlight classes.
            document.querySelectorAll('.foam-model-item, .everyday-model-item').forEach(elem => {
                elem.classList.remove('selectedModel');
            });
            if (visualizer.uuid_to_modelObj_Map.has(selected.uuid)) {
                const item = visualizer.uuid_to_modelObj_Map.get(selected.uuid) as EverydayModel | FoamModel;
                if (item.guiItem) {
                    item.guiItem.domElement.classList.add('selectedModel');
                }
            } 
        }

        // Listen for the Escape key to cancel selection.
        document.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                transformControls.detach();
                updateEscDiv(transformControls);
                document.querySelectorAll('.foam-model-item, .everyday-model-item').forEach(elem => {
                    elem.classList.remove('selectedModel');
                });
                document.querySelectorAll('.transform-panel').forEach(panel => {
                    (panel as HTMLElement).style.display = 'none';
                });
            }
        });

        // Listen for changes on the transform controls to update GUI fields.
        transformControls.addEventListener('change', () => {
            // console.log('transform change');
            if (transformControls.object) {
                const mesh = transformControls.object;
                const obj = visualizer.uuid_to_modelObj_Map.get(mesh.uuid) as FoamModel | EverydayModel;
                if (obj) {
                    const mode = obj.transformType;
                    if (mode === 'move') {
                        obj.transformX.x = parseFloat(mesh.position.x.toFixed(2));
                        obj.transformY.y = parseFloat(mesh.position.y.toFixed(2));
                        obj.transformZ.z = parseFloat(mesh.position.z.toFixed(2));
                    } else if (mode === 'rotate') {
                        obj.transformX.x = parseFloat(mesh.rotation.x.toFixed(2));
                        obj.transformY.y = parseFloat(mesh.rotation.y.toFixed(2));
                        obj.transformZ.z = parseFloat(mesh.rotation.z.toFixed(2));
                    } else if (mode === 'scale') {
                        obj.transformX.x = parseFloat(mesh.scale.x.toFixed(2));
                        obj.transformY.y = parseFloat(mesh.scale.y.toFixed(2));
                        obj.transformZ.z = parseFloat(mesh.scale.z.toFixed(2));
                    }
                    // Update highlight and points meshes if they exist.
                    if ('highlightFoamMesh' in obj && obj.highlightFoamMesh) {
                        obj.highlightFoamMesh.position.copy(mesh.position);
                        obj.highlightFoamMesh.rotation.copy(mesh.rotation);
                        obj.highlightFoamMesh.scale.copy(mesh.scale);
                    }
                    if ('highlightSenseMesh' in obj && obj.highlightSenseMesh) {
                        obj.highlightSenseMesh.position.copy(mesh.position);
                        obj.highlightSenseMesh.rotation.copy(mesh.rotation);
                        obj.highlightSenseMesh.scale.copy(mesh.scale);
                    }
                    if ('pointsMesh' in obj && obj.pointsMesh) {
                        obj.pointsMesh.position.copy(mesh.position);
                        obj.pointsMesh.rotation.copy(mesh.rotation);
                        obj.pointsMesh.scale.copy(mesh.scale);
                    }
                }
            }
        });
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
    visualizer.scene.add(transformControls as unknown as THREE.Object3D);

    // Return the created transform controls.
    // Then, in Visualizer.ts, you can assign the result to this.transformControls.
    // Also, call moveModels with both parameters.
    moveModels(visualizer, transformControls);

    return transformControls;
}
