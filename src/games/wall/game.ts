import type { Body, ViewWindow } from '../../engine/body/bodyModel';
import type { PoseSpec, Skeleton } from '../../engine/body/pose';
import type { BodyProfile } from '../../engine/body/profile';
import { clamp, clamp01 } from '../../engine/util/math';
import { limbsToParts, skeletonCapsules, type PartId } from './bodyShape';
import { buildWall, type BuiltWall } from './build';
import { judgePose, judgeShape, reasonText, resolveOutcome, type Outcome, type PoseJudge, type ShapeJudge } from './judge';
import { WallSequence } from './levels';
import type { ShapeSpec } from './shapes';
import { COMMON, TUNING, type Difficulty, type Tuning } from './tuning';

/**
 * 「别撞墙！」的游戏逻辑——一个不碰画面、不碰摄像头的纯状态机。
 *
 *   idle → countdown → ┌ approach（墙驶来）→ resolve（过 / 撞的演出）┐ → over
 *                      └── levelup（本关的墙出完了）←───────────────┘
 *   approach 途中看不到人超过 1 秒 → paused，人回来 0.5 秒后继续（墙离得太近的话先退回去一段）。
 *   墙到了却没看到人：不判，墙停在面前等；等到暂停。同一面墙第二次这样，就换一面墙。
 *   总之：看不到人，绝不扣命。
 *
 * 外面每帧调用 update(dt, body)：喂进这一帧的玩家身体，拿回这一帧发生的事件。
 * 画面（3D 场景、HUD、声音）只是事件和 state 的"观众"，所以整局游戏可以用模拟玩家在测试里跑完。
 */
export type Phase = 'idle' | 'countdown' | 'approach' | 'resolve' | 'levelup' | 'paused' | 'over';

export interface Summary {
  /** 闯到第几关 */
  level: number;
  /** 过了几面墙 */
  walls: number;
  score: number;
  bestCombo: number;
  /** 一星、两星、三星各拿了几次 */
  stars: [number, number, number];
  seed: number;
  difficulty: Difficulty;
}

export type GameEvent =
  | { type: 'countdown'; n: number }
  | { type: 'wall'; wall: BuiltWall }
  | { type: 'tick'; n: number }
  | { type: 'outcome'; outcome: Outcome; wall: BuiltWall; gained: number }
  /** 这面墙一直没看清人，不算数，直接换下一面（不扣命、不加分） */
  | { type: 'skip'; wall: BuiltWall }
  | { type: 'life'; lives: number }
  | { type: 'levelup'; level: number }
  | { type: 'pause'; on: boolean }
  | { type: 'over'; summary: Summary };

/** 墙驶来途中的实时反馈：现在摆得对不对、哪里不对。 */
export interface LiveJudge {
  accuracy: number;
  ok: boolean;
  /** 小人身上该变红的部位 */
  badParts: PartId[];
  /** 一句提示，比如"左手没摆对"；摆对了是空串 */
  hint: string;
}

export interface WallGameState {
  phase: Phase;
  level: number;
  /** 整局第几面墙 */
  wallIndex: number;
  wallInLevel: number;
  wallsInLevel: number;
  lives: number;
  score: number;
  combo: number;
  wall: BuiltWall | null;
  /** 墙走了多少：0 刚出现，1 到达 */
  progress: number;
  /** 墙还有几秒到 */
  timeLeft: number;
  live: LiveJudge | null;
  /** 最近一面墙的结果 */
  last: Outcome | null;
}

/** 还没开局时的"空状态"（场景在开局前也要有东西可画）。 */
export const IDLE_STATE: WallGameState = {
  phase: 'idle',
  level: 1,
  wallIndex: 0,
  wallInLevel: 0,
  wallsInLevel: COMMON.wallsBase + 1,
  lives: COMMON.lives,
  score: 0,
  combo: 0,
  wall: null,
  progress: 0,
  timeLeft: 0,
  live: null,
  last: null,
};

export interface StartCtx {
  profile: BodyProfile;
  mode: 'full' | 'upper';
  view: ViewWindow | null;
}

export class WallGame {
  private readonly seed: number;
  private readonly difficulty: Difficulty;
  private readonly tuning: Tuning;
  private readonly seq: WallSequence;

  private ctx: StartCtx | null = null;
  private phase: Phase = 'idle';
  private manualPause = false;
  private pending: GameEvent[] = [];

  private countdownLeft = 0;
  private countdownNext = 0;

