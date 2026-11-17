import type { Body } from '../../engine/body/bodyModel';
import type { PoseSpec } from '../../engine/body/pose';
import { SimPoseSource } from '../../engine/input/simSource';
import { STALE_MS, type PoseSource } from '../../engine/input/types';
import type { PlayerTracker } from '../../engine/player/playerTracker';
import { clamp } from '../../engine/util/math';
import { pairGap } from './duo';
import { FramingGate } from './framing';
import { WallGame, type GameEvent, type StartCtx } from './game';
import type { ShapeSpec } from './shapes';
import { COMMON, type Difficulty } from './tuning';

/**
 * 一局「别撞墙！」从头到尾的"流程管理"，夹在引擎和游戏规则之间：
 *
 *   站位引导（看得到人、站着没动）→ 标定 → 开局 → 每帧把玩家的身体喂给游戏规则 → 结束 → 再来一局
 *
 * 另外管三件容易出错的事：
 *   - 识别结果太旧（摄像头卡住了）时，当作"没看到人"，不拿旧数据去判；
 *   - 识别引擎在一局中途重启了（换了模型或摄像头、摄像头断了又重试、改用演示模式）：
 *     之前的标定作废，回到站位引导，过了之后**接着同一局玩**；
 *   - 模拟玩家（演示模式、自动化检查）：不用站位引导，墙一出来就让它照着摆。
 *
 * 双人（players: 2，而且引擎给了第二个追踪器）：站位要两位都合适；标定时量出两人隔多远，
 * 把 1 号的原位定在 -gap/2、2 号定在 +gap/2——之后两位的身体就在同一个舞台坐标系里，一左一右。
 *
 * 这里不碰画面和声音，也不依赖 React：游戏页（WallPlay）和首页的自动演示（Attract）都拿它来跑，
 * 测试里也直接跑它（session.test.ts）。
 */

/** 会话需要从引擎知道的事。app/useEngine 给出的 Engine 满足它；测试和首页演示自己拼一个。 */
export interface SessionEngine {
  status: 'loading' | 'ready' | 'error';
  /** 现在的姿态来源；它换了，就说明引擎重启过 */
  source: PoseSource | null;
  kind: 'camera' | 'sim' | 'replay';
  /** 1 号玩家（单人时唯一的玩家） */
  tracker: PlayerTracker;
  /** 2 号玩家的追踪器；引擎不是双人模式时没有 */
  mate?: PlayerTracker | null;
  sinceFrame(nowMs?: number): number;
}

/** begin：一局开始了（或者中途重新标定后接着玩，resumed 为 true）。其余是游戏规则发出来的事件。 */
export type SessionEvent = GameEvent | { type: 'begin'; ctx: StartCtx; resumed: boolean };

export type SessionStage = 'framing' | 'playing' | 'over';

export interface FramingView {
  text: string;
  progress: number;
  mode: 'full' | 'upper' | null;
  /** 这句话只是建议：做不到的话站着别动，过几秒照样开始 */
  advisory: boolean;
}

export interface WallPool {
  poses: PoseSpec[];
  shapes: ShapeSpec[];
}

export class WallSession {
  stage: SessionStage = 'framing';
  game: WallGame | null = null;
  /** 这一局的标定：身材、全身还是半身、摄像头看得见的范围 */
  ctx: StartCtx | null = null;
  framing: FramingView = { text: '', progress: 0, mode: null, advisory: false };

  private readonly gate = new FramingGate();
  private pool: WallPool | null = null;
  /** 标定是对着哪个姿态来源做的 */
  private calibratedFor: PoseSource | null = null;
  /** 引擎重启过，正在等重新标定；过了之后是"接着玩"而不是"新开一局" */
  private resuming = false;
  private simWarm = 0;
  private paused = false;
  private tracker: PlayerTracker | null = null;
  private mateTracker: PlayerTracker | null = null;
  private pending: SessionEvent[] = [];

