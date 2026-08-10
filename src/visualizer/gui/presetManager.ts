// src/visualizer/gui/presetManager.ts
import Visualizer from '../Visualizer';
import initScene from '../renderer/initScene';
import { EverydayModel, ToolpathConfig } from '../types/modelTypes';
import { Extruder, createDefaultExtruder } from '../../printer/Printer';

/** Extruder fields written out by the preset, one line each. */
const EXTRUDER_KEYS: (keyof Extruder)[] = [
  'nozzleDiameter',
  'nozzleLength',
  'dieSwelling',
  'printHead_speed_when_free_move',
  'print_temp_extruder',
  'idle_temp_extruder',
  'color'
];

/**
 * Serializes every extruder as `extruder<i>.<field> <value>` lines, preceded by the count
 * so the importer knows how many extruders to create.
 *
 * @param visualizer - The Visualizer instance.
 * @returns The preset lines describing the extruders.
 */
function serializeExtruders(visualizer: Visualizer): string[] {
  const lines = [`extruderCount ${visualizer.config.extruders.length}`];
  visualizer.config.extruders.forEach((extruder, index) => {
    EXTRUDER_KEYS.forEach(key => {
      lines.push(`extruder${index}.${key} ${extruder[key]}`);
    });
  });
  return lines;
}

/**
 * Applies an extruder-related preset line.
 * Handles both `extruderCount` (which resizes the extruder list) and
 * `extruder<i>.<field>` (which sets a single field).
 *
 * @param visualizer - The Visualizer instance.
 * @param key - The preset key.
 * @param rawValue - The raw string value from the preset file.
 * @returns True if the key was an extruder key and was handled.
 */
function applyExtruderParameter(visualizer: Visualizer, key: string, rawValue: string): boolean {
  if (key === 'extruderCount') {
    const count = Number(rawValue);
    if (!isFinite(count) || count < 1) {
      console.warn(`Invalid extruderCount "${rawValue}"`);
      return true;
    }
    const extruders = visualizer.config.extruders;
    while (extruders.length > count) extruders.pop();
    while (extruders.length < count) {
      const last = extruders[extruders.length - 1];
      extruders.push(last ? { ...last } : createDefaultExtruder());
    }
    return true;
  }

  const match = key.match(/^extruder(\d+)\.(.+)$/);
  if (!match) return false;

  const index = Number(match[1]);
  const field = match[2] as keyof Extruder;
  if (EXTRUDER_KEYS.indexOf(field) === -1) {
    console.warn(`Unknown extruder field "${field}"`);
    return true;
  }
  // extruderCount is written before the per-extruder lines, so the slot should already exist.
  if (index >= visualizer.config.extruders.length) {
    console.warn(`Preset references extruder ${index} but only ${visualizer.config.extruders.length} exist`);
    return true;
  }

  const value = Number(rawValue);
  if (!isFinite(value)) {
    console.warn(`Invalid value "${rawValue}" for ${key}`);
    return true;
  }
  visualizer.config.extruders[index][field] = value;
  return true;
}

// can add more params
/**
 * Exports current settings to a simple text format
 */
export function exportPresetToFile(visualizer: Visualizer, filename: string = 'foam_printer_preset'): void {
  if (!visualizer.currentSelectedModel) {
    console.warn("No Selected Model");
  }
  const config = visualizer.currentSelectedModel!.toolpathConfig;
  const lines = [
    `bedTemp ${visualizer.config.bedTemp}`,
    `machineDepth ${visualizer.config.machineDepth}`,
    `machineDepthY ${visualizer.config.machineDepthY}`,
    `machineHeight ${visualizer.config.machineHeight}`,
    `filamentDiameter ${visualizer.config.filamentDiameter}`,
    `printHeadMinX ${visualizer.config.printHeadMinX}`,
    `printHeadMinY ${visualizer.config.printHeadMinY}`,
    `printHeadMaxX ${visualizer.config.printHeadMaxX}`,
    `printHeadMaxY ${visualizer.config.printHeadMaxY}`,
    `useFermatSpirals ${visualizer.config.useFermatSpirals}`,
    `generateBoundary ${visualizer.config.generateBoundary}`,
    `purgeLine ${visualizer.config.purgeLine}`,
    `checkCollisions ${visualizer.config.checkCollisions}`,
    `bedLeveling ${visualizer.config.bedLeveling}`,
    `testSweep ${visualizer.config.testSweep}`,
    `multipleToolheads ${visualizer.config.multipleToolheads}`,
    ...serializeExtruders(visualizer),
    `startHStarTest ${visualizer.config.startHStarTest}`,
    `endHStarTest ${visualizer.config.endHStarTest}`,
    `startVStarTest ${visualizer.config.startVStarTest}`,
    `endVStarTest ${visualizer.config.endVStarTest}`,
    `testDeltaL ${visualizer.config.testDeltaL}`,
    `testSize ${visualizer.config.testSize}`,
    `toolMode ${visualizer.config.toolMode}`,
    `selectionMode ${visualizer.config.selectionMode}`,
    `selectModel ${visualizer.config.selectModel}`,
    `liveUpdate ${visualizer.config.liveUpdate}`,
    `selectWireframe ${visualizer.config.selectWireframe}`,
    `hStar ${config.hStar}`,
    `hStarEnd ${config.hStarEnd}`,
    `vStar ${config.vStar}`,
    `vStarEnd ${config.vStarEnd}`,
    `deltaZ ${config.deltaZ}`,
    `deltaL ${config.deltaL}`,
    `edot ${config.edot}`,
    `gridSize ${config.gridSize}`,
    `initialFoamLayerCount ${config.initialFoamLayerCount}`,
    `bumpSpacingX ${config.bumpSpacingX}`,
    `bumpSpacingY ${config.bumpSpacingY}`,
    `bumpScale ${config.bumpScale}`,
  ];
  
  const content = lines.join('\n');
  
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  URL.revokeObjectURL(url);
  console.log(`Preset exported to ${filename}.txt`);
}



