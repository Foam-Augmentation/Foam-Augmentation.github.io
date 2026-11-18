import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import Printer, { nozzleRadiusAt } from '../../printer/Printer';
import { coilReach } from '../toolpath/coilModel';
import type { EverydayModel } from '../types/modelTypes';
import {
  buildChunkForest,
  buildChunkTree,
  buildRoofRoom,
  buildRegionTree,
  ChunkNode,
  checkPolygonOverlap,
  shellCrossesRegion,
  shellRestsOnRegion,
  SliceRegion,
  checkShellRegularOverlap,
  connectIsocontours,
  connectSegments,
  extractRegionsFromLayer,
  extractRegionsFromPointCloud,
  extractShellRegionsFromLayer,
  generateInsetContourTree,
  getHolesAndOuters,
  getSegmentsFromMesh,
  getWindingOrder,
  LineSegment,
  offsetContour,
  offsetContourAll,
  offsetRegion,
  pointInPolygon,
  RegionNode,
  roofRoomAt,
  roofRoomBelow,
  sliceMeshIntoLayers,
  traceBoundaryLoops,
  wallLineArea,
} from './TreeSlicer';

/** A counter clockwise rectangle from (x0, y0) to (x1, y1) at height z. */
function rect(x0: number, y0: number, x1: number, y1: number, z = 0): THREE.Vector3[] {
  return [
    new THREE.Vector3(x0, y0, z),
    new THREE.Vector3(x1, y0, z),
    new THREE.Vector3(x1, y1, z),
    new THREE.Vector3(x0, y1, z),
  ];
}

/** A counter clockwise square centred on (cx, cy). */
function square(cx: number, cy: number, half: number, z = 0): THREE.Vector3[] {
  return rect(cx - half, cy - half, cx + half, cy + half, z);
}

/** The closed loop of segments going round a contour. */
function toSegments(contour: THREE.Vector3[]): LineSegment[] {
  return contour.map((p, i) => ({ start: p.clone(), end: contour[(i + 1) % contour.length].clone() }));
}

