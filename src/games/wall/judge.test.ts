import { describe, expect, it } from 'vitest';
import { BodyBuilder, type Body } from '../../engine/body/bodyModel';
import { poseToSkeleton, type JointName, type PoseSpec, type Skeleton } from '../../engine/body/pose';
import { defaultProfile, scaleProfile, type BodyProfile } from '../../engine/body/profile';
import { SimPoseSource } from '../../engine/input/simSource';
import { allJointsOk, skeletonCapsules } from './bodyShape';
import { buildField } from './field';
import { judgePose, judgeShape, reasonText, resolveOutcome, type PoseJudge, type ShapeJudge } from './judge';
import { getPose, STAND } from './poses';
import { getShape, SHAPES } from './shapes';
import { COMMON, TUNING } from './tuning';

const profile = defaultProfile();
const NORMAL = { angle: 32, pos: 0.26 };
const SHAPE_TOL = { slack: 0.05, hitFrac: 0.2 };
const P = (id: string): PoseSpec => getPose(id)!;

/** 直接用骨架拼一个 Body（不经过摄像头流水线），判定只看这些字段。 */
function bodyFrom(sk: Skeleton, opts: { mode?: 'full' | 'upper'; ok?: Partial<Record<JointName, boolean>> } = {}): Body {
  return {
    t: 0,
    skeleton: sk,
    ok: { ...allJointsOk(), ...opts.ok },
    root: { ...sk.hipC },
    mode: opts.mode ?? 'full',
    view: { left: -2, right: 2, bottom: -0.1, top: 2.3 },
    scale: 0.42,
    image: [],
  };
}
const holding = (spec: PoseSpec, x = 0, p: BodyProfile = profile): Body => bodyFrom(poseToSkeleton(spec, p, { x }));

/** 把两条手臂的四段都偏转 delta 度。 */
const armsOff = (spec: PoseSpec, delta: number): PoseSpec => ({
  ...spec,
  armL: [{ ...spec.armL[0], a: spec.armL[0].a + delta }, { ...spec.armL[1], a: spec.armL[1].a + delta }],
  armR: [{ ...spec.armR[0], a: spec.armR[0].a + delta }, { ...spec.armR[1], a: spec.armR[1].a + delta }],
});

const starsFor = (j: PoseJudge | ShapeJudge) => {
  const o = resolveOutcome([j]);
  return o.kind === 'pass' ? o.stars : 0;
};

