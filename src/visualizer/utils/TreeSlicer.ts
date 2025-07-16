import * as THREE from 'three';
import ClipperLib from 'clipper-lib';



const CLIPPER_SCALE = 1000;
const MIN_AREA = 3;


// basic data structures for slicing
export interface SliceRegion {
    id: string;
    height: number;
    contour: THREE.Vector3[];
    bounds: { min: THREE.Vector3; max: THREE.Vector3 };
}

export interface RegionNode {
    region: SliceRegion;
    children: RegionNode[];
    parent: RegionNode | null;
    layer: number;
    visited: boolean;
}

export interface PrintChunk {
    id: string;
    regions: SliceRegion[];
    minHeight: number;
    maxHeight: number;
    dependencies: PrintChunk[];
}


interface ContourNode {
  path: ClipperLib.IntPoint[];
  contour: THREE.Vector3[];
  children: ContourNode[];
}

// slice mesh into horizontal layers
export function sliceMeshIntoLayers(mesh: THREE.Mesh, deltaZ: number): { z: number, segments: { start: THREE.Vector3, end: THREE.Vector3 }[] }[] {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox!;
    
    const minZ = bbox.min.z;
    const maxZ = bbox.max.z;
    const layers: { z: number, segments: { start: THREE.Vector3, end: THREE.Vector3 }[] }[] = [];
    
    // go from bottom to top, slice every deltaZ
    for (let z = minZ; z <= maxZ; z += deltaZ) {
        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
        const segments = getSegmentsFromMesh(mesh, plane);
        layers.push({ z, segments });
    }
    
    return layers;
}

// take line segments and make closed shapes
export function extractRegionsFromLayer(z: number, segments: { start: THREE.Vector3, end: THREE.Vector3 }[]): SliceRegion[] {
    if (segments.length === 0) return [];
    
    const contours = connectSegments(segments);
    const regions: SliceRegion[] = [];
    
    // make a region for each contour we found
    for (let i = 0; i < contours.length; i++) {
        const contour = contours[i];
        const bounds = getBounds(contour, z);
        
        regions.push({
            id: `region_${z.toFixed(3)}_${i}`,
            height: z,
            contour: contour,
            bounds: bounds
        });
    }
    
    return regions;
}

/**
 * Gets the outer contour of a mesh on a specific plane
 * 
 * @private
 * @param {THREE.Mesh} mesh - The mesh to get segments from.
 * @param {THREE.Plane} plane - The plane on which to extract segments from the mesh on.
 * @returns {{ start: THREE.Vector3; end: THREE.Vector3 }[]} A list of line segments that make up the contour.
 */
export function getSegmentsFromMesh(mesh: THREE.Mesh, plane: THREE.Plane): { start: THREE.Vector3; end: THREE.Vector3 }[] {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const positions = geometry.attributes.position.array as Float32Array;
    const segments: { start: THREE.Vector3; end: THREE.Vector3 }[] = [];
    
    // check each triangle
    for (let i = 0; i < positions.length; i += 9) {
        const a = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
        const b = new THREE.Vector3(positions[i + 3], positions[i + 4], positions[i + 5]);
        const c = new THREE.Vector3(positions[i + 6], positions[i + 7], positions[i + 8]);
        
        const intersections = getTrianglePlaneIntersection(a, b, c, plane);
        if (intersections.length === 2) {
            segments.push({ start: intersections[0], end: intersections[1] });
        }
    }
    
    return segments;
}

/**
 * Gets the intersection points between a triangle and a plane.
 * 
 * @param {THREE.Vector3} a - First vertex of the triangle.
 * @param {THREE.Vector3} b - Second vertex of the triangle.
 * @param {THREE.Vector3} c - Third vertex of the triangle.
 * @param {THREE.Plane} plane - The plane to check intersections with.
 * @returns {THREE.Vector3[]} The list of intersection points.
 */
export function getTrianglePlaneIntersection(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, plane: THREE.Plane): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    const edges = [[a, b], [b, c], [c, a]];
    
    for (const [p1, p2] of edges) {
        const d1 = plane.distanceToPoint(p1);
        const d2 = plane.distanceToPoint(p2);
        
        // if points are on different sides of plane, edge crosses it
        if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) {
            const t = d1 / (d1 - d2);
            const intersection = new THREE.Vector3();
            intersection.lerpVectors(p1, p2, t);
            points.push(intersection);
        } 
    }
    
    return points;
}

