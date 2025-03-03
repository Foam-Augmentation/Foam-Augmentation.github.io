import * as THREE from 'three';
import Printer from '../../printer/Printer'; 

/**
 * Initializes a Three.js scene, adding lighting and a bounding box representing the printer base.
 * used in initRenderer() and when the printer dimensions are updated.
 *
 * @param {THREE.Scene} scene - The Three.js scene to which objects will be added.
 * @param {Printer} printer - An instance of the Printer class, providing machine dimensions.
 * @param {object} options - Configuration options.
 * @param {boolean} [options.setLight=true] - Whether to add lighting.
 * @param {boolean} [options.setPrintBase=true] - Whether to draw the printer base.
 * @returns {THREE.Object3D[]} An array of objects added to the scene for potential later removal or cleanup.
 */
export default function initScene(
  scene: THREE.Scene,
  printer: Printer,
  printBaseObjects: THREE.Object3D[] = [],
  { setLight = true, setPrintBase = true }: { setLight?: boolean; setPrintBase?: boolean }
): THREE.Object3D[] {
  // const printBaseObjects: THREE.Object3D[] = [];

  // Add lighting
  if (setLight) {
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.set(2048, 2048);
    directionalLight.position.set(10, 10, 10);
    scene.add(directionalLight);

    const ambientLight = new THREE.AmbientLight(0xffffff, 1);
    scene.add(ambientLight);
  }

  // remove printBaseObjects
  printBaseObjects.forEach((object) => {
    scene.remove(object);
  });
  printBaseObjects = [];

  const xMax = printer.machine_depth;
  const yMax = printer.machine_depth;
  const zMax = printer.machine_height;

  // Draw the printer base
  if (setPrintBase) {
    const points = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(xMax, 0, 0),
      new THREE.Vector3(xMax, yMax, 0),
      new THREE.Vector3(0, yMax, 0),
      new THREE.Vector3(0, 0, zMax),
      new THREE.Vector3(xMax, 0, zMax),
      new THREE.Vector3(xMax, yMax, zMax),
      new THREE.Vector3(0, yMax, zMax)
    ];

    const geometry = new THREE.BufferGeometry();
    const vertices = new Float32Array([
      ...points[0].toArray(), ...points[1].toArray(),
      ...points[1].toArray(), ...points[2].toArray(),
      ...points[2].toArray(), ...points[3].toArray(),
      ...points[3].toArray(), ...points[0].toArray(),
      ...points[4].toArray(), ...points[5].toArray(),
      ...points[5].toArray(), ...points[6].toArray(),
      ...points[6].toArray(), ...points[7].toArray(),
      ...points[7].toArray(), ...points[4].toArray(),
      ...points[0].toArray(), ...points[4].toArray(),
      ...points[1].toArray(), ...points[5].toArray(),
      ...points[2].toArray(), ...points[6].toArray(),
      ...points[3].toArray(), ...points[7].toArray()
    ]);
    geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));

    const material = new THREE.LineDashedMaterial({
      color: 0xffffff,
      dashSize: 10,
      gapSize: 10
    });

    const line = new THREE.LineSegments(geometry, material);
    line.computeLineDistances();
    scene.add(line);
    printBaseObjects.push(line);

    const originGeometry = new THREE.SphereGeometry(2);
    const originMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const originSphere = new THREE.Mesh(originGeometry, originMaterial);
    scene.add(originSphere);
    printBaseObjects.push(originSphere);

    const axesHelper = new THREE.AxesHelper(50);
    scene.add(axesHelper);
    printBaseObjects.push(axesHelper);
  }

  return printBaseObjects;
}
