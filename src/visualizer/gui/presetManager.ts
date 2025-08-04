// src/visualizer/gui/presetManager.ts
import Visualizer from '../Visualizer';
import initScene from '../renderer/initScene';

// can add more params
/**
 * Exports current settings to a simple text format
 */
export function exportPresetToFile(visualizer: Visualizer, filename: string = 'foam_printer_preset'): void {
  const lines = [
    `bedTemp ${visualizer.config.bedTemp}`,
    `nozzleLeftTemp ${visualizer.config.nozzleLeftTemp}`,
    `nozzleRightTemp ${visualizer.config.nozzleRightTemp}`,
    `machineDepth ${visualizer.config.machineDepth}`,
    `machineHeight ${visualizer.config.machineHeight}`,
    `dieSwelling ${visualizer.config.dieSwelling}`,
    `nozzleDiameter ${visualizer.config.nozzleDiameter}`,
    `filamentDiameter ${visualizer.config.filamentDiameter}`,
    `nozzleLength ${visualizer.config.nozzleLength}`,
    `printHeadMinX ${visualizer.config.printHeadMinX}`,
    `printHeadMinY ${visualizer.config.printHeadMinY}`,
    `printHeadMaxX ${visualizer.config.printHeadMaxX}`,
    `printHeadMaxY ${visualizer.config.printHeadMaxY}`,
    `useFermatSpirals ${visualizer.config.useFermatSpirals}`,
    `generateBoundary ${visualizer.config.generateBoundary}`,
    `purgeLine ${visualizer.config.purgeLine}`,
    `checkCollisions ${visualizer.config.checkCollisions}`,
    `startHStar ${visualizer.config.startHStar}`,
    `endHStar ${visualizer.config.endHStar}`,
    `startVStar ${visualizer.config.startVStar}`,
    `endVStar ${visualizer.config.endVStar}`,
    `deltaL ${visualizer.config.deltaL}`,
    `size ${visualizer.config.size}`,
    `toolMode ${visualizer.config.toolMode}`,
    `selectionMode ${visualizer.config.selectionMode}`,
    `selectModel ${visualizer.config.selectModel}`,
    `liveUpdate ${visualizer.config.liveUpdate}`,
    `selectWireframe ${visualizer.config.selectWireframe}`
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
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;    
    
    const parts = trimmed.split(' ');
    if (parts.length < 2) continue;
    
    const key = parts[0];
    const value = parts.slice(1).join(' '); 
    
    applyParameter(visualizer, key, value);
  }

  visualizer.syncConfigToPrinter();

  
  initScene(visualizer.scene, visualizer.printer, visualizer.printBaseObjects, { setLight: false, setPrintBase: true });
}

/**
 * Applies a single parameter to the visualizer
 */
