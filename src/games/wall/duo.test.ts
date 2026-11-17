import { describe, expect, it } from 'vitest';
import { BodyBuilder, type Body } from '../../engine/body/bodyModel';
import { NEUTRAL, poseToSkeleton, type PoseSpec } from '../../engine/body/pose';
import { defaultProfile, scaleProfile, type BodyProfile } from '../../engine/body/profile';
import { SimPoseSource } from '../../engine/input/simSource';
import { rad2deg } from '../../engine/util/math';
import { sdCircle } from '../../engine/util/sdf';
import { skeletonCapsules } from './bodyShape';
import { bodyGap, duoArmAngle, mergeHoles, pairGap } from './duo';
import { duoPose, getPose } from './poses';
import { COMMON } from './tuning';

const profile = defaultProfile();
const caps = (pose: PoseSpec, x: number, p: BodyProfile = profile) => skeletonCapsules(poseToSkeleton(pose, p, { x }), p);
const T = getPose('t')!;

describe('duoArmAngle (how high the inner arm goes in the two-player poses)', () => {
  it('holding hands: slants the arm down just enough for the two hands to meet half-way', () => {
    // 两人隔 1.2 米：肩到中线 0.6 − 0.16 = 0.44；减去半条缝和手的半径，手心要够到 0.365；手臂连手长 0.58
    expect(duoArmAngle('hold-hands', profile, 0.6)).toBeCloseTo(rad2deg(Math.asin(0.365 / 0.58)), 1);
    expect(duoArmAngle('hold-hands', profile, 0.75)).toBeGreaterThan(duoArmAngle('hold-hands', profile, 0.6));
  });

  it('holds the arm straight out when they stand too far apart to reach', () => {
    expect(duoArmAngle('hold-hands', profile, 0.95)).toBe(90);
    expect(duoArmAngle('bridge', profile, 0.95)).toBe(90);
  });

  it('a bridge is the same reach, upwards', () => {
    expect(duoArmAngle('bridge', profile, 0.6)).toBeCloseTo(180 - duoArmAngle('hold-hands', profile, 0.6), 6);
  });

  it('never points the arm away from the partner, however close they stand', () => {
    expect(duoArmAngle('hold-hands', profile, 0.1)).toBe(0);
    expect(duoArmAngle('bridge', profile, 0.1)).toBe(180);
  });

  it('with those angles the two hands end up 5 cm apart in the middle', () => {
    for (const gap of [1.2, 1.5]) {
      for (const id of ['hold-hands', 'bridge'] as const) {
        const a = poseToSkeleton(duoPose(id, -1, duoArmAngle(id, profile, gap / 2)), profile, { x: -gap / 2 });
        const b = poseToSkeleton(duoPose(id, 1, duoArmAngle(id, profile, gap / 2)), profile, { x: gap / 2 });
        expect(b.handL.x - a.handR.x, `${id} at ${gap}`).toBeCloseTo(COMMON.duo.handGap + 2 * profile.r.hand, 3);
        expect(a.handR.x, `${id} at ${gap}`).toBeLessThan(0);
        expect(b.handL.y).toBeCloseTo(a.handR.y, 6);
      }
    }
  });

  it('a long-armed and a short-armed player each reach to the middle with their own arm', () => {
    const kid = scaleProfile(profile, 0.7);
    expect(duoArmAngle('hold-hands', kid, 0.6)).toBeGreaterThan(duoArmAngle('hold-hands', profile, 0.6));
  });
});

