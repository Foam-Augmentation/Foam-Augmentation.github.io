// src/visualizer/gui/modelActions.ts
/**
 * Operations on a whole model and everything that hangs off it: removing a model completely,
 * and keeping its auxiliary meshes lined up with the main mesh.
 *
 * Every place that deletes or moves a model must go through these helpers so the two cannot
 * get out of step again.
 */
import * as THREE from 'three';
import type Visualizer from '../Visualizer';
import { EverydayModel, FoamModel, ObjectKind, RegularPrintSettings } from '../types/modelTypes';
import { DEFAULT_REGULAR_CONFIG } from '../toolpath/regularSlicer';

/** Either kind of model the app handles. */
export type AnyModel = EverydayModel | FoamModel;

/** Settings a model starts with when it is printed as a regular part. Copy it before changing it. */
export const DEFAULT_REGULAR_SETTINGS: Readonly<RegularPrintSettings> = DEFAULT_REGULAR_CONFIG;

/**
 * How each kind of object is shown: its name, a one-line description, the colour of its
 * badge in the object list (a CSS variable from style.css) and the colour of its mesh.
 */
export const KIND_INFO: Record<ObjectKind, { label: string; description: string; cssColor: string; meshColor: number }> = {
  augment: {
    label: 'Augmentation',
    description: 'Existing object; foam is printed onto a selected area',
    cssColor: 'var(--kind-augment)',
    // A neutral grey: the object itself is not printed, and the orange foam area reads well on it.
    meshColor: 0xc9d0da,
  },
  foam: {
    label: 'Foam Print',
    description: 'Printed entirely as foam',
    cssColor: 'var(--kind-foam)',
    meshColor: 0x9fdccb,
  },
  regular: {
    label: 'Regular Print',
    description: 'Printed as a solid plastic part',
    cssColor: 'var(--kind-regular)',
    meshColor: 0xa9b8f5,
  },
};

/**
 * Slight brightening of the selected object's mesh. It is white, so the object keeps the
 * colour of its kind; the outline box drawn by the Visualizer does most of the highlighting.
 */
const SELECTED_EMISSIVE = 0xffffff;
const SELECTED_EMISSIVE_INTENSITY = 0.1;

/**
 * Colours a model's mesh by its kind, and brightens it while it is the selected object.
 *
 * @param model - The model to colour.
 * @param selected - True if it is the selected object.
 */
export function applyModelAppearance(model: AnyModel, selected: boolean): void {
  const material = model.mesh.material as THREE.MeshStandardMaterial;
  if (!material || !('emissive' in material)) return;

  const kind = (model as Partial<EverydayModel>).kind;
  if (kind) {
    material.color.setHex(KIND_INFO[kind].meshColor);
  }
  material.emissive.setHex(selected ? SELECTED_EMISSIVE : 0x000000);
  material.emissiveIntensity = selected ? SELECTED_EMISSIVE_INTENSITY : 0;
}

/** The parts of the Visualizer that `disposeModel` needs. */
export type ModelHost = Pick<
  Visualizer,
  'scene' | 'foamModelList' | 'everydayModelList' | 'uuid_to_modelObj_Map' | 'releaseModel'
>;

/**
 * Scene objects that toolpath code attaches to a model without declaring them on the
 * model type (see updateSelectedMeshBoundingBox.ts).
 */
interface UndeclaredAuxObjects {
  selectedRegularFoamMeshBoundingBoxHelper?: THREE.Object3D;
  selectedRegularFoamMeshOutline?: THREE.Object3D;
}

/**
 * Removes an object from its parent and frees the GPU resources of it and its descendants.
 *
 * @param object - The object to dispose. Null and undefined are ignored.
 */
export function disposeObject3D(object: THREE.Object3D | null | undefined): void {
  if (!object) return;
  object.removeFromParent();
  object.traverse(child => {
    const drawable = child as Partial<Pick<THREE.Mesh, 'geometry' | 'material'>>;
    drawable.geometry?.dispose();
    const material = drawable.material;
    if (Array.isArray(material)) {
      material.forEach(m => m.dispose());
    } else {
      material?.dispose();
    }
  });
}

