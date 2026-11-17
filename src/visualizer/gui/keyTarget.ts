// src/visualizer/gui/keyTarget.ts
/**
 * What a key press is aimed at: a control of the page, or the 3D view. Shortcuts and Esc ask
 * before they act, so a key meant for a control does not also change the plate.
 *
 * No DOM types are used at load time, so this can be unit-tested under Node.
 */

/** Controls a key press can be meant for. */
const CONTROLS = 'input, select, textarea, [contenteditable="true"]';

/** Kinds of `<input>` that are clicked, not typed into. */
const CLICKED_INPUT_TYPES: ReadonlySet<string> = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image',
]);

/**
 * Whether a key press goes to a control of the page (a field, a checkbox, a dropdown): letters
 * and digits typed there are not shortcuts.
 *
 * @param target - The event's target.
 * @returns True if the target is, or is inside, such a control.
 */
export function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.(CONTROLS));
}

/**
 * Whether a key press goes to a control that has something of its own to do with Esc: a field
 * text is typed into (Esc leaves it), or a dropdown (Esc closes its list; whether the list is
 * open cannot be told). A checkbox or a slider that merely kept the focus after a click is not one.
 *
 * @param target - The event's target.
 * @returns True if Esc belongs to the control.
 */
export function takesEscape(target: EventTarget | null): boolean {
  const control = (target as HTMLElement | null)?.closest?.(CONTROLS) as HTMLElement | null | undefined;
  if (!control) return false;
  if (control.tagName !== 'INPUT') return true;
  return !CLICKED_INPUT_TYPES.has((control as HTMLInputElement).type);
}
