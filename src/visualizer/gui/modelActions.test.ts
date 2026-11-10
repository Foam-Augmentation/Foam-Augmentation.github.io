import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ModelHost, disposeModel, syncAuxTransforms } from './modelActions';
import { EverydayModel, FoamModel } from '../types/modelTypes';

/** A mesh with its own geometry and material, already added to the scene. */
function meshIn(scene: THREE.Scene): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  scene.add(mesh);
  return mesh;
}

/** An everyday model carrying every kind of auxiliary object the app can attach to one. */
function makeEverydayModel(scene: THREE.Scene): EverydayModel {
  const mesh = meshIn(scene);
  const points = () => {
    const p = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial());
    scene.add(p);
    return p;
  };
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  scene.add(group);

  const model = {
    name: 'cup.stl',
    mesh,
    geometry: mesh.geometry,
    transformType: 'move',
    transformX: { x: 0 },
    transformY: { y: 0 },
    transformZ: { z: 0 },
    highlightFoamMesh: meshIn(scene),
    highlightSenseMesh: meshIn(scene),
    pointsMesh_foam: points(),
    pointsMesh_sense: points(),
    toolpathVisualizationObject: group,
    sensingIntersectModelList: [meshIn(scene)],
    toolpathSamplePoints: [{ point: new THREE.Vector3(), type: 'foam' }],
    guiItem: { domElement: {} as HTMLElement, destroy: vi.fn() },
  } as unknown as EverydayModel;

  // Helpers that toolpath code attaches without declaring them on the model type.
  const undeclared = model as unknown as Record<string, THREE.Object3D>;
  undeclared.selectedRegularFoamMeshBoundingBoxHelper = meshIn(scene);
  undeclared.selectedRegularFoamMeshOutline = meshIn(scene);
  return model;
}

/** A stand-in for the parts of the Visualizer that disposeModel uses. */
function makeHost(): ModelHost & { releaseModel: ReturnType<typeof vi.fn> } {
  return {
    scene: new THREE.Scene(),
    foamModelList: [],
    everydayModelList: [],
    uuid_to_modelObj_Map: new Map(),
    releaseModel: vi.fn(),
  };
}

describe('disposeModel', () => {
  it('removes the model, every auxiliary object, its map entry and its GUI folder', () => {
    const host = makeHost();
    const model = makeEverydayModel(host.scene);
    const other = makeEverydayModel(host.scene);
    host.everydayModelList.push(model, other);
    host.uuid_to_modelObj_Map.set(model.mesh.uuid, model);
    host.uuid_to_modelObj_Map.set(other.mesh.uuid, other);

    const objectsOfOther = host.scene.children.length / 2;
    const destroyFolder = model.guiItem!.destroy;
    const sensingObject = model.sensingIntersectModelList![0];
    // Stands in for the listener cleanup that addSensingIntersectionGeo attaches.
    const disposeSensing = vi.fn();
    sensingObject.userData.dispose = disposeSensing;
    const geometryDisposed = vi.fn();
    model.mesh.geometry.addEventListener('dispose', geometryDisposed);

    disposeModel(host, model);

    expect(host.releaseModel).toHaveBeenCalledWith(model);
    expect(host.everydayModelList).toEqual([other]);
    expect(host.uuid_to_modelObj_Map.has(model.mesh.uuid)).toBe(false);
    expect(host.uuid_to_modelObj_Map.has(other.mesh.uuid)).toBe(true);
    // Only the other model's objects are left in the scene.
    expect(host.scene.children).toHaveLength(objectsOfOther);
    expect(host.scene.children).toContain(other.mesh);
    expect(destroyFolder).toHaveBeenCalledTimes(1);
    expect(geometryDisposed).toHaveBeenCalledTimes(1);

    expect(model.highlightFoamMesh).toBeUndefined();
    expect(model.pointsMesh_foam).toBeUndefined();
    expect(model.toolpathVisualizationObject).toBeUndefined();
    expect(model.toolpathSamplePoints).toBeUndefined();
    expect(model.guiItem).toBeUndefined();

    // The sensing object's own cleanup (which unregisters its canvas listeners) must have run.
    expect(disposeSensing).toHaveBeenCalledTimes(1);
  });

  it('handles a foam model and can be called twice', () => {
    const host = makeHost();
    const mesh = meshIn(host.scene);
    const model: FoamModel = {
      name: 'block.stl',
      mesh,
      geometry: mesh.geometry,
      transformType: 'move',
      transformX: { x: 0 },
      transformY: { y: 0 },
      transformZ: { z: 0 },
    };
    host.foamModelList.push(model);
    host.uuid_to_modelObj_Map.set(mesh.uuid, model);

    disposeModel(host, model);
    expect(() => disposeModel(host, model)).not.toThrow();

    expect(host.foamModelList).toHaveLength(0);
    expect(host.scene.children).toHaveLength(0);
    expect(host.uuid_to_modelObj_Map.size).toBe(0);
  });
});

describe('syncAuxTransforms', () => {
  it('gives highlight meshes the full transform and point clouds the position only', () => {
    const scene = new THREE.Scene();
    const model = makeEverydayModel(scene);
    model.mesh.position.set(10, 20, 30);
    model.mesh.rotation.set(0.1, 0.2, 0.3);
    model.mesh.scale.set(2, 3, 4);

    syncAuxTransforms(model);

    for (const highlight of [model.highlightFoamMesh!, model.highlightSenseMesh!]) {
      expect(highlight.position.toArray()).toEqual([10, 20, 30]);
      expect(highlight.rotation.x).toBeCloseTo(0.1);
      expect(highlight.rotation.z).toBeCloseTo(0.3);
      expect(highlight.scale.toArray()).toEqual([2, 3, 4]);
    }
    for (const points of [model.pointsMesh_foam!, model.pointsMesh_sense!]) {
      expect(points.position.toArray()).toEqual([10, 20, 30]);
      // Rotation and scale are baked into the sampled points.
      expect(points.scale.toArray()).toEqual([1, 1, 1]);
      expect(points.rotation.x).toBe(0);
    }
  });

  it('does nothing for a model without auxiliary meshes', () => {
    const scene = new THREE.Scene();
    const mesh = meshIn(scene);
    const model: FoamModel = {
      name: 'block.stl', mesh, geometry: mesh.geometry, transformType: 'move',
      transformX: { x: 0 }, transformY: { y: 0 }, transformZ: { z: 0 },
    };
    expect(() => syncAuxTransforms(model)).not.toThrow();
  });
});
