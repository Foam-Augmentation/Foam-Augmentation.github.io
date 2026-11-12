import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import type Printer from '../../printer/Printer';
import type { PathPoint } from './pathTypes';
import { generateRegularToolpath, validateRegularConfig, type RegularPart } from './regularSlicer';
import { buildPrusaConfig, formatPrusaIni, parsePrusaGcode, validatePrusaOptions } from './prusaGcode';
import { TRAVEL_CLEARANCE } from './toolpathConstants';
import { compatibleProfiles, listPrinters, parseVendorBundle, profileIni, type VendorBundle } from './prusaProfiles';

/** The printer profile the app starts with: its printer is an XL with 0.4 mm nozzles. */
export const DEFAULT_PRUSA_PRINTER_PROFILE = 'Original Prusa XL Input Shaper 0.4 nozzle';

/** What the desktop app tells the page about PrusaSlicer. */
export interface PrusaSlicerStatus {
    /** Whether a PrusaSlicer executable was found. */
    available: boolean;
    /** The executable that will be run, if one was found. */
    path?: string;
    /** The user's own PrusaSlicer profile (.ini) loaded under our settings, if one was chosen. */
    profile?: string;
}

/**
 * One slicing job for the desktop app: the parts as binary STL, the app's settings as an .ini
 * file, and the settings of the Prusa profiles chosen in the app (loaded first, so the user's own
 * profile and then the app's settings win over them).
 */
export interface PrusaSliceRequest {
    parts: { name: string, stl: Uint8Array }[];
    ini: string;
    profileIni?: string;
}

/** The bridge the desktop app's preload script puts on `window.prusaSlicer`. */
export interface PrusaSlicerBridge {
    status(): Promise<PrusaSlicerStatus>;
    slice(request: PrusaSliceRequest): Promise<{ gcode: string }>;
    /** Prusa's profile bundle from the PrusaSlicer install, if it can be found. */
    vendorProfiles?(): Promise<{ text: string | null, path?: string }>;
}

declare global {
    interface Window {
        /** Only there when the page runs in the desktop app. */
        prusaSlicer?: PrusaSlicerBridge;
    }
}

/** Which slicer produced a regular toolpath. */
export type RegularSlicerUsed = 'prusaslicer' | 'builtin';

/** A regular toolpath, and how it was made. */
export interface RegularSliceResult {
    toolpath: PathPoint[];
    slicer: RegularSlicerUsed;
    /** Why the built-in slicer was used, or anything else the user should know. */
    notes: string[];
}

/**
 * The PrusaSlicer bridge, when the page runs inside the desktop app.
 *
 * @returns {PrusaSlicerBridge | undefined} The bridge, or undefined in a plain browser.
 */
export function getPrusaSlicerBridge(): PrusaSlicerBridge | undefined {
    return typeof window !== 'undefined' ? window.prusaSlicer : undefined;
}

/**
 * Whether regular prints are sliced with PrusaSlicer right now: the page runs in the desktop
 * app and PrusaSlicer was found. The user can locate PrusaSlicer while the app runs, so ask
 * again rather than keeping the answer.
 *
 * @param {PrusaSlicerBridge | undefined} bridge The desktop app's bridge, if there is one.
 * @returns {Promise<boolean>} True if PrusaSlicer would be used; false in a plain browser, when
 *                             PrusaSlicer is missing, or if the desktop app cannot be asked.
 */
export async function isPrusaSlicerAvailable(bridge: PrusaSlicerBridge | undefined = getPrusaSlicerBridge()): Promise<boolean> {
    if (!bridge) {
        return false;
    }
    try {
        return (await bridge.status()).available;
    } catch {
        return false;
    }
}

/** The bundle each bridge gave, read once. */
const bundles = new WeakMap<PrusaSlicerBridge, Promise<VendorBundle | null>>();

