import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import Visualizer from '../Visualizer';
import { refreshModelControls, refreshModelGUIList } from '../gui/refreshModelGUIList';
import { dropMeshToBed, placeNewMesh } from '../gui/placement';
import { FoamModel, EverydayModel, ObjectKind } from '../types/modelTypes';
import { applyModelAppearance, DEFAULT_REGULAR_SETTINGS, newObjectId } from '../gui/modelActions';
import { MeshBVH } from 'three-mesh-bvh';
import { notify } from '../gui/notify';

// How far above the top of the augment mesh the downward sampling rays start (mm).
const SAMPLE_RAY_START_HEIGHT = 10;

/** A colour sampled from a gradient. Every channel, alpha included, is in the range 0-255. */
export interface RGBA { r: number; g: number; b: number; a: number; }
export interface Gradient {width: number, height: number, sampleColor(x: number, y: number): RGBA}


/**
 * Parses the contents of an STL file and checks that it holds usable geometry. If it doesn't,
 * the user is told why and null is returned.
 *
 * @param data - The raw contents of the file.
 * @param fileName - The name of the file, for messages.
 * @returns The parsed geometry with its bounding box computed, or null if the file is unusable.
 */
export function parseStlGeometry(data: ArrayBuffer, fileName: string): THREE.BufferGeometry | null {
    let geometry: THREE.BufferGeometry;
    try {
        geometry = new STLLoader().parse(data);
    } catch (err) {
        console.error(`Failed to parse STL file "${fileName}"`, err);
        notify(`Could not read "${fileName}": it is not a valid STL file.`, 'error');
        return null;
    }

    const position = geometry.getAttribute('position');
    if (!position || position.count < 3) {
        notify(`"${fileName}" does not contain any triangles.`, 'error');
        return null;
    }

    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox;
    const corners = bbox ? [bbox.min.x, bbox.min.y, bbox.min.z, bbox.max.x, bbox.max.y, bbox.max.z] : [NaN];
    if (!corners.every(Number.isFinite)) {
        notify(`"${fileName}" contains invalid coordinates and can't be used.`, 'error');
        return null;
    }

    return geometry;
}


/**
 * Opens a file picker for an STL file, reads and parses the chosen file, and hands the geometry
 * to a callback. Anything that goes wrong (the file can't be read, isn't a valid STL, or the
 * callback throws) is reported to the user rather than failing silently.
 *
 * @param onGeometry - Called with the parsed geometry (bounding box already computed) and the file.
 */
function pickStlFile(onGeometry: (geometry: THREE.BufferGeometry, file: File) => void): void {
    // Create a hidden file input element.
    const input: HTMLInputElement = document.createElement('input');
    input.type = 'file';
    input.accept = '.stl';

    // Listen for the file selection.
    input.addEventListener('change', (event: Event) => {
        const target = event.target as HTMLInputElement;
        if (!target.files || target.files.length === 0) return;
        readStlFile(target.files[0], onGeometry);
    });

    // Programmatically trigger the file input.
    input.click();
}

/**
 * Reads and parses one STL file and hands the geometry to a callback. Anything that goes wrong
 * is reported to the user rather than failing silently.
 *
 * @param file - The STL file.
 * @param onGeometry - Called with the parsed geometry (bounding box already computed) and the file.
 */
function readStlFile(file: File, onGeometry: (geometry: THREE.BufferGeometry, file: File) => void): void {
    const reader = new FileReader();

    reader.onerror = () => {
        console.error(`Failed to read file "${file.name}"`, reader.error);
        notify(`Could not read "${file.name}".`, 'error');
    };

    reader.onload = () => {
        if (!(reader.result instanceof ArrayBuffer) || reader.result.byteLength === 0) {
            notify(`"${file.name}" is empty.`, 'error');
            return;
        }

        const geometry = parseStlGeometry(reader.result, file.name);
        if (!geometry) return;

        try {
            onGeometry(geometry, file);
        } catch (err) {
            console.error(`Failed to import "${file.name}"`, err);
            notify(`Could not import "${file.name}": ${err instanceof Error ? err.message : err}`, 'error');
        }
    };

    reader.readAsArrayBuffer(file);
}

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
 * @param kind - For an everyday model: what the object is (see ObjectKind).
 */
