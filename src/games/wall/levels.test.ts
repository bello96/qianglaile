import { describe, expect, it } from 'vitest';
import type { ViewWindow } from '../../engine/body/bodyModel';
import { JOINTS, poseToSkeleton, type PoseSpec } from '../../engine/body/pose';
import { defaultProfile, scaleProfile, type BodyProfile } from '../../engine/body/profile';
import { skeletonCapsules } from './bodyShape';
import { bodyGap, duoArmAngle } from './duo';
import { CUSTOM_FROM_LEVEL, LEVELS, levelPlan, WallSequence, type SpawnCtx, type WallSpec } from './levels';
import { getPose, POSES } from './poses';
import { SHAPES } from './shapes';
import { COMMON, TUNING } from './tuning';

const profile = defaultProfile();
const WIDE_VIEW: ViewWindow = { left: -2.1, right: 2.1, bottom: -0.12, top: 2.26 };
const ctx = (over: Partial<SpawnCtx> = {}): SpawnCtx => ({ mode: 'full', view: WIDE_VIEW, profile, playerX: 0, ...over });
const take = (seq: WallSequence, n: number, c: SpawnCtx = ctx()): WallSpec[] => Array.from({ length: n }, () => seq.next(c));
const idOf = (w: WallSpec): string => (w.pose ?? w.shape)!.id;
const baseId = (w: WallSpec): string => idOf(w).replace(/~m$/, '');
const upperOk = (w: WallSpec): boolean => (w.pose ?? w.shape)!.upperOk;
/** 这面墙要求玩家摆出的骨架（人形洞是目标姿势，几何洞是示范姿势）。 */
const targetOf = (w: WallSpec) => poseToSkeleton(w.pose ?? w.shape!.demo, profile, { x: w.holeX });

/** 整局的墙数：十五关加起来 */
const ALL = COMMON.levelSlots.reduce((n, [fresh, review]) => n + fresh + review, 0);
/** 这个造型是哪一关新出现的（自己存的墙不在表里，返回 0） */
const introOf = (id: string): number => LEVELS.findIndex((l) => l.poses.includes(id) || l.shapes.includes(id)) + 1;
const NARROW: ViewWindow = { left: -0.9, right: 0.9, bottom: 0.02, top: 1.9 };
const custom = (id: string, tier: 1 | 2 | 3 | 4) => ({ ...getPose('hips')!, id, name: id, tier });

describe('tuning', () => {
  it('uses the angle tolerances proven on real players', () => {
    expect(TUNING.easy.angleTol).toBe(40);
    expect(TUNING.normal.angleTol).toBe(32);
    expect(TUNING.hard.angleTol).toBe(25);
  });
  it('only the hardest setting hides the landing outline', () => {
    expect(TUNING.easy.ghost).toBe(true);
    expect(TUNING.normal.ghost).toBe(true);
    expect(TUNING.hard.ghost).toBe(false);
  });
  it('gets stricter and faster with difficulty', () => {
    expect(TUNING.easy.approach).toBeGreaterThan(TUNING.normal.approach);
    expect(TUNING.normal.approach).toBeGreaterThan(TUNING.hard.approach);
    expect(TUNING.easy.posTol).toBeGreaterThan(TUNING.hard.posTol);
    expect(COMMON.lives).toBe(3);
  });
});

describe('the fifteen levels', () => {
  it('is a hand-written table of 15 levels and 55 walls, 34 of them new', () => {
    expect(COMMON.levels).toBe(15);
    expect(LEVELS).toHaveLength(15);
    expect(COMMON.levelSlots).toHaveLength(15);
    expect(ALL).toBe(55);
    expect(COMMON.levelSlots.reduce((n, [fresh]) => n + fresh, 0)).toBe(34);
  });

  it('names every level', () => {
    expect(LEVELS.map((l) => l.theme)).toEqual(['热身', '双脚打开', '一高一低', '弯弯腰', '扎马步', '钻洞', '弓步', '蹲到底', '挪一步', '弯腰鞠躬', '金鸡独立', '踢腿', '组合技', '高手进阶', '终极挑战']);
  });

  it('introduces every pose and every shape in exactly one level', () => {
    const poseIds = LEVELS.flatMap((l) => l.poses);
    const shapeIds = LEVELS.flatMap((l) => l.shapes);
    expect([...poseIds].sort()).toEqual(POSES.map((p) => p.id).sort());
    expect([...shapeIds].sort()).toEqual(SHAPES.map((s) => s.id).sort());
  });

  it('has enough new things in a level to fill its "new" slots', () => {
    LEVELS.forEach((l, i) => expect(l.poses.length + l.shapes.length, `level ${i + 1}`).toBeGreaterThanOrEqual(COMMON.levelSlots[i][0]));
  });

  it('brings the lower body in from level 2', () => {
    expect(LEVELS[0].poses.every((id) => getPose(id)!.upperOk)).toBe(true);
    expect(LEVELS[1].poses.every((id) => !getPose(id)!.upperOk)).toBe(true);
  });

  it('lets saved walls in later the harder they are', () => {
    expect(CUSTOM_FROM_LEVEL).toEqual({ 1: 2, 2: 3, 3: 5, 4: 11 });
  });
});

