// ---------------------------------------------------------------------------------------------
// PrusaSlicer's own printer, print and filament profiles, read from the vendor bundle that comes
// with the user's PrusaSlicer install (resources/profiles/PrusaResearch.ini). The app does not
// ship the bundle; the desktop app reads it from the installed PrusaSlicer at run time.
//
// A bundle is an .ini file of sections like `[print:0.20mm QUALITY @XLIS 0.4]`. A section can
// inherit from others (`inherits = *common*; *XLIS*`); names in asterisks are building blocks,
// not profiles of their own. Print and filament profiles say which printers they suit with a
// `compatible_printers_condition` such as `printer_notes=~/.*XLIS.*/ and nozzle_diameter[0]==0.4`;
// this file resolves the inheritance and evaluates those conditions.
//
// No DOM here, so it can be unit-tested under Node.
// ---------------------------------------------------------------------------------------------

/** The kinds of profile the app uses. */
export type ProfileType = 'printer' | 'print' | 'filament';

/** A profile's settings, as `key = value` text exactly as the bundle writes them. */
export type ProfileValues = Record<string, string>;

/** A parsed vendor bundle: every section of each kind, by name, with its own (not inherited) values. */
export interface VendorBundle {
    sections: Record<ProfileType, Map<string, ProfileValues>>;
}

/** Settings that describe a profile rather than configure slicing. They are not passed on to PrusaSlicer. */
const META_KEYS = new Set([
    'inherits', 'renamed_from', 'alias', 'compatible_printers', 'compatible_printers_condition',
    'compatible_prints', 'compatible_prints_condition', 'default_print_profile', 'default_filament_profile',
    'default_sla_print_profile', 'default_sla_material_profile', 'printer_variant', 'visible',
]);

/**
 * Reads a vendor bundle.
 *
 * @param {string} text The bundle file.
 * @returns {VendorBundle} Its printer, print and filament sections.
 */
export function parseVendorBundle(text: string): VendorBundle {
    const sections: VendorBundle['sections'] = { printer: new Map(), print: new Map(), filament: new Map() };
    let current: ProfileValues | null = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const header = /^\[(printer|print|filament):(.+)\]$/.exec(line);
        if (header) {
            current = {};
            sections[header[1] as ProfileType].set(header[2], current);
            continue;
        }
        if (line.startsWith('[')) {
            current = null; // a section the app does not use ([vendor], [printer_model:...], ...)
            continue;
        }
        const equals = line.indexOf('=');
        if (current && equals > 0) {
            current[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
        }
    }
    return { sections };
}

/** Whether a section is a building block (`*name*`) rather than a profile of its own. */
export function isAbstract(name: string): boolean {
    return name.startsWith('*') && name.endsWith('*');
}

