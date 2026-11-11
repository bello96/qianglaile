import { describe, expect, it } from 'vitest';
import { SimPoseSource, type SimOptions } from '../input/simSource';
import type { RawPose } from '../input/types';
import { BodyBuilder, type Body } from './bodyModel';
import { LM } from './landmarks';
import { JOINTS, NEUTRAL, poseToSkeleton, type PoseSpec } from './pose';
import { ANKLE_H, defaultProfile } from './profile';

const profile = defaultProfile();
const ASPECT = 16 / 9;
const T: PoseSpec = { ...NEUTRAL, id: 't', name: 'T', armL: [{ a: 90 }, { a: 90 }], armR: [{ a: 90 }, { a: 90 }] };
const CROUCH: PoseSpec = { ...NEUTRAL, id: 'crouch', name: '蹲', upperOk: false, legL: [{ a: 70, s: 0.5 }, { a: 0 }], legR: [{ a: 70, s: 0.5 }, { a: 0 }] };

/** 让模拟玩家摆好姿势后连喂若干帧，返回每一帧算出来的 Body。 */
function run(opts: SimOptions, setup: (sim: SimPoseSource, builder: BodyBuilder) => void = () => {}, frames = 6): { bodies: (Body | null)[]; builder: BodyBuilder; sim: SimPoseSource } {
  const sim = new SimPoseSource(opts);
  const builder = new BodyBuilder();
  setup(sim, builder);
  const bodies: (Body | null)[] = [];
  for (let i = 0; i < frames; i++) {
    const f = sim.step(33);
    bodies.push(builder.update(f.poses[0], f.t, f.aspect, profile));
  }
  return { bodies, builder, sim };
}
const last = <T>(xs: T[]): T => xs[xs.length - 1];

