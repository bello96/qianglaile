import { describe, expect, it } from 'vitest';
import { poseToSkeleton } from '../../engine/body/pose';
import { defaultProfile } from '../../engine/body/profile';
import { SimPoseSource } from '../../engine/input/simSource';
import { PlayerTracker } from '../../engine/player/playerTracker';
import { buildWall, type BuiltWall } from './build';
import { WallGame, type GameEvent } from './game';
import { sampleField } from './field';
import { getPose, STAND } from './poses';
import { getShape } from './shapes';
import { COMMON, TUNING, type Difficulty } from './tuning';

const STEP = 1 / 60;

type Policy = (wall: BuiltWall, sim: SimPoseSource) => void;
/** 照着墙的要求摆：人形洞摆目标姿势，几何洞摆示范姿势，并站到洞的位置。 */
const perfect: Policy = (wall, sim) => sim.setPose(wall.spec.pose ?? wall.spec.shape!.demo, { x: wall.spec.holeX }, 0.4);
/** 永远站着不动。 */
const lazy: Policy = () => {};

interface Rig {
  game: WallGame;
  sim: SimPoseSource;
  tracker: PlayerTracker;
  log: GameEvent[];
  /** 推进游戏，直到 stop 返回 true 或者超过 maxSec 秒（游戏时间）。 */
  run(stop: (rig: Rig) => boolean, maxSec?: number): Rig;
  /** 推进固定的秒数。 */
  advance(sec: number): Rig;
  count(type: GameEvent['type']): number;
}

function rig(opts: { seed?: number; difficulty?: Difficulty; policy?: Policy; noise?: number; pool?: ConstructorParameters<typeof WallGame>[0]['pool'] } = {}): Rig {
  const sim = new SimPoseSource({ seed: 5, noise: opts.noise ?? 0.008 });
  const tracker = new PlayerTracker();
  for (let i = 0; i < 40; i++) tracker.ingest(sim.step(1000 / 30)); // 先站一会儿：量身材
  tracker.calibrate();
  const game = new WallGame({ seed: opts.seed ?? 7, difficulty: opts.difficulty ?? 'normal', pool: opts.pool });
  game.start({ profile: tracker.state.profile, mode: 'full', view: tracker.state.body!.view });

  const policy = opts.policy ?? perfect;
  let tick = 0;
  const self: Rig = {
    game,
    sim,
    tracker,
    log: [],
    run(stop, maxSec = 200) {
      for (let t = 0; t < maxSec && !stop(self); t += STEP) {
        if (tick++ % 2 === 0) tracker.ingest(sim.step(1000 / 30)); // 识别 30 Hz，游戏 60 Hz
        for (const e of game.update(STEP, tracker.state.body)) {
          self.log.push(e);
          if (e.type === 'wall') policy(e.wall, sim);
        }
      }
      return self;
    },
    advance(sec) {
      let left = sec;
      return self.run(() => (left -= STEP) < 0, sec + 1);
    },
    count: (type) => self.log.filter((e) => e.type === type).length,
  };
  return self;
}

const outcomes = (r: Rig) => r.log.filter((e): e is Extract<GameEvent, { type: 'outcome' }> => e.type === 'outcome');
const inApproach = (r: Rig) => r.game.state.phase === 'approach';

