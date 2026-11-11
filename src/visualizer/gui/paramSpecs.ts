// src/visualizer/gui/paramSpecs.ts
/**
 * One description per user-editable parameter: display label (Title Case, unit in the label),
 * tooltip text, and the valid range.
 *
 * This is the single source of truth shared by the GUI (labels, tooltips, slider ranges) and
 * the preset importer (validation), so the two cannot drift apart. The keys are the config
 * keys and must not be renamed, otherwise existing preset files stop importing.
 *
 * Keep this file free of DOM and three.js imports so it can be unit-tested under Node.
 */
import { INFILL_PATTERNS, SUPPORT_MODES, SUPPORT_STYLES } from '../toolpath/regularPrintOptions';

/** Ends the tooltip of every regular-print setting that only PrusaSlicer uses. */
const PRUSA_ONLY_TIP = 'Only used when the desktop app slices with PrusaSlicer.';

/** A numeric parameter with an inclusive valid range. */
export interface NumberSpec {
  type: 'number';
  /** Display name, in Title Case, with the unit in brackets. */
  label: string;
  /** One or two sentences shown as a tooltip. */
  tip: string;
  min: number;
  max: number;
  step: number;
  /** True when only whole numbers are valid. */
  integer?: boolean;
  /**
   * The range the slider covers, when it should be narrower than `min`..`max`. `min` and
   * `max` are the hard limits (what may be typed in, and what a preset may hold); a slider
   * stretched over them would put every everyday value in its first few pixels.
   */
  slider?: readonly [number, number];
}

/** An on/off parameter. */
export interface BooleanSpec {
  type: 'boolean';
  label: string;
  tip: string;
}

/** A parameter that takes one of a fixed list of string values. */
export interface EnumSpec {
  type: 'enum';
  label: string;
  tip: string;
  /** The stored values, in display order. */
  options: readonly string[];
  /** Display name for each stored value. */
  optionLabels: Readonly<Record<string, string>>;
}

export type ParamSpec = NumberSpec | BooleanSpec | EnumSpec;

/** Shorthand for a numeric spec. */
function num(
  label: string,
  min: number,
  max: number,
  step: number,
  tip: string,
  integer = false,
  slider?: readonly [number, number]
): NumberSpec {
  return slider ? { type: 'number', label, tip, min, max, step, integer, slider } : { type: 'number', label, tip, min, max, step, integer };
}

/** Shorthand for a boolean spec. */
function bool(label: string, tip: string): BooleanSpec {
  return { type: 'boolean', label, tip };
}

/**
 * Global settings stored on `Visualizer.config`: selection, printer and slicer settings.
 */
