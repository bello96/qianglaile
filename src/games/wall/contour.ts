import { pointInPolygon, polygonArea, segDist, type Vec2 } from '../../engine/util/math';
import type { WallField } from './field';

/**
 * 从标量场里把"墙体"的轮廓描出来（marching squares）。
 *
 * 做法：逐个看由四个相邻格点围成的小方格。四个角有的在墙里（值 > 0）、有的不在，
 * 一共 16 种组合，每种组合对应方格里的一两条小线段；线段端点落在"值从正变负"的那条边上，
 * 位置按两端的值线性插值（所以轮廓是平滑的，不是锯齿）。把所有小线段首尾相接就是闭合的轮廓。
 *
 * 约定：沿线段前进时墙体在左手边。于是墙体的外圈是逆时针的，墙上的内孔是顺时针的。
 */

/** 一块墙体：外圈（逆时针）加若干内孔（顺时针）。可以直接交给 three.js 的 Shape。 */
export interface WallOutline {
  outer: Vec2[];
  holes: Vec2[][];
}

// 方格四条边的编号：0 下、1 右、2 上、3 左。每种角点组合 → 若干 [起点边, 终点边]
// 角点位：1 = 左下，2 = 右下，4 = 右上，8 = 左上
const CASES: number[][][] = [
  [], [[0, 3]], [[1, 0]], [[1, 3]], [[2, 1]], [], [[2, 0]], [[2, 3]],
  [[3, 2]], [[0, 2]], [], [[1, 2]], [[3, 1]], [[0, 1]], [[3, 0]], [],
];
/** 对角的两个角在墙里（鞍点）时有两种连法，看方格中心在不在墙里来定。 */
const SADDLE: Record<number, { joined: number[][]; apart: number[][] }> = {
  5: { joined: [[0, 1], [2, 3]], apart: [[0, 3], [2, 1]] },
  10: { joined: [[3, 0], [1, 2]], apart: [[1, 0], [3, 2]] },
};

/** 描出所有闭合轮廓，点很密（每过一条网格线一个点），未简化。 */
function traceLoops(f: WallField): Vec2[][] {
  const { nx, ny, cell, gx0, gy0, data } = f;
  const next = new Int32Array(nx * ny * 2).fill(-1);
  const px = new Float32Array(nx * ny * 2);
  const py = new Float32Array(nx * ny * 2);
  const starts: number[] = [];

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i;
      const v0 = data[k];
      const v1 = data[k + 1];
      const v2 = data[k + nx + 1];
      const v3 = data[k + nx];
      const code = (v0 > 0 ? 1 : 0) | (v1 > 0 ? 2 : 0) | (v2 > 0 ? 4 : 0) | (v3 > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const segs = SADDLE[code] ? (v0 + v1 + v2 + v3 > 0 ? SADDLE[code].joined : SADDLE[code].apart) : CASES[code];

      // 边的全局编号：横边 = 2·起点格点号，竖边 = 2·起点格点号 + 1
      const id = [2 * k, 2 * (k + 1) + 1, 2 * (k + nx), 2 * k + 1];
      const place = (e: number): void => {
        let x = gx0 + i * cell;
        let y = gy0 + j * cell;
        if (e === 0) x += (v0 / (v0 - v1)) * cell;
        else if (e === 1) (x += cell), (y += (v1 / (v1 - v2)) * cell);
        else if (e === 2) (y += cell), (x += (v3 / (v3 - v2)) * cell);
        else y += (v0 / (v0 - v3)) * cell;
        px[id[e]] = x;
        py[id[e]] = y;
      };
      for (const [from, to] of segs) {
        place(from);
        place(to);
        next[id[from]] = id[to];
        starts.push(id[from]);
      }
    }
  }

  const visited = new Uint8Array(nx * ny * 2);
  const loops: Vec2[][] = [];
  for (const start of starts) {
    if (visited[start]) continue;
    const pts: Vec2[] = [];
    let e = start;
    let closed = false;
    while (e >= 0 && !visited[e]) {
      visited[e] = 1;
      pts.push({ x: px[e], y: py[e] });
      e = next[e];
      if (e === start) closed = true;
    }
    if (closed && pts.length >= 3) loops.push(dedupe(pts));
  }
  return loops;
}

