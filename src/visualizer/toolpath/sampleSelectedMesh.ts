import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type Visualizer from '../Visualizer';
import type { EverydayModel, PointCloudPoint } from '../types/modelTypes';

/** Refuse to sample more grid cells than this; a grid that fine would freeze the tab. */
const MAX_GRID_CELLS = 4_000_000;

/**
 * Builds a BVH over a copy of a selected mesh's geometry with the model's scale and rotation
 * applied. The selected mesh itself is left untouched, so sampling the same selection again
 * (e.g. after selecting a sense area) does not scale or rotate it a second time.
 *
 * @param {THREE.Mesh | undefined} mesh The selected mesh, in the model's raw geometry coordinates.
 * @param {THREE.Matrix4} transform The model's rotation and scale.
 * @returns The BVH and the transformed geometry's bounding box, or null if the mesh has no triangles.
 */
function buildTransformedBVH(
    mesh: THREE.Mesh | undefined,
    transform: THREE.Matrix4,
): { bvh: MeshBVH; bbox: THREE.Box3 } | null {
    const position = mesh?.geometry.getAttribute('position');
    if (!mesh || !position || position.count < 3) {
        return null;
    }
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(transform);
    geometry.computeBoundingBox();
    return { bvh: new MeshBVH(geometry), bbox: geometry.boundingBox! };
}

/**
 * Samples the selected mesh using a simple grid sampling method (scanning in X and Y).
 *
 * A ray is cast straight down at every grid cell over the selected foam area. Cells that hit
 * the foam selection become foam points; cells that also hit the sense selection become sense
 * points. The results are stored in modelObj.toolpathSamplePoints, and two THREE.Points meshes
 * showing them replace the previous ones in the scene.
 *
 * Both selections are sampled with the model's current scale and rotation applied to a copy,
 * so neither selected mesh is modified.
 *
 * @param visualizer - The Visualizer instance which provides access to the scene.
 * @param modelObj - The model whose selection is sampled. Its toolpathSamplePoints are replaced;
 *                   they end up empty if no foam area is selected.
 * @throws {Error} If the model's grid size is not positive, or so small the grid would be enormous.
 */
export function sampleSelectedMesh(visualizer: Visualizer, modelObj: EverydayModel): void {
    const gridSize: number = modelObj.toolpathConfig.gridSize;
    if (!Number.isFinite(gridSize) || gridSize <= 0) {
        throw new Error(`Grid size must be greater than 0 (it is ${gridSize}).`);
    }

    // Arrays for foam and sense vertices.
    const vertices_foam: number[] = [];
    const vertices_sense: number[] = [];
    // Clear previous sample points.
    const samplePoints: PointCloudPoint[] = [];
    modelObj.toolpathSamplePoints = samplePoints;

    // The model's rotation and scale, but not its position: sample points are relative to the model.
    const transform = new THREE.Matrix4().compose(new THREE.Vector3(), modelObj.mesh.quaternion, modelObj.mesh.scale);
    const foam = buildTransformedBVH(modelObj.selectedRegularFoamMesh, transform);
    const sense = buildTransformedBVH(modelObj.selectedSenseFoamMesh, transform);

    if (foam) {
        const bbox = foam.bbox;
        const countX = Math.floor((bbox.max.x - bbox.min.x) / gridSize) + 1;
        const countY = Math.floor((bbox.max.y - bbox.min.y) / gridSize) + 1;
        if (countX * countY > MAX_GRID_CELLS) {
            throw new Error(`A grid size of ${gridSize} mm gives ${countX} x ${countY} sample points for this selection. Increase the grid size.`);
        }

        // Rays come from above everything that can be hit.
        const rayZ = Math.max(bbox.max.z, sense ? sense.bbox.max.z : -Infinity) + 10;
        const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));

        // Grid sample the selected mesh by scanning over the bounding box in X and Y. The grid is
        // stepped by index, so rounding cannot accumulate from one cell to the next.
        for (let ix = 0; ix < countX; ix++) {
            const x = bbox.min.x + ix * gridSize;
            for (let iy = 0; iy < countY; iy++) {
                const y = bbox.min.y + iy * gridSize;
                ray.origin.set(x, y, rayZ);

                const hitFoam = foam.bvh.raycastFirst(ray, THREE.FrontSide);
                if (!hitFoam) {
                    continue;
                }
                const hitSense = sense ? sense.bvh.raycastFirst(ray, THREE.FrontSide) : null;

                // If both foam and sense meshes are hit, treat the point as a sense point;
                // otherwise, as a foam point.
                const point = hitFoam.point.clone();
                if (hitSense) {
                    samplePoints.push({ point, type: 'sense' });
                    vertices_sense.push(point.x, point.y, point.z);
                } else {
                    samplePoints.push({ point, type: 'foam' });
                    vertices_foam.push(point.x, point.y, point.z);
                }
            }
        }
    }

    // Create materials for foam and sense points.
    const pointsMaterialFoam = new THREE.PointsMaterial({
        size: 4,
        color: 0xff9d3c // foam orange, as in style.css (--foam)
    });
    const pointsMaterialSense = new THREE.PointsMaterial({
        size: 4,
        color: 0x000000 // black points for sense
    });

    // Create new buffer geometries for foam and sense points.
    const pointsGeometry_foam = new THREE.BufferGeometry();
    const pointsGeometry_sense = new THREE.BufferGeometry();
    pointsGeometry_foam.setAttribute('position', new THREE.Float32BufferAttribute(vertices_foam, 3));
    pointsGeometry_sense.setAttribute('position', new THREE.Float32BufferAttribute(vertices_sense, 3));

    // Create Points meshes for foam and sense vertices.
    const pointsMesh_foam = new THREE.Points(pointsGeometry_foam, pointsMaterialFoam);
    const pointsMesh_sense = new THREE.Points(pointsGeometry_sense, pointsMaterialSense);
    // Add the points meshes to the scene.
    visualizer.scene.add(pointsMesh_foam);
    visualizer.scene.add(pointsMesh_sense);

    // Remove previous foam points mesh if exists.
    if (modelObj.pointsMesh_foam) {
        visualizer.scene.remove(modelObj.pointsMesh_foam);
        modelObj.pointsMesh_foam.geometry.dispose();
        (modelObj.pointsMesh_foam.material as THREE.Material).dispose();
    }
    // Save the new foam points mesh, positioned to match the model's mesh.
    modelObj.pointsMesh_foam = pointsMesh_foam;
    pointsMesh_foam.position.copy(modelObj.mesh.position);

    // Remove previous sense points mesh if exists.
    if (modelObj.pointsMesh_sense) {
        visualizer.scene.remove(modelObj.pointsMesh_sense);
        modelObj.pointsMesh_sense.geometry.dispose();
        (modelObj.pointsMesh_sense.material as THREE.Material).dispose();
    }
    // Save the new sense points mesh.
    modelObj.pointsMesh_sense = pointsMesh_sense;
    pointsMesh_sense.position.copy(modelObj.mesh.position);
}
