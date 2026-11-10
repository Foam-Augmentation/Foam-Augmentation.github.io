import 'tippy.js/dist/tippy.css';
import './style.css';

import Visualizer from './visualizer/Visualizer';
import Printer from './printer/Printer';


const myPrinter = new Printer();
const myVisualizer = new Visualizer('myCanvasContainer', myPrinter);
myVisualizer.render();
