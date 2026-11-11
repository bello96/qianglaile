import { BodyBuilder, type Body, type ViewWindow } from '../body/bodyModel';
import { JOINTS, type JointName, type Skeleton } from '../body/pose';
import { defaultProfile, ProfileEstimator, type BodyProfile } from '../body/profile';
import type { RawFrame } from '../input/types';
import { MotionAnalyzer, type Motion, type MotionEvent } from '../motion/features';
import { PersonSelector } from '../tracking/selectPerson';
import { clamp, damp } from '../util/math';

/** 游戏每帧读到的"玩家状态"。游戏只认识它，不认识识别库。 */
export interface PlayerState {
  /** 这一帧的时间戳（毫秒，来自姿态源） */
  t: number;
  /** 玩家在不在（短暂丢帧不算不在） */
  present: boolean;
  /** 已经多久没看到玩家 */
  lostMs: number;
  /** 这一帧的身体；这一帧没识别到就是 null */
  body: Body | null;
  motion: Motion;
  /** 这一帧发生的动作事件 */
  events: Set<MotionEvent>;
  profile: BodyProfile;
  /** 身材是否已经量出来了（没量出来时 profile 是默认身材） */
  profileReady: boolean;
}

const PRESENT_GRACE_MS = 300;
const FOLLOW_RATE = 30; // 1/秒：渲染帧追向最新识别结果的速度
const LEG_JOINTS: JointName[] = ['kneeL', 'kneeR', 'ankleL', 'ankleR', 'toeL', 'toeR'];

/**
 * 流水线的中段：原始识别帧 → 玩家状态。
 *   选人（跟住同一个人）→ 身体模型（换算成米、落地、滤波）→ 身材估计 → 动作特征
 *
 * 另外提供 sample()：识别每秒只有十几到三十次，而画面每秒刷新 60 次。
 * 渲染时不直接用最新的识别结果（会一顿一顿的），而是让显示用的骨架平滑地追过去。
 */
export class PlayerTracker {
  private readonly base: BodyProfile;
  private readonly selector = new PersonSelector();
  private readonly builder = new BodyBuilder();
  private readonly estimator: ProfileEstimator;
  private readonly analyzer = new MotionAnalyzer();

  private frozen: BodyProfile | null = null;
  private lastSeen: number | null = null;
  private lastView: ViewWindow | null = null;
  private firstT: number | null = null;
  private target: Skeleton | null = null;
  private display: Skeleton | null = null;
  private lastSampleMs: number | null = null;
  private current: PlayerState;

  constructor(opts: { profile?: BodyProfile } = {}) {
    this.base = opts.profile ?? defaultProfile();
    this.estimator = new ProfileEstimator(this.base);
    this.current = this.blank();
  }

  private blank(): PlayerState {
    return { t: 0, present: false, lostMs: 0, body: null, motion: MotionAnalyzer.idle(), events: new Set(), profile: this.profile(), profileReady: false };
  }

  private profile(): BodyProfile {
    return this.frozen ?? this.estimator.profile;
  }

  get state(): PlayerState {
    return this.current;
  }

  /** 每来一帧识别结果调用一次。 */
  ingest(frame: RawFrame): PlayerState {
    if (this.firstT === null) this.firstT = frame.t;
    const profile = this.profile();
    const pose = this.selector.pick(frame);
    const body = pose ? this.builder.update(pose, frame.t, frame.aspect, profile) : null;

    let motion = this.current.motion;
    let events = new Set<MotionEvent>();
    if (body) {
      this.lastSeen = frame.t;
      this.lastView = body.view;
      this.target = body.skeleton;
      if (!this.frozen) {
        // 半身模式下的腿是补出来的，不能拿来量腿长
        const ok = body.mode === 'upper' ? { ...body.ok, ...Object.fromEntries(LEG_JOINTS.map((j) => [j, false])) } : body.ok;
        this.estimator.observe(body.skeleton, ok);
      }
      ({ motion, events } = this.analyzer.update(body, profile));
    }

    const lostMs = frame.t - (this.lastSeen ?? this.firstT);
    this.current = {
      t: frame.t,
      present: this.lastSeen !== null && lostMs < PRESENT_GRACE_MS,
      lostMs,
      body,
      motion,
      events,
      profile: this.profile(),
      profileReady: this.frozen !== null || this.estimator.ready,
    };
    return this.current;
  }

  /**
   * 标定：把玩家现在站的位置记为 x = 0，并把量到的身材定下来（之后不再变）。
   * 返回"摄像头看得见的范围"——已经换算到新原点（还没见过人时返回 null）。
   * 一定要用这里返回的，不要用标定前那一帧的 body.view：那是相对旧原点量的，玩家挪过位置的话左右是歪的。
   */
  calibrate(): ViewWindow | null {
    // 从现在起只认这个位置附近的人：跟丢之后旁人入镜，不会被当成玩家（见 PersonSelector）
    this.selector.lock();
    const shift = this.builder.setHome();
    this.frozen = this.estimator.profile;
    this.current = { ...this.current, profile: this.frozen, profileReady: true };
    if (!this.lastView) return null;
    this.lastView = { ...this.lastView, left: this.lastView.left - shift, right: this.lastView.right - shift };
    return this.lastView;
  }

  /**
   * 认准 / 不再认准玩家现在站的位置（见 PersonSelector 的"锁定"）。calibrate() 会自动认准；
   * 一局结束后可以放开——那时人可能走到别处去举手点按钮了；再开一局时重新认准。
   */
  lock(): void {
    this.selector.lock();
  }

  unlock(): void {
    this.selector.unlock();
  }

  setMode(mode: 'auto' | 'full' | 'upper'): void {
    this.builder.forceMode = mode;
  }

  /**
   * 渲染帧调用：返回平滑追随后的骨架（每次都是新对象）。nowMs 用渲染时钟即可，只看前后两次的差。
   * 还没见过玩家时返回 null。
   */
  sample(nowMs: number): Skeleton | null {
    if (!this.target) return null;
    if (!this.display) {
      this.display = cloneSkeleton(this.target);
    } else {
      const dt = clamp((nowMs - (this.lastSampleMs ?? nowMs)) / 1000, 0, 0.1);
      for (const j of JOINTS) {
        const d = this.display[j];
        const t = this.target[j];
        d.x = damp(d.x, t.x, FOLLOW_RATE, dt);
        d.y = damp(d.y, t.y, FOLLOW_RATE, dt);
        d.z = damp(d.z, t.z, FOLLOW_RATE, dt);
      }
    }
    this.lastSampleMs = nowMs;
    return cloneSkeleton(this.display);
  }

  reset(): void {
    this.selector.reset();
    this.builder.reset();
    this.estimator.reset();
    this.analyzer.reset();
    this.frozen = null;
    this.lastSeen = this.firstT = this.lastSampleMs = null;
    this.lastView = null;
    this.target = this.display = null;
    this.current = this.blank();
  }
}

function cloneSkeleton(sk: Skeleton): Skeleton {
  const out = {} as Skeleton;
  for (const j of JOINTS) out[j] = { ...sk[j] };
  return out;
}
