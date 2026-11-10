import type Visualizer from '../Visualizer';
import type { PathPoint } from './pathTypes';
import { notify, withBusy } from '../gui/notify';
import * as THREE from 'three';
import type { EverydayModel } from '../types/modelTypes';
import {
    generateAugmentFoamToolpath,
    generateFoamToolpath,
    getTransformedMesh,
    makePurgeLine,
    visualizeToolpath,
} from './generateFoamToolpath';
import { generateRegularToolpath } from './regularSlicer';
import { disposeObject3D } from '../gui/modelActions';
import { buildPrintGcode, getPurgeTowerHeight } from './buildGcode';
import { saveGcodeToFile } from './saveGcodeToFile';
import { defaultDownloadName } from '../gui/downloadName';
import { TRAVEL_CLEARANCE, TRAVEL_PREVIEW_COLOR } from './toolpathConstants';


/**
 * Handler for "Save Toolpath G-Code": builds one G-code file from every everyday model that has
 * a selection, and downloads it.
 *
 * The toolpaths are generated here, at save time, one model after the other, so that
 * - they reflect the parameters as they are now, not as they were when the area was selected,
 * - the shared purge tower continues from one model into the next, and
 * - the G-code bodies are emitted in a single pass, with the tool that is picked carried from
 *   each model into the next (see {@link buildPrintGcode}).
 *
 * Problems are reported to the user as toasts; the returned promise never rejects.
 *
 * @param {Visualizer} visualizer The visualizer holding the models and the printer.
 * @returns {Promise<void>} Resolves once the file has been handed to the browser (or nothing was saved).
 */
export function saveAugmentGcode(visualizer: Visualizer): Promise<void> {
    const models = visualizer.everydayModelList.filter(
        model => model.kind === 'augment' && model.toolpathSamplePoints && model.toolpathSamplePoints.length > 0
    );
    if (!models.length) {
        notify('There is no augmentation to export yet. Press “Select Foam Area” on an Augmentation object and drag over it first.', 'warning');
        return Promise.resolve();
    }

    return withBusy('Generating G-code…', () => {
        const toolpaths: PathPoint[][] = [];
        let purgeTowerHeight = 0;
        // The highest point of everything printed so far, which later models have to stay clear of.
        let highestZ = -Infinity;
        for (const model of models) {
            const toolpath = generateAugmentFoamToolpath(visualizer, model, {
                purgeTowerStartHeight: purgeTowerHeight,
                minimumSafeZ: highestZ + TRAVEL_CLEARANCE,
            });
            if (!toolpath) {
                notify(`"${model.name}" has no printable area and was left out of the G-code.`, 'warning');
                continue;
            }
            purgeTowerHeight = Math.max(purgeTowerHeight, getPurgeTowerHeight(toolpath));
            for (const point of toolpath) {
                if (point.point.z > highestZ) {
                    highestZ = point.point.z;
                }
            }
            toolpaths.push(toolpath);
        }

        if (!toolpaths.length) {
            notify('No G-code was saved: none of the selections has a printable area.', 'warning');
            return;
        }

        const gcode = buildPrintGcode(visualizer.printer, toolpaths);
        saveGcodeToFile(gcode, defaultDownloadName(models.length === 1 ? models[0].name : 'toolpath', 'gcode'));
        notify(`G-code for ${toolpaths.length} model${toolpaths.length === 1 ? '' : 's'} saved.`, 'success');
    }).catch(error => {
        // withBusy has already shown the message; keep the details for debugging.
        console.error(error);
    });
}

/**
 * Slices the regular-print objects into one toolpath (all of them together, layer by layer)
 * and shows it in the scene.
 *
 * @param {Visualizer} visualizer The visualizer holding the printer and the scene.
 * @param {EverydayModel[]} models The objects whose kind is `regular`.
 * @returns {PathPoint[]} The toolpath; empty if there is nothing to print.
 * @throws {Error} If an object's regular-print settings are invalid.
 */
function sliceRegularModels(visualizer: Visualizer, models: EverydayModel[]): PathPoint[] {
    // Whatever was previewed for these objects before is about to be out of date.
    models.forEach(model => {
        disposeObject3D(model.toolpathVisualizationObject);
        model.toolpathVisualizationObject = undefined;
    });
    if (!models.length) {
        return [];
    }

    const toolpath = generateRegularToolpath(
        visualizer.printer,
        models.map(model => ({
            // Rotation and scale are baked into the copy; the position is added as an offset.
            mesh: getTransformedMesh(model.mesh),
            offset: model.mesh.position.clone(),
            config: model.regularConfig,
            name: model.name,
        }))
    );
    if (!toolpath.length) {
        return [];
    }

    const preview = new THREE.Group();
    visualizeToolpath(toolpath, preview, visualizer.printer.extruders.map(e => e.color), TRAVEL_PREVIEW_COLOR);
    visualizer.scene.add(preview);
    models[0].toolpathVisualizationObject = preview;
    return toolpath;
}

