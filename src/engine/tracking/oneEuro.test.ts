import { describe, expect, it } from 'vitest';
import { createRng } from '../util/rng';
import { OneEuro, OneEuroArray } from './oneEuro';

const std = (xs: number[]): number => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
};

describe('OneEuro', () => {
  it('passes the first sample through unchanged', () => {
    expect(new OneEuro().filter(0.37, 0)).toBe(0.37);
  });

  it('suppresses jitter on a still signal', () => {
    const rng = createRng(5);
    const f = new OneEuro();
    const input: number[] = [];
    const output: number[] = [];
    for (let i = 0; i < 90; i++) {
      const x = 1 + 0.01 * rng.gauss();
      input.push(x);
      output.push(f.filter(x, i / 30));
    }
    expect(std(output.slice(-60))).toBeLessThan(0.4 * std(input.slice(-60)));
  });

  it('follows a fast move with little lag', () => {
    const f = new OneEuro();
    let out = 0;
    for (let i = 0; i < 30; i++) out = f.filter(0, i / 30);
    for (let i = 30; i <= 36; i++) out = f.filter(1, i / 30); // 0.2 s after the step
    expect(out).toBeGreaterThan(0.9);
  });

  it('returns the previous value when time does not advance', () => {
    const f = new OneEuro();
    f.filter(1, 0);
    const a = f.filter(2, 0.033);
    const b = f.filter(50, 0.033);
    expect(b).toBe(a);
    expect(Number.isNaN(f.filter(3, 0.02))).toBe(false);
  });

  it('reset forgets history', () => {
    const f = new OneEuro();
    f.filter(1, 0);
    f.filter(1, 0.033);
    f.reset();
    expect(f.filter(9, 1)).toBe(9);
  });
});

describe('OneEuroArray', () => {
  it('filters each component like an independent OneEuro', () => {
    const rng = createRng(8);
    const arr = new OneEuroArray(3);
    const singles = [new OneEuro(), new OneEuro(), new OneEuro()];
    for (let i = 0; i < 40; i++) {
      const t = i / 30;
      const sample = [rng.gauss(), 5 + rng.gauss() * 0.1, Math.sin(t * 3)];
      const out = arr.filter(sample, t);
      for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(singles[k].filter(sample[k], t), 5);
    }
  });

  it('writes into the provided output buffer', () => {
    const arr = new OneEuroArray(2);
    const out = new Float32Array(2);
    expect(arr.filter([1, 2], 0, out)).toBe(out);
    expect(Array.from(out)).toEqual([1, 2]);
  });
});
