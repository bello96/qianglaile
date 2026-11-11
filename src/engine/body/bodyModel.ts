import type { RawPose } from '../input/types';
import { OneEuro, OneEuroArray, type OneEuroOpts } from '../tracking/oneEuro';
import type { Vec3 } from '../util/math';
import { LM } from './landmarks';
import { fitSimilarity, rescale, toMetric } from './metric';
import { JOINTS, NEUTRAL, poseToSkeleton, type JointName, type Skeleton } from './pose';
import { ANKLE_H, standHipHeight, type BodyProfile } from './profile';

/** 摄像头在玩家所站的平面上能看到的范围（舞台空间，米）。出墙时用它避开"看不见的地方"。 */
export interface ViewWindow {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/**
 * 一帧里的玩家身体——游戏真正使用的数据。
 * 坐标都在舞台空间：x 朝玩家右手（屏幕右）、y 朝上、地面 y = 0、标定位置 x = 0。
 */
export interface Body {
  t: number;
  skeleton: Skeleton;
  /** 每个关节这一帧看不看得清 */
  ok: Record<JointName, boolean>;
  /** 髋中心的位置（= skeleton.hipC） */
  root: Vec3;
  /** full：腿是真看到的；upper：只看到上半身，腿是按站姿补出来的 */
  mode: 'full' | 'upper';
  view: ViewWindow;
  /** 每米在画面里占多少个"画面高度"（越大说明人离镜头越近）。把图像里的位移换算成米时用 */
  scale: number;
  /** 镜像后的归一化图像坐标（x 已取 1−x），给 2D 游戏和摄像头小窗叠加用 */
  image: { x: number; y: number; v: number }[];
}

export interface BodyBuilderOpts {
  /** 深度压扁系数，见 toMetric */
  zGain?: number;
  /** 可见度高于它才算"看得清" */
  visOk?: number;
  filter?: Partial<OneEuroOpts>;
}

const N = JOINTS.length;
const LEG_JOINTS: JointName[] = ['kneeL', 'kneeR', 'ankleL', 'ankleR', 'toeL', 'toeR'];
const LEGS_HOLD_MS = 500;

/**
 * 原始关键点 → Body。依次做：
 *   1. 图像坐标换算成米（metric.ts）
 *   2. 33 个点整理成 19 个关节的骨架，看不清的手、头用邻近关节推
 *   3. 放到舞台上：左右位置相对标定原点，高度让较低的脚踩在地面
 *   4. 一欧元滤波去抖
 *   5. 腿看不见就进半身模式，补一双站着的腿
 */
export class BodyBuilder {
  /** auto：看得见腿就全身，否则半身 */
  forceMode: 'auto' | 'full' | 'upper' = 'auto';

  private readonly zGain: number;
  private readonly visOk: number;
  private readonly scale = new OneEuro({ minCutoff: 0.6, beta: 0.5 });
  private readonly xy: OneEuroArray;
  private readonly zf: OneEuroArray;
  private readonly rawXY = new Float32Array(N * 2);
  private readonly rawZ = new Float32Array(N);
  private readonly outXY = new Float32Array(N * 2);
  private readonly outZ = new Float32Array(N);

  private homeU: number | null = null;
  private lastTu: number | null = null;
  /** 玩家现在离原点多远（米，没滤波的） */
  private lastOffX = 0;
  private legs: boolean | null = null;
  private legsDifferSince: number | null = null;
  private lastOffY: number | null = null;

  constructor(opts: BodyBuilderOpts = {}) {
    this.zGain = opts.zGain ?? 0.6;
    this.visOk = opts.visOk ?? 0.5;
    this.xy = new OneEuroArray(N * 2, opts.filter);
    this.zf = new OneEuroArray(N, { minCutoff: 0.8, beta: 1 });
  }

  get hasHome(): boolean {
    return this.homeU !== null;
  }

  /**
   * 把玩家现在站的左右位置记为 x = 0（标定时调用）。
   * 返回原点挪了多少米：之前量出来的任何 x（包括可见范围的左右边）减去它，就是新坐标。
   */
  setHome(): number {
    const shift = this.lastOffX;
    this.homeU = this.lastTu;
    this.lastOffX = 0;
    // 原点变了，滤波器里记着的是旧坐标，清掉重来
    this.xy.reset();
    this.zf.reset();
    return shift;
  }

  reset(): void {
    // 全身还是半身，是上一次标定时按那时看到的画面定的；重来之后要按新看到的重新定
    this.forceMode = 'auto';
    this.homeU = this.lastTu = null;
    this.lastOffX = 0;
    this.legs = this.legsDifferSince = this.lastOffY = null;
    this.scale.reset();
    this.xy.reset();
    this.zf.reset();
  }

