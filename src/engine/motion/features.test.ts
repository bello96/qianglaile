import { describe, expect, it } from 'vitest';
import { BodyBuilder } from '../body/bodyModel';
import { NEUTRAL, type PoseSpec } from '../body/pose';
import { defaultProfile } from '../body/profile';
import { SimPoseSource, type SimOptions } from '../input/simSource';
import { MotionAnalyzer, type Motion, type MotionEvent } from './features';

const profile = defaultProfile();
const arms = (l: [number, number], r: [number, number] = l): Pick<PoseSpec, 'armL' | 'armR'> => ({
  armL: [{ a: l[0] }, { a: l[1] }],
  armR: [{ a: r[0] }, { a: r[1] }],
});
const T: PoseSpec = { ...NEUTRAL, id: 't', ...arms([90, 90]) };
const Y: PoseSpec = { ...NEUTRAL, id: 'y', ...arms([148, 150]) };
const LEFT_UP: PoseSpec = { ...NEUTRAL, id: 'left-up', ...arms([170, 170], [8, 4]) };
const CROUCH: PoseSpec = { ...NEUTRAL, id: 'crouch', legL: [{ a: 70, s: 0.5 }, { a: 0 }], legR: [{ a: 70, s: 0.5 }, { a: 0 }] };
const LEAN: PoseSpec = { ...NEUTRAL, id: 'lean', spine: { a: 20 } };
const KNEE_UP: PoseSpec = { ...NEUTRAL, id: 'knee', legR: [{ a: 10, s: 0.25 }, { a: 0 }] };
const WIDE: PoseSpec = { ...NEUTRAL, id: 'wide', legL: [{ a: 25 }, { a: 25 }], legR: [{ a: 25 }, { a: 25 }] };

/** 一条小流水线：模拟玩家 → Body → 动作分析。 */
class Rig {
  readonly sim: SimPoseSource;
  readonly builder = new BodyBuilder();
  readonly analyzer = new MotionAnalyzer();
  motion!: Motion;
  events: MotionEvent[] = [];

  constructor(opts: SimOptions = {}) {
    this.sim = new SimPoseSource({ seed: 4, ...opts });
  }

  run(ms: number): this {
    for (let t = 0; t < ms; t += 33) {
      const f = this.sim.step(33);
      const body = this.builder.update(f.poses[0], f.t, f.aspect, profile)!;
      const out = this.analyzer.update(body, profile);
      this.motion = out.motion;
      this.events.push(...out.events);
    }
    return this;
  }

  hold(spec: PoseSpec, ms = 700): this {
    this.sim.setPose(spec);
    return this.run(ms);
  }
}

describe('continuous features', () => {
  it('energy is near zero standing still and clearly higher when waving', () => {
    const rig = new Rig().run(2000);
    expect(rig.motion.energy).toBeLessThan(0.05);
    for (let i = 0; i < 8; i++) rig.hold(i % 2 ? NEUTRAL : T, 300);
    expect(rig.motion.energy).toBeGreaterThan(0.3);
  });

  it('armLift runs from about -1 (down) through 0 (level) to about +1 (up)', () => {
    expect(new Rig().run(700).motion.armLiftR).toBeLessThan(-0.8);
    expect(Math.abs(new Rig().hold(T).motion.armLiftR)).toBeLessThan(0.1);
    const y = new Rig().hold(Y).motion;
    expect(y.armLiftL).toBeGreaterThan(0.7);
    expect(y.armLiftR).toBeGreaterThan(0.7);
  });

  it('armLift is per side', () => {
    const m = new Rig().hold(LEFT_UP).motion;
    expect(m.armLiftL).toBeGreaterThan(0.7);
    expect(m.armLiftR).toBeLessThan(-0.8);
  });

  it('squat is 0 standing and rises when the hips drop', () => {
    expect(new Rig().run(700).motion.squat).toBeLessThan(0.05);
    expect(new Rig().hold(CROUCH).motion.squat).toBeGreaterThan(0.7);
  });

  it('lean follows the spine angle, 30° = 1', () => {
    const lean = new Rig().hold(LEAN).motion.lean;
    expect(lean).toBeGreaterThan(0.57);
    expect(lean).toBeLessThan(0.77);
    expect(Math.abs(new Rig().run(700).motion.lean)).toBeLessThan(0.05);
  });

  it('feetApart and kneeLift', () => {
    expect(new Rig().run(700).motion.feetApart).toBeLessThan(1);
    expect(new Rig().hold(WIDE).motion.feetApart).toBeGreaterThan(1.8);
    const knee = new Rig().hold(KNEE_UP).motion;
    expect(knee.kneeLiftR).toBeGreaterThan(0.5);
    expect(knee.kneeLiftL).toBeLessThan(0.1);
  });
});

describe('events', () => {
  it('one squat = one squatDown followed by one squatUp', () => {
    const rig = new Rig().run(500).hold(CROUCH, 900).hold(NEUTRAL, 900);
    expect(rig.events.filter((e) => e.startsWith('squat'))).toEqual(['squatDown', 'squatUp']);
  });

  it('raising a hand fires once for that side only', () => {
    const rig = new Rig().run(500).hold(LEFT_UP, 900);
    expect(rig.events.filter((e) => e.startsWith('handUp'))).toEqual(['handUpL']);
    rig.hold(NEUTRAL, 900).hold(LEFT_UP, 900);
    expect(rig.events.filter((e) => e === 'handUpL')).toHaveLength(2);
  });

  it('a hop fires exactly one jump', () => {
    const rig = new Rig().run(1000);
    rig.sim.setLift(0.25);
    rig.run(300);
    rig.sim.setLift(0);
    rig.run(1000);
    expect(rig.events.filter((e) => e === 'jump')).toHaveLength(1);
  });

  it('standing still fires nothing', () => {
    expect(new Rig().run(3000).events).toEqual([]);
  });

  it('reset clears event state', () => {
    const rig = new Rig().run(500).hold(CROUCH, 900);
    rig.analyzer.reset();
    rig.events = [];
    rig.hold(NEUTRAL, 900);
    expect(rig.events).toEqual([]); // 没有"蹲下"在先，就不该报"起身"
  });
});

describe('upper-body mode', () => {
  it('leg features stay quiet when the legs are synthesised', () => {
    const m = new Rig({ legs: false }).hold(T).motion;
    expect(m.squat).toBeLessThan(0.05);
    expect(m.kneeLiftL).toBeLessThan(0.05);
    expect(Math.abs(m.armLiftL)).toBeLessThan(0.1);
  });
});
