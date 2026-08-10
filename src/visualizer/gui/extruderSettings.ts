// src/visualizer/gui/extruderSettings.ts
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import Visualizer from '../Visualizer';

/**
 * Creates the delete button shown in an extruder folder's title bar.
 * Clicking it removes that extruder and rebuilds the extruder folder list.
 *
 * @param visualizer - The Visualizer instance.
 * @param extrudersFolder - The parent folder holding every extruder folder.
 * @param index - The index of the extruder this button belongs to.
 * @returns The HTML span element acting as the delete button.
 */
function createExtruderDeleteBtn(
  visualizer: Visualizer,
  extrudersFolder: GUI,
  index: number
): HTMLSpanElement {
  const deleteBtn = document.createElement('span');
  deleteBtn.innerHTML = `<img src="./assets/icons/delete.svg" alt="delete" class="delete-icon" />`;
  deleteBtn.style.cursor = 'pointer';
  deleteBtn.style.marginLeft = '10px';
  deleteBtn.title = 'delete extruder';
  deleteBtn.addEventListener('click', (e: Event) => {
    // Stop the click from also toggling the folder open/closed.
    e.stopPropagation();
    if (visualizer.removeExtruder(index)) {
      refreshExtruderFolders(visualizer, extrudersFolder);
    }
  });
  return deleteBtn;
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
  // Tear down the existing folders/controllers (copy first, destroy() mutates children).
  [...extrudersFolder.children].forEach(child => child.destroy());

  visualizer.config.extruders.forEach((extruder, index) => {
    const extruderFolder = extrudersFolder.addFolder(`extruder ${index}`);
    extruderFolder.domElement.classList.add('extruder-item');

    // Only offer deletion while there is more than one extruder left.
    if (visualizer.config.extruders.length > 1) {
      const titleElem = extruderFolder.domElement.querySelector('.title');
      if (titleElem) {
        titleElem.appendChild(createExtruderDeleteBtn(visualizer, extrudersFolder, index));
      }
    }

    const sync = () => visualizer.syncExtrudersToPrinter();

    extruderFolder.add(extruder, 'nozzleDiameter', 0, 2, 0.01).name('Nozzle Diameter').onChange(sync);
    extruderFolder.add(extruder, 'nozzleLength', 0, 100, 0.01).name('Nozzle Length').onChange(sync);
    extruderFolder.add(extruder, 'dieSwelling', 0, 2, 0.01).name('Die Swelling').onChange(sync);
    extruderFolder.add(extruder, 'print_temp_extruder', 0, 300, 1).name('Nozzle Temp').onChange(sync);
    extruderFolder.add(extruder, 'idle_temp_extruder', 0, 300, 1).name('Idle Temp').onChange(sync);
    extruderFolder.add(extruder, 'printHead_speed_when_free_move', 0, 10000, 1)
      .name('Free Move Speed').onChange(sync);

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
 * @param printerFolder - The 'printer settings' GUI folder.
 * @returns The folder holding the per-extruder folders.
 */
export function addExtrudersFolder(visualizer: Visualizer, printerFolder: GUI): GUI {
  const extrudersFolder = printerFolder.addFolder('extruders');

  refreshExtruderFolders(visualizer, extrudersFolder);

  printerFolder.add({
    addExtruder: () => {
      visualizer.addExtruder();
      refreshExtruderFolders(visualizer, extrudersFolder);
      extrudersFolder.open();
    }
  }, 'addExtruder').name('Add Extruder');

  return extrudersFolder;
}
