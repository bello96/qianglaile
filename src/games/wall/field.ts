import { segDist } from '../../engine/util/math';
import type { Sdf } from '../../engine/util/sdf';
import type { Capsule } from './bodyShape';

/**
 * 墙 = 网格上的一张"标量场"。
 *
 * 每个格点存一个数：**墙体内为正**（值 ≈ 离最近的洞边或墙边有多远），**洞里和墙外为负**。
 * 这一份数据有两个用处：
 *   - 画墙：沿着"值 = 0"的等值线提取轮廓，拉伸成 3D 网格（contour.ts）；
 *   - 判定：查玩家身体的采样点落在墙体里多深（judge.ts）。
 * 画的和判的是同一份数据，所以看到的洞就是判定用的洞。
 */
export interface WallBounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** 墙的尺寸：宽 4.2 米，高 3 米，底边贴地。比浮台宽，所以绕不过去。 */
export const WALL_BOUNDS: WallBounds = { x0: -2.1, x1: 2.1, y0: 0, y1: 3.0 };

export interface WallField {
  /** 格点数 */
  nx: number;
  ny: number;
  /** 格距（米） */
  cell: number;
  /** 第 (0,0) 个格点的坐标 */
  gx0: number;
  gy0: number;
  /** 按行存：data[j * nx + i] 是格点 (gx0 + i·cell, gy0 + j·cell) 的值 */
  data: Float32Array;
  bounds: WallBounds;
}

/** 网格比墙的矩形四周各多出几格，这样等值线在墙边也能闭合。 */
const PAD = 2;

/** 人形洞：目标姿势的身体轮廓（胶囊体的并集）向外放一圈余量。洞内为负。 */
export function capsulesHole(caps: Capsule[], margin: number): Sdf {
  return (x, y) => {
    let d = Infinity;
    for (const c of caps) d = Math.min(d, segDist(x, y, c.ax, c.ay, c.bx, c.by) - c.r - margin);
    return d;
  };
}

export function buildField(hole: Sdf, bounds: WallBounds = WALL_BOUNDS, cell = 0.025): WallField {
  const nx = Math.round((bounds.x1 - bounds.x0) / cell) + 1 + PAD * 2;
  const ny = Math.round((bounds.y1 - bounds.y0) / cell) + 1 + PAD * 2;
  const gx0 = bounds.x0 - PAD * cell;
  const gy0 = bounds.y0 - PAD * cell;
  const data = new Float32Array(nx * ny);

  for (let j = 0; j < ny; j++) {
    const y = gy0 + j * cell;
    for (let i = 0; i < nx; i++) {
      const x = gx0 + i * cell;
      // 在墙的矩形里面有多深（矩形外为负）
      const inRect = Math.min(x - bounds.x0, bounds.x1 - x, y - bounds.y0, bounds.y1 - y);
      data[j * nx + i] = Math.min(hole(x, y), inRect);
    }
  }

  removeUnsupported(data, nx, ny, gx0, gy0, cell, bounds);
  return { nx, ny, cell, gx0, gy0, data, bounds };
}

/**
 * 连通性修正：墙体必须和墙的上边或左右边连着（想象墙是从上面的轨道吊着、两侧有边框）。
 * 没连着的碎片——两腿之间那一块、手叉腰围出来的三角——在现实里会掉下来，这里把它们改成洞。
 * 底边不算支撑：只靠底边连着的那块也会被去掉，所以洞口在地面处总是敞开的。
 */
function removeUnsupported(data: Float32Array, nx: number, ny: number, gx0: number, gy0: number, cell: number, b: WallBounds): void {
  const supported = new Uint8Array(nx * ny);
  const stack: number[] = [];
  const near = 1.5 * cell;
  for (let j = 0; j < ny; j++) {
    const y = gy0 + j * cell;
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!(data[k] > 0)) continue;
      const x = gx0 + i * cell;
      if (b.y1 - y <= near || x - b.x0 <= near || b.x1 - x <= near) {
        supported[k] = 1;
        stack.push(k);
      }
    }
  }
  while (stack.length) {
    const k = stack.pop()!;
    const i = k % nx;
    const j = (k - i) / nx;
    if (i > 0) visit(k - 1);
    if (i < nx - 1) visit(k + 1);
    if (j > 0) visit(k - nx);
    if (j < ny - 1) visit(k + nx);
  }
  for (let k = 0; k < data.length; k++) if (data[k] > 0 && !supported[k]) data[k] = -cell / 2;

  function visit(k: number): void {
    if (supported[k] || !(data[k] > 0)) return;
    supported[k] = 1;
    stack.push(k);
  }
}

/** 查某一点的值（双线性插值）。网格以外一律返回 −1：那里没有墙。 */
export function sampleField(f: WallField, x: number, y: number): number {
  const fx = (x - f.gx0) / f.cell;
  const fy = (y - f.gy0) / f.cell;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  if (i < 0 || j < 0 || i >= f.nx - 1 || j >= f.ny - 1) return -1;
  const tx = fx - i;
  const ty = fy - j;
  const k = j * f.nx + i;
  const bottom = f.data[k] + (f.data[k + 1] - f.data[k]) * tx;
  const top = f.data[k + f.nx] + (f.data[k + f.nx + 1] - f.data[k + f.nx]) * tx;
  return bottom + (top - bottom) * ty;
}