describe('BodyBuilder', () => {
  it('reconstructs the skeleton the simulated player is holding', () => {
    const { bodies } = run({ noise: 0 }, (sim) => sim.setPose(T, {}, 0));
    const body = last(bodies)!;
    const want = poseToSkeleton(T, profile);
    for (const j of ['wristR', 'wristL', 'elbowR', 'kneeL', 'ankleR', 'shoulderL', 'hipC', 'handR'] as const) {
      expect(body.skeleton[j].x, j).toBeCloseTo(want[j].x, 2);
      expect(body.skeleton[j].y, j).toBeCloseTo(want[j].y, 2);
    }
    expect(body.root.y).toBeCloseTo(0.82, 2);
    expect(body.root.x).toBeCloseTo(0, 2);
    expect(body.mode).toBe('full');
    for (const j of JOINTS) expect(body.ok[j], j).toBe(true);
  });

  it('puts the head between the ears', () => {
    const { bodies } = run({ noise: 0 });
    const body = last(bodies)!;
    const want = poseToSkeleton(NEUTRAL, profile);
    expect(body.skeleton.head.x).toBeCloseTo(want.head.x, 2);
    expect(body.skeleton.head.y).toBeCloseTo(want.head.y, 2);
  });

  it('lowers the root when the player crouches and keeps the feet on the ground', () => {
    const { bodies } = run({ noise: 0 }, (sim) => sim.setPose(CROUCH, {}, 0));
    const body = last(bodies)!;
    expect(body.root.y).toBeLessThan(0.72);
    expect(body.skeleton.ankleL.y).toBeCloseTo(ANKLE_H, 2);
    expect(body.skeleton.ankleR.y).toBeCloseTo(ANKLE_H, 2);
  });

  it('measures sideways movement from the home position', () => {
    const sim = new SimPoseSource({ noise: 0 });
    const builder = new BodyBuilder();
    expect(builder.hasHome).toBe(false);
    let f = sim.step(33);
    builder.update(f.poses[0], f.t, f.aspect, profile);
    expect(builder.hasHome).toBe(true); // 第一帧自动把当前位置当作原点
    sim.setPose(NEUTRAL, { x: 0.4 }, 0);
    let body: Body | null = null;
    for (let i = 0; i < 30; i++) {
      f = sim.step(33);
      body = builder.update(f.poses[0], f.t, f.aspect, profile);
    }
    expect(body!.root.x).toBeCloseTo(0.4, 2);
    expect(body!.skeleton.hipC.x).toBeCloseTo(0.4, 2);

    builder.setHome(); // 把现在站的地方重新记为原点
    f = sim.step(33);
    body = builder.update(f.poses[0], f.t, f.aspect, profile);
    expect(body!.root.x).toBeCloseTo(0, 2);
  });

  it('switches to upper-body mode when the legs are not visible, and synthesises standing legs', () => {
    const { bodies } = run({ noise: 0, legs: false });
    const body = last(bodies)!;
    expect(body.mode).toBe('upper');
    expect(body.root.y).toBeCloseTo(0.82, 2);
    expect(body.skeleton.ankleL.y).toBeCloseTo(ANKLE_H, 2);
    expect(body.skeleton.kneeR.y).toBeGreaterThan(0.3);
    expect(body.ok.ankleL).toBe(true);
    expect(body.ok.wristR).toBe(true);
  });

  it('honours a forced mode', () => {
    const upper = run({ noise: 0 }, (_, b) => (b.forceMode = 'upper'));
    expect(last(upper.bodies)!.mode).toBe('upper');
    const full = run({ noise: 0, legs: false }, (_, b) => (b.forceMode = 'full'));
    const body = last(full.bodies)!;
    expect(body.mode).toBe('full');
    expect(body.ok.kneeL).toBe(false);
    expect(body.ok.ankleR).toBe(false);
  });

  it('does not flip modes on a brief loss of the legs', () => {
    const sim = new SimPoseSource({ noise: 0 });
    const builder = new BodyBuilder();
    const hideLegs = (pose: RawPose): RawPose => ({
      image: pose.image.map((l, i) => (i >= LM.leftKnee ? { ...l, v: 0.1 } : l)),
      world: pose.world,
    });
    let f = sim.step(33);
    expect(builder.update(f.poses[0], f.t, f.aspect, profile)!.mode).toBe('full');
    // 腿被挡住 0.2 秒：还是全身模式
    let body: Body | null = null;
    for (let i = 0; i < 6; i++) {
      f = sim.step(33);
      body = builder.update(hideLegs(f.poses[0]), f.t, f.aspect, profile);
    }
    expect(body!.mode).toBe('full');
    // 一直看不到，超过 0.5 秒：切到半身
    for (let i = 0; i < 12; i++) {
      f = sim.step(33);
      body = builder.update(hideLegs(f.poses[0]), f.t, f.aspect, profile);
    }
    expect(body!.mode).toBe('upper');
  });

  it('reports how much of the stage the camera can see', () => {
    const { bodies } = run({ noise: 0 });
    const view = last(bodies)!.view;
    expect(view.top).toBeCloseTo(0.95 / 0.42, 1);
    expect(Math.abs(view.top - 2.262)).toBeLessThan(0.02);
    expect(Math.abs(view.bottom - -0.119)).toBeLessThan(0.02);
    expect(Math.abs(view.left - -2.116)).toBeLessThan(0.02);
    expect(Math.abs(view.right - 2.116)).toBeLessThan(0.02);
  });

  it('mirrors the image landmarks so the player\'s right hand is on the right', () => {
    const { bodies } = run({ noise: 0 }, (sim) => sim.setPose(T, {}, 0));
    const body = last(bodies)!;
    expect(body.image).toHaveLength(33);
    expect(body.image[LM.rightWrist].x).toBeGreaterThan(0.6);
    expect(body.image[LM.leftWrist].x).toBeLessThan(0.4);
  });

  it('steadies a noisy pose', () => {
    const { bodies } = run({ noise: 0.008, seed: 3 }, (sim) => sim.setPose(T, {}, 0), 45);
    const xs = bodies.slice(15).map((b) => b!.skeleton.wristR.x);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    expect(std).toBeLessThan(0.006);
  });

  it('returns null when it cannot see enough of the person', () => {
    const sim = new SimPoseSource({ noise: 0 });
    const f = sim.step(33);
    const hidden: RawPose = { image: f.poses[0].image.map((l) => ({ ...l, v: 0 })), world: f.poses[0].world };
    expect(new BodyBuilder().update(hidden, f.t, ASPECT, profile)).toBeNull();
  });

  it('reset forgets the home position and filter state', () => {
    const { builder, sim } = run({ noise: 0 });
    builder.reset();
    expect(builder.hasHome).toBe(false);
    sim.setPose(NEUTRAL, { x: 0.5 }, 0);
    const f = sim.step(33);
    expect(builder.update(f.poses[0], f.t, f.aspect, profile)!.root.x).toBeCloseTo(0, 2);
  });
});
