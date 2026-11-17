import type { Body, ViewWindow } from '../../engine/body/bodyModel';
import type { PoseSpec, Skeleton } from '../../engine/body/pose';
import type { BodyProfile } from '../../engine/body/profile';
import { clamp, clamp01 } from '../../engine/util/math';
import { limbsToParts, skeletonCapsules, type PartId } from './bodyShape';
import { buildWall, type BuiltWall } from './build';
import { combineOutcomes, judgePose, judgeShape, reasonText, resolveOutcome, type Outcome, type PoseJudge, type ShapeJudge } from './judge';
import { levelPlan, WallSequence } from './levels';
import type { ShapeSpec } from './shapes';
import { COMMON, TUNING, type Difficulty, type Tuning } from './tuning';

/**
 * 「别撞墙！」的游戏逻辑——一个不碰画面、不碰摄像头的纯状态机。
 *
 *   idle → countdown → ┌ approach（墙驶来）→ resolve（过 / 撞的演出）┐ → over（没命了）
 *                      └── levelup（本关的墙出完了：庆祝、回一条命）←┘
 *                                          最后一关的墙出完且还有命 → finale（通关演出）→ over
 *   over 之后如果不是通关：retryLevel() 可以回到这一关的开头再闯。
 *   approach 途中看不到人超过 1 秒 → paused，人回来 0.5 秒后继续（墙离得太近的话先退回去一段）。
 *   墙到了却没看到人：不判，墙停在面前等；等到暂停。同一面墙第二次这样，就换一面墙。
 *   总之：看不到人，绝不扣命。
 *
 * 双人（开局时的标定里带着 mate）：一面墙两个洞，两位各判各的，**两个人都过才算过**；共用命和分数。
 * 任何一位看不清，都按"看不到人"处理：不判、等、暂停，两位都回来才继续。
 *
 * 外面每帧调用 update(dt, body, mate)：喂进这一帧的玩家身体，拿回这一帧发生的事件。
 * 画面（3D 场景、HUD、声音）只是事件和 state 的"观众"，所以整局游戏可以用模拟玩家在测试里跑完。
 */
export type Phase = 'idle' | 'countdown' | 'approach' | 'resolve' | 'levelup' | 'finale' | 'paused' | 'over';

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
  /** 十五关全部打完了（还有命） */
  cleared: boolean;
  /** 几个人玩的 */
  players: 1 | 2;
}

export type GameEvent =
  | { type: 'countdown'; n: number }
  | { type: 'wall'; wall: BuiltWall }
  | { type: 'tick'; n: number }
  | { type: 'outcome'; outcome: Outcome; wall: BuiltWall; gained: number }
  /** 这面墙一直没看清人，不算数，直接换下一面（不扣命、不加分） */
  | { type: 'skip'; wall: BuiltWall }
  /** 命变了：撞墙扣一条（delta -1），过一关回一条（delta +1） */
  | { type: 'life'; lives: number; delta: 1 | -1 }
  /** 过了一关。cleared 是刚过的那一关，level 是接下来的那一关 */
  | { type: 'levelup'; level: number; cleared: number }
  /** 过关的庆祝进行到一半：预告下一关。theme 为 null 表示不报主题（半身模式、只练一面墙时，出的墙对不上主题） */
  | { type: 'levelintro'; level: number; theme: string | null }
  | { type: 'pause'; on: boolean }
  /** 十五关全部打完：通关演出开始。演出放完才发 over */
  | { type: 'allclear'; summary: Summary }
  | { type: 'over'; summary: Summary };

