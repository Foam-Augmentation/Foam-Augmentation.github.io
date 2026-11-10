import { describe, expect, it } from 'vitest';
import {
  ExtruderValues,
  MAX_EXTRUDERS,
  ModelTarget,
  PRESET_VERSION,
  SettingsTarget,
  applyPresetToModel,
  applyPresetToSettings,
  hasModelSection,
  parsePreset,
  serializePreset,
} from './presetFormat';
import { EXTRUDER_SPECS, INITIAL_SPECS, MODEL_SPECS, SETTING_SPECS } from './paramSpecs';

/** A default extruder, mirroring createDefaultExtruder() in Printer.ts. */
function makeExtruder(): ExtruderValues {
  return {
    nozzleDiameter: 0.4,
    nozzleLength: 4.5,
    dieSwelling: 1.0,
    printHead_speed_when_free_move: 1000,
    print_temp_extruder: 230,
    idle_temp_extruder: 70,
    color: 0x00ff00,
  };
}

/** Settings shaped like Visualizer.config, with its defaults. */
function makeSettings(): SettingsTarget {
  return {
    toolMode: 'lasso',
    selectionMode: 'centroid-visible',
    liveUpdate: false,
    selectModel: false,
    selectWireframe: false,
    bedTemp: 60,
    extruders: [makeExtruder(), { ...makeExtruder(), print_temp_extruder: 240 }],
    machineDepth: 250,
    machineDepthY: 210,
    machineHeight: 220,
    filamentDiameter: 1.75,
    useFermatSpirals: false,
    generateBoundary: false,
    purgeLine: true,
    checkCollisions: false,
    printHeadMinX: -40,
    printHeadMinY: -15,
    printHeadMaxX: 35,
    printHeadMaxY: 70,
    bedLeveling: false,
    testSweep: false,
    multipleToolheads: true,
    purgeTower: true,
    startHStarTest: 5,
    endHStarTest: 10,
    startVStarTest: 0.15,
    endVStarTest: 0.3,
    testDeltaL: 3,
    testSize: 15,
  };
}

/** A model shaped like EverydayModel, with the defaults from modelLoader.ts. */
function makeModel(): ModelTarget & { toolpathConfig: Record<string, unknown>; initialConfig: Record<string, unknown> } {
  const toolpathConfig = {
    deltaZ: 1.16, gridSize: 1, deltaL: 1.7, deltaLEnd: 1.7, vStar: 0.15, vStarEnd: 0.15,
    hStar: 9, hStarEnd: 9, edot: 35, initialFoamLayerCount: 3, middleSenseLayerCount: 3,
    finalFoamLayerCount: 1, bumpSpacingX: 15, bumpSpacingY: 15, bumpScale: 1,
    generateBumps: false, curveAugment: false, steepnessThreshold: 75, flatLayerZOffset: 5,
    additionalCurveLayers: 3, senseDeltaLEnd: 1.7, senseDeltaZ: 1.16, senseHStar: 9,
    senseHStarEnd: 9, senseVStar: 0.16, SenseVStarEnd: 0.15, senseDeltaL: 1.7, senseEdot: 35,
  };
  return {
    name: 'bottle.stl',
    toolpathConfig,
    // The sense fields of the initial config are zero in the app and are not part of a preset.
    initialConfig: {
      ...toolpathConfig, edot: 200, initialFoamLayerCount: 0,
      senseDeltaLEnd: 0, senseDeltaZ: 0, senseHStar: 0, senseHStarEnd: 0,
      senseVStar: 0, SenseVStarEnd: 0, senseDeltaL: 0, senseEdot: 0,
    },
    initialOffset: 0,
  };
}

