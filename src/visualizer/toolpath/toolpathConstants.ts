/**
 * Numbers the toolpath generators share. Anything that depends on the machine (bed size, nozzle,
 * purge tower position) lives on the Printer instead; these are the remaining fixed choices.
 */

/** Maximum distance (mm) between consecutive toolpath points after filling. Smaller follows curves and gradients more closely. */
export const TOOLPATH_FILL_DISTANCE = 0.5;

/** Slack (mm) when turning a height into a layer index, so a layer sitting exactly on a boundary lands in it. */
export const LAYER_INDEX_TOLERANCE = 1e-4;

/** How far (mm) above the tallest thing printed so far the head lifts before a long travel move. */
export const TRAVEL_CLEARANCE = 10;

/** Height (mm) the purge line is printed at. */
export const PURGE_LINE_Z = 0.3;
/** Distance (mm) between the passes of the purge line. */
export const PURGE_LINE_SEPARATION = 2;
/** Number of passes the purge line makes across the bed. */
export const PURGE_LINE_COUNT = 2;
/** How far (mm) the head lifts off the purge line before travelling to the print. */
export const PURGE_LINE_LIFT = 2;

/** Height (mm) of the first layer of the boundary outline. */
export const BOUNDARY_FIRST_LAYER_Z = 0.1;
/** Height (mm) of each further boundary layer. */
export const BOUNDARY_LAYER_HEIGHT = 0.2;
/** How far (mm) outside the model's base the boundary outline is printed. */
export const BOUNDARY_OFFSET = 1;

/** Distance (mm) between ironing passes over a shell region. */
export const IRONING_LINE_SPACING = 0.4;

/** Number of beads making up the purge tower's wall. */
export const PURGE_TOWER_WALL_LINES = 3;
/** Rough length (mm) of each straight chord of the purge tower's spiral. */
export const PURGE_TOWER_POINT_SPACING = 0.5;

/** Flat layers added on top of a curve-augmented stack. */
export const CURVE_AUGMENT_EXTRA_FLAT_LAYERS = 3;
/** Points within this distance (mm) of the highest model point count as the top layer. */
export const TOP_LAYER_TOLERANCE = 0.01;

/** Alpha-shape radius (mm) used to turn sampled points into printable regions. */
export const POINT_CLOUD_ALPHA = 5;

/** Accuracy (mm) of the extra clearance the collision check recommends. */
export const COLLISION_OFFSET_TOLERANCE = 0.02;

/** Tolerance (mm) for the bed-bounds check, so points that sit exactly on an edge pass. */
export const BOUNDS_TOLERANCE = 1e-6;

/** Preview colour of travel moves: muted, so the printed lines stand out against the dark scene. */
export const TRAVEL_PREVIEW_COLOR = 0x7f8fa6;
