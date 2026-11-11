import { describe, expect, it } from 'vitest';
import { SimPoseSource } from '../../engine/input/simSource';
import { STALE_MS, type PoseSource } from '../../engine/input/types';
import { PlayerTracker } from '../../engine/player/playerTracker';
import type { GameEvent } from './game';
import { POSES, STAND } from './poses';
import { WallSession, type SessionEngine, type SessionEvent } from './session';
import { SHAPES } from './shapes';
import { COMMON } from './tuning';

const STEP = 1 / 60;
const POOL = { poses: POSES, shapes: SHAPES };

interface Rig {
  session: WallSession;
  engine: SessionEngine & { status: 'loading' | 'ready' | 'error'; source: PoseSource | null };
  tracker: PlayerTracker;
  log: SessionEvent[];
  sim(): SimPoseSource;
  run(stop: (r: Rig) => boolean, maxSec?: number): Rig;
  advance(sec: number): Rig;
  /** 摄像头卡住：不再有新的识别结果 */
  stall(on: boolean): void;
  /** 引擎重启：追踪器清空，换一个新的姿态来源（EngineController 重启时就是这么做的） */
  restart(next?: { legs?: boolean }): void;
  count(type: SessionEvent['type']): number;
}

/**
 * kind 'camera'：把模拟玩家当成"摄像头前的真人"——会话不会替他摆姿势，由这里的 player 策略来摆。
 * kind 'sim'：演示模式，会话自己让模拟玩家照着墙摆。
 */
function rig(opts: { kind?: 'camera' | 'sim'; sim?: 'off' | 'auto' | 'wrong' | 'manual'; pool?: boolean; player?: 'perfect' | 'lazy'; speed?: number } = {}): Rig {
  const tracker = new PlayerTracker();
  let now = 0;
  let lastFrame = -Infinity;
  let tick = 0;
  let stalled = false;
  let sim: SimPoseSource;
  const plug = (seed: number, legs = true): SimPoseSource => {
    const s = new SimPoseSource({ seed, noise: 0.006, legs });
    s.onFrame((f) => {
      if (s !== sim) return;
      tracker.ingest(f);
      lastFrame = now;
    });
    return s;
  };
  sim = plug(5);

  const engine: Rig['engine'] = { status: 'ready', source: sim, kind: opts.kind ?? 'camera', tracker, sinceFrame: (t = now) => t - lastFrame };
  const session = new WallSession({ seed: 7, sim: opts.sim ?? 'off', difficulty: () => 'normal' });
  if (opts.pool !== false) session.setPool(POOL);

  const self: Rig = {
    session,
    engine,
    tracker,
    log: [],
    sim: () => sim,
    run(stop, maxSec = 120) {
      for (let t = 0; t < maxSec && !stop(self); t += STEP) {
        now += 1000 / 60;
        if (!stalled && engine.status === 'ready' && tick++ % 2 === 0) sim.step(1000 / 30); // 识别 30 Hz，画面 60 Hz
        for (const e of session.update(now, STEP, engine, opts.speed ?? 1)) {
          self.log.push(e);
          // "真人"看到新墙，照着摆
          if (e.type === 'wall' && (opts.kind ?? 'camera') === 'camera' && (opts.player ?? 'perfect') === 'perfect') {
            sim.setPose(e.wall.spec.pose ?? e.wall.spec.shape!.demo, { x: e.wall.spec.holeX }, 0.4);
          }
        }
      }
      return self;
    },
    advance(sec) {
      let left = sec;
      return self.run(() => (left -= STEP) < 0, sec + 1);
    },
    stall(on) {
      stalled = on;
    },
    restart(next = {}) {
      tracker.reset();
      lastFrame = -Infinity;
      sim = plug(6, next.legs ?? true);
      engine.source = sim;
    },
    count: (type) => self.log.filter((e) => e.type === type).length,
  };
  return self;
}

