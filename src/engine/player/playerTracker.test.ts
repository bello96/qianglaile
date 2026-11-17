import { describe, expect, it } from 'vitest';
import { NEUTRAL, poseToSkeleton, type PoseSpec } from '../body/pose';
import { defaultProfile } from '../body/profile';
import { jointsToRawPose, SimPoseSource, skeletonToJoints33 } from '../input/simSource';
import type { RawFrame, RawPose } from '../input/types';
import { LaneSplit } from '../tracking/lanes';
import type { MotionEvent } from '../motion/features';
import { PlayerTracker } from './playerTracker';

const T: PoseSpec = { ...NEUTRAL, id: 't', armL: [{ a: 90 }, { a: 90 }], armR: [{ a: 90 }, { a: 90 }] };
const LEFT_UP: PoseSpec = { ...NEUTRAL, id: 'lu', armL: [{ a: 170 }, { a: 170 }] };

const feed = (tracker: PlayerTracker, sim: SimPoseSource, ms: number): MotionEvent[] => {
  const events: MotionEvent[] = [];
  for (let t = 0; t < ms; t += 33) events.push(...tracker.ingest(sim.step(33)).events);
  return events;
};

describe('PlayerTracker', () => {
  it('starts with nobody', () => {
    const s = new PlayerTracker().state;
    expect(s.present).toBe(false);
    expect(s.body).toBeNull();
    expect(s.profileReady).toBe(false);
    expect(s.profile).toEqual(defaultProfile());
  });

  it('sees the player from the first frame', () => {
    const tracker = new PlayerTracker();
    const state = tracker.ingest(new SimPoseSource().step(33));
    expect(state.present).toBe(true);
    expect(state.body).not.toBeNull();
    expect(state.lostMs).toBe(0);
    expect(tracker.state).toBe(state);
  });

  it('rides out a brief dropout but notices a real absence', () => {
    const tracker = new PlayerTracker();
    const sim = new SimPoseSource();
    feed(tracker, sim, 300);
    sim.setPresent(false);
    feed(tracker, sim, 200);
    expect(tracker.state.present).toBe(true);
    expect(tracker.state.body).toBeNull();
    feed(tracker, sim, 400);
    expect(tracker.state.present).toBe(false);
    expect(tracker.state.lostMs).toBeGreaterThanOrEqual(580);
    sim.setPresent(true);
    feed(tracker, sim, 100);
    expect(tracker.state.present).toBe(true);
    expect(tracker.state.lostMs).toBe(0);
  });

  it('calibrate makes the current spot x = 0', () => {
    const tracker = new PlayerTracker();
    const sim = new SimPoseSource({ noise: 0 });
    sim.setPose(NEUTRAL, { x: -0.5 }, 0);
    feed(tracker, sim, 300);
    tracker.calibrate();
    sim.setPose(NEUTRAL, { x: -0.2 }, 0);
    feed(tracker, sim, 1000);
    expect(tracker.state.body!.root.x).toBeCloseTo(0.3, 2);
  });

  it('calibrate hands back the visible window measured from the new origin', () => {
    // 玩家第一次被看到时站在一处，开局前又往旁边挪了 0.4 米。标定把原点挪到他现在站的地方；
    // "摄像头看得见的范围"是相对原点说的，也得跟着挪——否则出墙时用的是一扇挪歪了的窗
    const tracker = new PlayerTracker();
    const sim = new SimPoseSource({ noise: 0 });
    feed(tracker, sim, 300);
    sim.setPose(NEUTRAL, { x: 0.4 }, 0);
    feed(tracker, sim, 600);
    const before = tracker.state.body!.view;

    const view = tracker.calibrate();
    feed(tracker, sim, 300);
    const after = tracker.state.body!.view;

    expect(view).toBeTruthy();
    expect(view!.left).toBeCloseTo(after.left, 2);
    expect(view!.right).toBeCloseTo(after.right, 2);
    expect(view!.top).toBeCloseTo(after.top, 2);
    expect(view!.bottom).toBeCloseTo(after.bottom, 2);
    // 标定前的那扇窗确实偏了 0.4 米：玩家往右挪了，右边缘离他近了这么多
    expect(before.right - after.right).toBeCloseTo(0.4, 1);
  });

  it('after calibration, someone else elsewhere in the picture is not mistaken for the player', () => {
    const tracker = new PlayerTracker();
    const sim = new SimPoseSource({ noise: 0 });
    feed(tracker, sim, 400);
    tracker.calibrate();
    // 识别模型跟丢了玩家，转而给出 1.6 米外的另一个人。一帧里只有这一个人——真实情况就是这样
    sim.setPose(NEUTRAL, { x: 1.6 }, 0);
    feed(tracker, sim, 3000);
    expect(tracker.state.body).toBeNull();
    expect(tracker.state.present).toBe(false);
    // 那个人走了，玩家回到原位
    sim.setPose(NEUTRAL, { x: 0.05 }, 0);
    feed(tracker, sim, 300);
    expect(tracker.state.present).toBe(true);
    expect(tracker.state.body!.root.x).toBeCloseTo(0.05, 1);
  });

  it('before calibration it simply follows whoever is there', () => {
    const tracker = new PlayerTracker();
    const sim = new SimPoseSource({ noise: 0 });
    feed(tracker, sim, 400);
    sim.setPose(NEUTRAL, { x: 1.6 }, 0);
    feed(tracker, sim, 1500);
    expect(tracker.state.present).toBe(true);
  });

  it('calibrate returns no window when nobody has been seen yet', () => {
    expect(new PlayerTracker().calibrate()).toBeNull();
  });

  it('learns the player\'s proportions, then freezes them at calibration', () => {
    const slim = { ...defaultProfile(), upperArm: 0.22, forearm: 0.2 };
    const tracker = new PlayerTracker();
    const sim = new SimPoseSource({ profile: slim, noise: 0.004 });
    feed(tracker, sim, 400);
    sim.setPose(T);
    feed(tracker, sim, 1200);
    expect(tracker.state.profileReady).toBe(true);
    expect(Math.abs(tracker.state.profile.upperArm - 0.22)).toBeLessThan(0.02);
    expect(Math.abs(tracker.state.profile.forearm - 0.2)).toBeLessThan(0.02);

    tracker.calibrate();
    const frozen = structuredClone(tracker.state.profile);
    sim.setPose(LEFT_UP);
    feed(tracker, sim, 1500);
    expect(tracker.state.profile).toEqual(frozen);
  });

  it('passes motion events through', () => {
    const tracker = new PlayerTracker();
    const sim = new SimPoseSource();
    feed(tracker, sim, 500);
    sim.setPose(LEFT_UP);
    expect(feed(tracker, sim, 900)).toContain('handUpL');
    expect(tracker.state.motion.armLiftL).toBeGreaterThan(0.7);
  });

  it('can be forced into upper-body mode', () => {
    const tracker = new PlayerTracker();
    const sim = new SimPoseSource();
    tracker.setMode('upper');
    feed(tracker, sim, 200);
    expect(tracker.state.body!.mode).toBe('upper');
  });

  it('reset forgets a forced mode: what the next camera sees decides afresh', () => {
    // 上一局按全身标定过。引擎重启、换了一个只照得到上半身的摄像头：不能还硬说是全身
    const tracker = new PlayerTracker();
    feed(tracker, new SimPoseSource(), 300);
    tracker.calibrate();
    tracker.setMode('full');

    tracker.reset();
    feed(tracker, new SimPoseSource({ legs: false }), 900);
    expect(tracker.state.body!.mode).toBe('upper');

    tracker.setMode('upper');
    tracker.reset();
    feed(tracker, new SimPoseSource(), 900);
    expect(tracker.state.body!.mode).toBe('full');
  });

  it('sample() glides toward the newest skeleton between detections', () => {
    const tracker = new PlayerTracker();
    const sim = new SimPoseSource({ noise: 0 });
    expect(tracker.sample(0)).toBeNull();
    feed(tracker, sim, 200);
    const before = tracker.sample(1000)!.wristR.x;
    sim.setPose(T, {}, 0);
    tracker.ingest(sim.step(33));
    const target = tracker.state.body!.skeleton.wristR.x;
    const mid = tracker.sample(1016)!.wristR.x;
    expect(mid).toBeGreaterThan(before + 0.01);
    expect(mid).toBeLessThan(target - 0.01);
    let x = mid;
    for (let now = 1032; now < 1400; now += 16) x = tracker.sample(now)!.wristR.x;
    expect(x).toBeCloseTo(target, 2);
  });

  it('sample() does not share objects with the tracked body', () => {
    const tracker = new PlayerTracker();
    feed(tracker, new SimPoseSource(), 100);
    const s = tracker.sample(0)!;
    s.wristR.x = 99;
    expect(tracker.state.body!.skeleton.wristR.x).not.toBe(99);
  });

  it('reset forgets the player', () => {
    const tracker = new PlayerTracker();
    feed(tracker, new SimPoseSource(), 300);
    tracker.reset();
    expect(tracker.state.present).toBe(false);
    expect(tracker.state.body).toBeNull();
    expect(tracker.sample(0)).toBeNull();
  });
});

