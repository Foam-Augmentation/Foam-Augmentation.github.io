import * as THREE from 'three';
import type Printer from '../../printer/Printer';
import type { PathPoint } from './pathTypes';
import type { RegularPrintConfig } from './regularSlicer';
import {
    INFILL_PATTERNS,
    SOLID_FALLBACK_PATTERN,
    SOLID_INFILL_PATTERNS,
    SUPPORT_MODES,
    SUPPORT_STYLES,
    type SupportMode,
} from './regularPrintOptions';

// ---------------------------------------------------------------------------------------------
// The parts of the PrusaSlicer integration that do not need Electron: the settings PrusaSlicer is
// run with, and turning the G-code it writes back into our toolpath points.
//
// PrusaSlicer is run as a separate program (see electron/main.js). Our G-code emitter stays in
// charge of the file: the start and end G-code, tool changes, the purge line and tower. From
// PrusaSlicer we only take the moves, with the exact amount of filament each one extrudes, its
// speed, and the retraction and fan commands between them.
// ---------------------------------------------------------------------------------------------

/**
 * PrusaSlicer settings, as the `key = value` lines of a PrusaSlicer .ini file.
 * Values are strings exactly as PrusaSlicer writes them (e.g. `fill_density = 20%`).
 */
export type PrusaConfig = Record<string, string>;

/** mm/min to mm/s, the unit PrusaSlicer's speeds are in. */
const MM_PER_MIN_TO_MM_PER_S = 1 / 60;

/**
 * The settings our part of the pipeline relies on. These always override the user's own
 * PrusaSlicer profile, because the parser and the emitter depend on them.
 *
 * - Relative E: the emitter runs the printer in M83 mode and copies each move's E value as is.
 * - No start/end/layer/tool-change G-code and no temperature commands: those come from our emitter.
 * - No arcs: the parser and the preview only understand straight moves.
 * - No skirt or wipe tower: our purge line and purge tower do that job.
 * - No sequential printing: every object is printed layer by layer together.
 */
const INTEGRATION_SETTINGS: PrusaConfig = {
    use_relative_e_distances: '1',
    gcode_flavor: 'marlin2',
    start_gcode: '',
    end_gcode: '',
    before_layer_gcode: '',
    // PrusaSlicer refuses relative E without this. The parser drops it again: our emitter works in M83 too.
    layer_gcode: 'G92 E0',
    toolchange_gcode: '',
    autoemit_temperature_commands: '0',
    arc_fitting: 'disabled',
    skirts: '0',
    wipe_tower: '0',
    complete_objects: '0',
    gcode_label_objects: 'disabled',
};

/** The PrusaSlicer settings behind each choice of where supports go. */
const SUPPORT_SETTINGS: Record<SupportMode, PrusaConfig> = {
    none: { support_material: '0' },
    // Automatic supports on: with plain STL parts there are no support enforcers, so supports
    // that only follow enforcers would never print anything.
    buildplate: { support_material: '1', support_material_auto: '1', support_material_buildplate_only: '1' },
    everywhere: { support_material: '1', support_material_auto: '1', support_material_buildplate_only: '0' },
};

/** mm/min as the mm/s string PrusaSlicer takes. */
function toPrusaSpeed(mmPerMin: number): string {
    return (mmPerMin * MM_PER_MIN_TO_MM_PER_S).toFixed(2);
}

/**
 * Checks the regular-print settings that only PrusaSlicer uses (the built-in slicer ignores
 * them, see validateRegularConfig for the rest), so a bad value gets a clear message instead of
 * a PrusaSlicer error.
 *
 * @param {Printer} printer The printer the part is printed on.
 * @param {RegularPrintConfig} config How to print the part.
 * @param {string} name What to call the part in the message.
 * @throws {Error} If a setting has a value PrusaSlicer cannot slice with.
 */
