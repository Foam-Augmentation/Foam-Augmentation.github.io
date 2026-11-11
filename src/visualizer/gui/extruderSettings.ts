// src/visualizer/gui/extruderSettings.ts
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import Visualizer from '../Visualizer';
import { addButton, addFolderWithTip, addParam, createDeleteButton, folderTitleElement, hideTooltips } from './guiHelpers';
import { EXTRUDER_SPECS, ExtruderKey } from './paramSpecs';
import { notify } from './notify';

/** Extruder fields shown in the panel, in display order. */
const EXTRUDER_CONTROL_KEYS: ExtruderKey[] = [
  'nozzleDiameter',
  'nozzleLength',
  'dieSwelling',
  'print_temp_extruder',
  'idle_temp_extruder',
  'printHead_speed_when_free_move',
  'filamentDensity',
];

/**
 * Creates the delete button shown in an extruder folder's title bar.
 * Pressing it asks for confirmation, removes that extruder and rebuilds the extruder folders.
 *
 * @param visualizer - The Visualizer instance.
 * @param extrudersFolder - The parent folder holding every extruder folder.
 * @param index - The index of the extruder this button belongs to.
 * @returns The delete button element.
 */
function createExtruderDeleteBtn(
  visualizer: Visualizer,
  extrudersFolder: GUI,
  index: number
): HTMLButtonElement {
  return createDeleteButton(`Delete extruder ${index}`, () => {
    const confirmed = window.confirm(
      `Delete extruder ${index}?\n\nThe extruders after it move down by one number. This cannot be undone.`
    );
    if (!confirmed) return;
    if (visualizer.removeExtruder(index)) {
      refreshExtruderFolders(visualizer, extrudersFolder);
      notify(`Deleted extruder ${index}.`, 'info');
    }
  });
}

/**
 * Rebuilds the per-extruder GUI folders from visualizer.config.extruders.
 *
 * Every controller writes straight into the config extruder object and then pushes the
 * whole extruder list onto the printer, so the printer and the GUI never drift apart.
 * The folders are fully torn down and recreated because lil-gui controllers are bound to
 * a fixed object reference, which no longer holds once an extruder is added or removed.
 *
 * @param visualizer - The Visualizer instance.
 * @param extrudersFolder - The folder that contains one sub-folder per extruder.
 */
export function refreshExtruderFolders(visualizer: Visualizer, extrudersFolder: GUI): void {
  hideTooltips();

  // Tear down the existing folders/controllers (copy first, destroy() mutates children).
  [...extrudersFolder.children].forEach(child => child.destroy());

  visualizer.config.extruders.forEach((extruder, index) => {
    const extruderFolder = extrudersFolder.addFolder(`Extruder ${index}`);
    extruderFolder.domElement.classList.add('extruder-item');

    // Only offer deletion while there is more than one extruder left.
    if (visualizer.config.extruders.length > 1) {
      const titleElem = folderTitleElement(extruderFolder);
      if (titleElem) {
        titleElem.appendChild(createExtruderDeleteBtn(visualizer, extrudersFolder, index));
      }
    }

    const sync = () => visualizer.syncExtrudersToPrinter();

    EXTRUDER_CONTROL_KEYS.forEach(key => {
      addParam(extruderFolder, extruder, key, EXTRUDER_SPECS[key]).onChange(sync);
    });

    extruderFolder.close();
  });

  // Keep the printer in step with whatever the rebuild ended up with.
  visualizer.syncExtrudersToPrinter();
}

/**
 * Adds the extruders section to the printer settings folder.
 * This contains one folder per extruder plus the button used to add another one.
 *
 * @param visualizer - The Visualizer instance.
 * @param printerFolder - The 'Printer Settings' GUI folder.
 * @returns The folder holding the per-extruder folders.
 */
export function addExtrudersFolder(visualizer: Visualizer, printerFolder: GUI): GUI {
  const extrudersFolder = addFolderWithTip(
    printerFolder,
    'Extruders',
    'Nozzle, temperature and speed settings of each extruder (tool).'
  );

  refreshExtruderFolders(visualizer, extrudersFolder);

  addButton(printerFolder, 'Add Extruder', 'Add another extruder, starting as a copy of the last one.', () => {
    visualizer.addExtruder();
    refreshExtruderFolders(visualizer, extrudersFolder);
    extrudersFolder.open();
  });

  return extrudersFolder;
}
