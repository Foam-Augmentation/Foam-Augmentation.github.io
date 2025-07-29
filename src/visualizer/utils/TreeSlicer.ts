import * as THREE from 'three';
import ClipperLib from 'clipper-lib';
import Delaunator from 'delaunator';



const CLIPPER_SCALE = 1000;
const MIN_AREA = 3;


// basic data structures for slicing
export interface SliceRegion {
    id: string;
    height: number;
    contour: THREE.Vector3[];
    holes: THREE.Vector3[][];
    bounds: { min: THREE.Vector3; max: THREE.Vector3 };
}

export interface RegionNode {
    region: SliceRegion;
    children: RegionNode[];
    parent: RegionNode | null;
    layer: number;
    visited: boolean;
}

export interface ChunkNode {
  regions: SliceRegion[];
  children: ChunkNode[];
  parent: ChunkNode | null;
}

export interface PrintChunk {
    id: string;
    regions: SliceRegion[];
    minHeight: number;
    maxHeight: number;
    dependencies: PrintChunk[];
}


export interface ContourNode {
  contour: THREE.Vector3[];
  children: ContourNode[];
  parent: ContourNode | null;
}

// slice mesh into horizontal layers
export function sliceMeshIntoLayers(mesh: THREE.Mesh, deltaZ: number): { z: number, segments: { start: THREE.Vector3, end: THREE.Vector3 }[] }[] {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox!;
    
    const minZ = bbox.min.z + 0.00001;
    console.log("Minz: " + minZ);
    const maxZ = bbox.max.z + 0.000011;
    const layers: { z: number, segments: { start: THREE.Vector3, end: THREE.Vector3 }[] }[] = [];
    
    // go from bottom to top, slice every deltaZ
    for (let z = minZ; z <= maxZ; z += deltaZ) {
        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
        const segments = getSegmentsFromMesh(mesh, plane);
        layers.push({ z, segments });
    }
    
    return layers;
}


function pointInPolygon(point: THREE.Vector3, polygon: THREE.Vector3[]): boolean {
  let inside = false;
  const x = point.x, y = point.y;
  const n = polygon.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;

    const intersect = ((yi > y) !== (yj > y)) &&
                      (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);

    if (intersect) inside = !inside;
  }

  return inside;
}


// For now just samples one point from the contour so it cant handle contours that intersect
function contourContainsContour(
  contour1: THREE.Vector3[],
  contour2: THREE.Vector3[],
): boolean {
  return pointInPolygon(contour2[0], contour1);
}


function getHolesAndOuters(
  contours: THREE.Vector3[][],
): {outer: THREE.Vector3[], holes: THREE.Vector3[][]}[] {
  const holeContours: {outer: THREE.Vector3[], holes: THREE.Vector3[][]}[] = [];

  const isOuter: boolean[] = [];

  for (let i = 0; i < contours.length; i++) {
    isOuter.push(true);
  }

  for (let i = 0; i < contours.length; i++) {
    const contour1 = contours[i];
    const holes: THREE.Vector3[][] = [];
    for (let j = 0; j < contours.length; j++) {
      if (i != j) {
        const contour2 = contours[j];
        if (contourContainsContour(contour1, contour2)) {
          holes.push(contour2);
          isOuter[j] = false;
          // Make i false as well as otherwise we would push it twice
          isOuter[i] = false;
        }
      }
    }
    if (holes.length) {
      holeContours.push({
        outer: contour1,
        holes: holes,
      });
    }
  }

  for (let i = 0; i < isOuter.length; i++) {
    if (isOuter[i]) {
      holeContours.push({
        outer: contours[i],
        holes: [],
      });
    }
  }

  return holeContours;
}