describe('judgePose', () => {
  it('a perfect pose matches with full accuracy', () => {
    for (const id of ['t', 'y', 'hips', 'star', 'side-bend', 'squat', 'low', 'crane', 'tree']) {
      const j = judgePose(P(id), 0, holding(P(id)), profile, NORMAL);
      expect(j.matched, id).toBe(true);
      expect(j.accuracy, id).toBeGreaterThan(0.95);
      expect(j.bad, id).toEqual([]);
      expect(starsFor(j), id).toBe(3);
    }
  });

  it('grades by how far off the limbs are, up to the tolerance', () => {
    const grade = (delta: number) => judgePose(P('t'), 0, holding(armsOff(P('t'), delta)), profile, NORMAL);
    expect(starsFor(grade(12))).toBe(3);
    expect(starsFor(grade(22))).toBe(2);
    expect(starsFor(grade(30))).toBe(1);
    const miss = grade(36);
    expect(miss.matched).toBe(false);
    expect(starsFor(miss)).toBe(0);
    expect(miss.bad).toEqual(expect.arrayContaining(['upperArmL', 'upperArmR', 'forearmL', 'forearmR']));
    expect(miss.errors.upperArmL).toBeCloseTo(36, 0);
  });

  it('one limb far off drags the grade down even when the rest are perfect', () => {
    const oneOff: PoseSpec = { ...P('t'), armR: [{ a: 90 + 30 }, { a: 90 }] };
    const j = judgePose(P('t'), 0, holding(oneOff), profile, NORMAL);
    expect(j.matched).toBe(true);
    expect(starsFor(j)).toBe(2);
  });

  it('uses the tolerance it is given', () => {
    const body = holding(armsOff(P('t'), 30));
    expect(judgePose(P('t'), 0, body, profile, { angle: 40, pos: 0.3 }).matched).toBe(true);
    expect(judgePose(P('t'), 0, body, profile, { angle: 25, pos: 0.22 }).matched).toBe(false);
  });

  it('on a wall that only moves the arms, legs and spine get the full tolerance', () => {
    // 只动手的墙，人随便站着就行。脚分开一点、身子歪一点，不该被判成"腿没摆对"
    const wideStance: PoseSpec = { ...P('t'), legL: [{ a: 24 }, { a: 24 }], legR: [{ a: 24 }, { a: 24 }] };
    expect(judgePose(P('t'), 0, holding(wideStance), profile, NORMAL).matched).toBe(true);
    const leaning: PoseSpec = { ...P('t'), spine: { a: 20 } };
    expect(judgePose(P('t'), 0, holding(leaning), profile, NORMAL).matched).toBe(true);
    // 太离谱还是不行
    const splits: PoseSpec = { ...P('t'), legL: [{ a: 45 }, { a: 45 }], legR: [{ a: 45 }, { a: 45 }] };
    const j = judgePose(P('t'), 0, holding(splits), profile, NORMAL);
    expect(j.matched).toBe(false);
    expect(reasonText(j)).toBe('双腿没摆对');
  });

  it('on a wall that does pose the legs or the spine, those are held to half the tolerance', () => {
    // "双脚分开 22°"和"站直"只差十几度：要是也给足 32°，腿怎么放都算对，这面墙就白出了
    const starStanding: PoseSpec = { ...P('star'), legL: STAND.legL, legR: STAND.legR };
    expect(judgePose(P('star'), 0, holding(starStanding), profile, NORMAL).matched).toBe(false);
    const bendUpright: PoseSpec = { ...P('side-bend'), spine: undefined };
    const j = judgePose(P('side-bend'), 0, holding(bendUpright), profile, NORMAL);
    expect(j.matched).toBe(false);
    expect(reasonText(j)).toBe('身体没摆正');
    // 摆对了当然过
    expect(judgePose(P('star'), 0, holding(P('star')), profile, NORMAL).matched).toBe(true);
    expect(judgePose(P('side-bend'), 0, holding(P('side-bend')), profile, NORMAL).matched).toBe(true);
  });

  it('tightens only the limbs the pose uses: the standing leg of a one-legged pose keeps the full tolerance', () => {
    const crane = P('crane');
    // 哪条腿是站着的：两段都没有缩短的那条
    const standingIsLeft = crane.legL.every((l) => (l.s ?? 1) >= 0.9);
    const loose: [{ a: number }, { a: number }] = [{ a: 24 }, { a: 24 }];
    const sloppy: PoseSpec = standingIsLeft ? { ...crane, legL: loose } : { ...crane, legR: loose };
    expect(judgePose(crane, 0, holding(sloppy), profile, NORMAL).bad).toEqual([]);
  });

  it('rejects the wrong pose in both directions', () => {
    expect(judgePose(P('t'), 0, holding(STAND), profile, NORMAL).matched).toBe(false);
    expect(judgePose(STAND, 0, holding(P('t')), profile, NORMAL).matched).toBe(false);
    expect(judgePose(P('disco'), 0, holding(P('signal')), profile, NORMAL).matched).toBe(false);
  });

  it('wants the player to stand where the hole is', () => {
    const right = judgePose(P('t'), 0, holding(P('t'), 0.4), profile, NORMAL);
    expect(right.posOk).toBe(false);
    expect(right.matched).toBe(false);
    expect(right.dx).toBeCloseTo(0.4);
    expect(right.bad).toEqual([]);
    expect(reasonText(right)).toBe('往左站一点');
    expect(reasonText(judgePose(P('t'), 0, holding(P('t'), -0.4), profile, NORMAL))).toBe('往右站一点');
    expect(judgePose(P('t'), 0.4, holding(P('t'), 0.4), profile, NORMAL).matched).toBe(true);
    expect(judgePose(P('t'), 0, holding(P('t'), 0.2), profile, NORMAL).matched).toBe(true);
  });

  it('ignores the legs in upper-body mode', () => {
    const armsOfStar = bodyFrom(poseToSkeleton({ ...STAND, armL: P('star').armL, armR: P('star').armR }, profile), { mode: 'upper' });
    expect(judgePose(P('star'), 0, armsOfStar, profile, NORMAL).matched).toBe(true);
    const full = bodyFrom(armsOfStar.skeleton, { mode: 'full' });
    expect(judgePose(P('star'), 0, full, profile, NORMAL).matched).toBe(false);
  });

  it('checks foreshortened limbs by how short they look, not by their angle', () => {
    const low = judgePose(P('low'), 0, holding(STAND), profile, NORMAL);
    expect(low.matched).toBe(false);
    expect(low.bad).toEqual(expect.arrayContaining(['thighL', 'thighR']));
    expect(judgePose(P('low'), 0, holding(P('low')), profile, NORMAL).matched).toBe(true);
    expect(judgePose(P('squat'), 0, holding(STAND), profile, NORMAL).matched).toBe(false);
    expect(judgePose(P('crane'), 0, holding(P('t')), profile, NORMAL).matched).toBe(false);
  });

  it('does not accept arms pointed at the camera for arms spread sideways', () => {
    const forward: PoseSpec = { ...P('t'), armL: [{ a: 90, s: 0.2 }, { a: 90, s: 0.2 }], armR: [{ a: 90, s: 0.2 }, { a: 90, s: 0.2 }] };
    const j = judgePose(P('t'), 0, holding(forward), profile, NORMAL);
    expect(j.matched).toBe(false);
    expect(j.bad).toEqual(expect.arrayContaining(['upperArmL', 'upperArmR']));
  });

  it('skips limbs it cannot see, but needs at least two to judge', () => {
    const wrongRightArm: PoseSpec = { ...P('t'), armR: STAND.armR };
    const sk = poseToSkeleton(wrongRightArm, profile);
    expect(judgePose(P('t'), 0, bodyFrom(sk), profile, NORMAL).matched).toBe(false);
    const hidden = judgePose(P('t'), 0, bodyFrom(sk, { ok: { elbowR: false, wristR: false } }), profile, NORMAL);
    expect(hidden.matched).toBe(true);
    expect(hidden.errors.upperArmR).toBeUndefined();

    const nothing = Object.fromEntries(Object.keys(allJointsOk()).map((k) => [k, false]));
    const blind = judgePose(P('t'), 0, bodyFrom(poseToSkeleton(P('t'), profile), { ok: nothing }), profile, NORMAL);
    expect(blind.matched).toBe(false);
    expect(blind.accuracy).toBe(0);
  });

  it('works on bodies that came through the real pipeline, noise and all', () => {
    for (const id of ['t', 'disco', 'star']) {
      const sim = new SimPoseSource({ seed: 11, noise: 0.008 });
      const builder = new BodyBuilder();
      sim.setPose(P(id), {}, 0);
      let body: Body | null = null;
      for (let i = 0; i < 12; i++) {
        const f = sim.step(33);
        body = builder.update(f.poses[0], f.t, f.aspect, profile);
      }
      const j = judgePose(P(id), 0, body!, profile, NORMAL);
      expect(j.matched, id).toBe(true);
      expect(starsFor(j), id).toBe(3);
    }
  });
});