function signedArea(contour: THREE.Vector3[]): number {
  let area = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function boundsOf(contour: THREE.Vector3[]) {
  const xs = contour.map(p => p.x), ys = contour.map(p => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** A 10 mm cube as triangle soup (like an STL), sitting on z = 0 and centred on the origin in x and y. */
function cubeMesh(): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
  geometry.translate(0, 0, 5);
  return new THREE.Mesh(geometry);
}

/** A two-lobed shape: two 10 x 10 squares joined by a bar 2 wide and 10 long. Counter clockwise. */
function dumbbell(): THREE.Vector3[] {
  return [
    [0, 0], [10, 0], [10, 4], [20, 4], [20, 0], [30, 0],
    [30, 10], [20, 10], [20, 6], [10, 6], [10, 10], [0, 10],
  ].map(([x, y]) => new THREE.Vector3(x, y, 0));
}

function chainLength(node: RegionNode): number {
  let length = 1;
  while (node.children.length === 1) {
    node = node.children[0];
    length++;
  }
  return length;
}

describe('getHolesAndOuters (S1)', () => {
  it('treats a post inside the bore of a ring as its own region', () => {
    const O = square(0, 0, 10);
    const H = square(0, 0, 6);
    const P = square(0, 0, 2);

    const groups = getHolesAndOuters([O, H, P]);

    expect(groups).toHaveLength(2);
    expect(groups[0].outer).toBe(O);
    expect(groups[0].holes).toEqual([H]);
    expect(groups[1].outer).toBe(P);
    expect(groups[1].holes).toEqual([]);
  });

  it('gives the same grouping whatever order the contours come in', () => {
    const O = square(0, 0, 10);
    const H = square(0, 0, 6);
    const P = square(0, 0, 2);

    const groups = getHolesAndOuters([P, H, O]);

    expect(groups).toHaveLength(2);
    const ring = groups.find(g => g.outer === O)!;
    const post = groups.find(g => g.outer === P)!;
    expect(ring.holes).toEqual([H]);
    expect(post.holes).toEqual([]);
  });

  it('handles a hole inside the post, and several holes in one outer', () => {
    const O = square(0, 0, 20);
    const H1 = square(-10, 0, 6);
    const H2 = square(10, 0, 6);
    const P = square(-10, 0, 4);
    const PH = square(-10, 0, 2);

    const groups = getHolesAndOuters([O, H1, H2, P, PH]);

    expect(groups).toHaveLength(2);
    expect(groups.find(g => g.outer === O)!.holes).toEqual([H1, H2]);
    expect(groups.find(g => g.outer === P)!.holes).toEqual([PH]);
  });

  it('keeps separate contours as separate outers', () => {
    const groups = getHolesAndOuters([square(0, 0, 1), square(10, 0, 1)]);
    expect(groups).toHaveLength(2);
    expect(groups.every(g => g.holes.length === 0)).toBe(true);
  });
});

describe('sliceMeshIntoLayers (S2, S8)', () => {
  it('throws on a step that is not positive and finite', () => {
    const mesh = cubeMesh();
    for (const step of [0, -1, NaN, Infinity, -Infinity]) {
      expect(() => sliceMeshIntoLayers(mesh, step)).toThrow(/Layer thickness/);
    }
  });

  it('throws rather than hanging on an absurdly small step', () => {
    expect(() => sliceMeshIntoLayers(cubeMesh(), 1e-9)).toThrow(/layers/);
  });

  it('gives the expected number of layers for a box', () => {
    const mesh = cubeMesh();
    expect(sliceMeshIntoLayers(mesh, 1)).toHaveLength(10);
    expect(sliceMeshIntoLayers(mesh, 2.5)).toHaveLength(4);
    expect(sliceMeshIntoLayers(mesh, 20)).toHaveLength(1);
  });

  it('computes each z from the layer index', () => {
    const layers = sliceMeshIntoLayers(cubeMesh(), 0.1);
    expect(layers).toHaveLength(100);
    layers.forEach((layer, k) => {
      expect(layer.z).toBe(0.00001 + k * 0.1);
    });
  });

  it('slices a cube into square contours', () => {
    const layers = sliceMeshIntoLayers(cubeMesh(), 1);

    for (const { z, segments } of layers) {
      // two triangles per side face
      expect(segments).toHaveLength(8);

      const contours = connectSegments(segments);
      expect(contours).toHaveLength(1);

      const contour = contours[0];
      // closed: ends where it started (to within a couple of connection tolerances)
      expect(contour[0].distanceTo(contour[contour.length - 1])).toBeLessThan(1e-4);
      expect(Math.abs(signedArea(contour))).toBeCloseTo(100, 3);
      for (const p of contour) {
        expect(p.z).toBeCloseTo(z, 9);
        // every point is on the outline of the square
        expect(Math.max(Math.abs(p.x), Math.abs(p.y))).toBeCloseTo(5, 6);
      }

      const regions = extractRegionsFromLayer(z, segments, 0.4, 0);
      expect(regions).toHaveLength(1);
      expect(regions[0].holes).toHaveLength(0);
      expect(regions[0].bounds.min.x).toBeCloseTo(-5, 6);
      expect(regions[0].bounds.max.y).toBeCloseTo(5, 6);
    }
  });

  it('gives the same segments as cutting each layer with a plane', () => {
    const geometry = new THREE.TorusKnotGeometry(10, 3, 64, 12).toNonIndexed();
    geometry.rotateX(0.3);
    const mesh = new THREE.Mesh(geometry);

    const layers = sliceMeshIntoLayers(mesh, 1.16);
    expect(layers.length).toBeGreaterThan(10);

    for (const { z, segments } of layers) {
      const expected = getSegmentsFromMesh(mesh, new THREE.Plane(new THREE.Vector3(0, 0, 1), -z));
      expect(segments).toHaveLength(expected.length);
      segments.forEach((segment, i) => {
        expect(segment.start.distanceTo(expected[i].start)).toBeLessThan(1e-9);
        expect(segment.end.distanceTo(expected[i].end)).toBeLessThan(1e-9);
      });
    }
  });

  it('slices indexed geometry too', () => {
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    expect(geometry.index).not.toBeNull();
    const layers = sliceMeshIntoLayers(new THREE.Mesh(geometry), 1);
    expect(layers).toHaveLength(10);
    for (const { segments } of layers) {
      const contours = connectSegments(segments);
      expect(contours).toHaveLength(1);
      expect(Math.abs(signedArea(contours[0]))).toBeCloseTo(100, 6);
    }
  });
});

describe('getSegmentsFromMesh (S12)', () => {
  it('gives a closed contour when the plane passes exactly through vertices', () => {
    // the box has a ring of vertices at z = 0
    const geometry = new THREE.BoxGeometry(10, 10, 10, 1, 1, 2).toNonIndexed();
    const mesh = new THREE.Mesh(geometry);

    const segments = getSegmentsFromMesh(mesh, new THREE.Plane(new THREE.Vector3(0, 0, 1), 0));
    const contours = connectSegments(segments);

    expect(contours).toHaveLength(1);
    const contour = contours[0];
    expect(contour[0].distanceTo(contour[contour.length - 1])).toBeLessThan(1e-9);
    expect(Math.abs(signedArea(contour))).toBeCloseTo(100, 6);
  });
});

describe('connectSegments (S8)', () => {
  it('returns nothing for no segments', () => {
    expect(connectSegments([])).toEqual([]);
  });

  it('stitches shuffled and flipped segments into separate loops', () => {
    const a = toSegments(square(0, 0, 5));
    const b = toSegments(square(20, 0, 2));
    // interleave the two loops and flip some of the segments
    const mixed: LineSegment[] = [a[2], b[1], a[0], { start: b[3].end, end: b[3].start }, a[3], b[0], { start: a[1].end, end: a[1].start }, b[2]];

    const contours = connectSegments(mixed);

    expect(contours).toHaveLength(2);
    const areas = contours.map(c => Math.abs(signedArea(c))).sort((x, y) => x - y);
    expect(areas[0]).toBeCloseTo(16, 9);
    expect(areas[1]).toBeCloseTo(100, 9);
    // 4 segments each, so 5 points with the start repeated at the end
    expect(contours.every(c => c.length === 5)).toBe(true);
  });

  it('does not connect endpoints that are further apart than the tolerance', () => {
    const segments: LineSegment[] = [
      { start: new THREE.Vector3(0, 0, 0), end: new THREE.Vector3(1, 0, 0) },
      { start: new THREE.Vector3(1.001, 0, 0), end: new THREE.Vector3(2, 0, 0) },
      { start: new THREE.Vector3(2, 0, 0), end: new THREE.Vector3(3, 0, 0) },
    ];
    const contours = connectSegments(segments);
    // the first segment is alone (too short to be a contour); the other two join up
    expect(contours).toHaveLength(1);
    expect(contours[0].map(p => p.x)).toEqual([1.001, 2, 3]);
  });

  it('does not modify or share the points of the segments', () => {
    const segments = toSegments(square(0, 0, 5));
    const before = segments.map(s => [s.start.clone(), s.end.clone()]);
    const contours = connectSegments(segments);
    segments.forEach((s, i) => {
      expect(s.start.equals(before[i][0])).toBe(true);
      expect(s.end.equals(before[i][1])).toBe(true);
    });
    for (const p of contours[0]) {
      expect(segments.some(s => s.start === p || s.end === p)).toBe(false);
    }
  });
});

describe('offsetContourAll and offsetRegion (S3)', () => {
  it('returns both lobes of a dumbbell that splits when inset', () => {
    const lobes = offsetContourAll(dumbbell(), -1.5);

    expect(lobes).toHaveLength(2);
    for (const lobe of lobes) {
      expect(getWindingOrder(lobe)).toBe(true);
      // each lobe is a 7 x 7 square
      expect(signedArea(lobe)).toBeGreaterThan(48);
      expect(signedArea(lobe)).toBeLessThan(50);
    }
    // one lobe in each end of the dumbbell, and nothing left of the bar between them
    const bounds = lobes.map(boundsOf).sort((a, b) => a.minX - b.minX);
    expect(bounds[0].minX).toBeCloseTo(1.5, 2);
    expect(bounds[0].maxX).toBeLessThan(9);
    expect(bounds[1].minX).toBeGreaterThan(21);
    expect(bounds[1].maxX).toBeCloseTo(28.5, 2);
  });

  it('keeps offsetContour returning a single contour (the largest piece)', () => {
    const single = offsetContour(dumbbell(), -1.5);
    expect(single.length).toBeGreaterThanOrEqual(3);
    expect(Math.abs(signedArea(single))).toBeGreaterThan(48);
    expect(Math.abs(signedArea(single))).toBeLessThan(50);
  });

  it('returns one polygon when the shape stays whole, and none when it vanishes', () => {
    expect(offsetContourAll(dumbbell(), -0.5)).toHaveLength(1);
    expect(offsetContourAll(dumbbell(), -6)).toHaveLength(0);
    expect(offsetContourAll(dumbbell(), 1)).toHaveLength(1);
  });

  it('shrinks the outer and grows the holes of a region together', () => {
    const pieces = offsetRegion(square(0, 0, 10), [square(0, 0, 2)], -1);

    expect(pieces).toHaveLength(1);
    expect(pieces[0].holes).toHaveLength(1);
    const outer = boundsOf(pieces[0].outer);
    expect(outer.minX).toBeCloseTo(-9, 2);
    expect(outer.maxX).toBeCloseTo(9, 2);
    const hole = boundsOf(pieces[0].holes[0]);
    expect(hole.minX).toBeCloseTo(-3, 2);
    expect(hole.maxY).toBeCloseTo(3, 2);
  });

  it('accepts holes wound either way', () => {
    const clockwiseHole = square(0, 0, 2).reverse();
    const pieces = offsetRegion(square(0, 0, 10).reverse(), [clockwiseHole], -1);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].holes).toHaveLength(1);
    expect(boundsOf(pieces[0].holes[0]).maxX).toBeCloseTo(3, 2);
  });

  it('clips a hole that grows through the wall against the outer', () => {
    // the hole is 1 mm from the right hand wall; insetting by 1.5 breaks through it
    const pieces = offsetRegion(rect(0, 0, 20, 20), [rect(17, 8, 19, 12)], -1.5);

    expect(pieces).toHaveLength(1);
    expect(pieces[0].holes).toHaveLength(0);
    const outer = pieces[0].outer;
    // the bite taken out by the hole reaches in to x = 15.5
    expect(outer.some(p => Math.abs(p.x - 15.5) < 0.01 && p.y > 7.9 && p.y < 12.1)).toBe(true);
    expect(boundsOf(outer).maxX).toBeCloseTo(18.5, 2);
    expect(signedArea(outer)).toBeLessThan(17 * 17 - 3 * 7 + 1);
  });

  it('makes one region per piece when a layer outline splits under the shell inset', () => {
    // shell inset = linewidth * (shellLayers + 1) = 1.5
    const regions = extractRegionsFromLayer(1, toSegments(dumbbell()), 0.5, 2);

    expect(regions).toHaveLength(2);
    expect(new Set(regions.map(r => r.id)).size).toBe(2);
    for (const region of regions) {
      expect(region.contour.length).toBeGreaterThanOrEqual(3);
      expect(region.bounds.max.x - region.bounds.min.x).toBeLessThan(8);
      expect(region.height).toBe(1);
    }
  });

  it('keeps every shell line when the outline splits', () => {
    // the second shell line is inset by 1.5, which splits the dumbbell in two
    const regions = extractShellRegionsFromLayer(1, toSegments(dumbbell()), 1.5, 2);
    expect(regions).toHaveLength(1);
    expect(regions[0].shell).toBe(true);
    expect(regions[0].holes).toHaveLength(2);
  });
});

