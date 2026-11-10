// src/visualizer/gui/emptyState.ts
/**
 * What the app shows and accepts before any model is loaded:
 * - the "getting started" card on the canvas (`#emptyState` in index.html), with buttons to
 *   import an STL or load the built-in example;
 * - STL files dropped anywhere on the window (this keeps working after the card is gone).
 */
import type Visualizer from '../Visualizer';
import { importDroppedFiles, importSTLModel, loadExampleModel } from '../loaders/modelLoader';

/** Class put on `<body>` while files are dragged over the window. */
const DRAG_OVER_CLASS = 'file-drag-over';

/**
 * Tells whether a drag carries files (as opposed to text or a dragged page element).
 *
 * @param event - The drag event.
 * @returns True if files are being dragged.
 */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Wires up the getting-started card's buttons and file drop on the window.
 *
 * @param visualizer - The Visualizer instance.
 */
export function initEmptyState(visualizer: Visualizer): void {
  if (typeof document === 'undefined') return;

  document.getElementById('emptyStateImport')
    ?.addEventListener('click', () => importSTLModel(visualizer, 'everyday', 'augment'));
  document.getElementById('emptyStateExample')
    ?.addEventListener('click', () => loadExampleModel(visualizer));

  // `dragenter`/`dragleave` fire for every element the pointer crosses, so count them to know
  // when the drag has really left the window.
  let dragDepth = 0;
  const endDrag = (): void => {
    dragDepth = 0;
    document.body.classList.remove(DRAG_OVER_CLASS);
  };

  window.addEventListener('dragenter', (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    dragDepth++;
    document.body.classList.add(DRAG_OVER_CLASS);
  });
  window.addEventListener('dragleave', (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) endDrag();
  });
  window.addEventListener('dragover', (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    // Without this the browser opens the file instead of handing it to the page.
    event.preventDefault();
  });
  window.addEventListener('drop', (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    endDrag();
    importDroppedFiles(visualizer, Array.from(event.dataTransfer?.files ?? []));
  });
}

/**
 * Shows or hides the getting-started card.
 *
 * @param visible - True while no model is loaded.
 */
export function setEmptyStateVisible(visible: boolean): void {
  if (typeof document === 'undefined') return;
  const card = document.getElementById('emptyState');
  if (card) card.style.display = visible ? 'block' : 'none';
}