  private wall: BuiltWall | null = null;
  private progress = 0;
  private clockMs = 0;
  private nextTick = 0;
  private samples: { t: number; j: PoseJudge | ShapeJudge }[] = [];
  private live: LiveJudge | null = null;
  private lostMs = 0;
  private backMs = 0;
  /** 这面墙已经因为看不到人暂停过几次 */
  private pausesThisWall = 0;

  private phaseT = 0;
  private resolveDur = 0;
  private last: Outcome | null = null;

  private level = 1;
  private lives: number = COMMON.lives;
  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private passed = 0;
  private stars: [number, number, number] = [0, 0, 0];
  private playerX = 0;

  constructor(opts: { seed: number; difficulty: Difficulty; pool?: { poses: PoseSpec[]; shapes: ShapeSpec[] } }) {
    this.seed = opts.seed;
    this.difficulty = opts.difficulty;
    this.tuning = TUNING[opts.difficulty];
    this.seq = new WallSequence(opts.seed, opts.difficulty, opts.pool);
  }

  /** 标定完成后调用：开始倒计时。 */
  start(ctx: StartCtx): void {
    this.ctx = ctx;
    this.phase = 'countdown';
    this.countdownLeft = COMMON.countdownSec;
    this.countdownNext = COMMON.countdownSec;
  }

  /**
   * 一局中途换了一套标定，接着这一局玩。
   * 什么时候会这样：识别引擎重启过——在设置里换了识别模型或摄像头、摄像头断了又点了"再试一次"、改用了演示模式。
   * 重启之后玩家的位置、身材、摄像头看得见的范围都是重新量的，所以：
   *   - 正在飞来的那面墙作废（它是按旧的身材和位置造的）；
   *   - 重新 3-2-1，再出下一面墙；
   *   - 分数、命、连过、关卡都不变。刚判完的那面墙该有的后续照常兑现（没命了就结束，该升关就升关）。
   */
  recalibrate(ctx: StartCtx): void {
    this.ctx = ctx;
    if (this.phase === 'idle' || this.phase === 'over') return;

    const inFlight = this.phase === 'approach' || this.phase === 'paused';
    if (inFlight && this.wall) {
      this.emit({ type: 'skip', wall: this.wall });
      this.seq.forgetLast(); // 作废的墙不算进这一关
    }
    if ((inFlight || this.phase === 'resolve') && this.settle() === 'over') return;

    this.live = null;
    this.lostMs = 0;
    this.phase = 'countdown';
    this.countdownLeft = COMMON.countdownSec;
    this.countdownNext = COMMON.countdownSec;
  }

  /**
   * 手动暂停 / 继续（按了暂停键、打开了设置、标签页切到后台）。
   * 继续的时候和"人回来了"一样对待：墙要是已经很近，先退回去一段；暂停前的判定结果不作数——
   * 人离开过，回来时摆的是什么样，得重新看。
   */
  setPaused(on: boolean): void {
    const resuming = this.manualPause && !on;
    this.manualPause = on;
    if (resuming && this.phase === 'approach') this.backOff();
  }

  get timeLeft(): number {
    return this.wall ? Math.max(0, (1 - this.progress) * this.wall.spec.approachSec) : 0;
  }

  get state(): WallGameState {
    return {
      phase: this.phase,
      level: this.level,
      wallIndex: this.wall?.spec.index ?? 0,
      wallInLevel: this.seq.wallInLevel,
      wallsInLevel: this.seq.wallsInLevel,
      lives: this.lives,
      score: this.score,
      combo: this.combo,
      wall: this.wall,
      progress: this.progress,
      timeLeft: this.timeLeft,
      live: this.live,
      last: this.last,
    };
  }

  get summary(): Summary {
    return { level: this.level, walls: this.passed, score: this.score, bestCombo: this.bestCombo, stars: [...this.stars], seed: this.seed, difficulty: this.difficulty };
  }

  /**
   * 过关吸附。判定有容差，所以"判你过了"的时候手臂可能比洞口歪出去一点。
   * 墙到达前的最后一瞬，如果姿势在容差内，就把显示用的小人吸向洞的正中姿势（k 从 0 升到 1），
   * 让它干净地穿过去；穿过之后再放回真实动作。姿势不对时不吸附——红色的肢体就是撞墙的地方。
   */
  assist(): { k: number; target: Skeleton } | null {
    const wall = this.wall;
    if (!wall || wall.spec.kind !== 'pose') return null;
    if (this.phase === 'approach') {
      if (!this.live?.ok || this.timeLeft > COMMON.assistSec) return null;
      return { k: clamp01(1 - this.timeLeft / COMMON.assistSec), target: wall.target };
    }
    if (this.phase === 'resolve' && this.last?.kind === 'pass') {
      if (this.phaseT <= COMMON.assistHoldSec) return { k: 1, target: wall.target };
      const k = 1 - (this.phaseT - COMMON.assistHoldSec) / COMMON.assistFadeSec;
      return k > 0 ? { k, target: wall.target } : null;
    }
    return null;
  }