  update(pose: RawPose, tMs: number, aspect: number, profile: BodyProfile): Body | null {
    const fit = fitSimilarity(pose, aspect, this.visOk);
    if (!fit) return null;
    const tSec = tMs / 1000;
    const sim = rescale(fit, this.scale.filter(fit.s, tSec));
    const { joints: P, vis } = toMetric(pose, aspect, sim, this.zGain);
    const seen = (i: number): boolean => vis[i] >= this.visOk;

    // ---- 2. 整理成骨架（此时以髋为原点） ----
    const rel = {} as Skeleton;
    const ok = {} as Record<JointName, boolean>;
    const take = (j: JointName, i: number) => {
      rel[j] = { ...P[i] };
      ok[j] = seen(i);
    };
    const midOf = (a: number, b: number): Vec3 => ({ x: (P[a].x + P[b].x) / 2, y: (P[a].y + P[b].y) / 2, z: (P[a].z + P[b].z) / 2 });

    take('shoulderL', LM.leftShoulder);
    take('shoulderR', LM.rightShoulder);
    take('elbowL', LM.leftElbow);
    take('elbowR', LM.rightElbow);
    take('wristL', LM.leftWrist);
    take('wristR', LM.rightWrist);
    take('hipL', LM.leftHip);
    take('hipR', LM.rightHip);
    take('kneeL', LM.leftKnee);
    take('kneeR', LM.rightKnee);
    take('ankleL', LM.leftAnkle);
    take('ankleR', LM.rightAnkle);
    take('toeL', LM.leftFoot);
    take('toeR', LM.rightFoot);

    rel.neck = midOf(LM.leftShoulder, LM.rightShoulder);
    ok.neck = ok.shoulderL && ok.shoulderR;

    // 头：两耳中点最稳；侧着脸看不到耳朵时退而用鼻子
    const ears = seen(LM.leftEar) && seen(LM.rightEar);
    rel.head = ears ? midOf(LM.leftEar, LM.rightEar) : { x: P[LM.nose].x, y: P[LM.nose].y, z: P[LM.nose].z + profile.headR };
    ok.head = ears || seen(LM.nose);

    // 手掌中心：食指根和小指根的中点；看不清就沿前臂方向从手腕往外推
    const palm = (wrist: JointName, elbow: JointName, index: number, pinky: number): Vec3 => {
      if (seen(index) && seen(pinky)) return midOf(index, pinky);
      const dx = rel[wrist].x - rel[elbow].x;
      const dy = rel[wrist].y - rel[elbow].y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: rel[wrist].x + (dx / len) * profile.hand, y: rel[wrist].y + (dy / len) * profile.hand, z: rel[wrist].z };
    };
    rel.handL = palm('wristL', 'elbowL', LM.leftIndex, LM.leftPinky);
    rel.handR = palm('wristR', 'elbowR', LM.rightIndex, LM.rightPinky);
    ok.handL = ok.wristL;
    ok.handR = ok.wristR;

    // ---- 5a. 腿看不看得见（带滞回，免得被挡一下就来回切） ----
    const legsNow = ok.kneeL && ok.kneeR && ok.ankleL && ok.ankleR;
    if (this.legs === null) this.legs = legsNow;
    else if (legsNow === this.legs) this.legsDifferSince = null;
    else if (this.legsDifferSince === null) this.legsDifferSince = tMs;
    else if (tMs - this.legsDifferSince >= LEGS_HOLD_MS) {
      this.legs = legsNow;
      this.legsDifferSince = null;
    }
    const mode: 'full' | 'upper' = this.forceMode === 'auto' ? (this.legs ? 'full' : 'upper') : this.forceMode;

    // 髋：看不清时用拟合出来的原点（世界坐标的髋中心），它是由看得见的点推出来的
    if (!(ok.hipL && ok.hipR)) {
      rel.hipL = { x: -profile.hipW / 2, y: 0, z: 0 };
      rel.hipR = { x: profile.hipW / 2, y: 0, z: 0 };
    }
    rel.hipC = { x: (rel.hipL.x + rel.hipR.x) / 2, y: (rel.hipL.y + rel.hipR.y) / 2, z: (rel.hipL.z + rel.hipR.z) / 2 };
    ok.hipC = ok.hipL && ok.hipR;

    // ---- 5b. 半身模式：补一双站着的腿 ----
    if (mode === 'upper') {
      const stand = poseToSkeleton(NEUTRAL, profile);
      for (const j of LEG_JOINTS) {
        rel[j] = { x: rel.hipC.x + stand[j].x - stand.hipC.x, y: rel.hipC.y + stand[j].y - stand.hipC.y, z: rel.hipC.z };
        ok[j] = true;
      }
      ok.hipL = ok.hipR = ok.hipC = true;
    }

    // ---- 3. 放到舞台上 ----
    this.lastTu = sim.tu;
    if (this.homeU === null) this.homeU = sim.tu;
    const offX = -(sim.tu - this.homeU) / sim.s;
    this.lastOffX = offX;
    let offY: number;
    if (mode === 'upper') offY = standHipHeight(profile) - rel.hipC.y;
    else if (ok.ankleL && ok.ankleR) offY = ANKLE_H - Math.min(rel.ankleL.y, rel.ankleR.y); // 较低的脚踩地
    else offY = this.lastOffY ?? standHipHeight(profile) - rel.hipC.y;
    this.lastOffY = offY;

    // ---- 4. 滤波 ----
    for (let k = 0; k < N; k++) {
      const p = rel[JOINTS[k]];
      this.rawXY[k * 2] = p.x + offX;
      this.rawXY[k * 2 + 1] = p.y + offY;
      this.rawZ[k] = p.z;
    }
    this.xy.filter(this.rawXY, tSec, this.outXY);
    this.zf.filter(this.rawZ, tSec, this.outZ);

    const skeleton = {} as Skeleton;
    for (let k = 0; k < N; k++) skeleton[JOINTS[k]] = { x: this.outXY[k * 2], y: this.outXY[k * 2 + 1], z: this.outZ[k] };

    return {
      t: tMs,
      skeleton,
      ok,
      root: { ...skeleton.hipC },
      mode,
      view: {
        left: -(aspect - this.homeU) / sim.s,
        right: this.homeU / sim.s,
        bottom: -(1 - sim.tv) / sim.s + offY,
        top: sim.tv / sim.s + offY,
      },
      scale: sim.s,
      image: pose.image.map((l) => ({ x: 1 - l.x, y: l.y, v: l.v })),
    };
  }
}
