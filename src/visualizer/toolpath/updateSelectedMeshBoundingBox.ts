import * as THREE from 'three';
import concaveman from 'concaveman';
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

    // OUTLINE: FLATTENING APPROACH
    mesh.updateMatrixWorld(true); // Ensure world transform is up to date

    // get array of points of STL object
    const points2D: [number, number][] = [];
    const points3D: THREE.Vector3[] = [];
    const geom = mesh.geometry as THREE.BufferGeometry;
    const positionsAttr = geom.getAttribute('position');

    const vertex = new THREE.Vector3();

    for (let i = 0; i < positionsAttr.count; i++) {
        vertex.set(
            positionsAttr.getX(i),
            positionsAttr.getY(i),
            positionsAttr.getZ(i)
        );
        vertex.applyMatrix4(mesh.matrixWorld); // transform to world space
        points2D.push([vertex.x, vertex.y]); // flatten Z
        points3D.push(vertex.clone());
    }

    const concaveOutline = concaveman(points2D, 2, 1);
    const path: THREE.Vector2[] = concaveOutline.map(([x, y]) => new THREE.Vector2(x, y));

    // Build and log G-Code
    const flatten_gcode = generateOutlineGCode(path);
    console.log("%c>>> FLATTENING OUTLINE G-CODE <<<", "background: #111; color: #00ff00; font-family: monospace;");
    console.log(flatten_gcode);

    // Visualization in Scene
    if (object.flattenOutline) visualizer.scene.remove(object.flattenOutline);

    const minZ = points3D.reduce((min, v) => Math.min(min, v.z), Infinity);
    const flattenGeom = new THREE.BufferGeometry().setFromPoints(
        path.map(p => new THREE.Vector3(p.x, p.y, minZ))
    );

    const flattenLine = new THREE.LineLoop(
        flattenGeom,
        new THREE.LineBasicMaterial({ color: 0x00ff00, depthTest: false })
    );
    flattenLine.renderOrder = 999;
    visualizer.scene.add(flattenLine);
    object.flattenLine = flattenLine;

    // OUTLINE: BVH APPROACH
    mesh.updateMatrixWorld(true);
    const worldGeom = mesh.geometry.clone();
    worldGeom.applyMatrix4(mesh.matrixWorld); 
    worldGeom.computeBoundingBox();

    const worldBox = worldGeom.boundingBox!;
    const meshCenter = new THREE.Vector3();
    worldBox.getCenter(meshCenter);

    const bvh = worldGeom.boundsTree || new MeshBVH(worldGeom);
    let rawPoints: THREE.Vector3[] = [];
    const plane = new THREE.Plane();
    const sliceZ = worldBox.min.z + ((worldBox.max.z - worldBox.min.z) * 0.1);
    plane.set(new THREE.Vector3(0, 0, 1), -sliceZ);

    bvh.shapecast({
        intersectsBounds: (box: THREE.Box3) => plane.intersectsBox(box),
        intersectsTriangle: (tri: any) => {
            const edges = [
                new THREE.Line3(tri.a, tri.b),
                new THREE.Line3(tri.b, tri.c),
                new THREE.Line3(tri.c, tri.a)
            ];
            for (const edge of edges) {
                const hit = plane.intersectLine(edge, new THREE.Vector3());
                if (hit) rawPoints.push(hit);
            }
            return false;
        },
    });
    worldGeom.dispose();

    if (rawPoints.length < 5) return;

    // Radial Sort
    const centroid = new THREE.Vector2(0, 0);
    rawPoints.forEach(p => { centroid.x += p.x; centroid.y += p.y; });
    centroid.divideScalar(rawPoints.length);

    let sortedPath = rawPoints.map(p => ({
        x: p.x,
        y: p.y,
        angle: Math.atan2(p.y - centroid.y, p.x - centroid.x)
    })).sort((a, b) => a.angle - b.angle);

    let finalPath = simplifyPath(sortedPath, 5.0);

    const gcode = generateOutlineGCode(finalPath);
    console.log("%c>>> BVH OUTLINE G-CODE <<<", "background: #111; color: #00ff00; font-family: monospace;");
    console.log(gcode);

    if (object.selectedRegularFoamMeshOutline) visualizer.scene.remove(object.selectedRegularFoamMeshOutline);
    const visualGeom = new THREE.BufferGeometry().setFromPoints(
        finalPath.map(p => new THREE.Vector3(p.x, p.y, sliceZ))
    );
    const visualLine = new THREE.LineLoop(
        visualGeom,
        new THREE.LineBasicMaterial({ color: 0x00ffff, depthTest: false })
    );
    visualLine.renderOrder = 999;
    visualizer.scene.add(visualLine);
    object.selectedRegularFoamMeshOutline = visualLine;
    visualizer.render();
}

function simplifyPath(points: {x: number, y: number}[], tolerance: number): {x: number, y: number}[] {
    if (points.length < 3) return points;
    const result = [points[0]];
    for (let i = 1; i < points.length; i++) {
        // Calculates Euclidean distance, only includes points with greater than tolerance distance from prev point
        const d = Math.hypot(points[i].x - result[result.length - 1].x, points[i].y - result[result.length - 1].y);
        if (d > tolerance) result.push(points[i]);
    }
    return result;
}

export function generateOutlineGCode(points: {x: number, y: number}[]) {
    const k = 0.15;
    const F_print = 1500;

    let gcode = `G21\nG90\nM83\n`;

    const startX = points[0].x.toFixed(3);
    const startY = points[0].y.toFixed(3);
    gcode += `G0 X${startX} Y${startY} Z5.0 F6000\n`;
    gcode += `G1 Z0.200 F3000\n`;

    for (let i = 1; i < points.length; i++) {
        // Calculates Euclidean distance
        const d = Math.hypot(points[i].x - points[i-1].x, points[i].y - points[i-1].y);
        gcode += `G1 X${points[i].x.toFixed(3)} Y${points[i].y.toFixed(3)} E${(d * k).toFixed(4)} F${F_print}\n`;
    }

    const closeD = Math.hypot(points[0].x - points[points.length-1].x, points[0].y - points[points.length-1].y);
    gcode += `G1 X${startX} Y${startY} E${(closeD * k).toFixed(4)} F${F_print}\n`;

    gcode += `\n; End Perimeter\nG1 E-1.5 F2400\nG1 Z50 F3000\nG28 X0 Y0\n`;
    return gcode;
}