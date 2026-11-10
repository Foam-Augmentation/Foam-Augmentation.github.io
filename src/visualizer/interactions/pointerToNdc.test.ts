import { describe, expect, it } from 'vitest';
import { pointerToNdc } from './pointerToNdc';

/** A stand-in for a canvas at the given on-screen rectangle. */
function element(left: number, top: number, width: number, height: number) {
  return { getBoundingClientRect: () => ({ left, top, width, height }) };
}

describe('pointerToNdc', () => {
  it('maps the corners and centre of the element', () => {
    const canvas = element(0, 0, 800, 600);
    expect(pointerToNdc({ clientX: 0, clientY: 0 }, canvas)).toEqual({ x: -1, y: 1 });
    expect(pointerToNdc({ clientX: 800, clientY: 600 }, canvas)).toEqual({ x: 1, y: -1 });
    const centre = pointerToNdc({ clientX: 400, clientY: 300 }, canvas);
    expect(centre.x).toBeCloseTo(0);
    expect(centre.y).toBeCloseTo(0);
  });

  it('is relative to the element, not the window', () => {
    const canvas = element(100, 50, 400, 200);
    const centre = pointerToNdc({ clientX: 300, clientY: 150 }, canvas);
    expect(centre.x).toBeCloseTo(0);
    expect(centre.y).toBeCloseTo(0);
    expect(pointerToNdc({ clientX: 100, clientY: 50 }, canvas)).toEqual({ x: -1, y: 1 });
  });

  it('never returns NaN for a zero-sized element', () => {
    const point = pointerToNdc({ clientX: 10, clientY: 10 }, element(0, 0, 0, 0));
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  });
});
