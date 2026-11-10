import * as THREE from 'three';
import Visualizer from '../Visualizer';
import { EverydayModel } from '../types/modelTypes';
import { createSelectedMeshFromHighlight } from '../interactions/createSelectedMeshFromHighlight';
import { updateSelectedMeshBoundingBox } from './updateSelectedMeshBoundingBox';
import { sampleSelectedMesh } from './sampleSelectedMesh';
import { generateAugmentFoamToolpath } from './generateFoamToolpath';
import { notify } from '../gui/notify';

/**
 * Adds a sensing intersection geometry to an EverydayModel.
 *
 * Creates a sensing object (a box or a cylinder), adds it to modelObj.sensingIntersectModelList
 * and to the scene, and lets the user drag it over the model's surface. While it is dragged the
 * sense highlight follows it; when it is dropped the selection is sampled again and the toolpath
 * regenerated.
 *
 * The sensing object registers pointer listeners on the canvas. Call
 * `sensingObj.userData.dispose()` when removing the object to unregister them and free its
 * geometry and material.
 *
 * @param modelObj - The EverydayModel to add the sensing object to.
 * @param type - The shape of the sensing object ('cylinder' or 'box').
 * @param size - The edge length for a box; the diameter (and height) for a cylinder.
 * @param visualizer - The Visualizer instance (scene, camera, renderer, orbitControls, ...).
 */
export function addSensingIntersectionGeo(
  modelObj: EverydayModel,
  type: 'cylinder' | 'box',
  size: number,
  visualizer: Visualizer
): void {
  // 确保 sensingIntersectModelList 存在
  if (!modelObj.sensingIntersectModelList) {
    modelObj.sensingIntersectModelList = [];
  }

  // 根据 type 创建 sensing 对象的几何体
  let geometry: THREE.BufferGeometry;
  if (type === 'cylinder') {
    geometry = new THREE.CylinderGeometry(size / 2, size / 2, size, 32);
  } else {
    geometry = new THREE.BoxGeometry(size, size, size);
  }
  const material = new THREE.MeshBasicMaterial({
    color: 0xffaa00,
    opacity: 0.7,
    transparent: true,
  });
  const sensingObj = new THREE.Mesh(geometry, material);

  // 通过射线检测将 sensingObj 放置在 modelObj.mesh 的上表面
  const bbox = new THREE.Box3().setFromObject(modelObj.mesh);
  const center = bbox.getCenter(new THREE.Vector3());
  const rayOrigin = new THREE.Vector3(center.x, center.y, bbox.max.z + 10);
  const rayDirection = new THREE.Vector3(0, 0, -1);
  const raycaster = new THREE.Raycaster(rayOrigin, rayDirection);
  const results = raycaster.intersectObject(modelObj.mesh);
  if (results.length > 0) {
    const intersect = results[0];
    sensingObj.position.copy(intersect.point);
    if (intersect.face) {
      const normalWorld = intersect.face.normal
        .clone()
        .transformDirection(modelObj.mesh.matrixWorld)
        .normalize();
      const quaternion = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        normalWorld
      );
      sensingObj.quaternion.copy(quaternion);
    }
  } else {
    sensingObj.position.copy(center);
  }

  // 将 sensingObj 添加到 sensingIntersectModelList 和场景中
  modelObj.sensingIntersectModelList.push(sensingObj);
  visualizer.scene.add(sensingObj);

  // 拖拽事件
  const canvas = visualizer.renderer.domElement;
  let isDragging = false;
  let movedWhileDragging = false;
  const onPointerDown = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(mouse, visualizer.camera);
    const hits = rc.intersectObject(sensingObj);
    if (hits.length > 0) {
      isDragging = true;
      movedWhileDragging = false;
      visualizer.orbitControls.enabled = false;
      event.stopPropagation();
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(mouse, visualizer.camera);
    const hits = rc.intersectObject(modelObj.mesh);
    if (hits.length > 0) {
      const intersect = hits[0];
      sensingObj.position.copy(intersect.point);
      if (intersect.face) {
        const normalWorld = intersect.face.normal
          .clone()
          .transformDirection(modelObj.mesh.matrixWorld)
          .normalize();
        const quaternion = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          normalWorld
        );
        sensingObj.quaternion.copy(quaternion);
      }
      // 更新交集区域：遍历 sensingIntersectModelList 中所有 sensing 对象的联合区域
      // Only the highlight follows the drag; sampling and the toolpath wait for the drop.
      movedWhileDragging = _updateSenseIntersectionRegion(modelObj, type, size) || movedWhileDragging;
    }
  };

  const onPointerUp = () => {
    if (!isDragging) return;
    isDragging = false;
    visualizer.orbitControls.enabled = true;
    if (movedWhileDragging) {
      movedWhileDragging = false;
      _regenerateAfterSenseChange(visualizer, modelObj);
    }
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);

  // Lets whoever removes the sensing object also remove its listeners and free its resources.
  sensingObj.userData.dispose = () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    visualizer.scene.remove(sensingObj);
    geometry.dispose();
    material.dispose();
    const list = modelObj.sensingIntersectModelList;
    const index = list ? list.indexOf(sensingObj) : -1;
    if (list && index !== -1) {
      list.splice(index, 1);
    }
  };
}

