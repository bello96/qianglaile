import { describe, expect, it } from 'vitest';
import type { Body } from '../../engine/body/bodyModel';
import { DEFAULT_ARM, DEFAULT_LEG, JOINTS, mirrorPose, poseToSkeleton, targetLimbs } from '../../engine/body/pose';
import { ANKLE_H, defaultProfile } from '../../engine/body/profile';
import { allJointsOk } from './bodyShape';
import { isUpperOk } from './customPoses';
import { judgePose } from './judge';
import { DUO_POSE_IDS, duoPose, getPose, POSES, STAND } from './poses';

const profile = defaultProfile();

describe('pose library', () => {
  it('has 48 poses with unique ids and names', () => {
    expect(POSES).toHaveLength(48);
    expect(new Set(POSES.map((p) => p.id)).size).toBe(48);
    expect(new Set(POSES.map((p) => p.name)).size).toBe(48);
    for (const p of POSES) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('uses none of the names we must stay away from', () => {
    expect(JSON.stringify(POSES)).not.toMatch(/墙来了|动动乐园/);
  });

  it('tier 1 is symmetric, arms only, and doable sitting down', () => {
    const tier1 = POSES.filter((p) => p.tier === 1);
    expect(tier1.length).toBeGreaterThanOrEqual(6);
    for (const p of tier1) {
      expect(p.upperOk, p.id).toBe(true);
      expect(p.armL, p.id).toEqual(p.armR);
      expect(p.legL, p.id).toEqual(DEFAULT_LEG);
      expect(p.legR, p.id).toEqual(DEFAULT_LEG);
      expect(p.spine, p.id).toBeUndefined();
    }
  });

  it('offers at least ten poses for upper-body play, and every tier is populated', () => {
    expect(POSES.filter((p) => p.upperOk).length).toBeGreaterThanOrEqual(10);
    for (const tier of [1, 2, 3, 4]) expect(POSES.some((p) => p.tier === tier), `tier ${tier}`).toBe(true);
  });

  it('upper-body poses leave the legs alone', () => {
    for (const p of POSES.filter((q) => q.upperOk)) {
      expect(p.legL, p.id).toEqual(DEFAULT_LEG);
      expect(p.legR, p.id).toEqual(DEFAULT_LEG);
    }
  });

  it('every pose stands on the ground and stays inside the wall', () => {
    for (const p of POSES) {
      const sk = poseToSkeleton(p, profile);
      expect(Math.min(sk.ankleL.y, sk.ankleR.y), p.id).toBeCloseTo(ANKLE_H);
      for (const j of JOINTS) {
        expect(sk[j].x, `${p.id} ${j}.x`).toBeGreaterThan(-1.4);
        expect(sk[j].x, `${p.id} ${j}.x`).toBeLessThan(1.4);
        expect(sk[j].y, `${p.id} ${j}.y`).toBeGreaterThanOrEqual(0);
        expect(sk[j].y, `${p.id} ${j}.y`).toBeLessThan(2.25);
      }
    }
  });

  it('every pose has a spoken hint', () => {
    for (const p of POSES) expect(p.say?.length ?? 0, p.id).toBeGreaterThan(1);
  });

  it('looks poses up by id', () => {
    expect(getPose('t')?.name).toBe('一字平举');
    expect(getPose('nope')).toBeUndefined();
    expect(STAND.id).toBe('stand');
    expect(POSES.find((p) => p.id === 'stand')).toBeUndefined();
  });

  /** 这一版新加的 24 个：名字和墙出现时念的那句话都是设计里定下来的，逐字对。 */
  const ADDED: [string, string, string][] = [
    ['salute', '敬礼', '右手敬礼'],
    ['x-jump', '开合跳', '手脚都张开，像开合跳'],
    ['a-frame', '人字', '双脚分开，站成人字'],
    ['seesaw', '跷跷板', '双手平举，身体歪向一边'],
    ['moon', '弯月', '双手举过头，往旁边弯'],
    ['horse', '扎马步', '扎马步，双手叉腰'],
    ['sumo', '相扑', '蹲低一点，双手扶膝盖'],
    ['warrior', '战士', '侧弓步，双手平举'],
    ['archer-lunge', '弓步射箭', '弓步站稳，拉弓射箭'],
    ['lunge-reach', '弓步摘星', '弓步，一只手伸上去摘星星'],
    ['frog', '青蛙蹲', '蹲到底，膝盖朝外'],
    ['squat-up', '蹲下举手', '蹲下去，双手举高'],
    ['bow', '深鞠躬', '深深鞠一躬'],
    ['airplane', '小飞机', '弯下腰，张开双手当翅膀'],
    ['white-crane', '白鹤亮翅', '抬起一条腿，一手指天一手指地'],
    ['flamingo', '火烈鸟', '一只脚向后勾起来，双手叉腰'],
    ['one-leg-star', '单脚大字', '单脚站稳，另一条腿往旁边抬'],
    ['horse-disco', '马步指天', '扎马步，一手指天一手指地'],
    ['horse-salute', '马步敬礼', '扎着马步敬个礼'],
    ['lunge-moon', '弓步弯月', '弓步，双手举过头往旁边弯'],
    ['squat-flex', '蹲下秀肌肉', '蹲下去，秀出你的肌肉'],
    ['crane-salute', '独立敬礼', '金鸡独立，再敬个礼'],
    ['tree-t', '独木桥', '单脚站，双手平举'],
    ['kick-up', '踢腿举手', '一条腿往旁边踢，双手举高'],
  ];

  it('adds the 24 full-body poses with the agreed names and spoken hints', () => {
    for (const [id, name, say] of ADDED) {
      expect(getPose(id)?.name, id).toBe(name);
      expect(getPose(id)?.say, id).toBe(say);
    }
  });

  it('uses the lower body in more than half of the poses', () => {
    expect(POSES.filter((p) => !p.upperOk).length).toBeGreaterThan(24);
  });

  it('never mirrors a salute: it is always the right hand', () => {
    expect(POSES.filter((p) => p.noMirror).map((p) => p.id).sort()).toEqual(['crane-salute', 'horse-salute', 'salute']);
    for (const id of ['salute', 'horse-salute', 'crane-salute']) expect(getPose(id)!.armR, id).toEqual([{ a: 100 }, { a: -122 }]);
  });

  it('makes the star look like a 大 and gives the horse-stance T a real horse stance', () => {
    expect(getPose('star')!.armL[0].a).toBe(100);
    expect(targetLimbs(getPose('wide-t')!).thighL).toEqual({ angle: 62, scale: 0.8 });
    expect(getPose('wide-t')!.say).toBe('扎马步，双手平举');
    expect(getPose('wide-t')!.tier).toBe(3);
  });

  it('every pose passes its own wall with full marks', () => {
    for (const p of POSES) {
      const sk = poseToSkeleton(p, profile);
      const body: Body = { t: 0, skeleton: sk, ok: allJointsOk(), root: { ...sk.hipC }, mode: 'full', view: { left: -2, right: 2, bottom: -0.1, top: 2.3 }, scale: 0.42, image: [] };
      const j = judgePose(p, 0, body, profile, { angle: 25, pos: 0.22 });
      expect(j.matched, p.id).toBe(true);
      expect(j.accuracy, p.id).toBeGreaterThan(0.9);
    }
  });

  it('mirroring twice gives the pose back', () => {
    for (const p of POSES) expect(mirrorPose(mirrorPose(p)), p.id).toEqual(p);
  });

  it('marks a pose as doable from the waist up exactly when its legs and spine say so', () => {
    for (const p of POSES) expect(p.upperOk, p.id).toBe(isUpperOk(p));
  });
});

describe('two-player poses', () => {
  it('are not part of the solo library', () => {
    expect(DUO_POSE_IDS).toEqual(['hold-hands', 'bridge']);
    for (const id of DUO_POSE_IDS) expect(getPose(id), id).toBeUndefined();
  });

  it('holding hands: the player on the left reaches with the right arm, the other arm hangs', () => {
    const left = duoPose('hold-hands', -1, 50);
    expect(left).toMatchObject({ id: 'hold-hands', name: '手拉手', say: '两个人手拉手', upperOk: true, noMirror: true });
    expect(left.armR).toEqual([{ a: 50 }, { a: 50 }]);
    expect(left.armL).toEqual(DEFAULT_ARM);
    const right = duoPose('hold-hands', 1, 50);
    expect(right.id).toBe('hold-hands~m');
    expect(right.armL).toEqual([{ a: 50 }, { a: 50 }]);
    expect(right.armR).toEqual(DEFAULT_ARM);
  });

  it('bridge: the inner arm goes up, the outer hand rests on the hip', () => {
    const right = duoPose('bridge', 1, 140);
    expect(right).toMatchObject({ id: 'bridge~m', name: '搭桥', say: '两个人把手举高，搭一座桥' });
    expect(right.armL).toEqual([{ a: 140 }, { a: 140 }]);
    expect(right.armR).toEqual([{ a: 40 }, { a: -40 }]);
    expect(duoPose('bridge', -1, 140).armL).toEqual([{ a: 40 }, { a: -40 }]);
  });
});