export const SETTING_SPECS = {
  // ----- selection -----
  toolMode: {
    type: 'enum',
    label: 'Selection Tool',
    tip: 'Shape drawn when dragging over a model to select an area: a free-form lasso or a rectangle.',
    options: ['lasso', 'box'],
    optionLabels: { lasso: 'Lasso (Free Draw)', box: 'Box (Rectangle)' },
  } as EnumSpec,
  selectionMode: {
    type: 'enum',
    label: 'Selection Mode',
    tip: 'Which triangles a selection picks up: only the ones facing the camera, every triangle whose centre is inside the shape, or every triangle the shape touches.',
    options: ['centroid-visible', 'intersection', 'centroid'],
    optionLabels: {
      'centroid-visible': 'Visible Faces Only',
      intersection: 'All Faces Touched',
      centroid: 'All Faces Inside',
    },
  } as EnumSpec,
  selectModel: bool('Select Whole Model', 'Select the whole model instead of only the part inside the drawn shape.'),
  liveUpdate: bool('Live Update', 'Update the selection and toolpath while dragging instead of when the mouse button is released. Slow on large models.'),
  selectWireframe: bool('Show Selection Wireframe', 'Show the selected area as a wireframe.'),

  // ----- printer -----
  bedTemp: num('Bed Temperature (°C)', 0, 110, 1, 'Heated bed temperature.'),
  machineDepth: num('Bed Width X (mm)', 1, 1000, 1, 'Size of the print space along X.', false, [100, 500]),
  machineDepthY: num('Bed Depth Y (mm)', 1, 1000, 1, 'Size of the print space along Y.', false, [100, 500]),
  machineHeight: num('Build Height Z (mm)', 1, 2000, 1, 'Height of the print space.', false, [100, 500]),
  filamentDiameter: num('Filament Diameter (mm)', 0.1, 5, 0.01, 'Diameter of the filament being used.', false, [1, 3]),
  printHeadMinX: num('Print Head Min X (mm)', -100, 0, 0.01, 'Left edge of the print head, measured from the nozzle at (0, 0). Used for collision detection.'),
  printHeadMinY: num('Print Head Min Y (mm)', -100, 0, 0.01, 'Front edge of the print head, measured from the nozzle at (0, 0). Used for collision detection.'),
  printHeadMaxX: num('Print Head Max X (mm)', 0, 100, 0.01, 'Right edge of the print head, measured from the nozzle at (0, 0). Used for collision detection.'),
  printHeadMaxY: num('Print Head Max Y (mm)', 0, 100, 0.01, 'Back edge of the print head, measured from the nozzle at (0, 0). Used for collision detection.'),
  multipleToolheads: bool('Multiple Toolheads', 'Checked: the printer is a tool changer and each extruder is its own tool. Unchecked: one tool head, so a change of extruder becomes a filament change.'),
  purgeTower: bool('Purge Tower', 'Print a purge tower when the tool changes.'),

  // ----- slicer -----
  useFermatSpirals: bool('Fermat Spiral Infill', 'Fill each layer with Fermat spirals. Unchecked: straight back-and-forth (rectilinear) lines.'),
  generateBoundary: bool('Print Boundary', 'Print a boundary around the model. When augmenting, the print also pauses after the boundary so the object can be placed inside it.'),
  purgeLine: bool('Purge Line', 'Print a purge line before the model.'),
  checkCollisions: bool('Check Collisions', 'When augmenting, check whether the print head would hit the object and suggest an H* that avoids it. Makes slicing slower.'),
  bedLeveling: bool('Bed Leveling', 'Probe the bed for automatic leveling before printing.'),
  testSweep: bool('Test Sweep (Dry Run)', 'Follow the toolpath without heating or extruding, to check that the print head clears the object.'),

  // ----- test pattern (preset files only; no control in the panel) -----
  startHStarTest: num('Test Start H*', 0, 200, 0.01, 'First H* of the test pattern.'),
  endHStarTest: num('Test End H*', 0, 200, 0.01, 'Last H* of the test pattern.'),
  startVStarTest: num('Test Start V*', 0, 10, 0.01, 'First V* of the test pattern.'),
  endVStarTest: num('Test End V*', 0, 10, 0.01, 'Last V* of the test pattern.'),
  testDeltaL: num('Test Line Spacing (mm)', 0, 40, 0.01, 'Line spacing of the test pattern.'),
  testSize: num('Test Size (mm)', 0, 100, 0.01, 'Edge length of the test pattern.'),
} as const;

/** Per-extruder parameters (fields of `Extruder` in Printer.ts). */
export const EXTRUDER_SPECS = {
  nozzleDiameter: num('Nozzle Diameter (mm)', 0.05, 2, 0.01, 'Diameter of this extruder\'s nozzle.', false, [0.1, 1.2]),
  nozzleLength: num('Nozzle Length (mm)', 0, 100, 0.01, 'Length of the nozzle from its tip to the base of the print head.', false, [0, 20]),
  dieSwelling: num('Die Swell Factor', 0.1, 2, 0.01, 'How much the thread widens as it leaves the nozzle (thread diameter ÷ nozzle diameter).', false, [0.5, 2]),
  print_temp_extruder: num('Print Temperature (°C)', 0, 300, 1, 'Nozzle temperature while this extruder is printing.', false, [150, 300]),
  idle_temp_extruder: num('Idle Temperature (°C)', 0, 300, 1, 'Standby temperature while this extruder is parked.'),
  filamentDensity: num('Filament Density (g/cm³)', 0.5, 3, 0.01, 'Density of the filament in this extruder, for the filament weight in the slice summary. TPU is about 1.21, PLA 1.24, PETG 1.27.', false, [0.8, 2]),
  printHead_speed_when_free_move: num('Travel Speed (mm/min)', 1, 10000, 1, 'Print head speed for moves that do not extrude.', false, [100, 6000]),
  color: num('Color', 0, 0xffffff, 1, 'Display colour of this extruder\'s toolpath (RGB as a number).', true),
} as const;

