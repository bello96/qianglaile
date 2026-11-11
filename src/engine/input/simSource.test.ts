import { describe, expect, it } from 'vitest';
import { LM } from '../body/landmarks';
import { fitSimilarity, toMetric } from '../body/metric';
import { DEFAULT_LEG, NEUTRAL, poseToSkeleton, type PoseSpec } from '../body/pose';
import { defaultProfile } from '../body/profile';
import { jointsToRawPose, SimPoseSource, skeletonToJoints33, type SimCamera } from './simSource';
import type { RawFrame } from './types';

const T: PoseSpec = { id: 't', name: 'T', tier: 1, upperOk: true, armL: [{ a: 90 }, { a: 90 }], armR: [{ a: 90 }, { a: 90 }], legL: DEFAULT_LEG, legR: DEFAULT_LEG };
const cam: SimCamera = { aspect: 16 / 9, s: 0.42, groundV: 0.95 };
const profile = defaultProfile();

/** 把一帧里的人换算回以髋为原点的米制关节。 */
const metricOf = (frame: RawFrame) => {
  const pose = frame.poses[0];
  return toMetric(pose, frame.aspect, fitSimilarity(pose, frame.aspect)!, 0.6);
};

describe('skeletonToJoints33', () => {
  it('fills all 33 MediaPipe landmarks from a skeleton', () => {
    const sk = poseToSkeleton(T, profile);
    const { joints, vis } = skeletonToJoints33(sk, profile);
    expect(joints).toHaveLength(33);
    expect(vis).toHaveLength(33);
    expect(joints[LM.rightWrist].x).toBeCloseTo(sk.wristR.x);
    expect(joints[LM.leftShoulder].x).toBeCloseTo(sk.shoulderL.x);
    expect(joints[LM.leftAnkle].y).toBeCloseTo(sk.ankleL.y);
    // 鼻子在头的前面（-z），两耳在头的两侧
    expect(joints[LM.nose].z).toBeLessThan(0);
    expect(joints[LM.leftEar].x).toBeLessThan(joints[LM.rightEar].x);
    // 手掌中心 = 食指根和小指根的中点
    expect((joints[LM.rightIndex].x + joints[LM.rightPinky].x) / 2).toBeCloseTo(sk.handR.x);
    expect((joints[LM.rightIndex].y + joints[LM.rightPinky].y) / 2).toBeCloseTo(sk.handR.y);
  });
});

describe('jointsToRawPose', () => {
  it('is the exact inverse of the metric conversion', () => {
    const sk = poseToSkeleton(T, profile, { x: 0.3 });
    const { joints, vis } = skeletonToJoints33(sk, profile);
    const pose = jointsToRawPose(joints, vis, cam);
    const sim = fitSimilarity(pose, cam.aspect)!;
    expect(sim.s).toBeCloseTo(cam.s, 6);
    const m = toMetric(pose, cam.aspect, sim, 0.6);
    for (const i of [LM.nose, LM.leftWrist, LM.rightWrist, LM.leftKnee, LM.rightAnkle, LM.leftFoot]) {
      expect(m.joints[i].x).toBeCloseTo(joints[i].x - sk.hipC.x, 6);
      expect(m.joints[i].y).toBeCloseTo(joints[i].y - sk.hipC.y, 6);
      expect(m.joints[i].z).toBeCloseTo(joints[i].z, 6);
    }
  });

  it('places a centred standing player in the middle of the frame, feet near the bottom', () => {
    const sk = poseToSkeleton(NEUTRAL, profile);
    const { joints, vis } = skeletonToJoints33(sk, profile);
    const pose = jointsToRawPose(joints, vis, cam);
    const hipX = (pose.image[LM.leftHip].x + pose.image[LM.rightHip].x) / 2;
    expect(hipX).toBeCloseTo(0.5);
    expect(pose.image[LM.leftAnkle].y).toBeGreaterThan(0.85);
    expect(pose.image[LM.leftAnkle].y).toBeLessThan(0.95);
    // 未镜像的图像里，玩家的左手在画面右边
    expect(pose.image[LM.leftWrist].x).toBeGreaterThan(pose.image[LM.rightWrist].x);
  });
});

