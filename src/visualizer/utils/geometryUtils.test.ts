import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { getConvexHull, pointRayCrossesSegments } from './geometryUtils';

const v = (x: number, y: number) => new THREE.Vector2(x, y);

describe('getConvexHull (S11)', () => {
  it('finds the corners of an axis-aligned box, starting at the lowest-left one and going counter clockwise', () => {
    const points = [
      v(10, 5),            // middle of the right edge
      v(10, 10),
      v(5, 5),             // inside
      v(0, 10),
      v(5, 0),             // middle of the bottom edge
      v(10, 0),
      v(0, 0),
      v(0, 5),             // middle of the left edge
      v(5, 10),            // middle of the top edge
      v(3, 7),             // inside
    ];

    const hull = getConvexHull(points);

    expect(hull).not.toBeNull();
    expect(hull!.map(p => [p.x, p.y])).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
  });

  it('breaks a tie for the lowest point by taking the leftmost', () => {
    const hull = getConvexHull([v(5, 0), v(0, 0), v(5, 5), v(0, 5)]);
    expect(hull!.map(p => [p.x, p.y])).toEqual([[0, 0], [5, 0], [5, 5], [0, 5]]);
  });

  it('returns null for collinear points', () => {
    expect(getConvexHull([v(0, 0), v(1, 1), v(2, 2), v(3, 3)])).toBeNull();
    expect(getConvexHull([v(0, 0), v(1, 0), v(2, 0)])).toBeNull();
    expect(getConvexHull([v(0, 3), v(0, 1), v(0, 2), v(0, 0)])).toBeNull();
  });

  it('returns null when there are fewer than three distinct points', () => {
    expect(getConvexHull([])).toBeNull();
    expect(getConvexHull([v(1, 1)])).toBeNull();
    expect(getConvexHull([v(0, 0), v(1, 1)])).toBeNull();
    expect(getConvexHull([v(1, 1), v(1, 1), v(1, 1)])).toBeNull();
  });

  it('copes with repeated points', () => {
    const hull = getConvexHull([v(0, 0), v(4, 0), v(0, 0), v(4, 4), v(4, 0), v(0, 4), v(4, 4)]);
    expect(hull!.map(p => [p.x, p.y])).toEqual([[0, 0], [4, 0], [4, 4], [0, 4]]);
  });

  it('does not modify its input', () => {
    const points = [v(10, 10), v(5, 5), v(0, 10), v(10, 0), v(0, 0), v(5, 0)];
    const order = points.slice();
    const values = points.map(p => p.clone());

    getConvexHull(points);

    expect(points).toHaveLength(order.length);
    points.forEach((p, i) => {
      expect(p).toBe(order[i]);
      expect(p.equals(values[i])).toBe(true);
    });
  });

  it('finds the hull of a rotated box', () => {
    const corners = [v(0, -5), v(5, 0), v(0, 5), v(-5, 0)];
    const hull = getConvexHull([...corners, v(0, 0), v(1, 1), v(2.5, 2.5)]);
    expect(hull!.map(p => [p.x, p.y])).toEqual([[0, -5], [5, 0], [0, 5], [-5, 0]]);
  });
});

describe('pointRayCrossesSegments (S11)', () => {
  it('returns 0 for an empty list instead of throwing', () => {
    expect(pointRayCrossesSegments(v(0, 0), [])).toBe(0);
  });

  it('counts an odd number of crossings for a point inside a square', () => {
    const square = [v(0, 0), v(10, 0), v(10, 10), v(0, 10)];
    const segments = square.map((p, i) => ({ start: p, end: square[(i + 1) % square.length] }));
    expect(pointRayCrossesSegments(v(5, 5), segments) % 2).toBe(1);
    expect(pointRayCrossesSegments(v(15, 5), segments) % 2).toBe(0);
  });
});
