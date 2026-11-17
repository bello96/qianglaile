import { DEFAULT_ARM, DEFAULT_LEG, NEUTRAL, type Limb, type PoseSpec } from '../../engine/body/pose';

/**
 * 人形墙洞的姿势库。
 *
 * 每个姿势只写关节角（见 engine/body/pose.ts 的约定：0° 朝下、90° 水平朝外、180° 朝上，
 * 负值表示越过身体中线）。左右不对称的姿势只写一个方向，出墙时会随机取镜像。
 *
 * 哪一关出哪些姿势，不在这里——那张表在 levels.ts 的 LEVELS 里。这里的"层"（tier）只是难度的粗分，
 * 图鉴里显示用，自己存的墙也按它决定从第几关开始出。
 *
 * 想加新姿势：照着下面加一行，或者到"姿势实验室"里摆好姿势点"存成新墙"，再把生成的代码贴进来；
 * 然后在 levels.ts 的表里把它的 id 放进某一关。加完到实验室的"图鉴"页看一眼洞的形状像不像样。
 */

/** 手臂 / 腿的简写：两段的朝向角，可选两段的缩短比例。 */
const pair = (a: number, b: number, sa?: number, sb?: number): [Limb, Limb] => [
  sa === undefined ? { a } : { a, s: sa },
  sb === undefined ? { a: b } : { a: b, s: sb },
];

type Parts = Partial<Pick<PoseSpec, 'armL' | 'armR' | 'legL' | 'legR' | 'spine' | 'head'>>;

function pose(id: string, name: string, tier: PoseSpec['tier'], say: string, parts: Parts, opts: { noMirror?: boolean } = {}): PoseSpec {
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
    ...(opts.noMirror ? { noMirror: true } : {}),
  };
}

/** 两臂相同的对称姿势。 */
const both = (a: number, b: number): Parts => ({ armL: pair(a, b), armR: pair(a, b) });
/** 两腿相同。 */
const legs = (a: number, b: number, sa?: number, sb?: number): Parts => ({ legL: pair(a, b, sa, sb), legR: pair(a, b, sa, sb) });

