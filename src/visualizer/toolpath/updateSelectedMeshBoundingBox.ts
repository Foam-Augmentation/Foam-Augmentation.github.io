import * as THREE from 'three';
import Visualizer from '../Visualizer';
import { MeshBVH } from "three-mesh-bvh";
import ClipperLib from 'clipper-lib';
import { validateGeometryWithLogging } from '../utils/geometryValidation';

/**
 * Updates the outline of the selected mesh at lowest point + 1mm
 */
export function updateSelectedMeshBoundingBox(
  visualizer: Visualizer,
  object: any
): void {
  const mesh: THREE.Mesh | undefined =
    object.mesh ?? object.selectedRegularFoamMesh;
  if (!mesh) {
    console.warn("Missing mesh on object");
    return;
  }

  if (!validateGeometryWithLogging(mesh, 'updateSelectedMeshBoundingBox')) {
    console.warn("Cannot update bounding box — invalid geometry");
    return;
  }

  // Remove old helpers if they exist
  if (object.selectedRegularFoamMeshBoundingBoxHelper) {
    visualizer.scene.remove(object.selectedRegularFoamMeshBoundingBoxHelper);
    object.selectedRegularFoamMeshBoundingBoxHelper.geometry.dispose();
    object.selectedRegularFoamMeshBoundingBoxHelper.material.dispose();
    console.log("Disposing of old");
  }
  if (object.selectedRegularFoamMeshOutline) {
    visualizer.scene.remove(object.selectedRegularFoamMeshOutline);
    object.selectedRegularFoamMeshOutline.geometry.dispose();
    object.selectedRegularFoamMeshOutline.material.dispose();
  }

  const geometry = mesh.geometry;
  geometry.computeBoundingBox();
  mesh.updateWorldMatrix(true, false);

  const gbbox = geometry.boundingBox!;

  const tightBox = gbbox.clone();
  tightBox.applyMatrix4(mesh.matrixWorld);

  const bboxHelper = new THREE.Box3Helper(tightBox);
  bboxHelper.material = new THREE.LineBasicMaterial({ color: 0x0000ff });
  // visualizer.scene.add(bboxHelper);
  object.selectedRegularFoamMeshBoundingBoxHelper = bboxHelper;

  // Cleanup old outline
  if (object.selectedRegularFoamMeshOutline) {
    visualizer.scene.remove(object.selectedRegularFoamMeshOutline);
    object.selectedRegularFoamMeshOutline.geometry.dispose();
    object.selectedRegularFoamMeshOutline.material.dispose();
  }

  // Find lowest world Z point
  mesh.updateMatrixWorld(true);
  const meshWorldPos = new THREE.Vector3();
  mesh.getWorldPosition(meshWorldPos);
  
  const lowestWorldZ = 
    gbbox.min.z * mesh.scale.z + meshWorldPos.z;
  
  // Slice at lowest + 1mm
  const sliceZ = lowestWorldZ + 2.5;
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -sliceZ);

  // Transform geometry to world space
  const worldGeom = mesh.geometry.clone();
  worldGeom.applyMatrix4(mesh.matrixWorld);
  
  const bvh = new MeshBVH(worldGeom);
  const intersectionPoints: THREE.Vector3[] = [];

  // Find all plane-triangle intersections
  bvh.shapecast({
    intersectsBounds: () => true,
    intersectsTriangle: (tri) => {
      const edges = [
        new THREE.Line3(tri.a, tri.b),
        new THREE.Line3(tri.b, tri.c),
        new THREE.Line3(tri.c, tri.a),
      ];

      const hits: THREE.Vector3[] = [];
      for (const edge of edges) {
        const hit = plane.intersectLine(edge, new THREE.Vector3());
        if (hit) hits.push(hit);
      }

      if (hits.length === 2) {
        intersectionPoints.push(hits[0], hits[1]);
      }
      return false;
    },
  });

  if (intersectionPoints.length === 0) {
    console.warn("No intersections found at slice plane");
    return;
  }

  console.log(`BVH found ${intersectionPoints.length / 2} segments`);

  // Order points into clean outline loop using graph walking
  const orderedPoints = buildOutlineLoopWithGraph(intersectionPoints);
  
  if (orderedPoints.length === 0) {
    console.warn("Failed to build outline from segments");
    return;
  }

  console.log(`Final outline: ${orderedPoints.length} points`);

  // Create outline visualization
  const outlineGeom = new THREE.BufferGeometry().setFromPoints(
    orderedPoints.map(p => new THREE.Vector3(p.x, p.y, sliceZ))
  );

  const outlineMat = new THREE.LineBasicMaterial({
    color: 0xEE82EE,
    linewidth: 3,
    depthTest: false,
    transparent: true,
    opacity: 1.0,
  });

  const outline = new THREE.LineLoop(outlineGeom, outlineMat);
  outline.position.set(0, 0, 0);
  outline.renderOrder = 9999;
  
  visualizer.scene.add(outline);
  object.selectedRegularFoamMeshOutline = outline;

  // Generate G-code
  const gcode = generateOutlineGCode(orderedPoints);
  console.log("--- GENERATED OUTLINE G-CODE ---");
  console.log(gcode);
}