describe('levelPlan', () => {
  it('starts gentle', () => {
    expect(levelPlan(1, TUNING.normal)).toMatchObject({ level: 1, walls: 3, fresh: 3, review: 0, theme: '热身', offsets: false, angleTol: 32, approachSec: 6.5 });
  });
  it("ends at each difficulty's floor", () => {
    expect(levelPlan(15, TUNING.normal)).toMatchObject({ level: 15, walls: 4, fresh: 0, review: 4, theme: '终极挑战', offsets: true, angleTol: 25, approachSec: 3.6 });
    expect(levelPlan(15, TUNING.easy)).toMatchObject({ angleTol: 32, approachSec: 4.5 });
    expect(levelPlan(15, TUNING.hard)).toMatchObject({ angleTol: 20, approachSec: 3 });
  });
  it('tightens and speeds up in a straight line in between', () => {
    expect(levelPlan(8, TUNING.normal)).toMatchObject({ angleTol: 28.5, approachSec: 5.05 });
    for (let n = 2; n <= 15; n++) {
      expect(levelPlan(n, TUNING.normal).angleTol).toBeLessThan(levelPlan(n - 1, TUNING.normal).angleTol);
      expect(levelPlan(n, TUNING.normal).approachSec).toBeLessThan(levelPlan(n - 1, TUNING.normal).approachSec);
    }
  });
  it('asks for sidesteps from level 9', () => {
    expect(levelPlan(8, TUNING.normal).offsets).toBe(false);
    expect(levelPlan(9, TUNING.normal).offsets).toBe(true);
  });
  it('clamps the level to 1–15', () => {
    expect(levelPlan(99, TUNING.normal).level).toBe(15);
    expect(levelPlan(0, TUNING.normal).level).toBe(1);
  });
});

