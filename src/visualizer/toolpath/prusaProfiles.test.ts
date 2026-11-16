import { describe, expect, it } from 'vitest';
import {
    compatibleProfiles,
    evaluateCondition,
    listPrinters,
    missingProfiles,
    parseVendorBundle,
    printerMachine,
    printerVariables,
    profileChoices,
    profileIni,
    resolveProfile,
    slicingPrinter,
} from './prusaProfiles';

const BUNDLE = String.raw`
# A small bundle shaped like PrusaResearch.ini.
[vendor]
name = Prusa Research

[printer_model:XLIS]
name = Original Prusa XL Input Shaper

[printer:*common*]
printer_technology = FFF
retract_length = 2
printer_notes = "Don't remove the following keywords! These keywords are used in the \\"compatible printer\\" condition of the print and filament profiles:\nPRINTER_VENDOR_PRUSA3D\n"

[printer:*XLIS*]
inherits = *common*
retract_length = 0.8
printer_model = XLIS
printer_notes = "Keywords:\nPRINTER_VENDOR_PRUSA3D\nPRINTER_MODEL_XLIS\n"
bed_shape = 0x0,360x0,360x360,0x360
max_print_height = 360

[printer:Original Prusa XL Input Shaper 0.4 nozzle]
inherits = *XLIS*
printer_variant = 0.4
nozzle_diameter = 0.4

[printer:Original Prusa XL - 5T Input Shaper 0.4 nozzle]
inherits = *XLIS*
printer_model = XL5IS
printer_variant = 0.4
nozzle_diameter = 0.4,0.4,0.4,0.4,0.4

[printer:Original Prusa MK4 0.4 nozzle]
inherits = *common*
printer_model = MK4
bed_shape = 0x-4,250x-4,250x210,0x210
max_print_height = 220
nozzle_diameter = 0.4

[printer:Original Prusa XL Input Shaper 0.6 nozzle]
inherits = *XLIS*
nozzle_diameter = 0.6

[printer:Original Prusa XL - 2T Input Shaper 0.4 nozzle]
inherits = *XLIS*
nozzle_diameter = 0.4,0.4

[printer:Original Prusa SL1]
printer_technology = SLA

[print:*common*]
layer_height = 0.2
compatible_printers_condition = printer_notes=~/.*PRINTER_VENDOR_PRUSA3D.*/

[print:0.20mm SPEED @XLIS 0.4]
inherits = *common*
compatible_printers_condition = printer_notes=~/.*PRINTER_MODEL_XLIS.*/ and nozzle_diameter[0]==0.4

[print:0.30mm DRAFT @XLIS 0.6]
inherits = *common*
layer_height = 0.3
compatible_printers_condition = printer_model=="XLIS" and nozzle_diameter[0]==0.6

[print:Listed only]
compatible_printers = "Original Prusa XL Input Shaper 0.6 nozzle"

[filament:*PLA*]
temperature = 215
start_filament_gcode = "M572 S{if nozzle_diameter[0]==0.4}0.036{else}0{endif} ; Filament gcode"
compatible_printers_condition = nozzle_diameter[0]!=0.8 and !(printer_notes=~/.*PRINTER_MODEL_MK3.*/)

[filament:Generic PLA @XLIS]
inherits = *PLA*
renamed_from = "Generic PLA"
`;

const bundle = parseVendorBundle(BUNDLE);
const xl04 = 'Original Prusa XL Input Shaper 0.4 nozzle';

describe('parseVendorBundle and resolveProfile', () => {
    it('reads the printer, print and filament sections and skips the rest', () => {
        expect([...bundle.sections.printer.keys()]).toHaveLength(8);
        expect(bundle.sections.print.size).toBe(4);
        expect(bundle.sections.filament.size).toBe(2);
    });

    it('fills in what a profile inherits, its own settings last', () => {
        const printer = resolveProfile(bundle, 'printer', xl04)!;
        expect(printer.retract_length).toBe('0.8');
        expect(printer.printer_technology).toBe('FFF');
        expect(printer.nozzle_diameter).toBe('0.4');
        expect(resolveProfile(bundle, 'printer', 'nope')).toBeUndefined();
    });
});

describe('evaluateCondition', () => {
    const vars = printerVariables(resolveProfile(bundle, 'printer', xl04)!);

    it('matches regular expressions across the whole value', () => {
        expect(evaluateCondition('printer_notes=~/.*PRINTER_MODEL_XLIS.*/', vars)).toBe(true);
        expect(evaluateCondition('printer_notes=~/PRINTER_MODEL_XLIS/', vars)).toBe(false);
        expect(evaluateCondition('printer_notes!~/.*MK3.*/', vars)).toBe(true);
    });

    it('compares numbers, strings and list items, with and, or, not and brackets', () => {
        expect(evaluateCondition('nozzle_diameter[0]==0.4 and printer_model=="XLIS"', vars)).toBe(true);
        expect(evaluateCondition('nozzle_diameter[0]!=0.4 or num_extruders>1', vars)).toBe(false);
        expect(evaluateCondition('!(nozzle_diameter[0]>=0.6) && not printer_model=="MK4"', vars)).toBe(true);
        expect(evaluateCondition('', vars)).toBe(true);
    });

    it('refuses what it cannot read', () => {
        expect(() => evaluateCondition('nozzle_diameter[0]== and', vars)).toThrow();
    });
});