/**
 * Builds a clean outline from raw intersection points using graph walking
 */
function buildOutlineLoopWithGraph(rawPoints: THREE.Vector3[]): {x: number, y: number}[] {
  if (rawPoints.length < 2) return [];

  const PRECISION = 3; // decimal places for rounding

  console.log(`===== STARTING CONTOUR EXTRACTION =====`);
  console.log(`Raw points from BVH: ${rawPoints.length}`);

  // Build edge segments from BVH intersection pairs
  const segments: {a: {x: number, y: number}, b: {x: number, y: number}}[] = [];
  
  for (let i = 0; i < rawPoints.length; i += 2) {
    if (i + 1 < rawPoints.length) {
      segments.push({
        a: { 
          x: Number(rawPoints[i].x.toFixed(PRECISION)), 
          y: Number(rawPoints[i].y.toFixed(PRECISION))
        },
        b: { 
          x: Number(rawPoints[i+1].x.toFixed(PRECISION)), 
          y: Number(rawPoints[i+1].y.toFixed(PRECISION))
        }
      });
    }
  }

  console.log(`Building contour from ${segments.length} segments`);

  // Build graph to chain segments into closed loops
  const graph = new Map<string, {x: number, y: number}[]>();
  
  for (const seg of segments) {
    const keyA = `${seg.a.x},${seg.a.y}`;
    const keyB = `${seg.b.x},${seg.b.y}`;
    
    if (!graph.has(keyA)) graph.set(keyA, []);
    if (!graph.has(keyB)) graph.set(keyB, []);
    
    graph.get(keyA)!.push(seg.b);
    graph.get(keyB)!.push(seg.a);
  }

  console.log(`Graph has ${graph.size} unique vertices`);

  // Check connectivity
  const connectionCounts = new Map<number, number>();
  for (const [key, neighbors] of graph.entries()) {
    const count = neighbors.length;
    connectionCounts.set(count, (connectionCounts.get(count) || 0) + 1);
  }
  console.log('Vertex connectivity:', Object.fromEntries(connectionCounts));

  // Extract ALL closed contours by walking the graph
  const globalVisited = new Set<string>();
  const allContours: {x: number, y: number}[][] = [];

  let contourIndex = 0;
  for (const [startKey, _] of graph.entries()) {
    if (globalVisited.has(startKey)) continue;

    console.log(`\n--- Attempting contour ${contourIndex} from ${startKey} ---`);

    const contour: {x: number, y: number}[] = [];
    const localVisited = new Set<string>();
    const [sx, sy] = startKey.split(',').map(Number);
    let current = { x: sx, y: sy };
    const startPoint = `${sx},${sy}`;
    
    let steps = 0;
    const maxSteps = segments.length * 2;

    while (steps < maxSteps) {
      const key = `${current.x},${current.y}`;
      
      // Successfully closed the loop
      if (steps > 0 && key === startPoint) {
        console.log(`✓ CLOSED loop at step ${steps} with ${contour.length} points`);
        allContours.push([...contour]);
        // Mark all points in this contour as globally visited
        for (const pt of contour) {
          globalVisited.add(`${pt.x},${pt.y}`);
        }
        break;
      }

      // Already visited in THIS walk
      if (localVisited.has(key)) {
        console.log(`✗ Revisited ${key} at step ${steps} (loop not closed)`);
        break;
      }
      
      localVisited.add(key);
      contour.push({ x: current.x, y: current.y });
      
      const neighbors = graph.get(key) || [];
      console.log(`  Step ${steps}: at ${key}, has ${neighbors.length} neighbors`);
      
      // Find next unvisited neighbor (or back to start to close loop)
      let nextPoint: {x: number, y: number} | null = null;
      for (const neighbor of neighbors) {
        const neighborKey = `${neighbor.x},${neighbor.y}`;
        if (!localVisited.has(neighborKey)) {
          nextPoint = neighbor;
          console.log(`    → Going to ${neighborKey}`);
          break;
        } else if (steps > 2 && neighborKey === startPoint) {
          // Can close the loop
          nextPoint = neighbor;
          console.log(`    → Closing loop back to start`);
          break;
        }
      }
      
      if (!nextPoint) {
        console.log(`  ✗ Dead end at step ${steps} (${contour.length} points collected)`);
        break;
      }
      
      current = nextPoint;
      steps++;
    }
    
    contourIndex++;
  }

  console.log(`\n===== FOUND ${allContours.length} CLOSED CONTOURS =====`);
  allContours.forEach((c, i) => {
    const perimeter = calculatePerimeter(c);
    console.log(`Contour ${i}: ${c.length} points, perimeter ${perimeter.toFixed(2)}mm`);
  });
  
  if (allContours.length === 0) {
    console.warn("⚠️ NO CLOSED CONTOURS FOUND!");
    return [];
  }

  // Find the largest contour by perimeter (better than point count)
  const largestContour = allContours.reduce((largest, current) => {
    const largestPerim = calculatePerimeter(largest);
    const currentPerim = calculatePerimeter(current);
    return currentPerim > largestPerim ? current : largest;
  });

  const finalPerimeter = calculatePerimeter(largestContour);
  console.log(`\n✓ Using largest contour: ${largestContour.length} points, ${finalPerimeter.toFixed(2)}mm perimeter`);

  // Apply gentle Douglas-Peucker for smoothing
  const simplified = simplifyPath(largestContour, 0.3);
  
  // Make sure we didn't oversimplify
  if (simplified.length < 20 && largestContour.length > 20) {
    console.warn(`DP oversimplified to ${simplified.length} points, using original ${largestContour.length}`);
    return largestContour; // Use original if too simplified
  }
  
  console.log(`Simplified from ${largestContour.length} to ${simplified.length} points`);
  return simplified;
}