/**
 * Prusa's profile bundle from the PrusaSlicer install the desktop app uses, read once.
 *
 * @param {PrusaSlicerBridge | undefined} bridge The desktop app's bridge, if there is one.
 * @returns {Promise<VendorBundle | null>} The bundle, or null in a plain browser or if there is none.
 */
export function loadVendorBundle(bridge: PrusaSlicerBridge | undefined = getPrusaSlicerBridge()): Promise<VendorBundle | null> {
    if (!bridge?.vendorProfiles) return Promise.resolve(null);
    let promise = bundles.get(bridge);
    if (!promise) {
        promise = bridge.vendorProfiles()
            .then(({ text }) => text ? parseVendorBundle(text) : null)
            .catch(() => null);
        bundles.set(bridge, promise);
    }
    return promise;
}

/** The profiles a bundle offers, worked out once per printer. */
const choiceCache = new WeakMap<VendorBundle, Map<string, { prints: string[], filaments: string[] }>>();

/**
 * What a bundle offers: its printers, and the print and filament profiles that suit one of them.
 *
 * @param {VendorBundle} bundle The bundle.
 * @param {string} printer The printer profile ('' for none: then nothing else is offered).
 * @returns {{ printers: string[], prints: string[], filaments: string[] }} The names, sorted.
 */
export function profileChoices(bundle: VendorBundle, printer: string): { printers: string[], prints: string[], filaments: string[] } {
    let cache = choiceCache.get(bundle);
    if (!cache) {
        cache = new Map();
        choiceCache.set(bundle, cache);
    }
    let lists = cache.get(printer);
    if (!lists) {
        lists = printer
            ? { prints: compatibleProfiles(bundle, 'print', printer), filaments: compatibleProfiles(bundle, 'filament', printer) }
            : { prints: [], filaments: [] };
        cache.set(printer, lists);
    }
    let printers = cache.get('\u0000printers')?.prints;
    if (!printers) {
        printers = listPrinters(bundle);
        cache.set('\u0000printers', { prints: printers, filaments: [] });
    }
    return { printers, ...lists };
}

/**
 * Writes a part as binary STL in printer coordinates: its baked geometry moved by its offset.
 *
 * @param {RegularPart} part The part.
 * @returns {Uint8Array} The STL file.
 */