export function importSTLModel(visualizer: Visualizer, type: 'foam' | 'everyday', kind: ObjectKind = 'augment'): void {
    pickStlFile((geometry, file) => addModelFromGeometry(visualizer, geometry, file.name, type, kind));
}

/**
 * Imports STL files that were dropped on the window, each as its own model.
 * Files that are not STL files are named in one message and skipped.
 *
 * @param visualizer - The Visualizer instance.
 * @param files - The dropped files.
 */
export function importDroppedFiles(visualizer: Visualizer, files: File[]): void {
    const stlFiles = files.filter(file => file.name.toLowerCase().endsWith('.stl'));
    const skipped = files.length - stlFiles.length;
    if (skipped > 0) {
        notify(
            stlFiles.length > 0
                ? `Imported the STL files only; ${skipped} other file${skipped === 1 ? ' was' : 's were'} skipped.`
                : 'Only STL files can be imported.',
            'warning'
        );
    }
    stlFiles.forEach(file => {
        readStlFile(file, geometry => addModelFromGeometry(visualizer, geometry, file.name, 'everyday'));
    });
}

/**
 * Shape of the built-in example model (mm): a low puck that is slightly narrower at the top.
 * `ringSpacing` is how far apart the rings of triangles on its flat faces are; the faces are
 * finely divided so that a small drawn area still catches some triangles.
 */
const EXAMPLE_MODEL = { topRadius: 26, bottomRadius: 30, height: 12, segments: 64, ringSpacing: 2 };

/**
 * Builds the example puck as plain triangles (what an STL file gives): closed, outward-facing,
 * standing on z = 0 with its axis along Z.
 *
 * @returns The geometry, with normals and its bounding box computed.
 */
