import { describe, expect, it } from 'vitest';
import type { Body } from '../body/bodyModel';
import { JOINTS, NEUTRAL, poseToSkeleton, type JointName, type PoseSpec } from '../body/pose';
import { defaultProfile, scaleProfile } from '../body/profile';
import { AirCursor, airCursorWanted, DwellClicker } from './airCursor';

const profile = defaultProfile();
const allOk = Object.fromEntries(JOINTS.map((j) => [j, true])) as Record<JointName, boolean>;

function bodyOf(spec: PoseSpec, t: number, tweak?: (b: Body) => void): Body {
  const sk = poseToSkeleton(spec, profile);
  const body: Body = { t, skeleton: sk, ok: { ...allOk }, root: { ...sk.hipC }, mode: 'full', view: { left: -2, right: 2, bottom: 0, top: 2.2 }, scale: 0.42, image: [] };
  tweak?.(body);
  return body;
}
const RIGHT_UP: PoseSpec = { ...NEUTRAL, id: 'ru', armR: [{ a: 176 }, { a: 178 }] };
const LEFT_UP: PoseSpec = { ...NEUTRAL, id: 'lu', armL: [{ a: 176 }, { a: 178 }] };
const BOTH_UP: PoseSpec = { ...NEUTRAL, id: 'bu', armL: [{ a: 150 }, { a: 150 }], armR: [{ a: 176 }, { a: 178 }] };

/** 让光标稳定下来：同一个姿势连喂若干帧。 */
function settle(cursor: AirCursor, spec: PoseSpec, from = 0, frames = 20, tweak?: (b: Body) => void) {
  let state = cursor.update(null, profile);
  for (let i = 0; i < frames; i++) state = cursor.update(bodyOf(spec, from + i * 33, tweak), profile);
  return state;
}

describe('AirCursor', () => {
  it('is inactive with both hands down or nobody there', () => {
    const cursor = new AirCursor();
    expect(cursor.update(null, profile).active).toBe(false);
    expect(settle(cursor, NEUTRAL)).toMatchObject({ active: false, hand: null });
  });

  it('follows a raised right hand, starting near the middle', () => {
    const s = settle(new AirCursor(), RIGHT_UP);
    expect(s.active).toBe(true);
    expect(s.hand).toBe('R');
    expect(s.x).toBeGreaterThan(0.35);
    expect(s.x).toBeLessThan(0.65);
    expect(s.y).toBeLessThan(0.3); // 手举得很高 → 光标靠上
  });

  it('reaches the top, the bottom and both sides of the screen without stretching — for an adult and for a child', () => {
    // 屏幕顶上要是够不着，放在那儿的按钮就点不到。范围得按这个人自己的臂长来定
    const reach = (spec: PoseSpec, p = profile, tweak?: (b: Body) => void) => {
      const cursor = new AirCursor();
      let s = cursor.update(null, p);
      for (let i = 0; i < 20; i++) {
        const sk = poseToSkeleton(spec, p);
        const body: Body = { t: i * 33, skeleton: sk, ok: { ...allOk }, root: { ...sk.hipC }, mode: 'full', view: { left: -2, right: 2, bottom: 0, top: 2.2 }, scale: 0.42, image: [] };
        tweak?.(body);
        s = cursor.update(body, p);
      }
      return s;
    };
    /** 把右手放到"刚好算举起来"的高度：手腕比肩高 6 厘米 */
    const barelyUp = (b: Body): void => {
      const sh = b.skeleton.shoulderR;
      b.skeleton.wristR = { x: sh.x + 0.2, y: sh.y + 0.06, z: 0 };
      b.skeleton.handR = { x: sh.x + 0.25, y: sh.y + 0.065, z: 0 };
    };
    const outRight: PoseSpec = { ...NEUTRAL, id: 'side', armR: [{ a: 100 }, { a: 105 }] }; // 胳膊往右平伸，略高于肩
    const acrossLeft: PoseSpec = { ...NEUTRAL, id: 'across', armR: [{ a: -170 }, { a: -110 }] }; // 右手抬起来、横到左肩前面
    for (const p of [profile, scaleProfile(profile, 0.72)]) {
      expect(reach(RIGHT_UP, p).y).toBeLessThan(0.06);
      expect(reach(RIGHT_UP, p, barelyUp).y).toBeGreaterThan(0.9);
      expect(reach(outRight, p).x).toBeGreaterThan(0.94);
      expect(reach(acrossLeft, p).x).toBeLessThan(0.3);
    }
  });

  it('follows a raised left hand too', () => {
    const s = settle(new AirCursor(), LEFT_UP);
    expect(s).toMatchObject({ active: true, hand: 'L' });
    expect(s.x).toBeGreaterThan(0.35);
    expect(s.x).toBeLessThan(0.65);
  });

  it('moves right when the hand moves to the player\'s right, and down when it drops', () => {
    const base = settle(new AirCursor(), RIGHT_UP);
    const shifted = settle(new AirCursor(), RIGHT_UP, 0, 20, (b) => (b.skeleton.handR.x += 0.3));
    expect(shifted.x).toBeGreaterThan(base.x + 0.2);
    const lower = settle(new AirCursor(), RIGHT_UP, 0, 20, (b) => (b.skeleton.handR.y -= 0.3));
    expect(lower.y).toBeGreaterThan(base.y + 0.25);
  });

  it('stays within the screen however far the hand reaches', () => {
    const s = settle(new AirCursor(), RIGHT_UP, 0, 20, (b) => {
      b.skeleton.handR.x += 3;
      b.skeleton.handR.y += 3;
    });
    expect(s.x).toBeLessThanOrEqual(1);
    expect(s.y).toBeGreaterThanOrEqual(0);
  });

  it('uses the higher hand when both are up, and does not flip-flop', () => {
    const cursor = new AirCursor();
    expect(settle(cursor, BOTH_UP).hand).toBe('R');
    // 左手后来举得更高，但右手还举着：不换手，免得光标乱跳
    const still = settle(cursor, BOTH_UP, 700, 10, (b) => (b.skeleton.handL.y += 0.4));
    expect(still.hand).toBe('R');
  });

  it('glides instead of jumping', () => {
    const cursor = new AirCursor();
    const start = settle(cursor, RIGHT_UP);
    const next = cursor.update(bodyOf(RIGHT_UP, 20 * 33, (b) => (b.skeleton.handR.x += 0.3)), profile);
    expect(next.x).toBeGreaterThan(start.x);
    expect(next.x).toBeLessThan(start.x + 0.25);
  });

  it('lets go a moment after the hand comes down', () => {
    const cursor = new AirCursor();
    settle(cursor, RIGHT_UP);
    let s = cursor.update(bodyOf(NEUTRAL, 700), profile);
    expect(s.active).toBe(true); // 刚放下：再等一下，免得手抖一下光标就没了
    s = cursor.update(bodyOf(NEUTRAL, 1100), profile);
    expect(s).toMatchObject({ active: false, hand: null });
  });

  it('ignores a hand it cannot see', () => {
    const s = settle(new AirCursor(), RIGHT_UP, 0, 20, (b) => (b.ok.wristR = false));
    expect(s.active).toBe(false);
  });
});