describe('judgeShape', () => {
  const wall = (id: string, x = 0, p: BodyProfile = profile) => buildField(getShape(id)!.build(p, { x }));
  const caps = (spec: PoseSpec, x = 0, p: BodyProfile = profile) => skeletonCapsules(poseToSkeleton(spec, p, { x }), p);

  it('every shape lets its own demo pose through, for adult and child proportions', () => {
    for (const p of [profile, scaleProfile(profile, 0.72)]) {
      for (const s of SHAPES) {
        const x = s.offset ?? 0;
        const j = judgeShape(wall(s.id, x, p), caps(s.demo, x, p), SHAPE_TOL);
        expect(j.hit, `${s.id} bad=${j.bad} worst=${j.worst}`).toBe(false);
      }
    }
  });

  it('every shape leaves its own demo pose real room, so the slack is there for the player and not used up already', () => {
    // 示范姿势自己就蹭着墙的话，"泡沫弹性"那几厘米就被它吃掉了：真人稍微一晃就判撞（挑战档只有 4 厘米）
    for (const p of [profile, scaleProfile(profile, 0.72)]) {
      for (const s of SHAPES) {
        const x = s.offset ?? 0;
        const j = judgeShape(wall(s.id, x, p), caps(s.demo, x, p), SHAPE_TOL);
        expect(j.worst, `${s.id}: deepest point is ${(j.worst * 100).toFixed(1)} cm into the wall`).toBeLessThanOrEqual(0.01);
      }
    }
  });

  it('with camera-like jitter, no shape rejects its own demo pose even at the strictest setting', () => {
    const strict = { slack: TUNING.hard.shapeSlack, hitFrac: COMMON.hitFrac };
    for (const s of SHAPES) {
      const field = wall(s.id);
      let hits = 0;
      for (const seed of [1, 2, 3]) {
        const sim = new SimPoseSource({ noise: 0.008, seed });
        const builder = new BodyBuilder();
        sim.setPose(s.demo, { x: 0 }, 0);
        for (let i = 0; i < 300; i++) {
          const f = sim.step(33);
          const body = builder.update(f.poses[0], f.t, f.aspect, profile);
          if (body && i >= 30 && judgeShape(field, skeletonCapsules(body.skeleton, profile, body.ok), strict).hit) hits++;
        }
      }
      expect(hits, s.id).toBe(0);
    }
  });

  it('the low door stops anyone standing up', () => {
    const j = judgeShape(wall('low-door'), caps(STAND), SHAPE_TOL);
    expect(j.hit).toBe(true);
    expect(j.bad).toContain('head');
    expect(j.clean).toBe(false);
    expect(reasonText(j)).toBe('头撞到了');
  });

  it('the round hole needs a tuck', () => {
    expect(judgeShape(wall('round'), caps(STAND), SHAPE_TOL).hit).toBe(true);
    expect(judgeShape(wall('round'), caps(P('low')), SHAPE_TOL).hit).toBe(false);
  });

  it('the slot and the keyhole catch arms that stick out', () => {
    const t = judgeShape(wall('slot'), caps(P('t')), SHAPE_TOL);
    expect(t.hit).toBe(true);
    expect(t.bad).toEqual(expect.arrayContaining(['forearmL', 'forearmR', 'handL', 'handR']));
    expect(t.bad).not.toContain('torso');
    const hanging = judgeShape(wall('keyhole'), caps(STAND), SHAPE_TOL);
    expect(hanging.hit).toBe(true);
    expect(hanging.bad).not.toContain('head');
  });

  it('the side door needs a step to the side', () => {
    expect(judgeShape(wall('side-door', 0.55), caps(STAND, 0), SHAPE_TOL).hit).toBe(true);
    expect(judgeShape(wall('side-door', 0.55), caps(STAND, 0.55), SHAPE_TOL).hit).toBe(false);
    expect(judgeShape(wall('side-door', -0.55), caps(STAND, -0.55), SHAPE_TOL).hit).toBe(false);
  });

  it('forgives a graze but not a real collision', () => {
    const slot = wall('slot');
    const edge = profile.shoulderW / 2 + 0.14; // 窄缝的半宽
    const probe = (overlap: number) => judgeShape(slot, [{ id: 'handR', ax: edge - 0.05 + overlap, ay: 1, bx: edge - 0.05 + overlap, by: 1, r: 0.05, ok: true }], SHAPE_TOL);
    expect(probe(-0.02).clean).toBe(true); // 离洞边还有 2 厘米
    const graze = probe(0.03);
    expect(graze.hit).toBe(false);
    expect(graze.clean).toBe(false);
    expect(graze.worst).toBeCloseTo(0.03, 1);
    expect(probe(0.09).hit).toBe(true);
  });

  it('ignores parts it cannot see', () => {
    const parts = caps(P('t')).map((c) => ({ ...c, ok: !/arm|hand/i.test(c.id) }));
    expect(judgeShape(wall('slot'), parts, SHAPE_TOL).hit).toBe(false);
  });

  it('lists the worst-hit part first', () => {
    const j = judgeShape(wall('slot'), caps(P('t')), SHAPE_TOL);
    expect(['handL', 'handR']).toContain(j.bad[0]);
    expect(['左手撞到了', '右手撞到了']).toContain(reasonText(j));
  });
});