  constructor(
    private readonly opts: {
      /** 固定出墙顺序；null 表示每局随机 */
      seed: number | null;
      /** 地址栏的 sim 开关 */
      sim: 'off' | 'auto' | 'wrong' | 'manual';
      /** 现在的难度（开新局时读一次） */
      difficulty: () => Difficulty;
      /** 从第几关开始（地址栏的 level 开关：预览、测试后面的关卡用）；不给就是第 1 关 */
      startLevel?: number | null;
      /** 几个人玩，默认 1。2 = 双人：引擎也得是双人模式（有第二个追踪器）才生效 */
      players?: 1 | 2;
    },
  ) {}

  /**
   * 这一局从哪些造型里出墙。**不给就不开局**：造型池（内置的 + 自己存的）是异步读出来的，
   * 池子不同，同一个种子出的墙也不同，不能让"读得快还是慢"决定出墙顺序。
   */
  setPool(pool: WallPool): void {
    this.pool = pool;
  }

  /**
   * 引擎在一局中途重启了，而这一局正被手动暂停着（典型情形：游戏中打开设置、换了识别模型）。
   * 这时人在电脑前，不在他的站位上：不能做"站着别动就标定"。等他点了"继续"（setPaused(false)）再重新站位。
   * 界面据此显示暂停面板，而不是站位引导。
   */
  get awaitingResume(): boolean {
    return this.stage === 'framing' && this.resuming && this.paused;
  }

  /** 模拟玩家怎么表现；null 表示是真人（要过站位引导）。 */
  private policy(engine: SessionEngine): 'auto' | 'wrong' | 'manual' | null {
    if (this.opts.sim !== 'off') return this.opts.sim;
    return engine.kind === 'sim' ? 'auto' : null;
  }