describe('WallSequence', () => {
  it('is reproducible for a seed and differs between seeds', () => {
    const sig = (w: WallSpec) => `${idOf(w)}@${w.holeX.toFixed(2)}`;
    const a = take(new WallSequence(7, 'normal'), ALL).map(sig);
    const b = take(new WallSequence(7, 'normal'), ALL).map(sig);
    const c = take(new WallSequence(8, 'normal'), ALL).map(sig);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('always opens with the T pose', () => {
    for (const seed of [1, 2, 3]) expect(idOf(new WallSequence(seed, 'normal').next(ctx()))).toBe('t');
  });

  it('counts walls and levels', () => {
    const seq = new WallSequence(3, 'normal');
    expect(seq.level).toBe(1);
    const first = seq.next(ctx());
    expect(first).toMatchObject({ index: 1, level: 1, kind: 'pose', approachSec: 6.5, angleTol: 32, fresh: true });
    expect([seq.wallInLevel, seq.wallsInLevel]).toEqual([1, 3]);
    take(seq, 2);
    expect([seq.level, seq.wallInLevel]).toEqual([1, 3]);
    const fourth = seq.next(ctx());
    expect(fourth).toMatchObject({ index: 4, level: 2 });
    expect(fourth.approachSec).toBeLessThan(6.5);
    expect([seq.level, seq.wallInLevel, seq.wallsInLevel]).toEqual([2, 1, 3]);
  });

  it('is finished after the last wall of level 15, and not before', () => {
    const seq = new WallSequence(3, 'normal');
    take(seq, ALL - 1);
    expect(seq.finished).toBe(false);
    seq.next(ctx());
    expect([seq.level, seq.finished]).toEqual([15, true]);
  });

  it('gives each level its share of new walls and review walls', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const walls = take(new WallSequence(seed, 'normal'), ALL);
      for (let n = 1; n <= 15; n++) {
        const mine = walls.filter((w) => w.level === n);
        const [fresh, review] = COMMON.levelSlots[n - 1];
        expect(mine.length, `seed ${seed} level ${n}`).toBe(fresh + review);
        expect(mine.filter((w) => w.fresh).length, `seed ${seed} level ${n} new`).toBe(fresh);
      }
    }
  });

  it("new walls come from this level's list, review walls from earlier levels", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const w of take(new WallSequence(seed, 'normal'), ALL)) {
        const intro = introOf(baseId(w));
        if (w.fresh) expect(intro, `seed ${seed} wall ${w.index} ${idOf(w)}`).toBe(w.level);
        else expect(intro, `seed ${seed} wall ${w.index} ${idOf(w)}`).toBeLessThan(w.level);
      }
    }
  });

  it('the last level reviews only the hardest four', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const last = take(new WallSequence(seed, 'normal'), ALL).filter((w) => w.level === 15);
      for (const w of last) {
        expect(introOf(baseId(w)), `seed ${seed} ${idOf(w)}`).toBeGreaterThanOrEqual(11);
        expect(introOf(baseId(w))).toBeLessThanOrEqual(14);
      }
    }
  });

  it('reviews recent levels more often than old ones', () => {
    let recent = 0;
    let old = 0;
    for (let seed = 1; seed <= 40; seed++) {
      for (const w of take(new WallSequence(seed, 'normal'), ALL)) {
        if (w.fresh || w.level !== 10) continue;
        if (introOf(baseId(w)) >= 7) recent++;
        else if (introOf(baseId(w)) <= 3) old++;
      }
    }
    // 7～9 关一共 13 个造型，1～3 关一共 17 个；权重一样的话 old 该更多
    expect(recent).toBeGreaterThan(old);
  });

  it('gets the legs involved in every level from the second on', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const walls = take(new WallSequence(seed, 'normal'), ALL);
      for (let n = 2; n <= 15; n++) expect(walls.some((w) => w.level === n && !upperOk(w)), `seed ${seed} level ${n}`).toBe(true);
    }
  });

  it('never repeats a wall inside a level, nor twice in a row', () => {
    for (const seed of [11, 12, 13]) {
      const walls = take(new WallSequence(seed, 'normal'), ALL);
      for (let i = 1; i < walls.length; i++) expect(baseId(walls[i]), `wall ${i + 1}`).not.toBe(baseId(walls[i - 1]));
      for (let n = 1; n <= 15; n++) {
        const ids = walls.filter((w) => w.level === n).map(baseId);
        expect(new Set(ids).size, `seed ${seed} level ${n}`).toBe(ids.length);
      }
    }
  });

  it('holds back shapes until level 6 and sidesteps until level 9', () => {
    for (const seed of [1, 2, 3, 4]) {
      const walls = take(new WallSequence(seed, 'normal'), ALL, ctx({ playerX: 0.1 }));
      for (const w of walls) {
        if (w.level < 6) expect(w.kind, `seed ${seed} wall ${w.index}`).toBe('pose');
        if (w.level < 9) expect(w.holeX).toBeCloseTo(0.1);
        // 往旁边挪的只有两种：复习的人形洞，和偏门
        if (Math.abs(w.holeX - 0.1) > 1e-9) expect(baseId(w) === 'side-door' || (w.kind === 'pose' && !w.fresh), `seed ${seed} wall ${w.index} ${idOf(w)}`).toBe(true);
        expect(Math.abs(w.holeX)).toBeLessThanOrEqual(0.9 + 1e-9);
      }
      expect(walls.filter((w) => w.level === 6).filter((w) => w.kind === 'shape')).toHaveLength(2);
    }
    const moved = [1, 2, 3, 4, 5, 6].flatMap((seed) => take(new WallSequence(seed, 'normal'), ALL)).filter((w) => w.kind === 'pose' && Math.abs(w.holeX) > 0.3);
    expect(moved.length).toBeGreaterThan(0);
  });

  it('mirrors asymmetric poses some of the time, but never a salute', () => {
    const ids = [1, 2, 3, 4, 5, 6].flatMap((seed) => take(new WallSequence(seed, 'normal'), ALL)).map(idOf);
    expect(ids.some((id) => id.endsWith('~m'))).toBe(true);
    expect(ids.some((id) => ['disco', 'signal', 'teapot', 'wave', 'archer'].includes(id))).toBe(true);
    expect(ids).not.toContain('t~m'); // 对称姿势镜像了也一样，不该出镜像版
    expect(ids.some((id) => id.includes('salute'))).toBe(true);
    for (const id of ids) expect(id).not.toMatch(/salute~m$/);
  });

  it('in upper-body mode only asks for things you can do sitting down, all 55 walls', () => {
    for (const seed of [6, 7]) {
      const walls = take(new WallSequence(seed, 'normal'), ALL, ctx({ mode: 'upper' }));
      for (const w of walls) expect(upperOk(w), idOf(w)).toBe(true);
      expect(walls[ALL - 1].level).toBe(15);
    }
  });

  it('never asks for a pose that reaches outside what the camera sees', () => {
    const low: ViewWindow = { ...WIDE_VIEW, top: 1.7 };
    const walls = take(new WallSequence(2, 'normal'), ALL, ctx({ view: low }));
    for (const w of walls) {
      const sk = targetOf(w);
      for (const j of JOINTS) expect(sk[j].y, `${idOf(w)} ${j}`).toBeLessThanOrEqual(1.65);
    }
    const ids = new Set(walls.map(baseId));
    expect(ids.has('up')).toBe(false);
    expect(ids.has('y')).toBe(false);

    for (const seed of [2, 3, 4]) {
      const cramped = take(new WallSequence(seed, 'normal'), ALL, ctx({ view: NARROW }));
      expect(cramped[ALL - 1].level).toBe(15);
      for (const w of cramped) {
        const sk = targetOf(w);
        // 脚尖不算：判定只看到脚踝（见 levels.ts 的 FULL_JOINTS）
        for (const j of JOINTS.filter((name) => !name.startsWith('toe'))) {
          expect(Math.abs(sk[j].x), `${idOf(w)} ${j}`).toBeLessThanOrEqual(0.85 + 1e-9);
          expect(sk[j].y, `${idOf(w)} ${j}`).toBeLessThanOrEqual(1.85 + 1e-9);
        }
      }
    }
  });

  it('falls back to the T pose rather than failing when nothing fits', () => {
    const tiny: ViewWindow = { left: -0.2, right: 0.2, bottom: 0.5, top: 1.0 };
    const walls = take(new WallSequence(1, 'normal'), 12, ctx({ view: tiny }));
    expect(walls.every((w) => idOf(w) === 't')).toBe(true);
  });

  it('still offers every kind of wall when the frame cuts off the toes but not the ankles', () => {
    // 摄像头的下边缘正好落在脚踝和脚尖之间。判定用不到脚尖，不该因为它出画就什么墙都不敢出
    const toesCut: ViewWindow = { ...WIDE_VIEW, bottom: 0.03 };
    const walls = take(new WallSequence(7, 'normal'), ALL, ctx({ view: toesCut }));
    expect(walls.filter((w) => !upperOk(w)).length).toBeGreaterThan(20);
  });

  it('does hold back when the ankles themselves would be out of frame', () => {
    const anklesCut: ViewWindow = { ...WIDE_VIEW, bottom: 0.2 };
    const walls = take(new WallSequence(7, 'normal'), 12, ctx({ view: anklesCut }));
    expect(walls.every((w) => idOf(w) === 't')).toBe(true);
  });

  it('works without a view window', () => {
    expect(() => take(new WallSequence(1, 'normal'), ALL, ctx({ view: null }))).not.toThrow();
  });

  it('draws only from the pool it is given', () => {
    const pool = { poses: [getPose('a')!, getPose('flex')!, getPose('hips')!], shapes: [] };
    const walls = take(new WallSequence(1, 'normal', pool), ALL);
    for (const w of walls) {
      expect(w.kind).toBe('pose');
      expect(['a', 'flex', 'hips']).toContain(baseId(w));
    }
  });

  it('a pool of one wall gives that wall every time', () => {
    const walls = take(new WallSequence(1, 'normal', { poses: [getPose('crane')!], shapes: [] }), ALL);
    expect(walls.every((w) => baseId(w) === 'crane')).toBe(true);
    expect(walls[ALL - 1].level).toBe(15);
  });

  it('difficulty changes speed and tolerance, not the order of walls', () => {
    const easy = take(new WallSequence(5, 'easy'), ALL);
    const hard = take(new WallSequence(5, 'hard'), ALL);
    expect(easy.map(idOf)).toEqual(hard.map(idOf));
    expect(easy[0].angleTol).toBe(40);
    expect(hard[0].angleTol).toBe(25);
    expect(easy[0].approachSec).toBeGreaterThan(hard[0].approachSec);
  });

  describe('walls the player saved', () => {
    const pool = (...extra: ReturnType<typeof custom>[]) => ({ poses: [...POSES, ...extra], shapes: SHAPES });

    it('turn up as review walls, and not before the level their difficulty allows', () => {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const walls = take(new WallSequence(seed, 'normal', pool(custom('my-easy', 1), custom('my-hard', 4))), ALL);
        const easy = walls.filter((w) => baseId(w) === 'my-easy');
        const hard = walls.filter((w) => baseId(w) === 'my-hard');
        expect(easy.length, `seed ${seed}`).toBeGreaterThan(0);
        expect(hard.length, `seed ${seed}`).toBeGreaterThan(0);
        for (const w of [...easy, ...hard]) expect(w.fresh).toBe(false);
        expect(Math.min(...easy.map((w) => w.level))).toBeGreaterThanOrEqual(2);
        expect(Math.min(...hard.map((w) => w.level))).toBeGreaterThanOrEqual(11);
      }
    });

    it('do not crowd out the built-in ones', () => {
      const walls = take(new WallSequence(3, 'normal', pool(custom('my-a', 1), custom('my-b', 1), custom('my-c', 2))), ALL);
      expect(walls.filter((w) => w.fresh)).toHaveLength(34);
      expect(walls.filter((w) => baseId(w).startsWith('my-')).length).toBeLessThanOrEqual(21);
    });
  });

  describe('starting over', () => {
    it('a wall that did not count is replaced by one more in the same level', () => {
      const seq = new WallSequence(3, 'normal');
      take(seq, 2);
      seq.forgetLast();
      expect(seq.wallInLevel).toBe(1);
      take(seq, 2);
      expect([seq.level, seq.wallInLevel]).toEqual([1, 3]);
      expect(seq.next(ctx()).level).toBe(2);
    });

    it('restartLevel replays the level it is on from its first wall', () => {
      const seq = new WallSequence(3, 'normal');
      take(seq, 5); // 第 2 关的第 2 面
      expect([seq.level, seq.wallInLevel]).toEqual([2, 2]);
      seq.restartLevel();
      expect([seq.level, seq.wallInLevel]).toEqual([2, 0]);
      const again = take(seq, 3);
      expect(again.every((w) => w.level === 2)).toBe(true);
      expect(again.filter((w) => w.fresh)).toHaveLength(2);
      expect(seq.next(ctx()).level).toBe(3);
    });

    it('can start at a later level', () => {
      const seq = new WallSequence(3, 'normal', undefined, { startLevel: 15 });
      const walls = take(seq, 4);
      expect(walls.every((w) => w.level === 15)).toBe(true);
      expect(walls.every((w) => introOf(baseId(w)) >= 11)).toBe(true);
      expect(seq.finished).toBe(true);
      expect(new WallSequence(3, 'normal', undefined, { startLevel: 99 }).level).toBe(15);
      expect(new WallSequence(3, 'normal', undefined, { startLevel: 0 }).level).toBe(1);
    });

    it('keeps handing out last-level walls if asked for more after the end', () => {
      const seq = new WallSequence(3, 'normal');
      const extra = take(seq, ALL + 6).slice(ALL);
      expect(extra.every((w) => w.level === 15)).toBe(true);
    });
  });
});

