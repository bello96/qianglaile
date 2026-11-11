import { clamp, percentile } from '../util/math';
import type { JointName, Skeleton } from './pose';

/**
 * 一个人的身材：各段骨头的长度和肢体粗细，单位是"模型的米"
 * （MediaPipe 世界坐标的尺度，对谁都差不多是成年人大小，所以它描述的其实是比例）。
 *
 * 墙洞按这份身材量身挖：同一个姿势，长臂的人洞就开得宽一点。
 */
export interface BodyProfile {
  shoulderW: number;
  hipW: number;
  /** 肩中点到髋中点 */
  torso: number;
  /** 肩中点到头中心 */
  neck: number;
  headR: number;
  upperArm: number;
  forearm: number;
  /** 腕到手掌中心 */
  hand: number;
  thigh: number;
  shin: number;
  foot: number;
  /** 各部位的半径（把骨架"加粗"成身体轮廓时用） */
  r: {
    arm: number;
    forearm: number;
    hand: number;
    thigh: number;
    shin: number;
    foot: number;
    torso: number;
    shoulder: number;
    pelvis: number;
  };
}

/** 踝关节离地的高度。 */
export const ANKLE_H = 0.07;

/** 默认身材：对官方模型的真实输出量出来的平均值。 */
export function defaultProfile(): BodyProfile {
  return {
    shoulderW: 0.32,
    hipW: 0.2,
    torso: 0.5,
    neck: 0.19,
    headR: 0.11,
    upperArm: 0.26,
    forearm: 0.24,
    hand: 0.08,
    thigh: 0.37,
    shin: 0.38,
    foot: 0.16,
    r: { arm: 0.045, forearm: 0.04, hand: 0.05, thigh: 0.07, shin: 0.055, foot: 0.045, torso: 0.13, shoulder: 0.06, pelvis: 0.085 },
  };
}

/** 站直时髋的高度。 */
export const standHipHeight = (p: BodyProfile): number => p.thigh + p.shin + ANKLE_H;

/** 站直时头顶的高度。 */
export const standHeight = (p: BodyProfile): number => standHipHeight(p) + p.torso + p.neck + p.headR;

/** 整体缩放（比如造一个儿童比例的身材做测试）。 */
export function scaleProfile(p: BodyProfile, k: number): BodyProfile {
  const scaled = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(p)) {
    scaled[key] = typeof value === 'number' ? value * k : Object.fromEntries(Object.entries(value).map(([rk, rv]) => [rk, (rv as number) * k]));
  }
  return scaled as unknown as BodyProfile;
}

type Bone = 'shoulderW' | 'hipW' | 'torso' | 'neck' | 'upperArm' | 'forearm' | 'thigh' | 'shin';

/** 每种骨头由哪些关节对来量（左右两侧合并成一组样本）。 */
const BONE_PAIRS: Record<Bone, [JointName, JointName][]> = {
  shoulderW: [['shoulderL', 'shoulderR']],
  hipW: [['hipL', 'hipR']],
  torso: [['hipC', 'neck']],
  neck: [['neck', 'head']],
  upperArm: [['shoulderL', 'elbowL'], ['shoulderR', 'elbowR']],
  forearm: [['elbowL', 'wristL'], ['elbowR', 'wristR']],
  thigh: [['hipL', 'kneeL'], ['hipR', 'kneeR']],
  shin: [['kneeL', 'ankleL'], ['kneeR', 'ankleR']],
};
const BONES = Object.keys(BONE_PAIRS) as Bone[];

const WINDOW = 90;
const MIN_SAMPLES = 20;

/**
 * 从看到的骨架里估计这个人的身材。
 *
 * 难点：我们只看得到骨头在正面的**投影**。骨头朝向镜头时投影会变短，但永远不会比真实长度更长。
 * 所以不取平均，而取最近一批样本的 90 分位——接近"见过的最长"，又不会被个别噪声点带偏。
 */
export class ProfileEstimator {
  private readonly base: BodyProfile;
  private samples: Record<Bone, number[]>;

  constructor(base: BodyProfile = defaultProfile()) {
    this.base = base;
    this.samples = this.empty();
  }

  private empty(): Record<Bone, number[]> {
    return Object.fromEntries(BONES.map((b) => [b, [] as number[]])) as Record<Bone, number[]>;
  }

  observe(sk: Skeleton, ok: Record<JointName, boolean>): void {
    for (const bone of BONES) {
      for (const [a, b] of BONE_PAIRS[bone]) {
        if (!ok[a] || !ok[b]) continue;
        const list = this.samples[bone];
        list.push(Math.hypot(sk[a].x - sk[b].x, sk[a].y - sk[b].y));
        if (list.length > WINDOW) list.shift();
      }
    }
  }

  /** 手臂和躯干都攒够样本才算数——这两样坐着也看得到。 */
  get ready(): boolean {
    return this.samples.upperArm.length >= MIN_SAMPLES && this.samples.forearm.length >= MIN_SAMPLES && this.samples.torso.length >= MIN_SAMPLES;
  }

  get profile(): BodyProfile {
    const base = this.base;
    if (!this.ready) return scaleProfile(base, 1);

    const measured: Partial<Record<Bone, number>> = {};
    for (const bone of BONES) {
      if (this.samples[bone].length < MIN_SAMPLES) continue;
      measured[bone] = clamp(percentile(this.samples[bone], 0.9), base[bone] * 0.7, base[bone] * 1.4);
    }
    // 整体比例：量到的骨头相对默认值的平均倍数。没量到的骨头、以及粗细，都按它缩放
    const ratios = BONES.filter((b) => measured[b] !== undefined).map((b) => measured[b]! / base[b]);
    const k = ratios.reduce((a, b) => a + b, 0) / ratios.length;

    const out = scaleProfile(base, k);
    for (const bone of BONES) if (measured[bone] !== undefined) out[bone] = measured[bone]!;
    return out;
  }

  reset(): void {
    this.samples = this.empty();
  }
}