describe('PlayerTracker in a lane (two-player mode)', () => {
  const profile = defaultProfile();
  const ASPECT = 16 / 9;
  const person = (x: number): RawPose => {
    const { joints, vis } = skeletonToJoints33(poseToSkeleton(NEUTRAL, profile, { x }), profile);
    return jointsToRawPose(joints, vis, { aspect: ASPECT, s: 0.42, groundV: 0.95 });
  };
  const both = (t: number): RawFrame => ({ t, aspect: ASPECT, poses: [person(-0.75), person(0.75)] });

  it('calibrate can put the player at a given x instead of 0', () => {
    const sim = new SimPoseSource({ noise: 0 });
    const tracker = new PlayerTracker();
    feed(tracker, sim, 500);
    const view = tracker.calibrate({ x: 0.75 })!;
    feed(tracker, sim, 200);
    expect(tracker.state.body!.root.x).toBeCloseTo(0.75, 2);
    // 模拟玩家站在画面正中：看得见的范围以他为中心
    expect((view.left + view.right) / 2).toBeCloseTo(0.75, 2);
    expect(view.right - view.left).toBeCloseTo(ASPECT / 0.42, 1);
  });

  it('follows only the person on its side of the line', () => {
    const split = new LaneSplit();
    const p1 = new PlayerTracker();
    const p2 = new PlayerTracker();
    p1.setLane({ side: 'left', split });
    p2.setLane({ side: 'right', split });
    for (let t = 0; t < 600; t += 33) {
      p1.ingest(both(t));
      p2.ingest(both(t));
    }
    const hipX = (tr: PlayerTracker): number => (tr.state.body!.image[23].x + tr.state.body!.image[24].x) / 2;
    expect(hipX(p1)).toBeLessThan(0.5); // 镜像后的画面里，1 号在左
    expect(hipX(p2)).toBeGreaterThan(0.5);
  });

  it('even before calibration each player is on their own side of the stage, measured from the line between them', () => {
    // 开局前的站位画面上，两个小人就该一左一右地站着，而不是叠在正中
    const split = new LaneSplit();
    const p1 = new PlayerTracker();
    const p2 = new PlayerTracker();
    p1.setLane({ side: 'left', split });
    p2.setLane({ side: 'right', split });
    for (let t = 0; t < 600; t += 33) {
      const f = both(t);
      split.observe(f);
      p1.ingest(f);
      p2.ingest(f);
    }
    expect(p1.state.body!.root.x).toBeCloseTo(-0.75, 1);
    expect(p2.state.body!.root.x).toBeCloseTo(0.75, 1);

    // 两个人都站在画面的一侧也一样：以他们中间那条线为准
    const offside = (t: number): RawFrame => ({ t, aspect: ASPECT, poses: [person(0.3), person(1.7)] });
    const s2 = new LaneSplit();
    const q1 = new PlayerTracker();
    const q2 = new PlayerTracker();
    q1.setLane({ side: 'left', split: s2 });
    q2.setLane({ side: 'right', split: s2 });
    for (let t = 0; t < 1500; t += 33) {
      const f = offside(t);
      s2.observe(f);
      q1.ingest(f);
      q2.ingest(f);
    }
    expect(q1.state.body!.root.x).toBeCloseTo(-0.7, 1);
    expect(q2.state.body!.root.x).toBeCloseTo(0.7, 1);
  });

  it('a single player without lanes still starts at x = 0 wherever they stand', () => {
    const tracker = new PlayerTracker();
    for (let t = 0; t < 300; t += 33) tracker.ingest({ t, aspect: ASPECT, poses: [person(0.9)] });
    expect(tracker.state.body!.root.x).toBeCloseTo(0, 1);
  });

  it('calibrating freezes the dividing line, so it no longer drifts with the players', () => {
    const split = new LaneSplit();
    const p1 = new PlayerTracker();
    p1.setLane({ side: 'left', split });
    for (let t = 0; t < 300; t += 33) p1.ingest(both(t));
    expect(split.frozen).toBe(false);
    p1.calibrate({ x: -0.75 });
    expect(split.frozen).toBe(true);
    expect(p1.state.body).not.toBeNull();
  });
});
