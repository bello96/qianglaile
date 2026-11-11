import { describe, expect, it } from 'vitest';
import { inflate, sdBox, sdCapsule, sdCircle, sdTriangle, union } from './sdf';

describe('signed distance primitives (negative inside)', () => {
  it('circle', () => {
    expect(sdCircle(0, 0, 1)(2, 0)).toBeCloseTo(1);
    expect(sdCircle(0, 0, 1)(0, 0)).toBeCloseTo(-1);
    expect(sdCircle(1, 1, 0.5)(1, 1.5)).toBeCloseTo(0);
  });

  it('box', () => {
    const box = sdBox(0, 0, 1, 2);
    expect(box(1, 0)).toBeCloseTo(0);
    expect(box(3, 0)).toBeCloseTo(2);
    expect(box(0, 0)).toBeCloseTo(-1);
    expect(box(4, 6)).toBeCloseTo(5); // corner: hypot(3, 4)
  });

  it('rounded box keeps its overall half-size', () => {
    const box = sdBox(0, 0, 1, 2, 0.3);
    expect(box(1, 0)).toBeCloseTo(0);
    expect(box(0, 2)).toBeCloseTo(0);
    expect(box(1, 2)).toBeGreaterThan(0); // the sharp corner has been cut away
  });

  it('capsule', () => {
    const cap = sdCapsule(0, 0, 0, 2, 0.5);
    expect(cap(1, 1)).toBeCloseTo(0.5);
    expect(cap(0, 1)).toBeCloseTo(-0.5);
    expect(cap(0, 3)).toBeCloseTo(0.5);
  });

  it('triangle', () => {
    const tri = sdTriangle({ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 2 });
    expect(tri(0, 0.5)).toBeLessThan(0);
    expect(tri(0, -1)).toBeCloseTo(1);
    expect(tri(0, 3)).toBeCloseTo(1);
  });

  it('triangle works for either winding', () => {
    const tri = sdTriangle({ x: 0, y: 2 }, { x: 1, y: 0 }, { x: -1, y: 0 });
    expect(tri(0, 0.5)).toBeLessThan(0);
    expect(tri(0, -1)).toBeCloseTo(1);
  });
});

describe('operators', () => {
  it('union takes the nearest shape', () => {
    const u = union(sdCircle(-2, 0, 1), sdCircle(2, 0, 1));
    expect(u(-2, 0)).toBeCloseTo(-1);
    expect(u(2, 0)).toBeCloseTo(-1);
    expect(u(0, 0)).toBeCloseTo(1);
  });
  it('inflate grows a shape outward', () => {
    expect(inflate(sdCircle(0, 0, 1), 0.5)(1.5, 0)).toBeCloseTo(0);
  });
});