export function importPresetFromFile(visualizer: Visualizer): Promise<string | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt';
      
      input.onchange = (event: Event) => {
        const target = event.target as HTMLInputElement;
        const file = target.files?.[0];
        
        if (!file) {
          console.warn('No file selected');
          resolve(null);
          return;
        }
        
        const reader = new FileReader();
        reader.onload = (e: ProgressEvent<FileReader>) => {
          try {
            const content = e.target?.result as string;
            parseAndApplyPreset(visualizer, content);
            console.log('Preset imported and applied successfully');
            resolve(file.name);
            
          } catch (error) {
            console.error('Error importing preset:', error);
            alert('Error importing preset. Please check the file format.');
            resolve(null);
          }
        };
        
        reader.readAsText(file);
      };
      
      input.click();
    });
  }

/**
 * Parses text content and applies settings to visualizer
 */
function parseAndApplyPreset(visualizer: Visualizer, content: string): void {
  if (!visualizer.currentSelectedModel) {
    console.warn("No Selected Model");
  }
  const modelObj = visualizer.currentSelectedModel!;

  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;    
    
    const parts = trimmed.split(' ');
    if (parts.length < 2) continue;
    
    const key = parts[0];
    const value = parts.slice(1).join(' '); 
    
    if (applyExtruderParameter(visualizer, key, value)) {
      continue;
    } else if (isVisualizerKey(visualizer, key)) {
      applyVisualizerParameter(visualizer, key, value);
    } else if (isModelKey(modelObj.toolpathConfig, key)) {
      applyModelParameter(modelObj.toolpathConfig, key, value);
    }
  }

  visualizer.syncConfigToPrinter();

  
  initScene(visualizer.scene, visualizer.printer, visualizer.printBaseObjects, { setLight: false, setPrintBase: true });
}

function isVisualizerKey(
  visualizer: Visualizer,
  key: string
): key is keyof Visualizer['config'] {
  return key in visualizer.config;
}

function isModelKey(
  config: ToolpathConfig,
  key: string
): key is keyof ToolpathConfig {
  return key in config;
}

/**
 * Applies a single parameter to the visualizer
 */
function applyVisualizerParameter<K extends keyof Visualizer['config']>(
  visualizer: Visualizer,
  key: K,
  rawValue: string
): void {
  const current = visualizer.config[key];
  let newVal: string | number | boolean;

  if (typeof current === 'number') {
    const n = Number(rawValue);
    newVal = n;
  } else if (typeof current === 'boolean') {
    const l = rawValue.trim().toLowerCase();
    if (l === 'true') {
      newVal = true;
    } else if (l === 'false') {
      newVal = false;
    } else {
      console.warn("Invalid boolean");
      newVal = false;
    }
  } else {
    newVal = rawValue;
  }

  visualizer.config[key] = newVal as Visualizer['config'][K];
}

/**
 * Applies a single parameter to the model config
 */
function applyModelParameter<K extends keyof ToolpathConfig>(
  toolpathConfig: ToolpathConfig,
  key: K,
  value: string,
): void {
  const current = toolpathConfig[key];
  let newVal: number | boolean;

  if (typeof current === 'number') {
    const n = Number(value);
    newVal = n;
  } else if (typeof current === 'boolean') {
    const l = value.trim().toLowerCase();
    if (l === 'true') {
      newVal = true;
    } else if (l === 'false') {
      newVal = false;
    } else {
      console.warn("Invalid boolean");
      newVal = false;
    }
  } else {
    console.warn("Unable to find correct type");
    newVal = 0;
  }

  toolpathConfig[key] = newVal as ToolpathConfig[K];
}