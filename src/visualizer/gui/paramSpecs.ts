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
function num(label: string, min: number, max: number, step: number, tip: string, integer = false): NumberSpec {
  return { type: 'number', label, tip, min, max, step, integer };
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
    tip: 'Shape drawn while holding Alt (Option on Mac) and dragging: a free-form lasso or a rectangle.',
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
  machineDepth: num('Bed Width X (mm)', 1, 1000, 1, 'Size of the print space along X.'),
  machineDepthY: num('Bed Depth Y (mm)', 1, 1000, 1, 'Size of the print space along Y.'),
  machineHeight: num('Build Height Z (mm)', 1, 2000, 1, 'Height of the print space.'),
  filamentDiameter: num('Filament Diameter (mm)', 0.1, 5, 0.01, 'Diameter of the filament being used.'),
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
  nozzleDiameter: num('Nozzle Diameter (mm)', 0.05, 2, 0.01, 'Diameter of this extruder\'s nozzle.'),
  nozzleLength: num('Nozzle Length (mm)', 0, 100, 0.01, 'Length of the nozzle from its tip to the base of the print head.'),
  dieSwelling: num('Die Swell Factor', 0.1, 2, 0.01, 'How much the thread widens as it leaves the nozzle (thread diameter ÷ nozzle diameter).'),
  print_temp_extruder: num('Print Temperature (°C)', 0, 300, 1, 'Nozzle temperature while this extruder is printing.'),
  idle_temp_extruder: num('Idle Temperature (°C)', 0, 300, 1, 'Standby temperature while this extruder is parked.'),
  printHead_speed_when_free_move: num('Travel Speed (mm/min)', 1, 10000, 1, 'Print head speed for moves that do not extrude.'),
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
  deltaZ: num('Layer Thickness ΔZ (mm)', 0.05, 20, 0.01, TIP_DELTA_Z),
  deltaL: num('Line Spacing ΔL (mm)', 0.2, 100, 0.01, TIP_DELTA_L),
  deltaLEnd: num('Top Line Spacing ΔL (mm)', 0.01, 10, 0.01, TIP_DELTA_L_END),
  gridSize: num('Sampling Grid Size (mm)', 0.2, 100, 0.01, 'How far apart the surface is sampled. Smaller is more accurate but slower.'),
  vStar: num('Speed Ratio V*', 0.01, 5, 0.01, TIP_V_STAR),
  vStarEnd: num('Gradient End V*', 0.01, 5, 0.01, TIP_V_STAR_END),
  hStar: num('Height Ratio H*', 0.01, 100, 0.01, TIP_H_STAR),
  hStarEnd: num('Gradient End H*', 0.01, 100, 0.01, TIP_H_STAR_END),
  edot: num('Extrusion Rate Edot (mm/min)', 0.01, 1000, 0.01, TIP_EDOT),

  senseDeltaZ: num('Layer Thickness ΔZ (mm)', 0.05, 20, 0.01, TIP_DELTA_Z),
  senseDeltaL: num('Line Spacing ΔL (mm)', 0.2, 100, 0.01, TIP_DELTA_L),
  senseDeltaLEnd: num('Top Line Spacing ΔL (mm)', 0.01, 10, 0.01, TIP_DELTA_L_END),
  senseVStar: num('Speed Ratio V*', 0.01, 5, 0.01, TIP_V_STAR),
  SenseVStarEnd: num('Gradient End V*', 0.01, 5, 0.01, TIP_V_STAR_END),
  senseHStar: num('Height Ratio H*', 0.01, 100, 0.01, TIP_H_STAR),
  senseHStarEnd: num('Gradient End H*', 0.01, 100, 0.01, TIP_H_STAR_END),
  senseEdot: num('Extrusion Rate Edot (mm/min)', 0.01, 1000, 0.01, TIP_EDOT),

  initialFoamLayerCount: num('Foam Layers', 0, 20, 1, 'How many layers an augmentation gets. The total is Foam Layers + Initial Foam Layers.', true),
  middleSenseLayerCount: num('Middle Sensing Layers', 0, 10, 1, 'How many sensing layers sit between the foam layers.', true),
  finalFoamLayerCount: num('Final Foam Layers', 0, 10, 1, 'How many foam layers are printed on top of the sensing layers.', true),

  curveAugment: bool('Curved Augmentation', 'Curve the augmentation into the shape of the selected augment model. With no augment model selected, the top is flattened instead.'),
  steepnessThreshold: num('Max Surface Angle (°)', 0, 90, 0.01, 'Steepest surface that still gets augmented. Lower values keep the augmentation on flatter areas, where the nozzle can print closer to the model.'),
  flatLayerZOffset: num('Flat Layer Z Offset (mm)', 0, 100, 0.01, 'How far above the model the flat top layer sits. Only used when Curved Augmentation is on and no augment model is selected.'),
  additionalCurveLayers: num('Additional Curve Layers', 0, 100, 1, 'Extra layers printed after the path has reached the target shape. For example, 3 prints three more flat layers after a surface has been flattened.', true),

  generateBumps: bool('Generate Bumps', 'Add bumps across the surface of the augmentation to improve grip.'),
  bumpSpacingX: num('Bump Spacing X (mm)', 0.1, 100, 0.01, 'Distance between bump centres along X.'),
  bumpSpacingY: num('Bump Spacing Y (mm)', 0.1, 100, 0.01, 'Distance between bump centres along Y.'),
  bumpScale: num('Bump Scale', 0.01, 100, 0.01, 'Scale applied to the bump model.'),
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
export const INITIAL_OFFSET_SPEC = num('Outward Offset (mm)', 0, 50, 0.01, 'How far the initial layers are grown outwards, for example to build a scaffold around the object when augmenting.');

export type SettingKey = keyof typeof SETTING_SPECS;
export type ExtruderKey = keyof typeof EXTRUDER_SPECS;
export type ModelKey = keyof typeof MODEL_SPECS;
export type InitialKey = keyof typeof INITIAL_SPECS;
