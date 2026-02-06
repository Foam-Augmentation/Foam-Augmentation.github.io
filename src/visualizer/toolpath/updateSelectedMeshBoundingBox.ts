import * as THREE from 'three';
import Visualizer from '../Visualizer';
import { MeshBVH } from "three-mesh-bvh";

export function updateSelectedMeshBoundingBox(
    visualizer: Visualizer,
    object: any
): void {
    // Determine which mesh property exists
    const mesh: THREE.Mesh = object.mesh || object.selectedMesh || object;
    if (!mesh || !(mesh instanceof THREE.Mesh)) {
        console.error("Outline Error: No valid mesh provided");
        return;
    }

    // 1. Bake World Matrix for correct Bed Positioning
    mesh.updateMatrixWorld(true);
    const worldGeom = mesh.geometry.clone();
    worldGeom.applyMatrix4(mesh.matrixWorld); 
    worldGeom.computeBoundingBox();

    const worldBox = worldGeom.boundingBox!;
    const meshCenter = new THREE.Vector3();
    worldBox.getCenter(meshCenter);
    
    // 2. Slice at 30% Height
    // @ts-ignore
    const bvh = worldGeom.boundsTree || new MeshBVH(worldGeom);
    let rawPoints: THREE.Vector3[] = [];
    const plane = new THREE.Plane();
    const sliceZ = worldBox.min.z + ((worldBox.max.z - worldBox.min.z) * 0.3);
    plane.set(new THREE.Vector3(0, 0, 1), -sliceZ);

    bvh.shapecast({
        intersectsBounds: (box: THREE.Box3) => plane.intersectsBox(box),
        intersectsTriangle: (tri: any) => {
            const edges = [new THREE.Line3(tri.a, tri.b), new THREE.Line3(tri.b, tri.c), new THREE.Line3(tri.c, tri.a)];
            for (const edge of edges) {
                const hit = plane.intersectLine(edge, new THREE.Vector3());
                if (hit) rawPoints.push(hit);
            }
            return false;
        },
    });
    worldGeom.dispose();

    if (rawPoints.length < 5) return;

    // 3. Radial Sort (Clockwise / Counter-Clockwise Loop)
    const centroid = new THREE.Vector2(0, 0);
    rawPoints.forEach(p => { centroid.x += p.x; centroid.y += p.y; });
    centroid.divideScalar(rawPoints.length);

    let sortedPath = rawPoints.map(p => ({
        x: p.x,
        y: p.y,
        angle: Math.atan2(p.y - centroid.y, p.x - centroid.x)
    })).sort((a, b) => a.angle - b.angle);

    // 4. Simplify Path for Smooth Printing
    let finalPath = simplifyPath(sortedPath, 0.8);

    // 5. Build and Log G-Code
    const gcode = generateOutlineGCode(finalPath);
    console.log("%c>>> CONSOLE G-CODE DUMP <<<", "background: #111; color: #00ff00; font-family: monospace;");
    console.log(gcode);

    // 6. Visualization in Scene
    if (object.selectedRegularFoamMeshOutline) visualizer.scene.remove(object.selectedRegularFoamMeshOutline);
    const visualGeom = new THREE.BufferGeometry().setFromPoints(finalPath.map(p => new THREE.Vector3(p.x, p.y, sliceZ + 0.5)));
    const visualLine = new THREE.LineLoop(visualGeom, new THREE.LineBasicMaterial({ color: 0x00ffff, depthTest: false }));
    visualLine.renderOrder = 999;
    visualizer.scene.add(visualLine);
    object.selectedRegularFoamMeshOutline = visualLine;
    visualizer.render();
}

function simplifyPath(points: {x: number, y: number}[], tolerance: number): {x: number, y: number}[] {
    if (points.length < 3) return points;
    const result = [points[0]];
    for (let i = 1; i < points.length; i++) {
        const d = Math.hypot(points[i].x - result[result.length - 1].x, points[i].y - result[result.length - 1].y);
        if (d > tolerance) result.push(points[i]);
    }
    return result;
}

export function generateOutlineGCode(points: {x: number, y: number}[]) {
    const k = 0.15; // Extrusion multiplier
    const F_print = 1500;
    
    let gcode = `G21\nG90\nM83\n`;
    
    const startX = points[0].x.toFixed(3);
    const startY = points[0].y.toFixed(3);
    gcode += `G0 X${startX} Y${startY} Z5.0 F6000\n`;
    gcode += `G1 Z0.200 F3000\n`;

    for (let i = 1; i < points.length; i++) {
        const d = Math.hypot(points[i].x - points[i-1].x, points[i].y - points[i-1].y);
        gcode += `G1 X${points[i].x.toFixed(3)} Y${points[i].y.toFixed(3)} E${(d * k).toFixed(4)} F${F_print}\n`;
    }

    const closeD = Math.hypot(points[0].x - points[points.length-1].x, points[0].y - points[points.length-1].y);
    gcode += `G1 X${startX} Y${startY} E${(closeD * k).toFixed(4)} F${F_print}\n`;

    gcode += `\n; End Perimeter\nG1 E-1.5 F2400\nG1 Z50 F3000\nG28 X0 Y0\n`;
    return gcode;
}