/**
 * Takes in a list of line segments and connects the line segments to create contours, 
 * returning a matrix of points representing the contours.
 * 
 * @private
 * @param {{ start: THREE.Vector3; end: THREE.Vector3 }[]} segments - The contour in the form of line segments.
 * @returns {THREE.Vector3[][]} The ordered lists of points making up the contour.
 */
export function connectSegments(segments: { start: THREE.Vector3; end: THREE.Vector3 }[]): THREE.Vector3[][] {
    if (segments.length === 0) return [];
    
    const contours: THREE.Vector3[][] = [];
    const used = new Set<number>();
    const tolerance = 0.00001; // how close endpoints need to be to connect
    
    while (used.size < segments.length) {
        // find unused segment to start new contour
        let startIdx = -1;
        for (let i = 0; i < segments.length; i++) {
            if (!used.has(i)) {
                startIdx = i;
                break;
            }
        }
        
        if (startIdx === -1) break;
        
        const contour: THREE.Vector3[] = [];
        let currentSegment = segments[startIdx];
        let currentPoint = currentSegment.start;
        
        used.add(startIdx);
        contour.push(currentPoint.clone());
        contour.push(currentSegment.end.clone());
        currentPoint = currentSegment.end;
        
        // try to keep connecting more segments
        let foundConnection = true;
        while (foundConnection && used.size < segments.length) {
            foundConnection = false;
            
            for (let i = 0; i < segments.length; i++) {
                if (used.has(i)) continue;
                
                const seg = segments[i];
                
                // see if we can connect to this segment
                if (currentPoint.distanceTo(seg.start) < tolerance) {
                    contour.push(seg.end.clone());
                    currentPoint = seg.end;
                    used.add(i);
                    foundConnection = true;
                    break;
                } else if (currentPoint.distanceTo(seg.end) < tolerance) {
                    contour.push(seg.start.clone());
                    currentPoint = seg.start;
                    used.add(i);
                    foundConnection = true;
                    break;
                }
            }
        }
        
        if (contour.length > 2) {
            contours.push(contour);
        }
    }
    
    return contours;
}

// calculate bounding box for contour
function getBounds(contour: THREE.Vector3[], z: number): { min: THREE.Vector3; max: THREE.Vector3 } {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    for (const point of contour) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
    }
    
    return {
        min: new THREE.Vector3(minX, minY, z),
        max: new THREE.Vector3(maxX, maxY, z)
    };
}

// check if two regions overlap in XY plane
export function checkOverlap(regionA: SliceRegion, regionB: SliceRegion): boolean {
    return !(
        regionA.bounds.max.x < regionB.bounds.min.x ||
        regionA.bounds.min.x > regionB.bounds.max.x ||
        regionA.bounds.max.y < regionB.bounds.min.y ||
        regionA.bounds.min.y > regionB.bounds.max.y
    );
}

// split regions into groups when they overlap (for support stuff)
export function splitRegionsByOverlapOrSupport(regions: SliceRegion[]): SliceRegion[][] {
    let groups: SliceRegion[][] = [regions];
    let changed = true;
    
    // keep splitting until no more overlaps
    while (changed) {
        changed = false;
        const newGroups: SliceRegion[][] = [];
        
        for (const group of groups) {
            let splitIndex = -1;
            let splitHeight = -1;
            
            // look for overlapping regions at different heights
            for (let i = 0; i < group.length; i++) {
                for (let j = 0; j < group.length; j++) {
                    if (i === j) continue;
                    const a = group[i];
                    const b = group[j];
                    
                    if (checkOverlap(a, b)) {
                        if (a.height > b.height) {
                            splitIndex = i;
                            splitHeight = b.height;
                            break;
                        } else if (b.height > a.height) {
                            splitIndex = j;
                            splitHeight = a.height;
                            break;
                        }
                    }
                }
                if (splitIndex !== -1) break;
            }
            
            if (splitIndex !== -1) {
                const above = group.filter(r => r.height > splitHeight);
                const below = group.filter(r => r.height <= splitHeight);
                if (above.length > 0 && below.length > 0) {
                    newGroups.push(above, below);
                    changed = true;
                } else {
                    newGroups.push(group);
                }
            } else {
                newGroups.push(group);
            }
        }
        groups = newGroups;
    }
    
    return groups;
}

