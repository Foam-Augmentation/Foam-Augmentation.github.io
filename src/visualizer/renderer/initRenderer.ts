import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import initScene from './initScene';
import Printer from '../../printer/Printer'; 
import { ViewCube } from '../gui/ViewCube';

/**
 * Initializes the Three.js renderer, scene (calls initiScene(), creates light and printer base), 
 * camera, orbit controls, and printer base objects (bounding box for printer).
 * called only once when the application is first loaded.
 *
 * @param container - The container element with a <canvas> for rendering.
 * @param {Printer} printer - An instance of the Printer class, providing machine dimensions.
 * The caller owns the render loop (it must also call `viewCube.render()` each frame) and is
 * responsible for resizing: see `resizeRenderer`.
 *
 * @returns {{ renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, orbitControls: OrbitControls, printBaseObjects: THREE.Object3D[], viewCube: ViewCube }}
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
    // Render at the display's pixel density (capped at 2 to keep large windows fast).
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

    // Create the cube view for the camera
    const viewCube = new ViewCube(camera, orbitControls, {
        size: 120,
        position: { top: 20, right: 20 },
        opacity: 0.9
    });

    return { renderer, scene, camera, orbitControls, printBaseObjects, viewCube };
}

/**
 * Fits the renderer and camera to the current window size.
 * Call this from a window `resize` listener.
 *
 * @param renderer - The main renderer.
 * @param camera - The main camera.
 */
export function resizeRenderer(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (width === 0 || height === 0) return;

    // The pixel ratio changes when the window moves to another display or the page is zoomed.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
}