export function validatePrusaOptions(printer: Printer, config: RegularPrintConfig, name: string): void {
    const fail = (problem: string): never => {
        throw new Error(`Regular print settings of "${name}": ${problem}`);
    };
    const oneOf = (value: unknown, options: readonly string[]) => typeof value === 'string' && options.includes(value);

    if (!oneOf(config.supports, SUPPORT_MODES)) {
        fail(`"${config.supports}" is not a supports choice (${SUPPORT_MODES.join(', ')}).`);
    }
    if (!oneOf(config.supportStyle, SUPPORT_STYLES)) {
        fail(`"${config.supportStyle}" is not a support style (${SUPPORT_STYLES.join(', ')}).`);
    }
    if (!oneOf(config.infillPattern, INFILL_PATTERNS)) {
        fail(`"${config.infillPattern}" is not an infill pattern (${INFILL_PATTERNS.join(', ')}).`);
    }
    if (!Number.isInteger(config.supportThreshold) || config.supportThreshold < 0 || config.supportThreshold > 90) {
        fail(`the overhang threshold must be a whole number of degrees from 0 to 90 (it is ${config.supportThreshold}).`);
    }
    if (!Number.isFinite(config.brimWidth) || config.brimWidth < 0) {
        fail(`the brim width must be 0 or more (it is ${config.brimWidth}).`);
    }
    if (!Number.isFinite(config.firstLayerHeight) || config.firstLayerHeight <= 0) {
        fail(`the first layer height must be greater than 0 (it is ${config.firstLayerHeight}).`);
    }
    // PrusaSlicer refuses a first layer taller than the nozzle is wide.
    const nozzleDiameter = printer.extruders[config.extruder]?.nozzleDiameter;
    if (nozzleDiameter !== undefined && config.firstLayerHeight > nozzleDiameter) {
        fail(`the first layer height (${config.firstLayerHeight} mm) cannot be more than the nozzle diameter (${nozzleDiameter} mm).`);
    }
    if (typeof config.useProfileSpeeds !== 'boolean') {
        fail('"Use Profile Speeds" must be on or off.');
    }
    if (!config.useProfileSpeeds && (!Number.isFinite(config.firstLayerSpeed) || config.firstLayerSpeed <= 0)) {
        fail(`the first layer speed must be greater than 0 (it is ${config.firstLayerSpeed}).`);
    }
}

/**
 * The PrusaSlicer settings for one regular part: the integration settings, the printer's machine
 * and nozzle, and the part's own print settings (layers, walls, infill, supports, brim and, unless
 * the part uses the profile's speeds, its speeds). Everything else (retraction, cooling, seams,
 * support details, ...) is left to the user's PrusaSlicer profile, or PrusaSlicer's defaults.
 *
 * @param {Printer} printer The printer the part is printed on.
 * @param {RegularPrintConfig} config How to print the part. Check it with validatePrusaOptions first.
 * @returns {PrusaConfig} The settings to pass to PrusaSlicer.
 */
export function buildPrusaConfig(printer: Printer, config: RegularPrintConfig): PrusaConfig {
    const extruder = printer.extruders[config.extruder];
    if (!extruder) {
        throw new Error(`Extruder ${config.extruder} does not exist.`);
    }
    const width = printer.machine_depth;
    const depth = printer.machine_depth_y;
    const printSpeed = toPrusaSpeed(config.printSpeed);
    const speeds: PrusaConfig = config.useProfileSpeeds ? {} : {
        perimeter_speed: printSpeed,
        infill_speed: printSpeed,
        solid_infill_speed: printSpeed,
        first_layer_speed: toPrusaSpeed(config.firstLayerSpeed),
    };
    const solid = config.infillDensity >= 100;
    const fillPattern = solid && !SOLID_INFILL_PATTERNS.includes(config.infillPattern)
        ? SOLID_FALLBACK_PATTERN
        : config.infillPattern;

    return {
        ...INTEGRATION_SETTINGS,
        // The machine, so PrusaSlicer accepts every part that fits our bed.
        bed_shape: `0x0,${width}x0,${width}x${depth},0x${depth}`,
        max_print_height: String(printer.machine_height),
        nozzle_diameter: String(extruder.nozzleDiameter),
        filament_diameter: String(printer.diameter_filament),
        temperature: String(extruder.print_temp_extruder),
        first_layer_temperature: String(extruder.print_temp_extruder),
        bed_temperature: String(printer.material_bed_temperature),
        first_layer_bed_temperature: String(printer.material_bed_temperature),
        travel_speed: (extruder.printHead_speed_when_free_move * MM_PER_MIN_TO_MM_PER_S).toFixed(2),
        // The part's own settings, as set in the object list.
        layer_height: String(config.layerHeight),
        first_layer_height: String(config.firstLayerHeight),
        perimeters: String(config.perimeters),
        fill_density: `${config.infillDensity}%`,
        fill_pattern: fillPattern,
        top_solid_layers: String(config.topBottomLayers),
        bottom_solid_layers: String(config.topBottomLayers),
        ...SUPPORT_SETTINGS[config.supports],
        support_material_style: config.supportStyle,
        support_material_threshold: String(config.supportThreshold),
        brim_width: String(config.brimWidth),
        ...speeds,
    };
}

/**
 * Writes settings as a PrusaSlicer .ini file.
 *
 * @param {PrusaConfig} config The settings.
 * @returns {string} The file's contents.
 * @throws {Error} If a key or value could not be written safely (a newline would start a new setting).
 */
export function formatPrusaIni(config: PrusaConfig): string {
    return Object.entries(config).map(([key, value]) => {
        if (!/^[a-z0-9_]+$/.test(key)) {
            throw new Error(`"${key}" is not a valid PrusaSlicer setting name.`);
        }
        if (/[\r\n]/.test(value)) {
            throw new Error(`The PrusaSlicer setting "${key}" contains a line break.`);
        }
        return `${key} = ${value}`;
    }).join('\n') + '\n';
}

