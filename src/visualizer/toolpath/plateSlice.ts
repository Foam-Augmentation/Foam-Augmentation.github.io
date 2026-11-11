// ---------------------------------------------------------------------------------------------
// The result of slicing the plate's Foam Print and Regular Print objects: the G-code, a summary
// to show before it is exported, and a fingerprint of everything it was made from, so an export
// can tell when the plate has changed since.
//
// No DOM here, so it can be unit-tested under Node.
// ---------------------------------------------------------------------------------------------
import type * as THREE from 'three';
import type { EverydayModel } from '../types/modelTypes';
import type { PathPoint } from './pathTypes';
import type { RegularSlicerUsed } from './prusaSlicer';
import { getExtruderUsage } from './buildGcode';
import { SETTING_SPECS } from '../gui/paramSpecs';

/** What a slice holds for one object. */
export interface SlicedObject {
    /** How many layers of the object print something. */
    layers: number;
}

/** What a sliced plate contains, shown before it is exported. */
export interface PlateSummary {
    /** What sliced the Regular Print objects. Undefined when there were none. */
    regularSlicer?: RegularSlicerUsed;
    /** The objects that print something, by `EverydayModel.objectId`. */
    objects: Map<number, SlicedObject>;
    /** The extruders the file uses, in order of first use. */
    tools: number[];
    /** The height (mm) of the highest extrusion. 0 if nothing is extruded. */
    height: number;
    /** The size of the G-code file (bytes). */
    bytes: number;
}

/** A sliced plate, ready to be exported. */
export interface PlateSlice {
    gcode: string;
    /** The file name the G-code is offered under. */
    fileName: string;
    summary: PlateSummary;
    /** See {@link plateFingerprint}. Taken just before slicing. */
    fingerprint: string;
    /** The toolpath previews drawn in the scene for this slice. */
    previews: THREE.Object3D[];
    /** True once the plate has changed after slicing: the G-code no longer matches it. */
    stale: boolean;
}

/**
 * Sums up a sliced plate's toolpath.
 *
 * @param {PathPoint[]} toolpath Every point of the plate, in print order.
 * @param {string} gcode The G-code made from it.
 * @param {RegularSlicerUsed} [regularSlicer] What sliced the regular prints, if there were any.
 * @returns {PlateSummary} The summary.
 */
export function summarizePlate(toolpath: PathPoint[], gcode: string, regularSlicer?: RegularSlicerUsed): PlateSummary {
    const layersByObject = new Map<number, Set<number>>();
    let height = 0;
    for (const point of toolpath) {
        // Only extrusions of the objects themselves: not travel, not the purge line or tower.
        if (point.travel || point.role !== undefined) {
            continue;
        }
        if (point.point.z > height) {
            height = point.point.z;
        }
        if (point.objectId === undefined) {
            continue;
        }
        let layers = layersByObject.get(point.objectId);
        if (!layers) {
            layers = new Set();
            layersByObject.set(point.objectId, layers);
        }
        if (point.layer !== undefined) {
            layers.add(point.layer);
        }
    }

    const objects = new Map<number, SlicedObject>();
    for (const [objectId, layers] of layersByObject) {
        objects.set(objectId, { layers: layers.size });
    }
    return {
        regularSlicer,
        objects,
        tools: getExtruderUsage(toolpath).used,
        height,
        bytes: new TextEncoder().encode(gcode).length,
    };
}

/** A number per object, for things that are only told apart by identity (a loaded SVG, a mesh). */
const identities = new WeakMap<object, number>();
let lastIdentity = 0;

function identity(object: object | undefined | null): number | null {
    if (!object) return null;
    let id = identities.get(object);
    if (id === undefined) {
        id = ++lastIdentity;
        identities.set(object, id);
    }
    return id;
}

/**
 * Describes everything a plate slice depends on: every global setting and extruder, and for each
 * object that prints (in list order) its kind, placement, mesh and parameters, including the
 * files loaded for it. Two plates with the same fingerprint slice to the same G-code.
 *
 * @param {object} settings The global settings (`Visualizer.config`).
 * @param {EverydayModel[]} models Every object on the plate; augmentations are left out.
 * @returns {string} The fingerprint.
 */
export function plateFingerprint(settings: object, models: EverydayModel[]): string {
    const config = settings as Record<string, unknown>;
    const globalSettings = Object.keys(SETTING_SPECS).map(key => config[key]);
    return JSON.stringify({
        settings: globalSettings,
        extruders: config.extruders,
        models: models.filter(model => model.kind !== 'augment').map(model => [
            model.objectId,
            model.kind,
            model.name,
            model.mesh.position.toArray(),
            model.mesh.rotation.toArray(),
            model.mesh.scale.toArray(),
            model.mesh.geometry.uuid,
            model.regularConfig,
            model.toolpathConfig,
            model.initialConfig,
            model.initialOffset,
            identity(model.gradient),
            identity(model.bumpMesh),
            identity(model.augmentSamplePoints),
        ]),
    });
}