describe('inputs are not modified (S7)', () => {
  const snapshot = (contour: THREE.Vector3[]) => contour.map(p => p.clone());
  const sameAs = (contour: THREE.Vector3[], before: THREE.Vector3[]) =>
    contour.length === before.length && contour.every((p, i) => p.equals(before[i]));

  it('generateInsetContourTree leaves the outer and holes alone, whichever way they wind', () => {
    for (const reverseOuter of [false, true]) {
      for (const reverseHole of [false, true]) {
        const outer = square(0, 0, 10);
        const hole = square(0, 0, 3);
        if (reverseOuter) outer.reverse();
        if (reverseHole) hole.reverse();
        const holes = [hole];
        const outerBefore = snapshot(outer);
        const holeBefore = snapshot(hole);
        const outerRefs = outer.slice();

        const root = generateInsetContourTree(outer, holes, 1);

        expect(sameAs(outer, outerBefore)).toBe(true);
        expect(outer.every((p, i) => p === outerRefs[i])).toBe(true);
        expect(sameAs(hole, holeBefore)).toBe(true);
        expect(holes).toEqual([hole]);
        // the tree's root is a counter clockwise copy
        expect(root.contour).not.toBe(outer);
        expect(getWindingOrder(root.contour)).toBe(true);
        expect(root.children.length).toBeGreaterThan(0);
      }
    }
  });

  it('connectIsocontours leaves the tree and the region contour alone', () => {
    const outer = square(0, 0, 10);
    const outerBefore = snapshot(outer);
    const root = generateInsetContourTree(outer, [], 2);

    const lengths: number[] = [];
    const firstPoints: THREE.Vector3[] = [];
    for (let node = root; ; node = node.children[0]) {
      lengths.push(node.contour.length);
      firstPoints.push(node.contour[0]);
      if (node.children.length === 0) break;
    }

    const first = connectIsocontours(root, 2, new THREE.Vector3(-20, -20, 0), 35);
    const second = connectIsocontours(root, 2, new THREE.Vector3(-20, -20, 0), 35);

    expect(first.length).toBeGreaterThan(0);
    // running it twice gives the same path, because the first run changed nothing
    expect(second.map(p => p.point.toArray())).toEqual(first.map(p => p.point.toArray()));

    let i = 0;
    for (let node = root; ; node = node.children[0]) {
      expect(node.contour.length).toBe(lengths[i]);
      expect(node.contour[0]).toBe(firstPoints[i]);
      i++;
      if (node.children.length === 0) break;
    }
    expect(sameAs(outer, outerBefore)).toBe(true);
  });

  it('offset helpers leave their input alone', () => {
    const contour = dumbbell().reverse();
    const before = snapshot(contour);
    offsetContour(contour, -1);
    offsetContourAll(contour, -1.5);
    offsetRegion(contour, [], 1);
    expect(sameAs(contour, before)).toBe(true);
  });

  it('copes with contours of fewer than three points', () => {
    const twoPoints = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)];

    expect(getWindingOrder([])).toBe(false);
    expect(getWindingOrder(twoPoints)).toBe(false);
    expect(offsetContour([], 1)).toEqual([]);
    expect(offsetContour(twoPoints, 1)).toEqual([]);
    expect(offsetContourAll([], 1)).toEqual([]);
    expect(offsetRegion(twoPoints, [], 1)).toEqual([]);

    const root = generateInsetContourTree([], [], 1);
    expect(root.contour).toEqual([]);
    expect(root.children).toEqual([]);
    expect(connectIsocontours(root, 1, new THREE.Vector3(), 35)).toEqual([]);
  });

  it('generateInsetContourTree throws on a spacing that would never finish', () => {
    expect(() => generateInsetContourTree(square(0, 0, 10), [], 0)).toThrow();
    expect(() => generateInsetContourTree(square(0, 0, 10), [], NaN)).toThrow();
  });
});

describe('sliver filter and arc tolerance (S10)', () => {
  it('drops inset contours smaller than the minimum area', () => {
    // 3 x 3 square inset by 0.5: first 2 x 2 (4 mm^2, kept), then 1 x 1 (1 mm^2, a sliver)
    const root = generateInsetContourTree(rect(0, 0, 3, 3), [], 0.5);

    expect(root.children).toHaveLength(1);
    expect(Math.abs(signedArea(root.children[0].contour))).toBeCloseTo(4, 2);
    expect(root.children[0].children).toHaveLength(0);
  });

  it('gives no inset contours at all when the first one is already a sliver', () => {
    // 2 x 2 square inset by 0.25 leaves 1.5 x 1.5 = 2.25 mm^2
    const root = generateInsetContourTree(rect(0, 0, 2, 2), [], 0.25);
    expect(root.children).toHaveLength(0);
  });

  it('keeps insetting a large contour all the way in', () => {
    const root = generateInsetContourTree(square(0, 0, 10), [], 2);
    // insets of a 20 mm square by 2: 16, 12, 8, 4 mm wide
    expect(chainLengthOfContours(root)).toBe(5);
  });

  it('rounds corners with a sensible number of vertices', () => {
    const grown = offsetContour(square(0, 0, 5), 2);
    // four quarter circles of radius 2; the old tolerance gave about 200 vertices
    expect(grown.length).toBeGreaterThan(12);
    expect(grown.length).toBeLessThan(80);
    // and the arcs still stay within 0.02 mm of the true rounded square
    for (const p of grown) {
      const dx = Math.max(Math.abs(p.x) - 5, 0), dy = Math.max(Math.abs(p.y) - 5, 0);
      expect(Math.abs(Math.hypot(dx, dy) - 2)).toBeLessThan(0.02);
    }
  });
});

function chainLengthOfContours(root: { children: any[] }): number {
  let length = 1;
  let node = root;
  while (node.children.length === 1) {
    node = node.children[0];
    length++;
  }
  return length;
}

describe('buildRegionTree (S2, S5)', () => {
  it('throws on a layer height that is not positive and finite', () => {
    for (const step of [0, -0.2, NaN, Infinity]) {
      expect(() => buildRegionTree([], step)).toThrow(/Layer height/);
    }
  });

  it('stacks a ring and the post in its bore as two separate towers', () => {
    const regions = [0, 1, 2].flatMap(k => {
      const z = 0.00001 + k;
      const segments = [...toSegments(square(0, 0, 10, z)), ...toSegments(square(0, 0, 6, z)), ...toSegments(square(0, 0, 2, z))];
      return extractRegionsFromLayer(z, segments, 0.4, 0);
    });
    expect(regions).toHaveLength(6);

    const roots = buildRegionTree(regions, 1);

    expect(roots).toHaveLength(2);
    const ring = roots.find(r => r.region.holes.length === 1)!;
    const post = roots.find(r => r.region.holes.length === 0)!;
    expect(chainLength(ring)).toBe(3);
    expect(chainLength(post)).toBe(3);
    // the post's children are posts, never the ring
    expect(post.children[0].region.holes).toHaveLength(0);
    expect(ring.children[0].region.holes).toHaveLength(1);
  });

  it('keeps towers apart when only their bounding boxes overlap', () => {
    // two L shapes that hook round each other without touching
    const lowerL = (z: number) => [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10]].map(([x, y]) => new THREE.Vector3(x, y, z));
    const upperL = (z: number) => [[4, 4], [12, 4], [12, 12], [10, 12], [10, 6], [4, 6]].map(([x, y]) => new THREE.Vector3(x, y, z));

    const regions = [0, 1, 2].flatMap(k => {
      const z = 0.00001 + k * 1.16;
      return extractRegionsFromLayer(z, [...toSegments(lowerL(z)), ...toSegments(upperL(z))], 0.4, 0);
    });
    expect(regions).toHaveLength(6);

    const roots = buildRegionTree(regions, 1.16);

    expect(roots).toHaveLength(2);
    for (const root of roots) {
      expect(chainLength(root)).toBe(3);
      const rootMinX = root.region.bounds.min.x;
      for (let node = root; node.children.length; node = node.children[0]) {
        expect(node.children[0].region.bounds.min.x).toBeCloseTo(rootMinX, 6);
      }
    }
  });

  it('never makes a region the parent of another in the same layer', () => {
    const z = 0.5;
    const regions = extractRegionsFromLayer(z, [...toSegments(square(0, 0, 10, z)), ...toSegments(square(0, 0, 6, z)), ...toSegments(square(0, 0, 2, z))], 0.4, 0);
    const roots = buildRegionTree(regions, 1);
    expect(roots).toHaveLength(2);
    expect(roots.every(r => r.children.length === 0)).toBe(true);
  });

  it('chains the layers of a cube, with and without a shell inset', () => {
    const mesh = cubeMesh();
    for (const shellLayers of [0, 2]) {
      const regions = sliceMeshIntoLayers(mesh, 1.16).flatMap(({ z, segments }) =>
        extractRegionsFromLayer(z, segments, 0.4, shellLayers));
      expect(regions).toHaveLength(9);

      const roots = buildRegionTree(regions, 1.16);
      expect(roots).toHaveLength(1);
      expect(chainLength(roots[0])).toBe(9);
      expect(roots[0].layer).toBe(0);
    }
  });

  it('chains shell regions in order of height', () => {
    const mesh = cubeMesh();
    const foam = sliceMeshIntoLayers(mesh, 1.16).flatMap(({ z, segments }) => extractRegionsFromLayer(z, segments, 0.4, 2));
    const shell = sliceMeshIntoLayers(mesh, 0.2).flatMap(({ z, segments }) => extractShellRegionsFromLayer(z, segments, 0.4, 2));
    expect(shell).toHaveLength(50);

    const roots = buildRegionTree([...foam, ...shell], 1.16);

    expect(roots).toHaveLength(2);
    const shellRoot = roots.find(r => r.shell)!;
    const foamRoot = roots.find(r => !r.shell)!;
    expect(chainLength(shellRoot)).toBe(50);
    expect(chainLength(foamRoot)).toBe(9);
    // heights go up along the shell chain
    for (let node = shellRoot; node.children.length; node = node.children[0]) {
      expect(node.children[0].region.height).toBeGreaterThan(node.region.height);
    }
  });

  it('records the foam regions a shell region is printed on top of', () => {
    // a wide foam layer with a narrower shell starting just above it
    const foam = extractRegionsFromLayer(0.00001, toSegments(square(0, 0, 10, 0.00001)), 0.4, 0);
    const shell = extractShellRegionsFromLayer(0.20001, toSegments(square(0, 0, 3, 0.20001)), 0.4, 2);
    // and a shell far off to the side, over nothing
    const farShell = extractShellRegionsFromLayer(0.40001, toSegments(square(50, 0, 3, 0.40001)), 0.4, 2);

    // the answer doesn't depend on whether the foam or the shell regions come first
    for (const regions of [[...foam, ...shell, ...farShell], [...shell, ...farShell, ...foam]]) {
      const roots = buildRegionTree(regions, 1.16);
      const shellRoot = roots.find(r => r.shell)!;
      expect(shellRoot.region).toBe(shell[0]);
      expect(Array.from(shellRoot.shellDependentRegions!)).toEqual([foam[0].id]);
      expect(shellRoot.children[0].region).toBe(farShell[0]);
      expect(shellRoot.children[0].shellDependentRegions!.size).toBe(0);
    }
  });
});