/**
 * Replaces the travel a toolpath opens with by an approach from above.
 *
 * The foam slicer starts its path at the bed origin and travels to the model at printing
 * height. On an empty bed that is harmless, but once other parts have been printed the nozzle
 * would be dragged through whatever stands in between. This drops those opening travel moves
 * and instead arrives straight above the point where printing starts, at `safeZ`, then goes
 * down to it.
 *
 * @param {PathPoint[]} toolpath The toolpath. It is not modified.
 * @param {number} safeZ A height (mm) that clears everything printed so far.
 * @returns {PathPoint[]} The toolpath with its opening travel replaced. A toolpath that never
 *                        extrudes, or does not open with a travel, is returned unchanged.
 */
export function leadInFromAbove(toolpath: PathPoint[], safeZ: number): PathPoint[] {
    const firstPrint = toolpath.findIndex(point => !point.travel);
    if (firstPrint <= 0) {
        return toolpath;
    }

    // The last opening travel point is where printing starts from; keep it as the landing point.
    const landing = toolpath[firstPrint - 1];
    // The dropped points may be the ones that say which tool to use: carry that over.
    const extruder = toolpath.slice(0, firstPrint).find(point => point.extruder !== undefined)?.extruder;
    const above: PathPoint = {
        point: new THREE.Vector3(landing.point.x, landing.point.y, Math.max(safeZ, landing.point.z)),
        travel: true,
        role: 'approach',
    };
    if (extruder !== undefined) {
        above.extruder = extruder;
    }
    return [above, landing, ...toolpath.slice(firstPrint)];
}

/**
 * Returns the highest point of a toolpath.
 *
 * @param {PathPoint[]} toolpath The toolpath.
 * @returns {number} The largest z, or -Infinity for an empty toolpath.
 */
function highestZ(toolpath: PathPoint[]): number {
    let highest = -Infinity;
    for (const point of toolpath) {
        if (point.point.z > highest) highest = point.point.z;
    }
    return highest;
}

/**
 * Handler for "Slice & Export Prints": slices every Foam Print and Regular Print object on the
 * plate, builds one G-code file and downloads it. The work runs behind a busy overlay because
 * slicing blocks the page.
 *
 * Regular prints come first, all of them together layer by layer; the foam prints follow.
 * Between the two the head rises clear of everything printed so far and crosses to the first
 * foam point at that height. Augmentation objects are not part of this file (see
 * {@link saveAugmentGcode}).
 *
 * Problems are reported to the user as toasts; the returned promise never rejects.
 *
 * @param {Visualizer} visualizer The visualizer holding the models and the printer.
 * @returns {Promise<void>} Resolves once the file has been handed to the browser (or nothing was saved).
 */
export function slicePlateAndSave(visualizer: Visualizer): Promise<void> {
    const foamModels = visualizer.everydayModelList.filter(model => model.kind === 'foam');
    const regularModels = visualizer.everydayModelList.filter(model => model.kind === 'regular');
    const models = [...regularModels, ...foamModels];
    if (!models.length) {
        notify('There is nothing to slice. Add a Foam Print or Regular Print object first.', 'warning');
        return Promise.resolve();
    }

    return withBusy('Slicing plate…', () => {
        const printer = visualizer.printer;
        const regularPath = sliceRegularModels(visualizer, regularModels);
        // The purge line is printed once, at the very start of the file. The foam slicer adds
        // its own when it is the only thing printed; with regular prints first, it goes in front
        // of those instead.
        const foamPath = foamModels.length
            ? generateFoamToolpath(visualizer, foamModels, regularPath.length ? { purgeLine: false } : {})
            : [];

        const toolpaths: PathPoint[][] = [];
        if (regularPath.length) {
            toolpaths.push(printer.purgeLine ? [...makePurgeLine(printer), ...regularPath] : regularPath);
        }
        if (foamPath.length) {
            if (regularPath.length) {
                // Leave the finished regular parts straight up, then cross to the foam print
                // above everything that has been printed.
                const safeZ = highestZ(regularPath) + TRAVEL_CLEARANCE;
                const last = regularPath[regularPath.length - 1].point;
                toolpaths[0].push({ point: new THREE.Vector3(last.x, last.y, safeZ), travel: true, role: 'approach' });
                toolpaths.push(leadInFromAbove(foamPath, safeZ));
            } else {
                toolpaths.push(foamPath);
            }
        }

        if (!toolpaths.length) {
            notify('Slicing produced nothing to print. Check that the objects are on the bed and have some height.', 'warning');
            return;
        }

        const gcode = buildPrintGcode(printer, toolpaths);
        saveGcodeToFile(gcode, defaultDownloadName(models.length === 1 ? models[0].name : 'toolpath', 'gcode'));
        notify('Plate sliced and G-code saved.', 'success');
        if (regularPath.length && foamPath.length) {
            notify(
                'This file prints the regular parts first and the foam parts after them. Nothing checks that the print head clears the finished regular parts while it prints foam next to them: keep them well apart.',
                'warning'
            );
        }
    }).catch(error => {
        // withBusy has already shown the message; keep the details for debugging.
        console.error(error);
    });
}
