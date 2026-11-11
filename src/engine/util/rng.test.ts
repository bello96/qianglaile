import { describe, expect, it } from 'vitest';
import { createRng } from './rng';

describe('createRng', () => {
  it('is deterministic for a seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('differs between seeds', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it('int is inclusive on both ends', () => {
    const r = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const v = r.int(2, 5);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(5);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([2, 3, 4, 5]);
  });

  it('pick returns an element and shuffle returns a permutation', () => {
    const r = createRng(3);
    const xs = [10, 20, 30, 40, 50];
    expect(xs).toContain(r.pick(xs));
    const shuffled = r.shuffle(xs);
    expect(shuffled).not.toBe(xs);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(xs);
  });

  it('chance respects its probability', () => {
    const r = createRng(11);
    let hits = 0;
    for (let i = 0; i < 4000; i++) if (r.chance(0.3)) hits++;
    expect(hits / 4000).toBeGreaterThan(0.26);
    expect(hits / 4000).toBeLessThan(0.34);
    expect(createRng(1).chance(0)).toBe(false);
    expect(createRng(1).chance(1)).toBe(true);
  });

  it('gauss is roughly standard normal', () => {
    const r = createRng(99);
    const xs = Array.from({ length: 4000 }, () => r.gauss());
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.08);
    expect(std).toBeGreaterThan(0.92);
    expect(std).toBeLessThan(1.08);
  });
});
