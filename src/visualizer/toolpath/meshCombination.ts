


// Old approach for tryig to merge two meshes, so ignore the top few methods

// src/toolpath/meshCombination.ts
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
/**
 * Creates a mesh from the top layer of toolpath points using a tube geometry
 * @param topLayerPoints Array of Vector3 points from the top toolpath layer
 * @param tubeRadius Radius of the tube (default: 0.1)
 * @returns THREE.Mesh representing the toolpath as a solid mesh
 */
export function createToolpathMesh(topLayerPoints: THREE.Vector3[], tubeRadius: number = 0.1): THREE.Mesh {
    if (topLayerPoints.length < 2) {
        console.warn("Not enough points to create toolpath mesh");
        return new THREE.Mesh();
    }
    // Create a curve from the points
    const curve = new THREE.CatmullRomCurve3(topLayerPoints);
    
    // Create tube geometry along the curve
    const tubeGeometry = new THREE.TubeGeometry(curve, Math.max(topLayerPoints.length * 2, 64), tubeRadius, 8, false);
    
    // Ensure proper normals
    tubeGeometry.computeVertexNormals();
    
    const material = new THREE.MeshStandardMaterial({ 
        color: 0x00ff00,
        metalness: 0.1,
        roughness: 0.7,
        side: THREE.DoubleSide // Ensure visibility from both sides
    });
    
    return new THREE.Mesh(tubeGeometry, material);
}
/**
 * Combines all dot meshes into a single merged mesh
 * @param dotGroup THREE.Group containing all the dot meshes
 * @param modelPosition Position of the model to offset the dots relative to
 * @returns THREE.Mesh with all dots merged into one geometry
 */
export function createCombinedDotMesh(dotGroup: THREE.Group, modelPosition: THREE.Vector3 = new THREE.Vector3()): THREE.Mesh {
    const geometries: THREE.BufferGeometry[] = [];
    
    dotGroup.traverse((child) => {
        if (child instanceof THREE.Mesh && child.geometry) {
            // Clone the geometry
            const clonedGeometry = child.geometry.clone();
            
            // Apply the child's world matrix
            child.updateMatrixWorld(true);
            clonedGeometry.applyMatrix4(child.matrixWorld);
            
            // Adjust position relative to model position
            const offsetMatrix = new THREE.Matrix4();
            offsetMatrix.makeTranslation(-modelPosition.x, -modelPosition.y, -modelPosition.z);
            clonedGeometry.applyMatrix4(offsetMatrix);
            
            // Normalize the geometry
            const normalizedGeometry = normalizeGeometry(clonedGeometry);
            if (normalizedGeometry) {
                geometries.push(normalizedGeometry);
            }
        }
    });
    
    if (geometries.length === 0) {
        console.warn("No dot geometries found to combine");
        return new THREE.Mesh();
    }
    
    console.log(`Combining ${geometries.length} dot geometries`);
    
    try {
        // Merge all geometries into one
        const mergedGeometry = BufferGeometryUtils.mergeGeometries(geometries, false);
        
        if (!mergedGeometry) {
            throw new Error("Failed to merge geometries");
        }
        
        // Ensure proper normals for the merged geometry
        mergedGeometry.computeVertexNormals();
        
        const material = new THREE.MeshStandardMaterial({ 
            color: 0xff0000,
            metalness: 0.1,
            roughness: 0.7,
            side: THREE.DoubleSide
        });
        
        console.log(`Combined dot mesh created with ${mergedGeometry.attributes.position.count} vertices`);
        
        return new THREE.Mesh(mergedGeometry, material);
    } catch (error) {
        console.error("Error merging dot geometries:", error);
        // Return a simple sphere as fallback
        const fallbackGeometry = new THREE.SphereGeometry(0.1, 8, 8);
        const material = new THREE.MeshStandardMaterial({ color: 0xff0000 });
        return new THREE.Mesh(fallbackGeometry, material);
    }
}
/**
 * Combines toolpath mesh and dot mesh into a single mesh
 * @param toolpathMesh The mesh created from toolpath points
 * @param dotMesh The combined mesh of all dots
 * @returns THREE.Mesh combining both meshes
 */