/** Options for {@link parsePrusaGcode}. */
export interface ParsePrusaGcodeOptions {
    /** The extruder that prints the moves. Set on the first point so the emitter picks that tool. */
    extruder: number;
}

/** Splits a G-code word like `X12.5` into its letter and number. */
function readWords(code: string): Map<string, number> {
    const words = new Map<string, number>();
    for (const word of code.trim().split(/\s+/).slice(1)) {
        const value = Number(word.slice(1));
        if (word.length > 1 && Number.isFinite(value)) {
            words.set(word[0].toUpperCase(), value);
        }
    }
    return words;
}

/**
 * Turns the G-code PrusaSlicer wrote (with {@link buildPrusaConfig}'s settings) into toolpath points.
 *
 * - A move that extrudes becomes a regular segment carrying its exact `extrusion` and `speed`.
 * - A move that does not extrude becomes a travel. A travel that retracts while it moves (a wipe)
 *   keeps its negative `extrusion`.
 * - Retractions and fan commands, which do not move the head, are kept as `preGcode` on the
 *   point after them. A final retraction with no move after it is dropped: the next toolpath
 *   starts with its own moves, and PrusaSlicer has no matching unretract waiting.
 * - Feature changes (`;TYPE:Perimeter`) are carried over as debug comments.
 * - Everything else (temperatures, progress, `G92 E0`, the tool select) is our emitter's job and dropped.
 *
 * Moves before the head's x, y and z are all known only update where the head is.
 *
 * @param {string} gcode The G-code PrusaSlicer wrote.
 * @param {ParsePrusaGcodeOptions} options How to label the points.
 * @returns {PathPoint[]} The toolpath, in printer coordinates. Empty if nothing is printed.
 * @throws {Error} If the G-code uses absolute extrusion, arcs or a coordinate reset, which the
 *                 settings are meant to rule out.
 */
export function parsePrusaGcode(gcode: string, options: ParsePrusaGcodeOptions): PathPoint[] {
    const path: PathPoint[] = [];
    let x: number | null = null;
    let y: number | null = null;
    let z: number | null = null;
    let feed: number | undefined;
    let pending: string[] = [];
    let pendingType: string | undefined;
    let extruded = false;

    const lines = gcode.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const commentAt = line.indexOf(';');
        const code = (commentAt === -1 ? line : line.slice(0, commentAt)).trim();
        const comment = commentAt === -1 ? '' : line.slice(commentAt + 1).trim();

        if (comment.startsWith('TYPE:')) {
            pendingType = comment.slice('TYPE:'.length);
        }
        if (!code) {
            continue;
        }

        const command = code.split(/\s+/)[0].toUpperCase();
        const fail = (why: string) => {
            throw new Error(`PrusaSlicer's G-code could not be read: ${why} (line ${i + 1}: "${line.trim()}").`);
        };

        if (command === 'G0' || command === 'G1') {
            const words = readWords(code);
            if (words.has('F')) {
                feed = words.get('F');
            }
            const moves = words.has('X') || words.has('Y') || words.has('Z');
            const e = words.get('E');
            if (!moves) {
                if (e !== undefined && e !== 0) {
                    pending.push(feed !== undefined ? `G1 E${e} F${feed}` : `G1 E${e}`);
                }
                continue;
            }

            x = words.get('X') ?? x;
            y = words.get('Y') ?? y;
            z = words.get('Z') ?? z;
            if (x === null || y === null || z === null) {
                continue;
            }

            const point: PathPoint = { point: new THREE.Vector3(x, y, z) };
            if (e !== undefined && e > 0) {
                point.regularSegment = true;
                point.extrusion = e;
                extruded = true;
            } else {
                point.travel = true;
                if (e !== undefined && e < 0) {
                    point.extrusion = e;
                }
            }
            if (feed !== undefined) {
                point.speed = feed;
            }
            if (path.length === 0) {
                point.extruder = options.extruder;
            }
            if (pending.length) {
                point.preGcode = pending;
                pending = [];
            }
            if (pendingType !== undefined) {
                point.debug = `PrusaSlicer: ${pendingType}`;
                pendingType = undefined;
            }
            path.push(point);
        } else if (command === 'G10' || command === 'G11' || command === 'M106' || command === 'M107') {
            // Firmware retraction and the part cooling fan.
            pending.push(code);
        } else if (command === 'M82') {
            fail('it uses absolute extrusion; use_relative_e_distances must be on');
        } else if (command === 'G2' || command === 'G3') {
            fail('it contains arcs; arc_fitting must be disabled');
        } else if (command === 'G91') {
            fail('it switches to relative positioning');
        } else if (command === 'G92') {
            const words = readWords(code);
            if (words.has('X') || words.has('Y') || words.has('Z')) {
                fail('it resets the head position');
            }
        }
        // Anything else (M104/M109/M140/M190, M73, M83, G90, T0, ...) belongs to our emitter.
    }

    return extruded ? path : [];
}
