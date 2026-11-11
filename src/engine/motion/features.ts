import type { Body } from '../body/bodyModel';
import { LM } from '../body/landmarks';
import type { JointName, Skeleton } from '../body/pose';
import { ANKLE_H, standHipHeight, type BodyProfile } from '../body/profile';
import { clamp, clamp01, rad2deg } from '../util/math';

/**
 * 动作特征：把"关节在哪"翻译成游戏好用的两类信号。
 *
 * - 连续量（Motion）：一个 0～1（或 −1～1）的强度，可以直接当摇杆用。
 * - 事件（MotionEvent）：这一帧"发生了一次"。
 *
 * 因为骨架已经换算成米，这里的阈值都是实际尺寸，不用再除以躯干长度；站远站近结果一样。
 * 事件一律用**回滞**判定：越过高阈值才触发，回落到低阈值以下才允许下一次。
 * 只用一个阈值的话，数值在阈值附近抖一下就会连着触发好几次。
 */
export interface Motion {
  /** 活动量：0 = 站着不动，1 = 全身大幅运动 */
  energy: number;
  /** 侧倾：−1 = 向左倒 30°，+1 = 向右倒 30° */
  lean: number;
  /** 举臂：−1 垂下，0 平举，+1 举过头 */
  armLiftL: number;
  armLiftR: number;
  /** 下蹲：0 站直，1 = 髋降了 45% */
  squat: number;
  /** 双脚间距，以肩宽为单位 */
  feetApart: number;
  /** 抬膝：0 = 膝在站立高度，1 = 大腿抬平 */
  kneeLiftL: number;
  kneeLiftR: number;
}

export type MotionEvent = 'jump' | 'squatDown' | 'squatUp' | 'handUpL' | 'handUpR';

const ENERGY_JOINTS: JointName[] = ['wristL', 'wristR', 'elbowL', 'elbowR', 'kneeL', 'kneeR', 'ankleL', 'ankleR', 'head'];
const SPEED_CAP = 3; // 米/秒。单个关键点"飞"一下不该把活动量顶满
const NOISE_FLOOR = 0.12; // 米/秒。滤波后残留的抖动大约这么多，减掉它静止时才是 0
const ENERGY_TAU = 0.2;

const SQUAT_DOWN = 0.45;
const SQUAT_UP = 0.15;
const HAND_UP = 0.6;
const HAND_REARM = 0.4;
const JUMP_RISE = 0.09; // 米
const JUMP_REARM = 0.03;
const JUMP_COOLDOWN_MS = 400;
const JUMP_BASELINE_TAU = 0.7;

const zeroMotion = (): Motion => ({ energy: 0, lean: 0, armLiftL: 0, armLiftR: 0, squat: 0, feetApart: 0, kneeLiftL: 0, kneeLiftR: 0 });

export class MotionAnalyzer {
  private prev: { sk: Skeleton; t: number } | null = null;
  private energy = 0;
  // 状态从"不知道"开始：要先看到站直 / 手放下，之后的蹲下 / 举手才算数。
  // 否则分析器一启动、人正好蹲着或举着手，就会凭空报出事件。
  private squat: 'unknown' | 'up' | 'down' = 'unknown';
  private hand = { L: 'unknown', R: 'unknown' } as Record<'L' | 'R', 'unknown' | 'down' | 'up'>;
  private jump = { baseline: NaN, mode: '' as string, armed: true, lastAt: -Infinity };