  update(dtSec: number, body: Body | null): GameEvent[] {
    if (!(this.manualPause || this.phase === 'idle' || this.phase === 'over' || !this.ctx)) this.advance(dtSec, body);
    // 就算这一帧没往前走（暂停着、已经结束），之前攒下还没交出去的事件也要交出去
    const out = this.pending;
    this.pending = [];
    return out;
  }

  private advance(dtSec: number, body: Body | null): void {
    // 帧间隔封顶：标签页切走再回来时 dt 可能是好几秒，不能让墙一步到位
    const dt = clamp(dtSec, 0, COMMON.maxDtSec);
    if (body) this.playerX = body.root.x;

    switch (this.phase) {
      case 'countdown':
        while (this.countdownNext > 0 && this.countdownLeft <= this.countdownNext) this.emit({ type: 'countdown', n: this.countdownNext-- });
        this.countdownLeft -= dt;
        if (this.countdownLeft <= 0) this.spawn();
        break;
      case 'approach':
        this.approach(dt, body);
        break;
      case 'paused':
        // "回来了"指的是又能判了：只露个头不算
        this.backMs = this.wall && this.usable(this.wall, body) ? this.backMs + dt * 1000 : 0;
        if (this.backMs >= COMMON.resumeMs) this.resume();
        break;
      case 'resolve':
        this.phaseT += dt;
        if (this.phaseT >= this.resolveDur) this.afterResolve();
        break;
      case 'levelup':
        this.phaseT += dt;
        if (this.phaseT >= COMMON.levelUpSec) this.spawn();
        break;
    }
  }

  private emit(e: GameEvent): void {
    this.pending.push(e);
  }

  private spawn(): void {
    const ctx = this.ctx!;
    const spec = this.seq.next({ ...ctx, playerX: this.playerX });
    this.level = spec.level;
    this.wall = buildWall(spec, ctx.profile, this.tuning);
    this.phase = 'approach';
    this.progress = 0;
    this.nextTick = 3;
    this.samples = [];
    this.live = null;
    this.lostMs = 0;
    this.pausesThisWall = 0;
    this.emit({ type: 'wall', wall: this.wall });
  }

  /** 人不见了：停下来等，不扣命。同一面墙已经等过了，就不再等，换一面。 */
  private pause(wall: BuiltWall): void {
    if (this.pausesThisWall >= COMMON.maxPausesPerWall) {
      this.live = null;
      this.emit({ type: 'skip', wall });
      // 没判过的墙不算进这一关：不然一面墙都不摆、光靠躲，也能一路升关拿奖励分
      this.seq.forgetLast();
      this.afterResolve();
      return;
    }
    this.pausesThisWall++;
    this.phase = 'paused';
    this.backMs = 0;
    this.emit({ type: 'pause', on: true });
  }

  /** 人回来了：接着来。 */
  private resume(): void {
    this.phase = 'approach';
    this.lostMs = 0;
    this.backOff();
    this.emit({ type: 'pause', on: false });
  }

  /** 停过之后重新上路：墙要是已经很近，先退回去一段，留出重新摆好的时间；停之前的判定结果不作数。 */
  private backOff(): void {
    const wall = this.wall;
    if (!wall) return;
    this.progress = Math.min(this.progress, Math.max(0, 1 - COMMON.resumeLeadSec / wall.spec.approachSec));
    this.samples = [];
    this.nextTick = Math.min(3, Math.floor(this.timeLeft));
  }

  /**
   * 这一帧的身体能不能拿来判这面墙；能就返回判定结果，不能返回 null。
   * 人不在当然不能。人在，但人形洞要比的肢体看得清的不到两段（比如贴得太近，只剩头和肩）——也不能：
   * 没法判就不该判撞，和"没看到人"一样对待。
   */
  private usable(wall: BuiltWall, body: Body | null): PoseJudge | ShapeJudge | null {
    if (!body) return null;
    const j = this.judge(wall, body);
    return j.kind === 'pose' && Object.keys(j.errors).length < COMMON.minJudgedLimbs ? null : j;
  }

