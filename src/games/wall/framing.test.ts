import { describe, expect, it } from 'vitest';
import { BodyBuilder, type Body } from '../../engine/body/bodyModel';
import { NEUTRAL } from '../../engine/body/pose';
import { defaultProfile } from '../../engine/body/profile';
import { SimPoseSource, type SimOptions } from '../../engine/input/simSource';
import { MotionAnalyzer, type Motion } from '../../engine/motion/features';
import { checkFraming, FramingGate } from './framing';

const profile = defaultProfile();

/** 模拟玩家站在 x 处，返回流水线算出来的 Body。 */
function bodyAt(opts: SimOptions = {}, x = 0): Body {
  const sim = new SimPoseSource({ noise: 0, ...opts });
  const builder = new BodyBuilder();
  sim.setPose(NEUTRAL, { x }, 0);
  let body: Body | null = null;
  for (let i = 0; i < 6; i++) {
    const f = sim.step(33);
    body = builder.update(f.poses[0], f.t, f.aspect, profile);
  }
  return body!;
}
const still: Motion = { ...MotionAnalyzer.idle(), energy: 0.02 };
const moving: Motion = { ...MotionAnalyzer.idle(), energy: 0.5 };

describe('checkFraming', () => {
  it('asks you to step in when nobody is there', () => {
    expect(checkFraming(null)).toEqual({ issue: 'nobody', text: '站到摄像头前面来', mode: null });
  });

  it('is happy with a centred, fully visible player', () => {
    const r = checkFraming(bodyAt());
    expect(r.issue).toBe('none');
    expect(r.mode).toBe('full');
    expect(r.text).toContain('别动');
  });

  it('accepts an upper-body view and says so', () => {
    const r = checkFraming(bodyAt({ legs: false }));
    expect(r.issue).toBe('none');
    expect(r.mode).toBe('upper');
    expect(r.text).toContain('半身');
  });

  it('needs to see the head and both shoulders', () => {
    const body = bodyAt();
    expect(checkFraming({ ...body, ok: { ...body.ok, head: false } }).issue).toBe('partial');
    expect(checkFraming({ ...body, ok: { ...body.ok, shoulderL: false } }).issue).toBe('partial');
  });

  it('tells you to back off or come closer by how much the camera can see', () => {
    const close = checkFraming(bodyAt({ cam: { s: 1.2 } })); // 画面只装得下 0.83 米高
    expect(close).toMatchObject({ issue: 'close', text: '往后退一点' });
    const far = checkFraming(bodyAt({ cam: { s: 0.15 } })); // 画面装得下 6 米多：人太小了
    expect(far).toMatchObject({ issue: 'far', text: '往前走一点' });
  });

  it('tells you which way to shuffle when you are off to one side', () => {
    expect(checkFraming(bodyAt({}, 1.0))).toMatchObject({ issue: 'right', text: '往左站一点' });
    expect(checkFraming(bodyAt({}, -1.0))).toMatchObject({ issue: 'left', text: '往右站一点' });
    expect(checkFraming(bodyAt({}, 0.3)).issue).toBe('none');
  });
});

describe('FramingGate', () => {
  it('opens after the player has stood well and still for long enough', () => {
    const gate = new FramingGate(1200);
    const body = bodyAt();
    expect(gate.update(body, still, 0)).toMatchObject({ ready: false, progress: 0 });
    expect(gate.update(body, still, 600).progress).toBeCloseTo(0.5);
    expect(gate.update(body, still, 1199).ready).toBe(false);
    const done = gate.update(body, still, 1200);
    expect(done.ready).toBe(true);
    expect(done.progress).toBe(1);
    expect(done.result.mode).toBe('full');
  });

  it('starts over if the player fidgets', () => {
    const gate = new FramingGate(1200);
    const body = bodyAt();
    gate.update(body, still, 0);
    gate.update(body, still, 800);
    expect(gate.update(body, moving, 900).progress).toBe(0);
    expect(gate.update(body, still, 1000).progress).toBe(0);
    expect(gate.update(body, still, 2100).ready).toBe(false);
    expect(gate.update(body, still, 2200).ready).toBe(true);
  });

  it('starts over if the framing goes bad', () => {
    const gate = new FramingGate(1200);
    const body = bodyAt();
    gate.update(body, still, 0);
    gate.update(body, still, 900);
    const lost = gate.update(null, null, 1000);
    expect(lost).toMatchObject({ ready: false, progress: 0 });
    expect(lost.result.issue).toBe('nobody');
  });

  it('advises but does not insist: an imperfect view still opens, after a longer wait', () => {
    // 屋子小退不了那么远，或者就是坐在桌前：提醒过了，人还是站着不动，那就按现在看得到的范围开局
    const gate = new FramingGate(1200, 3500);
    const close = bodyAt({ cam: { s: 1.2 }, legs: false });
    expect(gate.update(close, still, 0)).toMatchObject({ ready: false, progress: 0, advisory: true });
    const midway = gate.update(close, still, 1300);
    expect(midway.ready).toBe(false); // 平常的 1.2 秒不够
    expect(midway.result).toMatchObject({ issue: 'close', text: '往后退一点' });
    expect(midway.progress).toBeCloseTo(1300 / 3500);
    expect(gate.update(close, still, 3499).ready).toBe(false);
    const done = gate.update(close, still, 3500);
    expect(done.ready).toBe(true);
    expect(done.result.mode).toBe('upper');
  });

  it('does the same for a player standing off to one side or too far away', () => {
    for (const body of [bodyAt({}, 1.0), bodyAt({ cam: { s: 0.15 } })]) {
      const gate = new FramingGate(1200, 3500);
      gate.update(body, still, 0);
      expect(gate.update(body, still, 2000).ready).toBe(false);
      expect(gate.update(body, still, 3500).ready).toBe(true);
    }
  });

  it('a good view is not marked as advice', () => {
    expect(new FramingGate().update(bodyAt(), still, 0).advisory).toBe(false);
  });

  it('never opens while it cannot see the head and shoulders, or anyone at all', () => {
    const body = bodyAt();
    const noHead = { ...body, ok: { ...body.ok, head: false } };
    const gate = new FramingGate(1200, 3500);
    gate.update(noHead, still, 0);
    expect(gate.update(noHead, still, 60000)).toMatchObject({ ready: false, progress: 0, advisory: false });
    gate.update(null, null, 60100);
    expect(gate.update(null, null, 120000).ready).toBe(false);
  });

  it('fixing the view part-way through keeps the time already waited', () => {
    const gate = new FramingGate(1200, 3500);
    gate.update(bodyAt({}, 1.0), still, 0);
    gate.update(bodyAt({}, 1.0), still, 1000);
    expect(gate.update(bodyAt(), still, 1300).ready).toBe(true);
  });

  it('reset clears the timer', () => {
    const gate = new FramingGate(1200);
    const body = bodyAt();
    gate.update(body, still, 0);
    gate.update(body, still, 1000);
    gate.reset();
    expect(gate.update(body, still, 1100).progress).toBe(0);
  });
});