// build tree structure to minimize travel path
export function buildRegionTree(regions: SliceRegion[], layerHeight: number): RegionNode[] {
    const nodes = new Map<string, RegionNode>();
    
    // create nodes for each region
    for (const region of regions) {
        const node: RegionNode = {
            region,
            children: [],
            parent: null,
            layer: Math.floor(region.height / layerHeight),
            visited: false
        };
        nodes.set(region.id, node);
    }

    // sort in descending order to start from the top of the tree
    // do this after making nodes because maps don't preserve order
    const sortedNodeRegions = Array.from(nodes.entries()).sort((a, b) => b[1].layer - a[1].layer)
    
    // figure out parent-child relationshipds
    for (let i = 0; i < sortedNodeRegions.length; i++) {
        const [id, node] = sortedNodeRegions[i];
        for (let j = i + 1; j < sortedNodeRegions.length; j++) {
            const [otherId, otherNode] = sortedNodeRegions[j];

            // break out of for loop after checking all nodes in the next layer down.
            if (node.layer - otherNode.layer > 1) {
                break;
            }

            if (shouldBeParent(node.region, otherNode.region)) {
                node.children.push(otherNode);
                otherNode.parent = node;
            }
        }
    }
    
    // return root nodes (ones with no parent)
    return Array.from(nodes.values()).filter(node => node.parent === null);
}

// check if regionA should be parent of regionB
function shouldBeParent(regionA: SliceRegion, regionB: SliceRegion): boolean {
    return (
        regionB.height > regionA.height &&
        checkOverlap(regionA, regionB)
    );
}

// create print chunks with dependencies for optimized printing
export function buildChunksWithDependencies(regionGroups: SliceRegion[][], regionTree: RegionNode[]): PrintChunk[] {
    const regionToChunk = new Map<string, PrintChunk>();
    const chunks: PrintChunk[] = [];
    
    // make chunks from groups
    regionGroups.forEach((group, i) => {
        if (group.length === 0) return;
        
        const heights = group.map(r => r.height);
        const minHeight = Math.min(...heights);
        const maxHeight = Math.max(...heights);
        
        const chunk: PrintChunk = {
            id: `chunk_${i}_${minHeight.toFixed(3)}`,
            regions: group,
            minHeight,
            maxHeight,
            dependencies: []
        };
        
        chunks.push(chunk);
        
        // map regions to their chunks
        for (const region of group) {
            regionToChunk.set(region.id, chunk);
        }
    });
    
    // figure out dependencies between chunks
    for (const chunk of chunks) {
        const deps = new Set<PrintChunk>();
        
        for (const region of chunk.regions) {
            const parent = findParentInTree(region, regionTree);
            if (parent) {
                const parentChunk = regionToChunk.get(parent.region.id);
                if (parentChunk && parentChunk !== chunk) {
                    deps.add(parentChunk);
                }
            }
        }
        
        chunk.dependencies = Array.from(deps);
    }
    
    return chunks;
}

// find parent of region in tree
function findParentInTree(region: SliceRegion, regionTree: RegionNode[]): RegionNode | null {
    for (const node of regionTree) {
        if (node.region.id === region.id) {
            return node.parent;
        }
        
        // search in children
        const found = findParentInTree(region, node.children);
        if (found) return found;
    }
    return null;
}

// sort chunks so dependencies print first
export function topologicalSortChunks(chunks: PrintChunk[]): PrintChunk[] {
    const sorted: PrintChunk[] = [];
    const visited = new Set<string>();
    
    function visitChunk(chunk: PrintChunk) {
        if (visited.has(chunk.id)) return;
        visited.add(chunk.id);
        
        // visit dependencies first
        for (const dep of chunk.dependencies) {
            visitChunk(dep);
        }
        
        sorted.push(chunk);
    }
    
    for (const chunk of chunks) {
        visitChunk(chunk);
    }
    
    return sorted;
}


function toClipperPath(loop: THREE.Vector2[]) {
  return loop.map(pt => ({
    X: Math.round(pt.x * CLIPPER_SCALE),
    Y: Math.round(pt.y * CLIPPER_SCALE),
  }));
}


function fromClipperPath(path: ClipperLib.IntPoint[]) {
  return path.map(pt =>
    new THREE.Vector2(pt.X / CLIPPER_SCALE, pt.Y / CLIPPER_SCALE)
  );
}