describe('checkPolygonOverlap (S5)', () => {
  const regionOf = (outer: THREE.Vector3[], holes: THREE.Vector3[][] = []) =>
    extractRegionsFromLayer(0, [outer, ...holes].flatMap(toSegments), 0.4, 0)
      .find(r => r.holes.length === holes.length)!;

  it('says identical outlines overlap', () => {
    expect(checkPolygonOverlap(regionOf(square(0, 0, 5)), regionOf(square(0, 0, 5)))).toBe(true);
  });

  it('says a post in the bore of a ring does not overlap the ring', () => {
    const ring = regionOf(square(0, 0, 10), [square(0, 0, 6)]);
    const post = regionOf(square(0, 0, 2));
    expect(checkPolygonOverlap(ring, post)).toBe(false);
    expect(checkPolygonOverlap(post, ring)).toBe(false);
  });

  it('says partly overlapping shapes overlap, and shapes that only touch do not', () => {
    expect(checkPolygonOverlap(regionOf(rect(0, 0, 10, 10)), regionOf(rect(9, 9, 20, 20)))).toBe(true);
    expect(checkPolygonOverlap(regionOf(rect(0, 0, 10, 10)), regionOf(rect(10, 0, 20, 10)))).toBe(false);
    expect(checkPolygonOverlap(regionOf(rect(0, 0, 10, 10)), regionOf(rect(30, 0, 40, 10)))).toBe(false);
  });

  it('finds a cross shaped overlap where neither shape has a corner inside the other', () => {
    expect(checkPolygonOverlap(regionOf(rect(-10, -1, 10, 1)), regionOf(rect(-1, -10, 1, 10)))).toBe(true);
  });
});

describe('checkShellRegularOverlap', () => {
  const foamRegion = (outer: THREE.Vector3[], holes: THREE.Vector3[][] = []) =>
    extractRegionsFromLayer(0, [outer, ...holes].flatMap(toSegments), 0.4, 0)
      .find(r => r.holes.length === holes.length)!;
  const shellRegion = (outer: THREE.Vector3[], z = 0.2) =>
    extractShellRegionsFromLayer(z, toSegments(outer.map(p => new THREE.Vector3(p.x, p.y, z))), 0.4, 2)[0];

  it('finds a shell with a vertex inside the foam', () => {
    expect(checkShellRegularOverlap(shellRegion(square(0, 0, 3)), foamRegion(square(0, 0, 10)))).toBe(true);
  });

  it('finds a shell line that crosses the foam without a vertex inside it', () => {
    expect(checkShellRegularOverlap(shellRegion(rect(-20, -1, 20, 1)), foamRegion(rect(-1, -10, 1, 10)))).toBe(true);
  });

  it('says no when the shell goes all the way round the foam, or sits in a hole', () => {
    expect(checkShellRegularOverlap(shellRegion(square(0, 0, 10)), foamRegion(square(0, 0, 3)))).toBe(false);
    expect(checkShellRegularOverlap(shellRegion(square(0, 0, 2)), foamRegion(square(0, 0, 10), [square(0, 0, 6)]))).toBe(false);
    expect(checkShellRegularOverlap(shellRegion(square(30, 0, 2)), foamRegion(square(0, 0, 10)))).toBe(false);
  });

  it('only counts shells within the allowed height above the foam', () => {
    const foam = foamRegion(square(0, 0, 10));
    expect(checkShellRegularOverlap(shellRegion(square(0, 0, 3), 1), foam, 1.16)).toBe(true);
    expect(checkShellRegularOverlap(shellRegion(square(0, 0, 3), 2), foam, 1.16)).toBe(false);
    expect(checkShellRegularOverlap(shellRegion(square(0, 0, 3), -1), foam, 1.16)).toBe(false);
  });

  it('agrees with testing every pair of segments on many-sided shapes', () => {
    const polygon = (cx: number, cy: number, radius: number, sides: number, z: number) =>
      Array.from({ length: sides }, (_, i) => {
        const angle = (i / sides) * Math.PI * 2;
        // a wobbly circle, so that edges really do cross each other
        const r = radius * (1 + 0.2 * Math.sin(angle * 7));
        return new THREE.Vector3(cx + r * Math.cos(angle), cy + r * Math.sin(angle), z);
      });
    const crosses = (a: THREE.Vector3[], b: THREE.Vector3[]) => {
      const ccw = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3) => (r.y - p.y) * (q.x - p.x) > (q.y - p.y) * (r.x - p.x);
      for (let i = 0; i < a.length; i++) {
        for (let j = 0; j < b.length; j++) {
          const a1 = a[i], a2 = a[(i + 1) % a.length], b1 = b[j], b2 = b[(j + 1) % b.length];
          if (ccw(a1, b1, b2) !== ccw(a2, b1, b2) && ccw(a1, a2, b1) !== ccw(a1, a2, b2)) return true;
        }
      }
      return false;
    };

    let overlapping = 0;
    for (let k = 0; k < 12; k++) {
      const foamOuter = polygon(0, 0, 10, 60, 0);
      // far to the left, sweeping across the foam, then (the last two) going right round it
      const shellOuter = k < 10 ? polygon(k * 5 - 20, k - 4, 3, 45, 0.2) : polygon(0, 0, 30 + k, 45, 0.2);
      const shell = shellRegion(shellOuter);
      const foam = foamRegion(foamOuter);
      // the brute force answer: any shell vertex inside the foam, or any pair of edges crossing
      const inside = (p: THREE.Vector3, poly: THREE.Vector3[]) => {
        let result = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          if ((poly[i].y > p.y) !== (poly[j].y > p.y) &&
              p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) result = !result;
        }
        return result;
      };
      const shellContours = [shell.contour, ...shell.holes];
      const expected = shellContours.some(c => c.some(p => inside(p, foam.contour)))
        || shellContours.some(c => crosses(c, foam.contour));
      expect(checkShellRegularOverlap(shell, foam)).toBe(expected);
      if (expected) overlapping++;
    }
    expect(overlapping).toBeGreaterThan(0);
    expect(overlapping).toBeLessThan(12);
  });
});

