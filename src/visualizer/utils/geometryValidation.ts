import * as THREE from 'three';

/**
 * Checks if a BufferGeometry has valid index data
 * @param geometry - The geometry to validate
 * @returns true if geometry has an index with at least 1 triangle (3 indices)
 */
export function isValidGeometry(
  geometry: THREE.BufferGeometry | null | undefined
): boolean {
  if (!geometry) {
    return false;
  }

  if (!geometry.index) {
    return false;
  }

  if (geometry.index.count === 0) {
    return false;
  }

  // At least one triangle (3 indices)
  if (geometry.index.count < 3) {
    return false;
  }

  return true;
}

/**
 * Validates that a mesh's geometry has a valid bounding box
 * Checks for Infinity values and NaN
 * @param mesh - The mesh to validate
 * @returns true if bounding box is valid and finite
 */
export function hasValidBoundingBox(mesh: THREE.Mesh): boolean {
  if (!mesh || !mesh.geometry) {
    return false;
  }

  // Ensure bounding box is computed
  if (!mesh.geometry.boundingBox) {
    mesh.geometry.computeBoundingBox();
  }

  const bbox = mesh.geometry.boundingBox;

  if (!bbox) {
    return false;
  }

  // Check min values
  if (
    bbox.min.x === Infinity ||
    bbox.min.y === Infinity ||
    bbox.min.z === Infinity
  ) {
    return false;
  }

  // Check max values
  if (
    bbox.max.x === -Infinity ||
    bbox.max.y === -Infinity ||
    bbox.max.z === -Infinity
  ) {
    return false;
  }

  // Check for NaN values
  if (
    isNaN(bbox.min.x) ||
    isNaN(bbox.min.y) ||
    isNaN(bbox.min.z) ||
    isNaN(bbox.max.x) ||
    isNaN(bbox.max.y) ||
    isNaN(bbox.max.z)
  ) {
    return false;
  }

  // Ensure min < max for all axes
  if (
    bbox.min.x > bbox.max.x ||
    bbox.min.y > bbox.max.y ||
    bbox.min.z > bbox.max.z
  ) {
    return false;
  }

  return true;
}

/**
 * Gets a safe bounding box value or returns null
 * @param mesh - The mesh to get bounding box from
 * @returns The bounding box if valid, null otherwise
 */
export function getSafeBoundingBox(mesh: THREE.Mesh): THREE.Box3 | null {
  if (!hasValidBoundingBox(mesh)) {
    return null;
  }

  mesh.geometry.computeBoundingBox();
  const bbox = mesh.geometry.boundingBox;

  if (!bbox) {
    return null;
  }

  return bbox.clone();
}

/**
 * Validates a computed scalar value (like sliceZ)
 * @param value - The value to check
 * @returns true if value is a finite number
 */
export function isValidScalarValue(value: number): boolean {
  return typeof value === 'number' && isFinite(value) && !isNaN(value);
}

/**
 * Logs geometry validation info for debugging
 * @param mesh - The mesh to inspect
 * @param label - Optional label for the log
 */
export function logGeometryStatus(mesh: THREE.Mesh | undefined, label?: string): void {
  const prefix = label ? `[${label}]` : '';

  if (!mesh) {
    console.warn(`${prefix} Mesh is null/undefined`);
    return;
  }

  const geometry = mesh.geometry;

  if (!geometry) {
    console.warn(`${prefix} Geometry is null/undefined`);
    return;
  }

  const indexCount = geometry.index?.count ?? 0;
  const triangleCount = Math.floor(indexCount / 3);

  console.log(`${prefix} Geometry status:`, {
    hasIndex: !!geometry.index,
    indexCount,
    triangleCount,
    isValid: isValidGeometry(geometry),
    hasBoundingBox: !!geometry.boundingBox,
    boundingBoxValid: hasValidBoundingBox(mesh),
  });

  if (geometry.boundingBox) {
    console.log(`${prefix} Bounding box:`, {
      min: { x: geometry.boundingBox.min.x, y: geometry.boundingBox.min.y, z: geometry.boundingBox.min.z },
      max: { x: geometry.boundingBox.max.x, y: geometry.boundingBox.max.y, z: geometry.boundingBox.max.z },
    });
  }
}

/**
 * Validates geometry and logs detailed error info if invalid
 * Useful for debugging crashes
 * @param mesh - The mesh to validate
 * @param operationName - Name of the operation that needs valid geometry
 * @returns true if valid, false otherwise
 */
export function validateGeometryWithLogging(
  mesh: THREE.Mesh | undefined,
  operationName: string
): boolean {
  if (!mesh) {
    console.error(`${operationName}: Mesh is null/undefined`);
    return false;
  }

  const geometry = mesh.geometry;

  if (!geometry) {
    console.error(`${operationName}: Geometry is null/undefined`);
    return false;
  }

  if (!isValidGeometry(geometry)) {
    const indexCount = geometry.index?.count ?? 0;
    console.error(`${operationName}: Invalid geometry`, {
      hasIndex: !!geometry.index,
      indexCount,
      triangleCount: Math.floor(indexCount / 3),
      reason: indexCount === 0 ? 'No triangles in geometry' : 'Index is missing',
    });
    return false;
  }

  if (!hasValidBoundingBox(mesh)) {
    console.error(`${operationName}: Invalid bounding box`, {
      boundingBox: geometry.boundingBox,
    });
    return false;
  }

  return true;
}