function clipperArea(path: ClipperLib.IntPoint[]) {
  let area = 0;
  for (let i = 0; i < path.length; i++) {
    const p1 = path[i], p2 = path[(i + 1) % path.length];
    area += p1.X * p2.Y - p2.X * p1.Y;
  }
  return area / 2;
}


function preparePaths(
  outer: THREE.Vector3[],
  holes: THREE.Vector3[][]
): THREE.Vector2[][] {
  if (get_winding_order(outer)) {
    outer.reverse();
  }
  holes.forEach(hole => {
    if (!get_winding_order(hole)) {
      holes.reverse();
    }
  })

  const twoDimContours: THREE.Vector2[][] = [];

  const twoDimOuter: THREE.Vector2[] = [];
  outer.forEach(point => {
      twoDimOuter.push(new THREE.Vector2(point.x, point. y));
  });
  twoDimContours.push(twoDimOuter);

  holes.forEach(hole => {
      const twoDimContour: THREE.Vector2[] = [];
      hole.forEach(point => {
          twoDimContour.push(new THREE.Vector2(point.x, point. y));
      });
      twoDimContours.push(twoDimContour);
  });
  return twoDimContours;
}


function pointAlongLine(
  a: THREE.Vector3,
  b: THREE.Vector3,
  distance: number
): THREE.Vector3 {
  const totalLen = a.distanceTo(b);
  if (totalLen === 0) return a.clone();
  const t = distance / totalLen;
  return a.clone().lerp(b, t);
}


function spiralContours(
  isocontours: THREE.Vector3[][],
  indicesToSpiral: number[],
  initialStartIndex: number,
  step: number
): THREE.Vector3[] {
  let path: THREE.Vector3[] = [];

  let startIndex = initialStartIndex;
  let initialDist = 0;
  for (const i of indicesToSpiral) {
    let totalDist = initialDist;
    let endIndex = 0;
    let lastPointIndex = startIndex
    let endPoint = new THREE.Vector3;
    const offsetAmount = i + 1 >= isocontours.length ? step : 2 * step;
    for (let j = 1; totalDist < offsetAmount; j++) {
      endIndex = startIndex - j;
      while (endIndex < 0) {
        endIndex += isocontours[i].length;
      }
      endIndex = endIndex % isocontours[i].length;
      const dist = isocontours[i][lastPointIndex].distanceTo(isocontours[i][endIndex]);
      if (totalDist + dist >= offsetAmount) {
        endPoint = pointAlongLine(isocontours[i][lastPointIndex], isocontours[i][endIndex], offsetAmount - totalDist);
      }
      totalDist += dist;
      lastPointIndex = endIndex;
    }

    let curIndex = startIndex;
    while(curIndex != endIndex) {
      path.push(isocontours[i][curIndex]);
      curIndex++;
      if (curIndex >= isocontours[i].length) {
        curIndex -= isocontours[i].length;
      }
    }
    path.push(isocontours[i][endIndex]);

    path.push(endPoint);

    const checkContourIndex = i + 2;
    if (checkContourIndex < isocontours.length) {
      let lowestDist = Infinity;
      let closestIndex = 0;
      let closestPoint = new THREE.Vector3;
      let lastPoint = isocontours[checkContourIndex][isocontours[checkContourIndex].length - 1];
      for (let j = 0; j < isocontours[checkContourIndex].length; j++) {
        const point = isocontours[checkContourIndex][j];
        const line = new THREE.Line3(lastPoint, point);
        let closestPointOnLine = new THREE.Vector3;
        line.closestPointToPoint(endPoint, true, closestPointOnLine);
        const dist = endPoint.distanceTo(closestPointOnLine);
        if (dist < lowestDist) {
          lowestDist = dist;
          closestIndex = j;
          closestPoint = closestPointOnLine;
        }

        lastPoint = point;
      }
      
      path.push(closestPoint);
      startIndex = closestIndex;
      initialDist = -isocontours[checkContourIndex][startIndex].distanceTo(closestPoint);
    }
  }

  return path;
}