describe('serializePreset', () => {
  it('writes a version line and every parameter', () => {
    const text = serializePreset(makeSettings(), makeModel());
    const keys = text.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(' ')[0]);

    expect(keys[0]).toBe('presetVersion');
    for (const key of Object.keys(SETTING_SPECS)) expect(keys).toContain(key);
    for (const key of Object.keys(MODEL_SPECS)) expect(keys).toContain(key);
    for (const key of Object.keys(INITIAL_SPECS)) expect(keys).toContain(`initial.${key}`);
    for (const key of Object.keys(EXTRUDER_SPECS)) {
      expect(keys).toContain(`extruder0.${key}`);
      expect(keys).toContain(`extruder1.${key}`);
    }
    expect(keys).toContain('initialOffset');
    expect(keys).toContain('extruderCount');
  });

  it('leaves the model section out when there is no model', () => {
    const text = serializePreset(makeSettings(), null);
    const preset = parsePreset(text);
    expect(preset.errors).toEqual([]);
    expect(hasModelSection(preset)).toBe(false);
    expect(text).not.toContain('hStar ');
  });

  it('keeps a model name with line breaks on one comment line', () => {
    const model = makeModel();
    model.name = 'evil\nbedTemp 999';
    const preset = parsePreset(serializePreset(makeSettings(), model));
    expect(preset.errors).toEqual([]);
    expect(preset.settings.bedTemp).toBe(60);
  });
});

describe('round trip', () => {
  it('restores every setting, extruder and model parameter', () => {
    const settings = makeSettings();
    const model = makeModel();

    // Move every value off its default so a dropped key cannot go unnoticed.
    settings.bedTemp = 85;
    settings.machineDepth = 360;
    settings.toolMode = 'box';
    settings.selectionMode = 'intersection';
    settings.purgeLine = false;
    settings.testSweep = true;
    settings.printHeadMinX = -12.5;
    settings.extruders.push({ ...makeExtruder(), nozzleDiameter: 0.6, color: 0xff0000 });
    settings.extruders[0].idle_temp_extruder = 90;
    Object.assign(model.toolpathConfig, {
      deltaZ: 0.8, deltaLEnd: 2.5, senseHStar: 4, SenseVStarEnd: 0.4, senseEdot: 60,
      curveAugment: true, generateBumps: true, steepnessThreshold: 42.5,
      flatLayerZOffset: 7, additionalCurveLayers: 5, middleSenseLayerCount: 2,
    });
    Object.assign(model.initialConfig, { hStar: 3, edot: 150, initialFoamLayerCount: 2 });
    model.initialOffset = 4.25;

    const preset = parsePreset(serializePreset(settings, model));
    expect(preset.errors).toEqual([]);
    expect(preset.warnings).toEqual([]);
    expect(preset.version).toBe(PRESET_VERSION);

    const restoredSettings = makeSettings();
    const restoredModel = makeModel();
    applyPresetToSettings(preset, restoredSettings, makeExtruder);
    applyPresetToModel(preset, restoredModel);

    expect(restoredSettings).toEqual(settings);
    expect(restoredModel).toEqual(model);
  });

  it('shrinks the extruder list when the preset has fewer extruders', () => {
    const one = makeSettings();
    one.extruders.pop();
    const preset = parsePreset(serializePreset(one));

    const target = makeSettings();
    applyPresetToSettings(preset, target, makeExtruder);
    expect(target.extruders).toHaveLength(1);
  });
});