describe('buildWall', () => {
  const profile = defaultProfile();
  it('cuts a pose-shaped hole where the spec says', () => {
    const wall = buildWall({ index: 1, level: 1, kind: 'pose', pose: getPose('t')!, holeX: 0.3, approachSec: 6.5, angleTol: 32 }, profile, TUNING.normal);
    const want = poseToSkeleton(getPose('t')!, profile, { x: 0.3 });
    expect(wall.target.wristR.x).toBeCloseTo(want.wristR.x);
    expect(sampleField(wall.field, want.wristR.x, want.wristR.y)).toBeLessThan(0); // 手腕在洞里
    expect(sampleField(wall.field, want.wristR.x, want.wristR.y + 0.4)).toBeGreaterThan(0); // 往上 40 厘米是墙
    expect(wall.outlines).toHaveLength(1);
    expect(wall.ghost.length).toBeGreaterThan(0);
    expect(wall.label).toBe('一字平举');
    expect(wall.say).toBe('双手平举');
  });

  it('cuts a geometric hole and keeps the demo pose as the hint', () => {
    const shape = getShape('low-door')!;
    const wall = buildWall({ index: 9, level: 4, kind: 'shape', shape, holeX: -0.2, approachSec: 5, angleTol: 30 }, profile, TUNING.normal);
    expect(wall.label).toBe('矮门');
    expect(wall.target.hipC.x).toBeCloseTo(-0.2);
    expect(wall.target.hipC.y).toBeLessThan(0.6); // 示范姿势是蹲着的
    expect(sampleField(wall.field, -0.2, 0.5)).toBeLessThan(0);
    expect(sampleField(wall.field, -0.2, 1.6)).toBeGreaterThan(0);
  });

  it('makes a snugger hole on harder settings', () => {
    const spec = { index: 1, level: 1, kind: 'pose' as const, pose: STAND, holeX: 0, approachSec: 6, angleTol: 32 };
    const probeX = profile.shoulderW / 2 + profile.r.shoulder + 0.1; // 肩膀外侧 10 厘米
    expect(sampleField(buildWall(spec, profile, TUNING.easy).field, probeX, 1.32)).toBeLessThan(0);
    expect(sampleField(buildWall(spec, profile, TUNING.hard).field, probeX, 1.32)).toBeGreaterThan(0);
  });
});

describe('WallGame flow', () => {
  it('is idle until started', () => {
    const game = new WallGame({ seed: 1, difficulty: 'normal' });
    expect(game.state.phase).toBe('idle');
    expect(game.update(STEP, null)).toEqual([]);
    expect(game.state).toMatchObject({ lives: 3, score: 0, level: 1, wallIndex: 0, wall: null });
  });

  it('counts down 3-2-1, then sends the first wall', () => {
    const r = rig().run((x) => x.count('wall') === 1);
    expect(r.log.map((e) => (e.type === 'countdown' ? `c${e.n}` : e.type))).toEqual(['c3', 'c2', 'c1', 'wall']);
    expect(r.game.state).toMatchObject({ phase: 'approach', wallIndex: 1, wallInLevel: 1, wallsInLevel: 5, level: 1 });
    expect(r.game.state.wall!.spec.pose!.id).toBe('t');
    expect(r.game.state.timeLeft).toBeCloseTo(6.5, 1);
  });

  it('ticks down the last three seconds of each wall', () => {
    const r = rig().run((x) => x.count('outcome') === 1);
    expect(r.log.filter((e) => e.type === 'tick').map((e) => (e as { n: number }).n)).toEqual([3, 2, 1]);
  });

  it('a player who matches every wall sails through two levels', () => {
    const r = rig().run((x) => x.count('outcome') === 11);
    const outs = outcomes(r);
    expect(outs.map((o) => o.outcome.kind)).toEqual(Array(11).fill('pass'));
    expect(r.game.state.lives).toBe(3);
    expect(r.game.state.score).toBeGreaterThan(11 * 100);
    expect(r.game.state.combo).toBe(11);
    expect(r.count('life')).toBe(0);

    // 第 5 面墙过完才升到第 2 关，之后才出第 6 面墙
    const order = r.log.filter((e) => e.type === 'outcome' || e.type === 'levelup' || e.type === 'wall').map((e) => e.type);
    expect(order.slice(8, 12)).toEqual(['wall', 'outcome', 'levelup', 'wall']);
    expect(r.log.find((e) => e.type === 'levelup')).toEqual({ type: 'levelup', level: 2 });
    expect(r.count('levelup')).toBe(1);
    expect(r.game.state.level).toBe(2);
  });

  it('shows live feedback while the wall approaches', () => {
    const r = rig().run((x) => inApproach(x) && x.game.state.progress > 0.6);
    expect(r.game.state.live).toMatchObject({ ok: true, badParts: [], hint: '' });
    expect(r.game.state.live!.accuracy).toBeGreaterThan(0.8);

    const idle = rig({ policy: lazy }).run((x) => inApproach(x) && x.game.state.progress > 0.6);
    expect(idle.game.state.live!.ok).toBe(false);
    expect(idle.game.state.live!.badParts).toEqual(expect.arrayContaining(['upperArmL', 'upperArmR']));
    expect(idle.game.state.live!.hint.length).toBeGreaterThan(0);
  });

  it('standing still gets knocked off three times and the game ends', () => {
    const r = rig({ policy: lazy }).run((x) => x.game.state.phase === 'over');
    expect(r.game.state.phase).toBe('over');
    expect(r.game.state.lives).toBe(0);
    const outs = outcomes(r);
    expect(outs).toHaveLength(3);
    expect(outs.every((o) => o.outcome.kind === 'hit' && o.gained === 0)).toBe(true);
    expect(outs[0].outcome).toMatchObject({ kind: 'hit', badParts: expect.arrayContaining(['upperArmL', 'upperArmR']) });

    // 每次撞墙后紧跟一条"扣命"
    const types = r.log.map((e) => e.type);
    for (let i = 0; i < types.length; i++) if (types[i] === 'outcome') expect(types[i + 1]).toBe('life');
    expect(r.log.filter((e) => e.type === 'life').map((e) => (e as { lives: number }).lives)).toEqual([2, 1, 0]);

    const over = r.log[r.log.length - 1];
    expect(over).toEqual({ type: 'over', summary: { level: 1, walls: 0, score: 0, bestCombo: 0, stars: [0, 0, 0], seed: 7, difficulty: 'normal' } });
    expect(r.game.summary).toEqual((over as Extract<GameEvent, { type: 'over' }>).summary);
    expect(r.game.update(STEP, null)).toEqual([]); // 结束后不再有任何动静
  });

  it('scores by stars with a growing combo bonus, and pays a bonus for levelling up', () => {
    const r = rig({ noise: 0.004 }).run((x) => x.count('wall') === 6);
    const outs = outcomes(r);
    expect(outs[0]).toMatchObject({ outcome: { kind: 'pass', stars: 3 }, gained: 300 });
    expect(outs[1]).toMatchObject({ outcome: { kind: 'pass', stars: 3 }, gained: 330 }); // 连击 ×1.1
    expect(outs[2].gained).toBe(360);
    const fromWalls = outs.reduce((sum, o) => sum + o.gained, 0);
    expect(r.game.state.score).toBe(fromWalls + 500 * 2);
    expect(r.game.summary).toMatchObject({ walls: 5, bestCombo: 5, stars: [0, 0, 5], level: 2 });
  });

  it('a miss resets the combo and the game carries on', () => {
    let n = 0;
    const missSecond: Policy = (wall, sim) => (++n === 2 ? sim.setPose(STAND, {}, 0.3) : perfect(wall, sim));
    const r = rig({ policy: missSecond, noise: 0.004 }).run((x) => x.count('outcome') === 3);
    const outs = outcomes(r);
    expect(outs.map((o) => o.outcome.kind)).toEqual(['pass', 'hit', 'pass']);
    expect(outs[2].gained).toBe(300); // 连击从头算
    expect(r.game.state.lives).toBe(2);
    expect(r.game.summary.bestCombo).toBe(1);
  });
});

