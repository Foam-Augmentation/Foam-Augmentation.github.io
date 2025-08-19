import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import Visualizer from '../Visualizer';
import { refreshModelGUIList } from '../gui/refreshModelGUIList';
import { FoamModel, EverydayModel, GUIItem } from '../types/modelTypes';
import { MeshBVH } from 'three-mesh-bvh';

export interface RGBA { r: number; g: number; b: number; a: number; }
export interface Gradient {width: number, height: number, sampleColor(x: number, y: number): RGBA}

/**
 * Imports an STL model file and integrates it with the Visualizer.
 *
 * This function creates a hidden file input element so that the user can select an STL file.
 * It then reads and parses the file using STLLoader, computes the bounding box to find the geometry's center,
 * translates the geometry so its center is at the origin, and creates a mesh with a material chosen based on
 * the model type. The mesh is then positioned on the printer's bed and added to the scene. Finally, the model
 * is stored in the appropriate model list and the GUI is updated.
 *
 * @param visualizer - An instance of Visualizer (from Visualizer.ts) 
 * @param type - The model type to import; must be either 'foam' or 'everyday'.
 */
export function importSTLModel(visualizer: Visualizer, type: 'foam' | 'everyday'): void {
    // Create a hidden file input element.
    const input: HTMLInputElement = document.createElement('input');
    input.type = 'file';
    input.accept = '.stl';

    // Listen for the file selection.
    input.addEventListener('change', (event: Event) => {
        const target = event.target as HTMLInputElement;
        if (!target.files || target.files.length === 0) return;
        const file = target.files[0];

        const reader = new FileReader();
        reader.onload = (e: ProgressEvent<FileReader>) => {
            if (!e.target || !e.target.result) return;

            // Parse the STL file into a BufferGeometry.
            const loader = new STLLoader();
            const geometry = loader.parse(e.target.result as ArrayBuffer);

            // Compute the bounding box to determine the center.
            geometry.computeBoundingBox();
            const bbox = geometry.boundingBox;
            const center = new THREE.Vector3();
            bbox?.getCenter(center);
            // Calculate a zOffset as half the height of the model.
            const zOffset = ((bbox?.max.z ?? 0) - (bbox?.min.z ?? 0)) / 2;

            // Translate geometry so its center is at the origin.
            geometry.translate(-center.x, -center.y, -center.z);

            // Select a material based on the model type.
            let material: THREE.Material;
            if (type === 'foam') {
                material = new THREE.MeshStandardMaterial({ color: 0x90ee90 });
            } else {
                material = new THREE.MeshStandardMaterial({ color: 0xffffff });
            }

            // Create a mesh using the geometry and material.
            const mesh = new THREE.Mesh(geometry, material);

            // Position the mesh at the center of the printer's bed.
            mesh.position.set(
                visualizer.printer.machine_depth / 2,
                visualizer.printer.machine_depth_y / 2,
                zOffset
            );

            // Save the model in the appropriate list and update the uuid mapping.
            if (type === 'foam') {
                const foamModelObj: FoamModel = {
                    name: file.name,
                    mesh,
                    geometry,
                    transformType: 'move',
                    transformX: { x: parseFloat(mesh.position.x.toFixed(2)) },
                    transformY: { y: parseFloat(mesh.position.y.toFixed(2)) },
                    transformZ: { z: parseFloat(mesh.position.z.toFixed(2)) },
                    // guiItem: {
                    //     domElement: document.createElement('div') // or any other appropriate initialization
                    // }
                };
                visualizer.foamModelList.push(foamModelObj);
                visualizer.uuid_to_modelObj_Map.set(mesh.uuid, foamModelObj);
                foamModelObj.mesh.geometry.boundsTree = new MeshBVH(foamModelObj.geometry); // Add bounds tree for raycasting.
            } else {
                const everydayModelObj: EverydayModel = {
                    name: file.name,
                    mesh,
                    geometry,
                    transformType: 'move',
                    transformX: { x: parseFloat(mesh.position.x.toFixed(2)) },
                    transformY: { y: parseFloat(mesh.position.y.toFixed(2)) },
                    transformZ: { z: parseFloat(mesh.position.z.toFixed(2)) },
                    toolpathConfig: {
                        deltaZ: 1.16,
                        gridSize: 1,
                        deltaL: 1.7,
                        vStar: 0.15,
                        vStarEnd: 0.15,
                        hStar: 9,
                        hStarEnd: 9,
                        edot: 35,
                        initialFoamLayerCount: 3,
                        middleSenseLayerCount: 3,
                        finalFoamLayerCount: 1,
                        bumpSpacingX: 15,
                        bumpSpacingY: 15,
                        bumpScale: 1,
                        generateBumps: false,
                        steepnessThreshold: 75,
                    },
                    plaConfig: {
                        deltaZ: 1.16,
                        gridSize: 1,
                        deltaL: 1.7,
                        vStar: 0.15,
                        vStarEnd: 0.15,
                        hStar: 9,
                        hStarEnd: 9,
                        edot: 200,
                        initialFoamLayerCount: 0,
                        middleSenseLayerCount: 3,
                        finalFoamLayerCount: 1,
                        bumpSpacingX: 15,
                        bumpSpacingY: 15,
                        bumpScale: 1,
                        generateBumps: false,
                        steepnessThreshold: 75,
                    },
                    plaOffset: 0,
                    gradient: {
                        width: 1,
                        height: 1,
                        sampleColor(x: number, y: number): RGBA {
                            return {r: 255, b: 255, g: 255, a: 1};
                        }
                    }
                    // guiItem: {
                    //     domElement: document.createElement('div') // or any other appropriate initialization
                    // } 
                };
                visualizer.everydayModelList.push(everydayModelObj);
                visualizer.uuid_to_modelObj_Map.set(mesh.uuid, everydayModelObj);
                everydayModelObj.mesh.geometry.boundsTree = new MeshBVH(everydayModelObj.geometry); // Add bounds tree for raycasting.
            }

            // Add the mesh to the scene.
            visualizer.scene.add(mesh);

            // Update the GUI model list. 
            if (type === 'foam') {
                refreshModelGUIList(visualizer, 'foam');
            } else {
                refreshModelGUIList(visualizer, 'everyday');
            }
        };

        reader.readAsArrayBuffer(file);
    });

    // Programmatically trigger the file input.
    input.click();
}


