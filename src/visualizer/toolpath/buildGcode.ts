import * as THREE from 'three';
import type Printer from '../../printer/Printer';
import type { PathPoint } from './pathTypes';
import { BOUNDS_TOLERANCE, TRAVEL_CLEARANCE } from './toolpathConstants';

/** At most this many individual problems are spelled out in a validation error. */
const MAX_REPORTED_PROBLEMS = 5;

/** Which extruders a toolpath uses. */
export interface ExtruderUsage {
    /** The extruder of the first point that names one, or 0 if no point does. */
    first: number;
    /** Every extruder named by any point, in order of first use. */
    used: number[];
}

/**
 * Works out which tool a toolpath starts with and which tools it uses at all.
 *
 * The first tool is taken from the first point that actually names an extruder: the leading
 * points of a toolpath (purge line, lead-in travel) usually do not, and assuming tool 0 for
 * them would heat and pick a tool the print may never use.
 *
 * @param {PathPoint[]} toolpath The toolpath to inspect.
 * @returns {ExtruderUsage} The first extruder and the list of used extruders.
 */
export function getExtruderUsage(toolpath: PathPoint[]): ExtruderUsage {
    const used: number[] = [];
    for (const point of toolpath) {
        if (point.extruder !== undefined && used.indexOf(point.extruder) === -1) {
            used.push(point.extruder);
        }
    }
    return { first: used.length ? used[0] : 0, used };
}

/**
 * The height the purge tower has reached at the end of a toolpath.
 *
 * @param {PathPoint[]} toolpath The toolpath to inspect.
 * @returns {number} The highest purge tower point's z, or 0 if the toolpath has no tower.
 */
export function getPurgeTowerHeight(toolpath: PathPoint[]): number {
    let height = 0;
    for (const point of toolpath) {
        if (point.role === 'purgeTower' && point.point.z > height) {
            height = point.point.z;
        }
    }
    return height;
}

/**
 * Joins the toolpaths of several models into the single toolpath of one print.
 *
 * - Only the first purge line is kept; the tool is primed once, at the start of the print.
 * - Between two models the head first lifts straight up to clear everything printed so far and
 *   only then crosses over, instead of cutting diagonally from the top of one model to the
 *   start of the next.
 * - The purge tower has to keep growing: a model whose tower would start below the height the
 *   tower already has is rejected, because the head would be driven into the existing tower.
 *
 * The toolpaths themselves are not modified.
 *
 * @param {PathPoint[][]} toolpaths One toolpath per model, in print order.
 * @returns {PathPoint[]} The combined toolpath.
 */
export function combineToolpaths(toolpaths: PathPoint[][]): PathPoint[] {
    const combined: PathPoint[] = [];
    let highestZ = -Infinity;
    let towerHeight = 0;
    let bodies = 0;

    for (const toolpath of toolpaths) {
        // Every model's toolpath carries its own purge line; all but the first are dropped.
        const body = bodies === 0 ? toolpath : toolpath.filter(point => point.role !== 'purgeLine');
        if (!body.length) {
            continue;
        }

        let lowestTowerZ = Infinity;
        for (const point of body) {
            if (point.role === 'purgeTower' && point.point.z < lowestTowerZ) {
                lowestTowerZ = point.point.z;
            }
        }
        if (lowestTowerZ <= towerHeight + BOUNDS_TOLERANCE) {
            throw new Error(
                `Model ${bodies + 1}'s purge tower starts at z=${lowestTowerZ.toFixed(3)} mm, but the tower is already ` +
                `${towerHeight.toFixed(3)} mm tall. Regenerate the toolpaths so the tower continues from its current height.`
            );
        }

        if (combined.length) {
            const from = combined[combined.length - 1].point;
            const to = body[0].point;
            const safeZ = Math.max(highestZ + TRAVEL_CLEARANCE, from.z, to.z);
            combined.push(
                { point: new THREE.Vector3(from.x, from.y, safeZ), travel: true, role: 'approach', debug: `NEXT MODEL (${bodies + 1})` },
                { point: new THREE.Vector3(to.x, to.y, safeZ), travel: true, role: 'approach' },
            );
        }

        for (const point of body) {
            combined.push(point);
            if (point.point.z > highestZ) {
                highestZ = point.point.z;
            }
        }
        towerHeight = Math.max(towerHeight, getPurgeTowerHeight(body));
        bodies++;
    }

    return combined;
}

/**
 * Checks the printer's own parameters for values that can only produce broken G-code.
 *
 * @param {Printer} printer The printer to check.
 * @returns {string[]} A description of every problem found. Empty if the printer is fine.
 */
export function validatePrinter(printer: Printer): string[] {
    const problems: string[] = [];
    const positive = (value: number, name: string) => {
        if (!Number.isFinite(value) || value <= 0) {
            problems.push(`${name} must be a positive number (is ${value}).`);
        }
    };
    const finiteNonNegative = (value: number, name: string) => {
        if (!Number.isFinite(value) || value < 0) {
            problems.push(`${name} must be zero or more (is ${value}).`);
        }
    };

    positive(printer.machine_depth, 'Machine depth (X)');
    positive(printer.machine_depth_y, 'Machine depth (Y)');
    positive(printer.machine_height, 'Machine height');
    positive(printer.diameter_filament, 'Filament diameter');
    finiteNonNegative(printer.material_bed_temperature, 'Bed temperature');
    finiteNonNegative(printer.toolchangeRetract, 'Toolchange retract');

    if (!printer.extruders.length) {
        problems.push('The printer has no extruders.');
    }
    printer.extruders.forEach((extruder, n) => {
        positive(extruder.nozzleDiameter, `Extruder ${n} nozzle diameter`);
        positive(extruder.dieSwelling, `Extruder ${n} die swelling`);
        positive(extruder.printHead_speed_when_free_move, `Extruder ${n} travel speed`);
        finiteNonNegative(extruder.print_temp_extruder, `Extruder ${n} print temperature`);
        finiteNonNegative(extruder.idle_temp_extruder, `Extruder ${n} idle temperature`);
    });

    return problems;
}