describe('what to offer', () => {
    const xl5 = 'Original Prusa XL - 5T Input Shaper 0.4 nozzle';

    it('lists the one-tool FFF printers, and the multi-tool XLs', () => {
        expect(listPrinters(bundle)).toEqual([
            'Original Prusa MK4 0.4 nozzle',
            xl5,
            'Original Prusa XL Input Shaper 0.4 nozzle',
            'Original Prusa XL Input Shaper 0.6 nozzle',
        ]);
    });

    it('slices a multi-tool XL as the single-tool XL with the same nozzle, and nothing else with several extruders', () => {
        expect(slicingPrinter(bundle, xl5)).toBe(xl04);
        expect(slicingPrinter(bundle, xl04)).toBe(xl04);
        // Several extruders but no single-tool sibling, like an MMU.
        expect(slicingPrinter(bundle, 'Original Prusa XL - 2T Input Shaper 0.4 nozzle')).toBeUndefined();
        expect(slicingPrinter(bundle, 'no such printer')).toBeUndefined();
    });

    it('offers a multi-tool XL what suits the single-tool XL', () => {
        expect(profileChoices(bundle, xl5).prints).toEqual(profileChoices(bundle, xl04).prints);
        expect(profileChoices(bundle, xl5).filaments).toEqual(['Generic PLA @XLIS']);
        expect(profileChoices(bundle, '')).toMatchObject({ prints: [], filaments: [] });
    });

    it('offers the print and filament profiles that suit the printer', () => {
        expect(compatibleProfiles(bundle, 'print', xl04)).toEqual(['0.20mm SPEED @XLIS 0.4']);
        expect(compatibleProfiles(bundle, 'print', 'Original Prusa XL Input Shaper 0.6 nozzle')).toEqual(['0.30mm DRAFT @XLIS 0.6', 'Listed only']);
        expect(compatibleProfiles(bundle, 'filament', xl04)).toEqual(['Generic PLA @XLIS']);
        expect(compatibleProfiles(bundle, 'print', 'no such printer')).toEqual([]);
    });
});

describe('profileIni', () => {
    it('writes printer, print and filament settings in that order, without the ones that only describe a profile', () => {
        const ini = profileIni(bundle, { printer: xl04, print: '0.20mm SPEED @XLIS 0.4', filament: 'Generic PLA @XLIS' });
        const lines = ini.trim().split('\n');
        expect(lines).toContain('retract_length = 0.8');
        expect(lines).toContain('layer_height = 0.2');
        expect(lines).toContain('start_filament_gcode = "M572 S{if nozzle_diameter[0]==0.4}0.036{else}0{endif} ; Filament gcode"');
        expect(lines.some(l => /^(inherits|compatible_printers_condition|renamed_from) =/.test(l))).toBe(false);
    });

    it('is empty when nothing is chosen', () => {
        expect(profileIni(bundle, {})).toBe('');
    });

    it('writes a multi-tool XL as the single-tool XL', () => {
        const lines = profileIni(bundle, { printer: 'Original Prusa XL - 5T Input Shaper 0.4 nozzle' }).trim().split('\n');
        expect(lines).toContain('nozzle_diameter = 0.4');
        expect(lines).toContain('printer_model = XLIS');
    });

    it('names the chosen profiles the bundle does not have', () => {
        expect(missingProfiles(bundle, { printer: xl04, print: 'Old print', filament: '' })).toEqual([{ type: 'print', name: 'Old print' }]);
    });
});

describe('printerMachine', () => {
    it('reads the bed, the height and the nozzles, and which G-code the app writes for it', () => {
        expect(printerMachine(bundle, xl04)).toEqual({ bed: { x: 360, y: 360, height: 360 }, nozzles: [0.4], family: 'XL' });
        expect(printerMachine(bundle, 'Original Prusa XL - 5T Input Shaper 0.4 nozzle')!.nozzles).toEqual([0.4, 0.4, 0.4, 0.4, 0.4]);
        // The bed's size, wherever its origin is.
        expect(printerMachine(bundle, 'Original Prusa MK4 0.4 nozzle')).toEqual({ bed: { x: 250, y: 214, height: 220 }, nozzles: [0.4], family: null });
    });

    it('gives nothing for a printer it cannot read', () => {
        expect(printerMachine(bundle, 'Original Prusa SL1')).toBeUndefined();
        expect(printerMachine(bundle, 'no such printer')).toBeUndefined();
    });
});
