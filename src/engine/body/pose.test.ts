import { describe, expect, it } from 'vitest';
import {
  angleDiff,
  DEFAULT_ARM,
  DEFAULT_LEG,
  JOINTS,
  lerpSkeleton,
  LIMBS,
  limbAngle,
  measureLimbs,
  mirrorPose,
  poseFromSkeleton,
  poseToSkeleton,
  targetLimbs,
  type JointName,
  type PoseSpec,
  type Skeleton,
} from './pose';
import { ANKLE_H, defaultProfile } from './profile';

const base = { tier: 1 as const, upperOk: true, legL: DEFAULT_LEG, legR: DEFAULT_LEG };
const STAND: PoseSpec = { ...base, id: 'stand', name: '站', armL: DEFAULT_ARM, armR: DEFAULT_ARM };
const T: PoseSpec = { ...base, id: 't', name: 'T', armL: [{ a: 90 }, { a: 90 }], armR: [{ a: 90 }, { a: 90 }] };
const Y: PoseSpec = { ...base, id: 'y', name: 'Y', armL: [{ a: 148 }, { a: 150 }], armR: [{ a: 148 }, { a: 150 }] };
const ASYM: PoseSpec = { ...base, id: 'asym', name: '不对称', armL: [{ a: 150 }, { a: 150 }], armR: [{ a: 35 }, { a: -40 }] };
const LEAN: PoseSpec = { ...base, id: 'lean', name: '侧倾', armL: [{ a: 165 }, { a: 165 }], armR: [{ a: 10 }, { a: 5 }], spine: { a: 20 }, head: 6 };
const CROUCH: PoseSpec = {
  ...base,
  id: 'crouch',
  name: '深蹲',
  upperOk: false,
  armL: [{ a: 60 }, { a: 60 }],
  armR: [{ a: 60 }, { a: 60 }],
  legL: [{ a: 70, s: 0.5 }, { a: 0 }],
  legR: [{ a: 70, s: 0.5 }, { a: 0 }],
  spine: { a: 0, s: 0.8 },
};

const profile = defaultProfile();

describe('limbAngle', () => {
  it('is 0 pointing down, 90 pointing outward, 180 pointing up', () => {
    expect(limbAngle(0, 0, 0, -1, 1)).toBeCloseTo(0);
    expect(limbAngle(0, 0, 1, 0, 1)).toBeCloseTo(90);
    expect(limbAngle(0, 0, -1, 0, -1)).toBeCloseTo(90);
    expect(limbAngle(0, 0, 0, 1, 1)).toBeCloseTo(180);
    expect(limbAngle(0, 0, 0, 1, -1)).toBeCloseTo(180);
  });
  it('is negative when the limb crosses toward the other side', () => {
    expect(limbAngle(0, 0, -1, 0, 1)).toBeCloseTo(-90);
    expect(limbAngle(0, 0, 1, 0, -1)).toBeCloseTo(-90);
  });
});

describe('angleDiff', () => {
  it('takes the short way around', () => {
    expect(angleDiff(170, -170)).toBeCloseTo(20);
    expect(angleDiff(10, 350)).toBeCloseTo(20);
    expect(angleDiff(90, 90)).toBeCloseTo(0);
    expect(angleDiff(0, 180)).toBeCloseTo(180);
    expect(angleDiff(-30, 40)).toBeCloseTo(70);
  });
});

describe('poseToSkeleton', () => {
  it('stands a neutral body on the ground', () => {
    const sk = poseToSkeleton(STAND, profile);
    expect(sk.hipC.y).toBeCloseTo(0.82, 2);
    expect(sk.ankleL.y).toBeCloseTo(ANKLE_H);
    expect(sk.ankleR.y).toBeCloseTo(ANKLE_H);
    expect(sk.head.y).toBeCloseTo(1.51, 2);
    expect(sk.shoulderR.x).toBeCloseTo(0.16);
    expect(sk.shoulderL.x).toBeCloseTo(-0.16);
    expect(sk.wristR.y).toBeLessThan(sk.shoulderR.y - 0.45);
  });

  it('defines every joint', () => {
    const sk = poseToSkeleton(STAND, profile);
    for (const j of JOINTS) {
      expect(Number.isFinite(sk[j].x)).toBe(true);
      expect(Number.isFinite(sk[j].y)).toBe(true);
      expect(sk[j].z).toBe(0);
    }
  });

  it('spreads the arms for a T', () => {
    const sk = poseToSkeleton(T, profile);
    expect(sk.wristR.x).toBeCloseTo(0.66);
    expect(sk.wristR.y).toBeCloseTo(1.32);
    expect(sk.wristL.x).toBeCloseTo(-0.66);
    expect(sk.handR.x).toBeCloseTo(0.74);
  });

  it('lowers the hips when the legs are foreshortened', () => {
    const sk = poseToSkeleton(CROUCH, profile);
    expect(sk.hipC.y).toBeLessThan(0.7);
    expect(Math.min(sk.ankleL.y, sk.ankleR.y)).toBeCloseTo(ANKLE_H);
  });

  it('keeps the lower foot on the ground when one leg is raised', () => {
    const oneLeg: PoseSpec = { ...T, id: 'one', legR: [{ a: 10, s: 0.25 }, { a: 0 }] };
    const sk = poseToSkeleton(oneLeg, profile);
    expect(sk.ankleL.y).toBeCloseTo(ANKLE_H);
    expect(sk.ankleR.y).toBeGreaterThan(0.3);
  });

  it('leans the spine toward +x for a positive lean and keeps shoulders square to it', () => {
    const sk = poseToSkeleton(LEAN, profile);
    expect(sk.neck.x).toBeGreaterThan(sk.hipC.x + 0.15);
    expect(sk.shoulderR.y).toBeLessThan(sk.shoulderL.y);
  });

  it('shifts sideways with at.x', () => {
    const sk = poseToSkeleton(T, profile, { x: 0.4 });
    expect(sk.hipC.x).toBeCloseTo(0.4);
    expect(sk.wristR.x).toBeCloseTo(1.06);
  });
});