/**
 * Checks a finished toolpath against the printer before any G-code is written: every coordinate
 * must be a real number inside the machine's volume, every extruder must exist, and every foam
 * extrusion must carry positive V*, H* and Edot.
 *
 * @param {Printer} printer The printer the toolpath will run on.
 * @param {PathPoint[]} toolpath The toolpath to check.
 * @returns {string[]} A description of every kind of problem found. Empty if the toolpath is printable.
 */
export function validateToolpath(printer: Printer, toolpath: PathPoint[]): string[] {
    const problems: string[] = [];
    const tol = BOUNDS_TOLERANCE;
    const limits = { x: printer.machine_depth, y: printer.machine_depth_y, z: printer.machine_height };

    // Problems are grouped by kind, so one misplaced model gives one message instead of thousands.
    const counts = new Map<string, { count: number; example: string }>();
    const report = (kind: string, example: string) => {
        const entry = counts.get(kind);
        if (entry) {
            entry.count++;
        } else {
            counts.set(kind, { count: 1, example });
        }
    };
    const describe = (i: number, p: THREE.Vector3) =>
        `point ${i} at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;

    for (let i = 0; i < toolpath.length; i++) {
        const point = toolpath[i];
        const p = point.point;

        if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
            report('A coordinate is not a number', `point ${i} is (${p.x}, ${p.y}, ${p.z})`);
            continue;
        }
        for (const axis of ['x', 'y', 'z'] as const) {
            if (p[axis] < -tol) {
                report(`${axis.toUpperCase()} is below 0`, describe(i, p));
            } else if (p[axis] > limits[axis] + tol) {
                report(`${axis.toUpperCase()} is beyond the machine's ${limits[axis]} mm`, describe(i, p));
            }
        }

        if (point.extruder !== undefined && !printer.extruders[point.extruder]) {
            report(`Extruder ${point.extruder} does not exist`, `point ${i}`);
        }

        const isFoamExtrusion = !point.travel && !point.regularSegment && !point.ironing;
        if (isFoamExtrusion) {
            for (const [name, value] of [['V*', point.vStar], ['H*', point.hStar], ['Edot', point.edot]] as const) {
                if (value === undefined || !Number.isFinite(value) || value <= 0) {
                    report(`${name} must be a positive number`, `point ${i} has ${name} = ${value}`);
                }
            }
        }
        if (point.layerHeight !== undefined && !(point.layerHeight > 0)) {
            report('Layer height must be a positive number', `point ${i} has ${point.layerHeight}`);
        }
    }

    counts.forEach((entry, kind) => {
        problems.push(`${kind}: ${entry.count} point(s), e.g. ${entry.example}.`);
    });
    return problems;
}

/**
 * Throws if the printer settings or the toolpath would produce G-code that is unsafe to run.
 *
 * @param {Printer} printer The printer the toolpath will run on.
 * @param {PathPoint[]} toolpath The toolpath to check.
 */
export function assertPrintable(printer: Printer, toolpath: PathPoint[]): void {
    const problems = [...validatePrinter(printer), ...validateToolpath(printer, toolpath)];
    if (!problems.length) {
        return;
    }
    const shown = problems.slice(0, MAX_REPORTED_PROBLEMS);
    const hidden = problems.length - shown.length;
    throw new Error(
        'The G-code was not generated because the toolpath is not safe to print:\n- ' +
        shown.join('\n- ') +
        (hidden > 0 ? `\n(and ${hidden} more)` : '')
    );
}

/**
 * Builds the complete G-code file for a print made of one or more model toolpaths.
 *
 * All bodies are emitted here, in one pass, after the start G-code: the tool that is picked and
 * the material that is loaded are carried from one model into the next, so a model that needs a
 * different tool than the previous one ended on gets a tool change. Start G-code, purge line and
 * end G-code each appear exactly once, and every heater is switched off at the end.
 *
 * @param {Printer} printer The printer to generate G-code for.
 * @param {PathPoint[][]} toolpaths One toolpath per model, in print order.
 * @returns {string} The whole G-code file.
 * @throws {Error} If there is nothing to print, or the toolpath fails validation.
 */
export function buildPrintGcode(printer: Printer, toolpaths: PathPoint[][]): string {
    const toolpath = combineToolpaths(toolpaths);
    if (!toolpath.length) {
        throw new Error('There is no toolpath to generate G-code from.');
    }

    assertPrintable(printer, toolpath);

    const { first, used } = getExtruderUsage(toolpath);
    const start = printer.build_start_gcode(first, used);
    const body = printer.generate_foam_gcode(toolpath, printer.createEmitterState(first));
    return start + body + printer.build_end_gcode();
}