function calculatePerimeter(contour: {x: number, y: number}[]): number {
  let perimeter = 0;
  for (let i = 0; i < contour.length; i++) {
    const p1 = contour[i];
    const p2 = contour[(i + 1) % contour.length];
    perimeter += Math.hypot(p2.x - p1.x, p2.y - p1.y);
  }
  return perimeter;
}


/**
 * Douglas-Peucker line simplification
 */
function simplifyPath(points: {x: number, y: number}[], tolerance: number): {x: number, y: number}[] {
  if (points.length <= 2) return points;

  const sqTolerance = tolerance * tolerance;

  function getSqSegDist(p: {x: number, y: number}, p1: {x: number, y: number}, p2: {x: number, y: number}): number {
    let x = p1.x, y = p1.y;
    let dx = p2.x - x, dy = p2.y - y;

    if (dx !== 0 || dy !== 0) {
      const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) {
        x = p2.x;
        y = p2.y;
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }

    dx = p.x - x;
    dy = p.y - y;
    return dx * dx + dy * dy;
  }

  function simplifyDPStep(points: {x: number, y: number}[], first: number, last: number, sqTolerance: number, simplified: {x: number, y: number}[]): void {
    let maxSqDist = sqTolerance;
    let index = 0;

    for (let i = first + 1; i < last; i++) {
      const sqDist = getSqSegDist(points[i], points[first], points[last]);
      if (sqDist > maxSqDist) {
        index = i;
        maxSqDist = sqDist;
      }
    }

    if (maxSqDist > sqTolerance) {
      if (index - first > 1) simplifyDPStep(points, first, index, sqTolerance, simplified);
      simplified.push(points[index]);
      if (last - index > 1) simplifyDPStep(points, index, last, sqTolerance, simplified);
    }
  }

  const last = points.length - 1;
  const simplified = [points[0]];
  simplifyDPStep(points, 0, last, sqTolerance, simplified);
  simplified.push(points[last]);

  return simplified;
}

