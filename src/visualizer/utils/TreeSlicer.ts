import * as THREE from 'three';

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
        if (d1 === 0) {
            points.push(p1);
        }
        if (d2 === 0) {
            points.push(p2);
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
