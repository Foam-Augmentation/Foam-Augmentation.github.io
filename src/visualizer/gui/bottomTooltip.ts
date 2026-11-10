// src/visualizer/gui/bottomTooltip.ts
/**
 * On-canvas mode indicators:
 * - `#selectionHint` (top of the canvas) explains how to draw a selection while area
 *   selection is armed;
 * - `#escDiv` (bottom bar) says exactly what pressing Esc will do right now.
 */

/** What the user is currently in the middle of. */
export interface ModeHintState {
  /** Name of the model attached to the move gizmo, or null. */
  gizmoModelName: string | null;
  /** The armed area selection, or null when no selection is armed. */
  selection: { modelName: string; kind: 'foam' | 'sense' } | null;
}

/**
 * Builds the text of the Esc bar for the given state.
 *
 * @param state - What is currently active.
 * @returns The text to show, or null when Esc would do nothing.
 */
export function escBarText(state: ModeHintState): string | null {
  const { gizmoModelName, selection } = state;
  if (gizmoModelName && selection) {
    return `Press Esc to release “${gizmoModelName}” from the move gizmo and stop selecting`;
  }
  if (gizmoModelName) {
    return `“${gizmoModelName}” is attached to the move gizmo. Press Esc to release it`;
  }
  if (selection) {
    return `Selecting on “${selection.modelName}”. Press Esc to stop selecting`;
  }
  return null;
}

/**
 * Builds the on-canvas instructions for an armed area selection.
 *
 * @param selection - The armed selection.
 * @returns The instruction text.
 */
export function selectionHintText(selection: NonNullable<ModeHintState['selection']>): string {
  const area = selection.kind === 'foam' ? 'foam area' : 'sensing area';
  return `Selecting the ${area} of “${selection.modelName}”: drag over the model to mark it. ` +
    `Right-drag rotates the view; areas are best drawn looking straight down.`;
}

/**
 * Shows or hides the selection hint and the Esc bar to match the given state.
 *
 * @param state - What is currently active.
 * @param onTopView - Called when the hint's "Top View" button is pressed.
 */
export function updateModeHints(state: ModeHintState, onTopView: () => void): void {
  if (typeof document === 'undefined') return;

  const escDiv = document.getElementById('escDiv');
  if (escDiv) {
    const text = escBarText(state);
    escDiv.textContent = text ?? '';
    escDiv.style.display = text ? 'block' : 'none';
  }

  const hint = document.getElementById('selectionHint');
  if (hint) {
    if (!state.selection) {
      hint.style.display = 'none';
      return;
    }

    // Build the hint's contents once: a text span and a shortcut button to the top view.
    let textSpan = hint.querySelector<HTMLSpanElement>('.selection-hint-text');
    if (!textSpan) {
      hint.textContent = '';
      textSpan = document.createElement('span');
      textSpan.className = 'selection-hint-text';
      hint.appendChild(textSpan);

      const topViewButton = document.createElement('button');
      topViewButton.type = 'button';
      topViewButton.className = 'selection-hint-button';
      topViewButton.textContent = 'Back to Top View';
      topViewButton.addEventListener('click', onTopView);
      hint.appendChild(topViewButton);
    }
    textSpan.textContent = selectionHintText(state.selection);
    hint.style.display = 'flex';
  }
}