/** 墙驶来途中的实时反馈：现在摆得对不对、哪里不对。 */
export interface LiveJudge {
  accuracy: number;
  ok: boolean;
  /** 小人身上该变红的部位 */
  badParts: PartId[];
  /** 一句提示，比如"左手没摆对"；摆对了是空串。双人时带着是谁："左边：右手没摆对" */
  hint: string;
  /** 双人：2 号（右边那位）的情况。上面的 ok、accuracy 是两位合起来的（都对才对、取较低的），badParts 是 1 号的 */
  mate?: { ok: boolean; accuracy: number; badParts: PartId[] };
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
  wallsInLevel: COMMON.levelSlots[0][0] + COMMON.levelSlots[0][1],
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
  /** 双人：2 号玩家（屏幕右边那位）的身材和他那边看得见的范围。有它，这一局就是双人的 */
  mate?: { profile: BodyProfile; view: ViewWindow | null };
  /** 双人：两条泳道的中心相距多远（米）；两位标定时分别站在 -gap/2 和 +gap/2 */
  gap?: number;
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
  /** 最近一小段时间里每一帧的判定：j 是 1 号的，m 是 2 号的（双人才有） */
  private samples: { t: number; j: PoseJudge | ShapeJudge; m?: PoseJudge | ShapeJudge }[] = [];
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
  /** 两位玩家现在站的左右位置（单人只用第一个） */
  private playerX: [number, number] = [0, 0];
  /** 十五关全部打完了 */
  private cleared = false;
  /** 这一次过关庆祝里，下一关的预告发过没有 */
  private introSent = false;
  /** 这一关开始时的成绩："再闯这一关"时退回到这里 */
  private levelStart: { score: number; passed: number; bestCombo: number; stars: [number, number, number] } = { score: 0, passed: 0, bestCombo: 0, stars: [0, 0, 0] };

  constructor(opts: { seed: number; difficulty: Difficulty; pool?: { poses: PoseSpec[]; shapes: ShapeSpec[] }; /** 从第几关开始（预览、测试后面的关卡用） */ startLevel?: number }) {
    this.seed = opts.seed;
    this.difficulty = opts.difficulty;
    this.tuning = TUNING[opts.difficulty];
    this.seq = new WallSequence(opts.seed, opts.difficulty, opts.pool, { startLevel: opts.startLevel });
    this.level = this.seq.level;
  }

  /** 标定完成后调用：开始倒计时。 */
  start(ctx: StartCtx): void {
    this.adopt(ctx);
    this.countdown();
  }

  /** 换上一套标定。标定把每位玩家现在站的地方定成了他的原位：单人是 0，双人是 ∓gap/2。 */
  private adopt(ctx: StartCtx): void {
    this.ctx = ctx;
    const half = ctx.mate ? (ctx.gap ?? 0) / 2 : 0;
    this.playerX = [-half, half];
  }

  private countdown(): void {
    this.phase = 'countdown';
    this.countdownLeft = COMMON.countdownSec;
    this.countdownNext = COMMON.countdownSec;
  }

  /**
   * 再闯这一关：没命结束之后，回到倒下的这一关的开头——3 条命，分数和各项统计退回这一关开始时，这一关的墙重新抽。
   * 只在"没命结束"之后有效；进行中、通关之后、已经点过一次，都什么也不做，返回 false。
   */
  retryLevel(): boolean {
    if (this.phase !== 'over' || this.cleared || !this.ctx) return false;
    const at = this.levelStart;
    this.score = at.score;
    this.passed = at.passed;
    this.bestCombo = at.bestCombo;
    this.stars = [...at.stars];
    this.combo = 0;
    this.lives = COMMON.lives;
    this.seq.restartLevel();
    this.wall = null;
    this.progress = 0;
    this.live = null;
    this.last = null;
    this.countdown();
    return true;
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
    this.adopt(ctx);
    // 通关演出里没有墙要造，也不用重新倒数：记下新的标定就行
    if (this.phase === 'idle' || this.phase === 'over' || this.phase === 'finale') return;

    const inFlight = this.phase === 'approach' || this.phase === 'paused';
    if (inFlight && this.wall) {
      this.emit({ type: 'skip', wall: this.wall });
      this.seq.forgetLast(); // 作废的墙不算进这一关
    }
    if (inFlight || this.phase === 'resolve') {
      const what = this.settle();
      if (what === 'over') return;
      if (what === 'clear') return this.enterFinale();
    }

    this.live = null;
    this.lostMs = 0;
    this.countdown();
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
    return {
      level: this.level,
      walls: this.passed,
      score: this.score,
      bestCombo: this.bestCombo,
      stars: [...this.stars],
      seed: this.seed,
      difficulty: this.difficulty,
      cleared: this.cleared,
      players: this.ctx?.mate ? 2 : 1,
    };
  }