describe('measuring a skeleton', () => {
  it('measureLimbs recovers the angles the pose was built from', () => {
    const m = measureLimbs(poseToSkeleton(ASYM, profile), profile);
    expect(m.upperArmL.angle).toBeCloseTo(150);
    expect(m.forearmR.angle).toBeCloseTo(-40);
    expect(m.thighL.angle).toBeCloseTo(4);
    expect(m.spine.angle).toBeCloseTo(0);
    expect(m.upperArmR.scale).toBeCloseTo(1);
  });

  it('targetLimbs lists every limb with default scale 1', () => {
    const t = targetLimbs(CROUCH);
    expect(Object.keys(t).sort()).toEqual([...LIMBS].sort());
    expect(t.thighL).toEqual({ angle: 70, scale: 0.5 });
    expect(t.shinL).toEqual({ angle: 0, scale: 1 });
    expect(t.spine).toEqual({ angle: 0, scale: 0.8 });
    expect(targetLimbs(T).spine).toEqual({ angle: 0, scale: 1 });
  });

  it('does not record a few percent of measurement error as foreshortening', () => {
    // 胳膊明明伸直了，只是量出来短了百分之五六（关键点在抖，或者身材估得不太准）：存成姿势时不该带上"缩短"
    const sk = poseToSkeleton(T, profile);
    const measuredLonger = { ...profile, upperArm: profile.upperArm * 1.06, forearm: profile.forearm * 1.06 };
    const spec = poseFromSkeleton(sk, measuredLonger);
    for (const limb of [...spec.armL, ...spec.armR]) expect(limb.s).toBeUndefined();
    // 真的缩短了（短了一成以上）照样记下来
    const muchLonger = { ...profile, upperArm: profile.upperArm * 1.25 };
    expect(poseFromSkeleton(sk, muchLonger).armL[0].s).toBeCloseTo(0.8, 5);
  });

  it('round-trips pose → skeleton → pose', () => {
    for (const spec of [T, Y, ASYM, LEAN, CROUCH]) {
      const back = poseFromSkeleton(poseToSkeleton(spec, profile), profile);
      const want = targetLimbs(spec);
      const got = targetLimbs({ ...spec, ...back });
      for (const limb of LIMBS) {
        expect(angleDiff(got[limb].angle, want[limb].angle), `${spec.id} ${limb} angle`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(got[limb].scale - want[limb].scale), `${spec.id} ${limb} scale`).toBeLessThanOrEqual(0.03);
      }
    }
  });
});

describe('mirrorPose', () => {
  const flip = (sk: Skeleton): Skeleton => {
    const out = {} as Skeleton;
    for (const j of JOINTS) {
      const twin = (j.endsWith('L') ? j.slice(0, -1) + 'R' : j.endsWith('R') ? j.slice(0, -1) + 'L' : j) as JointName;
      out[twin] = { x: -sk[j].x, y: sk[j].y, z: sk[j].z };
    }
    return out;
  };

  it('produces the left-right flipped body', () => {
    for (const spec of [ASYM, LEAN]) {
      const mirrored = poseToSkeleton(mirrorPose(spec), profile);
      const flipped = flip(poseToSkeleton(spec, profile));
      for (const j of JOINTS) {
        expect(mirrored[j].x).toBeCloseTo(flipped[j].x, 9);
        expect(mirrored[j].y).toBeCloseTo(flipped[j].y, 9);
      }
    }
  });

  it('marks the id and undoes itself when applied twice', () => {
    expect(mirrorPose(ASYM).id).toBe('asym~m');
    expect(mirrorPose(mirrorPose(LEAN))).toEqual(LEAN);
  });
});

describe('lerpSkeleton', () => {
  it('blends joint positions', () => {
    const a = poseToSkeleton(STAND, profile);
    const b = poseToSkeleton(T, profile);
    const mid = lerpSkeleton(a, b, 0.5);
    expect(mid.wristR.x).toBeCloseTo((a.wristR.x + b.wristR.x) / 2);
    expect(lerpSkeleton(a, b, 0).wristR).toEqual(a.wristR);
    expect(lerpSkeleton(a, b, 1).wristR.y).toBeCloseTo(b.wristR.y);
  });
});
