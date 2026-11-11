import type { Lm, PoseSource, RawFrame, RawPose } from './types';

/**
 * 一段录下来的识别数据。**只有关键点的数字，没有任何画面。**
 * 每个人压成一维数组：33 个图像点 (x, y, z, v) 接 33 个世界点 (x, y, z)，保留 4 位小数。
 * 用途：把真人的动作存成测试夹具，以后调判定、调滤波都能反复回放同一段数据。
 */
export interface Recording {
  version: 1;
  aspect: number;
  frames: { t: number; poses: number[][] }[];
}

const POINTS = 33;
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

export function encodePose(pose: RawPose): number[] {
  const out: number[] = [];
  for (const l of pose.image) out.push(round4(l.x), round4(l.y), round4(l.z), round4(l.v));
  for (const l of pose.world) out.push(round4(l.x), round4(l.y), round4(l.z));
  return out;
}

export function decodePose(flat: number[]): RawPose {
  const image: Lm[] = [];
  const world: Lm[] = [];
  for (let i = 0; i < POINTS; i++) {
    const v = flat[i * 4 + 3];
    image.push({ x: flat[i * 4], y: flat[i * 4 + 1], z: flat[i * 4 + 2], v });
    const w = POINTS * 4 + i * 3;
    world.push({ x: flat[w], y: flat[w + 1], z: flat[w + 2], v });
  }
  return { image, world };
}

/** 一个人压平后有多少个数 */
const FLAT_LENGTH = POINTS * 4 + POINTS * 3;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * 检查一份从文件里读出来的数据是不是一段录制。是就原样返回，不是返回 null。
 * 文件可能是别的什么 JSON，也可能被改坏了——不查就拿去回放，画出来的是一堆乱线。
 */
export function parseRecording(input: unknown): Recording | null {
  if (typeof input !== 'object' || input === null) return null;
  const { version, aspect, frames } = input as Partial<Recording>;
  if (version !== 1 || !isNumber(aspect) || aspect <= 0 || !Array.isArray(frames)) return null;
  let prev = -Infinity;
  for (const f of frames as unknown[]) {
    if (typeof f !== 'object' || f === null) return null;
    const { t, poses } = f as { t?: unknown; poses?: unknown };
    if (!isNumber(t) || !Array.isArray(poses)) return null;
    // 时间必须一帧比一帧晚。不往前走的时间戳会让循环回放原地打转，把页面卡死
    if (t <= prev) return null;
    prev = t;
    for (const flat of poses as unknown[]) {
      if (!Array.isArray(flat) || flat.length !== FLAT_LENGTH || !flat.every(isNumber)) return null;
    }
  }
  return input as Recording;
}

export class FrameRecorder {
  /** 最多录多少帧，录满自己停（默认 9000 帧，每秒 30 帧的话是五分钟）。忘了点"停止"也不会把内存吃光 */
  readonly maxFrames: number;
  private frames: Recording['frames'] = [];
  private aspect = 16 / 9;
  private off: (() => void) | null = null;

  constructor(opts: { maxFrames?: number } = {}) {
    this.maxFrames = opts.maxFrames ?? 9000;
  }

  /** 录满了 */
  get full(): boolean {
    return this.frames.length >= this.maxFrames;
  }

  get recording(): boolean {
    return this.off !== null;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  start(source: PoseSource): void {
    this.off?.();
    this.frames = [];
    this.off = source.onFrame((f: RawFrame) => {
      if (this.full) return;
      this.aspect = f.aspect;
      this.frames.push({ t: round4(f.t), poses: f.poses.map(encodePose) });
    });
  }

  stop(): Recording {
    this.off?.();
    this.off = null;
    return { version: 1, aspect: this.aspect, frames: this.frames };
  }
}
