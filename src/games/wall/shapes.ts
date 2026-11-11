import type { PoseSpec } from '../../engine/body/pose';
import { standHeight, standHipHeight, type BodyProfile } from '../../engine/body/profile';
import { sdBox, sdCircle, union, type Sdf } from '../../engine/util/sdf';
import { getPose, STAND } from './poses';

/**
 * 几何洞：不是人形，而是门、缝、圆洞这类形状。没有"目标姿势"，整个人钻得进去就算过。
 *
 * 洞的尺寸按玩家身材算（build 的第一个参数），所以大人小孩难度相当。
 * 每个形状配一个示范姿势 demo：模拟玩家照着它摆、图鉴里画提示小人、测试用它验证"确实钻得过去"。
 *
 * 想加新形状：用 engine/util/sdf.ts 里的基本形状拼一个"洞内为负"的函数即可。
 */
export interface ShapeSpec {
  id: string;
  name: string;
  /** 难度层：2 = 站着就能过，3 = 要蹲或要挪步 */
  tier: 2 | 3;
  upperOk: boolean;
  say?: string;
  /** 洞相对玩家的左右偏移（米）。出墙时随机取正负。 */
  offset?: number;
  build(p: BodyProfile, at: { x: number }): Sdf;
  demo: PoseSpec;
}

/** 洞往地面以下多挖一截，保证洞口在墙的底边是敞开的。 */
const BELOW = 0.3;

/** 从地下 BELOW 一直到 top 的竖直矩形洞。 */
const column = (x: number, halfWidth: number, top: number, round = 0.1): Sdf => sdBox(x, (top - BELOW) / 2, halfWidth, (top + BELOW) / 2, round);

export const SHAPES: ShapeSpec[] = [
  {
    id: 'slot',
    name: '窄缝',
    tier: 2,
    upperOk: true,
    say: '收紧身体，从窄缝里过去',
    demo: STAND,
    // 只比肩膀宽一点：手臂一张开就会卡住
    build: (p, at) => column(at.x, p.shoulderW / 2 + 0.14, standHeight(p) + 0.2),
  },
  {
    id: 'keyhole',
    name: '钥匙孔',
    tier: 2,
    upperOk: true,
    say: '把手举到头旁边，钻过钥匙孔',
    demo: getPose('head')!,
    // 上面一个圆（装得下头和举起的手臂），下面一条只够放腿的窄缝：手垂着会卡在缝外。
    // 缝的最底下留一个放脚的小缺口——脚尖朝外，比腿宽，不留的话站得再标准脚也蹭着墙
    build: (p, at) => {
      const shoulderY = standHipHeight(p) + p.torso;
      const cy = shoulderY + 0.06 * standHeight(p);
      const legs = column(at.x, p.hipW / 2 + p.r.thigh + 0.04, cy, 0.04);
      const feet = column(at.x, p.hipW / 2 + 2 * p.r.foot + 0.08, 0.14 * p.shin + 0.14, 0.04);
      return union(sdCircle(at.x, cy, 0.3 * standHeight(p)), legs, feet);
    },
  },
  {
    id: 'low-door',
    name: '矮门',
    tier: 3,
    upperOk: false,
    say: '门很矮，蹲下来',
    demo: getPose('low')!,
    build: (p, at) => column(at.x, p.shoulderW / 2 + 0.42, 0.66 * standHeight(p), 0.2),
  },
  {
    id: 'round',
    name: '圆洞',
    tier: 3,
    upperOk: false,
    say: '缩成一团，钻过圆洞',
    demo: getPose('low')!,
    build: (p, at) => {
      // 圆心压低到"圆的底部在地面以下一成站高"：圆在贴近地面的地方最窄，而蹲下时脚是往两边撇的，
      // 压得不够低脚尖就蹭墙。洞顶在 0.67 倍站高，站着的人肯定过不去
      const r = 0.385 * standHeight(p);
      return sdCircle(at.x, r - 0.1 * standHeight(p), r);
    },
  },
  {
    id: 'side-door',
    name: '偏门',
    tier: 3,
    upperOk: true,
    say: '门开在旁边，挪过去',
    offset: 0.55,
    demo: STAND,
    build: (p, at) => column(at.x, p.shoulderW / 2 + 0.36, standHeight(p) + 0.2),
  },
];

const BY_ID = new Map(SHAPES.map((s) => [s.id, s]));

export function getShape(id: string): ShapeSpec | undefined {
  return BY_ID.get(id);
}
