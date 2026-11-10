import * as THREE from 'three';
import Printer from '../../printer/Printer';

/** Colours of the print bed and print space. They match the page theme in style.css. */
const BED_COLORS = {
  surface: 0x242a33,
  gridMinor: 0x3a4350,
  gridMajor: 0x4a5565,
  outline: 0x8fa3bf,
  volume: 0x4a5565,
  origin: 0xf2665c,
};

/** Spacing of the bed grid lines (mm); every `GRID_MAJOR_EVERY`-th line is drawn stronger. */
const GRID_STEP = 10;
const GRID_MAJOR_EVERY = 5;

/** Length of the axes at the bed origin (mm). */
const AXES_LENGTH = 30;

/**
 * Builds line segments from a flat list of points, two per segment.
 *
 * @param {number[]} vertices x, y, z of each point.
 * @param {number} color The line colour.
 * @param {number} opacity The line opacity, 0 to 1.
 * @returns {THREE.LineSegments} The lines.
 */
function makeLines(vertices: number[], color: number, opacity = 1): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  const material = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  return new THREE.LineSegments(geometry, material);
} 

/**
 * Initializes a Three.js scene, adding lighting and a bounding box representing the printer base.
 * used in initRenderer() and when the printer dimensions are updated.
 *
 * @param {THREE.Scene} scene - The Three.js scene to which objects will be added.
 * @param {Printer} printer - An instance of the Printer class, providing machine dimensions.
 * @param {THREE.Object3D[]} printBaseObjects - The array returned by the previous call; these objects are removed and disposed.
 * @param {object} options - Configuration options.
 * @param {boolean} [options.setLight=true] - Whether to add lighting.
 * @param {boolean} [options.setPrintBase=true] - Whether to draw the printer base.
 * @returns {THREE.Object3D[]} The print base objects now in the scene. Store this and pass it to the next call.
 */
export default function initScene(
  scene: THREE.Scene,
  printer: Printer,
  printBaseObjects: THREE.Object3D[] = [],
  { setLight = true, setPrintBase = true }: { setLight?: boolean; setPrintBase?: boolean }
): THREE.Object3D[] {
  // Add lighting
  if (setLight) {
    // Sky/ground light gives every face a base level that depends on which way it points,
    // so shapes read even where the key light does not reach.
    const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x3a414d, 1.0);
    hemisphereLight.position.set(0, 0, 1); // "up" is +Z
    scene.add(hemisphereLight);

    // Key light from the front left, above; a weaker fill from the opposite side.
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
    keyLight.position.set(-0.6, -1, 1.4);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xdfe8ff, 0.35);
    fillLight.position.set(1, 0.8, 0.5);
    scene.add(fillLight);
  }

  // Remove the previous print base objects and free their GPU resources.
  // Callers must keep the returned array and pass it back in next time,
  // otherwise the old outline, origin marker and axes stay in the scene.
  printBaseObjects.forEach((object) => {
    scene.remove(object);
    const drawable = object as Partial<Pick<THREE.Mesh, 'geometry' | 'material'>>;
    drawable.geometry?.dispose();
    const material = drawable.material;
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose());
    } else {
      material?.dispose();
    }
  });
  printBaseObjects = [];

  const xMax = printer.machine_depth;
  const yMax = printer.machine_depth_y;
  const zMax = printer.machine_height;

  // Draw the printer base
  if (setPrintBase) {
    const add = (object: THREE.Object3D): void => {
      scene.add(object);
      printBaseObjects.push(object);
    };

    // The bed surface, a hair below z = 0 so models and toolpaths resting on the bed do not
    // flicker against it.
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(xMax, yMax),
      new THREE.MeshBasicMaterial({
        color: BED_COLORS.surface,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    surface.position.set(xMax / 2, yMax / 2, -0.05);
    surface.renderOrder = -2;
    add(surface);

    // Grid on the bed: a line every GRID_STEP mm, stronger every GRID_MAJOR_EVERY lines.
    const minor: number[] = [];
    const major: number[] = [];
    for (let k = 1; k * GRID_STEP < xMax; k++) {
      (k % GRID_MAJOR_EVERY === 0 ? major : minor).push(k * GRID_STEP, 0, 0, k * GRID_STEP, yMax, 0);
    }
    for (let k = 1; k * GRID_STEP < yMax; k++) {
      (k % GRID_MAJOR_EVERY === 0 ? major : minor).push(0, k * GRID_STEP, 0, xMax, k * GRID_STEP, 0);
    }
    const minorGrid = makeLines(minor, BED_COLORS.gridMinor);
    const majorGrid = makeLines(major, BED_COLORS.gridMajor);
    minorGrid.renderOrder = -1;
    majorGrid.renderOrder = -1;
    add(minorGrid);
    add(majorGrid);

    // Outline of the bed.
    add(makeLines([
      0, 0, 0, xMax, 0, 0,
      xMax, 0, 0, xMax, yMax, 0,
      xMax, yMax, 0, 0, yMax, 0,
      0, yMax, 0, 0, 0, 0,
    ], BED_COLORS.outline));

    // The rest of the print space: the four uprights and the top, drawn faintly.
    add(makeLines([
      0, 0, 0, 0, 0, zMax,
      xMax, 0, 0, xMax, 0, zMax,
      xMax, yMax, 0, xMax, yMax, zMax,
      0, yMax, 0, 0, yMax, zMax,
      0, 0, zMax, xMax, 0, zMax,
      xMax, 0, zMax, xMax, yMax, zMax,
      xMax, yMax, zMax, 0, yMax, zMax,
      0, yMax, zMax, 0, 0, zMax,
    ], BED_COLORS.volume, 0.45));

    // The bed origin and its axes (X red, Y green, Z blue).
    add(new THREE.Mesh(
      new THREE.SphereGeometry(1.5, 16, 12),
      new THREE.MeshBasicMaterial({ color: BED_COLORS.origin })
    ));
    add(new THREE.AxesHelper(AXES_LENGTH));
  }

  return printBaseObjects;
}