export function connectIsocontours(
  isocontours: THREE.Vector3[][],
  step: number,
  lastLayerEndPoint: THREE.Vector3,
): THREE.Vector3[] {
  // if (isocontoursRoot.contour.length === 0) {
  //   return [];
  // }
  if (isocontours.length === 0) {
    return [];
  }
  isocontours[0].reverse();
  // isocontoursRoot.contour.reverse();
  // iso

  // const isocontours: THREE.Vector3[][] = [];

  // let currentNode = isocontoursRoot;
  // while (currentNode.children.length === 1) {
  //   isocontours.push(currentNode.contour);
  //   currentNode = currentNode.children[0];
  // }
  // isocontours.push(currentNode);

  let startIndex = 0;
  let startPoint = new THREE.Vector3;
  let lowestDist = Infinity;
  let lastPointIndex = isocontours[0].length - 1;
  for (let i = 0; i < isocontours[0].length; i++) {
    const point = isocontours[0][i];
    const line = new THREE.Line3(isocontours[0][lastPointIndex], point);
    let closestPointOnLine = new THREE.Vector3;
    line.closestPointToPoint(lastLayerEndPoint, true, closestPointOnLine);
    const dist = lastLayerEndPoint.distanceTo(closestPointOnLine);
    if (dist < lowestDist) {
      lowestDist = dist;
      startIndex = i;
      startPoint = closestPointOnLine;
    }
    lastPointIndex = i;
  }

  isocontours[0].splice(startIndex, 0, startPoint);


  const oddIndices: number[] = [];
  const evenIndices: number[] = [];

  for (let i = 0; i < isocontours.length; i++) {
    if (i % 2  === 0) {
      evenIndices.push(i);
    } else {
      oddIndices.push(i);
    }
  }

  // make inwards path
  const path = spiralContours(isocontours, evenIndices, startIndex, step);

  if (isocontours.length > 1) {
    let totalDist = 0;
    let endIndex = 0;
    let lastPointIndex = startIndex
    let endPoint = new THREE.Vector3;
    const offsetAmount = step;
    for (let j = 1; totalDist < offsetAmount; j++) {
      endIndex = startIndex - j;
      while (endIndex < 0) {
        endIndex += isocontours[0].length;
      }
      endIndex = endIndex % isocontours[0].length;
      const dist = isocontours[0][lastPointIndex].distanceTo(isocontours[0][endIndex]);
      if (totalDist + dist >= offsetAmount) {
        endPoint = pointAlongLine(isocontours[0][lastPointIndex], isocontours[0][endIndex], offsetAmount - totalDist);
      }
      totalDist += dist;
      lastPointIndex = endIndex;
    }

    let lowestDist = Infinity;
    startIndex = 0;
    let lastPoint = isocontours[1][isocontours[1].length - 1];
    let closestPoint = new THREE.Vector3;
    for (let j = 0; j < isocontours[1].length; j++) {
      const point = isocontours[1][j];
      const line = new THREE.Line3(lastPoint, point);
      let closestPointOnLine = new THREE.Vector3;
      line.closestPointToPoint(endPoint, true, closestPointOnLine);
      const dist = endPoint.distanceTo(closestPointOnLine);
      if (dist < lowestDist) {
        lowestDist = dist;
        startIndex = j;
        closestPoint = closestPointOnLine;
      }
      lastPoint = point;
    }

    isocontours[1].splice(startIndex, 0, closestPoint);

    // make outwards path
    const inwardSpiralPath = spiralContours(isocontours, oddIndices, startIndex, step);
    path.push(...inwardSpiralPath.reverse());
    path.push(endPoint);
  }
  return path
}


// function connectIsocontourTree(
//   root: ContourNode,
//   step: number,
// ): THREE.Vector3[] {
//   const isocontours: THREE.Vector3[][] = [];
//   const path: THREE.Vector3[] = [];
//   let currentNode = root;
//   while (currentNode.children.length === 1) {
//     isocontours.push(currentNode.contour);
//     currentNode = currentNode.children[0];
//   }
//   isocontours.push(currentNode.contour);
//   path.push(...connectIsocontours(isocontours, step, new THREE.Vector3));
// }