/**
 * Copies the main mesh's transform onto the model's auxiliary meshes.
 *
 * Call this after every change to `model.mesh` position, rotation or scale, whether it came
 * from the gizmo, the numeric X/Y/Z fields or the Snap/Center buttons.
 *
 * - Highlight overlays share the main mesh's geometry, so they take the full transform.
 * - Sample-point clouds have rotation and scale baked into their vertices when they are
 *   sampled (sampleSelectedMesh.ts), so they only follow the position.
 *
 * @param model - The model whose auxiliary meshes should follow its main mesh.
 */
export function syncAuxTransforms(model: AnyModel): void {
  const mesh = model.mesh;
  const everyday = model as Partial<EverydayModel>;

  for (const highlight of [everyday.highlightFoamMesh, everyday.highlightSenseMesh]) {
    if (!highlight) continue;
    highlight.position.copy(mesh.position);
    highlight.rotation.copy(mesh.rotation);
    highlight.scale.copy(mesh.scale);
  }

  for (const points of [everyday.pointsMesh_foam, everyday.pointsMesh_sense]) {
    points?.position.copy(mesh.position);
  }
}

/**
 * Removes a model completely: selection state, GUI folder, list and map entries, the main
 * mesh, and every auxiliary object (highlights, sample points, toolpath preview, bounding
 * box helpers, sensing objects, bump mesh), disposing their GPU resources.
 *
 * Safe to call twice for the same model.
 *
 * @param host - The Visualizer (or the parts of it listed in `ModelHost`).
 * @param model - The model to remove.
 */
export function disposeModel(host: ModelHost, model: AnyModel): void {
  // 1. Selection first, so nothing regenerates this model's toolpath while it is torn down.
  host.releaseModel(model);

  // 2. Auxiliary objects.
  const everyday = model as Partial<EverydayModel> & UndeclaredAuxObjects;

  disposeObject3D(everyday.highlightFoamMesh);
  disposeObject3D(everyday.highlightSenseMesh);
  disposeObject3D(everyday.pointsMesh);
  disposeObject3D(everyday.pointsMesh_foam);
  disposeObject3D(everyday.pointsMesh_sense);
  disposeObject3D(everyday.toolpathVisualizationObject);
  disposeObject3D(everyday.selectedRegularFoamMesh);
  disposeObject3D(everyday.selectedSenseFoamMesh);
  disposeObject3D(everyday.selectedRegularFoamMeshBoundingBoxHelper);
  disposeObject3D(everyday.selectedRegularFoamMeshOutline);
  disposeObject3D(everyday.bumpMesh);

  // Copy the list first: each sensing object's own dispose() removes it from the list.
  for (const sensingObject of [...(everyday.sensingIntersectModelList ?? [])]) {
    // Unregisters the canvas listeners added in addSensingIntersectionGeo.ts.
    const disposeSensing = sensingObject.userData.dispose as (() => void) | undefined;
    disposeSensing?.();
    disposeObject3D(sensingObject);
  }

  everyday.highlightFoamMesh = undefined;
  everyday.highlightSenseMesh = undefined;
  everyday.pointsMesh = undefined;
  everyday.pointsMesh_foam = undefined;
  everyday.pointsMesh_sense = undefined;
  everyday.toolpathVisualizationObject = undefined;
  everyday.selectedRegularFoamMesh = undefined;
  everyday.selectedSenseFoamMesh = undefined;
  everyday.selectedRegularFoamMeshBoundingBoxHelper = undefined;
  everyday.selectedRegularFoamMeshOutline = undefined;
  everyday.bumpMesh = undefined;
  everyday.sensingIntersectModelList = undefined;
  everyday.toolpathSamplePoints = undefined;
  everyday.augmentSamplePoints = undefined;
  // 3. Lists and lookup map.
  for (const list of [host.foamModelList, host.everydayModelList] as AnyModel[][]) {
    const index = list.indexOf(model);
    if (index !== -1) list.splice(index, 1);
  }
  host.uuid_to_modelObj_Map.delete(model.mesh.uuid);

  // 4. GUI folder (and every controller in it).
  model.guiItem?.destroy?.();
  model.guiItem = undefined;

  // 5. The main mesh, including its BVH.
  disposeObject3D(model.mesh);
  (model.mesh.geometry as { boundsTree?: unknown }).boundsTree = undefined;
}