/**
 * Checks whether a point in world coordinates lies inside a sensing object.
 *
 * For a box the valid region is x, y, z ∈ [–size/2, size/2] in the object's local coordinates.
 * For a cylinder it is |y| <= size/2 and sqrt(x^2 + z^2) <= size/2: THREE.CylinderGeometry runs
 * along its local Y axis.
 *
 * @param point - The point, in world coordinates.
 * @param sensingObj - The sensing object.
 * @param type - The shape of the sensing object ('box' or 'cylinder').
 * @param size - The size the sensing object was created with.
 * @returns Whether the point is inside.
 */
export function pointInsideSensing(
  point: THREE.Vector3,
  sensingObj: THREE.Mesh,
  type: 'box' | 'cylinder',
  size: number
): boolean {
  const inverseMatrix = new THREE.Matrix4().copy(sensingObj.matrixWorld).invert();
  const localPoint = point.clone().applyMatrix4(inverseMatrix);
  const half = size / 2;
  if (type === 'box') {
    return (
      Math.abs(localPoint.x) <= half &&
      Math.abs(localPoint.y) <= half &&
      Math.abs(localPoint.z) <= half
    );
  } else {
    const radial = Math.sqrt(localPoint.x * localPoint.x + localPoint.z * localPoint.z);
    return Math.abs(localPoint.y) <= half && radial <= half;
  }
}

/**
 * Updates the sense highlight to the area covered by the model's sensing objects.
 *
 * Every triangle of modelObj.mesh with at least one vertex inside any sensing object counts as
 * part of the sensing area. Those triangles are written into highlightSenseMesh's index and
 * drawRange, and selectedSenseFoamMesh is rebuilt from them.
 *
 * @param modelObj - The EverydayModel whose sense area is updated.
 * @param type - The shape of the sensing objects ('box' or 'cylinder').
 * @param size - The size the sensing objects were created with.
 * @returns Whether the highlight could be updated (false if the model has no sense highlight mesh).
 */
function _updateSenseIntersectionRegion(
  modelObj: EverydayModel,
  type: 'box' | 'cylinder',
  size: number
): boolean {
  const highlightMesh = modelObj.highlightSenseMesh;
  const newIndexAttr = highlightMesh?.geometry.index;
  if (!highlightMesh || !newIndexAttr) {
    return false;
  }

  const posAttr = modelObj.mesh.geometry.getAttribute('position');
  const indexAttr = modelObj.mesh.geometry.index;
  const indices: number[] = [];

  // The sensing objects were just moved; their world matrices are otherwise only refreshed on render.
  modelObj.mesh.updateMatrixWorld();
  const sensingObjects = modelObj.sensingIntersectModelList ?? [];
  sensingObjects.forEach(sensing => sensing.updateMatrixWorld());

  // 判断某顶点是否落在任一 sensing 对象内部
  const isInsideAny = (vertex: THREE.Vector3): boolean =>
    sensingObjects.some(sensing => pointInsideSensing(vertex, sensing, type, size));

  if (indexAttr) {
    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const v2 = new THREE.Vector3();
    for (let i = 0; i + 2 < indexAttr.count; i += 3) {
      const idx0 = indexAttr.getX(i);
      const idx1 = indexAttr.getX(i + 1);
      const idx2 = indexAttr.getX(i + 2);
      v0.fromBufferAttribute(posAttr, idx0).applyMatrix4(modelObj.mesh.matrixWorld);
      v1.fromBufferAttribute(posAttr, idx1).applyMatrix4(modelObj.mesh.matrixWorld);
      v2.fromBufferAttribute(posAttr, idx2).applyMatrix4(modelObj.mesh.matrixWorld);
      // 若任一顶点在 sensing 区域内，则记录该三角形的原始索引
      if (isInsideAny(v0) || isInsideAny(v1) || isInsideAny(v2)) {
        indices.push(idx0, idx1, idx2);
      }
    }
  }

  // 更新 highlightSenseMesh 的 geometry.index 和 drawRange
  const count = Math.min(indices.length, newIndexAttr.count);
  for (let i = 0; i < count; i++) {
    newIndexAttr.setX(i, indices[i]);
  }
  highlightMesh.geometry.drawRange.count = count;
  newIndexAttr.needsUpdate = true;

  // 生成选中区域 Mesh
  modelObj.selectedSenseFoamMesh = createSelectedMeshFromHighlight(highlightMesh);
  return true;
}

/**
 * Samples the model's selection again and regenerates its toolpath after the sense area changed.
 * Problems are shown to the user instead of being thrown into an event handler.
 *
 * @param visualizer - The Visualizer instance.
 * @param modelObj - The EverydayModel whose sense area changed.
 */
function _regenerateAfterSenseChange(visualizer: Visualizer, modelObj: EverydayModel): void {
  if (!modelObj.selectedRegularFoamMesh) {
    notify('Select a foam area on the model first; the sensing area is cut out of it.', 'warning');
    return;
  }
  try {
    updateSelectedMeshBoundingBox(visualizer, modelObj);
    sampleSelectedMesh(visualizer, modelObj);
    generateAugmentFoamToolpath(visualizer, modelObj);
  } catch (error) {
    console.error(error);
    notify(`Could not update the toolpath: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}