// outlinePoints: array of { x: number, y: number } in print-bed coordinates (mm)
// Assumes they are already in the correct order around the outline.
export function generateOutlineGCode(outlinePoints: any) {
  if (!outlinePoints || outlinePoints.length < 2) {
    console.warn("Not enough outline points");
    return "";
  }

  // --- CONSTANTS ---
  const k = 0.15;  // extrusion per mm (your calibration constant)
  const F = 100.488281; // print head speed (mm/min)
  const Z = 0.30; // first layer height
  
  // --- START GCODE HEADER (your printer setup) ---
  let gcode = `; Parameters:
  ; V* = 0.15
  ; H* = 9
  ; Edot (mm/min) = 35
  ; deltaZ (mm) = 1.16

  ; Calculated Parameters:
  ; ZOffset (mm) = 3.600000
  ; printHeadSpeed (mm/min) = ${F.toFixed(6)}

    M201 X9000 Y9000 Z500 E10000
    M203 X500 Y500 Z12 E120
    M204 P2000 R1500 T2000
    M205 X10.00 Y10.00 Z0.20 E4.50
    M205 S0 T0
    M107
    M862.1 P0.4

    M104 S230
    M190 S60
    M109 S230
    M862.3 P "MK3S"

    G28
    G92 X0 Y0
    M420 S1

    G21
    G90
    M83            ; **relative extrusion**
    G92 E0
    M900 K0.05
    M900 K30

    G1 Z0.200 F2400
    M204 S1000
    G0 F2880 X5.000 Y5.000 Z0.100
    M205 X8 Y8
    G1 Z${Z.toFixed(3)} F3000

    ; ---- Outline start ----
    `;

    // ----- MOVE TO FIRST OUTLINE POINT -----
    const startPt = outlinePoints[0];
    gcode += `G0 X${startPt.x.toFixed(3)} Y${startPt.y.toFixed(3)} F6000\n`;

    // ----- EXTRUDE AROUND OUTLINE -----
    for (let i = 1; i < outlinePoints.length; i++) {
      const pPrev = outlinePoints[i - 1];
      const pCurr = outlinePoints[i];
      
      // distance between points
      const dx2 = pCurr.x - pPrev.x;
      const dy2 = pCurr.y - pPrev.y;
      const dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

      const E = dist2 * k;

      gcode += `G1 X${pCurr.x.toFixed(3)} Y${pCurr.y.toFixed(3)} E${E.toFixed(4)} F${F.toFixed(3)}\n`;
    }

    // ----- CLOSE LOOP BACK TO FIRST POINT -----
    const p_last = outlinePoints[outlinePoints.length - 1];
    const dx = startPt.x - p_last.x;
    const dy = startPt.y - p_last.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const E = dist * k;

    gcode += `G1 X${startPt.x.toFixed(3)} Y${startPt.y.toFixed(3)} E${E.toFixed(4)} F${F.toFixed(3)}\n`;

    // END
    gcode += `
    ; ---- End outline ----
    G1 Z5.00 F3000
    M104 S0
    M140 S0
    M84
    `;

    return gcode;
}