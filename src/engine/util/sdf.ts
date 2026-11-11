import { segDist, type Vec2 } from './math';

/**
 * 二维有符号距离函数：形状内部为负、外部为正，绝对值是到边界的距离。
 * 墙洞就是用这些基本形状拼出来的——"洞内为负"是全项目的约定。
 */
export type Sdf = (x: number, y: number) => number;

export function sdCircle(cx: number, cy: number, r: number): Sdf {
  return (x, y) => Math.hypot(x - cx, y - cy) - r;
}

/** 轴对齐矩形：中心 (cx,cy)，半宽 hx、半高 hy；round 是圆角半径（整体尺寸不变）。 */
export function sdBox(cx: number, cy: number, hx: number, hy: number, round = 0): Sdf {
  const ix = hx - round;
  const iy = hy - round;
  return (x, y) => {
    const qx = Math.abs(x - cx) - ix;
    const qy = Math.abs(y - cy) - iy;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - round;
  };
}

/** 胶囊体：线段 (ax,ay)-(bx,by) 加粗到半径 r。 */
export function sdCapsule(ax: number, ay: number, bx: number, by: number, r: number): Sdf {
  return (x, y) => segDist(x, y, ax, ay, bx, by) - r;
}

export function sdTriangle(a: Vec2, b: Vec2, c: Vec2): Sdf {
  // 统一成逆时针，这样"在三条边的左侧"就是在内部
  const ccw = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0;
  const [p0, p1, p2] = ccw ? [a, b, c] : [a, c, b];
  const side = (x: number, y: number, u: Vec2, v: Vec2) => (v.x - u.x) * (y - u.y) - (v.y - u.y) * (x - u.x);
  return (x, y) => {
    const d = Math.min(
      segDist(x, y, p0.x, p0.y, p1.x, p1.y),
      segDist(x, y, p1.x, p1.y, p2.x, p2.y),
      segDist(x, y, p2.x, p2.y, p0.x, p0.y),
    );
    const inside = side(x, y, p0, p1) >= 0 && side(x, y, p1, p2) >= 0 && side(x, y, p2, p0) >= 0;
    return inside ? -d : d;
  };
}

/** 并集：哪个形状近就取哪个。 */
export function union(...shapes: Sdf[]): Sdf {
  return (x, y) => {
    let d = Infinity;
    for (const s of shapes) d = Math.min(d, s(x, y));
    return d;
  };
}

/** 向外膨胀 d（d 为负则收缩）。 */
export function inflate(s: Sdf, d: number): Sdf {
  return (x, y) => s(x, y) - d;
}
