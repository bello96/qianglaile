import { describe, expect, it } from 'vitest';
import { DEFAULT_LEG, JOINTS, poseToSkeleton } from '../../engine/body/pose';
import { ANKLE_H, defaultProfile } from '../../engine/body/profile';
import { getPose, POSES, STAND } from './poses';

const profile = defaultProfile();

describe('pose library', () => {
  it('has 24 poses with unique ids and names', () => {
    expect(POSES).toHaveLength(24);
    expect(new Set(POSES.map((p) => p.id)).size).toBe(24);
    expect(new Set(POSES.map((p) => p.name)).size).toBe(24);
    for (const p of POSES) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('uses none of the names we must stay away from', () => {
    expect(JSON.stringify(POSES)).not.toMatch(/墙来了|动动乐园/);
  });

  it('tier 1 is symmetric, arms only, and doable sitting down', () => {
    const tier1 = POSES.filter((p) => p.tier === 1);
    expect(tier1.length).toBeGreaterThanOrEqual(6);
    for (const p of tier1) {
      expect(p.upperOk, p.id).toBe(true);
      expect(p.armL, p.id).toEqual(p.armR);
      expect(p.legL, p.id).toEqual(DEFAULT_LEG);
      expect(p.legR, p.id).toEqual(DEFAULT_LEG);
      expect(p.spine, p.id).toBeUndefined();
    }
  });

  it('offers at least ten poses for upper-body play, and every tier is populated', () => {
    expect(POSES.filter((p) => p.upperOk).length).toBeGreaterThanOrEqual(10);
    for (const tier of [1, 2, 3, 4]) expect(POSES.some((p) => p.tier === tier), `tier ${tier}`).toBe(true);
  });

  it('upper-body poses leave the legs alone', () => {
    for (const p of POSES.filter((q) => q.upperOk)) {
      expect(p.legL, p.id).toEqual(DEFAULT_LEG);
      expect(p.legR, p.id).toEqual(DEFAULT_LEG);
    }
  });

  it('every pose stands on the ground and stays inside the wall', () => {
    for (const p of POSES) {
      const sk = poseToSkeleton(p, profile);
      expect(Math.min(sk.ankleL.y, sk.ankleR.y), p.id).toBeCloseTo(ANKLE_H);
      for (const j of JOINTS) {
        expect(sk[j].x, `${p.id} ${j}.x`).toBeGreaterThan(-1.4);
        expect(sk[j].x, `${p.id} ${j}.x`).toBeLessThan(1.4);
        expect(sk[j].y, `${p.id} ${j}.y`).toBeGreaterThanOrEqual(0);
        expect(sk[j].y, `${p.id} ${j}.y`).toBeLessThan(2.25);
      }
    }
  });

  it('every pose has a spoken hint', () => {
    for (const p of POSES) expect(p.say?.length ?? 0, p.id).toBeGreaterThan(1);
  });

  it('looks poses up by id', () => {
    expect(getPose('t')?.name).toBe('一字平举');
    expect(getPose('nope')).toBeUndefined();
    expect(STAND.id).toBe('stand');
    expect(POSES.find((p) => p.id === 'stand')).toBeUndefined();
  });
});
