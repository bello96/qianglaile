import { describe, expect, it } from 'vitest';
import { clamp, clamp01, damp, deg2rad, lerp, median, percentile, pointInPolygon, polygonArea, rad2deg, segDist } from './math';

describe('scalar helpers', () => {
  it('clamps and interpolates', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp01(1.4)).toBe(1);
    expect(lerp(2, 6, 0.25)).toBeCloseTo(3);
  });

  it('damp follows the target exponentially, independent of step size', () => {
    expect(damp(0, 1, Math.LN2, 1)).toBeCloseTo(0.5);
    const twoHalfSteps = damp(damp(0, 1, Math.LN2, 0.5), 1, Math.LN2, 0.5);
    expect(twoHalfSteps).toBeCloseTo(0.5);
  });

  it('converts degrees and radians', () => {
    expect(deg2rad(180)).toBeCloseTo(Math.PI);
    expect(rad2deg(Math.PI / 2)).toBeCloseTo(90);
  });
});

describe('segDist', () => {
  it('measures the perpendicular distance when the foot falls on the segment', () => {
    expect(segDist(0, 1, -1, 0, 1, 0)).toBeCloseTo(1);
  });
  it('measures to the nearest endpoint when the foot falls outside', () => {
    expect(segDist(3, 0, -1, 0, 1, 0)).toBeCloseTo(2);
  });
  it('handles a zero-length segment', () => {
    expect(segDist(3, 4, 0, 0, 0, 0)).toBeCloseTo(5);
  });
});

describe('polygons', () => {
  const ccw = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  it('signed area is positive for counter-clockwise loops', () => {
    expect(polygonArea(ccw)).toBeCloseTo(1);
    expect(polygonArea([...ccw].reverse())).toBeCloseTo(-1);
  });
  it('tests point containment', () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, ccw)).toBe(true);
    expect(pointInPolygon({ x: 1.5, y: 0.5 }, ccw)).toBe(false);
  });
});

describe('order statistics', () => {
  it('median of odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBeCloseTo(2.5);
  });
  it('percentile interpolates linearly', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6);
    expect(percentile([5, 1], 0)).toBe(1);
    expect(percentile([5, 1], 1)).toBe(5);
  });
  it('empty input yields NaN rather than throwing', () => {
    expect(Number.isNaN(median([]))).toBe(true);
  });
});
