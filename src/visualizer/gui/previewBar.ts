// src/visualizer/gui/previewBar.ts
/**
 * The preview bar over the canvas (`#previewBar` in index.html): what the toolpath preview's
 * colours show, a slider that builds the print up layer by layer in print order, and a legend.
 *
 * It works on one preview at a time: the selected augmentation's, if it has one, and otherwise
 * the plate slice's while it is up to date. It hides when there is neither.
 */
import type Visualizer from '../Visualizer';
import type { EverydayModel } from '../types/modelTypes';
import type { PathRole } from '../toolpath/pathTypes';
import {
  colorPreview,
  PREVIEW_COLOR_MODES,
  showPreviewSteps,
  type PreviewColorMode,
  type PreviewLegend,
  type ToolpathPreview,
} from '../toolpath/toolpathPreview';

/** What the helper steps are called on the slider. */
const ROLE_NAMES: Record<PathRole, string> = {
  purgeLine: 'Purge line',
  purgeTower: 'Purge tower',
  boundary: 'Boundary',
  approach: 'Moves between objects',
};

/** How many decimals each scale shows. */
const SCALE_DECIMALS: Record<PreviewColorMode, number> = { feature: 0, tool: 0, speed: 0, vStar: 2, hStar: 2, edot: 1 };

/** What the bar shows, kept across previews. */
const state = {
  mode: 'feature' as PreviewColorMode,
  travel: true,
  only: false,
  /** Legend entries the user switched off, per colour mode. */
  hidden: new Map<PreviewColorMode, Set<string>>(),
  /** The preview the bar works on, and the step it shows up to. */
  active: null as ToolpathPreview | null,
  /** Whether the active preview is the plate slice's (rather than an augmentation's). */
  activeIsPlate: false,
  step: 0,
  /** The objects whose meshes the bar hid, so they can be shown again. */
  hiddenMeshes: new Set<EverydayModel>(),
};

function hiddenFor(mode: PreviewColorMode): Set<string> {
  let set = state.hidden.get(mode);
  if (!set) {
    set = new Set();
    state.hidden.set(mode, set);
  }
  return set;
}

/** The preview the bar should work on, and what to call it. */
function findPreview(visualizer: Visualizer): { preview: ToolpathPreview, title: string, plate: boolean } | null {
  const selected = visualizer.selectedModel as EverydayModel | null;
  if (selected && 'kind' in selected && selected.kind === 'augment') {
    const group = selected.toolpathVisualizationObject;
    const preview = group?.userData.preview as ToolpathPreview | undefined;
    if (group?.parent && preview) return { preview, title: selected.name, plate: false };
  }
  const slice = visualizer.plateSlice;
  const group = slice && !slice.stale ? slice.previews[0] : undefined;
  const preview = group?.userData.preview as ToolpathPreview | undefined;
  if (group?.parent && preview) return { preview, title: 'Sliced plate', plate: true };
  return null;
}

/**
 * A sliced print's mesh is the finished part, and hides the layers inside it. While the slider
 * shows less than the whole plate, the meshes of the sliced prints are hidden; they come back at
 * the last step, and whenever the bar lets go of the plate preview. An augmentation's mesh stays:
 * it is the real object the foam goes onto.
 */
function updateMeshVisibility(visualizer: Visualizer): void {
  const preview = state.active;
  const partial = Boolean(preview && state.activeIsPlate && (state.only || state.step < preview.steps.length - 1));
  const slice = visualizer.plateSlice;
  const toHide = new Set<EverydayModel>(partial && slice
    ? visualizer.everydayModelList.filter(model => model.kind !== 'augment' && slice.summary.objects.has(model.objectId))
    : []);
  for (const model of state.hiddenMeshes) {
    if (!toHide.has(model)) model.mesh.visible = true;
  }
  for (const model of toHide) model.mesh.visible = false;
  state.hiddenMeshes = toHide;
}

/** Writes a value of a scale the way it is entered elsewhere in the app. */
function formatValue(mode: PreviewColorMode, value: number): string {
  return value.toFixed(SCALE_DECIMALS[mode]);
}

function swatch(color: number): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = 'preview-swatch';
  element.style.setProperty('--swatch', `#${color.toString(16).padStart(6, '0')}`);
  return element;
}

