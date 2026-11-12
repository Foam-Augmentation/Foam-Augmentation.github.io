// src/visualizer/gui/placement.ts
/**
 * Placing objects on the bed: resting them on it, laying them on a face, arranging the plate,
 * finding free space for new objects and copies, and checking that printing foam will not drive
 * the print head into another part. The geometry is in utils/arrange.ts; this file turns meshes
 * into outlines and applies the results.
 */
import * as THREE from 'three';
import type Visualizer from '../Visualizer';
import type Printer from '../../printer/Printer';
import type { EverydayModel, ObjectKind } from '../types/modelTypes';
import { syncAuxTransforms, syncTransformFields } from './modelActions';
import {
    arrange,
    circlePolygon,
    convexHull,
    findFreeSpot,
    headConflicts,
    type ArrangeItem,
    type ArrangeSpace,
    type Point2,
} from '../utils/arrange';
import { PURGE_LINE_COUNT, PURGE_LINE_SEPARATION } from '../toolpath/toolpathConstants';
import { notify } from './notify';

/** The smallest gap (mm) between two objects when arranging, as in PrusaSlicer. */
const ARRANGE_SPACING = 6;
/** The grid (mm) positions are tried on. */
const ARRANGE_STEP = 2.5;

/**
 * The bed and printer as the arranger needs them: size, margin, spacing, the print head's reach,
 * and the areas the purge line and purge tower take.
 *
 * @param printer - The printer.
 * @returns The arranging space.
 */
export function arrangeSpace(printer: Printer): ArrangeSpace {
    const reserved = [];
    if (printer.purgeLine) {
        // The purge line runs along the front edge, PURGE_LINE_COUNT passes deep.
        const depth = printer.bedMargin + PURGE_LINE_SEPARATION * (PURGE_LINE_COUNT - 1);
        reserved.push([{ x: 0, y: 0 }, { x: printer.machine_depth, y: 0 }, { x: printer.machine_depth, y: depth }, { x: 0, y: depth }]);
    }
    if (printer.purgeTower) {
        const center = printer.purgeTowerCenter();
        reserved.push(circlePolygon({ x: center.x, y: center.y }, printer.purgeTowerRadius));
    }
    const head = printer.printHeadDims;
    return {
        width: printer.machine_depth,
        depth: printer.machine_depth_y,
        margin: printer.bedMargin,
        spacing: ARRANGE_SPACING,
        head: { minX: head.min.x, minY: head.min.y, maxX: head.max.x, maxY: head.max.y },
        // The shortest nozzle decides how close the head body comes to a part.
        nozzleLength: Math.min(...printer.extruders.map(e => e.nozzleLength)),
        reserved,
        step: ARRANGE_STEP,
    };
}

/**
 * A mesh as the arranger sees it: its outline seen from above (relative to its position) and its height.
 *
 * @param mesh - The mesh, placed.
 * @returns The outline and the height of its top.
 */
function meshFootprint(mesh: THREE.Mesh): { outline: Point2[], top: number } {
    mesh.updateMatrixWorld(true);
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const vertex = new THREE.Vector3();
    const points: Point2[] = [];
    let top = -Infinity;
    for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
        points.push({ x: vertex.x - mesh.position.x, y: vertex.y - mesh.position.y });
        if (vertex.z > top) top = vertex.z;
    }
    return { outline: convexHull(points), top: Number.isFinite(top) ? top : 0 };
}

/**
 * An object as the arranger sees it.
 *
 * @param model - The object.
 * @returns Its outline, position, height, whether foam is printed at it and whether it may move.
 */
export function arrangeItem(model: EverydayModel): ArrangeItem {
    return itemOf(model.mesh, model.kind, model.objectId);
}

function itemOf(mesh: THREE.Mesh, kind: ObjectKind, id: number): ArrangeItem {
    const { outline, top } = meshFootprint(mesh);
    return {
        id,
        outline,
        position: { x: mesh.position.x, y: mesh.position.y },
        top,
        foam: kind !== 'regular',
        // An augmentation is a real object on the bed: it stays where it was put.
        movable: kind !== 'augment',
    };
}

/**
 * Moves a mesh up or down so its lowest point rests on the bed, whatever its rotation and scale.
 *
 * @param mesh - The mesh.
 */