const playing = (r: Rig): boolean => r.session.stage === 'playing';
const outcomes = (r: Rig) => r.log.filter((e): e is Extract<GameEvent, { type: 'outcome' }> => e.type === 'outcome');
const begins = (r: Rig) => r.log.filter((e): e is Extract<SessionEvent, { type: 'begin' }> => e.type === 'begin');

describe('WallSession: getting a round started', () => {
  it('waits for a real player to stand still, then calibrates and starts the countdown', () => {
    const r = rig();
    expect(r.session.stage).toBe('framing');
    r.advance(0.6);
    expect(r.session.stage).toBe('framing');
    expect(r.session.framing.text).toContain('别动');
    expect(r.session.framing.progress).toBeGreaterThan(0.2);
    expect(r.session.game).toBeNull();

    r.run(playing, 5);
    expect(r.session.stage).toBe('playing');
    expect(begins(r)).toHaveLength(1);
    expect(begins(r)[0].resumed).toBe(false);
    expect(r.session.game!.state.phase).toBe('countdown');
    expect(r.tracker.state.profileReady).toBe(true); // 标定时把身材定下来了
  });

  it('does not start until it knows which walls it may draw from', () => {
    // 造型池（内置的 + 自己存的）是异步读出来的。池子不同，同一个种子出的墙也不同，所以要等它
    const r = rig({ pool: false });
    r.advance(4);
    expect(r.session.stage).toBe('framing');
    r.session.setPool(POOL);
    r.run(playing, 5);
    expect(r.session.stage).toBe('playing');
  });

  it('gives the game the visible range as measured from the spot where the player was calibrated', () => {
    const r = rig();
    r.advance(0.3); // 第一次被看到时站在一处……
    r.sim().setPose(STAND, { x: 0.4 }, 0.3); // ……开局前往旁边挪了 0.4 米
    r.run(playing, 8);
    const given = begins(r)[0].ctx.view!;
    r.advance(0.3);
    const actual = r.tracker.state.body!.view;
    expect(given.left).toBeCloseTo(actual.left, 1);
    expect(given.right).toBeCloseTo(actual.right, 1);
    expect(Math.abs(r.tracker.state.body!.root.x)).toBeLessThan(0.05); // 他现在站的地方就是原点
  });

  it('a player who is doing it right clears wall after wall', () => {
    const r = rig().run((x) => outcomes(x).length === 6, 80);
    expect(outcomes(r).map((o) => o.outcome.kind)).toEqual(Array(6).fill('pass'));
    expect(r.session.game!.state.lives).toBe(3);
  });
});

describe('WallSession: the simulated player', () => {
  it('in demo mode it starts without the stand-still wait and plays by itself', () => {
    const r = rig({ kind: 'sim' });
    r.run(playing, 4);
    expect(r.session.stage).toBe('playing');
    r.run((x) => outcomes(x).length === 5, 80);
    expect(outcomes(r).every((o) => o.outcome.kind === 'pass')).toBe(true);
  });

  it('told to get it wrong, it stands still, loses three lives, and the round is over', () => {
    const r = rig({ kind: 'sim', sim: 'wrong' }).run((x) => x.session.stage === 'over', 120);
    expect(r.session.stage).toBe('over');
    expect(r.count('over')).toBe(1);
    expect(r.session.game!.state.lives).toBe(0);
  });

  it('"again" starts a fresh round on the same calibration', () => {
    const r = rig({ kind: 'sim', sim: 'wrong' }).run((x) => x.session.stage === 'over', 120);
    const first = r.session.game;
    const calibration = r.session.ctx;
    r.session.again();
    r.advance(0.1);
    expect(r.session.stage).toBe('playing');
    expect(r.session.game).not.toBe(first);
    expect(r.session.game!.state).toMatchObject({ lives: COMMON.lives, score: 0 });
    expect(r.session.ctx).toBe(calibration);
    expect(begins(r)).toHaveLength(2);
    expect(begins(r)[1].resumed).toBe(false);
  });

  it('"again" before any round has been played does nothing', () => {
    const r = rig({ pool: false });
    r.session.again();
    r.advance(0.2);
    expect(r.session.stage).toBe('framing');
    expect(r.log).toEqual([]);
  });
});