  /**
   * 过关吸附。判定有容差，所以"判你过了"的时候手臂可能比洞口歪出去一点。
   * 墙到达前的最后一瞬，如果姿势在容差内，就把显示用的小人吸向洞的正中姿势（k 从 0 升到 1），
   * 让它干净地穿过去；穿过之后再放回真实动作。姿势不对时不吸附——红色的肢体就是撞墙的地方。
   */
  assist(who: 0 | 1 = 0): { k: number; target: Skeleton } | null {
    const wall = this.wall;
    const target = who === 0 ? wall?.target : wall?.mate?.target;
    if (!wall || !target || wall.spec.kind !== 'pose') return null;
    if (this.phase === 'approach') {
      // 双人：两位都摆对了才吸附（live.ok 是两位合起来的）——有一位不对，这面墙反正过不去
      if (!this.live?.ok || this.timeLeft > COMMON.assistSec) return null;
      return { k: clamp01(1 - this.timeLeft / COMMON.assistSec), target };
    }
    // 判完之后：过了的那位照样干净地穿过去（双人里可能只有一位过了）
    const mine = this.last?.each ? this.last.each[who] : this.last;
    if (this.phase === 'resolve' && mine?.kind === 'pass') {
      if (this.phaseT <= COMMON.assistHoldSec) return { k: 1, target };
      const k = 1 - (this.phaseT - COMMON.assistHoldSec) / COMMON.assistFadeSec;
      return k > 0 ? { k, target } : null;
    }
    return null;
  }

  update(dtSec: number, body: Body | null, mate: Body | null = null): GameEvent[] {
    // 单人的局不看第二个身体
    if (!(this.manualPause || this.phase === 'idle' || this.phase === 'over' || !this.ctx)) this.advance(dtSec, body, this.ctx.mate ? mate : null);
    // 就算这一帧没往前走（暂停着、已经结束），之前攒下还没交出去的事件也要交出去
    const out = this.pending;
    this.pending = [];
    return out;
  }

  private advance(dtSec: number, body: Body | null, mate: Body | null): void {
    // 帧间隔封顶：标签页切走再回来时 dt 可能是好几秒，不能让墙一步到位
    const dt = clamp(dtSec, 0, COMMON.maxDtSec);
    if (body) this.playerX[0] = body.root.x;
    if (mate) this.playerX[1] = mate.root.x;

    switch (this.phase) {
      case 'countdown':
        while (this.countdownNext > 0 && this.countdownLeft <= this.countdownNext) this.emit({ type: 'countdown', n: this.countdownNext-- });
        this.countdownLeft -= dt;
        if (this.countdownLeft <= 0) this.spawn();
        break;
      case 'approach':
        this.approach(dt, body, mate);
        break;
      case 'paused':
        // "回来了"指的是又能判了：只露个头不算。双人要两位都回来
        this.backMs = this.wall && this.usable(this.wall, body, 0) && (!this.ctx!.mate || this.usable(this.wall, mate, 1)) ? this.backMs + dt * 1000 : 0;
        if (this.backMs >= COMMON.resumeMs) this.resume();
        break;
      case 'resolve':
        this.phaseT += dt;
        if (this.phaseT >= this.resolveDur) this.afterResolve();
        break;
      case 'levelup':
        this.phaseT += dt;
        if (!this.introSent && this.phaseT >= COMMON.levelIntroAtSec) {
          this.introSent = true;
          // 半身模式出的是上半身做得了的墙，和"扎马步"这类主题对不上，就不报主题；只练一面墙时也一样
          const off = this.ctx!.mode === 'upper' || this.seq.practising;
          this.emit({ type: 'levelintro', level: this.level, theme: off ? null : levelPlan(this.level, this.tuning).theme });
        }
        if (this.phaseT >= COMMON.levelUpSec) this.spawn();
        break;
      case 'finale':
        this.phaseT += dt;
        if (this.phaseT >= COMMON.finaleSec) {
          this.phase = 'over';
          this.emit({ type: 'over', summary: this.summary });
        }
        break;
    }
  }

