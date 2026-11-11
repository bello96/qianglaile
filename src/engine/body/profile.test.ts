import { describe, expect, it } from 'vitest';
import { createRng } from '../util/rng';
import { DEFAULT_LEG, JOINTS, poseToSkeleton, type JointName, type Limb, type PoseSpec, type Skeleton } from './pose';
import { ANKLE_H, defaultProfile, ProfileEstimator, scaleProfile, standHeight, standHipHeight, type BodyProfile } from './profile';

const allOk = Object.fromEntries(JOINTS.map((j) => [j, true])) as Record<JointName, boolean>;

/** 用给定身材摆一串随机手臂姿势，加上关键点噪声，模拟标定时看到的数据。 */
function observeRandomPoses(est: ProfileEstimator, truth: BodyProfile, frames: number, opts: { shortEvery?: number } = {}): void {
  const rng = createRng(21);
  for (let f = 0; f < frames; f++) {
    const s = opts.shortEvery && f % opts.shortEvery === 0 ? 0.5 : 1;
    const arm = (): [Limb, Limb] => [{ a: rng.int(0, 180), s }, { a: rng.int(0, 180), s }];
    const leg: [Limb, Limb] = [{ a: DEFAULT_LEG[0].a, s }, { a: DEFAULT_LEG[1].a, s }];
    const spec: PoseSpec = { id: 'r', name: 'r', tier: 1, upperOk: true, armL: arm(), armR: arm(), legL: leg, legR: leg };
    const sk = poseToSkeleton(spec, truth);
    const noisy = {} as Skeleton;
    for (const j of JOINTS) noisy[j] = { x: sk[j].x + 0.005 * rng.gauss(), y: sk[j].y + 0.005 * rng.gauss(), z: 0 };
    est.observe(noisy, allOk);
  }
}

describe('BodyProfile defaults', () => {
  it('describes an average body in the model\'s metric space', () => {
    const p = defaultProfile();
    expect(p.shoulderW).toBeCloseTo(0.32);
    expect(p.torso).toBeCloseTo(0.5);
    expect(p.upperArm).toBeCloseTo(0.26);
    expect(p.forearm).toBeCloseTo(0.24);
    expect(p.thigh).toBeCloseTo(0.37);
    expect(p.shin).toBeCloseTo(0.38);
    expect(p.headR).toBeCloseTo(0.11);
    expect(p.r.arm).toBeCloseTo(0.045);
  });

  it('returns a fresh object each time', () => {
    const a = defaultProfile();
    a.thigh = 9;
    a.r.arm = 9;
    expect(defaultProfile().thigh).toBeCloseTo(0.37);
    expect(defaultProfile().r.arm).toBeCloseTo(0.045);
  });

  it('derives standing heights', () => {
    const p = defaultProfile();
    expect(ANKLE_H).toBeCloseTo(0.07);
    expect(standHipHeight(p)).toBeCloseTo(0.82);
    expect(standHeight(p)).toBeCloseTo(1.62);
  });

  it('scales lengths and radii together', () => {
    const p = scaleProfile(defaultProfile(), 0.8);
    expect(p.thigh).toBeCloseTo(0.296);
    expect(p.r.arm).toBeCloseTo(0.036);
    expect(p.shoulderW).toBeCloseTo(0.256);
  });
});

describe('ProfileEstimator', () => {
  const truth: BodyProfile = { ...defaultProfile(), thigh: 0.3, upperArm: 0.22, shoulderW: 0.26 };

  it('returns the base profile until it has seen enough frames', () => {
    const est = new ProfileEstimator();
    observeRandomPoses(est, truth, 12);
    expect(est.ready).toBe(false);
    expect(est.profile).toEqual(defaultProfile());
  });

  it('learns bone lengths from noisy observations', () => {
    const est = new ProfileEstimator();
    observeRandomPoses(est, truth, 60);
    expect(est.ready).toBe(true);
    expect(Math.abs(est.profile.thigh - 0.3)).toBeLessThan(0.015);
    expect(Math.abs(est.profile.upperArm - 0.22)).toBeLessThan(0.015);
    expect(Math.abs(est.profile.shoulderW - 0.26)).toBeLessThan(0.015);
    expect(Math.abs(est.profile.forearm - 0.24)).toBeLessThan(0.015);
  });

  it('is not fooled by foreshortened limbs', () => {
    const est = new ProfileEstimator();
    observeRandomPoses(est, truth, 60, { shortEvery: 3 });
    expect(Math.abs(est.profile.thigh - 0.3)).toBeLessThan(0.02);
    expect(Math.abs(est.profile.upperArm - 0.22)).toBeLessThan(0.02);
  });

  it('ignores bones whose joints are not visible', () => {
    const est = new ProfileEstimator();
    const sk = poseToSkeleton({ id: 's', name: 's', tier: 1, upperOk: true, armL: [{ a: 90 }, { a: 90 }], armR: [{ a: 90 }, { a: 90 }], legL: DEFAULT_LEG, legR: DEFAULT_LEG }, truth);
    const noLegs = { ...allOk, kneeL: false, kneeR: false, ankleL: false, ankleR: false };
    for (let i = 0; i < 40; i++) est.observe(sk, noLegs);
    expect(est.ready).toBe(true);
    expect(est.profile.upperArm).toBeCloseTo(0.22, 2);
    // 没见过腿：腿长按上半身的比例从默认值推算，而不是凭空给个数
    expect(est.profile.thigh).toBeGreaterThan(0.25);
    expect(est.profile.thigh).toBeLessThan(0.4);
  });

  it('keeps estimates within a sane range of the base profile', () => {
    const est = new ProfileEstimator();
    const giant = scaleProfile(defaultProfile(), 3);
    observeRandomPoses(est, giant, 40);
    expect(est.profile.thigh).toBeLessThanOrEqual(defaultProfile().thigh * 1.4 + 1e-9);
  });

  it('reset forgets everything', () => {
    const est = new ProfileEstimator();
    observeRandomPoses(est, truth, 60);
    est.reset();
    expect(est.ready).toBe(false);
    expect(est.profile).toEqual(defaultProfile());
  });
});