export function generateInsetContours(
  outer: THREE.Vector3[],
  holes: THREE.Vector3[][],
  step: number
): THREE.Vector2[][] {
  const inputLoops = preparePaths(outer, holes);
  const co = new ClipperLib.ClipperOffset(
    2,
    ClipperLib.ClipperOffset.def_arc_tolerance
  );

  // convert input loops to clipper format
  let current: ClipperLib.IntPoint[][] = inputLoops.map(toClipperPath);
  const allInsets: THREE.Vector2[][] = [];

  // iteratively inset until nothing remains
  while (current.length) {
    co.Clear();
    // add all loops (outer and holes), ClipperOffset will handle each
    current.forEach(path =>
      co.AddPath(
        path,
        ClipperLib.JoinType.jtRound,
        ClipperLib.EndType.etClosedPolygon
      )
    );

    const next: ClipperLib.Paths = [];
    co.Execute(next, -step * CLIPPER_SCALE);

    // filter out degenerate pieces
    const filtered = next.filter(p => Math.abs(clipperArea(p)) > MIN_AREA);
    if (!filtered.length) break;

    filtered.forEach(p => allInsets.push(fromClipperPath(p)));
    current = filtered;
  }

  return allInsets;
}


/**
 * Generates the contours for a boundary/brim around a mesh.
 * 
 * @param {THREE.Mesh} mesh - The mesh to make the contours for.
 * @param {number} offset - How offset the contours should be from the mesh.
 * @returns {THREE.Vector3[][]} A matrix containing the contours as a list of ordered points.
 */
export function generateBoundaryContours(
  mesh: THREE.Mesh,
  offset: number
): THREE.Vector3[][] {
  // get ordered set of points representing the boundary of the bottom layer
  const baseContours: THREE.Vector3[][] = connectSegments(getBaseContour(mesh));

  // push the contours out by offset
  const expandedContours: THREE.Vector3[][] = [];
  for (const contour of baseContours) {
    expandedContours.push(offsetContour(contour, offset));
  }

  // align contour with model
  expandedContours.forEach(contour => contour.forEach(p => p.add(mesh.position)));
  return expandedContours;
}


/**
 * Gets the contour of the bottom of a mesh.
 * 
 * @private
 * @param {THREE.Mesh} mesh - The mesh to get the base contour from.
 * @returns {{ start: THREE.Vector3; end: THREE.Vector3 }[]} The contour in the form of a list of line segments.
 */
export function getBaseContour(mesh: THREE.Mesh): { start: THREE.Vector3; end: THREE.Vector3 }[] {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const positions = geometry.attributes.position.array as Float32Array;

  // find the minimum z value
  let minZ = Infinity;
  for (let i = 2; i < positions.length; i += 3) {
      minZ = Math.min(minZ, positions[i]);
  }
  minZ += 0.01; // add a small amount to avoid issues with being exactly at the bottom of the mesh

  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -minZ);

  return getSegmentsFromMesh(mesh, plane);
}


/**
 * Expands a contour outwards (or inwards if offset is negative) by a given amount.
 * 
 * @param {THREE.Vector3[]} contour The contour to be offset.
 * @param {number} offset How much to offset the contour outwards by.
 * @returns {THREE.Vector3[]} The offset contour.
 */
export function offsetContour(
  contour: THREE.Vector3[],
  offset: number,
): THREE.Vector3[] {
  const expandedContour: THREE.Vector3[] = [];
  for (let i = 0; i < contour.length; i++) {
    const point = contour[i];

    // compute the normal using the two points next to the current point
    const tangent = get_tangent_at_point(contour, i);
    let norm = new THREE.Vector2(-tangent.y, tangent.x).normalize();
    if (get_winding_order(contour)) {
      norm.negate();
    }

    expandedContour.push(new THREE.Vector3(point.x + norm.x * offset, 
                                            point.y + norm.y * offset, 
                                            point.z));
  }
  return expandedContour;
}


function get_tangent_at_point(
  contour: THREE.Vector3[],
  pointIndex: number
): THREE.Vector2 {
  const lastPoint = contour[(pointIndex - 1 + contour.length) % contour.length];
  const point = contour[pointIndex];
  const nextPoint = contour[(pointIndex + 1) % contour.length];

  const lastToCur = new THREE.Vector2(point.x - lastPoint.x, point.y - lastPoint.y).normalize();
  const curToNext = new THREE.Vector2(nextPoint.x - point.x, nextPoint.y - point.y).normalize();
  return lastToCur.add(curToNext).normalize();
}


function get_winding_order(
  contour: THREE.Vector3[]
): boolean {
  let signedArea = 0;
  for (let i = 1; i < contour.length; i++) {
    signedArea += contour[i - 1].x * contour[i].y - contour[i].x * contour[i - 1].y;
  }
  return signedArea > 0;
}