describe('WallSequence for two players', () => {
  const WIDE_DUO: ViewWindow = { left: -2.6, right: 2.6, bottom: -0.12, top: 2.26 };
  const kid = scaleProfile(profile, 0.75);
  /** 两个人各站在 ∓gap/2。 */
  const duo = (gap: number, over: Partial<SpawnCtx> = {}, mateProfile: BodyProfile = profile): SpawnCtx => ({
    mode: 'full',
    view: WIDE_DUO,
    profile,
    playerX: -gap / 2,
    mate: { view: over.view === undefined ? WIDE_DUO : over.view, profile: mateProfile, playerX: gap / 2 },
    lanes: [-gap / 2, gap / 2],
    ...over,
  });
  const GAPS = [1.2, 1.5, 1.9];
  const posesOf = (w: WallSpec): [PoseSpec, PoseSpec] => [w.pose ?? w.shape!.demo, w.mate!.pose ?? w.mate!.shape!.demo];
  const ids = (w: WallSpec): [string, string] => [idOf(w), (w.mate!.pose ?? w.mate!.shape)!.id];
  const bases = (w: WallSpec): [string, string] => [ids(w)[0].replace(/~m$/, ''), ids(w)[1].replace(/~m$/, '')];
  const capsAt = (pose: PoseSpec, x: number, p: BodyProfile) => skeletonCapsules(poseToSkeleton(pose, p, { x }), p);
  /** 两位的目标轮廓之间空多少。 */
  const clearance = (w: WallSpec, mateProfile: BodyProfile = profile): number => bodyGap(capsAt(posesOf(w)[0], w.holeX, profile), capsAt(posesOf(w)[1], w.mate!.holeX, mateProfile));

  it('every wall has a hole for each player, at their own spot, through all 55 walls', () => {
    for (const gap of GAPS) {
      const walls = take(new WallSequence(4, 'normal'), ALL, duo(gap));
      expect(walls[ALL - 1].level, `gap ${gap}`).toBe(15);
      for (const w of walls) {
        expect(w.mate, `gap ${gap} wall ${w.index}`).toBeDefined();
        expect(w.holeX).toBeLessThan(0);
        expect(w.mate!.holeX).toBeGreaterThan(0);
        if (w.level < 9) expect([w.holeX, w.mate!.holeX]).toEqual([-gap / 2, gap / 2]);
      }
    }
  });

  it('never asks the two of them to occupy the same space', () => {
    for (const gap of GAPS) {
      for (const seed of [1, 2, 3]) {
        for (const w of take(new WallSequence(seed, 'normal'), ALL, duo(gap))) {
          expect(clearance(w), `gap ${gap} seed ${seed} wall ${w.index} ${ids(w).join(' + ')}`).toBeGreaterThanOrEqual(COMMON.duo.handGap - 0.011);
        }
      }
    }
  });

  it('keeps every joint of each player inside what the camera sees', () => {
    const cramped: ViewWindow = { left: -1.75, right: 1.75, bottom: 0.02, top: 1.9 };
    for (const seed of [1, 2]) {
      const walls = take(new WallSequence(seed, 'normal'), ALL, duo(1.5, { view: cramped }));
      expect(walls[ALL - 1].level).toBe(15);
      for (const w of walls) {
        const [a, b] = posesOf(w);
        for (const sk of [poseToSkeleton(a, profile, { x: w.holeX }), poseToSkeleton(b, profile, { x: w.mate!.holeX })]) {
          for (const j of JOINTS.filter((name) => !name.startsWith('toe'))) {
            expect(Math.abs(sk[j].x), `${ids(w).join(' + ')} ${j}`).toBeLessThanOrEqual(1.7 + 1e-9);
            expect(sk[j].y, `${ids(w).join(' + ')} ${j}`).toBeLessThanOrEqual(1.85 + 1e-9);
          }
        }
      }
    }
  });

  it('opens with holding hands when there is no room for two T poses, and with the T when there is', () => {
    const close = new WallSequence(3, 'normal').next(duo(1.5));
    expect(close.duo).toBe('hold-hands');
    expect(ids(close)).toEqual(['hold-hands', 'hold-hands~m']);
    const apart = new WallSequence(3, 'normal').next(duo(1.9));
    expect(ids(apart)).toEqual(['t', 't']);
    expect(apart.duo).toBeUndefined();
  });

  it('brings in holding hands in level 1 and the bridge in level 2, whatever the seed', () => {
    for (const gap of GAPS) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const walls = take(new WallSequence(seed, 'normal'), ALL, duo(gap));
        expect(walls.filter((w) => w.level === 1).some((w) => w.duo === 'hold-hands'), `gap ${gap} seed ${seed}`).toBe(true);
        expect(walls.filter((w) => w.level === 2).some((w) => w.duo === 'bridge'), `gap ${gap} seed ${seed}`).toBe(true);
        expect(walls.filter((w) => w.level === 1).some((w) => w.duo === 'bridge')).toBe(false);
      }
    }
  });

  it('sizes the reach of the two-player poses to how far apart the players stand', () => {
    const w = new WallSequence(3, 'normal').next(duo(1.2));
    expect(w.duo).toBe('hold-hands');
    expect(w.pose!.armR[0].a).toBeCloseTo(duoArmAngle('hold-hands', profile, 0.6), 6);
    expect(w.mate!.pose!.armL[0].a).toBeCloseTo(duoArmAngle('hold-hands', profile, 0.6), 6);
    const wide = new WallSequence(3, 'normal').next(duo(1.5));
    expect(wide.pose!.armR[0].a).toBeGreaterThan(w.pose!.armR[0].a);
  });

  it('gives both the same pose in the first two levels; from level 3 they may be asked for different ones', () => {
    let mixed = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const w of take(new WallSequence(seed, 'normal'), ALL, duo(1.5))) {
        const [a, b] = bases(w);
        if (w.level < COMMON.duo.mixFromLevel) expect(a, `seed ${seed} wall ${w.index}`).toBe(b);
        else if (a !== b) mixed++;
      }
    }
    expect(mixed).toBeGreaterThan(8);
  });

  it('mirrors a one-sided pose between them, so the picture is symmetric', () => {
    let seen = 0;
    for (const seed of [1, 2, 3, 4]) {
      for (const w of take(new WallSequence(seed, 'normal'), ALL, duo(1.5))) {
        const [a, b] = ids(w);
        if (w.kind !== 'pose' || w.duo || bases(w)[0] !== bases(w)[1]) continue;
        const pose = getPose(bases(w)[0])!;
        const oneSided = JSON.stringify(pose.armL) !== JSON.stringify(pose.armR) || JSON.stringify(pose.legL) !== JSON.stringify(pose.legR) || (pose.spine?.a ?? 0) !== 0;
        if (pose.noMirror || !oneSided) expect(a, `seed ${seed} wall ${w.index}`).toBe(b);
        else {
          expect(a.endsWith('~m'), `seed ${seed} wall ${w.index} ${a} + ${b}`).not.toBe(b.endsWith('~m'));
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(5);
  });

  it('never mirrors a salute for either of them', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      for (const w of take(new WallSequence(seed, 'normal'), ALL, duo(1.5))) for (const id of ids(w)) expect(id).not.toMatch(/salute~m$/);
    }
  });

  it('asks both to sidestep the same way by the same amount, and only from level 9', () => {
    let moved = 0;
    for (const gap of GAPS) {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        for (const w of take(new WallSequence(seed, 'normal'), ALL, duo(gap))) {
          const da = w.holeX + gap / 2;
          const db = w.mate!.holeX - gap / 2;
          expect(da, `gap ${gap} seed ${seed} wall ${w.index}`).toBeCloseTo(db, 9);
          expect(Math.abs(da)).toBeLessThanOrEqual(Math.min(0.55, gap / 2 - COMMON.duo.sideMargin) + 1e-9);
          if (w.level < 9) expect(da).toBe(0);
          if (Math.abs(da) > 0.05) moved++;
        }
      }
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('gives both players the same geometric hole', () => {
    const shapes = [1, 2, 3].flatMap((seed) => take(new WallSequence(seed, 'normal'), ALL, duo(1.5))).filter((w) => w.kind === 'shape');
    expect(shapes.length).toBeGreaterThan(3);
    for (const w of shapes) expect(w.mate!.shape).toBe(w.shape);
  });

  it('works in upper-body mode with a cramped view', () => {
    const cramped: ViewWindow = { left: -1.6, right: 1.6, bottom: 0.6, top: 1.9 };
    const walls = take(new WallSequence(5, 'normal'), ALL, duo(1.4, { mode: 'upper', view: cramped }));
    expect(walls[ALL - 1].level).toBe(15);
    for (const w of walls) {
      expect(upperOk(w), ids(w).join(' + ')).toBe(true);
      expect((w.mate!.pose ?? w.mate!.shape)!.upperOk, ids(w).join(' + ')).toBe(true);
    }
  });

  it('copes with a tall and a short player: each hole is fitted to its own player', () => {
    for (const seed of [1, 2]) {
      const walls = take(new WallSequence(seed, 'normal'), ALL, duo(1.3, {}, kid));
      expect(walls[ALL - 1].level).toBe(15);
      for (const w of walls) expect(clearance(w, kid), `seed ${seed} wall ${w.index} ${ids(w).join(' + ')}`).toBeGreaterThanOrEqual(COMMON.duo.handGap - 0.011);
      const hands = walls.find((w) => w.duo === 'hold-hands')!;
      expect(hands.mate!.pose!.armL[0].a).toBeGreaterThan(hands.pose!.armR[0].a); // 胳膊短的那位抬得更平
    }
  });

  it('when the only wall in the pool cannot be done side by side, both get hands on hips instead of a crash', () => {
    const walls = take(new WallSequence(1, 'normal', { poses: [getPose('t')!], shapes: [] }), 12, duo(1.2));
    for (const w of walls) expect(ids(w)).toEqual(['hips', 'hips']);
    // 放得下的时候，"只练这一面"两个人都是它，也不掺进手拉手
    const roomy = take(new WallSequence(1, 'normal', { poses: [getPose('up')!], shapes: [] }), 12, duo(1.2));
    for (const w of roomy) expect(ids(w)).toEqual(['up', 'up']);
  });

  it('is reproducible for a seed, and the same at every difficulty', () => {
    const sig = (w: WallSpec) => `${ids(w).join('+')}@${w.holeX.toFixed(2)},${w.mate!.holeX.toFixed(2)}`;
    const a = take(new WallSequence(7, 'normal'), ALL, duo(1.5)).map(sig);
    expect(take(new WallSequence(7, 'normal'), ALL, duo(1.5)).map(sig)).toEqual(a);
    expect(take(new WallSequence(7, 'easy'), ALL, duo(1.5)).map(sig)).toEqual(a);
    expect(take(new WallSequence(7, 'hard'), ALL, duo(1.5)).map(sig)).toEqual(a);
    expect(take(new WallSequence(8, 'normal'), ALL, duo(1.5)).map(sig)).not.toEqual(a);
  });

  it('keeps the two holes apart even when the players have drifted towards each other', () => {
    const close: SpawnCtx = { ...duo(1.2), playerX: -0.2, mate: { view: WIDE_DUO, profile, playerX: 0.2 } };
    for (const w of take(new WallSequence(2, 'normal'), 20, close)) {
      expect(w.mate!.holeX - w.holeX).toBeGreaterThanOrEqual(1.0 - 1e-9);
      expect(clearance(w)).toBeGreaterThanOrEqual(COMMON.duo.handGap - 0.011);
    }
  });

  it('however the players follow the holes about, neither hole ever comes near the line between them', () => {
    // 洞跟着人走，挪步又在这之上再挪：两样叠起来，洞不能挪到两人中线上去——
    // 站到线上的那位会被当成"走出了自己的泳道"，游戏就一直停在"人呢？"
    for (const gap of GAPS) {
      for (const seed of [3, 7, 11]) {
        const seq = new WallSequence(seed, 'normal');
        let at: [number, number] = [-gap / 2, gap / 2];
        for (let i = 0; i < ALL; i++) {
          const w = seq.next({ ...duo(gap), playerX: at[0], mate: { view: WIDE_DUO, profile, playerX: at[1] } });
          expect(w.holeX, `gap ${gap} seed ${seed} wall ${w.index}`).toBeLessThanOrEqual(-COMMON.duo.sideMargin + 1e-9);
          expect(w.mate!.holeX, `gap ${gap} seed ${seed} wall ${w.index}`).toBeGreaterThanOrEqual(COMMON.duo.sideMargin - 1e-9);
          at = [w.holeX, w.mate!.holeX]; // 两个人都站到洞那儿去了
        }
      }
    }
  });

  it('a single player still gets single walls', () => {
    for (const w of take(new WallSequence(4, 'normal'), ALL)) {
      expect(w.mate).toBeUndefined();
      expect(w.duo).toBeUndefined();
    }
  });
});
