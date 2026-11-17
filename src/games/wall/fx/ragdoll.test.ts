import { describe, expect, it } from 'vitest';
import { JOINTS, NEUTRAL, poseToSkeleton, type JointName, type Skeleton } from '../../../engine/body/pose';
import { defaultProfile } from '../../../engine/body/profile';
import { getPose } from '../poses';
import { Ragdoll, type RagdollEnv } from './ragdoll';

const ENV: RagdollEnv = { deckHalfW: 1.8, deckHalfD: 0.85, waterY: -0.9 };
const profile = defaultProfile();
const standing = (): Skeleton => poseToSkeleton(NEUTRAL, profile);

/** 骨架上相连的关节对：它们之间的距离不该变。 */
const BONES: [JointName, JointName][] = [
  ['head', 'neck'], ['neck', 'hipC'], ['shoulderL', 'shoulderR'], ['hipL', 'hipR'],
  ['shoulderL', 'elbowL'], ['elbowL', 'wristL'], ['wristL', 'handL'],
  ['shoulderR', 'elbowR'], ['elbowR', 'wristR'], ['wristR', 'handR'],
  ['hipL', 'kneeL'], ['kneeL', 'ankleL'], ['ankleL', 'toeL'],
  ['hipR', 'kneeR'], ['kneeR', 'ankleR'], ['ankleR', 'toeR'],
];
const dist = (sk: Skeleton, a: JointName, b: JointName): number => Math.hypot(sk[a].x - sk[b].x, sk[a].y - sk[b].y, sk[a].z - sk[b].z);

function run(doll: Ragdoll, sec: number, dt: number, wall: (t: number) => number | null = () => null, each?: (sk: Skeleton, t: number) => void): void {
  for (let t = 0; t < sec; t += dt) {
    doll.step(dt, wall(t));
    each?.(doll.skeleton(), t);
  }
}

describe('Ragdoll (the little figure after the wall hits it)', () => {
  it('starts exactly as the skeleton it was given', () => {
    const sk = getPose('star')!;
    const start = poseToSkeleton(sk, profile, { x: 0.3 });
    const doll = new Ragdoll(start, ENV);
    const got = doll.skeleton();
    for (const j of JOINTS) expect(got[j], j).toEqual(start[j]);
    expect(doll.sunk).toBe(false);
  });

  it('keeps its bones the length they were, however it is thrown about', () => {
    for (const dt of [1 / 60, 1 / 20]) {
      const start = standing();
      const doll = new Ragdoll(start, ENV);
      doll.kick({ x: 0.6, y: 2.5, z: 3.5 }, 4);
      run(doll, 3, dt, () => null, (sk) => {
        for (const [a, b] of BONES) {
          const was = dist(start, a, b);
          expect(Math.abs(dist(sk, a, b) - was) / was, `${a}-${b} at dt ${dt.toFixed(3)}`).toBeLessThan(0.03);
        }
      });
    }
  });

  it('never blows up: no NaN, nothing flung far away', () => {
    for (const dt of [1 / 60, 1 / 20, 0.1]) {
      const doll = new Ragdoll(standing(), ENV);
      doll.kick({ x: -1, y: 4, z: 4 }, 8);
      run(doll, 4, dt, () => null, (sk) => {
        for (const j of JOINTS) {
          for (const v of [sk[j].x, sk[j].y, sk[j].z]) expect(Number.isFinite(v)).toBe(true);
          expect(Math.hypot(sk[j].x, sk[j].y, sk[j].z)).toBeLessThan(20);
        }
      });
    }
  });

  it('knocked towards the audience, it goes over the edge and into the water', () => {
    const doll = new Ragdoll(standing(), ENV);
    doll.kick({ x: 0.2, y: 2, z: 3 }, 3);
    let wetAt = -1;
    run(doll, 3, 1 / 60, () => null, (_, t) => {
      if (wetAt < 0 && doll.sunk) wetAt = t;
    });
    expect(wetAt).toBeGreaterThan(0.2);
    expect(wetAt).toBeLessThan(2.5);
    expect(doll.skeleton().hipC.z).toBeGreaterThan(ENV.deckHalfD);
  });

  it('a wall coming through pushes every part of it along: nothing is left behind the wall', () => {
    const doll = new Ragdoll(standing(), ENV);
    // 墙面从 z = 0 走到台边 0.85，用 0.4 秒
    const wallAt = (t: number): number => Math.min(0.85, (t / 0.4) * 0.85);
    run(doll, 1.2, 1 / 60, wallAt, (sk, t) => {
      for (const j of JOINTS) expect(sk[j].z, `${j} at ${t.toFixed(2)}`).toBeGreaterThanOrEqual(wallAt(t) - 0.02);
    });
    // 被推到台边，掉下去了
    run(doll, 2, 1 / 60, () => 0.85);
    expect(doll.sunk).toBe(true);
  });

  it('left alone on the deck it crumples but does not fall through the floor', () => {
    const doll = new Ragdoll(standing(), ENV);
    run(doll, 2.5, 1 / 60, () => null, (sk) => {
      for (const j of JOINTS) expect(sk[j].y, j).toBeGreaterThan(-0.02);
    });
    expect(doll.sunk).toBe(false);
    expect(doll.skeleton().head.y).toBeLessThan(1.2); // 没有肌肉撑着，瘫下去了
  });

  it('floats near the surface instead of sinking forever', () => {
    const doll = new Ragdoll(standing(), ENV);
    doll.kick({ x: 0, y: 2, z: 3.5 }, 2);
    run(doll, 6, 1 / 60);
    const sk = doll.skeleton();
    for (const j of JOINTS) expect(sk[j].y, j).toBeGreaterThan(ENV.waterY - 1.3);
  });
});