describe('bodyGap (the clear space between two bodies)', () => {
  it('measures from outline to outline', () => {
    // 两个 T 字各站在 ±1.0：内侧的手心在 ±0.26，手的半径 0.05 → 之间空 0.42
    expect(bodyGap(caps(T, -1.0), caps(T, 1.0))).toBeCloseTo(0.42, 2);
  });

  it('is negative when they overlap', () => {
    expect(bodyGap(caps(T, -0.7), caps(T, 0.7))).toBeLessThan(0);
  });

  it('notices limbs that cross even though no joint is near another', () => {
    // 1 号的手臂水平伸过去，2 号的手臂竖直举着：两条线段相交，端点之间却隔着十几厘米
    const reach = caps(T, -0.45);
    const up = caps(getPose('up')!, 0.05);
    expect(bodyGap(reach, up)).toBeLessThan(0);
  });

  it('does not care which of the two is given first', () => {
    const a = caps(getPose('disco')!, -0.6);
    const b = caps(getPose('wave')!, 0.6);
    expect(bodyGap(a, b)).toBeCloseTo(bodyGap(b, a), 9);
  });

  it('a tall and a short player holding hands do not overlap', () => {
    const kid = scaleProfile(profile, 0.7);
    for (const gap of [1.2, 1.5, 1.9]) {
      const a = caps(duoPose('hold-hands', -1, duoArmAngle('hold-hands', profile, gap / 2)), -gap / 2);
      const b = caps(duoPose('hold-hands', 1, duoArmAngle('hold-hands', kid, gap / 2)), gap / 2, kid);
      expect(bodyGap(a, b), `gap ${gap}`).toBeGreaterThanOrEqual(COMMON.duo.handGap - 0.01);
    }
  });
});

describe('pairGap (how far apart two players stand, from what the camera sees)', () => {
  function seen(gap: number, cam: { s?: number } = {}): [Body, Body] {
    const sim = new SimPoseSource({ noise: 0, people: 2, gap, cam });
    const builders = [new BodyBuilder(), new BodyBuilder()];
    let bodies: (Body | null)[] = [null, null];
    for (let i = 0; i < 8; i++) {
      const f = sim.step(33);
      bodies = builders.map((b, k) => b.update(f.poses[k], f.t, f.aspect, profile));
    }
    return [bodies[0]!, bodies[1]!];
  }

  it('is the distance in metres, whatever the zoom', () => {
    expect(pairGap(...seen(1.4))).toBeCloseTo(1.4, 1);
    expect(pairGap(...seen(1.4, { s: 0.3 }))).toBeCloseTo(1.4, 1);
    expect(pairGap(...seen(1.9))).toBeCloseTo(1.9, 1);
  });

  it('is zero rather than nonsense when it cannot tell', () => {
    const [a, b] = seen(1.4);
    expect(pairGap({ ...a, image: [] }, b)).toBe(0);
  });
});

describe('mergeHoles (two holes on one wall)', () => {
  const D = COMMON.duo.minStrip;
  const twoCircles = (edgeGap: number) => {
    const half = 0.3 + edgeGap / 2;
    return mergeHoles(sdCircle(-half, 1, 0.3), sdCircle(half, 1, 0.3));
  };

  it('leaves the wall between them alone when there is a decent strip of it', () => {
    const hole = twoCircles(0.4);
    expect(hole(0, 1)).toBeGreaterThan(0.1); // 正中是墙
    // 洞的边还在原来的地方（左边那个圆的内侧边在 x = -0.2）
    expect(hole(-0.19, 1)).toBeGreaterThan(0);
    expect(hole(-0.21, 1)).toBeLessThan(0);
    expect(hole(-0.5, 1)).toBeLessThan(0);
    expect(hole(0.5, 1)).toBeLessThan(0);
  });

  it('carves away a strip that would be too thin to read as wall, so the holes join', () => {
    expect(D).toBe(0.1);
    expect(twoCircles(0.06)(0, 1)).toBeLessThan(0);
    expect(twoCircles(0.02)(0, 1)).toBeLessThan(0);
    // 只挖最窄的那一段：往上走，两个圆之间变宽了，墙还在
    expect(twoCircles(0.06)(0, 1.25)).toBeGreaterThan(0);
  });

  it('is simply both holes when they already overlap', () => {
    const hole = mergeHoles(sdCircle(-0.2, 1, 0.3), sdCircle(0.2, 1, 0.3));
    expect(hole(0, 1)).toBeLessThan(0);
    expect(hole(-0.45, 1)).toBeLessThan(0);
    expect(hole(0, 1.6)).toBeGreaterThan(0);
  });
});

describe('standing side by side', () => {
  it('two people standing naturally fit comfortably at the minimum distance', () => {
    const g = COMMON.duo.minGap;
    expect(bodyGap(caps(NEUTRAL, -g / 2), caps(NEUTRAL, g / 2))).toBeGreaterThan(0.5);
  });
});
