import { LM, LM_COUNT } from '../body/landmarks';
import { lerpSkeleton, NEUTRAL, poseToSkeleton, type PoseSpec, type Skeleton } from '../body/pose';
import { defaultProfile, type BodyProfile } from '../body/profile';
import { Emitter } from '../util/emitter';
import type { Vec3 } from '../util/math';
import { createRng, type Rng } from '../util/rng';
import type { Lm, PoseSource, RawFrame, RawPose, SourceStats } from './types';

/**
 * 模拟玩家：不开摄像头、没有真人，也能产出和识别模型一模一样格式的数据。
 *
 * 做法是把真实流水线反过来走一遍——
 *   姿势（关节角）→ 骨架 → 33 个关键点 → 虚拟摄像头投影成"图像坐标 + 世界坐标"
 * 所以下游（换算、滤波、判定、游戏）完全分不清数据是真是假。
 * 用途：自动化测试整局游戏、没摄像头时的演示模式、开发时不用起身。
 */

/** 虚拟摄像头：u = aspect/2 − x·s，v = groundV − y·s（u、v 以画面高度为单位）。 */
export interface SimCamera {
  aspect: number;
  /** 每米占多少个画面高度。0.42 ≈ 站在两三米外，全身占画面七成 */
  s: number;
  /** 地面在画面里的高度（0 顶 1 底）。大于 1 表示脚在画面外 */
  groundV: number;
}

export const DEFAULT_SIM_CAMERA: SimCamera = { aspect: 16 / 9, s: 0.42, groundV: 0.95 };

/** 把 19 个关节的骨架补成 MediaPipe 的 33 个点（鼻子、眼睛、耳朵、指根、脚跟……）。 */
export function skeletonToJoints33(sk: Skeleton, p: BodyProfile): { joints: Vec3[]; vis: number[] } {
  const joints: Vec3[] = Array.from({ length: LM_COUNT }, () => ({ x: 0, y: 0, z: 0 }));
  const set = (i: number, x: number, y: number, z: number) => {
    joints[i] = { x, y, z };
  };
  const copy = (i: number, v: Vec3, dz = 0) => set(i, v.x, v.y, v.z + dz);
  const h = sk.head;
  const face = -p.headR * 0.85; // 脸朝 -z

  set(LM.nose, h.x, h.y, h.z - p.headR);
  for (const [base, side] of [[1, -1], [4, 1]] as const) {
    // 每只眼睛三个点：内、中、外
    for (let k = 0; k < 3; k++) set(base + k, h.x + side * (0.02 + 0.012 * k), h.y + 0.03, h.z + face);
  }
  set(LM.leftEar, h.x - p.headR * 0.9, h.y, h.z);
  set(LM.rightEar, h.x + p.headR * 0.9, h.y, h.z);
  set(9, h.x - 0.03, h.y - 0.045, h.z + face);
  set(10, h.x + 0.03, h.y - 0.045, h.z + face);

  copy(LM.leftShoulder, sk.shoulderL);
  copy(LM.rightShoulder, sk.shoulderR);
  copy(LM.leftElbow, sk.elbowL);
  copy(LM.rightElbow, sk.elbowR);
  copy(LM.leftWrist, sk.wristL);
  copy(LM.rightWrist, sk.wristR);

  // 手：食指根和小指根分列手掌中心两侧（垂直于前臂方向），拇指在腕和掌之间
  const hand = (wrist: Vec3, palm: Vec3, pinky: number, index: number, thumb: number) => {
    const dx = palm.x - wrist.x;
    const dy = palm.y - wrist.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = (-dy / len) * 0.02;
    const py = (dx / len) * 0.02;
    set(index, palm.x + px, palm.y + py, palm.z);
    set(pinky, palm.x - px, palm.y - py, palm.z);
    set(thumb, (wrist.x + palm.x) / 2 + px * 1.5, (wrist.y + palm.y) / 2 + py * 1.5, palm.z);
  };
  hand(sk.wristL, sk.handL, LM.leftPinky, LM.leftIndex, 21);
  hand(sk.wristR, sk.handR, LM.rightPinky, LM.rightIndex, 22);

  copy(LM.leftHip, sk.hipL);
  copy(LM.rightHip, sk.hipR);
  copy(LM.leftKnee, sk.kneeL);
  copy(LM.rightKnee, sk.kneeR);
  copy(LM.leftAnkle, sk.ankleL);
  copy(LM.rightAnkle, sk.ankleR);
  set(LM.leftHeel, sk.ankleL.x, sk.ankleL.y - 0.05, sk.ankleL.z + 0.04);
  set(LM.rightHeel, sk.ankleR.x, sk.ankleR.y - 0.05, sk.ankleR.z + 0.04);
  copy(LM.leftFoot, sk.toeL, -0.1);
  copy(LM.rightFoot, sk.toeR, -0.1);

  return { joints, vis: new Array<number>(LM_COUNT).fill(0.99) };
}

/** 虚拟摄像头"拍"一下：舞台空间的 33 个点 → 模型会输出的图像坐标和世界坐标。是 toMetric 的逆运算。 */
export function jointsToRawPose(joints: Vec3[], vis: number[], cam: SimCamera, zGain = 0.6): RawPose {
  const hipX = (joints[LM.leftHip].x + joints[LM.rightHip].x) / 2;
  const hipY = (joints[LM.leftHip].y + joints[LM.rightHip].y) / 2;
  const image: Lm[] = [];
  const world: Lm[] = [];
  for (let i = 0; i < joints.length; i++) {
    const j = joints[i];
    const wz = j.z / zGain;
    image.push({ x: (cam.aspect / 2 - j.x * cam.s) / cam.aspect, y: cam.groundV - j.y * cam.s, z: wz, v: vis[i] });
    world.push({ x: -(j.x - hipX), y: -(j.y - hipY), z: wz, v: vis[i] });
  }
  return { image, world };
}