  /** 每个画面帧调用一次。speed：游戏时钟走几倍速。返回这一帧发生的事。 */
  update(nowMs: number, dtSec: number, engine: SessionEngine, speed = 1): SessionEvent[] {
    this.tracker = engine.tracker;
    const mate = this.opts.players === 2 ? (engine.mate ?? null) : null;
    this.mateTracker = mate;
    const ready = engine.status === 'ready' && engine.source !== null;
    // 太久没有新的识别结果（摄像头卡住了）：手上的是旧数据，当作看不到人
    const fresh = ready && engine.sinceFrame(nowMs) < STALE_MS;
    const body = fresh ? engine.tracker.state.body : null;
    const mateBody = fresh && mate ? mate.state.body : null;
    const policy = this.policy(engine);

    // 一局中途，姿态来源换了：引擎重启过，标定作废。回到站位引导，过了之后接着玩
    if (this.stage === 'playing' && engine.source !== this.calibratedFor) {
      this.stage = 'framing';
      this.resuming = true;
      this.gate.reset();
      this.simWarm = 0;
      this.framing = { text: '', progress: 0, mode: null, advisory: false };
    }

    if (ready && this.stage === 'framing' && this.pool && !this.awaitingResume) {
      if (policy) {
        // 模拟玩家不用引导：等它"站稳"、量好身材就开
        this.simWarm += dtSec;
        const measured = engine.tracker.state.profileReady && (!mate || mate.state.profileReady);
        if (body && (!mate || mateBody) && (measured || this.simWarm > 2)) this.begin(engine, mate && mateBody?.mode === 'upper' ? 'upper' : body.mode, body, mateBody);
      } else {
        const g = mate
          ? this.gate.updateDuo(body, mateBody, [engine.tracker.state.motion, mate.state.motion], [engine.tracker.state.profile, mate.state.profile], nowMs)
          : this.gate.update(body, engine.tracker.state.motion, nowMs);
        if (g.ready && body && (!mate || mateBody)) this.begin(engine, g.result.mode ?? body.mode, body, mateBody);
        else this.framing = { text: g.result.text, progress: g.progress, mode: g.result.mode, advisory: g.advisory };
      }
    }

    if (ready && this.stage === 'playing' && this.game) {
      for (const e of this.game.update(dtSec * speed, body, mateBody)) {
        // 演示模式：照着这面墙摆（双人的墙，两位各摆各的）
        if (e.type === 'wall' && policy === 'auto' && engine.source instanceof SimPoseSource) {
          const spec = e.wall.spec;
          engine.source.setPose(spec.pose ?? spec.shape!.demo, { x: spec.holeX }, 0.5, 0);
          if (spec.mate) engine.source.setPose(spec.mate.pose ?? spec.mate.shape!.demo, { x: spec.mate.holeX }, 0.5, 1);
        }
        if (e.type === 'over') {
          this.stage = 'over';
          // 结算时人可能走开去点按钮：不再只认原来的站位
          engine.tracker.unlock();
          mate?.unlock();
        }
        this.pending.push(e);
      }
    }

    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** 标定，然后开一局——或者（引擎重启之后）拿新的标定接着原来那一局。 */
  private begin(engine: SessionEngine, mode: 'full' | 'upper', body: Body, mateBody: Body | null): void {
    const mate = this.mateTracker;
    if (mate && mateBody) {
      // 双人：两个小人在舞台上隔多远，就按两个人实际隔多远来（太近、太远都夹到舞台放得下的范围里）。
      // 1 号的原位定在 -gap/2，2 号定在 +gap/2；两位的身体从此在同一个坐标系里
      const gap = clamp(pairGap(body, mateBody), COMMON.duo.minGap, COMMON.duo.maxGap);
      const view = engine.tracker.calibrate({ x: -gap / 2 });
      const mateView = mate.calibrate({ x: gap / 2 });
      engine.tracker.setMode(mode);
      mate.setMode(mode);
      this.ctx = { profile: engine.tracker.state.profile, mode, view, mate: { profile: mate.state.profile, view: mateView }, gap };
    } else {
      // 标定把原点挪到玩家现在站的地方，返回的可见范围是按新原点算的
      const view = engine.tracker.calibrate();
      engine.tracker.setMode(mode);
      this.ctx = { profile: engine.tracker.state.profile, mode, view };
    }
    this.calibratedFor = engine.source;

    const resumed = this.resuming && this.game !== null;
    this.resuming = false;
    if (resumed) this.game!.recalibrate(this.ctx);
    else this.newGame();
    this.stage = 'playing';
    this.pending.push({ type: 'begin', ctx: this.ctx, resumed });
  }

  private newGame(): void {
    this.game = new WallGame({
      seed: this.opts.seed ?? Math.floor(Math.random() * 1e6),
      difficulty: this.opts.difficulty(),
      pool: this.pool ?? undefined,
      startLevel: this.opts.startLevel ?? undefined,
    });
    this.game.start(this.ctx!);
    this.game.setPaused(this.paused);
  }

  /** 再来一局，沿用这一次的标定（人没挪地方，不用重新站位）。 */
  again(): void {
    if (!this.ctx) return;
    this.tracker?.lock(); // 新的一局：认准他现在站的地方
    this.mateTracker?.lock();
    this.newGame();
    this.stage = 'playing';
    this.pending.push({ type: 'begin', ctx: this.ctx, resumed: false });
  }

  /**
   * 再闯这一关：没命结束之后，接着**同一局**，回到倒下的那一关的开头（规则见 WallGame.retryLevel）。
   * 和"再来一局"一样沿用这一次的标定。不是"没命结束"的时候调用，什么也不发生。
   */
  retryLevel(): void {
    if (this.stage !== 'over' || !this.ctx || !this.game?.retryLevel()) return;
    this.tracker?.lock();
    this.mateTracker?.lock();
    this.game.setPaused(this.paused);
    this.stage = 'playing';
    this.pending.push({ type: 'begin', ctx: this.ctx, resumed: false });
  }

  /** 手动暂停 / 继续。 */
  setPaused(on: boolean): void {
    this.paused = on;
    this.game?.setPaused(on);
  }
}