  update(body: Body, p: BodyProfile): { motion: Motion; events: Set<MotionEvent> } {
    const sk = body.skeleton;
    const events = new Set<MotionEvent>();
    const dt = this.prev ? clamp((body.t - this.prev.t) / 1000, 0.005, 0.25) : 0;

    // ---- 活动量 ----
    if (this.prev && dt > 0) {
      let sum = 0;
      let n = 0;
      for (const j of ENERGY_JOINTS) {
        if (!body.ok[j]) continue;
        const a = this.prev.sk[j];
        sum += Math.min(SPEED_CAP, Math.hypot(sk[j].x - a.x, sk[j].y - a.y) / dt);
        n++;
      }
      const target = n ? clamp01((sum / n - NOISE_FLOOR) / 1.4) : 0;
      this.energy += (target - this.energy) * (1 - Math.exp(-dt / ENERGY_TAU));
    }

    // ---- 几何量 ----
    const reach = p.upperArm + p.forearm;
    const standHip = standHipHeight(p);
    const motion: Motion = {
      energy: this.energy,
      lean: clamp(rad2deg(Math.atan2(sk.neck.x - sk.hipC.x, sk.neck.y - sk.hipC.y)) / 30, -1, 1),
      armLiftL: clamp((sk.wristL.y - sk.shoulderL.y) / reach, -1, 1),
      armLiftR: clamp((sk.wristR.y - sk.shoulderR.y) / reach, -1, 1),
      squat: clamp01((standHip - body.root.y) / (0.45 * standHip)),
      feetApart: Math.abs(sk.ankleL.x - sk.ankleR.x) / p.shoulderW,
      kneeLiftL: clamp01((sk.kneeL.y - (ANKLE_H + p.shin)) / (0.8 * p.thigh)),
      kneeLiftR: clamp01((sk.kneeR.y - (ANKLE_H + p.shin)) / (0.8 * p.thigh)),
    };

    // ---- 蹲 / 起 ----
    if (this.squat === 'up' && motion.squat > SQUAT_DOWN) {
      this.squat = 'down';
      events.add('squatDown');
    } else if (this.squat !== 'up' && motion.squat < SQUAT_UP) {
      if (this.squat === 'down') events.add('squatUp');
      this.squat = 'up';
    }

    // ---- 举手 ----
    for (const side of ['L', 'R'] as const) {
      const lift = side === 'L' ? motion.armLiftL : motion.armLiftR;
      const seen = body.ok[side === 'L' ? 'wristL' : 'wristR'];
      if (this.hand[side] === 'down' && seen && lift > HAND_UP) {
        this.hand[side] = 'up';
        events.add(side === 'L' ? 'handUpL' : 'handUpR');
      } else if (this.hand[side] !== 'down' && lift < HAND_REARM) {
        this.hand[side] = 'down';
      }
    }

    // ---- 跳 ----
    // 骨架里的脚永远踩在地上（那是我们自己规定的），所以跳要回到图像坐标里看。
    // 看"较低的那只脚踝"离地没有：从深蹲站起来髋也会升高，但脚不会离地。看不到腿时退而看肩。
    const img = body.image;
    const feet = body.mode === 'full' && body.ok.ankleL && body.ok.ankleR;
    const refY = feet ? Math.max(img[LM.leftAnkle].y, img[LM.rightAnkle].y) : (img[LM.leftShoulder].y + img[LM.rightShoulder].y) / 2;
    const refMode = feet ? 'feet' : 'shoulders';
    if (this.jump.mode !== refMode || Number.isNaN(this.jump.baseline)) {
      this.jump.baseline = refY;
      this.jump.mode = refMode;
    }
    const rise = (this.jump.baseline - refY) / body.scale; // 图像 y 向下为正，所以"升高"是 baseline − 当前
    if (this.jump.armed && rise > JUMP_RISE && body.t - this.jump.lastAt >= JUMP_COOLDOWN_MS) {
      this.jump.armed = false;
      this.jump.lastAt = body.t;
      events.add('jump');
    } else if (!this.jump.armed && rise < JUMP_REARM) {
      this.jump.armed = true;
    }
    if (dt > 0) this.jump.baseline += (refY - this.jump.baseline) * (1 - Math.exp(-dt / JUMP_BASELINE_TAU));

    this.prev = { sk, t: body.t };
    return { motion, events };
  }

  reset(): void {
    this.prev = null;
    this.energy = 0;
    this.squat = 'unknown';
    this.hand = { L: 'unknown', R: 'unknown' };
    this.jump = { baseline: NaN, mode: '', armed: true, lastAt: -Infinity };
  }

  /** 还没有任何数据时的占位值。 */
  static idle(): Motion {
    return zeroMotion();
  }
}