  private emit(e: GameEvent): void {
    this.pending.push(e);
  }

  private spawn(): void {
    const ctx = this.ctx!;
    const spec = this.seq.next({
      mode: ctx.mode,
      view: ctx.view,
      profile: ctx.profile,
      playerX: this.playerX[0],
      ...(ctx.mate ? { mate: { ...ctx.mate, playerX: this.playerX[1] }, ...(ctx.gap !== undefined ? { lanes: [-ctx.gap / 2, ctx.gap / 2] as [number, number] } : {}) } : {}),
    });
    this.level = spec.level;
    this.wall = buildWall(spec, ctx.profile, this.tuning, ctx.mate?.profile);
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
   * 这一帧的身体能不能拿来判这面墙；能就返回判定结果，不能返回 null。who：0 是 1 号，1 是 2 号（双人）。
   * 人不在当然不能。人在，但人形洞要比的肢体看得清的不到两段（比如贴得太近，只剩头和肩）——也不能：
   * 没法判就不该判撞，和"没看到人"一样对待。
   */
  private usable(wall: BuiltWall, body: Body | null, who: 0 | 1): PoseJudge | ShapeJudge | null {
    if (!body) return null;
    const j = this.judge(wall, body, who);
    return j.kind === 'pose' && Object.keys(j.errors).length < COMMON.minJudgedLimbs ? null : j;
  }

  /** 一位玩家这一帧的实时反馈。 */
  private feedback(j: PoseJudge | ShapeJudge, body: Body): { accuracy: number; ok: boolean; badParts: PartId[]; hint: string } {
    const fb =
      j.kind === 'pose'
        ? { accuracy: j.accuracy, ok: j.matched, badParts: limbsToParts(j.bad), hint: j.matched ? '' : reasonText(j) }
        : { accuracy: j.clean ? 1 : j.hit ? 0 : 0.7, ok: !j.hit, badParts: j.bad, hint: j.hit ? reasonText(j) : '' };
    // 这一局是按全身开的，可现在两只脚都看不到了：多半是走近了。看不见的腿不参与判定，但得告诉他
    if (this.ctx!.mode === 'full' && !body.ok.ankleL && !body.ok.ankleR) fb.hint = '脚出画面了，退回原位';
    return fb;
  }

  private approach(dt: number, body: Body | null, mate: Body | null): void {
    const wall = this.wall!;
    const duo = !!this.ctx!.mate;
    const j = this.usable(wall, body, 0);
    const m = duo ? this.usable(wall, mate, 1) : null;
    if (j && body && (!duo || (m && mate))) {
      this.lostMs = 0;
      this.samples.push({ t: this.clockMs, j, ...(m ? { m } : {}) });
      const mine = this.feedback(j, body);
      if (m && mate) {
        // 双人：两位都对才算对，契合度显示较低的那个；提示先说 1 号的，说清是谁
        const theirs = this.feedback(m, mate);
        this.live = {
          accuracy: Math.min(mine.accuracy, theirs.accuracy),
          ok: mine.ok && theirs.ok,
          badParts: mine.badParts,
          hint: mine.hint ? `左边：${mine.hint}` : theirs.hint ? `右边：${theirs.hint}` : '',
          mate: { ok: theirs.ok, accuracy: theirs.accuracy, badParts: theirs.badParts },
        };
      } else {
        this.live = mine;
      }
    } else {
      // 没看到人，或者人在但看不全：都不判。后一种给个提示（双人时说清是谁）
      const unclear = '看不清你的手脚，退后一点';
      if (!duo) this.live = body ? { accuracy: 0, ok: false, badParts: [], hint: unclear } : null;
      else if (!body && !mate) this.live = null;
      else this.live = { accuracy: 0, ok: false, badParts: [], hint: body && !j ? `左边：${unclear}` : mate && !m ? `右边：${unclear}` : '', mate: { ok: false, accuracy: 0, badParts: [] } };
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

  /** 拿一位玩家的身体去比他的那个洞。 */
  private judge(wall: BuiltWall, body: Body, who: 0 | 1): PoseJudge | ShapeJudge {
    const ctx = this.ctx!;
    const profile = who === 1 && ctx.mate ? ctx.mate.profile : ctx.profile;
    const hole = who === 1 && wall.spec.mate ? wall.spec.mate : wall.spec;
    if (wall.spec.kind === 'pose' && hole.pose) {
      return judgePose(hole.pose, hole.holeX, body, profile, { angle: wall.spec.angleTol, pos: this.tuning.posTol });
    }
    // 几何洞：两个洞在同一张场里，各人的身体各自去查
    return judgeShape(wall.field, skeletonCapsules(body.skeleton, profile, body.ok), { slack: this.tuning.shapeSlack, hitFrac: COMMON.hitFrac });
  }

  private resolve(wall: BuiltWall): void {
    this.progress = 1;
    const mine = resolveOutcome(this.samples.map((s) => s.j));
    // 双人：两个人都过才算过；谁没过，结果里写着
    const outcome: Outcome = this.ctx!.mate ? combineOutcomes(mine, resolveOutcome(this.samples.flatMap((s) => (s.m ? [s.m] : [])))) : mine;
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
      // 双人里两位都没过，也只扣一条命
      this.combo = 0;
      this.lives--;
      this.resolveDur = COMMON.resolveHitSec;
      this.emit({ type: 'outcome', outcome, wall, gained: 0 });
      this.emit({ type: 'life', lives: this.lives, delta: -1 });
    }
  }

  /**
   * 一面墙有了着落之后的账：
   *   没命了 → 结束；
   *   最后一关的墙出完了（还有命）→ 全部通关；
   *   这一关的墙出完了 → 升关：加分、回一条命（不超过上限）、记下这一关开始时的成绩。
   */
  private settle(): 'over' | 'clear' | 'levelup' | 'next' {
    if (this.lives <= 0) {
      this.phase = 'over';
      this.emit({ type: 'over', summary: this.summary });
      return 'over';
    }
    if (this.seq.finished) {
      this.cleared = true;
      this.emit({ type: 'allclear', summary: this.summary });
      return 'clear';
    }
    if (this.seq.wallInLevel >= this.seq.wallsInLevel) {
      const cleared = this.level;
      this.level++;
      this.score += COMMON.levelBonus * this.level;
      this.emit({ type: 'levelup', level: this.level, cleared });
      if (this.lives < COMMON.lives) {
        this.lives++;
        this.emit({ type: 'life', lives: this.lives, delta: 1 });
      }
      this.markLevelStart();
      return 'levelup';
    }
    return 'next';
  }

  private markLevelStart(): void {
    this.levelStart = { score: this.score, passed: this.passed, bestCombo: this.bestCombo, stars: [...this.stars] };
  }

  private enterFinale(): void {
    this.phase = 'finale';
    this.phaseT = 0;
    this.live = null;
  }

  private afterResolve(): void {
    const what = this.settle();
    if (what === 'levelup') {
      this.phase = 'levelup';
      this.phaseT = 0;
      this.introSent = false;
    } else if (what === 'clear') {
      this.enterFinale();
    } else if (what === 'next') {
      this.spawn();
    }
  }
}