/** 去掉连续重复的点（插值恰好落在格点上时，相邻两条小线段会给出同一个点）。 */
function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= 1e-6) out.pop();
  return out;
}

/** Douglas–Peucker 折线简化：偏离不超过 eps 的中间点都丢掉。保留首尾。 */
function simplifyOpen(pts: Vec2[], eps: number): Vec2[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstDist = eps;
    for (let k = a + 1; k < b; k++) {
      const d = segDist(pts[k].x, pts[k].y, pts[a].x, pts[a].y, pts[b].x, pts[b].y);
      if (d > worstDist) {
        worst = k;
        worstDist = d;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** 闭合环的简化：以第 0 个点和离它最远的点为两个锚点，两半分别简化。 */
function simplifyClosed(pts: Vec2[], eps: number): Vec2[] {
  if (pts.length < 6) return pts;
  let far = 1;
  let best = -1;
  for (let k = 1; k < pts.length; k++) {
    const d = Math.hypot(pts[k].x - pts[0].x, pts[k].y - pts[0].y);
    if (d > best) {
      best = d;
      far = k;
    }
  }
  const a = simplifyOpen(pts.slice(0, far + 1), eps);
  const b = simplifyOpen([...pts.slice(far), pts[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/**
 * 墙体的轮廓，按块返回（正常情况下只有一块）。
 * 洞通到地面时，洞是外圈上的一个"缺口"；洞悬在墙中间时，才是内孔。
 */
export function wallOutlines(f: WallField, eps = 0.008): WallOutline[] {
  const outers: WallOutline[] = [];
  const inner: Vec2[][] = [];
  for (const dense of traceLoops(f)) {
    const loop = simplifyClosed(dense, eps);
    if (loop.length < 3) continue;
    const area = polygonArea(loop);
    if (Math.abs(area) < 1e-5) continue;
    if (area > 0) outers.push({ outer: loop, holes: [] });
    else inner.push(loop);
  }
  outers.sort((a, b) => polygonArea(b.outer) - polygonArea(a.outer));
  for (const hole of inner) {
    // 归到包含它的最小那一块
    let owner: WallOutline | null = null;
    for (const o of outers) if (pointInPolygon(hole[0], o.outer)) owner = o;
    owner?.holes.push(hole);
  }
  return outers;
}

/**
 * 洞口的边线（不含墙自己的外边），给"落位轮廓"用。
 * 通到地面的洞是一条两端落地的折线；悬在墙中间的洞是一条首尾相同的闭合折线。
 */
export function holeEdges(f: WallField, eps = 0.008): Vec2[][] {
  const b = f.bounds;
  const h = f.cell / 2;
  const onBorder = (p: Vec2): boolean => p.x - b.x0 < h || b.x1 - p.x < h || p.y - b.y0 < h || b.y1 - p.y < h;

  const lines: Vec2[][] = [];
  for (const loop of traceLoops(f)) {
    const border = loop.map(onBorder);
    if (border.every(Boolean)) continue;
    if (!border.some(Boolean)) {
      const closed = simplifyClosed(loop, eps);
      lines.push([...closed, closed[0]]);
      continue;
    }
    // 从一个贴边的点开始绕一圈，把连续的"不贴边"的点收成一条条折线
    const n = loop.length;
    const start = border.indexOf(true);
    let run: Vec2[] = [];
    for (let s = 1; s <= n; s++) {
      const k = (start + s) % n;
      if (!border[k]) {
        run.push(loop[k]);
      } else {
        if (run.length >= 2) lines.push(simplifyOpen(run, eps));
        run = [];
      }
    }
  }
  return lines;
}