describe('point cloud regions (S4, S13)', () => {
  it('walks boundary loops that share a pinch vertex without looping forever', () => {
    // two triangles that touch at vertex 0
    const loops = traceBoundaryLoops([[0, 1], [1, 2], [2, 0], [0, 3], [3, 4], [4, 0]]);

    expect(loops).toHaveLength(2);
    expect(loops.every(loop => loop.length === 3)).toBe(true);
    expect(loops.flat().filter(v => v === 0)).toHaveLength(2);
  });

  it('walks a simple loop once', () => {
    const loops = traceBoundaryLoops([[0, 1], [1, 2], [2, 3], [3, 0]]);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
  });

  it('drops open chains, which are not loops', () => {
    expect(traceBoundaryLoops([[0, 1]])).toEqual([]);
  });

  it('makes a region from a grid of points, with the height in its id', () => {
    const points: THREE.Vector3[] = [];
    for (let x = 0; x <= 10; x++) {
      for (let y = 0; y <= 10; y++) {
        points.push(new THREE.Vector3(x, y, 2.5));
      }
    }

    const regions = extractRegionsFromPointCloud(points, 5, 1);

    expect(regions).toHaveLength(1);
    expect(regions[0].id).toBe('region-1-2.500-0');
    expect(regions[0].extruder).toBe(1);
    expect(Math.abs(signedArea(regions[0].contour))).toBeCloseTo(100, 6);
    expect(regions[0].bounds.min.toArray()).toEqual([0, 0, 0]);
    expect(regions[0].bounds.max.toArray()).toEqual([10, 10, 0]);
  });

  it('finds a hole in a point cloud', () => {
    const points: THREE.Vector3[] = [];
    for (let x = 0; x <= 20; x++) {
      for (let y = 0; y <= 20; y++) {
        // leave out the middle
        if (x > 6 && x < 14 && y > 6 && y < 14) continue;
        points.push(new THREE.Vector3(x, y, 0));
      }
    }

    const regions = extractRegionsFromPointCloud(points, 1);

    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(1);
    // an 8 x 8 hole, less the four corner triangles that are small enough to count as filled
    expect(Math.abs(signedArea(regions[0].holes[0]))).toBeCloseTo(62, 6);
  });
});

/** Foam regions for `count` layers 1 mm apart, with the outlines `outlinesAt` gives for each layer. */
function foamLayers(count: number, outlinesAt: (layer: number, z: number) => THREE.Vector3[][]): SliceRegion[] {
  const regions: SliceRegion[] = [];
  for (let k = 0; k < count; k++) {
    const z = 0.00001 + k;
    regions.push(...extractRegionsFromLayer(z, outlinesAt(k, z).flatMap(toSegments), 0.4, 0));
  }
  return regions;
}

/** A 10 x 10 mm stack of foam regions starting at x0, leaning `lean` mm in x per layer. */
function foamStack(count: number, x0: number, lean = 0): SliceRegion[] {
  return foamLayers(count, (k, z) => [rect(x0 + lean * k, 0, x0 + 10 + lean * k, 10, z)]);
}

/**
 * The nozzle rides 2 mm above a layer, a layer is 1 mm thick and its material reaches 0.2 mm past
 * the nozzle's path, whatever the printer's settings are.
 */
const CLEARANCE = { tipOffset: () => 2, thickness: () => 1, reach: () => 0.2 };

/** How many regions each chunk of a chain holds, from the bottom up. Follows only children. */
function chunkSizes(root: ChunkNode): number[] {
  const sizes: number[] = [];
  for (let chunk: ChunkNode | undefined = root; chunk; chunk = chunk.children[0]) {
    sizes.push(chunk.regions.length);
  }
  return sizes;
}

/**
 * The order makeChunkTreePath prints chunks in: a round at a time, shells first within a round.
 * The rest of a round goes first to last, or last to first.
 */
function printOrder(roots: ChunkNode[], lastOfTies: boolean): ChunkNode[] {
  const open = [...roots];
  const order: ChunkNode[] = [];
  while (open.length) {
    const round = Math.min(...open.map(chunk => chunk.order));
    const inRound = open.filter(chunk => chunk.order <= round);
    const shells = inRound.filter(chunk => chunk.shell);
    const ties = shells.length ? shells : inRound;
    const next = lastOfTies ? ties[ties.length - 1] : ties[0];
    open.splice(open.indexOf(next), 1, ...next.children);
    order.push(next);
  }
  return order;
}

/** The distance in x and y between two regions, 0 if they overlap, found by trying every pair of edges. */
function regionGap(a: SliceRegion, b: SliceRegion, shiftA: number): number {
  const edges = (region: SliceRegion, shift: number) => [region.contour, ...region.holes].flatMap(ring =>
    ring.map((p, i) => {
      const q = ring[(i + 1) % ring.length];
      return [p.x + shift, p.y, q.x + shift, q.y];
    }));
  const pointToEdge = (px: number, py: number, [ax, ay, bx, by]: number[]) => {
    const abx = bx - ax, aby = by - ay;
    const t = Math.min(1, Math.max(0, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1)));
    return Math.hypot(px - ax - t * abx, py - ay - t * aby);
  };
  const side = (ax: number, ay: number, bx: number, by: number, px: number, py: number) =>
    Math.sign((bx - ax) * (py - ay) - (by - ay) * (px - ax));
  const solidContains = (region: SliceRegion, shift: number, point: THREE.Vector3, pointShift: number) => {
    if (region.shell) return false;
    const moved = new THREE.Vector3(point.x + pointShift - shift, point.y, 0);
    return pointInPolygon(moved, region.contour) && !region.holes.some(hole => pointInPolygon(moved, hole));
  };

  if (solidContains(b, 0, a.contour[0], shiftA) || solidContains(a, shiftA, b.contour[0], 0)) return 0;
  let gap = Infinity;
  for (const e of edges(a, shiftA)) {
    for (const f of edges(b, 0)) {
      const crossing = side(e[0], e[1], e[2], e[3], f[0], f[1]) !== side(e[0], e[1], e[2], e[3], f[2], f[3])
        && side(f[0], f[1], f[2], f[3], e[0], e[1]) !== side(f[0], f[1], f[2], f[3], e[2], e[3]);
      if (crossing) return 0;
      gap = Math.min(gap, pointToEdge(e[0], e[1], f), pointToEdge(e[2], e[3], f), pointToEdge(f[0], f[1], e), pointToEdge(f[2], f[3], e));
    }
  }
  return gap;
}

/**
 * Prints the chunks in order and counts the regions that cannot be printed: ones underneath a
 * region that is already there, ones the nozzle cannot get to past what stands next to them, and
 * ones the head body cannot get to past taller regions.
 */
function printProblems(
  order: ChunkNode[],
  printer: Printer,
  tipOffset: (region: SliceRegion) => number,
  thickness: (region: SliceRegion) => number,
  offsetOf: (chunk: ChunkNode) => number = () => 0,
): { covered: number; nozzleHits: number; headHits: number } {
  const head = printer.printHeadDims;
  const extruder = printer.extruders[0];
  const printed: { region: SliceRegion; dx: number }[] = [];
  let covered = 0, nozzleHits = 0, headHits = 0;

  for (const chunk of order) {
    const dx = offsetOf(chunk);
    for (const region of chunk.regions) {
      const tip = region.height + tipOffset(region);
      let isCovered = false, hitsNozzle = false, hitsHead = false;
      for (const before of printed) {
        if (before.dx === dx && before.region.height > region.height + 1e-6) {
          // Foam can go in under a wall that leans over it; a wall cannot go in under foam.
          if (region.shell === before.region.shell) isCovered ||= checkPolygonOverlap(before.region, region);
          else if (region.shell) isCovered ||= shellCrossesRegion(region, before.region);
        }
        // How far what is already there stands above the nozzle tip.
        const above = before.region.height + Math.min(thickness(before.region), tipOffset(before.region)) - tip;
        if (above <= 1e-6) continue;
        const a = region.bounds, b = before.region.bounds;
        const inReach = a.min.x + dx + head.min.x <= b.max.x + before.dx && a.max.x + dx + head.max.x >= b.min.x + before.dx
          && a.min.y + head.min.y <= b.max.y && a.max.y + head.max.y >= b.min.y;
        hitsHead ||= inReach && above > extruder.nozzleLength + 1e-6;
        hitsNozzle ||= regionGap(before.region, region, before.dx - dx) < nozzleRadiusAt(extruder, above);
      }
      if (isCovered) covered++;
      if (hitsNozzle) nozzleHits++;
      if (hitsHead) headHits++;
      printed.push({ region, dx });
    }
  }
  return { covered, nozzleHits, headHits };
}