describe('parsePreset', () => {
  it('reads a version 1 file (no version line, no initial-layer section)', () => {
    const preset = parsePreset([
      'bedTemp 70',
      'purgeLine false',
      'extruderCount 1',
      'extruder0.nozzleDiameter 0.6',
      'toolMode box',
      'hStar 7',
      'gridSize 2',
      'bumpScale 1.5',
    ].join('\n'));

    expect(preset.errors).toEqual([]);
    expect(preset.version).toBe(1);
    expect(preset.settings).toEqual({ bedTemp: 70, purgeLine: false, toolMode: 'box' });
    expect(preset.extruderCount).toBe(1);
    expect(preset.extruders).toEqual({ 0: { nozzleDiameter: 0.6 } });
    expect(preset.model).toEqual({ hStar: 7, gridSize: 2, bumpScale: 1.5 });
    expect(hasModelSection(preset)).toBe(true);
  });

  it('accepts Windows line endings, blank lines and comments', () => {
    const preset = parsePreset('# comment\r\n\r\nbedTemp 55\r\n   hStar   8  \r\n');
    expect(preset.errors).toEqual([]);
    expect(preset.settings.bedTemp).toBe(55);
    expect(preset.model.hStar).toBe(8);
  });

  it('rejects values that are not numbers', () => {
    for (const bad of ['bedTemp abc', 'bedTemp NaN', 'bedTemp Infinity', 'bedTemp', 'hStar 1e999']) {
      const preset = parsePreset(bad);
      expect(preset.errors, bad).toHaveLength(1);
      expect(preset.settings.bedTemp, bad).toBeUndefined();
    }
  });

  it('rejects values outside the allowed range', () => {
    expect(parsePreset('bedTemp 500').errors).toHaveLength(1);
    expect(parsePreset('deltaZ 0').errors).toHaveLength(1);
    expect(parsePreset('gridSize 0').errors).toHaveLength(1);
    expect(parsePreset('initial.deltaZ 0').errors).toHaveLength(1);
    expect(parsePreset('extruder0.nozzleDiameter 0').errors).toHaveLength(1);
    expect(parsePreset('initialOffset -1').errors).toHaveLength(1);
  });

  it('rejects fractional values for whole-number parameters', () => {
    expect(parsePreset('initialFoamLayerCount 2.5').errors).toHaveLength(1);
    expect(parsePreset('initialFoamLayerCount 2').errors).toEqual([]);
  });

  it('rejects unknown enum values and non-boolean flags', () => {
    expect(parsePreset('toolMode circle').errors).toHaveLength(1);
    expect(parsePreset('selectionMode everything').errors).toHaveLength(1);
    expect(parsePreset('purgeLine yes').errors).toHaveLength(1);
    expect(parsePreset('purgeLine TRUE').settings.purgeLine).toBe(true);
  });

  it('ignores keys that are not parameters, with a warning', () => {
    const preset = parsePreset([
      'extruders [object Object]',
      'currentSelectedModel null',
      'constructor 1',
      'toString 2',
      'extruder0.madeUp 3',
      'initial.senseHStar 4',
      'bedTemp 65',
    ].join('\n'));

    expect(preset.errors).toEqual([]);
    expect(preset.warnings).toHaveLength(6);
    expect(preset.settings).toEqual({ bedTemp: 65 });
    expect(preset.model).toEqual({});
  });

  it('rejects a bad extruder count and extruders beyond the declared count', () => {
    expect(parsePreset('extruderCount 0').errors).toHaveLength(1);
    expect(parsePreset('extruderCount 1.5').errors).toHaveLength(1);
    expect(parsePreset(`extruderCount ${MAX_EXTRUDERS + 1}`).errors).toHaveLength(1);
    expect(parsePreset('extruderCount 1\nextruder1.nozzleDiameter 0.4').errors).toHaveLength(1);
  });

  it('rejects a file from a newer version of the format', () => {
    expect(parsePreset(`presetVersion ${PRESET_VERSION + 1}\nbedTemp 60`).errors).toHaveLength(1);
    expect(parsePreset('presetVersion two').errors).toHaveLength(1);
  });

  it('reports every bad line, with its line number', () => {
    const preset = parsePreset('bedTemp 60\nbedTemp abc\nhStar -1');
    expect(preset.errors).toHaveLength(2);
    expect(preset.errors[0]).toContain('line 2');
    expect(preset.errors[1]).toContain('line 3');
  });
});

describe('applyPresetToSettings', () => {
  it('leaves the extruder count alone when the preset does not declare one', () => {
    const preset = parsePreset('extruder0.print_temp_extruder 200\nextruder5.print_temp_extruder 210');
    expect(preset.errors).toEqual([]);

    const target = makeSettings();
    applyPresetToSettings(preset, target, makeExtruder);
    expect(target.extruders).toHaveLength(2);
    expect(target.extruders[0].print_temp_extruder).toBe(200);
  });

  it('creates extruders from the factory when there is none to copy', () => {
    const preset = parsePreset('extruderCount 2\nextruder1.nozzleDiameter 0.8');
    const target = makeSettings();
    target.extruders.length = 0;
    applyPresetToSettings(preset, target, makeExtruder);
    expect(target.extruders).toHaveLength(2);
    expect(target.extruders[0]).toEqual(makeExtruder());
    expect(target.extruders[1].nozzleDiameter).toBe(0.8);
  });
});
