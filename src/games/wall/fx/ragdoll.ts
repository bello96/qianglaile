import { JOINTS, type JointName, type Skeleton } from '../../../engine/body/pose';

/**
 * 布娃娃：小人被墙撞到之后，不再是"整个人僵着翻出去"，而是四肢各甩各的。不碰画面，能直接测。
 *
 * 做法是最简单的那种（Verlet 积分 + 距离约束）：
 *   19 个关节各是一个有质量的点；骨架上相连的两个关节之间拉一根"定长的杆"；
 *   躯干再加几根斜撑，不然肩膀和骨盆会像纸片一样塌掉。
 *   每一小步：各点按惯性和重力走一步 → 反复把每根杆拉回原长 → 处理碰撞（浮台、墙面、水）。
 * 没有关节角度的限制，所以胳膊腿可能折成人做不到的角度——一个被泡沫墙拍下水的卡通小人，这样正好。
 */
export interface RagdollEnv {
  /** 浮台半宽（x）、半深（z）；顶面在 y = 0，中心在原点 */
  deckHalfW: number;
  deckHalfD: number;
  waterY: number;
}

const GRAVITY = 9.8;
/** 固定的小步长：外面给多长的 dt 都拆成这么长的步子走，结果不随帧率变 */
const STEP = 1 / 90;
/** 每一小步把所有的杆拉回原长这么多遍 */
const ITERATIONS = 8;
/** 关节当作这么大的球去碰台面 */
const RADIUS = 0.06;
/** 墙面推着人走时，关节的中心至少在墙面前面这么多 */
const WALL_CLEAR = 0.08;
/**
 * 被墙推着的关节，顺着墙的方向最多带上这么大的速度（米/秒）。
 * 墙是泡沫的，人是被"拱"下去的，不是被打飞的；后面关卡的墙每秒走八九米，全带上的话人会直接飞到镜头后面。
 */
const PUSH_CARRY = 1.7;
/** 浮台有多厚（顶面以下） */
const DECK_THICKNESS = 0.55;
/** 空气里每一小步留下的速度比例 */
const AIR_KEEP = 0.998;
/** 贴着台面时，每一小步留下的水平速度比例（摩擦） */
const DECK_KEEP = 0.82;
/** 水里：每一小步留下的速度比例；浮力是重力的多少倍（略大于 1：会慢慢浮上来，在水面晃） */
const WATER_KEEP = 0.9;
const BUOYANCY = 1.15;

/** 骨架上相连的关节（骨头）。 */
const BONES: [JointName, JointName][] = [
  ['head', 'neck'], ['neck', 'hipC'],
  ['neck', 'shoulderL'], ['neck', 'shoulderR'],
  ['shoulderL', 'elbowL'], ['elbowL', 'wristL'], ['wristL', 'handL'],
  ['shoulderR', 'elbowR'], ['elbowR', 'wristR'], ['wristR', 'handR'],
  ['hipC', 'hipL'], ['hipC', 'hipR'],
  ['hipL', 'kneeL'], ['kneeL', 'ankleL'], ['ankleL', 'toeL'],
  ['hipR', 'kneeR'], ['kneeR', 'ankleR'], ['ankleR', 'toeR'],
];
/** 躯干的斜撑：让肩线、骨盆、脖子和头保持相对位置。 */
const BRACES: [JointName, JointName][] = [
  ['shoulderL', 'shoulderR'], ['hipL', 'hipR'],
  ['shoulderL', 'hipL'], ['shoulderR', 'hipR'], ['shoulderL', 'hipR'], ['shoulderR', 'hipL'],
  ['shoulderL', 'hipC'], ['shoulderR', 'hipC'], ['neck', 'hipL'], ['neck', 'hipR'],
  ['head', 'shoulderL'], ['head', 'shoulderR'],
];

const N = JOINTS.length;
const INDEX = new Map<JointName, number>(JOINTS.map((j, i) => [j, i]));

export class Ragdoll {
  /** 现在的位置、上一小步的位置（两者之差就是速度） */
  private readonly p = new Float64Array(N * 3);
  private readonly q = new Float64Array(N * 3);
  private readonly links: { a: number; b: number; len: number }[];
  private owed = 0;

  constructor(
    sk: Skeleton,
    private readonly env: RagdollEnv,
  ) {
    JOINTS.forEach((j, i) => {
      this.p[i * 3] = this.q[i * 3] = sk[j].x;
      this.p[i * 3 + 1] = this.q[i * 3 + 1] = sk[j].y;
      this.p[i * 3 + 2] = this.q[i * 3 + 2] = sk[j].z;
    });
    this.links = [...BONES, ...BRACES].map(([ja, jb]) => {
      const a = INDEX.get(ja)!;
      const b = INDEX.get(jb)!;
      return { a, b, len: Math.hypot(this.p[a * 3] - this.p[b * 3], this.p[a * 3 + 1] - this.p[b * 3 + 1], this.p[a * 3 + 2] - this.p[b * 3 + 2]) };
    });
  }