describe('shellRestsOnRegion', () => {
  const shellAt = (x: number, z: number, half = 10) => extractShellRegionsFromLayer(z, toSegments(square(x, 0, half, z)), 0.4, 2)[0];
  const foamAt = (x: number, z: number, half = 10) => extractRegionsFromLayer(z, toSegments(square(x, 0, half, z)), 0.4, 2)[0];

  it('says a straight wall does not rest on the foam inside it', () => {
    expect(shellRestsOnRegion(shellAt(0, 0.1), foamAt(0, 0), [shellAt(0, 0)], 0.2)).toBe(false);
    expect(shellRestsOnRegion(shellAt(0, 0.1), foamAt(0, 0), [], 0.2)).toBe(false);
  });

  it('says a wall that leans over the foam does not rest on it while the wall below holds it up', () => {
    // 1.3 mm to the side of the foam layer's own wall, which puts its lines over the foam
    const leaning = shellAt(1.3, 1);
    const foam = foamAt(0, 0);
    expect(shellCrossesRegion(leaning, foam)).toBe(true);

    // the wall layer right below it is 0.15 mm back: close enough to hold it up
    expect(shellRestsOnRegion(leaning, foam, [shellAt(1.15, 0.9)], 0.2)).toBe(false);
    // 0.5 mm back is too far, and so is no wall at all
    expect(shellRestsOnRegion(leaning, foam, [shellAt(0.8, 0.9)], 0.2)).toBe(true);
    expect(shellRestsOnRegion(leaning, foam, [], 0.2)).toBe(true);
  });

  it('says the first wall of a part that starts on top of foam rests on it', () => {
    // a 6 mm post starting on a 20 mm base: the base's wall is nowhere near under it
    expect(shellRestsOnRegion(shellAt(0, 1, 3), foamAt(0, 0), [shellAt(0, 0.9)], 0.2)).toBe(true);
  });

  it('lets buildRegionTree tell the two apart', () => {
    // a bar leaning 0.15 mm per 0.1 mm shell layer over two 1 mm foam layers
    const regions: SliceRegion[] = [];
    for (let k = 0; k < 2; k++) regions.push(foamAt(1.5 * k, 0.00001 + k));
    for (let k = 0; k < 20; k++) regions.push(shellAt(0.15 * k, 0.00001 + k * 0.1));
    let shell = buildRegionTree(regions, 1, 0.2).find(root => root.shell)!;
    for (; shell; shell = shell.children[0]) {
      expect(shell.shellDependentRegions!.size).toBe(0);
    }

    // the same bar, leaning too fast for the wall below to hold the next one
    const steep: SliceRegion[] = [];
    for (let k = 0; k < 2; k++) steep.push(foamAt(5 * k, 0.00001 + k));
    for (let k = 0; k < 20; k++) steep.push(shellAt(0.5 * k, 0.00001 + k * 0.1));
    const resting: number[] = [];
    shell = buildRegionTree(steep, 1, 0.2).find(root => root.shell)!;
    for (; shell; shell = shell.children[0]) resting.push(shell.shellDependentRegions!.size);
    // from the layer where its wall first comes over the edge of the first foam layer, 1.2 mm in
    expect(resting.slice(0, 2)).toEqual([0, 0]);
    expect(resting.slice(2, 10).every(count => count > 0)).toBe(true);
  });
});

describe('nozzleRadiusAt', () => {
  const nozzle = new Printer().extruders[0];

  it('follows the cone and the hex of a Prusa XL nozzle', () => {
    expect(nozzleRadiusAt(nozzle, 0)).toBe(0);
    expect(nozzleRadiusAt(nozzle, -1)).toBe(0);
    // just above the tip it is the flat of the tip, 1 mm across
    expect(nozzleRadiusAt(nozzle, 1e-9)).toBeCloseTo(0.5, 6);
    // half way up the 2 mm cone, which is 3.7 mm across at the top
    expect(nozzleRadiusAt(nozzle, 1)).toBeCloseTo((0.5 + 1.85) / 2, 6);
    expect(nozzleRadiusAt(nozzle, 2)).toBeCloseTo(1.85, 6);
    // the hex, 8 mm across its corners, from there up
    expect(nozzleRadiusAt(nozzle, 2.01)).toBe(4);
    expect(nozzleRadiusAt(nozzle, 30)).toBe(4);
  });

  it('never narrows going up, and takes the Nextruder for an extruder without a shape', () => {
    const odd = { ...nozzle, nozzleTipWidth: 6, nozzleConeWidth: 2, nozzleBodyWidth: 1 };
    expect(nozzleRadiusAt(odd, 0.5)).toBe(3);
    expect(nozzleRadiusAt(odd, 4)).toBe(3);

    const old = { ...nozzle } as Partial<typeof nozzle>;
    delete old.nozzleTipWidth; delete old.nozzleConeHeight; delete old.nozzleConeWidth; delete old.nozzleBodyWidth;
    expect(nozzleRadiusAt(old as typeof nozzle, 1)).toBeCloseTo(1.175, 6);
    expect(nozzleRadiusAt(old as typeof nozzle, 3)).toBe(4);
  });
});