function applyParameter(visualizer: Visualizer, key: string, value: string): void {
  switch (key) {
    case 'bedTemp':
      const bedTemp = parseFloat(value);
      visualizer.config.bedTemp = bedTemp;
      visualizer.printer.material_bed_temperature = bedTemp;
      break;
      
    case 'nozzleLeftTemp':
      const nozzleLeftTemp = parseFloat(value);
      visualizer.config.nozzleLeftTemp = nozzleLeftTemp;
      visualizer.printer.print_temp_left_extruder = nozzleLeftTemp;
      break;
      
    case 'nozzleRightTemp':
      const nozzleRightTemp = parseFloat(value);
      visualizer.config.nozzleRightTemp = nozzleRightTemp;
      visualizer.printer.print_temp_right_extruder = nozzleRightTemp;
      break;
      
    case 'machineDepth':
      const machineDepth = parseFloat(value);
      visualizer.config.machineDepth = machineDepth;
      visualizer.printer.machine_depth = machineDepth;
      break;
      
    case 'machineHeight':
      const machineHeight = parseFloat(value);
      visualizer.config.machineHeight = machineHeight;
      visualizer.printer.machine_height = machineHeight;
      break;
      
    case 'dieSwelling':
      const dieSwelling = parseFloat(value);
      visualizer.config.dieSwelling = dieSwelling;
      visualizer.printer.dieSwelling = dieSwelling;
      break;
      
    case 'nozzleDiameter':
      const nozzleDiameter = parseFloat(value);
      visualizer.config.nozzleDiameter = nozzleDiameter;
      visualizer.printer.nozzleDiameter = nozzleDiameter;
      break;
      
    case 'filamentDiameter':
      const filamentDiameter = parseFloat(value);
      visualizer.config.filamentDiameter = filamentDiameter;
      visualizer.printer.diameter_filament = filamentDiameter;
      break;
      
    case 'nozzleLength':
      const nozzleLength = parseFloat(value);
      visualizer.config.nozzleLength = nozzleLength;
      visualizer.printer.nozzleLength = nozzleLength;
      break;
      
    case 'printHeadMinX':
      const printHeadMinX = parseFloat(value);
      visualizer.config.printHeadMinX = printHeadMinX;
      visualizer.printer.printHeadDims.min.setX(printHeadMinX);
      break;
      
    case 'printHeadMinY':
      const printHeadMinY = parseFloat(value);
      visualizer.config.printHeadMinY = printHeadMinY;
      visualizer.printer.printHeadDims.min.setY(printHeadMinY);
      break;
      
    case 'printHeadMaxX':
      const printHeadMaxX = parseFloat(value);
      visualizer.config.printHeadMaxX = printHeadMaxX;
      visualizer.printer.printHeadDims.max.setX(printHeadMaxX);
      break;
      
    case 'printHeadMaxY':
      const printHeadMaxY = parseFloat(value);
      visualizer.config.printHeadMaxY = printHeadMaxY;
      visualizer.printer.printHeadDims.max.setY(printHeadMaxY);
      break;
      
    case 'useFermatSpirals':
      const useFermatSpirals = value.toLowerCase() === 'true';
      visualizer.config.useFermatSpirals = useFermatSpirals;
      visualizer.printer.useFermatSpirals = useFermatSpirals;
      break;
      
    case 'generateBoundary':
      const generateBoundary = value.toLowerCase() === 'true';
      visualizer.config.generateBoundary = generateBoundary;
      visualizer.printer.generateBoundary = generateBoundary;
      break;
      
    case 'purgeLine':
      const purgeLine = value.toLowerCase() === 'true';
      visualizer.config.purgeLine = purgeLine;
      visualizer.printer.purgeLine = purgeLine;
      break;
      
    case 'checkCollisions':
      const checkCollisions = value.toLowerCase() === 'true';
      visualizer.config.checkCollisions = checkCollisions;
      visualizer.printer.checkCollisions = checkCollisions;
      break;
      
    case 'startHStar':
      visualizer.config.startHStar = parseFloat(value);
      break;
      
    case 'endHStar':
      visualizer.config.endHStar = parseFloat(value);
      break;
      
    case 'startVStar':
      visualizer.config.startVStar = parseFloat(value);
      break;
      
    case 'endVStar':
      visualizer.config.endVStar = parseFloat(value);
      break;
      
    case 'deltaL':
      visualizer.config.deltaL = parseFloat(value);
      break;
      
    case 'size':
      visualizer.config.size = parseFloat(value);
      break;
      
    case 'toolMode':
      visualizer.config.toolMode = value;
      break;
      
    case 'selectionMode':
      visualizer.config.selectionMode = value;
      break;
      
    case 'selectModel':
      visualizer.config.selectModel = value.toLowerCase() === 'true';
      break;
      
    case 'liveUpdate':
      visualizer.config.liveUpdate = value.toLowerCase() === 'true';
      break;
      
    case 'selectWireframe':
      visualizer.config.selectWireframe = value.toLowerCase() === 'true';
      break;
      
    default:
      console.warn(`Unknown parameter: ${key}`);
      break;
  }
}