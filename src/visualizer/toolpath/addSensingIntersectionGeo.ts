import * as THREE from 'three';
import Visualizer from '../Visualizer';
import { EverydayModel } from '../types/modelTypes';
import { createSelectedMeshFromHighlight } from '../interactions/createSelectedMeshFromHighlight';
import { updateSelectedMeshBoundingBox } from './updateSelectedMeshBoundingBox';
import { sampleSelectedMesh } from './sampleSelectedMesh';
import { generateAugmentFoamToolpath } from './generateFoamToolpath';

/**
 * Adds a sensing intersection geometry to an EverydayModel.
 *
 * 创建一个 sensing 对象（box 或 cylinder），并将其添加到 modelObj.sensingIntersectModelList 与场景中。
 * 拖拽时更新 sensingObj 位置，同时调用 _updateSenseIntersectionRegion，
 * 计算 modelObj.mesh 与所有 sensing 对象（联合区域）的交集，将结果更新到 highlightSenseMesh 与 selectedSenseFoamMesh 中，
 * 并调用后续处理函数（创建选中网格、更新边界盒、采样、生成工具路径）。
 *
 * @param modelObj - EverydayModel 对象
 * @param type - sensing 对象的类型 ('cylinder' 或 'box')
 * @param size - 当 type 为 box 时为边长；为 cylinder 时为直径
 * @param visualizer - Visualizer 实例（包含 scene、camera、renderer、orbitControls 等）
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
  let isDragging = false;
  const onPointerDown = (event: PointerEvent) => {
    const rect = visualizer.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(mouse, visualizer.camera);
    const hits = rc.intersectObject(sensingObj);
    if (hits.length > 0) {
      isDragging = true;
      console.log('Dragging sensing object');
      visualizer.orbitControls.enabled = false;
      event.stopPropagation();
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!isDragging) return;
    const rect = visualizer.renderer.domElement.getBoundingClientRect();
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
      _updateSenseIntersectionRegion(visualizer, modelObj, type, size);
    }
  };

  const onPointerUp = () => {
    isDragging = false;
    visualizer.orbitControls.enabled = true;
  };

  visualizer.renderer.domElement.addEventListener('pointerdown', onPointerDown);
  visualizer.renderer.domElement.addEventListener('pointermove', onPointerMove);
  visualizer.renderer.domElement.addEventListener('pointerup', onPointerUp);
}

/**
 * 检查一个世界坐标点是否落在某个 sensing 对象内部。
 *
 * 对于 box：有效区域为 sensing 对象局部坐标的 x,y,z ∈ [–size/2, size/2]
 * 对于 cylinder：假设沿局部 z 轴，要求 |z| <= size/2 且 sqrt(x^2+y^2) <= size/2
 *
 * @param point - 世界坐标下的点
 * @param sensingObj - sensing 对象
 * @param type - sensing 类型 ('box' 或 'cylinder')
 * @param size - 尺寸参数
 * @returns 是否在内部
 */
function pointInsideSensing(
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
    const radial = Math.sqrt(localPoint.x * localPoint.x + localPoint.y * localPoint.y);
    return Math.abs(localPoint.z) <= half && radial <= half;
  }
}

/**
 * 更新 sensing 区域的交集。
 *
 * 遍历 modelObj.mesh 的所有三角形，若任一顶点落在 modelObj.sensingIntersectModelList 中任一 sensing 对象内部，
 * 则认为该三角形属于交集区域，将该三角形的原始索引记录到 indices 数组中，
 * 最后根据 indices 数组更新 highlightSenseMesh 的 geometry.index 和 drawRange，
 * 并调用 createSelectedMeshFromHighlight、updateSelectedMeshBoundingBox、sampleSelectedMesh、generateFoamToolpath 等后续处理函数。
 *
 * @param visualizer - Visualizer 实例
 * @param modelObj - EverydayModel 对象
 * @param type - sensing 类型 ('box' 或 'cylinder')
 * @param size - 尺寸参数
 */
function _updateSenseIntersectionRegion(
  visualizer: Visualizer,
  modelObj: EverydayModel,
  type: 'box' | 'cylinder',
  size: number
): void {
  const posAttr = modelObj.mesh.geometry.getAttribute('position');
  const indexAttr = modelObj.mesh.geometry.index;
  const indices: number[] = [];

  // 判断某顶点是否落在任一 sensing 对象内部
  const isInsideAny = (vertex: THREE.Vector3): boolean => {
    if (modelObj.sensingIntersectModelList) {
      for (const sensing of modelObj.sensingIntersectModelList) {
        if (pointInsideSensing(vertex, sensing, type, size)) {
          return true;
        }
      }
    }
    return false;
  };

  if (indexAttr) {
    for (let i = 0; i < indexAttr.count; i += 3) {
      const idx0 = indexAttr.getX(i);
      const idx1 = indexAttr.getX(i + 1);
      const idx2 = indexAttr.getX(i + 2);
      const v0 = new THREE.Vector3(
        posAttr.getX(idx0),
        posAttr.getY(idx0),
        posAttr.getZ(idx0)
      ).applyMatrix4(modelObj.mesh.matrixWorld);
      const v1 = new THREE.Vector3(
        posAttr.getX(idx1),
        posAttr.getY(idx1),
        posAttr.getZ(idx1)
      ).applyMatrix4(modelObj.mesh.matrixWorld);
      const v2 = new THREE.Vector3(
        posAttr.getX(idx2),
        posAttr.getY(idx2),
        posAttr.getZ(idx2)
      ).applyMatrix4(modelObj.mesh.matrixWorld);
      // 若任一顶点在 sensing 区域内，则记录该三角形的原始索引
      if (isInsideAny(v0) || isInsideAny(v1) || isInsideAny(v2)) {
        indices.push(idx0, idx1, idx2);
      }
    }
  }

  // 更新 highlightSenseMesh 的 geometry.index 和 drawRange
  let highlightMesh: THREE.Mesh = modelObj.highlightSenseMesh || new THREE.Mesh();
  if (!highlightMesh) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', posAttr.clone());
    if (indexAttr) {
      geom.setIndex(indexAttr.clone());
    }
    highlightMesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true }));
    modelObj.highlightSenseMesh = highlightMesh;
    visualizer.scene.add(highlightMesh);
  }
  const newIndexAttr = highlightMesh.geometry.index!;
  // 将 indices 数组复制到 newIndexAttr 中
  for (let i = 0, l = indices.length; i < l; i++) {
    newIndexAttr.setX(i, indices[i]);
  }
  highlightMesh.geometry.drawRange.count = indices.length;
  newIndexAttr.needsUpdate = true;

  // 生成选中区域 Mesh
  if (highlightMesh) {
    modelObj.selectedSenseFoamMesh = createSelectedMeshFromHighlight(highlightMesh);
  }
  
  console.log("updated selected mesh bounding box call from addSensingIntersectionGeo");
  updateSelectedMeshBoundingBox(visualizer, modelObj);
  sampleSelectedMesh(visualizer, modelObj);
  generateAugmentFoamToolpath(visualizer, modelObj);
}