const TIP_DELTA_Z = 'How far apart each layer is from the next.';
const TIP_DELTA_L = 'How far apart neighbouring infill lines are.';
const TIP_DELTA_L_END = 'Line spacing at the top layer. The spacing changes evenly from Line Spacing at the bottom layer to this value at the top.';
const TIP_V_STAR = 'Print head speed ÷ the speed the thread leaves the nozzle. Below 1 the thread coils into foam; at 1 and above it is laid down straight or stretched.';
const TIP_V_STAR_END = 'With a gradient, V* moves toward this value in the darker parts of the gradient SVG and stays near V* in the lighter parts.';
const TIP_H_STAR = 'Nozzle height above the surface ÷ thread diameter.';
const TIP_H_STAR_END = 'With a gradient, H* moves toward this value in the darker parts of the gradient SVG and stays near H* in the lighter parts.';
const TIP_EDOT = 'Filament feed rate. Raising it speeds up both extrusion and print head movement, because V* keeps them in ratio.';

/**
 * Per-model toolpath parameters (keys of `ToolpathConfig`).
 * The `sense…` keys repeat the foam parameters for areas selected as sensing areas.
 */
export const MODEL_SPECS = {
  deltaZ: num('Layer Thickness ΔZ (mm)', 0.05, 20, 0.01, TIP_DELTA_Z, false, [0.2, 3]),
  deltaL: num('Line Spacing ΔL (mm)', 0.2, 100, 0.01, TIP_DELTA_L, false, [0.5, 5]),
  deltaLEnd: num('Top Line Spacing ΔL (mm)', 0.01, 10, 0.01, TIP_DELTA_L_END, false, [0.5, 5]),
  gridSize: num('Sampling Grid Size (mm)', 0.2, 100, 0.01, 'How far apart the surface is sampled. Smaller is more accurate but slower.', false, [0.2, 5]),
  vStar: num('Speed Ratio V*', 0.01, 5, 0.01, TIP_V_STAR, false, [0.01, 1]),
  vStarEnd: num('Gradient End V*', 0.01, 5, 0.01, TIP_V_STAR_END, false, [0.01, 1]),
  hStar: num('Height Ratio H*', 0.01, 100, 0.01, TIP_H_STAR, false, [1, 20]),
  hStarEnd: num('Gradient End H*', 0.01, 100, 0.01, TIP_H_STAR_END, false, [1, 20]),
  edot: num('Extrusion Rate Edot (mm/min)', 0.01, 1000, 0.01, TIP_EDOT, false, [1, 300]),

  senseDeltaZ: num('Layer Thickness ΔZ (mm)', 0.05, 20, 0.01, TIP_DELTA_Z, false, [0.2, 3]),
  senseDeltaL: num('Line Spacing ΔL (mm)', 0.2, 100, 0.01, TIP_DELTA_L, false, [0.5, 5]),
  senseDeltaLEnd: num('Top Line Spacing ΔL (mm)', 0.01, 10, 0.01, TIP_DELTA_L_END, false, [0.5, 5]),
  senseVStar: num('Speed Ratio V*', 0.01, 5, 0.01, TIP_V_STAR, false, [0.01, 1]),
  SenseVStarEnd: num('Gradient End V*', 0.01, 5, 0.01, TIP_V_STAR_END, false, [0.01, 1]),
  senseHStar: num('Height Ratio H*', 0.01, 100, 0.01, TIP_H_STAR, false, [1, 20]),
  senseHStarEnd: num('Gradient End H*', 0.01, 100, 0.01, TIP_H_STAR_END, false, [1, 20]),
  senseEdot: num('Extrusion Rate Edot (mm/min)', 0.01, 1000, 0.01, TIP_EDOT, false, [1, 300]),

  initialFoamLayerCount: num('Foam Layers', 0, 20, 1, 'How many layers an augmentation gets. The total is Foam Layers + Initial Foam Layers.', true),
  middleSenseLayerCount: num('Middle Sensing Layers', 0, 10, 1, 'How many sensing layers sit between the foam layers.', true),
  finalFoamLayerCount: num('Final Foam Layers', 0, 10, 1, 'How many foam layers are printed on top of the sensing layers.', true),

  curveAugment: bool('Curved Augmentation', 'Curve the augmentation into the shape of the selected augment model. With no augment model selected, the top is flattened instead.'),
  steepnessThreshold: num('Max Surface Angle (°)', 0, 90, 0.01, 'Steepest surface that still gets augmented. Lower values keep the augmentation on flatter areas, where the nozzle can print closer to the model.'),
  flatLayerZOffset: num('Flat Layer Z Offset (mm)', 0, 100, 0.01, 'How far above the model the flat top layer sits. Only used when Curved Augmentation is on and no augment model is selected.', false, [0, 20]),
  additionalCurveLayers: num('Additional Curve Layers', 0, 100, 1, 'Extra layers printed after the path has reached the target shape. For example, 3 prints three more flat layers after a surface has been flattened.', true, [0, 10]),

  generateBumps: bool('Generate Bumps', 'Add bumps across the surface of the augmentation to improve grip.'),
  bumpSpacingX: num('Bump Spacing X (mm)', 0.1, 100, 0.01, 'Distance between bump centres along X.', false, [1, 50]),
  bumpSpacingY: num('Bump Spacing Y (mm)', 0.1, 100, 0.01, 'Distance between bump centres along Y.', false, [1, 50]),
  bumpScale: num('Bump Scale', 0.01, 100, 0.01, 'Scale applied to the bump model.', false, [0.1, 5]),
} as const;