export function createExampleGeometry(): THREE.BufferGeometry {
    const { topRadius, bottomRadius, height, segments, ringSpacing } = EXAMPLE_MODEL;

    // The outline from the centre of the bottom, out to the rim, up the side and back in to the
    // centre of the top, as (radius, z) pairs. Spinning it around Z gives the puck.
    const profile: [number, number][] = [];
    const bottomRings = Math.ceil(bottomRadius / ringSpacing);
    for (let i = 0; i <= bottomRings; i++) profile.push([bottomRadius * i / bottomRings, 0]);
    const sideSteps = Math.ceil(height / ringSpacing);
    for (let i = 1; i <= sideSteps; i++) {
        profile.push([bottomRadius + (topRadius - bottomRadius) * i / sideSteps, height * i / sideSteps]);
    }
    const topRings = Math.ceil(topRadius / ringSpacing);
    for (let i = topRings - 1; i >= 0; i--) profile.push([topRadius * i / topRings, height]);

    const positions: number[] = [];
    const vertex = (profileIndex: number, segment: number): [number, number, number] => {
        const [radius, z] = profile[profileIndex];
        // The last segment ends exactly where the first one starts, so the seam is closed.
        const angle = 2 * Math.PI * (segment % segments) / segments;
        return [radius * Math.cos(angle), radius * Math.sin(angle), z];
    };
    for (let i = 0; i < profile.length - 1; i++) {
        for (let j = 0; j < segments; j++) {
            const a = vertex(i, j);
            const b = vertex(i + 1, j);
            const c = vertex(i + 1, j + 1);
            const d = vertex(i, j + 1);
            // On the axis two corners of the quad coincide, so only one triangle is real.
            if (profile[i + 1][0] > 0) positions.push(...a, ...c, ...b);
            if (profile[i][0] > 0) positions.push(...a, ...d, ...c);
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    return geometry;
}

/**
 * Adds the built-in example model, so the app can be tried without an STL file at hand.
 *
 * @param visualizer - The Visualizer instance.
 */
export function loadExampleModel(visualizer: Visualizer): void {
    addModelFromGeometry(visualizer, createExampleGeometry(), 'example-puck', 'everyday');
}

/** How a new model is placed, besides resting on the bed. */
export interface NewModelPlacement {
    /** Turn and scale it like this (and rest it on the bed). Defaults to as it comes. */
    orientation?: { quaternion: THREE.Quaternion, scale: THREE.Vector3 };
    /** Where to look for free space first. Defaults to the middle of the bed. */
    near?: { x: number, y: number };
}

/**
 * Turns a geometry into a model: centres it, rests it on the print bed in the free space nearest
 * the middle (or `placement.near`), adds it to the scene and the model list, selects it and
 * brings it into view.
 *
 * @param visualizer - The Visualizer instance.
 * @param geometry - The model's geometry, with its bounding box computed.
 * @param name - The model's name (normally the file name).
 * @param type - Which list the model goes into.
 * @param kind - For an everyday model: what the object is (see ObjectKind).
 * @param placement - How to turn the model and where to put it.
 * @returns The new model.
 */
export function addModelFromGeometry(
    visualizer: Visualizer,
    geometry: THREE.BufferGeometry,
    name: string,
    type: 'foam' | 'everyday',
    kind: ObjectKind = 'augment',
    placement: NewModelPlacement = {},
): EverydayModel | FoamModel {
    {
        // Use the bounding box to determine the center.
        const bbox = geometry.boundingBox!;
        const center = new THREE.Vector3();
        bbox.getCenter(center);
        // Calculate a zOffset as half the height of the model.
        const zOffset = (bbox.max.z - bbox.min.z) / 2;

        if (bbox.max.z - bbox.min.z <= 0) {
            notify(`"${name}" is completely flat, so there is nothing to slice.`, 'warning');
        }

        // Translate geometry so its center is at the origin.
        geometry.translate(-center.x, -center.y, -center.z);

        // Shade from the triangles themselves. STL files often carry missing or wrong normals,
        // which would leave the model black; for separate triangles this gives each face its
        // true normal.
        geometry.computeVertexNormals();

        // Build the bounds tree used for raycasting before the model is registered anywhere,
        // so a failure here doesn't leave a half-imported model behind.
        geometry.boundsTree = new MeshBVH(geometry);

        // Select a material based on the model type.
        let material: THREE.Material;
        if (type === 'foam') {
            material = new THREE.MeshStandardMaterial({ color: 0x9fd8a8, roughness: 0.75, metalness: 0 });
        } else {
            // A light neutral grey: the orange foam highlight and the toolpath colours read well on it.
            material = new THREE.MeshStandardMaterial({ color: 0xc9d0da, roughness: 0.8, metalness: 0 });
        }

        // Create a mesh using the geometry and material.
        const mesh = new THREE.Mesh(geometry, material);

        // Position the mesh at the center of the printer's bed.
        mesh.position.set(
            visualizer.printer.machine_depth / 2,
            visualizer.printer.machine_depth_y / 2,
            zOffset
        );
        if (placement.orientation) {
            mesh.quaternion.copy(placement.orientation.quaternion);
            mesh.scale.copy(placement.orientation.scale);
            dropMeshToBed(mesh);
        }
        // Clear of every object already on the plate, where there is room.
        if (type === 'everyday' && !placeNewMesh(visualizer, mesh, kind, placement.near)) {
            notify(`There is no free space on the bed for “${name}”, so it overlaps another object. Move it or press Arrange.`, 'warning');
        }

        // Save the model in the appropriate list and update the uuid mapping.
        let created: EverydayModel | FoamModel;
        if (type === 'foam') {
            const foamModelObj: FoamModel = {
                name,
                mesh,
                geometry,
                transformType: 'move',
                transformX: { x: parseFloat(mesh.position.x.toFixed(2)) },
                transformY: { y: parseFloat(mesh.position.y.toFixed(2)) },
                transformZ: { z: parseFloat(mesh.position.z.toFixed(2)) },
            };
            visualizer.foamModelList.push(foamModelObj);
            visualizer.uuid_to_modelObj_Map.set(mesh.uuid, foamModelObj);
            created = foamModelObj;
        } else {
            const everydayModelObj: EverydayModel = {
                objectId: newObjectId(),
                name,
                kind,
                regularConfig: { ...DEFAULT_REGULAR_SETTINGS },
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
                    deltaLEnd: 1.7,
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
                    curveAugment: false,
                    steepnessThreshold: 75,
                    flatLayerZOffset: 5,
                    additionalCurveLayers: 3,
                    senseDeltaLEnd: 1.7,
                    senseDeltaZ: 1.16,
                    senseHStar: 9,
                    senseHStarEnd: 9,
                    senseVStar: 0.16,
                    SenseVStarEnd: 0.15,
                    senseDeltaL: 1.7,
                    senseEdot: 35
                },
                initialConfig: {
                    deltaZ: 1.16,
                    gridSize: 1,
                    deltaL: 1.7,
                    deltaLEnd: 1.7,
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
                    curveAugment: false,
                    steepnessThreshold: 75,
                    flatLayerZOffset: 5,
                    additionalCurveLayers: 3,
                    senseDeltaLEnd: 0,
                    senseDeltaZ: 0,
                    senseHStar: 0,
                    senseHStarEnd: 0,
                    senseVStar: 0,
                    SenseVStarEnd: 0,
                    senseDeltaL: 0,
                    senseEdot: 0
                },
                initialOffset: 0,
                gradient: {
                    width: 1,
                    height: 1,
                    sampleColor(x: number, y: number): RGBA {
                        return {r: 255, b: 255, g: 255, a: 255};
                    }
                }
            };
            visualizer.everydayModelList.push(everydayModelObj);
            visualizer.uuid_to_modelObj_Map.set(mesh.uuid, everydayModelObj);
            applyModelAppearance(everydayModelObj, false);
            created = everydayModelObj;
        }

        // Add the mesh to the scene.
        visualizer.scene.add(mesh);

        // Update the GUI model list.
        if (type === 'foam') {
            refreshModelGUIList(visualizer, 'foam');
        } else {
            refreshModelGUIList(visualizer, 'everyday');
        }

        // Bring every model into view, the new one included, and show the new one's settings.
        visualizer.fitView();
        if (type === 'everyday') {
            visualizer.selectModel(visualizer.everydayModelList[visualizer.everydayModelList.length - 1]);
        }
        return created;
    }
}

/**
 * The name for a copy of a model: its name with the next free number, e.g. "bottle.stl (2)".
 *
 * @param names - The names already on the plate.
 * @param name - The name of the model being copied.
 * @returns A name no model has.
 */
export function copyName(names: string[], name: string): string {
    const base = name.replace(/ \(\d+\)$/, '');
    let n = 2;
    while (names.includes(`${base} (${n})`)) n++;
    return `${base} (${n})`;
}

/**
 * Adds a copy of an object next to it: the same mesh, turned and scaled the same, with the same
 * type and settings, in the free space nearest to it. An augmentation's selected areas are not
 * copied: the copy starts without one.
 *
 * @param visualizer - The Visualizer instance.
 * @param source - The object to copy.
 * @returns The copy. It is selected.
 */
export function duplicateModel(visualizer: Visualizer, source: EverydayModel): EverydayModel {
    const names = visualizer.everydayModelList.map(model => model.name);
    // The copy has its own geometry: deleting one of the two disposes only its own.
    const copy = addModelFromGeometry(visualizer, source.mesh.geometry.clone(), copyName(names, source.name), 'everyday', source.kind, {
        orientation: { quaternion: source.mesh.quaternion, scale: source.mesh.scale },
        near: { x: source.mesh.position.x, y: source.mesh.position.y },
    }) as EverydayModel;
    // Into the objects the copy's controls are bound to, not replacing them.
    Object.assign(copy.regularConfig, structuredClone(source.regularConfig));
    Object.assign(copy.toolpathConfig, structuredClone(source.toolpathConfig));
    Object.assign(copy.initialConfig, structuredClone(source.initialConfig));
    copy.initialOffset = source.initialOffset;
    // A gradient is never changed in place (loading an SVG replaces it), so the two can share it.
    copy.gradient = source.gradient;
    refreshModelControls(visualizer);
    return copy;
}


/**
 * Imports an STL file to use as the bump shape of a model. The mesh is centred on the origin.
 *
 * @param modelObj - The model to give the bump mesh to.
 */
export function importBumpMesh(
    modelObj: EverydayModel
): void {
    pickStlFile((geometry: THREE.BufferGeometry) => {
        // Use the bounding box to determine the center.
        const center = new THREE.Vector3();
        geometry.boundingBox!.getCenter(center);

        // Translate geometry so its center is at the origin.
        geometry.translate(-center.x, -center.y, -center.z);

        // Create a mesh using the geometry and material.
        const material = new THREE.MeshStandardMaterial({ color: 0x90ee90 });
        const mesh = new THREE.Mesh(geometry, material);

        mesh.position.set(0, 0, 0);

        modelObj.bumpMesh = mesh;
    });
}


/**
 * Imports an SVG image to use as the gradient of a model. The image is drawn once and its
 * pixels are kept, so sampling a colour is just an array lookup.
 *
 * @param modelObj - The model to give the gradient to.
 */
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
      try {
        if (!img.naturalWidth || !img.naturalHeight) {
          notify(`"${file.name}" has no size, so it can't be used as a gradient. Give the SVG a width and height.`, 'error');
          return;
        }

        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('2D canvas is not available');
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);

        modelObj.gradient = createPixelGradient(
          canvas.width,
          canvas.height,
          ctx.getImageData(0, 0, canvas.width, canvas.height).data
        );
      } catch (err) {
        console.error('Failed to read SVG for sampling', err);
        notify(`Could not use "${file.name}" as a gradient.`, 'error');
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    img.onerror = (err) => {
      console.error('Failed to load SVG for sampling', err);
      notify(`Could not load "${file.name}": it is not a valid SVG image.`, 'error');
      URL.revokeObjectURL(url);
    };
  });

  input.click();
}