describe('resolveOutcome', () => {
  const pose = (matched: boolean, accuracy = 0.9): PoseJudge => ({ kind: 'pose', matched, accuracy, errors: {}, bad: matched ? [] : ['forearmL'], posOk: true, dx: 0 });
  const shape = (hit: boolean, clean = !hit): ShapeJudge => ({ kind: 'shape', hit, clean, worst: hit ? 0.2 : 0, bad: hit ? ['head'] : [] });

  it('nobody seen counts as a hit', () => {
    expect(resolveOutcome([])).toEqual({ kind: 'hit', reason: '没看到你', badParts: [] });
  });

  it('a pose passes on a majority of samples', () => {
    const four = [pose(true), pose(false), pose(true), pose(false), pose(true), pose(false), pose(true)];
    expect(resolveOutcome(four).kind).toBe('pass');
    const three = [pose(true), pose(false), pose(true), pose(false), pose(false), pose(false), pose(true)];
    const out = resolveOutcome(three);
    expect(out).toEqual({ kind: 'hit', reason: '左手没摆对', badParts: ['forearmL', 'handL'] });
    expect(resolveOutcome([pose(true), pose(false)]).kind).toBe('hit'); // 平局不算过
  });

  it('pose stars come from the median accuracy of the matching samples', () => {
    const out = resolveOutcome([pose(true, 0.95), pose(true, 0.7), pose(true, 0.65), pose(false, 0.1)]);
    expect(out).toEqual({ kind: 'pass', stars: 2, accuracy: 0.7 });
    expect(resolveOutcome([pose(true, 0.55)])).toMatchObject({ kind: 'pass', stars: 1 });
    expect(resolveOutcome([pose(true, 0.85)])).toMatchObject({ kind: 'pass', stars: 3 });
  });

  it('a shape passes on a majority of clear samples; three stars only if mostly clean', () => {
    expect(resolveOutcome([shape(false), shape(false), shape(true)])).toMatchObject({ kind: 'pass', stars: 3 });
    expect(resolveOutcome([shape(false, false), shape(false, false), shape(false, true)])).toMatchObject({ kind: 'pass', stars: 2 });
    expect(resolveOutcome([shape(true), shape(true), shape(false)])).toEqual({ kind: 'hit', reason: '头撞到了', badParts: ['head'] });
  });
});

