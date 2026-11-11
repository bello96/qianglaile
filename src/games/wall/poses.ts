import { DEFAULT_ARM, DEFAULT_LEG, NEUTRAL, type Limb, type PoseSpec } from '../../engine/body/pose';

/**
 * 人形墙洞的姿势库。
 *
 * 每个姿势只写关节角（见 engine/body/pose.ts 的约定：0° 朝下、90° 水平朝外、180° 朝上，
 * 负值表示越过身体中线）。左右不对称的姿势只写一个方向，出墙时会随机取镜像。
 *
 * 想加新姿势：照着下面加一行，或者到"姿势实验室"里摆好姿势点"存成新墙"，再把生成的代码贴进来。
 * 加完到实验室的"图鉴"页看一眼洞的形状像不像样。
 */

/** 手臂 / 腿的简写：两段的朝向角，可选两段的缩短比例。 */
const pair = (a: number, b: number, sa?: number, sb?: number): [Limb, Limb] => [
  sa === undefined ? { a } : { a, s: sa },
  sb === undefined ? { a: b } : { a: b, s: sb },
];

type Parts = Partial<Pick<PoseSpec, 'armL' | 'armR' | 'legL' | 'legR' | 'spine' | 'head'>>;

function pose(id: string, name: string, tier: PoseSpec['tier'], say: string, parts: Parts): PoseSpec {
  const legs = parts.legL ?? parts.legR;
  return {
    id,
    name,
    tier,
    say,
    // 只要动了腿、或者要弯腰缩身子，坐着就做不了
    upperOk: !legs && (parts.spine?.s ?? 1) >= 1,
    armL: parts.armL ?? DEFAULT_ARM,
    armR: parts.armR ?? DEFAULT_ARM,
    legL: parts.legL ?? DEFAULT_LEG,
    legR: parts.legR ?? DEFAULT_LEG,
    ...(parts.spine ? { spine: parts.spine } : {}),
    ...(parts.head !== undefined ? { head: parts.head } : {}),
  };
}

/** 两臂相同的对称姿势。 */
const both = (a: number, b: number): Parts => ({ armL: pair(a, b), armR: pair(a, b) });

/** 自然站立（不进姿势库，用作默认和示范）。 */
export const STAND: PoseSpec = NEUTRAL;

export const POSES: PoseSpec[] = [
  // ---- 第 1 层：左右对称，只动手 ----
  pose('t', '一字平举', 1, '双手平举', both(90, 90)),
  pose('y', '举高高', 1, '双手举高，张开', both(148, 150)),
  pose('up', '顶天立地', 1, '双手举过头顶', both(176, 178)),
  pose('a', '小企鹅', 1, '双手斜着往下张开', both(40, 40)),
  pose('flex', '大力士', 1, '秀出你的肌肉', both(90, 180)),
  pose('hips', '叉腰', 1, '双手叉腰', both(40, -40)),
  pose('scarecrow', '稻草人', 1, '手肘抬平，小臂垂下', both(90, 0)),
  pose('head', '抱头', 1, '双手抱头', both(130, -140)),

  // ---- 第 2 层：左右不对称，或者双脚分开 ----
  pose('disco', '指天指地', 2, '一只手指天，一只手指地', { armL: pair(150, 150), armR: pair(35, 35) }),
  pose('signal', '交警', 2, '一只手平举，一只手举高', { armL: pair(90, 90), armR: pair(178, 178) }),
  pose('teapot', '小茶壶', 2, '一只手叉腰，一只手翘起来', { armL: pair(40, -40), armR: pair(90, 150) }),
  pose('wave', '打招呼', 2, '举起一只手打招呼', { armR: pair(90, 170) }),
  pose('archer', '拉弓', 2, '一只手伸直，一只手拉弓', { armL: pair(90, 90), armR: pair(90, -90) }),
  pose('star', '大字', 2, '手脚都张开，摆个大字', { ...both(125, 125), legL: pair(22, 22), legR: pair(22, 22) }),
  pose('wide-t', '马步平举', 2, '双脚分开，双手平举', { ...both(90, 90), legL: pair(25, 5), legR: pair(25, 5) }),

  // ---- 第 3 层：侧弯、下蹲 ----
  pose('side-bend', '侧弯腰', 3, '一只手举过头，往旁边弯腰', { armL: pair(200, 205), armR: pair(10, 5), spine: { a: 22 }, head: 5 }),
  pose('squat', '蹲马步', 3, '蹲个马步', { ...both(60, 60), legL: pair(65, -8, 0.75), legR: pair(65, -8, 0.75) }),
  pose('low', '小矮人', 3, '蹲下来，缩成一团', { ...both(15, 10), legL: pair(80, 0, 0.45, 0.9), legR: pair(80, 0, 0.45, 0.9), spine: { a: 0, s: 0.6 } }),
  pose('lunge', '侧弓步', 3, '一条腿弯，一条腿伸直，双手叉腰', { ...both(40, -40), legL: pair(50, 0), legR: pair(38, 38) }),
  pose('hero', '超人', 3, '一只手冲天，一只手叉腰', { armL: pair(40, -40), armR: pair(165, 165), legL: pair(18, 18), legR: pair(18, 18), spine: { a: 12 } }),

  // ---- 第 4 层：单脚、平衡 ----
  pose('crane', '金鸡独立', 4, '抬起一条腿，双手平举', { ...both(90, 90), legL: pair(0, 0), legR: pair(10, 0, 0.25) }),
  pose('side-kick', '侧踢', 4, '一条腿往旁边踢出去', { armL: pair(90, 90), armR: pair(30, 30), legL: pair(0, 0), legR: pair(60, 60), spine: { a: -10 } }),
  pose('skater', '滑冰', 4, '身体前倾，一条腿往后伸', { armL: pair(100, 100), armR: pair(60, 60), legL: pair(0, 0), legR: pair(40, 55), spine: { a: 18 } }),
  pose('tree', '树式', 4, '单脚站，双手举过头顶合起来', { ...both(170, 175), legL: pair(0, 0), legR: pair(60, -60) }),
];

const BY_ID = new Map(POSES.map((p) => [p.id, p]));

export function getPose(id: string): PoseSpec | undefined {
  return BY_ID.get(id);
}
