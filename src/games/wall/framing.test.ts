import { describe, expect, it } from 'vitest';
import { BodyBuilder, type Body } from '../../engine/body/bodyModel';
import { NEUTRAL } from '../../engine/body/pose';
import { defaultProfile } from '../../engine/body/profile';
import { SimPoseSource, type SimOptions } from '../../engine/input/simSource';
import { MotionAnalyzer, type Motion } from '../../engine/motion/features';
import { checkDuoFraming, checkFraming, FramingGate } from './framing';
import { COMMON } from './tuning';

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

  it('seeing only the upper body, it asks you to step back so the legs can join in', () => {
    const r = checkFraming(bodyAt({ legs: false }));
    expect(r).toEqual({ issue: 'upper', text: '往后退，让脚也进画面，才能玩全身的姿势', mode: 'upper' });
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

  it('an upper-body view is only advice: stand still a few seconds longer and the round opens as upper-body', () => {
    // 现在大半的姿势要用腿。只看到上半身时多等一会儿，给人退后的机会；坐在桌前退不了的，站着别动照样能玩
    const gate = new FramingGate(1200, 3500);
    const seated = bodyAt({ legs: false });
    const midway = gate.update(seated, still, 0) && gate.update(seated, still, 1300);
    expect(midway).toMatchObject({ ready: false, advisory: true });
    expect(midway.result.issue).toBe('upper');
    expect(gate.update(seated, still, 3499).ready).toBe(false);
    const done = gate.update(seated, still, 3500);
    expect(done.ready).toBe(true);
    expect(done.result.mode).toBe('upper');
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

/** 两个模拟玩家并排站着，返回流水线算出来的两个 Body（0 号在屏幕左边）。 */
function pairAt(opts: SimOptions = {}): [Body, Body] {
  const sim = new SimPoseSource({ noise: 0, people: 2, ...opts });
  const builders = [new BodyBuilder(), new BodyBuilder()];
  let bodies: (Body | null)[] = [null, null];
  for (let i = 0; i < 6; i++) {
    const f = sim.step(33);
    bodies = builders.map((b, k) => b.update(f.poses[k], f.t, f.aspect, profile));
  }
  return [bodies[0]!, bodies[1]!];
}
const both: [typeof profile, typeof profile] = [profile, profile];

describe('checkDuoFraming', () => {
  it('asks both to step in when nobody is there', () => {
    expect(checkDuoFraming(null, null, both)).toEqual({ issue: 'nobody', text: '两位都站到摄像头前面来', mode: null });
  });

  it('says one more is needed when it sees only one of them', () => {
    const [a, b] = pairAt();
    expect(checkDuoFraming(a, null, both)).toMatchObject({ issue: 'one', text: '还差一位，站到旁边来' });
    expect(checkDuoFraming(null, b, both)).toMatchObject({ issue: 'one', text: '还差一位，站到旁边来' });
  });

  it('…unless the one it sees is tiny: then the other is probably there too, just too far away to be found', () => {
    const [a] = pairAt({ cam: { s: 0.25 } });
    expect(checkDuoFraming(a, null, both)).toMatchObject({ issue: 'far', text: '两位都往前走一点' });
  });

  it('is happy with two fully visible players standing apart', () => {
    expect(checkDuoFraming(...pairAt(), both)).toEqual({ issue: 'none', text: '站得很好，别动', mode: 'full' });
  });

  it('needs the head and shoulders of both', () => {
    const [a, b] = pairAt();
    b.ok.shoulderL = false;
    expect(checkDuoFraming(a, b, both)).toMatchObject({ issue: 'partial', text: '让摄像头看到你的头和肩膀' });
  });

  it('asks them to back off when the camera sees too little', () => {
    // 两人隔得够开（1.4 米），只是离镜头太近
    expect(checkDuoFraming(...pairAt({ cam: { s: 1.0 }, legs: false, gap: 1.4 }), both)).toMatchObject({ issue: 'close', text: '往后退一点' });
  });

  it('asks them to come closer when they are small in the picture', () => {
    // 人占画面不到一半高：识别模型找得到一个，找不到第二个
    expect(checkDuoFraming(...pairAt({ cam: { s: 0.28 } }), both)).toMatchObject({ issue: 'far', text: '两位都往前走一点' });
    expect(checkDuoFraming(...pairAt({ cam: { s: 0.33 } }), both).issue).toBe('none');
  });

  it('asks them to spread out when they stand closer than an arm apart', () => {
    expect(checkDuoFraming(...pairAt({ gap: 0.9 }), both)).toMatchObject({ issue: 'gap', text: '两个人分开一点，中间留一臂宽' });
    expect(checkDuoFraming(...pairAt({ gap: 1.25 }), both).issue).toBe('none');
  });

  it('standing too close together is said first, even when they are also too close to the camera', () => {
    // 两个人挤在笔记本前：离镜头太近（只是提醒）和两人挨得太近（硬要求）同时成立。得先说硬的那条——
    // 不然提醒那条等几秒就放行了，一局开出来两个人只隔几十厘米，哪种配对都摆不下
    const [a, b] = pairAt({ cam: { s: 1.0 }, legs: false, gap: 0.7 });
    expect(a.view.top - a.view.bottom).toBeLessThan(COMMON.framing.minViewHeight);
    expect(checkDuoFraming(a, b, both)).toMatchObject({ issue: 'gap', text: '两个人分开一点，中间留一臂宽' });
  });

  it('plays upper-body for both when the legs of either are out of view', () => {
    const [a] = pairAt();
    const [, seated] = pairAt({ legs: false });
    expect(checkDuoFraming(a, seated, both)).toEqual({ issue: 'upper', text: '往后退，让脚也进画面，才能玩全身的姿势', mode: 'upper' });
  });
});

describe('FramingGate for two players', () => {
  const stills: [Motion, Motion] = [still, still];

  it('opens after both have stood well and still for long enough', () => {
    const gate = new FramingGate(1200, 3500);
    const [a, b] = pairAt();
    expect(gate.updateDuo(a, b, stills, both, 0)).toMatchObject({ ready: false, advisory: false });
    expect(gate.updateDuo(a, b, stills, both, 1199).ready).toBe(false);
    expect(gate.updateDuo(a, b, stills, both, 1200).ready).toBe(true);
  });

  it('starts over when either of them moves', () => {
    const gate = new FramingGate(1200, 3500);
    const [a, b] = pairAt();
    gate.updateDuo(a, b, stills, both, 0);
    expect(gate.updateDuo(a, b, [still, moving], both, 900).progress).toBe(0);
    expect(gate.updateDuo(a, b, stills, both, 1000).progress).toBe(0);
    expect(gate.updateDuo(a, b, stills, both, 2200).ready).toBe(true);
  });

  it('too far and too close together are not advice here: it will not open however long they stand', () => {
    for (const opts of [{ cam: { s: 0.28 } }, { gap: 0.9 }]) {
      const gate = new FramingGate(1200, 3500);
      const [a, b] = pairAt(opts);
      gate.updateDuo(a, b, stills, both, 0);
      const later = gate.updateDuo(a, b, stills, both, 20000);
      expect(later, JSON.stringify(opts)).toMatchObject({ ready: false, advisory: false, progress: 0 });
    }
  });

  it('does not open on two players huddled at a laptop, however long they stand', () => {
    const gate = new FramingGate(1200, 3500);
    const [a, b] = pairAt({ cam: { s: 1.0 }, legs: false, gap: 0.7 });
    gate.updateDuo(a, b, stills, both, 0);
    expect(gate.updateDuo(a, b, stills, both, 20000)).toMatchObject({ ready: false, advisory: false });
  });

  it('never opens on one player alone', () => {
    const gate = new FramingGate(1200, 3500);
    const [a] = pairAt();
    gate.updateDuo(a, null, [still, null], both, 0);
    expect(gate.updateDuo(a, null, [still, null], both, 20000).ready).toBe(false);
  });

  it('an upper-body view is still only advice', () => {
    const gate = new FramingGate(1200, 3500);
    const [a, b] = pairAt({ legs: false });
    gate.updateDuo(a, b, stills, both, 0);
    expect(gate.updateDuo(a, b, stills, both, 1300)).toMatchObject({ ready: false, advisory: true });
    const done = gate.updateDuo(a, b, stills, both, 3500);
    expect(done.ready).toBe(true);
    expect(done.result.mode).toBe('upper');
  });
});
