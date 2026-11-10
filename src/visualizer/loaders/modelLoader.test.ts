import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createPixelGradient, parseStlGeometry, sampleMesh } from './modelLoader';

/** Builds a binary STL file holding the given triangles (9 numbers each). */
function binaryStl(triangles: number[][]): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, t) => {
    const offset = 84 + t * 50;
    // the normal (12 bytes) is left as zero
    triangle.forEach((value, i) => view.setFloat32(offset + 12 + i * 4, value, true));
  });
  return buffer;
}

describe('sampleMesh (S9)', () => {
  it('samples the top surface of a box on a grid', () => {
    const geometry = new THREE.BoxGeometry(10, 6, 4).toNonIndexed();
    const points = sampleMesh(new THREE.Mesh(geometry), 1);

    expect(points).toHaveLength(10);
    for (const column of points) {
      expect(column).toHaveLength(6);
      for (const p of column) {
        expect(p.z).toBeCloseTo(2, 6);
      }
    }
    expect(points[0][0].x).toBeCloseTo(-5, 6);
    expect(points[0][0].y).toBeCloseTo(-3, 6);
    expect(points[9][5].x).toBeCloseTo(4, 6);
    expect(points[9][5].y).toBeCloseTo(2, 6);
  });

  it('gives the same points as an un-accelerated raycast', () => {
    const geometry = new THREE.TorusKnotGeometry(10, 3, 64, 12).toNonIndexed();
    geometry.rotateX(0.4);
    const reference = new THREE.Mesh(geometry.clone(), new THREE.MeshBasicMaterial());
    reference.geometry.computeBoundingBox();
    const bbox = reference.geometry.boundingBox!;

    const points = sampleMesh(new THREE.Mesh(geometry), 1.5);

    let hits = 0;
    for (const column of points) {
      for (const p of column) {
        const raycaster = new THREE.Raycaster(new THREE.Vector3(p.x, p.y, bbox.max.z + 10), new THREE.Vector3(0, 0, -1));
        const expected = raycaster.intersectObject(reference);
        expect(expected.length).toBeGreaterThan(0);
        expect(p.distanceTo(expected[0].point)).toBeLessThan(1e-6);
        hits++;
      }
    }
    expect(hits).toBeGreaterThan(50);
  });

  it('skips grid points with nothing under them', () => {
    // a single triangle covers half of its bounding box
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 10, 0], 3));
    const points = sampleMesh(new THREE.Mesh(geometry), 1);
    const total = points.reduce((sum, column) => sum + column.length, 0);
    expect(total).toBeGreaterThan(30);
    expect(total).toBeLessThan(70);
  });

  it('throws on a grid size that would never finish', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    for (const gridSize of [0, -1, NaN, Infinity]) {
      expect(() => sampleMesh(mesh, gridSize)).toThrow(/Grid size/);
    }
  });
});

describe('createPixelGradient (G18, S13)', () => {
  // a 2 x 2 image: red, green / blue, white
  const pixels = new Uint8ClampedArray([
    255, 0, 0, 255,   0, 255, 0, 255,
    0, 0, 255, 255,   255, 255, 255, 128,
  ]);
  const gradient = createPixelGradient(2, 2, pixels);

  it('looks colours up by pixel', () => {
    expect(gradient.width).toBe(2);
    expect(gradient.height).toBe(2);
    expect(gradient.sampleColor(0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(gradient.sampleColor(1.9, 0.2)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(gradient.sampleColor(0.5, 1.5)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
    expect(gradient.sampleColor(1, 1)).toEqual({ r: 255, g: 255, b: 255, a: 128 });
  });

  it('clamps coordinates outside the image, and treats NaN as 0', () => {
    expect(gradient.sampleColor(-5, -5)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(gradient.sampleColor(2, 2)).toEqual({ r: 255, g: 255, b: 255, a: 128 });
    expect(gradient.sampleColor(100, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(gradient.sampleColor(NaN, NaN)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });
});

describe('parseStlGeometry (S6)', () => {
  // rejected files are reported on the console; keep the test output clean
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a valid STL and computes its bounding box', () => {
    const geometry = parseStlGeometry(binaryStl([[0, 0, 0, 10, 0, 0, 0, 10, 5]]), 'ok.stl');
    expect(geometry).not.toBeNull();
    expect(geometry!.getAttribute('position').count).toBe(3);
    expect(geometry!.boundingBox!.max.toArray()).toEqual([10, 10, 5]);
  });

  it('rejects an STL with no triangles', () => {
    expect(parseStlGeometry(binaryStl([]), 'empty.stl')).toBeNull();
  });

  it('rejects an STL with coordinates that are not finite', () => {
    expect(parseStlGeometry(binaryStl([[0, 0, 0, Infinity, 0, 0, 0, 10, 5]]), 'bad.stl')).toBeNull();
    expect(parseStlGeometry(binaryStl([[0, 0, 0, NaN, 0, 0, 0, 10, 5]]), 'nan.stl')).toBeNull();
  });

  it('rejects a file that is not an STL at all, without throwing', () => {
    const garbage = new TextEncoder().encode('this is not an stl file').buffer as ArrayBuffer;
    expect(parseStlGeometry(garbage, 'notes.txt')).toBeNull();
    expect(parseStlGeometry(new ArrayBuffer(3), 'tiny.stl')).toBeNull();
  });
});