describe('WallSession: when the picture is not trustworthy', () => {
  it('treats recognition results that have gone stale as "nobody there"', () => {
    // 摄像头卡住了：追踪器里留着的是最后一帧。不能拿它当人还在、还摆得对
    const r = rig().run((x) => x.session.game?.state.phase === 'approach' && x.session.game.state.progress > 0.3, 30);
    r.stall(true);
    r.advance(STALE_MS / 1000 + COMMON.lostPauseMs / 1000 + 0.3);
    expect(r.session.game!.state.phase).toBe('paused');
    expect(r.session.game!.state.lives).toBe(3);

    r.stall(false);
    r.run((x) => x.session.game!.state.phase === 'approach', 5);
    expect(r.session.game!.state.phase).toBe('approach');
  });

  it('nothing moves while the engine is not ready', () => {
    const r = rig().run((x) => x.session.game?.state.phase === 'approach' && x.session.game.state.progress > 0.3, 30);
    const before = r.session.game!.state.progress;
    const events = r.log.length;
    r.engine.status = 'error';
    r.engine.source = null;
    r.advance(3);
    expect(r.session.game!.state.progress).toBe(before);
    expect(r.log.length).toBe(events);
  });
});

describe('WallSession: the engine restarts in the middle of a round', () => {
  /** 打到第三面墙飞到一半，然后引擎重启。 */
  const midRound = (): Rig => {
    const r = rig().run((x) => outcomes(x).length === 2, 60);
    return r.run((x) => x.session.game!.state.phase === 'approach' && x.session.game!.state.progress > 0.3, 20);
  };

  it('goes back to the stand-still check instead of carrying on with a calibration that no longer holds', () => {
    const r = midRound();
    r.restart();
    r.advance(0.1);
    expect(r.session.stage).toBe('framing');
    expect(r.tracker.state.profileReady).toBe(false);
  });

  it('then carries on with the same round: same game, same score and lives, a fresh countdown', () => {
    const r = midRound();
    const game = r.session.game;
    const { score, lives, level, wallIndex } = game!.state;
    const mark = r.log.length;

    r.restart();
    r.advance(0.1); // 会话在下一帧才发现来源换了
    r.run(playing, 8);
    expect(r.session.game).toBe(game);
    expect(begins(r)).toHaveLength(2);
    expect(begins(r)[1].resumed).toBe(true);

    r.run((x) => x.log.slice(mark).some((e) => e.type === 'wall'), 10);
    const kinds = r.log.slice(mark).map((e) => e.type);
    expect(kinds).toEqual(['begin', 'skip', 'countdown', 'countdown', 'countdown', 'wall']);
    expect(game!.state).toMatchObject({ score, lives, level, wallIndex: wallIndex + 1 });
    expect(r.tracker.state.profileReady).toBe(true);

    // 接着玩没有问题
    r.run((x) => outcomes(x).length === 4, 40);
    expect(outcomes(r).slice(2).map((o) => o.outcome.kind)).toEqual(['pass', 'pass']);
  });

  it('time stands still for the game while the engine is loading and the player is being re-framed', () => {
    const r = midRound();
    const lives = r.session.game!.state.lives;
    r.restart();
    r.engine.status = 'loading';
    r.engine.source = null;
    r.advance(5);
    expect(r.session.stage).toBe('framing');
    expect(r.count('outcome')).toBe(2);
    expect(r.session.game!.state.lives).toBe(lives);
    r.engine.status = 'ready';
    r.engine.source = r.sim();
    r.run(playing, 8);
    expect(r.session.stage).toBe('playing');
  });

  it('does not re-calibrate while the round is paused by hand — the player is at the keyboard, not at their spot', () => {
    // 典型情形：游戏中打开设置（游戏随之暂停），换了识别模型，引擎重启。这时人坐在电脑前一动不动地看设置，
    // 要是照常做"站着别动就标定"，就会把电脑前的那个位置标定成站位
    const r = midRound();
    r.session.setPaused(true);
    r.restart();
    r.advance(8);
    expect(r.session.stage).toBe('framing');
    expect(begins(r)).toHaveLength(1);
    expect(r.session.awaitingResume).toBe(true);

    // 点了"继续"，走回去站好：这时才重新标定，然后接着这一局
    const mark = r.log.length;
    r.session.setPaused(false);
    expect(r.session.awaitingResume).toBe(false);
    r.run(playing, 8);
    expect(begins(r)).toHaveLength(2);
    expect(begins(r)[1].resumed).toBe(true);
    r.run((x) => x.log.slice(mark).some((e) => e.type === 'wall'), 10);
    expect(r.log.slice(mark).some((e) => e.type === 'wall')).toBe(true);
  });

  it('is not "awaiting resume" in ordinary play, ordinary pauses, or before the first round', () => {
    const fresh = rig();
    expect(fresh.session.awaitingResume).toBe(false);
    const r = midRound();
    expect(r.session.awaitingResume).toBe(false);
    r.session.setPaused(true);
    r.advance(0.5);
    expect(r.session.awaitingResume).toBe(false); // 只是普通的暂停，没有重启
    r.session.setPaused(false);
  });

  it('decides full-body or upper-body afresh from what the new camera sees', () => {
    const r = midRound();
    expect(r.session.ctx!.mode).toBe('full');
    r.restart({ legs: false }); // 换的那个摄像头只照得到上半身
    r.advance(0.9);
    expect(r.session.framing.text).toContain('半身');
    r.run(playing, 12);
    expect(begins(r)[1].ctx.mode).toBe('upper');

    const mark = r.log.length;
    r.run((x) => x.log.slice(mark).filter((e) => e.type === 'wall').length === 8, 120);
    for (const e of r.log.slice(mark)) {
      if (e.type === 'wall') expect((e.wall.spec.pose ?? e.wall.spec.shape)!.upperOk, e.wall.label).toBe(true);
    }
  });

  it('once the round is over it no longer insists on the calibrated spot; "again" does again', () => {
    // 结算时人可能走到别处去了。举手悬停点"再来一次"得照样好使
    const r = rig({ kind: 'sim', sim: 'wrong' }).run((x) => x.session.stage === 'over', 120);
    r.sim().setPose(STAND, { x: 1.6 }, 0); // 跟丢，然后在 1.6 米外重新出现
    r.advance(1.5);
    expect(r.tracker.state.present).toBe(true);

    r.session.again(); // 就在这儿再来一局：认准现在这个位置
    r.advance(0.3);
    r.sim().setPose(STAND, { x: 0 }, 0);
    r.advance(2);
    expect(r.tracker.state.present).toBe(false);
  });

  it('a restart after the round is over does not bring it back', () => {
    const r = rig({ kind: 'sim', sim: 'wrong' }).run((x) => x.session.stage === 'over', 120);
    r.restart();
    r.advance(5);
    expect(r.session.stage).toBe('over');
    expect(r.count('begin')).toBe(1);
  });
});

describe('WallSession: odds and ends', () => {
  it('can run the game clock faster (for demos and automated checks)', () => {
    // 开局后过 5 秒：正常速度下第一面墙还在路上；三倍速下它早就到了
    const normal = rig().run(playing, 5).advance(5);
    const fast = rig({ speed: 3 }).run(playing, 5).advance(5);
    expect(normal.count('outcome')).toBe(0);
    expect(fast.count('outcome')).toBeGreaterThanOrEqual(1);
  });
});
