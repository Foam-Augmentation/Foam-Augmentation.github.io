// src/visualizer/gui/guiHelpers.ts
/**
 * Small helpers shared by every part of the lil-gui panel, so labels, tooltips, ranges and
 * delete buttons are built the same way everywhere.
 */
import { GUI, Controller } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import tippy, { hideAll } from 'tippy.js';
import { ParamSpec } from './paramSpecs';

/** Attribute that holds an element's tooltip text. */
const TIP_ATTRIBUTE = 'data-tip';

/**
 * Turns on tooltips for every element under `root` that has a tooltip set with `setTip`,
 * including elements added later.
 *
 * A tippy instance is created the first time an element is hovered or focused, and is
 * referenced only by that element, so it is garbage-collected together with the element
 * when a folder is destroyed.
 *
 * @param root - The panel's root element.
 */
export function initTooltips(root: HTMLElement): void {
  const showTip = (event: Event): void => {
    const target = (event.target as Element | null)?.closest?.(`[${TIP_ATTRIBUTE}]`);
    if (!target || !root.contains(target) || (target as { _tippy?: unknown })._tippy) return;

    tippy(target, {
      content: reference => reference.getAttribute(TIP_ATTRIBUTE) ?? '',
      placement: 'right',
      delay: [350, 0],
      maxWidth: 280,
      // `focusin` (rather than `focus`) so focusing the input inside a control counts.
      trigger: 'mouseenter focusin',
      // The pointer or focus is already on the element, so show without waiting for the next event.
      showOnCreate: true,
    });
  };
  root.addEventListener('mouseover', showTip);
  root.addEventListener('focusin', showTip);
}

/**
 * Hides any tooltip that is showing. Call before destroying folders, so a tooltip whose
 * element disappears is not left on screen.
 */
export function hideTooltips(): void {
  hideAll({ duration: 0 });
}

/**
 * Sets the tooltip shown when the element is hovered or focused.
 *
 * @param element - The element to describe.
 * @param tip - The tooltip text.
 */
export function setTip(element: Element | null | undefined, tip: string): void {
  element?.setAttribute(TIP_ATTRIBUTE, tip);
}

/**
 * Returns a folder's own title element (not the title of a nested folder).
 *
 * @param folder - A lil-gui folder.
 * @returns The title element, or null if it cannot be found.
 */
export function folderTitleElement(folder: GUI): HTMLElement | null {
  return folder.domElement.querySelector<HTMLElement>(':scope > .title');
}

/**
 * Adds a folder with a tooltip on its title.
 *
 * @param parent - The folder to add to.
 * @param title - The folder title, in Title Case.
 * @param tip - One line saying what the folder is for.
 * @returns The new folder.
 */
export function addFolderWithTip(parent: GUI, title: string, tip: string): GUI {
  const folder = parent.addFolder(title);
  setTip(folderTitleElement(folder), tip);
  return folder;
}

/**
 * Adds a control for one parameter, taking its label, tooltip and valid range from its spec.
 *
 * @param folder - The folder to add the control to.
 * @param target - The object that holds the value.
 * @param key - The property of `target` to edit.
 * @param spec - The parameter's spec (see paramSpecs.ts).
 * @returns The lil-gui controller, for chaining `.onChange(...)`.
 */
export function addParam<T extends object>(
  folder: GUI,
  target: T,
  key: keyof T & string,
  spec: ParamSpec
): Controller {
  // lil-gui's overloads are keyed on the property's static type, which a spec-driven call
  // cannot satisfy, so go through one loosely-typed signature here.
  const add = folder.add.bind(folder) as unknown as (
    object: object,
    property: string,
    minOrOptions?: number | Record<string, string>,
    max?: number,
    step?: number
  ) => Controller;

  let controller: Controller;
  if (spec.type === 'number') {
    const [sliderMin, sliderMax] = spec.slider ?? [spec.min, spec.max];
    controller = add(target, key, sliderMin, sliderMax, spec.step);
    if (spec.slider) {
      // lil-gui clamps typed values to the slider's range. The slider only covers the everyday
      // range here, so replace the clamp with the spec's hard limits: values outside the
      // slider can still be typed into the number field. (`_clamp` is lil-gui's own hook for
      // this; it is called for typed, dragged and arrow-key input alike.)
      (controller as unknown as { _clamp: (value: number) => number })._clamp =
        value => Math.min(spec.max, Math.max(spec.min, value));
    }
  } else if (spec.type === 'enum') {
    const options: Record<string, string> = {};
    spec.options.forEach(value => { options[spec.optionLabels[value] ?? value] = value; });
    controller = add(target, key, options);
  } else if (spec.type === 'text') {
    controller = add(target, key);
  } else {
    controller = add(target, key);
  }

  controller.name(spec.label);
  setTip(controller.domElement, spec.tip);
  return controller;
}

/**
 * Adds a button with a tooltip.
 *
 * @param folder - The folder to add the button to.
 * @param label - The button text, in Title Case.
 * @param tip - What the button does.
 * @param onClick - Called when the button is pressed.
 * @returns The lil-gui controller.
 */
export function addButton(folder: GUI, label: string, tip: string, onClick: () => void): Controller {
  const controller = folder.add({ run: onClick }, 'run').name(label);
  setTip(controller.domElement, tip);
  // Callers only need the generic controller interface.
  return controller as unknown as Controller;
}

/**
 * Creates a delete button for a folder's title bar.
 *
 * It is a real `<button>`, so it can be reached with Tab and pressed with Enter or Space,
 * and it carries an accessible name.
 *
 * @param label - What the button deletes, e.g. `Delete model "cup.stl"`. Used as the
 *                accessible name and the hover text.
 * @param onDelete - Called when the button is pressed. Ask for confirmation in here.
 * @returns The button element.
 */
export function createDeleteButton(label: string, onDelete: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'delete-btn';
  button.title = label;
  button.setAttribute('aria-label', label);

  const icon = document.createElement('img');
  icon.src = './assets/icons/delete.svg';
  icon.alt = '';
  icon.className = 'delete-icon';
  button.appendChild(icon);

  button.addEventListener('click', (event: Event) => {
    // Keep the click from also opening or closing the folder.
    event.stopPropagation();
    onDelete();
  });
  // The folder title treats Enter/Space as "toggle folder" and cancels the key press;
  // stop it from seeing key presses meant for this button.
  button.addEventListener('keydown', (event: Event) => event.stopPropagation());
  return button;
}
