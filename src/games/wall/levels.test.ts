import { describe, expect, it } from 'vitest';
import type { ViewWindow } from '../../engine/body/bodyModel';
import { JOINTS, poseToSkeleton } from '../../engine/body/pose';
import { defaultProfile } from '../../engine/body/profile';
import { levelPlan, WallSequence, type SpawnCtx, type WallSpec } from './levels';
import { getPose } from './poses';
import { COMMON, TUNING } from './tuning';

const profile = defaultProfile();
const WIDE_VIEW: ViewWindow = { left: -2.1, right: 2.1, bottom: -0.12, top: 2.26 };
const ctx = (over: Partial<SpawnCtx> = {}): SpawnCtx => ({ mode: 'full', view: WIDE_VIEW, profile, playerX: 0, ...over });
const take = (seq: WallSequence, n: number, c: SpawnCtx = ctx()): WallSpec[] => Array.from({ length: n }, () => seq.next(c));
const idOf = (w: WallSpec): string => (w.pose ?? w.shape)!.id;
const baseId = (w: WallSpec): string => idOf(w).replace(/~m$/, '');
const tierOf = (w: WallSpec): number => (w.pose ?? w.shape)!.tier;
const upperOk = (w: WallSpec): boolean => (w.pose ?? w.shape)!.upperOk;
/** 这面墙要求玩家摆出的骨架（人形洞是目标姿势，几何洞是示范姿势）。 */
const targetOf = (w: WallSpec) => poseToSkeleton(w.pose ?? w.shape!.demo, profile, { x: w.holeX });

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

describe('levelPlan', () => {
  it('starts gentle', () => {
    expect(levelPlan(1, TUNING.normal)).toMatchObject({ level: 1, walls: 5, tiers: [1], shapes: false, offsets: false, angleTol: 32, approachSec: 6.5 });
  });
  it('adds asymmetric poses, then shapes, then sidesteps, then balance', () => {
    expect(levelPlan(2, TUNING.normal)).toMatchObject({ walls: 6, tiers: [1, 2], shapes: false, offsets: false });
    expect(levelPlan(3, TUNING.normal)).toMatchObject({ walls: 7, tiers: [1, 2], shapes: true, shapeTier: 2, offsets: false });
    expect(levelPlan(4, TUNING.normal)).toMatchObject({ walls: 8, tiers: [2, 3], shapes: true, shapeTier: 3, offsets: true });
    expect(levelPlan(5, TUNING.normal)).toMatchObject({ walls: 8, tiers: [2, 3, 4], shapes: true, offsets: true });
  });
  it('tightens and speeds up, but never past the floor', () => {
    expect(levelPlan(6, TUNING.normal)).toMatchObject({ walls: 8, angleTol: 25, approachSec: 4.5 });
    expect(levelPlan(20, TUNING.normal).approachSec).toBe(3.6);
    expect(levelPlan(20, TUNING.normal).angleTol).toBe(25);
    expect(levelPlan(3, TUNING.easy).angleTol).toBe(37);
  });
});

