// src/visualizer/gui/objectList.ts
/**
 * The Objects panel on the right of the window (`#objectPanel` in index.html).
 *
 * It lists every object on the plate with what it is (an augmentation, a foam print or a
 * regular print), lets the user add objects of each kind, and holds the two export actions.
 * Clicking a row selects that object: it glows in the 3D view and the settings panel on the
 * left shows its settings (see `Visualizer.selectModel`).
 */
import type Visualizer from '../Visualizer';
import { EverydayModel, ObjectKind } from '../types/modelTypes';
import { importSTLModel } from '../loaders/modelLoader';
import { saveAugmentGcode, slicePlateAndSave } from '../toolpath/gcodeActions';
import { KIND_INFO } from './modelActions';
import { countObjects, objectStatus } from './objectSummary';
import { confirmAndDeleteModel } from './refreshModelGUIList';

/** The kinds, in the order they are offered in the Add menu. */
const KINDS: ObjectKind[] = ['augment', 'foam', 'regular'];

/**
 * Builds the row of one object: a button that selects it (kind colour, name, status and kind
 * badge) and a delete button.
 *
 * @param visualizer - The Visualizer instance.
 * @param model - The object the row is for.
 * @returns The list item.
 */
function buildRow(visualizer: Visualizer, model: EverydayModel): HTMLLIElement {
  const info = KIND_INFO[model.kind];
  const selected = visualizer.selectedModel === model;

  const row = document.createElement('li');
  row.className = `object-row${selected ? ' selected' : ''}`;
  row.style.setProperty('--kind-color', info.cssColor);

  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'object-select';
  select.setAttribute('aria-pressed', String(selected));
  select.title = `${info.label}: ${info.description}`;
  select.addEventListener('click', () => visualizer.selectModel(model));

  const swatch = document.createElement('span');
  swatch.className = 'object-swatch';

  const text = document.createElement('span');
  text.className = 'object-text';
  const name = document.createElement('span');
  name.className = 'object-name';
  name.textContent = model.name;
  const status = document.createElement('span');
  status.className = 'object-status';
  status.textContent = objectStatus(model);
  text.append(name, status);

  const badge = document.createElement('span');
  badge.className = 'object-badge';
  badge.textContent = info.label;

  select.append(swatch, text, badge);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'object-delete';
  remove.title = `Delete “${model.name}”`;
  remove.setAttribute('aria-label', remove.title);
  remove.textContent = '×';
  remove.addEventListener('click', () => confirmAndDeleteModel(visualizer, model));

  row.append(select, remove);
  return row;
}

/**
 * Sets an export button's enabled state and the line under its label.
 *
 * @param id - The button's element id.
 * @param enabled - Whether the button can do something right now.
 * @param note - What it will export, or what is missing.
 */
function setExportButton(id: string, enabled: boolean, note: string): void {
  const button = document.getElementById(id) as HTMLButtonElement | null;
  if (!button) return;
  button.disabled = !enabled;
  const noteElement = button.querySelector('.export-note');
  if (noteElement) noteElement.textContent = note;
}

/**
 * Redraws the object list and the export buttons from the Visualizer's current state.
 *
 * @param visualizer - The Visualizer instance.
 */
export function renderObjectList(visualizer: Visualizer): void {
  if (typeof document === 'undefined') return;
  const list = document.getElementById('objectList');
  if (!list) return;

  const models = visualizer.everydayModelList;
  list.replaceChildren(...models.map(model => buildRow(visualizer, model)));

  const empty = document.getElementById('objectListEmpty');
  if (empty) empty.style.display = models.length === 0 ? 'block' : 'none';

  const counts = countObjects(models);
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

  setExportButton(
    'exportAugmentButton',
    counts.augmentReady > 0,
    counts.augment === 0
      ? 'No augmentation objects'
      : counts.augmentReady === 0
        ? 'Select a foam area first'
        : `${counts.augmentReady} of ${plural(counts.augment, 'augmentation')} ready`
  );

  const prints = [
    counts.foam > 0 ? plural(counts.foam, 'foam print') : '',
    counts.regular > 0 ? plural(counts.regular, 'regular print') : '',
  ].filter(Boolean);
  setExportButton(
    'exportPrintButton',
    prints.length > 0,
    prints.length > 0 ? prints.join(', ') : 'No foam or regular prints'
  );
}

/**
 * Builds the Add menu and wires up the panel's buttons. Call once.
 *
 * @param visualizer - The Visualizer instance.
 */
export function initObjectList(visualizer: Visualizer): void {
  if (typeof document === 'undefined') return;

  const addButton = document.getElementById('addObjectButton');
  const menu = document.getElementById('addObjectMenu');
  if (addButton && menu) {
    const setMenuOpen = (open: boolean): void => {
      menu.hidden = !open;
      addButton.setAttribute('aria-expanded', String(open));
    };

    KINDS.forEach(kind => {
      const info = KIND_INFO[kind];
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'add-object-item';
      item.style.setProperty('--kind-color', info.cssColor);

      const swatch = document.createElement('span');
      swatch.className = 'object-swatch';
      const text = document.createElement('span');
      text.className = 'object-text';
      const label = document.createElement('span');
      label.className = 'object-name';
      label.textContent = info.label;
      const description = document.createElement('span');
      description.className = 'object-status';
      description.textContent = info.description;
      text.append(label, description);
      item.append(swatch, text);

      item.addEventListener('click', () => {
        setMenuOpen(false);
        importSTLModel(visualizer, 'everyday', kind);
      });
      menu.appendChild(item);
    });

    addButton.addEventListener('click', event => {
      event.stopPropagation();
      setMenuOpen(menu.hidden);
    });
    // A click anywhere else, or Esc, closes the menu.
    document.addEventListener('click', event => {
      if (!menu.hidden && !menu.contains(event.target as Node)) setMenuOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') setMenuOpen(false);
    });
  }

  document.getElementById('exportAugmentButton')
    ?.addEventListener('click', () => { void saveAugmentGcode(visualizer); });
  document.getElementById('exportPrintButton')
    ?.addEventListener('click', () => { void slicePlateAndSave(visualizer); });

  renderObjectList(visualizer);
}