  /**
   * 给全身一个初速度 v（米/秒），外加绕质心向后仰的转动 spin（弧度/秒）。
   * 墙是拍在上半身的，脚还踩着台面：所以越高的地方速度越大，人是向后倒下去的，不是平移出去的。
   */
  kick(v: { x: number; y: number; z: number }, spin: number): void {
    let lo = Infinity;
    let hi = -Infinity;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < N; i++) {
      lo = Math.min(lo, this.p[i * 3 + 1]);
      hi = Math.max(hi, this.p[i * 3 + 1]);
      cy += this.p[i * 3 + 1] / N;
      cz += this.p[i * 3 + 2] / N;
    }
    for (let i = 0; i < N; i++) {
      const up = (this.p[i * 3 + 1] - lo) / Math.max(1e-6, hi - lo);
      const share = 0.35 + 0.65 * up;
      // 绕 x 轴的转动：ω × r，头顶朝 +z（朝观众）甩，脚朝后
      const vy = v.y * share - spin * (this.p[i * 3 + 2] - cz);
      const vz = v.z * share + spin * (this.p[i * 3 + 1] - cy);
      this.q[i * 3] = this.p[i * 3] - v.x * share * STEP;
      this.q[i * 3 + 1] = this.p[i * 3 + 1] - vy * STEP;
      this.q[i * 3 + 2] = this.p[i * 3 + 2] - vz * STEP;
    }
  }

  /** 推进 dt 秒。wallZ：墙面现在在哪（墙推着人走，谁也不能留在墙后面）；null = 没有墙。 */
  step(dt: number, wallZ: number | null): void {
    this.owed += dt;
    while (this.owed >= STEP - 1e-9) {
      this.owed -= STEP;
      this.substep(wallZ);
    }
  }

  private substep(wallZ: number | null): void {
    const { p, q } = this;
    const { waterY } = this.env;

    // 1. 惯性 + 重力（水里：浮力和阻力）
    for (let i = 0; i < N; i++) {
      const k = i * 3;
      const wet = p[k + 1] < waterY;
      const keep = wet ? WATER_KEEP : AIR_KEEP;
      const g = wet ? GRAVITY * (BUOYANCY - 1) : -GRAVITY;
      for (let c = 0; c < 3; c++) {
        const now = p[k + c];
        p[k + c] = now + (now - q[k + c]) * keep + (c === 1 ? g * STEP * STEP : 0);
        q[k + c] = now;
      }
    }

    // 2. 把杆拉回原长，同时处理碰撞；反复几遍
    for (let it = 0; it < ITERATIONS; it++) {
      for (const { a, b, len } of this.links) {
        const ka = a * 3;
        const kb = b * 3;
        const dx = p[kb] - p[ka];
        const dy = p[kb + 1] - p[ka + 1];
        const dz = p[kb + 2] - p[ka + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-9;
        const push = ((d - len) / d) * 0.5;
        p[ka] += dx * push;
        p[ka + 1] += dy * push;
        p[ka + 2] += dz * push;
        p[kb] -= dx * push;
        p[kb + 1] -= dy * push;
        p[kb + 2] -= dz * push;
      }
      for (let i = 0; i < N; i++) this.collide(i, wallZ, it === ITERATIONS - 1);
    }
  }

  /** 一个关节和浮台、墙面的碰撞。last：这一小步的最后一遍（摩擦只算一次）。 */
  private collide(i: number, wallZ: number | null, last: boolean): void {
    const { p, q } = this;
    const { deckHalfW: w, deckHalfD: d } = this.env;
    const k = i * 3;

    // 墙面推着走：关节不能在墙面后面
    if (wallZ !== null && p[k + 2] < wallZ + WALL_CLEAR) {
      p[k + 2] = wallZ + WALL_CLEAR;
      q[k + 2] = Math.max(q[k + 2], p[k + 2] - PUSH_CARRY * STEP);
    }

    // 浮台是个扁盒子：陷进去了，就从最近的那个面推出来（顶面，或者四周的侧面）
    const x = p[k];
    const y = p[k + 1];
    const z = p[k + 2];
    if (Math.abs(x) < w + RADIUS && Math.abs(z) < d + RADIUS && y < RADIUS && y > -DECK_THICKNESS) {
      const up = RADIUS - y;
      const out = Math.min(w + RADIUS - Math.abs(x), d + RADIUS - Math.abs(z));
      if (up <= out) {
        p[k + 1] = RADIUS;
        if (last) {
          // 贴着台面：水平方向有摩擦（把"上一步的位置"往现在的位置挪，等于减速）
          q[k] = p[k] - (p[k] - q[k]) * DECK_KEEP;
          q[k + 2] = p[k + 2] - (p[k + 2] - q[k + 2]) * DECK_KEEP;
        }
      } else if (w + RADIUS - Math.abs(x) < d + RADIUS - Math.abs(z)) {
        p[k] = Math.sign(x) * (w + RADIUS);
      } else {
        p[k + 2] = Math.sign(z) * (d + RADIUS);
      }
    }
  }

  /** 现在的骨架。 */
  skeleton(): Skeleton {
    const out = {} as Skeleton;
    JOINTS.forEach((j, i) => {
      out[j] = { x: this.p[i * 3], y: this.p[i * 3 + 1], z: this.p[i * 3 + 2] };
    });
    return out;
  }

  /** 髋有没有沉到水面以下。 */
  get sunk(): boolean {
    return this.p[INDEX.get('hipC')! * 3 + 1] < this.env.waterY;
  }
}