// ---- 几种反复用到的下半身 ----
/** 马步：两膝朝外打开，大腿朝镜头方向缩短一点 */
const HORSE = legs(62, -6, 0.8);
/** 侧弓步：左腿弯、右腿伸直（出墙时会随机镜像） */
const LUNGE: Parts = { legL: pair(54, -4), legR: pair(40, 40) };
/** 蹲到底，膝盖朝外 */
const FROG = legs(80, -28, 0.9, 0.85);
/** 金鸡独立：左脚站，右膝朝镜头抬起（大腿在正面看只剩四分之一长） */
const CRANE: Parts = { legL: pair(0, 0), legR: pair(10, 0, 0.25) };
/** 敬礼：右上臂抬平，小臂折回来，手到额角 */
const SALUTE = pair(100, -122);
/** 敬礼只能是右手，所以带敬礼的姿势都不取镜像 */
const RIGHT_HAND = { noMirror: true };

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
  pose('salute', '敬礼', 2, '右手敬礼', { armR: SALUTE }, RIGHT_HAND),
  // 手臂只比水平高一点：再往上举就成了"开合跳"，不像"大"字了
  pose('star', '大字', 2, '手脚都张开，摆个大字', { ...both(100, 100), ...legs(24, 24) }),
  pose('x-jump', '开合跳', 2, '手脚都张开，像开合跳', { ...both(140, 140), ...legs(24, 24) }),
  pose('a-frame', '人字', 2, '双脚分开，站成人字', { ...both(15, 10), ...legs(26, 26) }),

  // ---- 第 3 层：侧弯、马步、弓步、下蹲、弯腰 ----
  pose('side-bend', '侧弯腰', 3, '一只手举过头，往旁边弯腰', { armL: pair(200, 205), armR: pair(10, 5), spine: { a: 22 }, head: 5 }),
  pose('seesaw', '跷跷板', 3, '双手平举，身体歪向一边', { armR: pair(70, 70), armL: pair(110, 110), ...legs(20, 20), spine: { a: 20 } }),
  pose('moon', '弯月', 3, '双手举过头，往旁边弯', { armR: pair(158, 160), armL: pair(202, 205), ...legs(14, 14), spine: { a: 22 }, head: 5 }),
  pose('hero', '超人', 3, '一只手冲天，一只手叉腰', { armL: pair(40, -40), armR: pair(165, 165), legL: pair(18, 18), legR: pair(18, 18), spine: { a: 12 } }),

  pose('horse', '扎马步', 3, '扎马步，双手叉腰', { ...both(40, -40), ...HORSE }),
  pose('squat', '蹲马步', 3, '蹲个马步', { ...both(60, 60), legL: pair(65, -8, 0.75), legR: pair(65, -8, 0.75) }),
  pose('wide-t', '马步平举', 3, '扎马步，双手平举', { ...both(90, 90), ...HORSE }),
  pose('sumo', '相扑', 3, '蹲低一点，双手扶膝盖', { ...both(24, 24), ...legs(75, -12, 0.9) }),
  pose('horse-disco', '马步指天', 3, '扎马步，一手指天一手指地', { armL: pair(150, 150), armR: pair(35, 35), ...HORSE }),
  pose('horse-salute', '马步敬礼', 3, '扎着马步敬个礼', { armR: SALUTE, armL: pair(40, -40), ...HORSE }, RIGHT_HAND),

  pose('lunge', '侧弓步', 3, '一条腿弯，一条腿伸直，双手叉腰', { ...both(40, -40), legL: pair(50, 0), legR: pair(38, 38) }),
  pose('warrior', '战士', 3, '侧弓步，双手平举', { ...both(90, 90), ...LUNGE }),
  pose('archer-lunge', '弓步射箭', 3, '弓步站稳，拉弓射箭', { armL: pair(90, 90), armR: pair(90, -90), ...LUNGE }),
  pose('lunge-reach', '弓步摘星', 3, '弓步，一只手伸上去摘星星', { armL: pair(165, 168), armR: pair(40, -40), ...LUNGE, spine: { a: -8 } }),
  pose('lunge-moon', '弓步弯月', 3, '弓步，双手举过头往旁边弯', { armL: pair(162, 164), armR: pair(198, 200), ...LUNGE, spine: { a: -18 }, head: -5 }),

  pose('low', '小矮人', 3, '蹲下来，缩成一团', { ...both(15, 10), legL: pair(80, 0, 0.45, 0.9), legR: pair(80, 0, 0.45, 0.9), spine: { a: 0, s: 0.6 } }),
  pose('frog', '青蛙蹲', 3, '蹲到底，膝盖朝外', { ...both(4, -4), ...FROG, spine: { a: 0, s: 0.85 } }),
  pose('squat-up', '蹲下举手', 3, '蹲下去，双手举高', { ...both(165, 170), ...legs(80, 0, 0.45, 0.9), spine: { a: 0, s: 0.85 } }),
  pose('squat-flex', '蹲下秀肌肉', 3, '蹲下去，秀出你的肌肉', { ...both(90, 180), ...FROG, spine: { a: 0, s: 0.85 } }),

  // 向前弯腰：上身朝镜头压下去，正面看躯干只剩一半长
  pose('bow', '深鞠躬', 3, '深深鞠一躬', { ...both(4, 2), spine: { a: 0, s: 0.5 } }),
  pose('airplane', '小飞机', 3, '弯下腰，张开双手当翅膀', { ...both(90, 90), ...legs(14, 14), spine: { a: 0, s: 0.55 } }),

  // ---- 第 4 层：单脚、平衡 ----
  pose('crane', '金鸡独立', 4, '抬起一条腿，双手平举', { ...both(90, 90), ...CRANE }),
  pose('white-crane', '白鹤亮翅', 4, '抬起一条腿，一手指天一手指地', { armL: pair(160, 165), armR: pair(45, 45), ...CRANE }),
  pose('crane-salute', '独立敬礼', 4, '金鸡独立，再敬个礼', { armR: SALUTE, ...CRANE }, RIGHT_HAND),
  // 小腿向后勾起来：朝镜头的反方向折，正面看只剩四分之一长
  pose('flamingo', '火烈鸟', 4, '一只脚向后勾起来，双手叉腰', { ...both(40, -40), legL: pair(0, 0), legR: pair(4, 0, 1, 0.25) }),
  pose('tree', '树式', 4, '单脚站，双手举过头顶合起来', { ...both(170, 175), legL: pair(0, 0), legR: pair(60, -60) }),
  pose('tree-t', '独木桥', 4, '单脚站，双手平举', { ...both(90, 90), legL: pair(0, 0), legR: pair(60, -60) }),
  pose('side-kick', '侧踢', 4, '一条腿往旁边踢出去', { armL: pair(90, 90), armR: pair(30, 30), legL: pair(0, 0), legR: pair(60, 60), spine: { a: -10 } }),
  pose('skater', '滑冰', 4, '身体前倾，一条腿往后伸', { armL: pair(100, 100), armR: pair(60, 60), legL: pair(0, 0), legR: pair(40, 55), spine: { a: 18 } }),
  pose('one-leg-star', '单脚大字', 4, '单脚站稳，另一条腿往旁边抬', { ...both(95, 95), legL: pair(0, 0), legR: pair(45, 45), spine: { a: -8 } }),
  pose('kick-up', '踢腿举手', 4, '一条腿往旁边踢，双手举高', { ...both(165, 168), legL: pair(0, 0), legR: pair(55, 55), spine: { a: -8 } }),
];