/** Draws the legend. Entries of the feature and tool modes switch their moves on and off. */
function renderLegend(visualizer: Visualizer, legend: PreviewLegend): void {
  const container = document.getElementById('previewLegend');
  if (!container) return;
  if (legend.kind === 'categories') {
    const hidden = hiddenFor(state.mode);
    container.replaceChildren(...legend.items.map(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preview-legend-item';
      const shown = !hidden.has(item.id);
      button.setAttribute('aria-pressed', String(shown));
      button.title = `${shown ? 'Hide' : 'Show'} ${item.label.toLowerCase()} in the preview`;
      const label = document.createElement('span');
      label.textContent = item.label;
      button.append(swatch(item.color), label);
      button.addEventListener('click', () => {
        if (hidden.has(item.id)) hidden.delete(item.id);
        else hidden.add(item.id);
        apply(visualizer);
      });
      return button;
    }));
    return;
  }

  const unit = legend.unit ? ` (${legend.unit})` : '';
  const title = document.createElement('span');
  title.className = 'preview-scale-title';
  title.textContent = `${legend.label}${unit}`;
  if (!Number.isFinite(legend.min)) {
    const none = document.createElement('span');
    none.className = 'preview-scale-none';
    none.textContent = 'No move in this preview has one.';
    container.replaceChildren(title, none);
    return;
  }
  const low = document.createElement('span');
  low.textContent = formatValue(state.mode, legend.min);
  const bar = document.createElement('span');
  bar.className = 'preview-gradient';
  const stops = legend.stops.map(c => `#${c.toString(16).padStart(6, '0')}`);
  bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
  const high = document.createElement('span');
  high.textContent = formatValue(state.mode, legend.max);
  const parts: HTMLElement[] = [title, low, bar, high];
  if (legend.notApplicableCount > 0) {
    const other = document.createElement('span');
    other.className = 'preview-legend-item static';
    const label = document.createElement('span');
    label.textContent = state.mode === 'speed' ? 'No speed' : 'Not foam';
    other.append(swatch(legend.notApplicable), label);
    parts.push(other);
  }
  container.replaceChildren(...parts);
}

/** Says which step the slider is on. */
function renderStepLabel(visualizer: Visualizer): void {
  const label = document.getElementById('previewStepLabel');
  const preview = state.active;
  if (!label || !preview) return;
  if (!preview.steps.length) {
    label.textContent = 'Nothing is extruded';
    return;
  }
  const step = preview.steps[state.step];
  let where: string;
  if (step.role !== undefined) {
    where = ROLE_NAMES[step.role];
  } else {
    const name = visualizer.everydayModelList.find(model => model.objectId === step.objectId)?.name ?? 'Object';
    where = step.layer !== undefined ? `${name}, layer ${step.layer + 1}` : name;
  }
  const z = step.zMax - step.zMin < 0.005
    ? `z ${step.zMin.toFixed(2)} mm`
    : `z ${step.zMin.toFixed(2)}–${step.zMax.toFixed(2)} mm`;
  label.textContent = `${state.step + 1} / ${preview.steps.length} · ${where} · ${z}`;
}

/** Applies the bar's settings to the active preview. */
function apply(visualizer: Visualizer): void {
  const preview = state.active;
  if (!preview) return;
  const legend = colorPreview(preview, state.mode, hiddenFor(state.mode));
  preview.travel.visible = state.travel;
  showPreviewSteps(preview, state.step, state.only);
  updateMeshVisibility(visualizer);
  renderLegend(visualizer, legend);
  renderStepLabel(visualizer);
}

/**
 * Brings the bar in line with the scene: shows it for the preview it should work on (starting
 * at the last step when that preview is new to it), or hides it. Call after previews, the
 * plate slice or the selection change.
 *
 * @param visualizer - The Visualizer instance.
 */
export function refreshPreviewBar(visualizer: Visualizer): void {
  if (typeof document === 'undefined') return;
  const bar = document.getElementById('previewBar');
  if (!bar) return;
  const found = findPreview(visualizer);
  bar.hidden = !found;
  if (!found) {
    state.active = null;
    updateMeshVisibility(visualizer);
    return;
  }
  const title = document.getElementById('previewTitle');
  if (title) title.textContent = found.title;
  if (found.preview !== state.active) {
    state.active = found.preview;
    state.activeIsPlate = found.plate;
    state.step = Math.max(0, found.preview.steps.length - 1);
    const slider = document.getElementById('previewStep') as HTMLInputElement | null;
    if (slider) {
      slider.max = String(state.step);
      slider.value = String(state.step);
      slider.disabled = found.preview.steps.length < 2;
    }
    apply(visualizer);
  } else {
    renderStepLabel(visualizer);
  }
}

/**
 * Builds the bar's controls and wires them up. Call once.
 *
 * @param visualizer - The Visualizer instance.
 */
export function initPreviewBar(visualizer: Visualizer): void {
  if (typeof document === 'undefined') return;
  const select = document.getElementById('previewColorMode') as HTMLSelectElement | null;
  if (select) {
    select.replaceChildren(...PREVIEW_COLOR_MODES.map(({ mode, label }) => {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = label;
      return option;
    }));
    select.value = state.mode;
    select.addEventListener('change', () => {
      state.mode = select.value as PreviewColorMode;
      apply(visualizer);
    });
  }
  const travel = document.getElementById('previewTravel') as HTMLInputElement | null;
  travel?.addEventListener('change', () => {
    state.travel = travel.checked;
    apply(visualizer);
  });
  const only = document.getElementById('previewOnlyLayer') as HTMLInputElement | null;
  only?.addEventListener('change', () => {
    state.only = only.checked;
    apply(visualizer);
  });
  const slider = document.getElementById('previewStep') as HTMLInputElement | null;
  slider?.addEventListener('input', () => {
    state.step = Number(slider.value);
    if (state.active) showPreviewSteps(state.active, state.step, state.only);
    updateMeshVisibility(visualizer);
    renderStepLabel(visualizer);
  });
  // The arrow keys move the slider; they must not reach the canvas shortcuts as well.
  slider?.addEventListener('keydown', event => event.stopPropagation());
  refreshPreviewBar(visualizer);
}