describe('SimPoseSource', () => {
  it('emits one person per step with advancing timestamps', () => {
    const sim = new SimPoseSource({ noise: 0 });
    const a = sim.step(33);
    const b = sim.step(33);
    expect(b.t - a.t).toBe(33);
    expect(a.poses).toHaveLength(1);
    expect(a.aspect).toBeCloseTo(16 / 9);
    expect(sim.kind).toBe('sim');
    expect(sim.video).toBeNull();
  });

  it('can leave the frame', () => {
    const sim = new SimPoseSource();
    sim.setPresent(false);
    expect(sim.step(33).poses).toHaveLength(0);
    sim.setPresent(true);
    expect(sim.step(33).poses).toHaveLength(1);
  });

  it('notifies subscribers until they unsubscribe', () => {
    const sim = new SimPoseSource();
    const seen: number[] = [];
    const off = sim.onFrame((f) => seen.push(f.t));
    sim.step(33);
    sim.step(33);
    off();
    sim.step(33);
    expect(seen).toHaveLength(2);
  });

  it('moves smoothly from one pose to the next', () => {
    const sim = new SimPoseSource({ noise: 0 });
    const start = metricOf(sim.step(33)).joints[LM.rightWrist].x;
    sim.setPose(T, {}, 0.5);
    let frame = sim.step(250);
    const mid = metricOf(frame).joints[LM.rightWrist].x;
    expect(mid).toBeGreaterThan(start + 0.05);
    expect(mid).toBeLessThan(0.66 - 0.05);
    frame = sim.step(350);
    expect(metricOf(frame).joints[LM.rightWrist].x).toBeCloseTo(0.66, 2);
  });

  it('snaps immediately when the blend time is zero', () => {
    const sim = new SimPoseSource({ noise: 0 });
    sim.setPose(T, {}, 0);
    expect(metricOf(sim.step(33)).joints[LM.rightWrist].x).toBeCloseTo(0.66, 3);
  });

  it('moves sideways and off the ground', () => {
    const sim = new SimPoseSource({ noise: 0 });
    const base = sim.step(33).poses[0];
    sim.setPose(NEUTRAL, { x: 0.5 }, 0);
    const moved = sim.step(33).poses[0];
    // 玩家往自己的右边走 → 在未镜像的图像里往左（x 变小）
    expect(moved.image[LM.leftHip].x).toBeLessThan(base.image[LM.leftHip].x - 0.05);
    sim.setLift(0.25);
    const lifted = sim.step(33).poses[0];
    expect(lifted.image[LM.leftHip].y).toBeCloseTo(moved.image[LM.leftHip].y - 0.25 * 0.42, 5);
  });

  it('is deterministic for a seed, including noise', () => {
    const a = new SimPoseSource({ seed: 5 });
    const b = new SimPoseSource({ seed: 5 });
    const c = new SimPoseSource({ seed: 6 });
    for (let i = 0; i < 10; i++) {
      const fa = a.step(33);
      const fb = b.step(33);
      const fc = c.step(33);
      expect(fa).toEqual(fb);
      if (i === 9) expect(fa).not.toEqual(fc);
    }
  });

  it('adds noise of about the requested size', () => {
    const sim = new SimPoseSource({ noise: 0.008, seed: 2 });
    const xs: number[] = [];
    for (let i = 0; i < 200; i++) xs.push(sim.step(33).poses[0].image[LM.rightWrist].x * (16 / 9) / 0.42);
    const mean = xs.reduce((p, q) => p + q, 0) / xs.length;
    const std = Math.sqrt(xs.reduce((p, q) => p + (q - mean) ** 2, 0) / xs.length);
    expect(std).toBeGreaterThan(0.005);
    expect(std).toBeLessThan(0.011);
  });

  it('can hide the legs like a desk-height camera would', () => {
    const sim = new SimPoseSource({ legs: false });
    const pose = sim.step(33).poses[0];
    expect(pose.image[LM.leftAnkle].v).toBeCloseTo(0.1);
    expect(pose.image[LM.rightKnee].v).toBeCloseTo(0.1);
    expect(pose.image[LM.leftShoulder].v).toBeGreaterThan(0.9);
  });

  it('reports itself in stats', () => {
    expect(new SimPoseSource({ fps: 30 }).stats()).toEqual({ fps: 30, detectMs: 0, delegate: 'sim', model: 'sim' });
  });
});
