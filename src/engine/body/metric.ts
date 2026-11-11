import type { RawPose } from '../input/types';
import type { Vec3 } from '../util/math';
import { CORE_LM } from './landmarks';

/**
 * 把"图像坐标"换算成"米"。
 *
 * 模型给了两套坐标，各有短处：
 * - 图像关键点位置准，但人离镜头越远就越小；
 * - 世界关键点单位是米、与远近无关，但四肢末端不如图像关键点准。
 *
 * 人离镜头两三米时可以近似成弱透视：图像坐标 ≈ 缩放 × 世界坐标的正面投影 + 平移。
 * 每帧用最小二乘把这个"缩放 + 平移"拟合出来，再反过来用它把**图像关键点**换算进米制空间：
 * 位置取图像关键点的精度，尺度取世界关键点的稳定。实测两者平均只差 2 厘米左右。
 */
export interface Similarity {
  /** 每米对应多少个"画面高度" */
  s: number;
  /** 世界原点（髋中心）落在图像上的位置：u = x·aspect，v = y */
  tu: number;
  tv: number;
  /** 参与拟合的关键点个数 */
  n: number;
  /** 拟合用到的两组点各自的加权质心：世界坐标 (ax, ay) 和图像坐标 (bu, bv) */
  ax: number;
  ay: number;
  bu: number;
  bv: number;
}

/** 换一个缩放值（比如滤波后的），平移跟着重算，保证两组质心仍然对齐。 */
export function rescale(sim: Similarity, s: number): Similarity {
  return { ...sim, s, tu: sim.bu - s * sim.ax, tv: sim.bv - s * sim.ay };
}

export function fitSimilarity(pose: RawPose, aspect: number, minVis = 0.5): Similarity | null {
  let sw = 0;
  let ax = 0;
  let ay = 0;
  let bu = 0;
  let bv = 0;
  let n = 0;
  for (const i of CORE_LM) {
    const w = pose.image[i].v;
    if (!(w >= minVis)) continue;
    n++;
    sw += w;
    ax += w * pose.world[i].x;
    ay += w * pose.world[i].y;
    bu += w * pose.image[i].x * aspect;
    bv += w * pose.image[i].y;
  }
  if (n < 4) return null;
  ax /= sw;
  ay /= sw;
  bu /= sw;
  bv /= sw;

  let num = 0;
  let den = 0;
  for (const i of CORE_LM) {
    const w = pose.image[i].v;
    if (!(w >= minVis)) continue;
    const dax = pose.world[i].x - ax;
    const day = pose.world[i].y - ay;
    num += w * (dax * (pose.image[i].x * aspect - bu) + day * (pose.image[i].y - bv));
    den += w * (dax * dax + day * day);
  }
  if (den < 1e-9) return null;
  const s = num / den;
  if (!(s > 1e-6)) return null;
  return { s, tu: bu - s * ax, tv: bv - s * ay, n, ax, ay, bu, bv };
}

/** 一个人的米制骨架：以髋为原点，轴向是舞台空间的（x 朝玩家右手、y 朝上、z 朝观众，身体正面朝 -z）。 */
export interface MetricPose {
  joints: Vec3[];
  vis: number[];
  sim: Similarity;
}

/**
 * x、y 取自图像关键点（经相似变换换算成米，并做镜像和上下翻转）；
 * z 取自世界关键点，乘以 zGain 压扁一些——深度是模型最不准的一维，只用来让 3D 小人看着立体。
 */
export function toMetric(pose: RawPose, aspect: number, sim: Similarity, zGain = 0.6): MetricPose {
  const joints: Vec3[] = [];
  const vis: number[] = [];
  for (let i = 0; i < pose.image.length; i++) {
    const p = pose.image[i];
    joints.push({
      x: -(p.x * aspect - sim.tu) / sim.s,
      y: -(p.y - sim.tv) / sim.s,
      z: pose.world[i].z * zGain,
    });
    vis.push(p.v);
  }
  return { joints, vis, sim };
}
