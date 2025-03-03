import * as THREE from 'three';
import Visualizer from '../Visualizer';

/**
 * Represents the state for lasso selection.
 */
export interface LassoState {
    selectionPoints: number[];  // Array of numbers representing lasso points in NDC.
    dragging: boolean;          // Indicates if lasso dragging is active.
    selectionShapeNeedsUpdate: boolean; // Flag indicating if the lasso shape needs update.
    selectionNeedsUpdate: boolean;      // Flag indicating if selection processing is needed.
    startX: number;             // Starting X coordinate in NDC.
    startY: number;             // Starting Y coordinate in NDC.
    prevX: number;              // Previous pointer X coordinate.
    prevY: number;              // Previous pointer Y coordinate.
    tempVec0: THREE.Vector2;    // Temporary vector for calculations.
    tempVec1: THREE.Vector2;    // Temporary vector for calculations.
    tempVec2: THREE.Vector2;    // Temporary vector for calculations.
    selectionShape: THREE.Line; // The line object representing the lasso shape.
}

/**
 * Initializes the lasso selection functionality.
 *
 * This function sets up pointer event listeners on the renderer's DOM element to manage lasso selection.
 * It updates the lassoState (a collection of related variables) and the selection shape accordingly.
 *
 * @param visualizer - An instance of Visualizer. It is expected to have properties such as:
 *                     renderer, camera, orbitControls, scene, and lassoState.
 */
export function initLassoSelect(visualizer: Visualizer): void {
    const ls: LassoState = visualizer.lassoState;

    // Configure the selection shape. We assume its material is a LineBasicMaterial.
    // Type cast the material to THREE.LineBasicMaterial so that 'color' and 'depthTest' can be accessed.
    (ls.selectionShape.material as THREE.LineBasicMaterial).color.set(0xff9800).convertSRGBToLinear();
    // Set render order.
    ls.selectionShape.renderOrder = 1;
    // set position.z
    ls.selectionShape.position.z = - .2;
    // Instead of setting depthTest on the object, set it on the material.
    (ls.selectionShape.material as THREE.LineBasicMaterial).depthTest = false;
    ls.selectionShape.scale.setScalar(1);
    // Make the selection shape a child of the camera.
    visualizer.camera.add(ls.selectionShape);

    // Pointerdown event: begin lasso selection.
    visualizer.renderer.domElement.addEventListener('pointerdown', (e: PointerEvent) => {
        ls.prevX = e.clientX;
        ls.prevY = e.clientY;
        ls.startX = (e.clientX / window.innerWidth) * 2 - 1;
        ls.startY = -((e.clientY / window.innerHeight) * 2 - 1);
        ls.selectionPoints.length = 0;
        ls.dragging = true;
    });

    // Pointerup event: finish lasso selection.
    visualizer.renderer.domElement.addEventListener('pointerup', () => {
        visualizer.orbitControls.enabled = true; // Re-enable orbit controls.
        ls.selectionShape.visible = false;
        ls.dragging = false;
        if (ls.selectionPoints.length > 0) {
            ls.selectionNeedsUpdate = true;
        }
    });

    // Pointermove event: update the lasso shape.
    visualizer.renderer.domElement.addEventListener('pointermove', (e: PointerEvent) => {
        // Only proceed if the left mouse button is pressed and the Alt key is held.
        if ((e.buttons & 1) === 0 || !e.altKey) return;

        // Disable orbit controls during lasso selection.
        visualizer.orbitControls.enabled = false;

        const ex = e.clientX;
        const ey = e.clientY;
        const nx = (e.clientX / window.innerWidth) * 2 - 1;
        const ny = -((e.clientY / window.innerHeight) * 2 - 1);

        if (visualizer.config.toolMode === 'box') {
            // For box selection, set exactly 5 corners (15 numbers).
            ls.selectionPoints.length = 15;
            ls.selectionPoints[0] = ls.startX;
            ls.selectionPoints[1] = ls.startY;
            ls.selectionPoints[2] = 0;

            ls.selectionPoints[3] = nx;
            ls.selectionPoints[4] = ls.startY;
            ls.selectionPoints[5] = 0;

            ls.selectionPoints[6] = nx;
            ls.selectionPoints[7] = ny;
            ls.selectionPoints[8] = 0;

            ls.selectionPoints[9] = ls.startX;
            ls.selectionPoints[10] = ny;
            ls.selectionPoints[11] = 0;

            ls.selectionPoints[12] = ls.startX;
            ls.selectionPoints[13] = ls.startY;
            ls.selectionPoints[14] = 0;

            if (ex !== ls.prevX || ey !== ls.prevY) {
                ls.selectionShapeNeedsUpdate = true;
            }
            ls.prevX = ex;
            ls.prevY = ey;
            ls.selectionShape.visible = true;
            if (visualizer.config.liveUpdate) {
                ls.selectionNeedsUpdate = true;
            }
        } else {
            // For free-form lasso mode.
            if (Math.abs(ex - ls.prevX) >= 3 || Math.abs(ey - ls.prevY) >= 3) {
                const i = (ls.selectionPoints.length / 3) - 1;
                const i3 = i * 3;
                let doReplace = false;
                if (ls.selectionPoints.length > 3) {
                    // Compute the direction of the previous segment.
                    ls.tempVec0.set(ls.selectionPoints[i3 - 3], ls.selectionPoints[i3 - 2]);
                    ls.tempVec1.set(ls.selectionPoints[i3], ls.selectionPoints[i3 + 1]);
                    ls.tempVec1.sub(ls.tempVec0).normalize();
                    // Compute the current segment direction.
                    ls.tempVec0.set(ls.selectionPoints[i3], ls.selectionPoints[i3 + 1]);
                    ls.tempVec2.set(nx, ny);
                    ls.tempVec2.sub(ls.tempVec0).normalize();

                    const dot = ls.tempVec1.dot(ls.tempVec2);
                    doReplace = dot > 0.99;
                }

                if (doReplace) {
                    ls.selectionPoints[i3] = nx;
                    ls.selectionPoints[i3 + 1] = ny;
                } else {
                    ls.selectionPoints.push(nx, ny, 0);
                }
                ls.selectionShapeNeedsUpdate = true;
                ls.selectionShape.visible = true;
                ls.prevX = ex;
                ls.prevY = ey;
                if (visualizer.config.liveUpdate) {
                    ls.selectionNeedsUpdate = true;
                }
            }
        }
    });
}