describe('buildChunkForest', () => {
  const printer = new Printer();
  const noProblems = { covered: 0, nozzleHits: 0, headHits: 0 };
  /** Two 10 mm wide stacks of 15 layers, `gap` mm apart. */
  const twoStacks = (gap: number) =>
    buildRegionTree(foamLayers(15, (k, z) => [rect(0, 0, 10, 10, z), rect(10 + gap, 0, 20 + gap, 10, z)]), 1);
  const expectPrintable = (
    chunks: ChunkNode[],
    tipOffset: (region: SliceRegion) => number = CLEARANCE.tipOffset,
    thickness: (region: SliceRegion) => number = CLEARANCE.thickness,
    offsetOf?: (chunk: ChunkNode) => number,
  ) => {
    for (const lastOfTies of [false, true]) {
      expect(printProblems(printOrder(chunks, lastOfTies), printer, tipOffset, thickness, offsetOf)).toEqual(noProblems);
    }
  };

  it('prints a stack with nothing near it in one go, however tall it is', () => {
    const chunks = buildChunkForest([{ roots: buildRegionTree(foamStack(40, 0), 1), ...CLEARANCE }], printer);

    expect(chunks).toHaveLength(1);
    expect(chunkSizes(chunks[0])).toEqual([40]);
  });

  it('stops a stack where the head body could no longer get to the stack next to it', () => {
    // 5 mm apart: clear of the nozzle, which is 4 mm at its widest, but under the head.
    const chunks = buildChunkForest([{ roots: twoStacks(5), ...CLEARANCE }], printer);

    // The top of layer k is at k + 1. The nozzle tip is 2 above the lowest layer still to print,
    // and the head body a nozzle length (4.5) above that.
    expect(chunks.map(chunkSizes)).toEqual([[6, 6, 3], [6, 6, 3]]);
    expectPrintable(chunks);
  });

  it('stops a stack sooner the closer the next one is, for the nozzle to fit beside it', () => {
    const sizes = (gap: number) => {
      const chunks = buildChunkForest([{ roots: twoStacks(gap), ...CLEARANCE }], printer);
      expectPrintable(chunks);
      return chunkSizes(chunks[0]);
    };

    // 4 mm apart, the hex (4 mm from the nozzle's axis, from 2 mm above its tip) is in the way.
    expect(sizes(4)).toEqual([4, 4, 4, 3]);
    // 1.5 mm apart, the cone is: it is that wide a little over 1 mm above the tip.
    expect(sizes(1.5)).toEqual([3, 3, 3, 3, 3]);
    // 0.5 mm apart, the flat of the tip is: the stack may not stand above the tip at all.
    expect(sizes(0.5)).toEqual([2, 2, 2, 2, 2, 2, 2, 1]);
  });

  it('follows how high the nozzle rides over the layer', () => {
    // On top of the layer, the head body is a nozzle length above it: five layers fit under it.
    const low = buildChunkForest([{ roots: twoStacks(5), ...CLEARANCE, tipOffset: () => 1 }], printer);
    expect(chunkSizes(low[0])).toEqual([5, 5, 5]);
    // 6 mm above the layer, ten do.
    const high = buildChunkForest([{ roots: twoStacks(5), ...CLEARANCE, tipOffset: () => 6 }], printer);
    expect(chunkSizes(high[0])).toEqual([10, 5]);
  });

  it('gives foam the reach of its coils when it is told nothing else', () => {
    // 5 mm apart, a thin line leaves room for the nozzle's hex; coiled foam does not.
    const thin = buildChunkForest([{ roots: twoStacks(5), ...CLEARANCE }], printer);
    expect(chunkSizes(thin[0])).toEqual([6, 6, 3]);

    const hStar = printer.getVTPSettings(0).H_star;
    const reach = coilReach(hStar, printer.threadDiameter(0));
    // the hex is 4 mm from the nozzle's axis, and the coils reach over a millimetre towards it
    expect(reach).toBeGreaterThan(1);
    const coiled = buildChunkForest([{ roots: twoStacks(5), tipOffset: () => 2, thickness: () => 1 }], printer);
    expect(chunkSizes(coiled[0])).toEqual([4, 4, 4, 3]);
    // far enough apart for the coils as well, it is the head body again
    const apart = buildChunkForest([{ roots: twoStacks(4 + reach + 0.2), tipOffset: () => 2, thickness: () => 1 }], printer);
    expect(chunkSizes(apart[0])).toEqual([6, 6, 3]);
  });

  it('numbers the chunks in the order they have to be printed in', () => {
    const chunks = buildChunkForest([{ roots: twoStacks(5), ...CLEARANCE }], printer);

    // Both stacks can start, so they share a round; each next chunk is a round of its own pair.
    expect(chunks.map(chunk => chunk.order)).toEqual([1, 1]);
    expect(chunks.map(chunk => chunk.children[0].order)).toEqual([2, 2]);
    expect(chunks.map(chunk => chunk.children[0].children[0].order)).toEqual([3, 3]);
  });

  it('takes the printer\'s own settings when it is told nothing else', () => {
    const chunks = buildChunkTree(twoStacks(5), printer);
    const vtp = printer.getVTPSettings(0);

    expectPrintable(chunks, () => vtp.H_star * printer.threadDiameter(0), () => vtp.deltaZ);
    expect(chunks[0].VTPSettings).toEqual(vtp);
    expect(chunks[0].children.length).toBeGreaterThan(0);
  });

  it('leaves a stack whole when the head cannot reach the other one', () => {
    // The head is 40 mm wide to the left of the nozzle and 35 mm to the right.
    const chunks = buildChunkForest([{ roots: twoStacks(50), ...CLEARANCE }], printer);

    expect(chunks.map(chunkSizes)).toEqual([[15], [15]]);
  });

  it('finishes the stacks in reach of each other before starting ones that are out of reach', () => {
    // Two pairs of stacks, 5 mm apart within a pair, the pairs 75 mm apart.
    const regions = foamLayers(15, (k, z) => [0, 15, 100, 115].map(x => rect(x, 0, x + 10, 10, z)));
    const chunks = buildChunkForest([{ roots: buildRegionTree(regions, 1), ...CLEARANCE }], printer);

    const rounds = chunks.map(root => {
      const orders: number[] = [];
      for (let chunk: ChunkNode | undefined = root; chunk; chunk = chunk.children[0]) orders.push(chunk.order);
      return orders;
    });
    expect(rounds).toEqual([[1, 2, 3], [1, 2, 3], [4, 5, 6], [4, 5, 6]]);
    expectPrintable(chunks);
  });

  it('never prints a region over a lower one that is still to come', () => {
    // Two bars leaning the same way: the left one ends up over the foot of the right one.
    const regions = foamLayers(12, (k, z) => [rect(k, 0, 10 + k, 10, z), rect(12 + k, 0, 22 + k, 10, z)]);
    const chunks = buildChunkForest([{ roots: buildRegionTree(regions, 1), ...CLEARANCE }], printer);

    // Layer 2 of the left bar already touches the foot of the right one, above its nozzle.
    expect(chunkSizes(chunks[0])[0]).toBe(2);
    expectPrintable(chunks);
  });

  it('prints both legs of an arch before the bridge across them', () => {
    const regions = foamLayers(6, (k, z) => k < 4
      ? [rect(0, 0, 10, 10, z), rect(20, 0, 30, 10, z)]
      : [rect(0, 0, 30, 10, z)]);
    const roots = buildRegionTree(regions, 1);
    // The bridge is the child of one leg only, so nothing in the tree says it rests on the other.
    expect(roots.map(chainLength).sort()).toEqual([4, 6]);

    const chunks = buildChunkForest([{ roots, ...CLEARANCE }], printer);

    expect(chunks.map(chunkSizes).sort()).toEqual([[4], [4, 2]]);
    expectPrintable(chunks);
  });

  it('keeps a model from running ahead of the model next to it', () => {
    const source = (x: number, count: number) => ({
      roots: buildRegionTree(foamStack(count, 0), 1),
      position: new THREE.Vector3(x, 0, 0),
      modelObj: { name: `at ${x}` } as unknown as EverydayModel,
      ...CLEARANCE,
    });
    const offsetOf = (chunk: ChunkNode) => Number(chunk.modelObj!.name.slice(3));

    const near = buildChunkForest([source(0, 30), source(15, 8)], printer);
    // The tall one keeps pace with the short one, and is free once the short one is finished.
    expect(near.map(chunkSizes)).toEqual([[6, 6, 18], [6, 2]]);
    expect(near[0].children[0].modelObj).toBe(near[0].modelObj);
    expectPrintable(near, CLEARANCE.tipOffset, CLEARANCE.thickness, offsetOf);

    const far = buildChunkForest([source(0, 30), source(200, 8)], printer);
    expect(far.map(chunkSizes)).toEqual([[30], [8]]);
  });

  it('builds a leaning wall before the foam it leans over', () => {
    // A 20 mm square bar leaning 0.3 mm per mm: 0.15 mm per shell layer, which the wall below holds up.
    const outline = (z: number) => toSegments(square(0.3 * z, 0, 10, z));
    const regions: SliceRegion[] = [];
    for (let k = 0; k < 12; k++) {
      regions.push(...extractRegionsFromLayer(0.00001 + k, outline(0.00001 + k), 0.4, 2));
    }
    for (let k = 0; k < 24; k++) {
      regions.push(...extractShellRegionsFromLayer(0.00001 + k * 0.5, outline(0.00001 + k * 0.5), 0.4, 2));
    }
    const tipOffset = (region: SliceRegion) => region.shell ? 0.5 : 2;
    const thickness = (region: SliceRegion) => region.shell ? 0.5 : 1;
    // Higher up, the wall is over the foam layers below it.
    expect(shellCrossesRegion(regions.find(r => r.shell && r.height > 5)!, regions[0])).toBe(true);

    const chunks = buildChunkForest([{ roots: buildRegionTree(regions, 1, 0.2), tipOffset, thickness }], printer);

    const shell = chunks.find(chunk => chunk.shell)!;
    const foam = chunks.find(chunk => !chunk.shell)!;
    // Same as for a straight post: the wall first, up to the foam nozzle, then one layer of foam.
    expect(shell.order).toBeLessThan(foam.order);
    expect(shell.dependentRegions!.size).toBe(0);
    expect(shell.regions[shell.regions.length - 1].height + 0.5).toBeCloseTo(2, 3);
    expect(chunkSizes(shell).reduce((a, b) => a + b)).toBe(24);
    expect(chunkSizes(foam).reduce((a, b) => a + b)).toBe(12);
    expectPrintable(chunks, tipOffset, thickness);
  });

  it('builds the wall of a post before the foam inside it, and never above the foam nozzle', () => {
    // A 20 mm square post: foam layers 1 mm apart inside shell layers 0.5 mm apart.
    const outline = (z: number) => toSegments(square(0, 0, 10, z));
    const regions: SliceRegion[] = [];
    for (let k = 0; k < 20; k++) {
      regions.push(...extractRegionsFromLayer(0.00001 + k, outline(0.00001 + k), 0.4, 2));
    }
    for (let k = 0; k < 40; k++) {
      regions.push(...extractShellRegionsFromLayer(0.00001 + k * 0.5, outline(0.00001 + k * 0.5), 0.4, 2));
    }
    // The shell is printed on its layer; the foam nozzle rides 2 mm over a 1 mm foam layer.
    const tipOffset = (region: SliceRegion) => region.shell ? 0.5 : 2;
    const thickness = (region: SliceRegion) => region.shell ? 0.5 : 1;

    const chunks = buildChunkForest([{ roots: buildRegionTree(regions, 1), tipOffset, thickness }], printer);

    const shell = chunks.find(chunk => chunk.shell)!;
    const foam = chunks.find(chunk => !chunk.shell)!;
    // The wall goes first, up to the height the foam nozzle will be at over the first foam layer.
    expect(shell.order).toBeLessThan(foam.order);
    expect(shell.regions[shell.regions.length - 1].height + 0.5).toBeCloseTo(2, 3);
    // The foam then fills the wall that is there, and stops at its rim.
    expect(foam.regions[foam.regions.length - 1].height + 1).toBeCloseTo(2, 3);
    expect(chunkSizes(shell).reduce((a, b) => a + b)).toBe(40);
    expect(chunkSizes(foam).reduce((a, b) => a + b)).toBe(20);
    expectPrintable(chunks, tipOffset, thickness);
  });

  describe('under a roof (C6, C7)', () => {
    /**
     * A square that narrows 2 mm per mm up, like a shallow roof: each 0.25 mm shell layer is
     * 0.5 mm inside the one below, too far to be held up by it, so it rests on the foam of its
     * layer, which stands 1 mm thick, above the nozzle that prints it.
     */
    const roof = (): SliceRegion[] => {
      const outline = (z: number) => toSegments(square(0, 0, 10 - 2 * z, z));
      const regions: SliceRegion[] = [];
      for (let k = 0; k < 4; k++) regions.push(...extractRegionsFromLayer(0.00001 + k, outline(0.00001 + k), 0.4, 2));
      for (let k = 0; k < 16; k++) regions.push(...extractShellRegionsFromLayer(0.00001 + k * 0.25, outline(0.00001 + k * 0.25), 0.4, 2));
      return regions;
    };
    const tipOffset = (region: SliceRegion) => region.shell ? 0.25 : 2;
    const thickness = (region: SliceRegion) => region.shell ? 0.25 : 1;
    const layerOf = (region: SliceRegion) => Math.floor(region.height + 0.0001);
    /** Every region's printing round. */
    const rounds = (chunks: ChunkNode[]) => {
      const order = new Map<string, number>();
      const stack = [...chunks];
      while (stack.length) {
        const chunk = stack.pop()!;
        chunk.regions.forEach(region => order.set(region.id, chunk.order));
        stack.push(...chunk.children);
      }
      return order;
    };

    it('prints the roof over foam that is not there yet when the foam is not fitted under it, and says so', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const roots = buildRegionTree(roof(), 1, 0.2);
        buildChunkForest([{ roots, tipOffset, thickness }], printer);
        expect(warn).toHaveBeenCalled();
        const message = String(warn.mock.calls[0][0]);
        expect(message).toMatch(/shell region .* before the foam region .*, which it covers from above\./);
        expect(message).toMatch(/It is printed over foam that is not there yet, and that foam is then laid around and over it\./);
        expect(message).not.toMatch(/The nozzle may hit printed material there/);
      } finally {
        warn.mockRestore();
      }
    });

    it('prints foam that is fitted under the roof first, and the roof onto it, without a fallback', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const roots = buildRegionTree(roof(), 1, 0.2);
        const keptBelow = (foam: SliceRegion, shell: SliceRegion) => layerOf(foam) === layerOf(shell);
        const chunks = buildChunkForest([{ roots, tipOffset, thickness, keptBelow }], printer);
        expect(warn).not.toHaveBeenCalled();

        const order = rounds(chunks);
        let resting = 0;
        const stack = [...roots];
        while (stack.length) {
          const node = stack.pop()!;
          stack.push(...node.children);
          for (const foamId of node.shellDependentRegions ?? []) {
            resting++;
            expect(order.get(foamId)!).toBeLessThan(order.get(node.region.id)!);
          }
        }
        expect(resting).toBeGreaterThan(0);
      } finally {
        warn.mockRestore();
      }
    });

    it('checks the regions near foam against its nozzle where it dips under a roof', () => {
      // As 'follows how high the nozzle rides over the layer': a nozzle 1 mm over the layer lets
      // five layers of the stack beside it go under the head body, where one at 2 mm lets six.
      const dipped = buildChunkForest([{ roots: twoStacks(5), ...CLEARANCE, lowestTipOffset: () => 1 }], printer);
      expect(chunkSizes(dipped[0])).toEqual([5, 5, 5]);
      expectPrintable(dipped, () => 1);
    });
  });
});