/**
 * Makes a gradient that samples colours out of an image's pixels.
 *
 * @param width - The width of the image in pixels.
 * @param height - The height of the image in pixels.
 * @param pixels - The image's pixels as RGBA bytes, row by row (as returned by getImageData).
 * @returns A gradient whose sampleColor takes pixel coordinates; ones outside the image are clamped to its edge.
 */
export function createPixelGradient(
  width: number,
  height: number,
  pixels: ArrayLike<number>
): Gradient {
  return {
    width,
    height,

    sampleColor(x: number, y: number): RGBA {
      let ix = Math.min(width  - 1, Math.max(0, Math.floor(x)));
      let iy = Math.min(height - 1, Math.max(0, Math.floor(y)));
      // NaN coordinates sample the first row/column, as getImageData used to
      if (!(ix >= 0)) ix = 0;
      if (!(iy >= 0)) iy = 0;
      const offset = (iy * width + ix) * 4;
      return { r: pixels[offset], g: pixels[offset + 1], b: pixels[offset + 2], a: pixels[offset + 3] };
    }
  };
}


/**
 * Samples the height of a mesh's top surface on a regular grid, by casting a ray straight down
 * at every grid point. The rays are tested against a BVH of the mesh, so each one only looks at
 * the triangles near it.
 *
 * @param mesh - The mesh to sample. It is treated as sitting at the origin, unrotated and unscaled.
 * @param gridSize - The spacing of the grid (mm). Must be positive.
 * @returns One list of hit points per grid column (along x). Grid points with nothing under them are skipped.
 * @throws {Error} If gridSize is not a positive, finite number.
 */
