import type { Body } from '../../engine/body/bodyModel';
import { LM } from '../../engine/body/landmarks';
import type { BodyProfile } from '../../engine/body/profile';
import { rad2deg, segDist } from '../../engine/util/math';
import type { Sdf } from '../../engine/util/sdf';
import type { Capsule } from './bodyShape';
import type { DuoPoseId } from './poses';
import { COMMON } from './tuning';

/**
 * 双人模式的几何：两个人隔多远、两副身体会不会碰到、内侧的手臂抬多高、两个洞怎么挖在同一面墙上。
 * 都是纯函数。谁和谁配成一面墙，在 levels.ts 里；这里只回答"这样摆行不行"。
 */

/**
 * 两位玩家实际隔多远（米），从摄像头画面里量。
 *
 * 开局前两个人的 Body 各在各的坐标系里（各自以"第一次被看到的地方"为原点），root.x 不能直接相减。
 * 所以回到画面上量：两人肩髋质心在画面里的横向距离，除以"每米占多少画面"。
 * 量不出来（关键点都看不清）时返回 0——调用的地方会把它当成"靠得太近"，不会因此开局。
 */
export function pairGap(a: Body, b: Body): number {
  /** 肩髋质心在画面里的横向位置，以画面高度为单位 */
  const across = (body: Body): number => {
    const aspect = (body.view.right - body.view.left) * body.scale;
    let sum = 0;
    let n = 0;
    for (const i of [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip]) {
      const p = body.image[i];
      if (!p || p.v < 0.5) continue;
      sum += p.x;
      n++;
    }
    return n ? (sum / n) * aspect : Number.NaN;
  };
  const metres = Math.abs(across(a) - across(b)) / ((a.scale + b.scale) / 2);
  return Number.isFinite(metres) ? metres : 0;
}

/**
 * 双人专属造型（手拉手、搭桥）里，内侧那条手臂的朝向角。
 *
 * 手臂是直的，要让手正好伸到两人中间：两只手之间留一条 handGap 宽的缝。
 * halfGap：这位玩家离两人中线多远。站得近，手臂就斜着放下（手拉手）或斜着举起（搭桥）；
 * 站得太开、伸直了也够不着，就水平伸直，中间空着。
 */
export function duoArmAngle(id: DuoPoseId, p: BodyProfile, halfGap: number): number {
  const reach = p.upperArm + p.forearm + p.hand;
  // 从肩到手心要横着走多远
  const across = halfGap - p.shoulderW / 2 - COMMON.duo.handGap / 2 - p.r.hand;
  const fromDown = across >= reach ? 90 : rad2deg(Math.asin(Math.max(0, across) / reach));
  return id === 'bridge' ? 180 - fromDown : fromDown;
}

/** 两条线段相不相交（端点正好搭在另一条上也算）。有一条退化成点时不在这里管。 */
function segmentsCross(a: Capsule, b: Capsule): boolean {
  const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = side(b.ax, b.ay, b.bx, b.by, a.ax, a.ay);
  const d2 = side(b.ax, b.ay, b.bx, b.by, a.bx, a.by);
  const d3 = side(a.ax, a.ay, a.bx, a.by, b.ax, b.ay);
  const d4 = side(a.ax, a.ay, a.bx, a.by, b.bx, b.by);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * 两副身体轮廓之间最近的空隙（米）；碰到、交叠了就是负数。
 * 身体是胶囊体的并集，所以最近距离 = 所有"胶囊对"里的最小值：两条轴线之间的距离减去两个半径。
 */
export function bodyGap(a: Capsule[], b: Capsule[]): number {
  let least = Infinity;
  for (const p of a) {
    for (const q of b) {
      const axes = segmentsCross(p, q)
        ? 0
        : Math.min(
            segDist(p.ax, p.ay, q.ax, q.ay, q.bx, q.by),
            segDist(p.bx, p.by, q.ax, q.ay, q.bx, q.by),
            segDist(q.ax, q.ay, p.ax, p.ay, p.bx, p.by),
            segDist(q.bx, q.by, p.ax, p.ay, p.bx, p.by),
          );
      least = Math.min(least, axes - p.r - q.r);
    }
  }
  return least;
}

/**
 * 把两位玩家各自的洞合到一面墙上。
 *
 * 基本上就是"两个洞都挖"。多做的一件事：两个洞之间要是只隔着不到 minStrip 的一条墙，把那一段也挖掉。
 * 不然会留下一根几厘米宽的细条——看着像画错了，按格点描轮廓时还会断成碎渣。
 * （手拉手、搭桥正是靠这个让两个洞连成一个：两只手之间那条缝比 minStrip 窄。）
 *
 * 做法：墙体里的一点到两个洞的距离之和小于 minStrip，就说明它落在那条细缝里。
 */
export function mergeHoles(a: Sdf, b: Sdf): Sdf {
  const strip = COMMON.duo.minStrip;
  return (x, y) => {
    const da = a(x, y);
    const db = b(x, y);
    return Math.min(da, db, (da + db - strip) / 2);
  };
}
