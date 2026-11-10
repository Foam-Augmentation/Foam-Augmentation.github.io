import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { leadInFromAbove } from './gcodeActions';
import type { PathPoint } from './pathTypes';

/** A travel point. */
function travel(x: number, y: number, z: number, extra: Partial<PathPoint> = {}): PathPoint {
  return { point: new THREE.Vector3(x, y, z), travel: true, ...extra };
}

/** A printing point. */
function print(x: number, y: number, z: number): PathPoint {
  return { point: new THREE.Vector3(x, y, z) };
}

describe('leadInFromAbove', () => {
  it('replaces the opening travel across the bed by an approach from above', () => {
    // As the foam slicer does: start at the origin and cross the bed at printing height.
    const toolpath = [travel(0, 0, 0.2), travel(25, 20, 0.2), travel(50, 40, 0.2), print(60, 40, 0.2), print(60, 50, 0.2)];
    const result = leadInFromAbove(toolpath, 16);

    expect(result.map(p => p.point.toArray())).toEqual([
      [50, 40, 16],   // arrive above the start of printing
      [50, 40, 0.2],  // straight down
      [60, 40, 0.2],
      [60, 50, 0.2],
    ]);
    expect(result[0].travel).toBe(true);
    expect(result[0].role).toBe('approach');
    // nothing below the safe height is crossed before the head is over the landing point
    expect(result.slice(0, 1).every(p => p.point.z >= 16)).toBe(true);
  });

  it('keeps the tool choice of a dropped point', () => {
    const toolpath = [travel(0, 0, 0.2, { extruder: 1 }), travel(50, 40, 0.2), print(60, 40, 0.2)];
    expect(leadInFromAbove(toolpath, 16)[0].extruder).toBe(1);
  });

  it('never approaches below the landing point', () => {
    const toolpath = [travel(0, 0, 30), travel(50, 40, 30), print(60, 40, 30)];
    expect(leadInFromAbove(toolpath, 16)[0].point.z).toBe(30);
  });

  it('leaves the input and paths without an opening travel alone', () => {
    const toolpath = [travel(0, 0, 0.2), travel(50, 40, 0.2), print(60, 40, 0.2)];
    const copy = toolpath.map(p => p.point.clone());
    leadInFromAbove(toolpath, 16);
    expect(toolpath.map(p => p.point)).toEqual(copy);
    expect(toolpath).toHaveLength(3);

    const printsFirst = [print(1, 1, 0.2), print(2, 1, 0.2)];
    expect(leadInFromAbove(printsFirst, 16)).toBe(printsFirst);
    const onlyTravel = [travel(0, 0, 0.2), travel(5, 5, 0.2)];
    expect(leadInFromAbove(onlyTravel, 16)).toBe(onlyTravel);
    expect(leadInFromAbove([], 16)).toEqual([]);
  });
});