describe('WallGame robustness', () => {
  it('pauses instead of punishing when the player walks out of view', () => {
    const r = rig().run((x) => inApproach(x) && x.game.state.progress > 0.3);
    r.sim.setPresent(false);
    r.advance(0.8);
    expect(r.game.state.phase).toBe('approach'); // 还没到 1 秒，先不暂停
    r.advance(0.5);
    expect(r.game.state.phase).toBe('paused');
    expect(r.log[r.log.length - 1]).toEqual({ type: 'pause', on: true });

    const frozen = r.game.state.progress;
    r.advance(5);
    expect(r.game.state.progress).toBe(frozen);
    expect(r.game.state.lives).toBe(3);
    expect(r.count('outcome')).toBe(0);

    r.sim.setPresent(true);
    r.advance(0.3);
    expect(r.game.state.phase).toBe('paused'); // 回来还不到 0.5 秒
    r.advance(0.5);
    expect(r.game.state.phase).toBe('approach');
    expect(r.log[r.log.length - 1]).toEqual({ type: 'pause', on: false });

    r.run((x) => x.count('outcome') === 1);
    expect(outcomes(r)[0].outcome.kind).toBe('pass');
  });

  it('does not take a life when the player is not seen as the wall arrives: the wall waits, then backs off', () => {
    const r = rig().run((x) => inApproach(x) && x.game.state.timeLeft < 0.6);
    r.sim.setPresent(false);
    r.advance(1.6); // 墙本该在 0.6 秒后到达
    expect(r.count('outcome')).toBe(0);
    expect(r.game.state.lives).toBe(3);
    expect(r.game.state.phase).toBe('paused');

    // 人回来：墙退回去一段，留出重新摆好的时间
    r.sim.setPresent(true);
    r.run(inApproach, 5);
    expect(r.game.state.timeLeft).toBeGreaterThanOrEqual(COMMON.resumeLeadSec - 0.05);
    r.run((x) => x.count('outcome') === 1);
    expect(outcomes(r)[0].outcome.kind).toBe('pass');
    expect(r.game.state.lives).toBe(3);
  });

  it('rides out a short recognition dropout right at arrival', () => {
    // 识别偶尔会丢几帧。墙到的那一刻正好丢了不到半秒：一直摆得对的人不该被判撞墙，也不该被打断
    const r = rig().run((x) => inApproach(x) && x.game.state.timeLeft < 0.3);
    r.sim.setPresent(false);
    r.advance(0.45);
    expect(r.count('outcome')).toBe(0);
    r.sim.setPresent(true);
    r.run((x) => x.count('outcome') === 1, 20);
    expect(outcomes(r)[0].outcome.kind).toBe('pass');
    expect(r.game.state.lives).toBe(3);
    expect(r.count('pause')).toBe(0);
  });

  it('judges on what it saw when the dropout is shorter than the judging window', () => {
    const r = rig().run((x) => inApproach(x) && x.game.state.timeLeft < 0.12);
    r.sim.setPresent(false);
    r.run((x) => x.count('outcome') === 1, 5);
    expect(outcomes(r)[0].outcome.kind).toBe('pass');
    expect(r.count('pause')).toBe(0);
  });

  it('still counts a wrong pose as a hit — waiting is only for when nobody is seen', () => {
    const r = rig({ policy: lazy }).run((x) => x.count('outcome') === 1);
    expect(outcomes(r)[0].outcome.kind).toBe('hit');
    expect(r.game.state.lives).toBe(2);
  });

  it('after any pause late in the approach, leaves time to get back into the pose', () => {
    const r = rig().run((x) => inApproach(x) && x.game.state.timeLeft < 1.4);
    r.sim.setPresent(false);
    r.advance(1.2);
    expect(r.game.state.phase).toBe('paused');
    r.sim.setPresent(true);
    r.run(inApproach, 5);
    expect(r.game.state.timeLeft).toBeGreaterThanOrEqual(COMMON.resumeLeadSec - 0.05);
    expect(r.game.state.timeLeft).toBeLessThanOrEqual(COMMON.resumeLeadSec + 0.05);
  });

  it('does not push the wall back when there was plenty of time left anyway', () => {
    const r = rig().run((x) => inApproach(x) && x.game.state.progress > 0.2);
    r.sim.setPresent(false);
    r.advance(1.3);
    const frozen = r.game.state.timeLeft;
    r.sim.setPresent(true);
    r.run(inApproach, 5);
    expect(r.game.state.timeLeft).toBeCloseTo(frozen, 1);
  });

  it('moves on to another wall, at no cost, if the same wall arrives unseen a second time', () => {
    // 有的姿势可能恰好让识别跟丢人。不能让游戏永远卡在这一面墙上
    const r = rig().run((x) => inApproach(x) && x.game.state.timeLeft < 0.6);
    const first = r.game.state.wallIndex;
    r.sim.setPresent(false);
    r.advance(1.8);
    r.sim.setPresent(true);
    r.run(inApproach, 5);
    r.run((x) => x.game.state.timeLeft < 0.6, 10);
    r.sim.setPresent(false);
    r.advance(1.8);

    expect(r.count('skip')).toBe(1);
    expect(r.count('outcome')).toBe(0);
    expect(r.game.state.wallIndex).toBe(first + 1);
    expect(r.game.state.lives).toBe(3);
  });

  it('resuming from a manual pause late in the approach leaves time to get back into the pose', () => {
    // 按了暂停（或者打开了设置、切走了标签页），回来点"继续"时墙就在眼前：和"人回来了"一样，先让墙退回去一段
    const r = rig().run((x) => inApproach(x) && x.game.state.timeLeft < 0.3);
    r.game.setPaused(true);
    r.advance(2);
    r.game.setPaused(false);
    expect(r.game.state.timeLeft).toBeGreaterThanOrEqual(COMMON.resumeLeadSec - 0.01);
    expect(r.game.state.timeLeft).toBeLessThanOrEqual(COMMON.resumeLeadSec + 0.01);
    r.run((x) => x.count('outcome') === 1);
    expect(outcomes(r)[0].outcome.kind).toBe('pass');
  });

  it('after a manual pause it judges what the player does now, not what it saw before the pause', () => {
    // 暂停前摆对了，墙只差 0.08 秒就到；继续时人已经放下了手。不能凭暂停前那几帧就算他过
    const r = rig().run((x) => inApproach(x) && x.game.state.timeLeft < 0.08);
    r.game.setPaused(true);
    r.sim.setPose(STAND, {}, 0);
    r.advance(1);
    r.game.setPaused(false);
    r.run((x) => x.count('outcome') === 1);
    expect(outcomes(r)[0].outcome.kind).toBe('hit');
  });

  it('pausing and resuming with plenty of time left changes nothing', () => {
    const r = rig().run((x) => inApproach(x) && x.game.state.progress > 0.2);
    const left = r.game.state.timeLeft;
    r.game.setPaused(true);
    r.advance(1);
    r.game.setPaused(false);
    expect(r.game.state.timeLeft).toBe(left);
    r.game.setPaused(false); // 没暂停时再"继续"一次：什么也不发生
    expect(r.game.state.timeLeft).toBe(left);
  });

  it('a wall that was skipped does not count toward the level and brings no points', () => {
    // 每面墙都躲出画面、暂停了再回来的人，不该一路升关、白拿升关的奖励分
    const r = rig({ policy: lazy }).run((x) => x.count('wall') === 1);
    for (let i = 0; i < 60 * 80; i++) {
      r.sim.setPresent(r.game.state.phase === 'paused'); // 墙一来就躲开，暂停了就回来
      r.advance(STEP);
    }
    expect(r.count('skip')).toBeGreaterThan(3);
    expect(r.count('outcome')).toBe(0);
    expect(r.count('levelup')).toBe(0);
    expect(r.game.state).toMatchObject({ score: 0, level: 1, lives: 3 });
    expect(r.game.state.wallInLevel).toBeLessThanOrEqual(1);
  });

  it('does not count it as a hit when the player is there but too little of them can be seen to judge', () => {
    // 头和肩看得见，胳膊和腿都看不清（比如贴得太近）。没法判，就不能判撞——和"没看到人"一样，停下来等
    const r = rig().run((x) => inApproach(x) && x.game.state.timeLeft < 0.6);
    const body = r.tracker.state.body!;
    const none = Object.fromEntries(Object.keys(body.ok).map((j) => [j, false])) as typeof body.ok;
    const headOnly = { ...body, ok: { ...none, head: true, neck: true, shoulderL: true, shoulderR: true } };

    r.log.push(...r.game.update(STEP, headOnly));
    expect(r.game.state.live?.hint).toContain('看不清');
    for (let i = 0; i < 150; i++) r.log.push(...r.game.update(STEP, headOnly));
    expect(r.count('outcome')).toBe(0);
    expect(r.game.state.lives).toBe(3);
    expect(r.game.state.phase).toBe('paused');

    // 还是只看得见头：不算"人回来了"
    for (let i = 0; i < 120; i++) r.log.push(...r.game.update(STEP, headOnly));
    expect(r.game.state.phase).toBe('paused');
    // 手脚都进画面了：接着来
    r.run(inApproach, 5);
    expect(r.game.state.phase).toBe('approach');
  });

  it('tells a full-body player whose feet have left the frame to step back', () => {
    const r = rig().run((x) => inApproach(x) && x.game.state.progress > 0.2);
    const body = r.tracker.state.body!;
    expect(r.game.state.live?.hint ?? '').not.toContain('退回原位');
    const noFeet = { ...body, ok: { ...body.ok, kneeL: false, kneeR: false, ankleL: false, ankleR: false, toeL: false, toeR: false } };
    r.game.update(STEP, noFeet);
    expect(r.game.state.live?.hint).toContain('退回原位');
  });

  it('never lets one long frame teleport the wall', () => {
    const r = rig().run((x) => inApproach(x) && x.game.state.progress > 0.2);
    const before = r.game.state.progress;
    r.game.update(5, r.tracker.state.body); // 标签页切走 5 秒后回来
    const after = r.game.state.progress;
    expect(after - before).toBeLessThanOrEqual(COMMON.maxDtSec / r.game.state.wall!.spec.approachSec + 1e-9);
    expect(r.game.state.phase).toBe('approach');
  });

  it('does nothing while manually paused', () => {
    const r = rig().run((x) => inApproach(x) && x.game.state.progress > 0.2);
    const before = r.game.state;
    r.game.setPaused(true);
    for (let i = 0; i < 300; i++) expect(r.game.update(STEP, r.tracker.state.body)).toEqual([]);
    expect(r.game.state.progress).toBe(before.progress);
    expect(r.game.state.phase).toBe('approach');
    r.game.setPaused(false);
    r.advance(0.5);
    expect(r.game.state.progress).toBeGreaterThan(before.progress);
  });

  it('replays identically for the same seed and the same play', () => {
    const sig = (r: Rig) => r.log.map((e) => (e.type === 'wall' ? `wall:${(e.wall.spec.pose ?? e.wall.spec.shape)!.id}@${e.wall.spec.holeX.toFixed(2)}` : e.type === 'outcome' ? `out:${e.outcome.kind}:${e.gained}` : e.type));
    const a = sig(rig({ seed: 21 }).run((x) => x.count('outcome') === 8));
    const b = sig(rig({ seed: 21 }).run((x) => x.count('outcome') === 8));
    const c = sig(rig({ seed: 22 }).run((x) => x.count('outcome') === 8));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('keeps going through shapes and sidesteps in later levels', () => {
    const r = rig({ seed: 3, noise: 0.004 }).run((x) => x.count('outcome') === 34, 400);
    const outs = outcomes(r);
    expect(outs.filter((o) => o.outcome.kind === 'hit').map((o) => `${(o.wall.spec.pose ?? o.wall.spec.shape)!.id} ${JSON.stringify(o.outcome)}`)).toEqual([]);
    expect(outs.some((o) => o.wall.spec.kind === 'shape')).toBe(true);
    expect(r.game.state.level).toBeGreaterThanOrEqual(5);
    expect(r.game.state.lives).toBe(3);
  });

  it('a player who gets every wall right never loses a life — at every difficulty, with camera-like jitter', () => {
    // 模拟玩家每面墙都照着摆，关键点带着和真实识别差不多的抖动。这样还掉命，就是哪面墙自己出得太苛刻
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      for (const seed of [3, 11]) {
        const r = rig({ seed, difficulty }).run((x) => x.count('outcome') === 34, 400);
        const misses = outcomes(r)
          .filter((o) => o.outcome.kind === 'hit')
          .map((o) => `${(o.wall.spec.pose ?? o.wall.spec.shape)!.id} at level ${o.wall.spec.level}: ${JSON.stringify(o.outcome)}`);
        expect(misses, `${difficulty}, seed ${seed}`).toEqual([]);
        expect(r.count('skip'), `${difficulty}, seed ${seed}`).toBe(0);
      }
    }
    // 六整局、两百多面墙，是全套测试里最费时间的一个；和别的测试文件一起跑时要几秒钟，给足时限
  }, 60_000);

  it('uses the pose pool it is given', () => {
    const pool = { poses: [getPose('a')!, getPose('flex')!, getPose('hips')!], shapes: [] };
    const r = rig({ pool }).run((x) => x.count('wall') === 8);
    for (const e of r.log) if (e.type === 'wall') expect(['a', 'flex', 'hips']).toContain(e.wall.spec.pose!.id);
  });
});

describe('WallGame.recalibrate (the recogniser restarted mid-round: carry on with a fresh calibration)', () => {
  const ctxOf = (r: Rig, mode: 'full' | 'upper' = 'full') => ({ profile: r.tracker.state.profile, mode, view: r.tracker.state.body!.view });

  it('drops the wall in flight, counts down again, and keeps score, lives, combo and level', () => {
    const r = rig().run((x) => x.count('outcome') === 2);
    r.run((x) => inApproach(x) && x.game.state.progress > 0.3);
    const before = r.game.state;
    const mark = r.log.length;

    r.game.recalibrate(ctxOf(r));
    expect(r.game.state.phase).toBe('countdown');
    r.run((x) => x.log.slice(mark).some((e) => e.type === 'wall'), 10);

    expect(r.log.slice(mark).map((e) => (e.type === 'countdown' ? `countdown ${e.n}` : e.type))).toEqual(['skip', 'countdown 3', 'countdown 2', 'countdown 1', 'wall']);
    const after = r.game.state;
    expect(after.score).toBe(before.score);
    expect(after.lives).toBe(before.lives);
    expect(after.combo).toBe(before.combo);
    expect(after.level).toBe(before.level);
    expect(after.wallIndex).toBe(before.wallIndex + 1);
    expect(after.score).toBeGreaterThan(0);
  });

  it('uses the new calibration for the walls that follow', () => {
    // 比如换了个摄像头，只照得到上半身了：之后的墙都得是坐着也能做的
    const r = rig().run((x) => inApproach(x) && x.game.state.progress > 0.3);
    const mark = r.log.length;
    r.game.recalibrate(ctxOf(r, 'upper'));
    r.run((x) => x.log.slice(mark).filter((e) => e.type === 'wall').length === 14, 200);
    for (const e of r.log.slice(mark)) {
      if (e.type === 'wall') expect((e.wall.spec.pose ?? e.wall.spec.shape)!.upperOk, e.wall.label).toBe(true);
    }
  });

  it('works from a pause too, and the game is no longer waiting for the player', () => {
    const r = rig().run((x) => inApproach(x) && x.game.state.progress > 0.3);
    r.sim.setPresent(false);
    r.advance(1.3);
    expect(r.game.state.phase).toBe('paused');
    r.sim.setPresent(true);
    r.advance(0.1);
    r.game.recalibrate(ctxOf(r));
    expect(r.game.state.phase).toBe('countdown');
  });

  it('does not hand back a life: a third hit that was still playing out ends the game', () => {
    const r = rig({ policy: lazy }).run((x) => x.game.state.lives === 0 && x.game.state.phase === 'resolve');
    r.game.recalibrate(ctxOf(r));
    r.advance(0.2);
    expect(r.game.state.phase).toBe('over');
    expect(r.count('over')).toBe(1);
  });

  it('still pays the level-up when the wall just judged was the last of its level', () => {
    const r = rig().run((x) => x.game.state.phase === 'resolve' && x.game.state.wallInLevel === x.game.state.wallsInLevel);
    const { score, level } = r.game.state;
    const walls = r.count('wall');
    r.game.recalibrate(ctxOf(r));
    r.run((x) => x.count('wall') > walls, 10);
    expect(r.count('levelup')).toBe(1);
    expect(r.game.state.level).toBe(level + 1);
    expect(r.game.state.score).toBe(score + COMMON.levelBonus * (level + 1));
    expect(r.game.state.wallInLevel).toBe(1);
  });

  it('before the start or after the end it changes nothing', () => {
    const fresh = new WallGame({ seed: 1, difficulty: 'normal' });
    const r = rig();
    fresh.recalibrate(ctxOf(r));
    expect(fresh.state.phase).toBe('idle');
    expect(fresh.update(STEP, null)).toEqual([]);

    const over = rig({ policy: lazy }).run((x) => x.game.state.phase === 'over');
    over.game.recalibrate(ctxOf(over));
    expect(over.game.state.phase).toBe('over');
  });
});

describe('WallGame assist (snap to the hole when you got it right)', () => {
  it('is off while the wall is far away', () => {
    const r = rig().run((x) => inApproach(x) && x.game.state.progress > 0.5);
    expect(r.game.state.timeLeft).toBeGreaterThan(COMMON.assistSec);
    expect(r.game.assist()).toBeNull();
  });

  it('pulls a correct pose onto the target in the last moments', () => {
    const r = rig().run((x) => inApproach(x) && x.game.state.timeLeft < 0.2);
    const a = r.game.assist()!;
    expect(a.k).toBeGreaterThan(0.3);
    expect(a.k).toBeLessThanOrEqual(1);
    expect(a.target).toBe(r.game.state.wall!.target);

    r.run((x) => x.game.state.phase === 'resolve');
    expect(r.game.assist()!.k).toBe(1); // 穿过去的那一下保持在正中姿势
    r.advance(0.9);
    expect(r.game.assist()).toBeNull(); // 之后放手，回到真实动作
  });

  it('never helps a wrong pose', () => {
    const r = rig({ policy: lazy }).run((x) => inApproach(x) && x.game.state.timeLeft < 0.2);
    expect(r.game.assist()).toBeNull();
    r.run((x) => x.game.state.phase === 'resolve');
    expect(r.game.assist()).toBeNull();
  });
});