describe('WallSequence', () => {
  it('is reproducible for a seed and differs between seeds', () => {
    const sig = (w: WallSpec) => `${idOf(w)}@${w.holeX.toFixed(2)}`;
    const a = take(new WallSequence(7, 'normal'), 40).map(sig);
    const b = take(new WallSequence(7, 'normal'), 40).map(sig);
    const c = take(new WallSequence(8, 'normal'), 40).map(sig);
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
    expect(first).toMatchObject({ index: 1, level: 1, kind: 'pose', approachSec: 6.5, angleTol: 32 });
    expect([seq.wallInLevel, seq.wallsInLevel]).toEqual([1, 5]);
    take(seq, 4);
    expect([seq.level, seq.wallInLevel]).toEqual([1, 5]);
    const sixth = seq.next(ctx());
    expect(sixth).toMatchObject({ index: 6, level: 2, approachSec: 6.1 });
    expect([seq.level, seq.wallInLevel, seq.wallsInLevel]).toEqual([2, 1, 6]);
  });

  it('keeps level 1 to simple symmetric poses', () => {
    for (const w of take(new WallSequence(5, 'normal'), 5)) {
      expect(w.kind).toBe('pose');
      expect(tierOf(w)).toBe(1);
    }
  });

  it('holds back shapes until level 3 and sidesteps until level 4', () => {
    for (const seed of [1, 2, 3, 4]) {
      const walls = take(new WallSequence(seed, 'normal'), 60, ctx({ playerX: 0.1 }));
      for (const w of walls) {
        if (w.level < 3) expect(w.kind, `seed ${seed} wall ${w.index}`).toBe('pose');
        if (w.level === 3 && w.kind === 'shape') expect(tierOf(w)).toBe(2);
        if (w.level < 4) expect(w.holeX).toBeCloseTo(0.1);
        expect(Math.abs(w.holeX)).toBeLessThanOrEqual(0.9 + 1e-9);
      }
      expect(walls.some((w) => w.kind === 'shape')).toBe(true);
      expect(walls.some((w) => w.level >= 4 && Math.abs(w.holeX - 0.1) > 0.3)).toBe(true);
    }
  });

  it('respects each level\'s tiers', () => {
    for (const w of take(new WallSequence(9, 'normal'), 60)) {
      const plan = levelPlan(w.level, TUNING.normal);
      if (w.kind === 'pose') expect(plan.tiers, `wall ${w.index} ${idOf(w)}`).toContain(tierOf(w));
      else expect(tierOf(w)).toBeLessThanOrEqual(plan.shapeTier);
    }
  });

  it('never repeats the same wall twice in a row', () => {
    const walls = take(new WallSequence(12, 'normal'), 80);
    for (let i = 1; i < walls.length; i++) expect(baseId(walls[i]), `wall ${i + 1}`).not.toBe(baseId(walls[i - 1]));
  });

  it('mirrors asymmetric poses some of the time', () => {
    const ids = take(new WallSequence(4, 'normal'), 80).map(idOf);
    expect(ids.some((id) => id.endsWith('~m'))).toBe(true);
    expect(ids.some((id) => ['disco', 'signal', 'teapot', 'wave', 'archer'].includes(id))).toBe(true);
    expect(ids).not.toContain('t~m'); // 对称姿势镜像了也一样，不该出镜像版
  });

  it('in upper-body mode only asks for things you can do sitting down', () => {
    for (const w of take(new WallSequence(6, 'normal'), 60, ctx({ mode: 'upper' }))) expect(upperOk(w), idOf(w)).toBe(true);
  });

  it('never asks for a pose that reaches outside what the camera sees', () => {
    const low: ViewWindow = { ...WIDE_VIEW, top: 1.7 };
    const walls = take(new WallSequence(2, 'normal'), 60, ctx({ view: low }));
    for (const w of walls) {
      const sk = targetOf(w);
      for (const j of JOINTS) expect(sk[j].y, `${idOf(w)} ${j}`).toBeLessThanOrEqual(1.65);
    }
    const ids = new Set(walls.map(baseId));
    expect(ids.has('up')).toBe(false);
    expect(ids.has('y')).toBe(false);

    const narrow: ViewWindow = { ...WIDE_VIEW, left: -0.9, right: 0.9 };
    for (const w of take(new WallSequence(2, 'normal'), 60, ctx({ view: narrow }))) {
      const sk = targetOf(w);
      for (const j of JOINTS) expect(Math.abs(sk[j].x), `${idOf(w)} ${j}`).toBeLessThanOrEqual(0.85 + 1e-9);
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
    const walls = take(new WallSequence(7, 'normal'), 40, ctx({ view: toesCut }));
    expect(new Set(walls.map(baseId)).size).toBeGreaterThan(8);
  });

  it('does hold back when the ankles themselves would be out of frame', () => {
    const anklesCut: ViewWindow = { ...WIDE_VIEW, bottom: 0.2 };
    const walls = take(new WallSequence(7, 'normal'), 12, ctx({ view: anklesCut }));
    expect(walls.every((w) => idOf(w) === 't')).toBe(true);
  });

  it('works without a view window', () => {
    expect(() => take(new WallSequence(1, 'normal'), 30, ctx({ view: null }))).not.toThrow();
  });

  it('draws only from the pool it is given', () => {
    const pool = { poses: [getPose('a')!, getPose('flex')!, getPose('hips')!], shapes: [] };
    const walls = take(new WallSequence(1, 'normal', pool), 40);
    for (const w of walls) {
      expect(w.kind).toBe('pose');
      expect(['a', 'flex', 'hips']).toContain(baseId(w));
    }
  });

  it('difficulty changes speed and tolerance, not the order of walls', () => {
    const easy = take(new WallSequence(5, 'easy'), 20);
    const hard = take(new WallSequence(5, 'hard'), 20);
    expect(easy.map(idOf)).toEqual(hard.map(idOf));
    expect(easy[0].angleTol).toBe(40);
    expect(hard[0].angleTol).toBe(25);
    expect(easy[0].approachSec).toBeGreaterThan(hard[0].approachSec);
  });
});