export function importBumpMesh(
    modelObj: EverydayModel
): void {
    const input: HTMLInputElement = document.createElement('input');
    input.type = 'file';
    input.accept = '.stl';

    // Listen for the file selection.
    input.addEventListener('change', (event: Event) => {
        const target = event.target as HTMLInputElement;
        if (!target.files || target.files.length === 0) return;
        const file = target.files[0];

        const reader = new FileReader();

        reader.onload = (e: ProgressEvent<FileReader>) => {
            if (!e.target || !e.target.result) return;

            // Parse the STL file into a BufferGeometry.
            const loader = new STLLoader();
            const geometry = loader.parse(e.target.result as ArrayBuffer);

            // Compute the bounding box to determine the center.
            geometry.computeBoundingBox();
            const bbox = geometry.boundingBox;
            const center = new THREE.Vector3();
            bbox?.getCenter(center);

            // Translate geometry so its center is at the origin.
            geometry.translate(-center.x, -center.y, -center.z);

            // Create a mesh using the geometry and material.
            const material = new THREE.MeshStandardMaterial({ color: 0x90ee90 });
            const mesh = new THREE.Mesh(geometry, material);

            // Position the mesh at the center of the printer's bed.
            mesh.position.set(
                0,
                0,
                0,
            );

            modelObj.bumpMesh = mesh;
        };

        reader.readAsArrayBuffer(file);
    });

    // Programmatically trigger the file input.
    input.click();
}


export function importSvgGradient(modelObj: EverydayModel): void {
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = '.svg';

  input.addEventListener('change', (ev) => {
    const files = (ev.target as HTMLInputElement).files;
    if (!files?.length) return;
    const file = files[0];
    const url  = URL.createObjectURL(file);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src         = url;

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      modelObj.gradient = {
        width:  canvas.width,
        height: canvas.height,

        sampleColor(x: number, y: number): RGBA {
          const ix = Math.min(canvas.width  - 1, Math.max(0, Math.floor(x)));
          const iy = Math.min(canvas.height - 1, Math.max(0, Math.floor(y)));
          const d  = ctx.getImageData(ix, iy, 1, 1).data;
          return { r: d[0], g: d[1], b: d[2], a: d[3] };
        }
      };

      URL.revokeObjectURL(url);
    };

    img.onerror = (err) => {
      console.error('Failed to load SVG for sampling', err);
      URL.revokeObjectURL(url);
    };
  });

  input.click();
}