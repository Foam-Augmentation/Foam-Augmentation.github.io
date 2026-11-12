// src/visualizer/gui/shortcuts.ts
/**
 * Keyboard shortcuts for the bed tools, as in PrusaSlicer:
 * - A: arrange the plate.
 * - F: lay the selected object on a face (then click the face).
 * - Ctrl+D (Cmd+D): duplicate the selected object.
 *
 * They are ignored while typing in a field, so they never get in the way of a value.
 */
import type Visualizer from '../Visualizer';
import type { EverydayModel } from '../types/modelTypes';
import { duplicateModel } from '../loaders/modelLoader';
import { arrangePlate } from './placement';

/** Whether a key press goes to something the user is typing in. */
function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.('input, select, textarea, [contenteditable="true"]'));
}

/**
 * Turns the shortcuts on. Call once.
 *
 * @param visualizer - The Visualizer instance.
 */
export function initShortcuts(visualizer: Visualizer): void {
  if (typeof document === 'undefined') return;
  document.addEventListener('keydown', event => {
    if (event.altKey || event.repeat || isTyping(event.target)) return;
    const selected = visualizer.selectedModel;
    const object = selected && 'kind' in selected ? selected as EverydayModel : null;
    const key = event.key.toLowerCase();

    if (event.ctrlKey || event.metaKey) {
      if (key === 'd' && !event.shiftKey && object) {
        event.preventDefault();
        duplicateModel(visualizer, object);
      }
      return;
    }
    if (event.shiftKey) return;
    if (key === 'a') {
      event.preventDefault();
      arrangePlate(visualizer);
    } else if (key === 'f' && object) {
      event.preventDefault();
      visualizer.armLayOnFace(object);
    }
  });
}
