/**
 * 一欧元滤波器（One Euro Filter，Casiez 等，2012）。
 *
 * 关键点天然有抖动。固定强度的低通滤波只能二选一：滤得重，手一快就"拖"；滤得轻，站着不动也在抖。
 * 一欧元滤波器让截止频率跟着速度走：
 *   cutoff = minCutoff + beta · |速度|
 * 动得慢 → 截止频率低 → 强力去抖；动得快 → 截止频率高 → 几乎不滤、跟手。
 *
 * - minCutoff：静止时的截止频率（Hz）。越小越稳，但慢动作越"黏"。
 * - beta：速度对截止频率的增益。越大快动作越跟手，但快动作时抖动也放进来更多。
 * - dCutoff：估计速度时用的截止频率，一般不用动。
 */
export interface OneEuroOpts {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

const DEFAULTS: OneEuroOpts = { minCutoff: 1.5, beta: 3, dCutoff: 1.2 };

/** 一阶低通在采样间隔 dt 下的平滑系数。 */
const alpha = (cutoff: number, dt: number): number => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

export class OneEuro {
  private readonly opts: OneEuroOpts;
  private x = 0;
  private dx = 0;
  private lastT = 0;
  private started = false;

  constructor(opts: Partial<OneEuroOpts> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  filter(value: number, tSec: number): number {
    if (!this.started) {
      this.started = true;
      this.x = value;
      this.dx = 0;
      this.lastT = tSec;
      return value;
    }
    const dt = tSec - this.lastT;
    if (!(dt > 0)) return this.x; // 时间没前进：不更新，避免除以零
    this.lastT = tSec;
    const rate = (value - this.x) / dt;
    this.dx += alpha(this.opts.dCutoff, dt) * (rate - this.dx);
    this.x += alpha(this.opts.minCutoff + this.opts.beta * Math.abs(this.dx), dt) * (value - this.x);
    return this.x;
  }

  reset(): void {
    this.started = false;
  }
}

/** 一组互相独立的分量共用一个时间戳（比如 33 个关键点的 x、y、z）。 */
export class OneEuroArray {
  private readonly opts: OneEuroOpts;
  private readonly x: Float64Array;
  private readonly dx: Float64Array;
  private lastT = 0;
  private started = false;

  constructor(
    private readonly n: number,
    opts: Partial<OneEuroOpts> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.x = new Float64Array(n);
    this.dx = new Float64Array(n);
  }

  filter(input: ArrayLike<number>, tSec: number, out: Float32Array = new Float32Array(this.n)): Float32Array {
    const { x, dx, n } = this;
    if (!this.started) {
      this.started = true;
      this.lastT = tSec;
      for (let i = 0; i < n; i++) {
        x[i] = input[i];
        dx[i] = 0;
      }
    } else {
      const dt = tSec - this.lastT;
      if (dt > 0) {
        this.lastT = tSec;
        const ad = alpha(this.opts.dCutoff, dt);
        for (let i = 0; i < n; i++) {
          const rate = (input[i] - x[i]) / dt;
          dx[i] += ad * (rate - dx[i]);
          x[i] += alpha(this.opts.minCutoff + this.opts.beta * Math.abs(dx[i]), dt) * (input[i] - x[i]);
        }
      }
    }
    for (let i = 0; i < n; i++) out[i] = x[i];
    return out;
  }

  reset(): void {
    this.started = false;
  }
}
