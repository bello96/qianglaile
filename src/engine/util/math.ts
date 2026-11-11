export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * 指数跟随：让 cur 以速率 lambda（1/秒）追向 target。
 * 与帧率无关——走两个半步和走一个整步结果相同，所以渲染帧率变化时手感不变。
 */
export const damp = (cur: number, target: number, lambda: number, dt: number): number =>
  cur + (target - cur) * (1 - Math.exp(-lambda * dt));

export const deg2rad = (d: number): number => (d * Math.PI) / 180;
export const rad2deg = (r: number): number => (r * 180) / Math.PI;

/** 点 (px,py) 到线段 (ax,ay)-(bx,by) 的距离。 */
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** 有符号面积：逆时针为正。 */
export function polygonArea(pts: Vec2[]): number {
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    sum += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return sum / 2;
}

export function pointInPolygon(p: Vec2, pts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** p ∈ [0,1]，线性插值的分位数；空数组返回 NaN。 */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = clamp01(p) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return lerp(sorted[lo], sorted[hi], pos - lo);
}

export const median = (xs: number[]): number => percentile(xs, 0.5);
