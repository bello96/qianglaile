import { describe, expect, it } from 'vitest';
import { poseToSkeleton } from '../../engine/body/pose';
import { defaultProfile, scaleProfile } from '../../engine/body/profile';
import { getShape, SHAPES } from './shapes';

describe('shape library', () => {
  it('has five geometric holes with unique ids and names', () => {
    expect(SHAPES).toHaveLength(5);
    expect(new Set(SHAPES.map((s) => s.id)).size).toBe(5);
    expect(new Set(SHAPES.map((s) => s.name)).size).toBe(5);
    expect(SHAPES.map((s) => s.id).sort()).toEqual(['keyhole', 'low-door', 'round', 'side-door', 'slot']);
    expect(JSON.stringify(SHAPES.map((s) => [s.name, s.say]))).not.toMatch(/墙来了|动动乐园/);
  });

  it('only uses tiers 2 and 3, and marks which ones work sitting down', () => {
    for (const s of SHAPES) expect([2, 3]).toContain(s.tier);
    expect(getShape('slot')!.upperOk).toBe(true);
    expect(getShape('low-door')!.upperOk).toBe(false);
    expect(getShape('round')!.upperOk).toBe(false);
  });

  it('the side door is the only one that sits off to the side', () => {
    expect(getShape('side-door')!.offset).toBeCloseTo(0.55);
    for (const s of SHAPES.filter((q) => q.id !== 'side-door')) expect(s.offset ?? 0).toBe(0);
  });

  it('each hole contains the hips of its own demo pose, for adult and child proportions', () => {
    for (const p of [defaultProfile(), scaleProfile(defaultProfile(), 0.72)]) {
      for (const s of SHAPES) {
        const x = s.offset ?? 0;
        const sk = poseToSkeleton(s.demo, p, { x });
        const hole = s.build(p, { x });
        expect(hole(sk.hipC.x, sk.hipC.y), s.id).toBeLessThan(0);
        expect(hole(sk.head.x, sk.head.y), `${s.id} head`).toBeLessThan(0);
      }
    }
  });

  it('holes are solid far away from the opening', () => {
    const p = defaultProfile();
    for (const s of SHAPES) {
      const hole = s.build(p, { x: 0 });
      expect(hole(-1.8, 2.6), s.id).toBeGreaterThan(0);
      expect(hole(1.8, 2.6), s.id).toBeGreaterThan(0);
    }
  });

  it('the low door and the round hole are too low to walk through upright', () => {
    const p = defaultProfile();
    const standingHeadY = 1.51;
    expect(getShape('low-door')!.build(p, { x: 0 })(0, standingHeadY)).toBeGreaterThan(0);
    expect(getShape('round')!.build(p, { x: 0 })(0, standingHeadY)).toBeGreaterThan(0);
  });

  it('holes move with at.x', () => {
    const p = defaultProfile();
    const slot = getShape('slot')!;
    expect(slot.build(p, { x: 0 })(0.6, 1)).toBeGreaterThan(0);
    expect(slot.build(p, { x: 0.6 })(0.6, 1)).toBeLessThan(0);
  });
});