const LEG_POINTS = [LM.leftKnee, LM.rightKnee, LM.leftAnkle, LM.rightAnkle, LM.leftHeel, LM.rightHeel, LM.leftFoot, LM.rightFoot];
const smoothstep = (k: number): number => k * k * (3 - 2 * k);

export interface SimOptions {
  cam?: Partial<SimCamera>;
  profile?: BodyProfile;
  /** 关键点噪声的标准差（米），默认 0.008——和真实模型的抖动差不多 */
  noise?: number;
  seed?: number;
  fps?: number;
  /** false：腿不可见（模拟坐在桌前） */
  legs?: boolean;
  /** 模拟几个人，默认 1。2 = 双人模式：0 号站在屏幕左边，1 号站在右边 */
  people?: 1 | 2;
  /** 两个人隔多远（米），默认 1.5 */
  gap?: number;
}

/** 一个模拟出来的人：正从 from 过渡到 to。 */
interface Actor {
  /** 他平时站的位置（舞台 x） */
  homeX: number;
  from: Skeleton;
  to: Skeleton;
  blend: number;
  blendDur: number;
  present: boolean;
}

export class SimPoseSource implements PoseSource {
  readonly kind = 'sim' as const;
  readonly video = null;

  private readonly cam: SimCamera;
  private readonly profile: BodyProfile;
  private readonly noise: number;
  private readonly fps: number;
  private readonly legs: boolean;
  private readonly rng: Rng;
  private readonly frames = new Emitter<RawFrame>();

  private readonly actors: Actor[];
  private lift = 0;
  private t = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SimOptions = {}) {
    this.cam = { ...DEFAULT_SIM_CAMERA, ...opts.cam };
    this.profile = opts.profile ?? defaultProfile();
    this.noise = opts.noise ?? 0.008;
    this.fps = opts.fps ?? 30;
    this.legs = opts.legs ?? true;
    this.rng = createRng(opts.seed ?? 1);
    const gap = opts.gap ?? 1.5;
    // 一个人站在正中；两个人一左一右（0 号在舞台 x 为负的那边，也就是屏幕左边）
    const homes = opts.people === 2 ? [-gap / 2, gap / 2] : [0];
    this.actors = homes.map((homeX) => {
      const standing = poseToSkeleton(NEUTRAL, this.profile, { x: homeX });
      return { homeX, from: standing, to: standing, blend: 1, blendDur: 0, present: true };
    });
  }

  private current(a: Actor): Skeleton {
    return a.blend >= 1 ? a.to : lerpSkeleton(a.from, a.to, smoothstep(a.blend));
  }

  /**
   * 摆一个姿势；blendSec 秒内从当前姿势平滑过渡过去。
   * at.x 是舞台坐标（不给就回到他平时站的位置）；who 是第几个人（双人时 0 / 1）。
   */
  setPose(spec: PoseSpec, at: { x?: number } = {}, blendSec = 0.25, who: 0 | 1 = 0): void {
    const a = this.actors[who];
    if (!a) return;
    a.from = this.current(a);
    a.to = poseToSkeleton(spec, this.profile, { x: at.x ?? a.homeX });
    a.blendDur = Math.max(0, blendSec);
    a.blend = a.blendDur > 0 ? 0 : 1;
  }

  /** 整个人离地多少米（模拟跳起）。 */
  setLift(metres: number): void {
    this.lift = metres;
  }

  /** 走出 / 回到画面。不说是谁（who）就是所有人。 */
  setPresent(on: boolean, who?: 0 | 1): void {
    this.actors.forEach((a, i) => {
      if (who === undefined || who === i) a.present = on;
    });
  }

  /** 推进 dtMs 毫秒并产出一帧。测试里手动调用；start() 之后由定时器调用。 */
  step(dtMs: number): RawFrame {
    this.t += dtMs;
    const poses: RawPose[] = [];
    for (const a of this.actors) {
      if (a.blend < 1) a.blend = Math.min(1, a.blend + dtMs / 1000 / a.blendDur);
      if (!a.present) continue;
      const { joints, vis } = skeletonToJoints33(this.current(a), this.profile);
      for (const j of joints) {
        j.x += this.noise * this.rng.gauss();
        j.y += this.noise * this.rng.gauss() + this.lift;
        j.z += this.noise * this.rng.gauss();
      }
      if (!this.legs) for (const i of LEG_POINTS) vis[i] = 0.1;
      poses.push(jointsToRawPose(joints, vis, this.cam));
    }
    const frame: RawFrame = { t: this.t, aspect: this.cam.aspect, poses };
    this.frames.emit(frame);
    return frame;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    const dt = 1000 / this.fps;
    this.timer = setInterval(() => this.step(dt), dt);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onFrame(cb: (f: RawFrame) => void): () => void {
    return this.frames.on(cb);
  }

  stats(): SourceStats {
    return { fps: this.fps, detectMs: 0, delegate: 'sim', model: 'sim', people: this.actors.length };
  }
}