/**
 * Parameters of a model's initial-layer config (`EverydayModel.initialConfig`).
 * Only the keys the toolpath generator reads for the initial layers are listed.
 */
export const INITIAL_SPECS = {
  deltaZ: MODEL_SPECS.deltaZ,
  deltaL: MODEL_SPECS.deltaL,
  deltaLEnd: MODEL_SPECS.deltaLEnd,
  gridSize: MODEL_SPECS.gridSize,
  vStar: MODEL_SPECS.vStar,
  vStarEnd: MODEL_SPECS.vStarEnd,
  hStar: MODEL_SPECS.hStar,
  hStarEnd: MODEL_SPECS.hStarEnd,
  edot: MODEL_SPECS.edot,
  initialFoamLayerCount: num('Initial Foam Layers', 0, 20, 1, 'How many layers are printed with the initial-layer parameters before switching to the foam parameters.', true),
} as const;

/** `EverydayModel.initialOffset`. */
export const INITIAL_OFFSET_SPEC = num('Outward Offset (mm)', 0, 50, 0.01, 'How far the initial layers are grown outwards, for example to build a scaffold around the object when augmenting.', false, [0, 10]);

/** `EverydayModel.kind`: what an object on the plate is. */
export const KIND_SPEC: EnumSpec = {
  type: 'enum',
  label: 'Type',
  tip: 'Augmentation: an existing object on the bed; foam is printed onto the area you select on it. ' +
    'Foam Print: the whole model is printed as foam. Regular Print: the model is printed as an ordinary solid part.',
  options: ['augment', 'foam', 'regular'],
  optionLabels: { augment: 'Augmentation', foam: 'Foam Print', regular: 'Regular Print' },
};