/** The names in an `inherits` value: `a; b` or `"a"; "b"`. */
function parentsOf(values: ProfileValues): string[] {
    const inherits = values.inherits?.trim();
    if (!inherits) return [];
    return inherits.split(';').map(name => name.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

/**
 * A section's settings with everything it inherits filled in: parents first, in order, then its own.
 *
 * @param {VendorBundle} bundle The bundle.
 * @param {ProfileType} type The kind of section.
 * @param {string} name The section's name.
 * @returns {ProfileValues | undefined} The settings, or undefined if there is no such section.
 */
export function resolveProfile(bundle: VendorBundle, type: ProfileType, name: string): ProfileValues | undefined {
    const resolve = (sectionName: string, seen: Set<string>): ProfileValues | undefined => {
        const own = bundle.sections[type].get(sectionName);
        if (!own || seen.has(sectionName)) return undefined;
        seen.add(sectionName);
        const merged: ProfileValues = {};
        for (const parent of parentsOf(own)) {
            Object.assign(merged, resolve(parent, seen) ?? {});
        }
        Object.assign(merged, own);
        seen.delete(sectionName);
        return merged;
    };
    return resolve(name, new Set());
}

/** The settings of a profile to pass to PrusaSlicer: resolved, without the ones that only describe it. */
export function profileSettings(bundle: VendorBundle, type: ProfileType, name: string): ProfileValues | undefined {
    const resolved = resolveProfile(bundle, type, name);
    if (!resolved) return undefined;
    const settings: ProfileValues = {};
    for (const [key, value] of Object.entries(resolved)) {
        if (!META_KEYS.has(key)) settings[key] = value;
    }
    return settings;
}

// ----- compatibility conditions ---------------------------------------------------------------

/** What a condition can read about a printer. */
export type ConditionVariables = Record<string, string | number | (string | number)[]>;

/** Reads a value the way PrusaSlicer stores it: a quoted string, a number, or a list split by commas. */
function readValue(raw: string | undefined): string | number | (string | number)[] {
    if (raw === undefined) return '';
    const text = raw.trim();
    if (/^".*"$/.test(text)) return text.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    if (text.includes(',')) return text.split(',').map(part => readValue(part) as string | number);
    const number = Number(text);
    return text !== '' && Number.isFinite(number) ? number : text;
}

/**
 * The values a compatibility condition can read about a printer profile.
 *
 * @param {ProfileValues} printer The printer profile, resolved.
 * @returns {ConditionVariables} Its settings as typed values, plus `num_extruders`.
 */
export function printerVariables(printer: ProfileValues): ConditionVariables {
    const variables: ConditionVariables = {};
    for (const [key, raw] of Object.entries(printer)) variables[key] = readValue(raw);
    const nozzles = variables.nozzle_diameter;
    variables.num_extruders = Array.isArray(nozzles) ? nozzles.length : 1;
    return variables;
}

type Token =
    | { kind: 'op', value: string }
    | { kind: 'name', value: string }
    | { kind: 'number', value: number }
    | { kind: 'string', value: string }
    | { kind: 'regex', value: string };

/** Splits a condition into tokens. */
function tokenize(expression: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < expression.length) {
        const rest = expression.slice(i);
        const space = /^\s+/.exec(rest);
        if (space) { i += space[0].length; continue; }
        const op = /^(=~|!~|==|!=|<=|>=|&&|\|\||<|>|!|\(|\)|\[|\])/.exec(rest);
        // After =~ or !~ a slash starts a regular expression, not a division.
        const previous = tokens[tokens.length - 1];
        if (rest[0] === '/' && previous?.kind === 'op' && (previous.value === '=~' || previous.value === '!~')) {
            let j = 1;
            while (j < rest.length && rest[j] !== '/') j += rest[j] === '\\' ? 2 : 1;
            tokens.push({ kind: 'regex', value: rest.slice(1, j) });
            i += j + 1;
            continue;
        }
        if (op) { tokens.push({ kind: 'op', value: op[0] }); i += op[0].length; continue; }
        const string = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
        if (string) { tokens.push({ kind: 'string', value: string[1] }); i += string[0].length; continue; }
        const number = /^\d+(\.\d+)?/.exec(rest);
        if (number) { tokens.push({ kind: 'number', value: Number(number[0]) }); i += number[0].length; continue; }
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
        if (name) {
            const word = name[0];
            tokens.push(word === 'and' || word === 'or' || word === 'not' ? { kind: 'op', value: word } : { kind: 'name', value: word });
            i += word.length;
            continue;
        }
        throw new Error(`Cannot read "${rest.slice(0, 20)}" in the condition.`);
    }
    return tokens;
}

/**
 * Evaluates a compatibility condition (PrusaSlicer's macro language, the part profile bundles
 * use: `and`/`or`/`not`, `!`, brackets, comparisons, `=~`/`!~` regular expressions, and
 * variables with an optional `[index]`).
 *
 * @param {string} expression The condition. Empty means "any printer".
 * @param {ConditionVariables} variables What it can read.
 * @returns {boolean} Whether it holds.
 * @throws {Error} If the condition cannot be read.
 */
export function evaluateCondition(expression: string, variables: ConditionVariables): boolean {
    const text = expression.trim().replace(/^"(.*)"$/, '$1');
    if (!text) return true;
    const tokens = tokenize(text);
    let position = 0;
    const peek = () => tokens[position];
    const isOp = (value: string) => peek()?.kind === 'op' && (peek() as { value: string }).value === value;
    const expect = (value: string) => {
        if (!isOp(value)) throw new Error(`Expected "${value}" in the condition.`);
        position++;
    };

    type Value = string | number | boolean;
    const operand = (): Value => {
        const token = tokens[position++];
        if (!token) throw new Error('The condition ends too early.');
        if (token.kind === 'number' || token.kind === 'string') return token.value;
        if (token.kind === 'name') {
            let value = variables[token.value];
            if (isOp('[')) {
                position++;
                const index = operand();
                expect(']');
                value = Array.isArray(value) ? value[Number(index)] : value;
            } else if (Array.isArray(value)) {
                value = value[0];
            }
            return value ?? '';
        }
        if (token.kind === 'op' && token.value === '(') {
            const inner = orExpression();
            expect(')');
            return inner;
        }
        throw new Error(`Did not expect "${(token as { value: unknown }).value}" in the condition.`);
    };
    const comparison = (): Value => {
        const left = operand();
        const token = peek();
        if (token?.kind !== 'op' || !['=~', '!~', '==', '!=', '<', '>', '<=', '>='].includes(token.value)) return left;
        position++;
        if (token.value === '=~' || token.value === '!~') {
            const pattern = tokens[position++];
            if (pattern?.kind !== 'regex') throw new Error('Expected a regular expression after =~.');
            const matches = new RegExp(`^(?:${pattern.value})$`, 's').test(String(left));
            return token.value === '=~' ? matches : !matches;
        }
        const right = operand();
        const bothNumbers = typeof left === 'number' && typeof right === 'number';
        const a = bothNumbers ? left : String(left);
        const b = bothNumbers ? right : String(right);
        switch (token.value) {
            case '==': return bothNumbers ? Math.abs((a as number) - (b as number)) < 1e-9 : a === b;
            case '!=': return bothNumbers ? Math.abs((a as number) - (b as number)) >= 1e-9 : a !== b;
            case '<': return a < b;
            case '>': return a > b;
            case '<=': return a <= b;
            default: return a >= b;
        }
    };
    const unary = (): Value => {
        if (isOp('!') || isOp('not')) {
            position++;
            return !truthy(unary());
        }
        return comparison();
    };
    const truthy = (value: Value) => typeof value === 'boolean' ? value : typeof value === 'number' ? value !== 0 : value !== '';
    const andExpression = (): Value => {
        let value = unary();
        while (isOp('and') || isOp('&&')) {
            position++;
            const right = unary();
            value = truthy(value) && truthy(right);
        }
        return value;
    };
    function orExpression(): Value {
        let value = andExpression();
        while (isOp('or') || isOp('||')) {
            position++;
            const right = andExpression();
            value = truthy(value) || truthy(right);
        }
        return value;
    }

    const result = orExpression();
    if (position !== tokens.length) throw new Error('The condition has more after its end.');
    return truthy(result);
}

// ----- what to offer --------------------------------------------------------------------------

/**
 * The printer profiles of a bundle that the app can slice with: FFF printers with one extruder
 * (PrusaSlicer slices each of the app's tools on its own).
 *
 * @param {VendorBundle} bundle The bundle.
 * @returns {string[]} Their names, sorted.
 */
export function listPrinters(bundle: VendorBundle): string[] {
    const names: string[] = [];
    for (const name of bundle.sections.printer.keys()) {
        if (isAbstract(name)) continue;
        const printer = resolveProfile(bundle, 'printer', name)!;
        if ((printer.printer_technology ?? 'FFF') !== 'FFF') continue;
        if ((printer.nozzle_diameter ?? '').includes(',')) continue;
        names.push(name);
    }
    return names.sort((a, b) => a.localeCompare(b));
}

/**
 * The print or filament profiles of a bundle that suit a printer profile.
 *
 * @param {VendorBundle} bundle The bundle.
 * @param {'print' | 'filament'} type Which kind.
 * @param {string} printerName The printer profile.
 * @returns {string[]} Their names, sorted. Empty if the printer profile is not in the bundle.
 */
export function compatibleProfiles(bundle: VendorBundle, type: 'print' | 'filament', printerName: string): string[] {
    const printer = resolveProfile(bundle, 'printer', printerName);
    if (!printer) return [];
    const variables = printerVariables(printer);
    const names: string[] = [];
    for (const name of bundle.sections[type].keys()) {
        if (isAbstract(name)) continue;
        const profile = resolveProfile(bundle, type, name)!;
        const listed = (profile.compatible_printers ?? '').trim();
        let fits: boolean;
        if (listed && listed !== '""') {
            fits = listed.split(';').map(n => n.trim().replace(/^"(.*)"$/, '$1')).includes(printerName);
        } else {
            try {
                fits = evaluateCondition(profile.compatible_printers_condition ?? '', variables);
            } catch {
                fits = false; // a condition the app cannot read: better left out than offered wrongly
            }
        }
        if (fits) names.push(name);
    }
    return names.sort((a, b) => a.localeCompare(b));
}

/**
 * The settings of the chosen profiles, as one PrusaSlicer .ini: printer first, then print, then
 * filament, each overriding the one before where they overlap. Values are written exactly as the
 * bundle has them.
 *
 * @param {VendorBundle} bundle The bundle.
 * @param {{ printer?: string, print?: string, filament?: string }} chosen The profile names; empty ones are skipped.
 * @returns {string} The .ini text. Empty if no profile was chosen (or none is in the bundle).
 */
export function profileIni(bundle: VendorBundle, chosen: { printer?: string, print?: string, filament?: string }): string {
    const merged: ProfileValues = {};
    for (const type of ['printer', 'print', 'filament'] as const) {
        const name = chosen[type];
        if (!name) continue;
        Object.assign(merged, profileSettings(bundle, type, name) ?? {});
    }
    const lines = Object.entries(merged)
        .filter(([key, value]) => /^[a-z0-9_]+$/.test(key) && !/[\r\n]/.test(value))
        .map(([key, value]) => `${key} = ${value}`);
    return lines.length ? lines.join('\n') + '\n' : '';
}
