import { describe, expect, it } from 'vitest';
import { mirrorPose, poseToSkeleton } from '../../engine/body/pose';
import { defaultProfile, scaleProfile } from '../../engine/body/profile';
import { SimPoseSource } from '../../engine/input/simSource';
import { PlayerTracker } from '../../engine/player/playerTracker';
import { LaneSplit } from '../../engine/tracking/lanes';
import { buildWall, type BuiltWall } from './build';
import { duoArmAngle } from './duo';
import { WallGame, type GameEvent } from './game';
import { DUO_BOUNDS, sampleField, WALL_BOUNDS } from './field';
import { duoPose, getPose, STAND } from './poses';
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

function rig(
  opts: { seed?: number; difficulty?: Difficulty; policy?: Policy; noise?: number; pool?: ConstructorParameters<typeof WallGame>[0]['pool']; startLevel?: number; mode?: 'full' | 'upper' } = {},
): Rig {
  const sim = new SimPoseSource({ seed: 5, noise: opts.noise ?? 0.008 });
  const tracker = new PlayerTracker();
  for (let i = 0; i < 40; i++) tracker.ingest(sim.step(1000 / 30)); // 先站一会儿：量身材
  tracker.calibrate();
  if (opts.mode) tracker.setMode(opts.mode);
  const game = new WallGame({ seed: opts.seed ?? 7, difficulty: opts.difficulty ?? 'normal', pool: opts.pool, startLevel: opts.startLevel });
  game.start({ profile: tracker.state.profile, mode: opts.mode ?? 'full', view: tracker.state.body!.view });

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
    const wall = buildWall({ index: 1, level: 1, kind: 'pose', pose: getPose('t')!, holeX: 0.3, approachSec: 6.5, angleTol: 32, fresh: true }, profile, TUNING.normal);
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
    const wall = buildWall({ index: 9, level: 4, kind: 'shape', shape, holeX: -0.2, approachSec: 5, angleTol: 30, fresh: true }, profile, TUNING.normal);
    expect(wall.label).toBe('矮门');
    expect(wall.target.hipC.x).toBeCloseTo(-0.2);
    expect(wall.target.hipC.y).toBeLessThan(0.6); // 示范姿势是蹲着的
    expect(sampleField(wall.field, -0.2, 0.5)).toBeLessThan(0);
    expect(sampleField(wall.field, -0.2, 1.6)).toBeGreaterThan(0);
  });

  it('makes a snugger hole on harder settings', () => {
    const spec = { index: 1, level: 1, kind: 'pose' as const, pose: STAND, holeX: 0, approachSec: 6, angleTol: 32, fresh: true };
    const probeX = profile.shoulderW / 2 + profile.r.shoulder + 0.1; // 肩膀外侧 10 厘米
    expect(sampleField(buildWall(spec, profile, TUNING.easy).field, probeX, 1.32)).toBeLessThan(0);
    expect(sampleField(buildWall(spec, profile, TUNING.hard).field, probeX, 1.32)).toBeGreaterThan(0);
  });

  it('a single-player wall has one name plate, over its hole', () => {
    const wall = buildWall({ index: 1, level: 1, kind: 'pose', pose: getPose('t')!, holeX: 0.3, approachSec: 6.5, angleTol: 32, fresh: true }, profile, TUNING.normal);
    expect(wall.labels).toEqual([{ text: '一字平举', x: 0.3 }]);
    expect(wall.field.bounds).toEqual(WALL_BOUNDS);
    expect(wall.mate).toBeUndefined();
  });
});

