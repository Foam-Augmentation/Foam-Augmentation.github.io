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
import { EverydayModel, FoamModel } from '../types/modelTypes';

/** Either kind of model the app handles. */
export type AnyModel = EverydayModel | FoamModel;

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
