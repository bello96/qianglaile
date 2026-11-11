import { Emitter } from '../util/emitter';
import { median } from '../util/math';
import { decodePose, type Recording } from './recorder';
import type { PoseSource, RawFrame, SourceStats } from './types';

/** 把一段录制按原来的节奏重新放出来。对下游来说它和摄像头没有区别。 */
export class ReplayPoseSource implements PoseSource {
  readonly kind = 'replay' as const;
  readonly video = null;

  private readonly frames = new Emitter<RawFrame>();
  private readonly rec: Recording;
  private readonly loop: boolean;
  /** 一帧的典型间隔：循环播放时首尾之间隔这么久 */
  private readonly interval: number;
  private readonly duration: number;

  private clock = 0;
  private base = 0;
  private index = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(rec: Recording, opts: { loop?: boolean } = {}) {
    this.rec = rec;
    this.loop = opts.loop ?? false;
    const ts = rec.frames.map((f) => f.t);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]);
    this.interval = gaps.length ? median(gaps) : 33;
    this.duration = ts.length ? ts[ts.length - 1] - ts[0] : 0;
  }

  get done(): boolean {
    return this.rec.frames.length === 0 || (!this.loop && this.index >= this.rec.frames.length);
  }

  /** 推进 dtMs 毫秒，把这段时间里该出的帧都发出去；返回最后发出的那一帧，没有则返回 null。 */
  step(dtMs: number): RawFrame | null {
    const frames = this.rec.frames;
    if (!frames.length) return null;
    this.clock += dtMs;
    let last: RawFrame | null = null;
    for (let guard = 0; guard < 10000; guard++) {
      if (this.index >= frames.length) {
        if (!this.loop || this.clock < this.duration + this.interval) break;
        // 回到开头：时间戳接着往后排，保证单调递增
        this.clock -= this.duration + this.interval;
        this.base += this.duration + this.interval;
        this.index = 0;
      }
      const f = frames[this.index];
      const rel = f.t - frames[0].t;
      if (rel > this.clock) break;
      last = { t: this.base + rel, aspect: this.rec.aspect, poses: f.poses.map(decodePose) };
      this.index++;
      this.frames.emit(last);
    }
    return last;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(16), 16);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onFrame(cb: (f: RawFrame) => void): () => void {
    return this.frames.on(cb);
  }

  stats(): SourceStats {
    return { fps: Math.round(1000 / this.interval), detectMs: 0, delegate: 'replay', model: 'replay' };
  }
}