export function combineToolpathAndDots(toolpathMesh: THREE.Mesh, dotMesh: THREE.Mesh): THREE.Mesh {
    const geometries: THREE.BufferGeometry[] = [];
    
    // Process toolpath mesh
    if (toolpathMesh.geometry && toolpathMesh.geometry.attributes.position.count > 0) {
        const toolpathGeometry = toolpathMesh.geometry.clone();
        toolpathMesh.updateMatrixWorld(true);
        toolpathGeometry.applyMatrix4(toolpathMesh.matrixWorld);
        const normalizedToolpath = normalizeGeometry(toolpathGeometry);
        if (normalizedToolpath) {
            geometries.push(normalizedToolpath);
            console.log(`Toolpath geometry: ${normalizedToolpath.attributes.position.count} vertices`);
        }
    }
    
    // Process dot mesh
    if (dotMesh.geometry && dotMesh.geometry.attributes.position.count > 0) {
        const dotGeometry = dotMesh.geometry.clone();
        dotMesh.updateMatrixWorld(true);
        dotGeometry.applyMatrix4(dotMesh.matrixWorld);
        const normalizedDot = normalizeGeometry(dotGeometry);
        if (normalizedDot) {
            geometries.push(normalizedDot);
            console.log(`Dot geometry: ${normalizedDot.attributes.position.count} vertices`);
        }
    }
    
    if (geometries.length === 0) {
        console.warn("No geometries to combine");
        return new THREE.Mesh();
    }
    
    try {
        const mergedGeometry = BufferGeometryUtils.mergeGeometries(geometries, false);
        
        if (!mergedGeometry) {
            throw new Error("Failed to merge geometries");
        }
        
        // Compute normals for the final merged geometry
        mergedGeometry.computeVertexNormals();
        
        const material = new THREE.MeshStandardMaterial({ 
            color: 0x00ffff, // Cyan for the combined mesh
            metalness: 0.1,
            roughness: 0.7,
            wireframe: false,
            side: THREE.DoubleSide
        });
        
        const combinedMesh = new THREE.Mesh(mergedGeometry, material);
        
        console.log(`Final combined mesh: ${mergedGeometry.attributes.position.count} vertices`);
        console.log(`Triangle count: ${mergedGeometry.attributes.position.count / 3}`);
        
        return combinedMesh;
    } catch (error) {
        console.error("Error merging geometries:", error);
        // Return just the toolpath mesh as fallback
        return toolpathMesh;
    }
}
/**
 * Normalizes geometry attributes to ensure compatibility for merging
 * @param geometry The geometry to normalize
 * @returns Normalized geometry or null if invalid
 */
function normalizeGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry | null {
    try {
        // Check if geometry has valid position attribute
        if (!geometry.attributes.position || geometry.attributes.position.count === 0) {
            console.warn("Geometry has no position data");
            return null;
        }
        
        // Convert to non-indexed if needed
        let processedGeometry = geometry;
        if (geometry.index) {
            processedGeometry = geometry.toNonIndexed();
        }
        
        // Ensure normals exist and are computed
        if (!processedGeometry.attributes.normal) {
            processedGeometry.computeVertexNormals();
        }
        //
        if (!processedGeometry.attributes.uv) {
            const positionCount = processedGeometry.attributes.position.count;
            const uvs = new Float32Array(positionCount * 2);
            // Initialize with valid UV coordinates (0-1 range)
            for (let i = 0; i < positionCount * 2; i += 2) {
                uvs[i] = 0.5;     // U coordinate
                uvs[i + 1] = 0.5; // V coordinate
            }
            processedGeometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        }
        // Clear morph attributes that can cause issues
        processedGeometry.morphAttributes = {};
        
        // Remove any groups that might cause issues
        processedGeometry.clearGroups();
        
        return processedGeometry;
    } catch (error) {
        console.error("Error normalizing geometry:", error);
        return null;
    }
}