describe('room under a roof', () => {
  /** A wall slice of a 20 mm square at height z, two 0.4 mm lines. */
  const wallAt = (half: number, z: number) => extractShellRegionsFromLayer(z, toSegments(square(0, 0, half, z)), 0.4, 2)[0].wall!;

  it('takes a wall\'s lines from half a line outside its outline to half a line inside its innermost one', () => {
    const area = wallLineArea(wallAt(10, 0), 0.4);
    expect(area).toHaveLength(1);
    const outer = boundsOf(area[0].outer);
    expect(outer.minX).toBeCloseTo(-10.2, 2);
    expect(outer.maxX).toBeCloseTo(10.2, 2);
    expect(area[0].holes).toHaveLength(1);
    const hole = boundsOf(area[0].holes[0]);
    expect(hole.minX).toBeCloseTo(-9.4, 2);
    expect(hole.maxX).toBeCloseTo(9.4, 2);
  });

  it('keeps the smallest room at each point, and the whole layer where nothing limits it', () => {
    // A 4 x 4 square limited to 0.5 mm, inside an 8 x 8 one limited to 1 mm.
    const small = [{ outer: square(0, 0, 2), holes: [] }];
    const large = [{ outer: square(0, 0, 4), holes: [] }];
    const room = buildRoofRoom([{ room: 1, area: large, grow: 0 }, { room: 0.5, area: small, grow: 0 }, { room: 2, area: large, grow: 0 }], 0, 1.7);

    // The limit of 2 mm is more than a layer and limits nothing.
    expect(room.levels.map(level => level.room)).toEqual([0.5, 1]);
    expect(roofRoomAt(room, 0, 0, 1.7)).toBe(0.5);
    expect(roofRoomAt(room, 3, 0, 1.7)).toBe(1);
    expect(roofRoomAt(room, 5, 0, 1.7)).toBe(1.7);
  });

  it('holds each limit within its own distance and the coils\' reach of its area', () => {
    const line = [{ outer: rect(0, 0, 10, 1), holes: [] }];
    const room = buildRoofRoom([{ room: 0.3, area: line, grow: 0.5 }], 1, 1.7);
    expect(roofRoomAt(room, 5, 2.4, 1.7)).toBe(0.3);
    expect(roofRoomAt(room, 5, 2.6, 1.7)).toBe(1.7);
    expect(roofRoomAt(room, -1.4, 0.5, 1.7)).toBe(0.3);
  });

  it('gives the area where there is less room than a height, the same array each time', () => {
    const small = [{ outer: square(0, 0, 2), holes: [] }];
    const large = [{ outer: square(0, 0, 4), holes: [] }];
    const room = buildRoofRoom([{ room: 0.4, area: small, grow: 0 }, { room: 1, area: large, grow: 0 }], 0, 1.7);

    expect(roofRoomBelow(room, 0.3)).toEqual([]);
    expect(boundsOf(roofRoomBelow(room, 0.5)[0].outer).maxX).toBeCloseTo(2, 3);
    expect(boundsOf(roofRoomBelow(room, 1.5)[0].outer).maxX).toBeCloseTo(4, 3);
    expect(roofRoomBelow(room, 0.5)).toBe(roofRoomBelow(room, 0.9));
  });
});