/** Parameters of a regular print (`EverydayModel.regularConfig`). */
export const REGULAR_SPECS = {
  layerHeight: num('Layer Height (mm)', 0.05, 1, 0.01, 'Thickness of each printed layer.', false, [0.1, 0.4]),
  perimeters: num('Wall Loops', 0, 10, 1, 'How many loops are printed around the outline of every layer.', true, [0, 6]),
  infillDensity: num('Infill Density (%)', 0, 100, 1, 'How much of the inside is filled. 0 leaves it hollow, 100 makes it solid.', true),
  topBottomLayers: num('Top / Bottom Layers', 0, 20, 1, 'How many solid layers close every top and bottom surface.', true, [0, 10]),
  extruder: num('Extruder', 0, 9, 1, 'Which extruder prints this part (0 is the first one). Its temperature and nozzle come from Printer Settings › Extruders.', true, [0, 4]),
  printSpeed: num('Print Speed (mm/min)', 60, 12000, 10, 'Speed of the print head while extruding.', false, [300, 6000]),

  // ----- used only when the desktop app slices with PrusaSlicer (see PRUSA_ONLY_REGULAR_KEYS) -----
  firstLayerHeight: num('First Layer Height (mm)', 0.05, 1, 0.01, `Thickness of the first layer. A thicker first layer sticks better and evens out a slightly uneven bed. It cannot be more than the nozzle diameter. ${PRUSA_ONLY_TIP}`, false, [0.1, 0.4]),
  firstLayerSpeed: num('First Layer Speed (mm/min)', 60, 12000, 10, `Speed of every move on the first layer. Slower helps the part stick. ${PRUSA_ONLY_TIP}`, false, [300, 3000]),
  useProfileSpeeds: bool('Use Profile Speeds', `Use the speeds of your PrusaSlicer profile (Slicer menu), or PrusaSlicer's defaults if none is chosen, instead of Print Speed and First Layer Speed. ${PRUSA_ONLY_TIP}`),
  infillPattern: {
    type: 'enum',
    label: 'Infill Pattern',
    tip: `Pattern of the sparse infill. A solid part (100 % infill) is filled with straight lines whatever is chosen here. ${PRUSA_ONLY_TIP}`,
    options: INFILL_PATTERNS,
    optionLabels: {
      grid: 'Grid',
      gyroid: 'Gyroid',
      rectilinear: 'Rectilinear',
      alignedrectilinear: 'Aligned Rectilinear',
      triangles: 'Triangles',
      stars: 'Stars',
      cubic: 'Cubic',
      adaptivecubic: 'Adaptive Cubic',
      supportcubic: 'Support Cubic',
      lightning: 'Lightning',
      honeycomb: 'Honeycomb',
      '3dhoneycomb': '3D Honeycomb',
      concentric: 'Concentric',
    },
  } as EnumSpec,
  supports: {
    type: 'enum',
    label: 'Supports',
    tip: `Where supports are printed under overhangs. Build Plate Only never puts supports on top of the part itself. ${PRUSA_ONLY_TIP}`,
    options: SUPPORT_MODES,
    optionLabels: { none: 'None', buildplate: 'Build Plate Only', everywhere: 'Everywhere' },
  } as EnumSpec,
  supportStyle: {
    type: 'enum',
    label: 'Support Style',
    tip: `Grid: a sturdy block, easy to remove. Snug: hugs the overhang and uses less material. Organic: branching trees that touch the part only where needed. ${PRUSA_ONLY_TIP}`,
    options: SUPPORT_STYLES,
    optionLabels: { grid: 'Grid', snug: 'Snug', organic: 'Organic (Tree)' },
  } as EnumSpec,
  supportThreshold: num('Overhang Threshold (°)', 0, 90, 1, `Surfaces flatter than this angle, measured from the bed, get support; steeper ones are printed without. 0 lets PrusaSlicer decide from how far each layer overhangs the one below. ${PRUSA_ONLY_TIP}`, true),
  brimWidth: num('Brim Width (mm)', 0, 50, 0.5, `Width of a flat ring printed around the part on the first layer, to stop corners lifting. 0 prints no brim. ${PRUSA_ONLY_TIP}`, false, [0, 20]),
} as const;

/**
 * Regular-print settings that only PrusaSlicer uses. The built-in slicer (the web version, or
 * the desktop app without PrusaSlicer) ignores them, so the panel greys them out there.
 */
export const PRUSA_ONLY_REGULAR_KEYS: readonly RegularKey[] = [
  'firstLayerHeight',
  'firstLayerSpeed',
  'useProfileSpeeds',
  'infillPattern',
  'supports',
  'supportStyle',
  'supportThreshold',
  'brimWidth',
];

export type SettingKey = keyof typeof SETTING_SPECS;
export type RegularKey = keyof typeof REGULAR_SPECS;
export type ExtruderKey = keyof typeof EXTRUDER_SPECS;
export type ModelKey = keyof typeof MODEL_SPECS;
export type InitialKey = keyof typeof INITIAL_SPECS;