// Quick export stl, this is used as a testing thing for you to just see the mesh
// this mesh will need to be sent to travel slicer, which currently has an error going through it
/**
 * Immediately exports and downloads a mesh as STL using Three.js built-in exporter
 * @param mesh The mesh to export
 * @param filename Optional filename (defaults to timestamp)
 */
export function quickExportSTL(mesh: THREE.Mesh, filename?: string): void {
    if (!mesh.geometry) {
        console.warn('No geometry to export');
        return;
    }
    // Generate filename with timestamp if not provided
    const name = filename || `mesh_${Date.now()}`;
    
    try {
        // Create STL exporter
        const exporter = new STLExporter();
        
        // Export mesh to STL string 
        const stlString = exporter.parse(mesh);
        
        // Auto-download
        const blob = new Blob([stlString], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}.stl`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log(`✅ STL downloaded: ${name}.stl`);
        
    } catch (error) {
        console.error('Export failed:', error);
    }
}


// Here we convert toolpath points along with the dots into a mesh
// thisshould be transfered to the travel slicer


// 
/**
 * Converts toolpath points to a point cloud with specified density
 * @param toolpathPoints Array of Vector3 points from toolpath
 * @param density Number of points per unit length along the path (default: 5)
 * @returns Array of Vector3 points representing the toolpath as a point cloud
 */
export function toolpathToPointCloud(toolpathPoints: THREE.Vector3[], density: number = 5): THREE.Vector3[] {
    if (toolpathPoints.length < 2) {
        return toolpathPoints.slice(); // Return copy of original points
    }
    const pointCloud: THREE.Vector3[] = [];
    
    for (let i = 0; i < toolpathPoints.length - 1; i++) {
        const start = toolpathPoints[i];
        const end = toolpathPoints[i + 1];
        const distance = start.distanceTo(end);
        const numPoints = Math.max(1, Math.floor(distance * density));
        
        // Add interpolated points along the segment
        for (let j = 0; j <= numPoints; j++) {
            const t = j / numPoints;
            const interpolatedPoint = start.clone().lerp(end, t);
            pointCloud.push(interpolatedPoint);
        }
    }
    
    console.log(`Converted toolpath to point cloud: ${pointCloud.length} points`);
    return pointCloud;
}


// ensures that the dots are near the toolpath, wiht customizable parameters (need to add into gui)
/**
 * Extracts point cloud from dot visualization group and translates dots to sit above toolpath
 * PRESERVES the original curvature of the dots while lifting them above toolpath
 * NOW FILTERS to only include dots that are near the toolpath
 * @param dotGroup THREE.Group containing dot meshes
 * @param toolpathTopLayer Array of Vector3 points representing the top layer of toolpath
 * @param modelPosition Position of the model to offset the dots relative to
 * @param dotOffsetZ Additional Z offset to place dots slightly above toolpath (default: 0.5)
 * @param proximityThreshold Maximum distance from toolpath to include a dot (default: 10.0)
 * @returns Array of Vector3 points representing dot positions with preserved curvature, filtered by proximity to toolpath
 */
export function extractAndTranslateDotPointCloud(
    dotGroup: THREE.Group, 
    toolpathTopLayer: THREE.Vector3[],
    modelPosition: THREE.Vector3 = new THREE.Vector3(),
    dotOffsetZ: number = 0.5,
    proximityThreshold: number = 10.0  // NEW PARAMETER
): THREE.Vector3[] {
    const pointCloud: THREE.Vector3[] = [];
    
    // Find the Z-coordinate range of the toolpath top layer
    if (toolpathTopLayer.length === 0) {
        console.warn("No toolpath top layer points provided");
        return pointCloud;
    }
    
    // Calculate the average Z height of the top layer
    const zHeights = toolpathTopLayer.map(point => point.z);
    const toolpathTopZ = zHeights.reduce((sum, z) => sum + z, 0) / zHeights.length;
    const minToolpathZ = Math.min(...zHeights);
    const maxToolpathZ = Math.max(...zHeights);
    
    console.log(`Toolpath top layer Z: avg=${toolpathTopZ.toFixed(3)}, min=${minToolpathZ.toFixed(3)}, max=${maxToolpathZ.toFixed(3)}`);
    
    // First, collect all original dot positions to understand their Z range
    const originalDotPositions: THREE.Vector3[] = [];
    dotGroup.traverse((child) => {
        if (child instanceof THREE.Mesh) {
            const worldPosition = new THREE.Vector3();
            child.getWorldPosition(worldPosition);
            const adjustedPosition = worldPosition.clone().sub(modelPosition);
            originalDotPositions.push(adjustedPosition);
        }
    });
    
    if (originalDotPositions.length === 0) {
        console.warn("No dots found in dot group");
        return pointCloud;
    }
    
    // Calculate the Z range of the original dots to understand their curvature
    const originalDotZs = originalDotPositions.map(p => p.z);
    const minDotZ = Math.min(...originalDotZs);
    const maxDotZ = Math.max(...originalDotZs);
    const dotZRange = maxDotZ - minDotZ;
    
    console.log(`Original dots Z range: min=${minDotZ.toFixed(3)}, max=${maxDotZ.toFixed(3)}, range=${dotZRange.toFixed(3)}`);
    
    //Filter dots by proximity to toolpath before translation
    let filteredCount = 0;
    let totalCount = 0;
    
    // Now translate each dot to preserve curvature relative to toolpath
    // BUT ONLY if it's close enough to the toolpath
    originalDotPositions.forEach((dotPos, index) => {
        totalCount++;
        
        // NEW: Check if this dot is close enough to any toolpath point
        const isNearToolpath = toolpathTopLayer.some(toolpathPoint => {
            // Calculate 2D distance (X,Y only) between dot and toolpath point
            const distance2D = Math.sqrt(
                Math.pow(dotPos.x - toolpathPoint.x, 2) + 
                Math.pow(dotPos.y - toolpathPoint.y, 2)
            );
            return distance2D <= proximityThreshold;
        });
        
        // Only process dots that are near the toolpath
        if (!isNearToolpath) {
            return; // Skip this dot
        }
        
        filteredCount++;
        
        // Calculate the relative height of this dot within its original Z range (0 to 1)
        const relativeHeight = dotZRange > 0 ? (dotPos.z - minDotZ) / dotZRange : 0;
        
        // Map this relative height to the toolpath Z range plus offset
        const toolpathZRange = maxToolpathZ - minToolpathZ;
        const newZ = minToolpathZ + dotOffsetZ + (relativeHeight * toolpathZRange);
        
        const translatedPosition = new THREE.Vector3(
            dotPos.x,
            dotPos.y,
            newZ  // Preserve relative curvature above toolpath
        );
        
        pointCloud.push(translatedPosition);
    });
    
    console.log(`Filtered dots by proximity: ${filteredCount}/${totalCount} dots within ${proximityThreshold} units of toolpath`);
    console.log(`Extracted and translated ${pointCloud.length} dots preserving curvature`);
    
    // Log
    const sampleSize = Math.min(3, pointCloud.length);
    console.log(`Sample translated positions (preserving curvature):`);
    for (let i = 0; i < sampleSize; i++) {
        const original = originalDotPositions.find((_, origIndex) => {
            // Find the corresponding original position for this filtered dot
            let currentFilteredIndex = 0;
            for (let j = 0; j <= origIndex; j++) {
                const origDot = originalDotPositions[j];
                const isNear = toolpathTopLayer.some(tp => {
                    const dist2D = Math.sqrt(
                        Math.pow(origDot.x - tp.x, 2) + 
                        Math.pow(origDot.y - tp.y, 2)
                    );
                    return dist2D <= proximityThreshold;
                });
                if (isNear) {
                    if (currentFilteredIndex === i) return true;
                    currentFilteredIndex++;
                }
            }
            return false;
        });
        
        if (original) {
            const translated = pointCloud[i];
            console.log(`  Dot ${i}: Original Z=${original.z.toFixed(3)} -> Translated Z=${translated.z.toFixed(3)}`);
        }
    }
    
    return pointCloud;
}
/**
 * ORIGINAL: Extracts point cloud from dot visualization group (unchanged for compatibility)
 */
export function extractDotPointCloud(dotGroup: THREE.Group, modelPosition: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3[] {
    const pointCloud: THREE.Vector3[] = [];
    
    dotGroup.traverse((child) => {
        if (child instanceof THREE.Mesh) {
            // Get the world position of each dot
            const worldPosition = new THREE.Vector3();
            child.getWorldPosition(worldPosition);
            
            // Adjust position relative to model position if needed
            const adjustedPosition = worldPosition.clone().sub(modelPosition);
            pointCloud.push(adjustedPosition);
        }
    });
    
    console.log(`Extracted ${pointCloud.length} points from dot group`);
    return pointCloud;
}
/**
 * Combines multiple point clouds into one unified point cloud
 * @param pointClouds Array of point cloud arrays to combine
 * @returns Combined point cloud array
 */
export function combinePointClouds(...pointClouds: THREE.Vector3[][]): THREE.Vector3[] {
    const combined: THREE.Vector3[] = [];
    
    pointClouds.forEach((cloud, index) => {
        console.log(`Adding point cloud ${index}: ${cloud.length} points`);
        combined.push(...cloud);
    });
    
    console.log(`Combined point cloud total: ${combined.length} points`);
    return combined;
}

/**
 * Creates a mesh from a point cloud using individual spheres for each point
 * This preserves the individual dot appearance unlike ConvexGeometry
 * @param pointCloud Array of Vector3 points
 * @param dotRadius Radius of each dot sphere (default: 1.0)
 * @param dotResolution Resolution of each sphere (default: 8)
 * @returns THREE.Mesh created from individual spheres merged together
 */
export function pointCloudToMesh(
    pointCloud: THREE.Vector3[], 
    dotRadius: number = 1.0,
    dotResolution: number = 8
): THREE.Mesh {
    if (pointCloud.length === 0) {
        console.warn("Empty point cloud provided");
        return new THREE.Mesh();
    }
    console.log(`Creating mesh from ${pointCloud.length} points using sphere method`);
    try {
        // Create a base sphere geometry that we'll reuse for each point
        const baseSphereGeometry = new THREE.SphereGeometry(dotRadius, dotResolution, dotResolution);
        const geometries: THREE.BufferGeometry[] = [];
        // Create a sphere for each point in the cloud
        pointCloud.forEach((point, index) => {
            // Clone the base sphere geometry
            const sphereGeometry = baseSphereGeometry.clone();
            
            // Position the sphere at the point location
            sphereGeometry.translate(point.x, point.y, point.z);
            
            // Ensure proper normals
            sphereGeometry.computeVertexNormals();
            
            geometries.push(sphereGeometry);
            
            // Log progress for large point clouds
            if (index > 0 && index % 1000 === 0) {
                console.log(`Processed ${index}/${pointCloud.length} points`);
            }
        });
        console.log(`Created ${geometries.length} sphere geometries, merging...`);
        // Merge all sphere geometries into one
        const mergedGeometry = BufferGeometryUtils.mergeGeometries(geometries, false);
        
        if (!mergedGeometry) {
            throw new Error("Failed to merge sphere geometries");
        }
        // Ensure proper normals for the merged geometry
        mergedGeometry.computeVertexNormals();
        
        const material = new THREE.MeshStandardMaterial({ 
            color: 0x00ffff,
            metalness: 0.1,
            roughness: 0.7,
            side: THREE.DoubleSide
        });
        
        console.log(`Merged sphere mesh created with ${mergedGeometry.attributes.position.count} vertices`);
        console.log(`Triangle count: ${mergedGeometry.attributes.position.count / 3}`);
        
        // Clean up the base geometry
        baseSphereGeometry.dispose();
        
        return new THREE.Mesh(mergedGeometry, material);
        
    } catch (error) {
        console.error("Error creating sphere mesh:", error);
        // Fallback: single large sphere
        const fallbackGeometry = new THREE.SphereGeometry(dotRadius * 2, 16, 16);
        const material = new THREE.MeshStandardMaterial({ color: 0xff0000 });
        return new THREE.Mesh(fallbackGeometry, material);
    }
}

/**
 * Creates a  mesh from toolpath points using ConvexGeometry or alternative
 * This creates a continuous surface instead of individual spheres
 */
function createSolidToolpathMesh(toolpathPoints: THREE.Vector3[]): THREE.Mesh {
    if (toolpathPoints.length === 0) {
        console.warn("No toolpath points provided");
        return new THREE.Mesh();
    }
    console.log(`Creating solid toolpath mesh from ${toolpathPoints.length} points`);
    try {
        // Method 1: Try ConvexGeometry
        if (typeof ConvexGeometry !== 'undefined') {
            const convexGeometry = new ConvexGeometry(toolpathPoints);
            convexGeometry.computeVertexNormals();
            
            const material = new THREE.MeshStandardMaterial({
                color: 0x00ff00, // Green for toolpath
                metalness: 0.1,
                roughness: 0.7,
                side: THREE.DoubleSide
            });
            
            console.log("Created solid toolpath using ConvexGeometry");
            return new THREE.Mesh(convexGeometry, material);
        }
        
        // Method 2: Fallback - Create a thick extruded path
        console.log("ConvexGeometry not available, using extruded path method");
        return createExtrudedToolpathMesh(toolpathPoints);
        
    } catch (error) {
        console.error("Error creating solid toolpath mesh:", error);
        // Method 3: Final fallback - single solid shape
        return createFallbackToolpathMesh(toolpathPoints);
    }
}
/**
 * Creates an extruded mesh along the toolpath for a solid appearance
 */
function createExtrudedToolpathMesh(toolpathPoints: THREE.Vector3[]): THREE.Mesh {
    if (toolpathPoints.length < 2) {
        return new THREE.Mesh();
    }
    // Create a path from the toolpath points
    const curve = new THREE.CatmullRomCurve3(toolpathPoints);
    
    // Create a cross-section for the toolpath
    const shape = new THREE.Shape();
    const width = 2.0; // can adjust
    const height = 1.0; // can adjust
    
    shape.moveTo(-width/2, -height/2);
    shape.lineTo(width/2, -height/2);
    shape.lineTo(width/2, height/2);
    shape.lineTo(-width/2, height/2);
    shape.closePath();
    // Extrude the shape along the curve
    const extrudeSettings = {
        steps: Math.max(10, toolpathPoints.length),
        bevelEnabled: false,
        extrudePath: curve
    };
    const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
        color: 0x00ff00, // Green for toolpath
        metalness: 0.1,
        roughness: 0.7,
        side: THREE.DoubleSide
    });
    console.log("Created extruded toolpath mesh");
    return new THREE.Mesh(geometry, material);
}
/**
 * Creates a simple solid shape as fallback
 */
function createFallbackToolpathMesh(toolpathPoints: THREE.Vector3[]): THREE.Mesh {
    // Calculate bounding box of toolpath points
    const box = new THREE.Box3().setFromPoints(toolpathPoints);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // Create a solid box that encompasses the toolpath
    const geometry = new THREE.BoxGeometry(size.x, size.y, Math.max(size.z, 1.0));
    geometry.translate(center.x, center.y, center.z);
    const material = new THREE.MeshStandardMaterial({
        color: 0x00ff00, // Green for toolpath
        metalness: 0.1,
        roughness: 0.7
    });
    console.log("Created fallback box toolpath mesh");
    return new THREE.Mesh(geometry, material);
}

/**
 * Updated main function to create combined mesh with  toolpath and dot spheres
 * proximity filtering for dots
 */
export function createCombinedPointCloudMesh(
    topLayerPoints: THREE.Vector3[], 
    dotGroup: THREE.Group, 
    modelPosition: THREE.Vector3 = new THREE.Vector3(),
    toolpathDensity: number = 5,
    dotRadius: number = 1.0,
    dotOffsetZ: number = 0.5,
    proximityThreshold: number = 15.0  // NEW PARAMETER
): THREE.Mesh {
    console.log("=== Creating combined mesh with SOLID toolpath and filtered dot spheres ===");
    console.log(`Input: ${topLayerPoints.length} top layer points, ${dotGroup.children.length} dots in group`);
    console.log(`Proximity threshold: ${proximityThreshold} units`);
    
    // Create toolpath mesh (not point cloud spheres)
    const solidToolpathMesh = createSolidToolpathMesh(topLayerPoints);
    console.log(`Step 1: Solid toolpath mesh created`);
    
    // Step 2: Extract dot positions and translate them to sit on top of toolpath
    // has filtering for proximity so only dots with the toolpath can be included
    const dotPointCloud = extractAndTranslateDotPointCloud(
        dotGroup, 
        topLayerPoints, 
        modelPosition, 
        dotOffsetZ,
        proximityThreshold  // Pass the proximity threshold
    );
    console.log(`Step 2: Filtered dot point cloud generated: ${dotPointCloud.length} points`);
    
    // Step 3: Create dot mesh using spheres 
    const dotMesh = pointCloudToMesh(
        dotPointCloud, 
        dotRadius,
        8
    );
    dotMesh.material = new THREE.MeshStandardMaterial({ 
        color: 0xff0000, // Red for dots
        metalness: 0.1,
        roughness: 0.7 
    });
    console.log(`Step 3: Dot spheres mesh created from ${dotPointCloud.length} filtered dots`);
    
    // Step 4: Merge the solid toolpath with dot spheres
    try {
        const geometries: THREE.BufferGeometry[] = [];
        
        // Add solid toolpath geometry
        if (solidToolpathMesh.geometry && solidToolpathMesh.geometry.attributes.position.count > 0) {
            const toolpathGeometry = solidToolpathMesh.geometry.clone();
            const normalizedToolpath = normalizeGeometry(toolpathGeometry);
            if (normalizedToolpath) {
                geometries.push(normalizedToolpath);
                console.log(`Added solid toolpath geometry: ${normalizedToolpath.attributes.position.count} vertices`);
            }
        }
        
        // Add dot spheres geometry
        if (dotMesh.geometry && dotMesh.geometry.attributes.position.count > 0) {
            const dotGeometry = dotMesh.geometry.clone();
            const normalizedDot = normalizeGeometry(dotGeometry);
            if (normalizedDot) {
                geometries.push(normalizedDot);
                console.log(`Added dot geometry: ${normalizedDot.attributes.position.count} vertices`);
            }
        }
        
        if (geometries.length === 0) {
            console.warn("No geometries to merge, returning solid toolpath only");
            return solidToolpathMesh;
        }
        
        const mergedGeometry = BufferGeometryUtils.mergeGeometries(geometries, false);
        
        if (!mergedGeometry) {
            throw new Error("Failed to merge geometries");
        }
        
        mergedGeometry.computeVertexNormals();
        
        // Final material
        const finalMaterial = new THREE.MeshStandardMaterial({ 
            color: 0x00ffff, // Cyan for combined mesh
            metalness: 0.1,
            roughness: 0.7,
            side: THREE.DoubleSide
        });
        
        const combinedMesh = new THREE.Mesh(mergedGeometry, finalMaterial);
        
        console.log(`=== Final combined mesh created ===`);
        console.log(`- Total vertices: ${mergedGeometry.attributes.position.count}`);
        console.log(`- Solid toolpath base with ${dotPointCloud.length} filtered dot spheres on top`);
        
        // Clean up temporary meshes
        solidToolpathMesh.geometry?.dispose();
        dotMesh.geometry?.dispose();
        
        return combinedMesh;
        
    } catch (error) {
        console.error("Error creating combined mesh:", error);
        console.log("Returning solid toolpath mesh as fallback");
        return solidToolpathMesh;
    }
}
// TO FIX:
// need to ensure that if dots are scaled, so are the dots for the mesh (right now have to physically scale, this isd an easy fix)
// after merging this into new branch, for some reason the dots don't always follow the exact curvature in the mesh
// version, so need to debug
// need to ensure the mesh can be sliced by travel slicer (PRIORITY)