export function dropMeshToBed(mesh: THREE.Mesh): void {
    mesh.updateMatrixWorld(true);
    // Precise: from the vertices. The default turns the mesh's own bounding box with it, whose
    // corners sit lower than the mesh at any angle that is not a multiple of 90°.
    const box = new THREE.Box3().setFromObject(mesh, true);
    if (!box.isEmpty()) mesh.position.z -= box.min.z;
}

/**
 * Brings everything that hangs off an object's placement up to date after its mesh moved: the
 * auxiliary meshes, the numbers in its Transform folder, and its toolpath (an augmentation's is
 * generated again; a print's plate slice goes out of date).
 *
 * @param visualizer - The Visualizer instance.
 * @param model - The object that moved.
 */
export function placementChanged(visualizer: Visualizer, model: EverydayModel): void {
    syncAuxTransforms(model);
    syncTransformFields(model);
    visualizer.scheduleToolpathRefresh(model);
}

/**
 * Turns an object so the face with the given normal faces down, and rests it on the bed.
 *
 * @param visualizer - The Visualizer instance.
 * @param model - The object.
 * @param worldNormal - The face's outward normal, in world coordinates.
 */
export function layOnFace(visualizer: Visualizer, model: EverydayModel, worldNormal: THREE.Vector3): void {
    const turn = new THREE.Quaternion().setFromUnitVectors(worldNormal.clone().normalize(), new THREE.Vector3(0, 0, -1));
    model.mesh.quaternion.premultiply(turn);
    dropMeshToBed(model.mesh);
    placementChanged(visualizer, model);
}

/**
 * Finds the free spot nearest to `near` for a mesh about to join the plate, clear of every object
 * on it, and moves the mesh there. Leaves it where it is if it fits nowhere.
 *
 * @param visualizer - The Visualizer instance.
 * @param mesh - The new mesh, rotated and scaled as it will be.
 * @param kind - What it will be.
 * @param near - Where to look first. Defaults to where the mesh is.
 * @returns True if it was placed clear of everything.
 */
export function placeNewMesh(visualizer: Visualizer, mesh: THREE.Mesh, kind: ObjectKind, near?: Point2): boolean {
    const item = itemOf(mesh, kind, -1);
    const others = visualizer.everydayModelList.filter(model => model.mesh !== mesh).map(arrangeItem);
    const spot = findFreeSpot(item, others, arrangeSpace(visualizer.printer), near ?? item.position);
    if (!spot) return false;
    mesh.position.x = spot.x;
    mesh.position.y = spot.y;
    return true;
}

/**
 * Arranges the plate: every Foam Print and Regular Print moves to where it is clear of the others,
 * of the Augmentation objects (which stay put) and of the purge line and tower, packed around the
 * middle of the bed. A foam print is kept clear of the print head's reach around it.
 *
 * @param visualizer - The Visualizer instance.
 */
export function arrangePlate(visualizer: Visualizer): void {
    const models = visualizer.everydayModelList;
    if (!models.some(model => model.kind !== 'augment')) {
        notify('There is nothing to arrange: Augmentation objects stay where they are.', 'info');
        return;
    }
    const { positions, unplaced } = arrange(models.map(arrangeItem), arrangeSpace(visualizer.printer));
    for (const model of models) {
        const at = positions.get(model.objectId);
        if (!at) continue;
        model.mesh.position.x = at.x;
        model.mesh.position.y = at.y;
        placementChanged(visualizer, model);
    }
    if (unplaced.length) {
        const names = models.filter(model => unplaced.includes(model.objectId)).map(model => `“${model.name}”`);
        notify(`${names.join(', ')} did not fit on the bed with the room the print head needs, and stayed where ${unplaced.length === 1 ? 'it was' : 'they were'}.`, 'warning');
    } else {
        notify('Plate arranged.', 'success');
    }
}

/**
 * Describes every place where printing foam at one object would bring the print head into another
 * object that is taller than the nozzle.
 *
 * @param visualizer - The Visualizer instance.
 * @param models - The objects on the plate to check.
 * @returns One sentence per conflict. Empty if there is none.
 */
export function describeHeadConflicts(visualizer: Visualizer, models: EverydayModel[]): string[] {
    const name = (id: number) => `“${models.find(model => model.objectId === id)?.name ?? 'object'}”`;
    return headConflicts(models.map(arrangeItem), arrangeSpace(visualizer.printer))
        .map(([foam, other]) => `While foam prints at ${name(foam)}, the print head would reach ${name(other)}.`);
}
