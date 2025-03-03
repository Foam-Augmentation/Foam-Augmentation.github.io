import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import initScene from './initScene';
import Printer from '../../printer/Printer'; 

/**
 * Initializes the Three.js renderer, scene (calls initiScene(), creates light and printer base), 
 * camera, orbit controls, and printer base objects (bounding box for printer).
 * called only once when the application is first loaded.
 *
 * @param container - The container element with a <canvas> for rendering.
 * @param {Printer} printer - An instance of the Printer class, providing machine dimensions.
 * @returns {{ renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, orbitControls: OrbitControls, printBaseObjects: THREE.Object3D[] }}
 */
export default function initRenderer(container: HTMLElement, printer: Printer) {
    // Retrieve the canvas element from the container.
    const canvas = container.querySelector("canvas");
    if (!canvas) throw new Error("Canvas element not found");

    // Create the WebGLRenderer with antialiasing and alpha transparency enabled.
    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true,
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x262626, 1);

    // Create a new Three.js Scene.
    const scene = new THREE.Scene();

    // Initialize the scene by adding lights and printer base objects.
    const printBaseObjects = initScene(scene, printer, [],
        { setLight: true, setPrintBase: true, });

    // Create a PerspectiveCamera with a 60° field of view.
    const camera = new THREE.PerspectiveCamera(
        60,
        window.innerWidth / window.innerHeight,
        0.1,
        10000
    );
    camera.position.set(
        printer.machine_depth,
        printer.machine_depth / 2,
        printer.machine_height / 2
    );
    camera.lookAt(0, 0, 0);
    camera.up.set(0, 0, 1);
    scene.add(camera);

    // Initialize OrbitControls to allow user interaction with the camera.
    const orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.25;

    return { renderer, scene, camera, orbitControls, printBaseObjects };
}