const BY_ID = new Map(POSES.map((p) => [p.id, p]));

export function getPose(id: string): PoseSpec | undefined {
  return BY_ID.get(id);
}

// ---------------------------------------------------------------- 双人专属

/** 只有双人模式才出的造型：两个人的内侧手臂伸向对方。 */
export const DUO_POSE_IDS = ['hold-hands', 'bridge'] as const;
export type DuoPoseId = (typeof DUO_POSE_IDS)[number];

const DUO_TEXT: Record<DuoPoseId, { name: string; say: string; tier: PoseSpec['tier'] }> = {
  'hold-hands': { name: '手拉手', say: '两个人手拉手', tier: 1 },
  bridge: { name: '搭桥', say: '两个人把手举高，搭一座桥', tier: 2 },
};

/**
 * 双人专属造型里一位玩家的姿势。
 *
 * 它不能写死在上面的表里：内侧手臂抬多高，取决于两个人当场站得多开（见 duo.ts 的 duoArmAngle）——
 * 站得近就斜着放下一点，站得开就抬平，让两只手正好在两人中间碰头。
 *
 * side：-1 是站在左边的那位（内侧是右手），+1 是右边那位（内侧是左手，id 带 '~m'）。
 * armAngle：内侧手臂的朝向角，整条手臂是直的。
 */
export function duoPose(id: DuoPoseId, side: -1 | 1, armAngle: number): PoseSpec {
  const inner = pair(armAngle, armAngle);
  // 外侧的手：手拉手时自然垂着，搭桥时叉腰（和举起来的那只手一高一低，洞形好认）
  const outer = id === 'bridge' ? pair(40, -40) : DEFAULT_ARM;
  return {
    id: side < 0 ? id : `${id}~m`,
    ...DUO_TEXT[id],
    upperOk: true,
    noMirror: true,
    armL: side < 0 ? outer : inner,
    armR: side < 0 ? inner : outer,
    legL: DEFAULT_LEG,
    legR: DEFAULT_LEG,
  };
}