function partToStl(part: RegularPart): Uint8Array {
    const geometry = part.mesh.geometry.clone();
    if (part.offset) {
        geometry.translate(part.offset.x, part.offset.y, part.offset.z);
    }
    const mesh = new THREE.Mesh(geometry);
    const data = new STLExporter().parse(mesh, { binary: true }) as unknown as DataView;
    geometry.dispose();
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Groups parts that share the same print settings. PrusaSlicer is run once per group, because its
 * command line takes one set of settings for everything it slices.
 *
 * @param {RegularPart[]} parts The parts.
 * @returns {RegularPart[][]} The groups, in the order their first part was given.
 */
function groupBySettings(parts: RegularPart[]): RegularPart[][] {
    const groups = new Map<string, RegularPart[]>();
    for (const part of parts) {
        const key = JSON.stringify(part.config);
        const group = groups.get(key);
        if (group) {
            group.push(part);
        } else {
            groups.set(key, [part]);
        }
    }
    return [...groups.values()];
}

/**
 * Slices regular parts with PrusaSlicer.
 *
 * Parts with the same settings are sliced together and print layer by layer together. Parts with
 * different settings are sliced separately and printed one group after the other; between groups
 * the head rises clear of everything printed so far before crossing to the next group.
 *
 * Each group is sliced with the Prusa profiles chosen for it (the printer's, and the part's print
 * and filament profiles) under the app's settings. A chosen profile the bundle does not have is
 * left out, with a note.
 *
 * @param {Printer} printer The printer.
 * @param {RegularPart[]} parts The parts.
 * @param {PrusaSlicerBridge} bridge The desktop app's bridge.
 * @param {string[]} [notes] Where to add anything the user should know.
 * @returns {Promise<PathPoint[]>} The toolpath.
 */
export async function slicePartsWithPrusa(printer: Printer, parts: RegularPart[], bridge: PrusaSlicerBridge, notes: string[] = []): Promise<PathPoint[]> {
    const toolpath: PathPoint[] = [];
    let highestZ = -Infinity;
    const bundle = await loadVendorBundle(bridge);

    for (const group of groupBySettings(parts)) {
        const config = group[0].config;
        const chosen = { printer: printer.prusaPrinterProfile, print: config.printProfile, filament: config.filamentProfile };
        if (bundle) {
            for (const type of ['printer', 'print', 'filament'] as const) {
                const name = chosen[type];
                if (name && !bundle.sections[type].has(name)) {
                    notes.push(`The ${type} profile “${name}” is not in the PrusaSlicer install's profiles, so it was left out.`);
                    chosen[type] = '';
                }
            }
        } else if (chosen.printer || chosen.print || chosen.filament) {
            notes.push("PrusaSlicer's own profiles could not be read from its install, so the chosen printer, print and filament profiles were left out.");
        }
        const vendorIni = bundle ? profileIni(bundle, chosen) : '';
        const request: PrusaSliceRequest = {
            parts: group.map((part, i) => ({ name: part.name ?? `Part ${i + 1}`, stl: partToStl(part) })),
            ini: formatPrusaIni(buildPrusaConfig(printer, config)),
            ...(vendorIni ? { profileIni: vendorIni } : {}),
        };
        const { gcode } = await bridge.slice(request);
        const groupPath = parsePrusaGcode(gcode, { extruder: config.extruder, objectIds: group.map(part => part.objectId) });
        if (!groupPath.length) {
            continue;
        }

        if (toolpath.length) {
            const last = toolpath[toolpath.length - 1].point;
            const first = groupPath[0].point;
            const safeZ = Math.max(highestZ + TRAVEL_CLEARANCE, first.z);
            toolpath.push({ point: new THREE.Vector3(last.x, last.y, safeZ), travel: true, role: 'approach' });
            toolpath.push({ point: new THREE.Vector3(first.x, first.y, safeZ), travel: true, role: 'approach' });
        }
        for (const point of groupPath) {
            if (point.point.z > highestZ) highestZ = point.point.z;
            toolpath.push(point);
        }
    }
    return toolpath;
}

/**
 * Slices regular parts with PrusaSlicer when the page runs in the desktop app and PrusaSlicer is
 * installed, and with the built-in slicer otherwise.
 *
 * @param {Printer} printer The printer.
 * @param {RegularPart[]} parts The parts.
 * @param {PrusaSlicerBridge | undefined} bridge The desktop app's bridge, if there is one.
 * @returns {Promise<RegularSliceResult>} The toolpath and which slicer made it.
 */
export async function sliceRegularParts(
    printer: Printer,
    parts: RegularPart[],
    bridge: PrusaSlicerBridge | undefined = getPrusaSlicerBridge(),
): Promise<RegularSliceResult> {
    const notes: string[] = [];
    if (bridge) {
        const status = await bridge.status();
        if (status.available) {
            parts.forEach((part, i) => {
                const name = part.name ?? `Part ${i + 1}`;
                validateRegularConfig(printer, part.config, name);
                validatePrusaOptions(printer, part.config, name);
            });
            if (groupBySettings(parts).length > 1) {
                notes.push('Regular parts with different settings are printed one group after another. Keep them well apart: nothing checks that the print head clears a finished group.');
            }
            return { toolpath: await slicePartsWithPrusa(printer, parts, bridge, notes), slicer: 'prusaslicer', notes };
        }
        notes.push('PrusaSlicer was not found, so the built-in slicer was used. Choose it under Slicer → Locate PrusaSlicer….');
    }
    return { toolpath: generateRegularToolpath(printer, parts), slicer: 'builtin', notes };
}
