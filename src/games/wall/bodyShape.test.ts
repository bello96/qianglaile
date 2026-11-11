import { describe, expect, it } from 'vitest';
import { JOINTS, NEUTRAL, poseToSkeleton, type JointName } from '../../engine/body/pose';
import { defaultProfile } from '../../engine/body/profile';
import { limbsToParts, PART_IDS, skeletonCapsules, type PartId } from './bodyShape';

const profile = defaultProfile();
const sk = poseToSkeleton(NEUTRAL, profile);

describe('skeletonCapsules', () => {
  const caps = skeletonCapsules(sk, profile);

  it('covers all fourteen body parts', () => {
    expect(PART_IDS).toHaveLength(14);
    expect(new Set(caps.map((c) => c.id))).toEqual(new Set<PartId>(PART_IDS));
  });

  it('models the head as a circle', () => {
    const head = caps.find((c) => c.id === 'head')!;
    expect([head.ax, head.ay]).toEqual([head.bx, head.by]);
    expect(head.ax).toBeCloseTo(sk.head.x);
    expect(head.ay).toBeCloseTo(sk.head.y);
    expect(head.r).toBeCloseTo(0.11);
  });

  it('runs each limb capsule between its joints with the profile radius', () => {
    const arm = caps.find((c) => c.id === 'upperArmR')!;
    expect([arm.ax, arm.ay]).toEqual([sk.shoulderR.x, sk.shoulderR.y]);
    expect([arm.bx, arm.by]).toEqual([sk.elbowR.x, sk.elbowR.y]);
    expect(arm.r).toBeCloseTo(0.045);
    const shin = caps.find((c) => c.id === 'shinL')!;
    expect([shin.bx, shin.by]).toEqual([sk.ankleL.x, sk.ankleL.y]);
    expect(shin.r).toBeCloseTo(0.055);
  });

  it('builds the torso from a spine, a shoulder bar and a pelvis bar', () => {
    const torso = caps.filter((c) => c.id === 'torso');
    expect(torso).toHaveLength(3);
    expect(torso.map((c) => c.r).sort()).toEqual([0.06, 0.085, 0.13]);
  });

  it('is fully visible by default', () => {
    expect(caps.every((c) => c.ok)).toBe(true);
  });

  it('marks a part invisible when one of its joints is', () => {
    const ok = Object.fromEntries(JOINTS.map((j) => [j, true])) as Record<JointName, boolean>;
    ok.elbowR = false;
    const parts = skeletonCapsules(sk, profile, ok);
    const state = (id: PartId) => parts.filter((c) => c.id === id).map((c) => c.ok);
    expect(state('upperArmR')).toEqual([false]);
    expect(state('forearmR')).toEqual([false]);
    expect(state('handR')).toEqual([true]);
    expect(state('upperArmL')).toEqual([true]);
  });
});

describe('limbsToParts', () => {
  it('maps limbs to the body parts they move', () => {
    expect(limbsToParts(['forearmL', 'spine'])).toEqual(['forearmL', 'handL', 'torso', 'head']);
    expect(limbsToParts(['upperArmR'])).toEqual(['upperArmR']);
    expect(limbsToParts(['shinR', 'thighR'])).toEqual(['shinR', 'footR', 'thighR']);
  });
  it('does not repeat parts', () => {
    expect(limbsToParts(['spine', 'spine'])).toEqual(['torso', 'head']);
    expect(limbsToParts([])).toEqual([]);
  });
});
