import { describe, expect, it } from 'vitest';
import { NEUTRAL, poseToSkeleton } from '../body/pose';
import { defaultProfile } from '../body/profile';
import { jointsToRawPose, skeletonToJoints33 } from '../input/simSource';
import type { RawFrame, RawPose } from '../input/types';
import { PersonSelector } from './selectPerson';

const profile = defaultProfile();
const ASPECT = 16 / 9;

/** 造一个站在舞台 x 处的人；s 越大表示离镜头越近（在画面里越大）。 */
function person(x: number, s = 0.42): RawPose {
  const { joints, vis } = skeletonToJoints33(poseToSkeleton(NEUTRAL, profile, { x }), profile);
  return jointsToRawPose(joints, vis, { aspect: ASPECT, s, groundV: 0.95 });
}
const frame = (t: number, ...poses: RawPose[]): RawFrame => ({ t, aspect: ASPECT, poses });

describe('PersonSelector', () => {
  it('returns null for an empty frame', () => {
    expect(new PersonSelector().pick(frame(0))).toBeNull();
  });

  it('starts with the person who is biggest and most central', () => {
    const centre = person(0, 0.42);
    const side = person(1.3, 0.3);
    expect(new PersonSelector().pick(frame(0, side, centre))).toBe(centre);
    expect(new PersonSelector().pick(frame(0, centre, side))).toBe(centre);
  });

  it('keeps following the same person when a bystander takes the centre', () => {
    const sel = new PersonSelector();
    let t = 0;
    let player = person(0);
    expect(sel.pick(frame(t, player))).toBe(player);
    // 玩家一步步走到左边
    for (let x = -0.1; x >= -0.55; x -= 0.1) {
      t += 33;
      player = person(x);
      expect(sel.pick(frame(t, player))).toBe(player);
    }
    // 这时一个更大、更居中的旁人走进画面
    for (let i = 0; i < 5; i++) {
      t += 33;
      player = person(-0.6);
      const bystander = person(0, 0.5);
      expect(sel.pick(frame(t, bystander, player))).toBe(player);
    }
  });

  it('does not jump to someone else the moment the player is lost', () => {
    const sel = new PersonSelector();
    sel.pick(frame(0, person(-0.8)));
    const bystander = person(0.8);
    expect(sel.pick(frame(300, bystander))).toBeNull();
  });

  it('re-acquires after the player has been gone for a while', () => {
    const sel = new PersonSelector();
    sel.pick(frame(0, person(-0.8)));
    const bystander = person(0.8);
    expect(sel.pick(frame(300, bystander))).toBeNull();
    expect(sel.pick(frame(600, bystander))).toBe(bystander);
  });

  it('picks the player up again if they come back in time', () => {
    const sel = new PersonSelector();
    sel.pick(frame(0, person(0)));
    expect(sel.pick(frame(200))).toBeNull();
    const back = person(0.05);
    expect(sel.pick(frame(400, back))).toBe(back);
  });

  describe('once locked onto the player (during a round)', () => {
    // 识别模型一次只给一个人。跟丢玩家之后，它下一个给出来的可能是旁边路过的人。
    const start = (): { sel: PersonSelector; t: number } => {
      const sel = new PersonSelector();
      let t = 0;
      for (; t < 300; t += 33) sel.pick(frame(t, person(0)));
      sel.lock();
      return { sel, t };
    };

    it('never hands control to someone standing somewhere else, however long the player is gone', () => {
      const { sel, t } = start();
      const bystander = person(1.6);
      for (let dt = 33; dt < 5000; dt += 33) expect(sel.pick(frame(t + dt, bystander)), `after ${dt} ms`).toBeNull();
    });

    it('takes the player back when they return to their spot', () => {
      const { sel, t } = start();
      for (let dt = 33; dt < 2000; dt += 33) sel.pick(frame(t + dt, person(1.6)));
      const back = person(0.1);
      expect(sel.pick(frame(t + 2033, back))).toBe(back);
    });

    it('accepts the player back anywhere a wall could have sent them', () => {
      // 洞最远开在离原位 0.9 米的地方，人可能正站在那儿
      const { sel, t } = start();
      for (let dt = 33; dt < 1500; dt += 33) sel.pick(frame(t + dt));
      const aside = person(-0.9);
      expect(sel.pick(frame(t + 1533, aside))).toBe(aside);
    });

    it('still follows the player as they walk, step by step', () => {
      const { sel, t } = start();
      let now = t;
      for (let x = 0; x <= 1.6; x += 0.08) {
        const p = person(x);
        expect(sel.pick(frame((now += 33), p))).toBe(p);
      }
    });

    it('unlock goes back to picking whoever is there', () => {
      const { sel, t } = start();
      sel.unlock();
      const other = person(1.6);
      for (let dt = 33; dt < 600; dt += 33) sel.pick(frame(t + dt, other));
      expect(sel.pick(frame(t + 700, other))).toBe(other);
    });

    it('lock before anyone was seen does nothing', () => {
      const sel = new PersonSelector();
      sel.lock();
      const p = person(1.2);
      expect(sel.pick(frame(0, p))).toBe(p);
    });
  });

  it('reset starts over', () => {
    const sel = new PersonSelector();
    sel.pick(frame(0, person(-0.8)));
    sel.reset();
    const other = person(0.8);
    expect(sel.pick(frame(33, other))).toBe(other);
  });

  it('ignores people whose torso is not visible', () => {
    const ghost = person(0);
    for (const l of ghost.image) l.v = 0.1;
    const real = person(1.0, 0.3);
    expect(new PersonSelector().pick(frame(0, ghost, real))).toBe(real);
  });
});