describe('buildWall for two players', () => {
  const profile = defaultProfile();
  const kid = scaleProfile(profile, 0.7);
  const base = { index: 1, level: 3, kind: 'pose' as const, holeX: -0.75, approachSec: 6, angleTol: 32, fresh: true };
  const up = getPose('up')!;

  it('cuts two holes in one wider wall, each to its own player', () => {
    const wall = buildWall({ ...base, pose: up, mate: { pose: up, holeX: 0.75 } }, profile, TUNING.normal, kid);
    expect(wall.field.bounds).toEqual(DUO_BOUNDS);
    expect(sampleField(wall.field, -0.75, 1.0)).toBeLessThan(0); // 1 号的洞
    expect(sampleField(wall.field, 0.75, 0.7)).toBeLessThan(0); // 2 号的洞
    expect(sampleField(wall.field, 0, 1.6)).toBeGreaterThan(0); // 两人之间是墙
    expect(sampleField(wall.field, 2.45, 1.5)).toBeGreaterThan(0); // 加宽出来的那一段也是墙
    expect(wall.target.hipC.x).toBeCloseTo(-0.75);
    expect(wall.mate!.target.hipC.x).toBeCloseTo(0.75);
    // 矮个子的洞矮：大人举起的手那么高的地方，在他那边是墙
    expect(wall.mate!.target.head.y).toBeLessThan(wall.target.head.y - 0.3);
    expect(sampleField(wall.field, -0.75, wall.target.head.y)).toBeLessThan(0);
    expect(sampleField(wall.field, 0.75, wall.target.head.y)).toBeGreaterThan(0);
  });

  it('both doing the same pose: one name, and the hint says "together"', () => {
    const wall = buildWall({ ...base, pose: up, mate: { pose: up, holeX: 0.75 } }, profile, TUNING.normal, profile);
    expect(wall.label).toBe('顶天立地');
    expect(wall.say).toBe('两个人一起：双手举过头顶');
    expect(wall.labels).toEqual([
      { text: '顶天立地', x: -0.75 },
      { text: '顶天立地', x: 0.75 },
    ]);
  });

  it('mirrored halves of one pose count as the same pose', () => {
    const disco = getPose('disco')!;
    const wall = buildWall({ ...base, pose: disco, mate: { pose: mirrorPose(disco), holeX: 0.75 } }, profile, TUNING.normal, profile);
    expect(wall.label).toBe('指天指地');
    expect(wall.say).toBe('两个人一起：一只手指天，一只手指地');
  });

  it('different poses are announced left and right', () => {
    const wall = buildWall({ ...base, pose: getPose('low')!, mate: { pose: up, holeX: 0.75 } }, profile, TUNING.normal, profile);
    expect(wall.label).toBe('左 小矮人 · 右 顶天立地');
    expect(wall.say).toBe('左边小矮人，右边顶天立地');
    expect(wall.labels.map((l) => l.text)).toEqual(['小矮人', '顶天立地']);
  });

  it('holding hands keeps its own name and line, and the two holes join where the hands meet', () => {
    const a = duoPose('hold-hands', -1, duoArmAngle('hold-hands', profile, 0.6));
    const b = duoPose('hold-hands', 1, duoArmAngle('hold-hands', profile, 0.6));
    const wall = buildWall({ ...base, level: 1, pose: a, holeX: -0.6, mate: { pose: b, holeX: 0.6 }, duo: 'hold-hands' }, profile, TUNING.normal, profile);
    expect(wall.label).toBe('手拉手');
    expect(wall.say).toBe('两个人手拉手');
    expect(wall.labels).toEqual([{ text: '手拉手', x: 0 }]); // 两个洞连成了一个，名牌也只挂一块，在正中
    expect(sampleField(wall.field, 0, wall.target.handR.y)).toBeLessThan(0); // 两只手之间没有墙
    expect(sampleField(wall.field, 0, 2.0)).toBeGreaterThan(0); // 头顶上方还是墙
    expect(wall.outlines.length).toBeGreaterThan(0);
  });

  it('two geometric holes side by side', () => {
    const door = getShape('low-door')!;
    const wall = buildWall({ ...base, kind: 'shape', shape: door, mate: { shape: door, holeX: 0.75 } }, profile, TUNING.normal, profile);
    expect(sampleField(wall.field, -0.75, 0.5)).toBeLessThan(0);
    expect(sampleField(wall.field, 0.75, 0.5)).toBeLessThan(0);
    expect(sampleField(wall.field, 0, 1.6)).toBeGreaterThan(0);
    expect(wall.label).toBe('矮门');
    expect(wall.say).toBe('两个人一起：门很矮，蹲下来');
    expect(wall.mate!.target.hipC.y).toBeLessThan(0.6);
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
    expect(r.game.state).toMatchObject({ phase: 'approach', wallIndex: 1, wallInLevel: 1, wallsInLevel: 3, level: 1 });
    expect(r.game.state.wall!.spec.pose!.id).toBe('t');
    expect(r.game.state.timeLeft).toBeCloseTo(6.5, 1);
  });

  it('ticks down the last three seconds of each wall', () => {
    const r = rig().run((x) => x.count('outcome') === 1);
    expect(r.log.filter((e) => e.type === 'tick').map((e) => (e as { n: number }).n)).toEqual([3, 2, 1]);
  });

  it('a player who matches every wall sails through two levels', () => {
    const r = rig().run((x) => x.count('outcome') === 7);
    const outs = outcomes(r);
    expect(outs.map((o) => o.outcome.kind)).toEqual(Array(7).fill('pass'));
    expect(r.game.state.lives).toBe(3);
    expect(r.game.state.score).toBeGreaterThan(7 * 100);
    expect(r.game.state.combo).toBe(7);
    expect(r.count('life')).toBe(0); // 满命过关，没有命可回

    // 第 3 面墙过完才升到第 2 关；庆祝完、预告过下一关，才出第 4 面墙
    const order = r.log.filter((e) => e.type === 'outcome' || e.type === 'levelup' || e.type === 'levelintro' || e.type === 'wall').map((e) => e.type);
    expect(order.slice(4, 9)).toEqual(['wall', 'outcome', 'levelup', 'levelintro', 'wall']);
    expect(r.log.find((e) => e.type === 'levelup')).toEqual({ type: 'levelup', level: 2, cleared: 1 });
    expect(r.log.find((e) => e.type === 'levelintro')).toEqual({ type: 'levelintro', level: 2, theme: '双脚打开' });
    expect(r.count('levelup')).toBe(2);
    expect(r.game.state.level).toBe(3);
  });

  it('pauses three seconds to celebrate a cleared level, announcing the next one part-way through', () => {
    const r = rig().run((x) => x.count('levelup') === 1);
    expect(r.game.state.phase).toBe('levelup');
    r.advance(COMMON.levelIntroAtSec - 0.1);
    expect(r.count('levelintro')).toBe(0);
    r.advance(0.2);
    expect(r.count('levelintro')).toBe(1);
    r.advance(COMMON.levelUpSec - COMMON.levelIntroAtSec - 0.3);
    expect(r.game.state.phase).toBe('levelup');
    r.advance(0.4);
    expect(r.game.state.phase).toBe('approach');
    expect(COMMON.levelUpSec).toBe(3);
  });

  it('does not name a theme when practising a single wall either (every wall is that one wall)', () => {
    const r = rig({ pool: { poses: [getPose('hips')!], shapes: [] } }).run((x) => x.count('levelintro') === 1);
    expect(r.log.find((e) => e.type === 'levelintro')).toEqual({ type: 'levelintro', level: 2, theme: null });
  });

  it('does not name the theme of the next level in upper-body play (the walls will not match it)', () => {
    const r = rig({ mode: 'upper' }).run((x) => x.count('levelintro') === 1);
    expect(r.log.find((e) => e.type === 'levelintro')).toEqual({ type: 'levelintro', level: 2, theme: null });
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
    expect(r.log.filter((e) => e.type === 'life')).toEqual([2, 1, 0].map((lives) => ({ type: 'life', lives, delta: -1 })));

    const over = r.log[r.log.length - 1];
    expect(over).toEqual({ type: 'over', summary: { level: 1, walls: 0, score: 0, bestCombo: 0, stars: [0, 0, 0], seed: 7, difficulty: 'normal', cleared: false, players: 1 } });
    expect(r.count('allclear')).toBe(0);
    expect(r.game.summary).toEqual((over as Extract<GameEvent, { type: 'over' }>).summary);
    expect(r.game.update(STEP, null)).toEqual([]); // 结束后不再有任何动静
  });

  it('scores by stars with a growing combo bonus, and pays a bonus for levelling up', () => {
    const r = rig({ noise: 0.004 }).run((x) => x.count('wall') === 4);
    const outs = outcomes(r);
    expect(outs[0]).toMatchObject({ outcome: { kind: 'pass', stars: 3 }, gained: 300 });
    expect(outs[1]).toMatchObject({ outcome: { kind: 'pass', stars: 3 }, gained: 330 }); // 连击 ×1.1
    expect(outs[2].gained).toBe(360);
    const fromWalls = outs.reduce((sum, o) => sum + o.gained, 0);
    expect(r.game.state.score).toBe(fromWalls + 500 * 2);
    expect(r.game.summary).toMatchObject({ walls: 3, bestCombo: 3, stars: [0, 0, 3], level: 2 });
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

  it('a player who gets every wall right clears all fifteen levels without losing a life — at every difficulty, with camera-like jitter', () => {
    // 模拟玩家每面墙都照着摆，关键点带着和真实识别差不多的抖动。这样还掉命，就是哪面墙自己出得太苛刻
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      for (const seed of [3, 11]) {
        const r = rig({ seed, difficulty }).run((x) => x.game.state.phase === 'over', 600);
        const outs = outcomes(r);
        const misses = outs.filter((o) => o.outcome.kind === 'hit').map((o) => `${(o.wall.spec.pose ?? o.wall.spec.shape)!.id} at level ${o.wall.spec.level}: ${JSON.stringify(o.outcome)}`);
        const tag = `${difficulty}, seed ${seed}`;
        expect(misses, tag).toEqual([]);
        expect(outs, tag).toHaveLength(55);
        expect(outs.some((o) => o.wall.spec.kind === 'shape'), tag).toBe(true);
        expect(r.count('skip'), tag).toBe(0);
        expect([r.count('levelup'), r.count('levelintro'), r.count('allclear'), r.count('over')], tag).toEqual([14, 14, 1, 1]);
        expect(r.game.summary, tag).toMatchObject({ cleared: true, level: 15, walls: 55, players: 1 });
        expect(r.game.state.lives, tag).toBe(3);
      }
    }
    // 六整局、三百多面墙，是全套测试里最费时间的一个；和别的测试文件一起跑时要几秒钟，给足时限
  }, 120_000);

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

/** 第 n 面墙（从 1 数）站着不摆，其余照着摆。 */
const missing = (...which: number[]): Policy => {
  let n = 0;
  return (wall, sim) => (which.includes(++n) ? sim.setPose(STAND, {}, 0.3) : perfect(wall, sim));
};

describe('WallGame lives: one back for every level cleared', () => {
  it('hands a life back when a level is cleared, and says so', () => {
    const r = rig({ policy: missing(1), noise: 0.004 }).run((x) => x.count('levelup') === 1);
    expect(outcomes(r).map((o) => o.outcome.kind)).toEqual(['hit', 'pass', 'pass']);
    expect(r.game.state.lives).toBe(3);
    expect(r.log.filter((e) => e.type === 'life')).toEqual([
      { type: 'life', lives: 2, delta: -1 },
      { type: 'life', lives: 3, delta: 1 },
    ]);
    // 先发"过关"，再发"回了一条命"
    const types = r.log.map((e) => e.type);
    expect(types.lastIndexOf('life')).toBeGreaterThan(types.indexOf('levelup'));
  });

  it('never goes above three lives', () => {
    const r = rig({ noise: 0.004 }).run((x) => x.count('levelup') === 3);
    expect(r.game.state.lives).toBe(COMMON.lives);
    expect(r.count('life')).toBe(0);
  });

  it('gives back only one life per level', () => {
    const r = rig({ policy: missing(1, 2), noise: 0.004 }).run((x) => x.count('levelup') === 1);
    expect(r.game.state.lives).toBe(2);
  });
});

describe('WallGame: clearing all fifteen levels', () => {
  const lastLevel = (policy?: Policy) => rig({ startLevel: 15, policy, noise: 0.004 });

  it('can start at a later level', () => {
    const r = lastLevel().run((x) => x.count('wall') === 1);
    expect(r.game.state).toMatchObject({ level: 15, wallInLevel: 1, wallsInLevel: 4 });
  });

  it('after the last wall of level 15 it is "all clear": a ten-second show, then the round is over', () => {
    const r = lastLevel().run((x) => x.count('allclear') === 1);
    expect(outcomes(r)).toHaveLength(4);
    expect(r.game.state.phase).toBe('finale');
    expect(r.count('levelup')).toBe(0); // 没有第 16 关可升
    const clear = r.log.find((e) => e.type === 'allclear') as Extract<GameEvent, { type: 'allclear' }>;
    expect(clear.summary).toMatchObject({ cleared: true, level: 15, walls: 4, players: 1 });

    r.advance(COMMON.finaleSec - 0.5);
    expect(r.game.state.phase).toBe('finale');
    expect(r.count('over')).toBe(0);
    r.advance(1);
    expect(r.game.state.phase).toBe('over');
    expect(r.log[r.log.length - 1]).toEqual({ type: 'over', summary: clear.summary });
    expect(COMMON.finaleSec).toBe(10);
  });

  it('still counts as all clear when the very last wall knocks you in, as long as a life is left', () => {
    const r = lastLevel(missing(4)).run((x) => x.game.state.phase === 'over', 120);
    expect(outcomes(r).map((o) => o.outcome.kind)).toEqual(['pass', 'pass', 'pass', 'hit']);
    expect(r.count('allclear')).toBe(1);
    expect(r.game.summary).toMatchObject({ cleared: true, walls: 3 });
  });

  it('is not all clear when the last wall takes the last life', () => {
    const r = lastLevel(missing(2, 3, 4)).run((x) => x.game.state.phase === 'over', 120);
    expect(r.game.state.lives).toBe(0);
    expect(r.count('allclear')).toBe(0);
    expect(r.game.summary).toMatchObject({ cleared: false, level: 15 });
  });
});

describe('WallGame.retryLevel (out of lives: have another go at the level you fell on)', () => {
  /** 前两关照着摆，到第 3 关就站着不动，直到没命。记下第 3 关开始时的分数。 */
  function fallOnLevel3(): { r: Rig; scoreAt3: number } {
    let scoreAt3 = -1;
    let r!: Rig;
    const policy: Policy = (wall, sim) => {
      if (wall.spec.level < 3) return perfect(wall, sim);
      if (scoreAt3 < 0) scoreAt3 = r.game.state.score;
      sim.setPose(STAND, {}, 0.3);
    };
    r = rig({ policy, noise: 0.004 });
    r.run((x) => x.game.state.phase === 'over', 200);
    return { r, scoreAt3 };
  }

  it('puts you back at the start of that level with three lives and the score you had then', () => {
    const { r, scoreAt3 } = fallOnLevel3();
    expect(r.game.summary).toMatchObject({ level: 3, cleared: false, walls: 6 });
    expect(scoreAt3).toBeGreaterThan(0);

    expect(r.game.retryLevel()).toBe(true);
    expect(r.game.state).toMatchObject({ phase: 'countdown', lives: 3, score: scoreAt3, level: 3, combo: 0, wallInLevel: 0 });
    expect(r.game.summary).toMatchObject({ walls: 6, stars: [0, 0, 6], bestCombo: 6 });
  });

  it('then plays on from there', () => {
    const { r } = fallOnLevel3();
    r.game.retryLevel();
    const mark = r.log.length;
    r.run((x) => x.log.slice(mark).some((e) => e.type === 'wall'), 10);
    expect(r.log.slice(mark).map((e) => (e.type === 'countdown' ? `c${e.n}` : e.type))).toEqual(['c3', 'c2', 'c1', 'wall']);
    expect(r.game.state).toMatchObject({ level: 3, wallInLevel: 1, phase: 'approach' });
  });

  it('a second click does nothing', () => {
    const { r, scoreAt3 } = fallOnLevel3();
    expect(r.game.retryLevel()).toBe(true);
    expect(r.game.retryLevel()).toBe(false);
    expect(r.game.state).toMatchObject({ phase: 'countdown', lives: 3, score: scoreAt3 });
  });

  it('is refused while the round is still going, and before it starts', () => {
    const r = rig().run((x) => x.count('outcome') === 1);
    expect(r.game.retryLevel()).toBe(false);
    expect(r.game.state.lives).toBe(3);
    expect(new WallGame({ seed: 1, difficulty: 'normal' }).retryLevel()).toBe(false);
  });

  it('is refused once everything has been cleared', () => {
    const r = rig({ startLevel: 15, noise: 0.004 }).run((x) => x.game.state.phase === 'over', 120);
    expect(r.game.summary.cleared).toBe(true);
    expect(r.game.retryLevel()).toBe(false);
    expect(r.game.state.phase).toBe('over');
  });
});

// ---------------------------------------------------------------- 双人

/** 0 号（左边那位）照着摆。 */
const leftDoes: Policy = (wall, sim) => sim.setPose(wall.spec.pose ?? wall.spec.shape!.demo, { x: wall.spec.holeX }, 0.4, 0);
/** 1 号（右边那位）照着摆。 */
const rightDoes: Policy = (wall, sim) => sim.setPose(wall.spec.mate!.pose ?? wall.spec.mate!.shape!.demo, { x: wall.spec.mate!.holeX }, 0.4, 1);
const bothDo: Policy = (wall, sim) => {
  leftDoes(wall, sim);
  rightDoes(wall, sim);
};

/** 两个模拟玩家隔 1.5 米并排站，两条泳道各一个追踪器，各自标定到 ∓0.75。 */
function duoRig(opts: { seed?: number; difficulty?: Difficulty; policy?: Policy; noise?: number; startLevel?: number } = {}): Rig & { mate: PlayerTracker } {
  const sim = new SimPoseSource({ seed: 5, noise: opts.noise ?? 0.008, people: 2 });
  const split = new LaneSplit();
  const tracker = new PlayerTracker();
  const mate = new PlayerTracker();
  tracker.setLane({ side: 'left', split });
  mate.setLane({ side: 'right', split });
  const feed = (): void => {
    const f = sim.step(1000 / 30);
    split.observe(f);
    tracker.ingest(f);
    mate.ingest(f);
  };
  for (let i = 0; i < 40; i++) feed();
  const view = tracker.calibrate({ x: -0.75 });
  const mateView = mate.calibrate({ x: 0.75 });
  for (let i = 0; i < 4; i++) feed();
  const game = new WallGame({ seed: opts.seed ?? 7, difficulty: opts.difficulty ?? 'normal', startLevel: opts.startLevel });
  game.start({ profile: tracker.state.profile, mode: 'full', view, mate: { profile: mate.state.profile, view: mateView }, gap: 1.5 });

  const policy = opts.policy ?? bothDo;
  let tick = 0;
  const self: Rig & { mate: PlayerTracker } = {
    game,
    sim,
    tracker,
    mate,
    log: [],
    run(stop, maxSec = 200) {
      for (let t = 0; t < maxSec && !stop(self); t += STEP) {
        if (tick++ % 2 === 0) feed();
        for (const e of game.update(STEP, tracker.state.body, mate.state.body)) {
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

describe('WallGame for two players', () => {
  it('sends walls with a hole for each player, where each of them stands', () => {
    const r = duoRig().run((x) => x.count('wall') === 1);
    const wall = r.game.state.wall!;
    expect(wall.spec.mate).toBeDefined();
    expect(wall.spec.holeX).toBeCloseTo(-0.75, 1);
    expect(wall.spec.mate!.holeX).toBeCloseTo(0.75, 1);
    expect(wall.target.hipC.x).toBeCloseTo(-0.75, 1);
    expect(wall.mate!.target.hipC.x).toBeCloseTo(0.75, 1);
    expect(wall.spec.duo).toBe('hold-hands'); // 隔 1.5 米摆不下两个 T 字，用手拉手开场
  });

  it('two players who both match every wall clear all fifteen levels together — at every difficulty, with camera-like jitter', () => {
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      const r = duoRig({ seed: 3, difficulty }).run((x) => x.game.state.phase === 'over', 600);
      const outs = outcomes(r);
      const name = (o: (typeof outs)[number]): string => `${(o.wall.spec.pose ?? o.wall.spec.shape)!.id}+${(o.wall.spec.mate!.pose ?? o.wall.spec.mate!.shape)!.id}`;
      const misses = outs.filter((o) => o.outcome.kind === 'hit').map((o) => `${name(o)} at level ${o.wall.spec.level}: ${JSON.stringify(o.outcome)}`);
      expect(misses, difficulty).toEqual([]);
      expect(outs, difficulty).toHaveLength(55);
      expect([r.count('skip'), r.count('allclear'), r.count('over')], difficulty).toEqual([0, 1, 1]);
      expect(r.game.summary, difficulty).toMatchObject({ cleared: true, level: 15, walls: 55, players: 2 });
      expect(r.game.state.lives, difficulty).toBe(3);
    }
  }, 120_000);

  it('both must pass: when only the player on the right gets it wrong it is a hit, it says who, and it costs one life', () => {
    const r = duoRig({ policy: leftDoes, noise: 0.004 }).run((x) => x.count('outcome') === 1);
    const out = outcomes(r)[0].outcome;
    expect(out.kind).toBe('hit');
    expect(out.each!.map((o) => o.kind)).toEqual(['pass', 'hit']);
    expect(out.kind === 'hit' ? out.reason : '').toMatch(/^右边：/);
    expect(out.kind === 'hit' ? out.badParts : null).toEqual([]);
    expect(r.game.state.lives).toBe(2);
    expect(r.log.filter((e) => e.type === 'life')).toEqual([{ type: 'life', lives: 2, delta: -1 }]);
  });

  it('…and the other way round', () => {
    const r = duoRig({ policy: rightDoes, noise: 0.004 }).run((x) => x.count('outcome') === 1);
    const out = outcomes(r)[0].outcome;
    expect(out.each!.map((o) => o.kind)).toEqual(['hit', 'pass']);
    expect(out.kind === 'hit' ? out.reason : '').toMatch(/^左边：/);
    expect(out.kind === 'hit' ? out.badParts.length : 0).toBeGreaterThan(0);
  });

  it('when both get it wrong it names both and still costs just one life', () => {
    const r = duoRig({ policy: lazy }).run((x) => x.count('outcome') === 1);
    const out = outcomes(r)[0].outcome;
    expect(out.kind === 'hit' ? out.reason : '').toMatch(/^左边：.+；右边：.+/);
    expect(r.game.state.lives).toBe(2);
  });

  it('three such walls and the round is over for both', () => {
    const r = duoRig({ policy: leftDoes, noise: 0.004 }).run((x) => x.game.state.phase === 'over');
    expect(outcomes(r)).toHaveLength(3);
    expect(r.game.summary).toMatchObject({ cleared: false, players: 2, walls: 0 });
  });

  it('shows who is off while the wall approaches', () => {
    const midway = (x: Rig): boolean => inApproach(x) && x.game.state.progress > 0.6;
    const good = duoRig().run(midway).game.state.live!;
    expect(good).toMatchObject({ ok: true, hint: '', badParts: [] });
    expect(good.mate).toMatchObject({ ok: true, badParts: [] });

    const rightOff = duoRig({ policy: leftDoes }).run(midway).game.state.live!;
    expect(rightOff.ok).toBe(false);
    expect(rightOff.hint).toMatch(/^右边：/);
    expect(rightOff.badParts).toEqual([]); // 1 号没问题，他身上不变红
    expect(rightOff.mate!.ok).toBe(false);
    expect(rightOff.mate!.badParts.length).toBeGreaterThan(0);
    expect(rightOff.accuracy).toBeLessThan(good.accuracy); // 契合度显示两人里较低的

    const leftOff = duoRig({ policy: rightDoes }).run(midway).game.state.live!;
    expect(leftOff.hint).toMatch(/^左边：/);
    expect(leftOff.badParts.length).toBeGreaterThan(0);
    expect(leftOff.mate!.ok).toBe(true);
  });

  it('pauses when either of them walks out of view, takes no life, and carries on when both are back', () => {
    const r = duoRig().run((x) => inApproach(x) && x.game.state.progress > 0.3);
    r.sim.setPresent(false, 1);
    r.advance(1.3);
    expect(r.game.state.phase).toBe('paused');
    expect(r.game.state.lives).toBe(3);
    r.advance(3); // 只有一位在，就一直等
    expect(r.game.state.phase).toBe('paused');
    r.sim.setPresent(true, 1);
    r.run(inApproach, 5);
    expect(r.game.state.phase).toBe('approach');
    r.run((x) => x.count('outcome') === 1, 20);
    expect(outcomes(r)[0].outcome.kind).toBe('pass');
    expect(r.count('life')).toBe(0);
  });

  it('snaps onto the hole only when both are right, and afterwards only the one who got through', () => {
    const close = (x: Rig): boolean => inApproach(x) && x.game.state.timeLeft < 0.2;
    const ok = duoRig({ noise: 0.004 }).run(close);
    expect(ok.game.assist(0)!.target.hipC.x).toBeLessThan(0);
    expect(ok.game.assist(1)!.target.hipC.x).toBeGreaterThan(0);

    const half = duoRig({ policy: leftDoes, noise: 0.004 }).run(close);
    expect(half.game.assist(0)).toBeNull(); // 墙还没到：有一位不对，两位都不吸附
    expect(half.game.assist(1)).toBeNull();
    half.run((x) => x.game.state.phase === 'resolve');
    expect(half.game.assist(0)).toMatchObject({ k: 1 }); // 判完了：过了的那位照样干净地穿过去
    expect(half.game.assist(1)).toBeNull();
  });

  it('a single-player game ignores a second body handed to it', () => {
    const r = rig().run((x) => x.count('wall') === 1);
    expect(r.game.state.wall!.spec.mate).toBeUndefined();
    expect(r.game.summary.players).toBe(1);
  });
});