export function sampleMesh(
    mesh: THREE.Mesh,
    gridSize: number,
): THREE.Vector3[][] {
    if (!Number.isFinite(gridSize) || gridSize <= 0) {
        throw new Error(`Grid size must be a positive number (got ${gridSize}).`);
    }

    mesh.geometry.computeBoundingBox();
    const bbox = mesh.geometry.boundingBox!;

    const samplePoints: THREE.Vector3[][] = [];

    const bvh = new MeshBVH(mesh.geometry);
    // one ray, pointing straight down, moved from grid point to grid point
    const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));

    const remainderX = (bbox.max.x - bbox.min.x) % gridSize
    const remainderY = (bbox.max.y - bbox.min.y) % gridSize
    let x = bbox.min.x + remainderX / 2;

    while (x < bbox.max.x) {
        let y = bbox.min.y + remainderY / 2;
        const column: THREE.Vector3[] = [];
        while (y < bbox.max.y) {
            ray.origin.set(x, y, bbox.max.z + SAMPLE_RAY_START_HEIGHT);

            // only faces that point up at the ray count, the same as a default material would give
            const hit = bvh.raycastFirst(ray, THREE.FrontSide);
            if (hit) {
                column.push(hit.point.clone());
            }
            y += gridSize;
        }
        samplePoints.push(column);
        x += gridSize;
    }
    return samplePoints;
}