  private approach(dt: number, body: Body | null): void {
    const wall = this.wall!;
    const j = this.usable(wall, body);
    if (j && body) {
      this.lostMs = 0;
      this.samples.push({ t: this.clockMs, j });
      this.live =
        j.kind === 'pose'
          ? { accuracy: j.accuracy, ok: j.matched, badParts: limbsToParts(j.bad), hint: j.matched ? '' : reasonText(j) }
          : { accuracy: j.clean ? 1 : j.hit ? 0 : 0.7, ok: !j.hit, badParts: j.bad, hint: j.hit ? reasonText(j) : '' };
      // 这一局是按全身开的，可现在两只脚都看不到了：多半是走近了。看不见的腿不参与判定，但得告诉他
      if (this.ctx!.mode === 'full' && !body.ok.ankleL && !body.ok.ankleR) this.live.hint = '脚出画面了，退回原位';
    } else {
      // 没看到人，或者人在但看不全：都不判。后一种给个提示
      this.live = body ? { accuracy: 0, ok: false, badParts: [], hint: '看不清你的手脚，退后一点' } : null;
      this.lostMs += dt * 1000;
      if (this.lostMs >= COMMON.lostPauseMs) {
        this.pause(wall);
        return;
      }
    }

    this.clockMs += dt * 1000;
    while (this.samples.length && this.samples[0].t < this.clockMs - COMMON.judgeWindowMs) this.samples.shift();

    // 墙这一步就要到了，手里却没有足够的判定依据（这会儿没看到人，或者人刚回来）：
    // 先不判，墙停在面前等着。看不到人的时间照常累计，够久了就走上面的暂停。
    const next = this.progress + dt / wall.spec.approachSec;
    const enough = this.samples.length > 0 && this.clockMs - this.samples[0].t >= COMMON.judgeMinSpanMs;
    if (next >= 1 && !enough) return;
    this.progress = next;

    while (this.nextTick > 0 && this.timeLeft <= this.nextTick) {
      if (wall.spec.approachSec > this.nextTick) this.emit({ type: 'tick', n: this.nextTick });
      this.nextTick--;
    }

    if (this.progress >= 1) this.resolve(wall);
  }

  private judge(wall: BuiltWall, body: Body): PoseJudge | ShapeJudge {
    const profile = this.ctx!.profile;
    if (wall.spec.kind === 'pose' && wall.spec.pose) {
      return judgePose(wall.spec.pose, wall.spec.holeX, body, profile, { angle: wall.spec.angleTol, pos: this.tuning.posTol });
    }
    return judgeShape(wall.field, skeletonCapsules(body.skeleton, profile, body.ok), { slack: this.tuning.shapeSlack, hitFrac: COMMON.hitFrac });
  }

  private resolve(wall: BuiltWall): void {
    this.progress = 1;
    const outcome = resolveOutcome(this.samples.map((s) => s.j));
    this.last = outcome;
    this.live = null;
    this.phase = 'resolve';
    this.phaseT = 0;

    if (outcome.kind === 'pass') {
      const gained = Math.round(COMMON.starScore * outcome.stars * (1 + COMMON.comboBonus * Math.min(this.combo, COMMON.comboCap)));
      this.score += gained;
      this.combo++;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      this.passed++;
      this.stars[outcome.stars - 1]++;
      this.resolveDur = COMMON.resolvePassSec;
      this.emit({ type: 'outcome', outcome, wall, gained });
    } else {
      this.combo = 0;
      this.lives--;
      this.resolveDur = COMMON.resolveHitSec;
      this.emit({ type: 'outcome', outcome, wall, gained: 0 });
      this.emit({ type: 'life', lives: this.lives });
    }
  }

  /** 一面墙有了着落之后的账：没命了就结束；这一关的墙出完了就升关（加分、发通知）。 */
  private settle(): 'over' | 'levelup' | 'next' {
    if (this.lives <= 0) {
      this.phase = 'over';
      this.emit({ type: 'over', summary: this.summary });
      return 'over';
    }
    if (this.seq.wallInLevel >= this.seq.wallsInLevel) {
      this.level++;
      this.score += COMMON.levelBonus * this.level;
      this.emit({ type: 'levelup', level: this.level });
      return 'levelup';
    }
    return 'next';
  }

  private afterResolve(): void {
    const what = this.settle();
    if (what === 'levelup') {
      this.phase = 'levelup';
      this.phaseT = 0;
    } else if (what === 'next') {
      this.spawn();
    }
  }
}