describe('DwellClicker', () => {
  it('fires once after the cursor rests on a target long enough', () => {
    const d = new DwellClicker(1100);
    expect(d.update('again', 0)).toEqual({ progress: 0, fire: null });
    expect(d.update('again', 550).progress).toBeCloseTo(0.5);
    expect(d.update('again', 1099).fire).toBeNull();
    expect(d.update('again', 1100)).toEqual({ progress: 1, fire: 'again' });
  });

  it('does not fire again until the cursor leaves and comes back', () => {
    const d = new DwellClicker(1100);
    d.update('again', 0);
    d.update('again', 1100);
    expect(d.update('again', 3000).fire).toBeNull();
    d.update(null, 3100);
    d.update('again', 3200);
    expect(d.update('again', 4300).fire).toBe('again');
  });

  it('starts over when the cursor moves to another target or off all targets', () => {
    const d = new DwellClicker(1100);
    d.update('again', 0);
    d.update('again', 800);
    expect(d.update('home', 900).progress).toBe(0);
    expect(d.update('home', 1500).fire).toBeNull();
    expect(d.update('home', 2000).fire).toBe('home');

    d.update('again', 2100);
    d.update('again', 2900);
    expect(d.update(null, 3000)).toEqual({ progress: 0, fire: null });
    expect(d.update('again', 3100).progress).toBe(0);
  });
});

describe('airCursorWanted', () => {
  const ok = { ready: true, kind: 'camera', modalOpen: false, hasTargets: true } as const;

  it('shows the cursor when a real person is on camera and there is something to point at', () => {
    expect(airCursorWanted(ok)).toBe(true);
  });

  it('never lets a simulated player or a recording press buttons', () => {
    // 演示或者回放到某个举着手的姿势时，暂停面板上的"回首页"不能自己被点下去
    expect(airCursorWanted({ ...ok, kind: 'sim' })).toBe(false);
    expect(airCursorWanted({ ...ok, kind: 'replay' })).toBe(false);
  });

  it('stays hidden while a dialog is open, when there is nothing to point at, or before the engine is ready', () => {
    expect(airCursorWanted({ ...ok, modalOpen: true })).toBe(false);
    expect(airCursorWanted({ ...ok, hasTargets: false })).toBe(false);
    expect(airCursorWanted({ ...ok, ready: false })).toBe(false);
  });
});
