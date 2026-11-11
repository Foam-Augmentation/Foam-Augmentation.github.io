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
import { sliceRegularParts, type RegularSlicerUsed } from './prusaSlicer';
import { disposeObject3D } from '../gui/modelActions';
import { plateFingerprint, summarizePlate } from './plateSlice';
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
 * Slices the regular-print objects into one toolpath and shows it in the scene.
 *
 * In the desktop app with PrusaSlicer installed, PrusaSlicer slices them; otherwise the built-in
 * slicer does (all of them together, layer by layer). Anything the user should know about which
 * slicer ran is shown as a toast.
 *
 * @param {Visualizer} visualizer The visualizer holding the printer and the scene.
 * @param {EverydayModel[]} models The objects whose kind is `regular`.
 * @returns {Promise<{ toolpath: PathPoint[], slicer: RegularSlicerUsed }>} The toolpath (empty if
 *          there is nothing to print) and which slicer made it.
 * @throws {Error} If an object's regular-print settings are invalid, or PrusaSlicer fails.
 */
async function sliceRegularModels(
    visualizer: Visualizer,
    models: EverydayModel[],
): Promise<{ toolpath: PathPoint[], slicer: RegularSlicerUsed }> {
    // Whatever was previewed for these objects before is about to be out of date.
    models.forEach(model => {
        disposeObject3D(model.toolpathVisualizationObject);
        model.toolpathVisualizationObject = undefined;
    });
    if (!models.length) {
        return { toolpath: [], slicer: 'builtin' };
    }

    const { toolpath, slicer, notes } = await sliceRegularParts(
        visualizer.printer,
        models.map(model => ({
            // Rotation and scale are baked into the copy; the position is added as an offset.
            mesh: getTransformedMesh(model.mesh),
            offset: model.mesh.position.clone(),
            config: model.regularConfig,
            name: model.name,
            objectId: model.objectId,
        }))
    );
    notes.forEach(note => notify(note, 'warning'));
    if (!toolpath.length) {
        return { toolpath, slicer };
    }

    const preview = new THREE.Group();
    visualizeToolpath(toolpath, preview, visualizer.printer.extruders.map(e => e.color), TRAVEL_PREVIEW_COLOR);
    visualizer.scene.add(preview);
    models[0].toolpathVisualizationObject = preview;
    return { toolpath, slicer };
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
 * Handler for "Slice Prints": slices every Foam Print and Regular Print object on the plate into
 * one G-code file, shows its toolpath and keeps the file for "Export Print G-Code" (see
 * {@link exportPlateGcode}), so the result can be looked at before it is saved. The work runs
 * behind a busy overlay because slicing blocks the page.
 *
 * Regular prints come first, all of them together layer by layer; the foam prints follow.
 * Between the two the head rises clear of everything printed so far and crosses to the first
 * foam point at that height. Augmentation objects are not part of this file (see
 * {@link saveAugmentGcode}).
 *
 * Problems are reported to the user as toasts; the returned promise never rejects.
 *
 * @param {Visualizer} visualizer The visualizer holding the models and the printer.
 * @returns {Promise<void>} Resolves once the plate is sliced (or nothing was).
 */
export function slicePlate(visualizer: Visualizer): Promise<void> {
    const foamModels = visualizer.everydayModelList.filter(model => model.kind === 'foam');
    const regularModels = visualizer.everydayModelList.filter(model => model.kind === 'regular');
    const models = [...regularModels, ...foamModels];
    if (!models.length) {
        notify('There is nothing to slice. Add a Foam Print or Regular Print object first.', 'warning');
        return Promise.resolve();
    }

    // Taken before slicing, so an export can tell whether the plate changed since.
    const fingerprint = plateFingerprint(visualizer.config, visualizer.everydayModelList);

    return withBusy('Slicing plate…', async () => {
        const printer = visualizer.printer;
        // The old slice's preview goes now, so it is never shown next to the new one.
        visualizer.invalidatePlateSlice();

        const regular = await sliceRegularModels(visualizer, regularModels);
        const regularPath = regular.toolpath;
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

        // What the two slicers drew. They hang off the first object of each kind.
        const previews = [regularModels[0], foamModels[0]]
            .map(model => model?.toolpathVisualizationObject)
            .filter((preview): preview is THREE.Group => preview !== undefined);

        if (!toolpaths.length) {
            previews.forEach(preview => disposeObject3D(preview));
            notify('Slicing produced nothing to print. Check that the objects are on the bed and have some height.', 'warning');
            return;
        }

        const gcode = buildPrintGcode(printer, toolpaths);
        const summary = summarizePlate(toolpaths.flat(), gcode, regularModels.length ? regular.slicer : undefined);
        visualizer.setPlateSlice({
            gcode,
            fileName: defaultDownloadName(models.length === 1 ? models[0].name : 'toolpath', 'gcode'),
            summary,
            fingerprint,
            previews,
            stale: false,
        });

        notify('Plate sliced. Check the preview and the summary, then press Export Print G-Code.', 'success');
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

/**
 * Handler for "Export Print G-Code": saves the G-code of the last plate slice.
 *
 * Refuses, with a message, when there is no slice or the plate has changed since it was made:
 * the file would no longer print what is on the plate.
 *
 * @param {Visualizer} visualizer The visualizer holding the plate slice.
 */
export function exportPlateGcode(visualizer: Visualizer): void {
    const slice = visualizer.plateSlice;
    if (!slice) {
        notify('Slice the plate first: press Slice Prints.', 'warning');
        return;
    }
    // Every change the app knows of marks the slice stale; the fingerprint also catches the rest.
    if (slice.stale || plateFingerprint(visualizer.config, visualizer.everydayModelList) !== slice.fingerprint) {
        visualizer.invalidatePlateSlice();
        notify('The plate changed after it was sliced, so this G-code no longer matches it. Press Slice Prints again.', 'warning');
        return;
    }
    saveGcodeToFile(slice.gcode, slice.fileName);
    notify('Print G-code saved.', 'success');
}
