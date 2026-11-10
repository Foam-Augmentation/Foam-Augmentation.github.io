import type Visualizer from '../Visualizer';
import type { PathPoint } from './pathTypes';
import { notify, withBusy } from '../gui/notify';
import { generateAugmentFoamToolpath, generateFoamToolpath } from './generateFoamToolpath';
import { buildPrintGcode, getPurgeTowerHeight } from './buildGcode';
import { saveGcodeToFile } from './saveGcodeToFile';
import { defaultDownloadName } from '../gui/downloadName';
import { TRAVEL_CLEARANCE } from './toolpathConstants';


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
        model => model.toolpathSamplePoints && model.toolpathSamplePoints.length > 0
    );
    if (!models.length) {
        notify('There is no toolpath to save yet. Press “Select Foam Area” on a model and drag over it first.', 'warning');
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
 * Handler for "Slice Plate": slices every model on the plate as a foam print, builds the G-code
 * and downloads it. The work runs behind a busy overlay because slicing blocks the page.
 *
 * Problems are reported to the user as toasts; the returned promise never rejects.
 *
 * @param {Visualizer} visualizer The visualizer holding the models and the printer.
 * @returns {Promise<void>} Resolves once the file has been handed to the browser (or nothing was saved).
 */
export function slicePlateAndSave(visualizer: Visualizer): Promise<void> {
    const models = visualizer.everydayModelList;
    if (!models.length) {
        notify('There is nothing to slice. Import a model first.', 'warning');
        return Promise.resolve();
    }

    return withBusy('Slicing plate…', () => {
        const toolpath = generateFoamToolpath(visualizer, models);
        if (!toolpath.length) {
            notify('Slicing produced nothing to print. Check that the models are on the bed and have some height.', 'warning');
            return;
        }

        const gcode = buildPrintGcode(visualizer.printer, [toolpath]);
        saveGcodeToFile(gcode, defaultDownloadName(models.length === 1 ? models[0].name : 'toolpath', 'gcode'));
        notify('Plate sliced and G-code saved.', 'success');
    }).catch(error => {
        // withBusy has already shown the message; keep the details for debugging.
        console.error(error);
    });
}