// take line segments and make closed shapes
export function extractRegionsFromLayer(z: number, segments: { start: THREE.Vector3, end: THREE.Vector3 }[]): SliceRegion[] {
    if (segments.length === 0) return [];
    
    const contours = connectSegments(segments);

    const holeContours = getHolesAndOuters(contours);

    const regions: SliceRegion[] = [];
    
    // make a region for each contour we found
    for (let i = 0; i < holeContours.length; i++) {
        const contour = holeContours[i];
        const bounds = getBounds(contour.outer, z);
        
        regions.push({
            id: `region_${z.toFixed(3)}_${i}`,
            height: z,
            contour: contour.outer,
            holes: contour.holes,
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
export function getBounds(contour: THREE.Vector3[], z: number): { min: THREE.Vector3; max: THREE.Vector3 } {
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


/**
 * Determines if two regions overlap when only considering x and y dimensions.
 * Currently only uses a regions bounding box so is not perfectly accurate.
 * 
 * @param {SliceRegion} regionA The first region.
 * @param {SliceRegion} regionB The second region.
 * @returns {boolean} Whether or not the two regions overlap.
 */
export function checkOverlap(
  regionA: SliceRegion, 
  regionB: SliceRegion
): boolean {
    return !(
        regionA.bounds.max.x < regionB.bounds.min.x ||
        regionA.bounds.min.x > regionB.bounds.max.x ||
        regionA.bounds.max.y < regionB.bounds.min.y ||
        regionA.bounds.min.y > regionB.bounds.max.y
    );
}

// split regions into groups when they overlap (for support stuff)
// export function splitRegionsByOverlapOrSupport(regions: SliceRegion[]): SliceRegion[][] {
//     let groups: SliceRegion[][] = [regions];
//     let changed = true;
    
//     // keep splitting until no more overlaps
//     while (changed) {
//         changed = false;
//         const newGroups: SliceRegion[][] = [];
        
//         for (const group of groups) {
//             let splitIndex = -1;
//             let splitHeight = -1;
            
//             // look for overlapping regions at different heights
//             for (let i = 0; i < group.length; i++) {
//                 for (let j = 0; j < group.length; j++) {
//                     if (i === j) continue;
//                     const a = group[i];
//                     const b = group[j];
                    
//                     if (checkOverlap(a, b)) {
//                         if (a.height > b.height) {
//                             splitIndex = i;
//                             splitHeight = b.height;
//                             break;
//                         } else if (b.height > a.height) {
//                             splitIndex = j;
//                             splitHeight = a.height;
//                             break;
//                         }
//                     }
//                 }
//                 if (splitIndex !== -1) break;
//             }
            
//             if (splitIndex !== -1) {
//                 const above = group.filter(r => r.height > splitHeight);
//                 const below = group.filter(r => r.height <= splitHeight);
//                 if (above.length > 0 && below.length > 0) {
//                     newGroups.push(above, below);
//                     changed = true;
//                 } else {
//                     newGroups.push(group);
//                 }
//             } else {
//                 newGroups.push(group);
//             }
//         }
//         groups = newGroups;
//     }
    
//     return groups;
// }

/**
 * Build a tree of RegionNodes that encode hiearchy of slice regions. The tree starts from the bottom
 * of the model and goes upwards. If a region could have two parents, it just chooses the first it finds.
 * 
 * @param {SliceRegion[]} regions The list of slice regions to build the tree from.
 * @param {number} layerHeight The layer height of the slice regions.
 * @returns {RegionNode[]} The root nodes of the tree.
 */
export function buildRegionTree(
  regions: SliceRegion[], 
  layerHeight: number
): RegionNode[] {
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

    // sort in ascending order to start from the bottom of the tree
    // do this after making nodes because maps don't preserve order
    const sortedNodeRegions = Array.from(nodes.entries()).sort((a, b) => a[1].layer - b[1].layer)
    
    // figure out parent-child relationshipds
    for (let i = 0; i < sortedNodeRegions.length; i++) {
        const [id, node] = sortedNodeRegions[i];
        for (let j = i + 1; j < sortedNodeRegions.length; j++) {
            const [otherId, otherNode] = sortedNodeRegions[j];

            // break out of for loop after checking all nodes in the next layer down.
            if (otherNode.layer - node.layer > 1) {
                break;
            }

            if (otherNode.parent === null && checkOverlap(node.region, otherNode.region)) {
                node.children.push(otherNode);
                otherNode.parent = node;
            }
        }
    }
    
    // return root nodes (ones with no parent)
    const roots = Array.from(nodes.values()).filter(node => node.parent === null);
    
    return roots;
}


/**
 * Builds a tree of printable chunks from a tree of regions by splitting the regions into
 * super nodes and splitting the supernodes when they overlap. 
 * 
 * @param {RegionNode[]} roots The root nodes of the region tree.
 * @param {number} nozzleHeight The height of the nozzle.
 * @returns {ChunkNode[]} The root nodes of the printable chunk tree.
 */
export function buildChunkTree(
  roots: RegionNode[],
  nozzleHeight: number,
): ChunkNode[] {
  if (roots.length === 0) {
    return [];
  }
  const rootNodes: ChunkNode[] = [];
  for (const root of roots) {
    let currentChunkNode: ChunkNode = {
      regions: [],
      children: [],
      parent: null,
    }
    let currentNode = root;
    let regions: SliceRegion[] = [currentNode.region];
    while (true) {
      if (currentNode.children.length === 0) {
        currentChunkNode.regions = regions;
        rootNodes.push(currentChunkNode);
        break;
      }
      if (currentNode.children.length > 1 || currentNode.children[0].region.height - root.region.height > nozzleHeight) {
        currentChunkNode.regions = regions;
        currentChunkNode.children = buildChunkTree(currentNode.children, nozzleHeight);
        for (const child of currentChunkNode.children) {
          child.parent = currentChunkNode;
        }
        rootNodes.push(currentChunkNode);
        break;
      }
      currentNode = currentNode.children[0];
      regions.push(currentNode.region);
    }
  }
  splitChunkTreeByOverlap(rootNodes);
  return rootNodes;
}


function findHeightSiblings(
  roots: ChunkNode[],
  rootToFindSiblings: ChunkNode,
): ChunkNode[] {
  const rootMax  = rootToFindSiblings.regions[rootToFindSiblings.regions.length - 1].height;
  const siblings: ChunkNode[] = [];
  for (const root of roots) {
    const min = root.regions[0].height;
    const max = root.regions[root.regions.length - 1].height;
    if (min < rootMax && max > rootMax) {
      siblings.push(root);
    } else if (max < rootMax) {
      siblings.push(...findHeightSiblings(root.children, rootToFindSiblings));
    }
  }
  return siblings;
}


function splitChunkTreeByOverlap(
  roots: ChunkNode[],
): void {
  if (roots.length === 0) return;

  const allChildren: ChunkNode[] = [];

  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    const siblings = findHeightSiblings(roots.filter((root, idx) => idx != i), root);

    for (const sibling of siblings) {
      let foundOverlap = false;
      for (let j = 1; j < sibling.regions.length; j++) {
        for (let k = 0; k < root.regions.length; k++) {
          if (checkOverlap(sibling.regions[j], root.regions[k])) {
            const newNodeSibling: ChunkNode = {
              regions: sibling.regions.slice(j),
              children: sibling.children,
              parent: sibling,
            }
            sibling.children = [newNodeSibling];
            sibling.regions = sibling.regions.slice(0, j);
            foundOverlap = true;
            break;
          }
        }
      }
      if (foundOverlap) {
        break;
      }
    }
    allChildren.push(...root.children);
  }
  
  splitChunkTreeByOverlap(allChildren);
}


// create print chunks with dependencies for optimized printing
// export function buildChunksWithDependencies(regionGroups: SliceRegion[][], regionTree: RegionNode[]): PrintChunk[] {
//     const regionToChunk = new Map<string, PrintChunk>();
//     const chunks: PrintChunk[] = [];
    
//     // make chunks from groups
//     regionGroups.forEach((group, i) => {
//         if (group.length === 0) return;
        
//         const heights = group.map(r => r.height);
//         const minHeight = Math.min(...heights);
//         const maxHeight = Math.max(...heights);
        
//         const chunk: PrintChunk = {
//             id: `chunk_${i}_${minHeight.toFixed(3)}`,
//             regions: group,
//             minHeight,
//             maxHeight,
//             dependencies: []
//         };
        
//         chunks.push(chunk);
        
//         // map regions to their chunks
//         for (const region of group) {
//             regionToChunk.set(region.id, chunk);
//         }
//     });
    
//     // figure out dependencies between chunks
//     for (const chunk of chunks) {
//         const deps = new Set<PrintChunk>();
        
//         for (const region of chunk.regions) {
//             const parent = findParentInTree(region, regionTree);
//             if (parent) {
//                 const parentChunk = regionToChunk.get(parent.region.id);
//                 if (parentChunk && parentChunk !== chunk) {
//                     deps.add(parentChunk);
//                 }
//             }
//         }
        
//         chunk.dependencies = Array.from(deps);
//     }
    
//     return chunks;
// }

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
// export function topologicalSortChunks(chunks: PrintChunk[]): PrintChunk[] {
//     const sorted: PrintChunk[] = [];
//     const visited = new Set<string>();
    
//     function visitChunk(chunk: PrintChunk) {
//         if (visited.has(chunk.id)) return;
//         visited.add(chunk.id);
        
//         // visit dependencies first
//         for (const dep of chunk.dependencies) {
//             visitChunk(dep);
//         }
        
//         sorted.push(chunk);
//     }
    
//     for (const chunk of chunks) {
//         visitChunk(chunk);
//     }
    
//     return sorted;
// }


// Makes a clipper path from a 2D contour
function toClipperPath(loop: THREE.Vector2[]) {
  return loop.map(pt => ({
    X: Math.round(pt.x * CLIPPER_SCALE),
    Y: Math.round(pt.y * CLIPPER_SCALE),
  }));
}


// Gets a 2D contour from a clipper path
function fromClipperPath(path: ClipperLib.IntPoint[]) {
  return path.map(pt =>
    new THREE.Vector2(pt.X / CLIPPER_SCALE, pt.Y / CLIPPER_SCALE)
  );
}


// Gets the signed area of a clipper path
function clipperArea(path: ClipperLib.IntPoint[]) {
  let area = 0;
  for (let i = 0; i < path.length; i++) {
    const p1 = path[i], p2 = path[(i + 1) % path.length];
    area += p1.X * p2.Y - p2.X * p1.Y;
  }
  return area / 2;
}


/**
 * Helper function for generateInsetContourTree that prepares the outer contours and hole contours
 * by making them a consistent winding order (CCW for holes, CW for outer) and making them 2D.
 * 
 * @param {THREE.Vector3[]} outer The outer contour.
 * @param {THREE.Vector3[][]} holes The hole contours.
 * @returns {THREE.Vector2[][]} All of the 2D paths (outer and holes).
 */
function preparePaths(
  outer: THREE.Vector3[],
  holes: THREE.Vector3[][]
): THREE.Vector2[][] {
  if (getWindingOrder(outer)) {
    outer.reverse();
  }
  holes.forEach(hole => {
    if (!getWindingOrder(hole)) {
      hole.reverse();
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


export function pointAlongLine(
  a: THREE.Vector3,
  b: THREE.Vector3,
  distance: number
): THREE.Vector3 {
  const totalLen = a.distanceTo(b);
  if (totalLen === 0) return a.clone();
  const t = distance / totalLen;
  return a.clone().lerp(b, t);
}


/**
 * Helper function for connectIsocontours
 * Spirals a list of contours towards the center, only connecting contours in the indicesToSpiral
 * 
 * @param {THREE.Vector3[][]} isocontours The inset isocontours to spiral.
 * @param {number[]} indicesToSpiral The indices of the isocontours array to spiral.
 * @param {number} initialStartIndex Where to start spiralling from in the outermost isocontour.
 * @param {number} step How far apart each isocontour is.
 * @returns {THREE.Vector3[]} A list of points representing the inwards spiral.
 */
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

/**
 * Work in progress and buggy
 * Connects a tree of inset isocontours into a continous fermat sprial.
 * 
 * @param {ContourNode} isocontoursRoot The root node of the inset contour tree.
 * @param {number} step How far away each inset contour is from each other.
 * @param {THREE.Vector3} lastLayerEndPoint The endpoint of the last layer, this is included so it starts as close
 *                          as possible to the last layer to minimize travel time.
 * @returns {THREE.Vector3[]} A list of points making up the fermat spiral.
 */
export function connectIsocontours(
  // isocontours: THREE.Vector3[][],
  isocontoursRoot: ContourNode,
  step: number,
  lastLayerEndPoint: THREE.Vector3,
  reverse: boolean = false,
): THREE.Vector3[] {
  if (isocontoursRoot.contour.length === 0) {
    return [];
  }

  const isocontours: THREE.Vector3[][] = [];

  let currentNode = isocontoursRoot;
  while (currentNode.children.length === 1) {
    if (reverse) {
      isocontours.push(currentNode.contour.reverse());
    } else {
      isocontours.push(currentNode.contour);
    }
    currentNode = currentNode.children[0];
  }
  isocontours.push(currentNode.contour);

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

  // make paths for children nodes before spiralling outwards only if the most inward contour is spiralled inwards
  if (isocontours.length % 2 === 1 && currentNode.children.length > 0) {
    const childPaths: {path: THREE.Vector3[], index: number}[] = [];
    for (const child of currentNode.children) {
      lowestDist = Infinity;
      let closestIndexOuter = 0;
      for (let i = 0; i < Math.min(isocontours[isocontours.length - 1].length, path.length); i++) {
        const point = path[path.length - 1 - i];
        for (let j = 0; j < child.contour.length; j++) {
          const otherPoint = child.contour[j];
          const dist = point.distanceTo(otherPoint);
          if (dist < lowestDist) {
            lowestDist = dist;
            closestIndexOuter = path.length - 1 - i;
          }
        }
      }
      const childPath = connectIsocontours(child, step, path[closestIndexOuter], !reverse);
      childPaths.push({path: childPath, index: closestIndexOuter});
    }

    childPaths.sort((a, b) => b.index - a.index);

    const endIndices: number[] = [];

    for (let i = 0; i < childPaths.length; i++) {
      let totalDist = 0;
      let endIndex = 0;
      let lastPointIndex = childPaths[i].index;
      let endPoint = new THREE.Vector3;
      let numIndicesToDelete = 0;
      const offsetAmount = step;
      for (let j = 1; totalDist < offsetAmount; j++) {
        endIndex = (startIndex - j);
        const dist = path[lastPointIndex].distanceTo(path[endIndex]);
        if (totalDist + dist >= offsetAmount) {
          endPoint = pointAlongLine(path[lastPointIndex], path[endIndex], offsetAmount - totalDist);
        }
        totalDist += dist;
        lastPointIndex = endIndex;
      }

      endIndices.push(endIndex);
      childPaths[i].path.push(endPoint);
    }

    for (let i = 0; i < childPaths.length; i++) {
      path.splice(childPaths[i].index, 0, ...childPaths[i].path);
    }
  }


  // make outwards path
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

    const inwardSpiralPath = spiralContours(isocontours, oddIndices, startIndex, step);

    if (isocontours.length % 2 === 0 && currentNode.children.length > 0) {
      const childPaths: THREE.Vector3[][] = [];
      const childPathIndices: number[] = [];
      for (const child of currentNode.children) {
        lowestDist = Infinity;
        let closestIndexOuter = 0;
        for (let i = 0; i < Math.min(isocontours[isocontours.length - 1].length, path.length); i++) {
          const point = inwardSpiralPath[inwardSpiralPath.length - 1 - i];
          for (let j = 0; j < child.contour.length; j++) {
            const otherPoint = child.contour[j];
            const dist = point.distanceTo(otherPoint);
            if (dist < lowestDist) {
              lowestDist = dist;
              closestIndexOuter = i;
            }
          }
        }
        const childPath = connectIsocontours(child, step, inwardSpiralPath[closestIndexOuter]);
        childPaths.push(childPath);
        childPathIndices.push(closestIndexOuter);
      }

      for (let i = 0; i < childPaths.length; i++) {
        inwardSpiralPath.splice(childPathIndices[i], 0, ...childPaths[i]);
      }
    }

    path.push(...inwardSpiralPath.reverse());
    path.push(endPoint);
  }
  return path
}


/**
 * Makes a tree of inset contours, with the children of each node being the contours
 * contained within it.
 * 
 * @param {THREE.Vector3[]} outer The outer contour to start insetting from.
 * @param {THREE.Vector3[][]} holes Holes in the region to not generate inset contours inside.
 * @param {number} step How far away each inset contour should be.
 * @returns {ContourNode} The root node of the inset contour tree.
 */
export function generateInsetContourTree(
  outer: THREE.Vector3[],
  holes: THREE.Vector3[][],
  step: number
): ContourNode {
  const inputLoops = preparePaths(outer, holes);
  const co = new ClipperLib.ClipperOffset(
    2,
    ClipperLib.ClipperOffset.def_arc_tolerance
  );

  // convert input loops to clipper format
  let current: ClipperLib.IntPoint[][] = inputLoops.map(toClipperPath);

  const rootNode = {
    contour: outer,
    children: [],
    parent: null
  };
  let currentNodes: ContourNode[] = [rootNode];
  let holeNodes: ContourNode[] = holes.map(hole => {
    return {
      contour: hole,
      children: [],
      parent: null,
    };
  });

  const allHoleNodes: ContourNode[] = [...holeNodes];

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

    const filtered = next.filter(p => Math.abs(clipperArea(p)) > MIN_AREA);
    if (!filtered.length) break;

    const contours = filtered.map(p => fromClipperPath(p).map(point => new THREE.Vector3(point.x, point.y, outer[0].z)));

    const windingOrders = contours.map(contour => getWindingOrder(contour));
    const holeContours = contours.filter((c, idx) => !windingOrders[idx]);
    const normalContours = contours.filter((c, idx) => windingOrders[idx]);

    const nextHoleNodes: ContourNode[] = [];
    // extend hole nodes
    for (const holeContour of holeContours) {
      const containedHoleNodes: ContourNode[] = [];
      for (const holeNode of holeNodes) {
        if (contourContainsContour(holeContour, holeNode.contour)) {
          containedHoleNodes.push(holeNode);
        }
      }
      const newNode = {
        contour: holeContour.reverse(),
        children: containedHoleNodes,
        parent: null
      }

      for (const holeNode of containedHoleNodes) {
        holeNode.parent = newNode;
      }

      nextHoleNodes.push(newNode);
    }

    const nextNodes: ContourNode[] = [];

    // extend regular nodes
    for (const node of currentNodes) {
      for (const contour of normalContours) {
        if (contourContainsContour(node.contour, contour)) {
          const newNode: ContourNode = {
            contour: contour,
            children: [],
            parent: node,
          }
          node.children.push(newNode);
          nextNodes.push(newNode);
        }
      }
    }

    currentNodes = nextNodes;
    holeNodes = nextHoleNodes;

    allHoleNodes.push(...holeNodes);

    current = filtered;
  }

  const outerHoleNodes: ContourNode[] = allHoleNodes.filter(holeNode => !holeNode.parent);
  currentNodes = [rootNode];

  // push hole nodes to where they belong in the tree
  function assignHoleChildren(
    rootNodes: ContourNode[],
    holes: ContourNode[],
  ): void {
    const allChildren: ContourNode[] = [];
    for (const root of rootNodes) {
      const toRemoveIndices: number[] = [];

      for (let i = 0; i < holes.length; i++) {
        const hole = holes[i];

        if (contourContainsContour(root.contour, hole.contour)) {
          let containedByChild = false;
          for (const child of root.children) {
            if (contourContainsContour(child.contour, hole.contour)) {
              containedByChild = true;
              break;
            }
          }
          if (!containedByChild) {
            root.children.push(hole);
            toRemoveIndices.push(i);
          }
        }
      }

      if (toRemoveIndices.length > 0) {
        toRemoveIndices.sort((a, b) => b - a).forEach(i => {
          if (i >= 0 && i < holes.length) {
            holes.splice(i, 1);
          }
        }); 
      }

      allChildren.push(...root.children);
    }

    if (allChildren.length > 0 && holes.length > 0) {
      assignHoleChildren(allChildren, holes);
    }
  }

  assignHoleChildren(currentNodes, outerHoleNodes);

  rootNode.contour.reverse();

  return rootNode;
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
    const tangent = getTangentAtPoint(contour, i);
    let norm = new THREE.Vector2(-tangent.y, tangent.x).normalize();
    if (getWindingOrder(contour)) {
      norm.negate();
    }

    expandedContour.push(new THREE.Vector3(point.x + norm.x * offset, 
                                            point.y + norm.y * offset, 
                                            point.z));
  }
  return expandedContour;
}


function getTangentAtPoint(
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


export function getWindingOrder(
  contour: THREE.Vector3[]
): boolean {
  let signedArea = 0;
  for (let i = 1; i < contour.length; i++) {
    signedArea += contour[i - 1].x * contour[i].y - contour[i].x * contour[i - 1].y;
  }
  return signedArea > 0;
}



export function extractRegionsFromPointCloud(
  points: THREE.Vector3[],
  alpha: number = Infinity
): SliceRegion[] {
  if (points.length === 0) return [];

  const height = points[0].z;

  const coords = points.map(p => [p.x, p.y] as [number, number]);

  const delaunay = Delaunator.from(coords);
  const { triangles } = delaunay;

  // select only triangles with circumradius <= alpha
  const goodTris = new Set<number>();
  for (let t = 0; t < triangles.length; t += 3) {
    const [i0, i1, i2] = [triangles[t], triangles[t+1], triangles[t+2]];
    const [ax, ay] = coords[i0], [bx, by] = coords[i1], [cx, cy] = coords[i2];
    // side lengths
    const ab = Math.hypot(ax - bx, ay - by),
          bc = Math.hypot(bx - cx, by - cy),
          ca = Math.hypot(cx - ax, cy - ay);
    // triangle area via cross product
    const area = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
    if (area === 0) continue;
    // circumradius formula
    const R = (ab * bc * ca) / (4 * area);
    if (R <= alpha) goodTris.add(t / 3);
  }

  // build undirected edge‑count map for good triangles
  type EdgeKey = string;
  const edgeCount = new Map<EdgeKey, number>();
  for (const t of goodTris) {
    const base = 3 * t;
    const idxs = [triangles[base], triangles[base+1], triangles[base+2]];
    for (let k = 0; k < 3; k++) {
      const a = idxs[k], b = idxs[(k + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
    }
  }

  // extract boundary edges (those seen exactly once)
  const boundaryEdges: [number, number][] = [];
  for (const [key, cnt] of edgeCount.entries()) {
    if (cnt === 1) {
      const [sa, sb] = key.split(',').map(Number);
      boundaryEdges.push([sa, sb]);
    }
  }

  // build adjacency list of those edges
  const neigh = new Map<number, number[]>();
  for (const [u, v] of boundaryEdges) {
    if (!neigh.has(u)) neigh.set(u, []);
    if (!neigh.has(v)) neigh.set(v, []);
    neigh.get(u)!.push(v);
    neigh.get(v)!.push(u);
  }

  // traverse edges to form loops
  const visited = new Set<string>();
  const loopsIdx: number[][] = [];
  const mark = (u: number, v: number) => visited.add(`${u}_${v}`) && visited.add(`${v}_${u}`);

  for (const [u, vs] of neigh.entries()) {
    for (const v of vs) {
      if (visited.has(`${u}_${v}`)) continue;
      // start a new loop
      const loop = [u, v];
      mark(u, v);
      let prev = u, curr = v;
      while (true) {
        const nexts = neigh.get(curr)!;
        const next = nexts.find(w => w !== prev);
        if (next === undefined) break;
        mark(curr, next);
        if (next === loop[0]) break;
        loop.push(next);
        prev = curr; curr = next;
      }
      loopsIdx.push(loop);
    }
  }

  const loops = loopsIdx.map(idxs =>
    idxs.map(i => new THREE.Vector3(coords[i][0], coords[i][1], height))
  );

  const holeContours = getHolesAndOuters(loops);

  // build SliceRegion for each contour
  const regions: SliceRegion[] = holeContours.map((holeContour, i) => {
    const xs = holeContour.outer.map(p => p.x), ys = holeContour.outer.map(p => p.y);
    return {
      id:      `region-${i}`,
      height: height,
      contour: holeContour.outer,
      holes:   holeContour.holes,
      bounds: {
        min: new THREE.Vector3(Math.min(...xs), Math.min(...ys), 0),
        max: new THREE.Vector3(Math.max(...xs), Math.max(...ys), 0),
      }
    };
  });

  return regions;
}