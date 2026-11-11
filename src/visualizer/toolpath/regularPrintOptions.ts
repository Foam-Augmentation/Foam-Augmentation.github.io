// ---------------------------------------------------------------------------------------------
// The choices offered for the regular-print settings that only PrusaSlicer uses (supports, infill
// pattern). The values are PrusaSlicer's own option values, so they can be passed on as they are.
//
// Kept free of imports so both the slicer code and the GUI's parameter specs can use it.
// ---------------------------------------------------------------------------------------------

/**
 * Where supports are printed:
 * - `none`: no supports.
 * - `buildplate`: only supports that stand on the bed, never on top of the part.
 * - `everywhere`: under every overhang, including on the part itself.
 */
export const SUPPORT_MODES = ['none', 'buildplate', 'everywhere'] as const;
export type SupportMode = typeof SUPPORT_MODES[number];

/** PrusaSlicer's support styles (`support_material_style`). */
export const SUPPORT_STYLES = ['grid', 'snug', 'organic'] as const;
export type SupportStyle = typeof SUPPORT_STYLES[number];

/**
 * The sparse infill patterns offered (`fill_pattern`). PrusaSlicer has a few more, mostly
 * decorative (Hilbert curve, Archimedean chords, ...); they are left out.
 */
export const INFILL_PATTERNS = [
    'grid',
    'gyroid',
    'rectilinear',
    'alignedrectilinear',
    'triangles',
    'stars',
    'cubic',
    'adaptivecubic',
    'supportcubic',
    'lightning',
    'honeycomb',
    '3dhoneycomb',
    'concentric',
] as const;
export type InfillPattern = typeof INFILL_PATTERNS[number];

/**
 * The offered patterns PrusaSlicer accepts at 100 % density. It refuses to slice any other
 * pattern at 100 %, so a solid part is filled with straight lines instead.
 */
export const SOLID_INFILL_PATTERNS: readonly InfillPattern[] = ['rectilinear', 'alignedrectilinear', 'concentric'];

/** The pattern a solid (100 %) part is filled with when the chosen one cannot be. */
export const SOLID_FALLBACK_PATTERN: InfillPattern = 'rectilinear';
