import { TransformControls } from 'three/examples/jsm/controls/TransformControls';

/**
 * If the TransformControls object is active, display a message to press the escape key to quit.
 *
 * @param {TransformControls} transformControls - The TransformControls instance used to determine the current state.
 */
export function updateEscDiv(transformControls: TransformControls): void {
  const escDiv = document.getElementById('escDiv');
  if (!escDiv) {
    console.warn("escDiv element not found.");
    return;
  }
  if (transformControls.object) {
    escDiv.style.display = 'block';
    escDiv.textContent = "press esc to quit";
  } else {
    escDiv.style.display = 'none';
  }
}