/**
 * Imports an STL file whose top surface is used to shape the top of a model's augment. The mesh
 * is centred, scaled to cover the model in x and y, and sampled on the model's grid.
 *
 * @param modelObj - The model to give the sampled surface to.
 */
export function importAugmentSTL(
    modelObj: EverydayModel
): void {
    pickStlFile((geometry: THREE.BufferGeometry, file: File) => {
        // Use the bounding box to determine the center.
        const bbox = geometry.boundingBox!;
        const center = new THREE.Vector3();
        bbox.getCenter(center);

        const sizeX = bbox.max.x - bbox.min.x;
        const sizeY = bbox.max.y - bbox.min.y;
        if (!(sizeX > 0) || !(sizeY > 0)) {
            notify(`"${file.name}" has no width or depth, so it can't be scaled to fit the model.`, 'error');
            return;
        }

        modelObj.geometry.computeBoundingBox();
        const modelBbox = modelObj.geometry.boundingBox!;

        const scale = Math.max((modelBbox.max.x - modelBbox.min.x) / sizeX,
                               (modelBbox.max.y - modelBbox.min.y) / sizeY);
        if (!Number.isFinite(scale) || scale <= 0) {
            notify(`"${modelObj.name}" has no width or depth, so "${file.name}" can't be scaled to fit it.`, 'error');
            return;
        }

        const gridSize = modelObj.toolpathConfig.gridSize;
        if (!Number.isFinite(gridSize) || gridSize <= 0) {
            notify('Grid size must be greater than 0 to sample the augment surface.', 'error');
            return;
        }

        // Translate geometry so its center is at the origin.
        geometry.translate(-center.x, -center.y, -center.z);
        geometry.scale(scale, scale, scale);

        // Create a mesh using the geometry and material.
        const material = new THREE.MeshStandardMaterial({ color: 0x90ee90 });
        const mesh = new THREE.Mesh(geometry, material);

        mesh.position.set(0, 0, 0);

        modelObj.augmentSamplePoints = sampleMesh(mesh, gridSize);
    });
}