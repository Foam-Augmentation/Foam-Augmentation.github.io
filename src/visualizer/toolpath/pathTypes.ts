import * as THREE from 'three';

/**
 * What a point is there for, when it is not part of the model itself.
 *
 * Model points leave `role` undefined. Everything else is tagged, so that passes which measure
 * the model (its height, its top layer) or which combine several models' toolpaths can tell the
 * helpers apart without guessing from the `travel` / `regularSegment` flags.
 *
 * - `purgeLine`: the priming line printed once at the very start of a print.
 * - `purgeTower`: a layer of the purge tower.
 * - `boundary`: the outline printed around a model's base.
 * - `approach`: a travel move that only exists to get the head somewhere safely (lead-ins,
 *   moves to and from the purge tower, moves between models).
 */
export type PathRole = 'purgeLine' | 'purgeTower' | 'boundary' | 'approach';

/**
 * A single point of a toolpath, together with how the print head gets to it.
 */
export interface PathPoint {
    point: THREE.Vector3;
    /** The head moves here without extruding. */
    travel?: boolean;
    /** The extruder that must be active from this point on. */
    extruder?: number;
    /** Park the head and wait for the user before moving here. */
    pause?: boolean;
    /** The move here is a regular (non-VTP) extrusion, e.g. shells, purge line, purge tower. */
    regularSegment?: boolean;
    /** Written into the G-code as a comment. */
    debug?: string;
    hStar?: number;
    vStar?: number;
    edot?: number;
    deltaZ?: number;
    deltaL?: number;
    /** The move here is an ironing pass (a regular extrusion at reduced flow). */
    ironing?: boolean;
    /** Why the point exists if it is not part of the model. Undefined for model points. */
    role?: PathRole;
    /**
     * Whether this point belongs to the "initial foam layers", which are printed with a different,
     * hand-loaded material. The G-code emitter keeps track of which material is loaded in each tool
     * and pauses for a filament swap whenever this differs from it. Undefined means "don't care".
     */
    initialMaterial?: boolean;
    /**
     * The layer height (mm) a regular or ironing segment was sliced at, used for its extrusion
     * amount. When left out the emitter assumes half the nozzle diameter.
     */
    layerHeight?: number;
    /**
     * The head speed (mm/min) of a regular segment. When left out the emitter uses the active
     * extruder's travel speed, as it always has. Ignored by travel, ironing and foam moves.
     */
    speed?: number;
    /**
     * The exact filament (mm, relative E) the move here feeds, from an outside slicer such as
     * PrusaSlicer. When set it replaces the amount the emitter would work out for a regular
     * segment. A travel may carry a negative amount: a retraction made while moving (a wipe).
     */
    extrusion?: number;
    /** G-code lines written as they are before the move here: retractions, fan changes. */
    preGcode?: string[];
}