describe('reasonText', () => {
  const pose = (bad: PoseJudge['bad'], errors: PoseJudge['errors'] = {}): PoseJudge => ({ kind: 'pose', matched: false, accuracy: 0, errors, bad, posOk: true, dx: 0 });
  it('names the limb that is furthest off', () => {
    expect(reasonText(pose(['upperArmR']))).toBe('右手没摆对');
    expect(reasonText(pose(['shinL']))).toBe('左腿没摆对');
    expect(reasonText(pose(['spine']))).toBe('身体没摆正');
    expect(reasonText(pose(['forearmL', 'thighR'], { forearmL: 40, thighR: 70 }))).toBe('右腿没摆对');
    expect(reasonText(pose([]))).toBe('姿势不对');
  });
  it('says "both" when the same kind of limb is wrong on both sides', () => {
    expect(reasonText(pose(['upperArmL', 'forearmR'], { upperArmL: 80, forearmR: 70 }))).toBe('双手没摆对');
    expect(reasonText(pose(['thighL', 'shinR'], { thighL: 30, shinR: 25 }))).toBe('双腿没摆对');
    // 最差的是腿，手只有一边不对：还是说腿
    expect(reasonText(pose(['thighL', 'thighR', 'forearmL'], { thighL: 60, thighR: 50, forearmL: 40 }))).toBe('双腿没摆对');
    // 最差的是脊柱
    expect(reasonText(pose(['spine', 'upperArmL', 'upperArmR'], { spine: 90, upperArmL: 40, upperArmR: 40 }))).toBe('身体没摆正');
    expect(reasonText(null)).toBe('没看到你');
  });
});
