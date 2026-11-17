import type { ViewWindow } from '../../engine/body/bodyModel';
import { JOINTS, mirrorPose, poseToSkeleton, type JointName, type PoseSpec } from '../../engine/body/pose';
import type { BodyProfile } from '../../engine/body/profile';
import { clamp, lerp } from '../../engine/util/math';
import { createRng, type Rng } from '../../engine/util/rng';
import { skeletonCapsules } from './bodyShape';
import { bodyGap, duoArmAngle } from './duo';
import { DUO_POSE_IDS, duoPose, getPose, POSES, type DuoPoseId } from './poses';
import { SHAPES, type ShapeSpec } from './shapes';
import { COMMON, TUNING, type Difficulty, type Tuning } from './tuning';

/**
 * 十五关。每一关有一个主题和一批**这一关新出现**的造型；出墙时一部分名额给新造型，一部分拿前面学过的来复习
 * （各几面见 tuning.ts 的 levelSlots）。难度是这张表排出来的，不是随机撞出来的：
 *
 *   热身（只动手）→ 双脚打开 → 左右不对称 → 侧弯 → 马步 → 几何洞 → 弓步 → 深蹲 → 挪步 →
 *   弯腰 → 单脚 → 踢腿 → 组合 → 更难的组合 → 最后一关把最难的四关再过一遍。
 *
 * 想加新姿势：在 poses.ts 里写好，再把它的 id 放进下面某一关的 poses 里（一个造型只属于一关）。
 */
export interface LevelDef {
  /** 这一关的名字，过关时预告用 */
  theme: string;
  /** 这一关新出现的人形姿势（poses.ts 里的 id） */
  poses: string[];
  /** 这一关新出现的几何洞（shapes.ts 里的 id） */
  shapes: string[];
  /** 复习只从这几关（含两端）新出现的造型里挑；不写 = 前面所有关 */
  reviewFrom?: [number, number];
}

export const LEVELS: LevelDef[] = [
  { theme: '热身', poses: ['t', 'y', 'up', 'a', 'flex', 'hips', 'scarecrow', 'head'], shapes: [] },
  { theme: '双脚打开', poses: ['star', 'x-jump', 'a-frame'], shapes: [] },
  { theme: '一高一低', poses: ['salute', 'disco', 'signal', 'teapot', 'wave', 'archer'], shapes: [] },
  { theme: '弯弯腰', poses: ['side-bend', 'seesaw', 'moon', 'hero'], shapes: [] },
  { theme: '扎马步', poses: ['horse', 'squat', 'wide-t', 'sumo'], shapes: [] },
  { theme: '钻洞', poses: [], shapes: ['slot', 'keyhole'] },
  { theme: '弓步', poses: ['lunge', 'warrior', 'archer-lunge', 'lunge-reach'], shapes: [] },
  { theme: '蹲到底', poses: ['low', 'frog', 'squat-up'], shapes: ['low-door', 'round'] },
  { theme: '挪一步', poses: [], shapes: ['side-door'] },
  { theme: '弯腰鞠躬', poses: ['bow', 'airplane'], shapes: [] },
  { theme: '金鸡独立', poses: ['crane', 'white-crane', 'flamingo', 'tree'], shapes: [] },
  { theme: '踢腿', poses: ['side-kick', 'skater', 'one-leg-star'], shapes: [] },
  { theme: '组合技', poses: ['horse-disco', 'horse-salute', 'lunge-moon', 'squat-flex'], shapes: [] },
  { theme: '高手进阶', poses: ['crane-salute', 'tree-t', 'kick-up'], shapes: [] },
  { theme: '终极挑战', poses: [], shapes: [], reviewFrom: [11, 14] },
];

/**
 * 自己存的墙（姿势实验室里"存成新墙"的）不在上面的表里：按它的难度层，从这一关起进"复习"的池子。
 * 第 1 关没有复习名额，所以最容易的也要到第 2 关。
 */
export const CUSTOM_FROM_LEVEL: Record<1 | 2 | 3 | 4, number> = { 1: 2, 2: 3, 3: 5, 4: 11 };

/** 双人专属的两个造型各在哪一关新出现（只有双人模式才出）。 */
const DUO_INTRO: Record<DuoPoseId, number> = { 'hold-hands': 1, bridge: 2 };

/** 一关的规则：出几面墙、多快、多严。 */
export interface LevelPlan {
  level: number;
  /** 这一关一共几面墙 = fresh + review */
  walls: number;
  /** 其中几面出这一关新出现的造型 */
  fresh: number;
  /** 几面拿前面的造型来复习 */
  review: number;
  theme: string;
  /** 复习的人形洞是否可能开在玩家旁边（需要挪步） */
  offsets: boolean;
  angleTol: number;
  approachSec: number;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** 第几关的规则。墙速和容差从第 1 关的值**线性**过渡到最后一关的下限值（各难度档有各自的起点和下限）。 */
export function levelPlan(level: number, t: Tuning): LevelPlan {
  const n = clamp(Math.floor(level), 1, COMMON.levels);
  const k = (n - 1) / (COMMON.levels - 1);
  const [fresh, review] = COMMON.levelSlots[n - 1];
  return {
    level: n,
    walls: fresh + review,
    fresh,
    review,
    theme: LEVELS[n - 1].theme,
    offsets: n >= COMMON.offsetFromLevel,
    angleTol: round2(lerp(t.angleTol, t.angleTolFloor, k)),
    approachSec: round2(lerp(t.approach, t.approachFloor, k)),
  };
}

/** 一面墙的"订单"：造型、位置、速度、容差。真正的墙体由 build.ts 按它造出来。 */
export interface WallSpec {
  /** 整局第几面墙，从 1 开始 */
  index: number;
  level: number;
  kind: 'pose' | 'shape';
  pose?: PoseSpec;
  shape?: ShapeSpec;
  /** 洞的中心在舞台上的左右位置 */
  holeX: number;
  approachSec: number;
  angleTol: number;
  /** 这个造型是不是这一关新出现的（否则是复习） */
  fresh: boolean;
  /**
   * 双人：2 号玩家（右边那位）的洞。和 1 号的同一种（都是人形或都是几何洞），造型可以不同。
   * 有它，这面墙就是一面"两个洞"的墙。
   */
  mate?: { pose?: PoseSpec; shape?: ShapeSpec; holeX: number };
  /** 这面墙是哪个双人专属造型（手拉手、搭桥） */
  duo?: DuoPoseId;
}

/** 出墙那一刻的现场情况。 */
export interface SpawnCtx {
  mode: 'full' | 'upper';
  /** 摄像头看得见的范围；null 表示不限 */
  view: ViewWindow | null;
  profile: BodyProfile;
  /** 玩家现在站的左右位置 */
  playerX: number;
  /** 双人：2 号玩家（屏幕右边那位）的现场情况。给了它，出的就是两个洞的墙 */
  mate?: { view: ViewWindow | null; profile: BodyProfile; playerX: number };
  /** 双人：两条泳道的中心（标定时两人各自站的位置）。不给就当作两人现在站的地方 */
  lanes?: [number, number];
}

const UPPER_JOINTS: JointName[] = ['head', 'neck', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'handL', 'handR'];
/**
 * 全身模式下，目标姿势的哪些关节必须落在摄像头看得见的范围里：判定用得到的那些。
 * 脚尖不算——判定只看到脚踝。要是把脚尖也算上，画面下边缘正好切在脚踝和脚尖之间时就没有一面墙"放得下"了。
 */
const FULL_JOINTS: JointName[] = JOINTS.filter((j) => j !== 'toeL' && j !== 'toeR');

const sameLimbs = (a: PoseSpec['armL'], b: PoseSpec['armL']): boolean =>
  a[0].a === b[0].a && a[1].a === b[1].a && (a[0].s ?? 1) === (b[0].s ?? 1) && (a[1].s ?? 1) === (b[1].s ?? 1);

/** 左右镜像后会不会不一样。 */
const isAsymmetric = (p: PoseSpec): boolean => !sameLimbs(p.armL, p.armR) || !sameLimbs(p.legL, p.legR) || (p.spine?.a ?? 0) !== 0 || (p.head ?? 0) !== 0;
/** 出墙时可以取它的镜像。 */
const canMirror = (p: PoseSpec): boolean => isAsymmetric(p) && !p.noMirror;

const baseId = (id: string): string => id.replace(/~m$/, '');

/** 池子里的一个造型，连同它在关卡表里的位置。 */
interface Item {
  id: string;
  pose?: PoseSpec;
  shape?: ShapeSpec;
  /** 双人专属造型：姿势要按两人当场的间距现算，所以这里只有名字 */
  duo?: DuoPoseId;
  upperOk: boolean;
  /** 自己存的（不在关卡表里） */
  custom: boolean;
  /** 哪一关新出现；自己存的没有"新出现"这回事，记 0 */
  intro: number;
  /** 从哪一关起可以拿来复习 */
  reviewAt: number;
}

/** 一位玩家出墙时的现场：看得见的范围、身材、洞该开在哪。 */
interface Spot {
  mode: 'full' | 'upper';
  view: ViewWindow | null;
  profile: BodyProfile;
  /** 洞的"原位"：他现在站的地方 */
  home: number;
}

/** 一个洞：实际用的姿势（可能取了镜像）或几何形状，和它的位置。 */
interface Hole {
  item: Item;
  pose?: PoseSpec;
  shape?: ShapeSpec;
  holeX: number;
}

/** 一个造型落到这面墙上的样子。双人时多一个洞。 */
interface Placement extends Hole {
  mate?: Hole;
  duo?: DuoPoseId;
}

/** 每个内置造型是哪一关新出现的 */
const INTRO = new Map<string, number>();
LEVELS.forEach((def, i) => {
  for (const id of [...def.poses, ...def.shapes]) INTRO.set(id, i + 1);
});

function toItem(src: { pose: PoseSpec } | { shape: ShapeSpec }): Item {
  const pose = 'pose' in src ? src.pose : undefined;
  const shape = 'shape' in src ? src.shape : undefined;
  const one = (pose ?? shape)!;
  const intro = INTRO.get(one.id) ?? 0;
  // 不在表里的：人形的按难度层；几何洞（目前没有自定义的）和第一批几何洞同时
  const reviewAt = intro ? intro + 1 : pose ? CUSTOM_FROM_LEVEL[pose.tier] : INTRO.get('slot')!;
  return { id: one.id, pose, shape, upperOk: one.upperOk, custom: intro === 0, intro, reviewAt };
}

const DUO_ITEMS: Item[] = DUO_POSE_IDS.map((id) => ({ id, duo: id, upperOk: true, custom: false, intro: DUO_INTRO[id], reviewAt: DUO_INTRO[id] + 1 }));

/**
 * 出墙顺序。给定种子、现场情况和造型池，出的墙完全确定——同一关可以重玩、可以和别人比。
 * 难度档位只影响速度和容差，不影响出墙顺序。
 *
 * 单人：一面墙一个洞。双人（现场情况里带着 mate）：一面墙两个洞，见 placePair。
 */
export class WallSequence {
  private readonly rng: Rng;
  private readonly tuning: Tuning;
  private readonly items: Item[];
  /** 池子里只有一面墙（"试试这面墙"）：这时只练它，不掺别的 */
  private readonly practice: boolean;
  private index = 0;
  /** 上一面墙出的造型（双人时是两个） */
  private lastIds = new Set<string>();
  /** 这一关已经出过的造型 */
  private used = new Set<string>();
  /** 这一局已经出过的自存墙 */
  private customSeen = new Set<string>();
  /** 这一关每一面墙的名额：true = 新造型，false = 复习 */
  private slots: boolean[] = [];
  /** 这一关出过用到腿的墙没有 */
  private legsSeen = false;
  /** 双人：两条泳道之间的那条线在舞台上的位置（两条泳道中心的正中） */
  private midline = 0;

  level: number;
  /** 刚出的这面墙是本关第几面 */
  wallInLevel = 0;

  constructor(seed: number, difficulty: Difficulty, pool?: { poses: PoseSpec[]; shapes: ShapeSpec[] }, opts: { startLevel?: number } = {}) {
    this.rng = createRng(seed);
    this.tuning = TUNING[difficulty];
    this.items = [...(pool?.poses ?? POSES).map((pose) => toItem({ pose })), ...(pool?.shapes ?? SHAPES).map((shape) => toItem({ shape }))];
    this.practice = this.items.length <= 1;
    this.level = clamp(Math.floor(opts.startLevel ?? 1), 1, COMMON.levels);
    this.enterLevel();
  }

  get wallsInLevel(): number {
    return levelPlan(this.level, this.tuning).walls;
  }

  /** 池子里只有一面墙，这一局就是反复练它（"试试这面墙"） */
  get practising(): boolean {
    return this.practice;
  }

  /** 最后一关的墙也出完了 */
  get finished(): boolean {
    return this.level >= COMMON.levels && this.wallInLevel >= this.wallsInLevel;
  }

  next(ctx: SpawnCtx): WallSpec {
    if (this.index > 0 && this.wallInLevel >= this.wallsInLevel) {
      // 最后一关之后没有下一关：再要墙的话（正常不会），接着出最后一关的
      if (this.level < COMMON.levels) this.level++;
      this.enterLevel();
    }
    this.index++;
    this.wallInLevel++;
    const plan = levelPlan(this.level, this.tuning);
    const spots = this.spots(ctx);
    const wantFresh = this.slots[this.wallInLevel - 1] ?? false;

    const placed = this.opener(spots, plan) ?? this.choose(spots, wantFresh, plan) ?? this.lastResort(spots);
    const holes = placed.mate ? [placed, placed.mate] : [placed];
    this.lastIds = new Set(holes.map((h) => baseId(h.item.id)));
    for (const h of holes) {
      this.used.add(baseId(h.item.id));
      if (h.item.custom) this.customSeen.add(baseId(h.item.id));
      if (!h.item.upperOk) this.legsSeen = true;
    }

    const what = (h: Hole): { pose: PoseSpec } | { shape: ShapeSpec } => (h.pose ? { pose: h.pose } : { shape: h.shape! });
    return {
      index: this.index,
      level: this.level,
      kind: placed.pose ? 'pose' : 'shape',
      ...what(placed),
      holeX: placed.holeX,
      approachSec: plan.approachSec,
      angleTol: plan.angleTol,
      fresh: this.isFresh(placed.item),
      ...(placed.mate ? { mate: { ...what(placed.mate), holeX: placed.mate.holeX } } : {}),
      ...(placed.duo ? { duo: placed.duo } : {}),
    };
  }

  /**
   * 刚出的这面墙不算数（没判就作废了：人一直没被看到，或者中途重新标定了）：不计入这一关的进度。
   * 整局的编号（index）照常往后排。
   */
  forgetLast(): void {
    this.wallInLevel = Math.max(0, this.wallInLevel - 1);
  }

  /** 这一关从头再来（没命之后"再闯这一关"）：进度清零，这一关的墙重新抽。 */
  restartLevel(): void {
    this.enterLevel();
  }

  private enterLevel(): void {
    const plan = levelPlan(this.level, this.tuning);
    this.wallInLevel = 0;
    this.used.clear();
    this.legsSeen = false;
    this.slots = this.rng.shuffle([...Array<boolean>(plan.fresh).fill(true), ...Array<boolean>(plan.review).fill(false)]);
  }

  /** 每位玩家的洞该开在哪。单人：他站的地方。双人：各自站的地方，但不离开自己的泳道太远，也不互相凑得太近。 */
  private spots(ctx: SpawnCtx): Spot[] {
    const one = { mode: ctx.mode, view: ctx.view, profile: ctx.profile };
    if (!ctx.mate) return [{ ...one, home: clamp(ctx.playerX, -COMMON.maxHoleX, COMMON.maxHoleX) }];

    const lanes = ctx.lanes ?? [ctx.playerX, ctx.mate.playerX];
    this.midline = (lanes[0] + lanes[1]) / 2;
    const drift = COMMON.duo.maxDrift;
    // 洞跟着人走，但不离开自己泳道的中心太远，更不能凑到两人中线跟前
    let a = Math.min(clamp(ctx.playerX, lanes[0] - drift, lanes[0] + drift), this.midline - COMMON.duo.sideMargin);
    let b = Math.max(clamp(ctx.mate.playerX, lanes[1] - drift, lanes[1] + drift), this.midline + COMMON.duo.sideMargin);
    // 两个人都往中间凑了：洞还是得隔开，不然哪种配对都放不下
    const least = COMMON.duo.minGap - 0.2;
    if (b - a < least) {
      const mid = (a + b) / 2;
      a = mid - least / 2;
      b = mid + least / 2;
    }
    return [
      { ...one, home: a },
      { mode: ctx.mode, view: ctx.mate.view, profile: ctx.mate.profile, home: b },
    ];
  }

  private isFresh(item: Item): boolean {
    return !item.custom && item.intro === this.level;
  }

  /** 这一关能拿这个造型来复习吗。 */
  private isReview(item: Item): boolean {
    const range = LEVELS[this.level - 1].reviewFrom;
    if (item.custom || !range) return item.reviewAt <= this.level;
    return item.intro >= range[0] && item.intro <= range[1];
  }

  /**
   * 整局第一面墙固定是最好认的 T 字，算是热身。
   * 双人时两个 T 字并排要站得很开才放得下；放不下就用"手拉手"开场。
   */
  private opener(spots: Spot[], plan: LevelPlan): Placement | null {
    if (this.index !== 1 || this.level !== 1) return null;
    const t = this.items.find((it) => it.id === 't');
    const placed = t ? this.place(t, spots, plan, []) : null;
    if (placed || spots.length === 1 || this.practice) return placed;
    return this.place(DUO_ITEMS[0], spots, plan, []);
  }

  /**
   * 给这面墙挑一个造型。候选一批一批放宽：
   *   这个名额该出的（新 / 复习）→ 另一种 → 到这一关为止出现过的任何造型（允许这一关里重复）→ 池子里的任何造型。
   * 每一批里按下面的偏好排个先后，取第一个放得下的。
   */
  private choose(spots: Spot[], wantFresh: boolean, plan: LevelPlan): Placement | null {
    const pool = spots.length === 2 && !this.practice ? [...this.items, ...DUO_ITEMS] : this.items;
    const able = pool.filter((it) => spots[0].mode === 'full' || it.upperOk);
    const notLast = able.filter((it) => !this.lastIds.has(baseId(it.id)));
    const unused = notLast.filter((it) => !this.used.has(baseId(it.id)));
    // 双人专属造型在它那一关必出一次：排在这一关别的新造型前面
    const fresh = (): Item[] => {
      const list = this.rng.shuffle(unused.filter((it) => this.isFresh(it)));
      return [...list.filter((it) => it.duo), ...list.filter((it) => !it.duo)];
    };
    const review = (): Item[] => this.reviewOrder(unused.filter((it) => this.isReview(it)));

    const batches: (() => Item[])[] = [
      ...(wantFresh ? [fresh, review] : [review, fresh]),
      () => this.rng.shuffle(notLast.filter((it) => this.isFresh(it) || this.isReview(it))),
      () => this.rng.shuffle(notLast),
      () => this.rng.shuffle(able),
    ];
    for (const batch of batches) {
      const list = batch();
      for (const item of list) {
        const placed = this.place(item, spots, plan, list);
        if (placed) return placed;
      }
    }
    return null;
  }

  /**
   * 复习的候选排个先后：
   *   - 这一关还没出过用腿的墙，就先出用腿的（不然"一高一低""钻洞"这几关可能一面用腿的都没有）；
   *   - 有自己存的、这一局还没出过的墙时，一半的机会先给它们（不然几十个内置造型里很难轮到它）；
   *   - 其余按"越近的关越容易被抽到"加权。
   */
  private reviewOrder(pool: Item[]): Item[] {
    const weighted = (list: Item[]): Item[] => {
      const left = [...list];
      const out: Item[] = [];
      while (left.length) {
        const weights = left.map((it) => Math.pow(COMMON.reviewDecay, Math.max(0, this.level - it.reviewAt)));
        let r = this.rng.next() * weights.reduce((a, b) => a + b, 0);
        let k = 0;
        while (k < left.length - 1 && (r -= weights[k]) >= 0) k++;
        out.push(...left.splice(k, 1));
      }
      return out;
    };
    const unseen = pool.filter((it) => it.custom && !this.customSeen.has(baseId(it.id)));
    const first = unseen.length && this.rng.chance(COMMON.customChance) ? this.rng.shuffle(unseen) : [];
    const rest = pool.filter((it) => !first.includes(it));
    const legs = this.legsSeen ? [] : rest.filter((it) => !it.upperOk);
    return [...first, ...weighted(legs), ...weighted(rest.filter((it) => !legs.includes(it)))];
  }

  /** 把一个造型放到这面墙上；现场放不下就返回 null。others：同一批候选（双人"搭配"时从里面给 2 号另挑一个）。 */
  private place(item: Item, spots: Spot[], plan: LevelPlan, others: Item[]): Placement | null {
    return spots.length === 2 ? this.placePair(item, spots[0], spots[1], plan, others) : this.placeOne(item, spots[0], plan);
  }

  private placeOne(item: Item, spot: Spot, plan: LevelPlan): Placement | null {
    const home = spot.home;
    const inStage = (x: number): number => clamp(x, -COMMON.maxHoleX, COMMON.maxHoleX);

    if (item.shape) {
      const shape = item.shape;
      if (!shape.offset) return this.fits(shape.demo, home, spot) ? { item, shape, holeX: home } : null;
      // 偏门这类开在旁边的洞：随机选一边，那边放不下就换另一边
      const sign = this.rng.chance(0.5) ? 1 : -1;
      const x = [home + sign * shape.offset, home - sign * shape.offset].map(inStage).find((v) => this.fits(shape.demo, v, spot));
      return x === undefined ? null : { item, shape, holeX: x };
    }
    if (!item.pose) return null; // 双人专属造型一个人做不了

    let pose = item.pose;
    if (!this.fits(pose, home, spot)) return null;
    if (canMirror(pose) && this.rng.chance(0.5)) {
      const mirrored = mirrorPose(pose);
      if (this.fits(mirrored, home, spot)) pose = mirrored;
    }

    let holeX = home;
    // 挪步只给复习的墙：新造型第一次见，让人在原地专心摆
    if (plan.offsets && !this.isFresh(item) && this.rng.chance(COMMON.offsetChance)) {
      const sign = this.rng.chance(0.5) ? 1 : -1;
      const shifted = [home + sign * COMMON.offsetX, home - sign * COMMON.offsetX].map(inStage).find((v) => this.fits(pose, v, spot));
      if (shifted !== undefined) holeX = shifted;
    }
    return { item, pose, holeX };
  }

  /**
   * 双人：给两位玩家各开一个洞。
   *
   *   几何洞 —— 两人各一个同样的洞。
   *   双人专属（手拉手、搭桥）—— 内侧手臂的角度按两人当场隔多远现算，两只手正好在中间碰头。
   *   其余人形姿势 —— "同款"：对称的姿势两人一样；不对称的一人原样、一人镜像，画面左右对称。
   *                   "搭配"（第 mixFromLevel 关起）：2 号换成同一批候选里的另一个造型——
   *                   一字平举这类很宽的姿势，两个人并排摆不下，配一个窄的就摆得下了。
   *
   * 每种配法都要过两道检查：两位各自的每个关节都在摄像头看得见的范围里；两副身体轮廓不碰到一起。
   * 要挪步的话，两个洞朝同一边、挪同样多——两个人一起挪。
   */
  private placePair(item: Item, a: Spot, b: Spot, plan: LevelPlan, others: Item[]): Placement | null {
    const sep = b.home - a.home;
    /** 两个洞一起往旁边挪 dx 之后，两位还都看得见吗 */
    const seen = (pa: PoseSpec, pb: PoseSpec, dx: number): boolean => this.fits(pa, a.home + dx, a) && this.fits(pb, b.home + dx, b);
    /**
     * 试着一起挪 size 那么远：随机先试一边，不行换另一边，都不行就不挪。
     * 往哪边挪，哪边就有一位是朝两人中线走的——他挪完离中线还得留 sideMargin：
     * 站到线上的人会被当成"走出了自己的泳道"（跟丢），游戏就停在那儿了。
     */
    const sidestep = (pa: PoseSpec, pb: PoseSpec, size: number): number => {
      const sign = this.rng.chance(0.5) ? 1 : -1;
      for (const dir of [sign, -sign]) {
        const room = dir > 0 ? this.midline - COMMON.duo.sideMargin - a.home : b.home - this.midline - COMMON.duo.sideMargin;
        const dx = dir * Math.min(size, room);
        if (Math.abs(dx) >= 0.05 && seen(pa, pb, dx)) return dx;
      }
      return 0;
    };
    const hole = (it: Item, pose: PoseSpec | undefined, shape: ShapeSpec | undefined, x: number): Hole => ({ item: it, ...(pose ? { pose } : { shape }), holeX: x });

    if (item.shape) {
      const shape = item.shape;
      const dx = shape.offset ? sidestep(shape.demo, shape.demo, shape.offset) : 0;
      // 偏门就是要人挪过去的：挪不了就不出它
      if (shape.offset ? dx === 0 : !seen(shape.demo, shape.demo, 0)) return null;
      return { ...hole(item, undefined, shape, a.home + dx), mate: hole(item, undefined, shape, b.home + dx) };
    }

    /** 两位按这两个姿势站好，身体轮廓之间空多少 */
    const clearance = (pa: PoseSpec, pb: PoseSpec): number =>
      bodyGap(skeletonCapsules(poseToSkeleton(pa, a.profile, { x: a.home }), a.profile), skeletonCapsules(poseToSkeleton(pb, b.profile, { x: b.home }), b.profile));
    const shifted = (pa: PoseSpec, pb: PoseSpec, mine: Item, theirs: Item): Placement => {
      const wantShift = plan.offsets && !this.isFresh(mine) && this.rng.chance(COMMON.offsetChance);
      const dx = wantShift ? sidestep(pa, pb, COMMON.offsetX) : 0;
      return { ...hole(mine, pa, undefined, a.home + dx), mate: hole(theirs, pb, undefined, b.home + dx), ...(mine.duo ? { duo: mine.duo } : {}) };
    };

    if (item.duo) {
      const pa = duoPose(item.duo, -1, duoArmAngle(item.duo, a.profile, sep / 2));
      const pb = duoPose(item.duo, 1, duoArmAngle(item.duo, b.profile, sep / 2));
      // 两只手之间本来就只留了 handGap 那么宽的缝，所以这里的要求比别的配对松
      if (!seen(pa, pb, 0) || clearance(pa, pb) < COMMON.duo.handGap - 0.01) return null;
      return shifted(pa, pb, item, item);
    }

    const pose = item.pose!;
    const turns = (p: PoseSpec): PoseSpec[] => (canMirror(p) ? this.rng.shuffle([p, mirrorPose(p)]) : [p]);
    type Option = [PoseSpec, PoseSpec, Item];
    const same = (): Option[] => turns(pose).map((p) => [p, canMirror(p) ? mirrorPose(p) : p, item]);
    const mixed = (): Option[] =>
      this.level < COMMON.duo.mixFromLevel
        ? []
        : this.rng
            .shuffle(others.filter((o) => o.pose && o !== item))
            .slice(0, 4)
            .flatMap((o) => turns(pose).flatMap((pa) => turns(o.pose!).map((pb): Option => [pa, pb, o])));
    const mixFirst = this.level >= COMMON.duo.mixFromLevel && this.rng.chance(COMMON.duo.mixChance);
    const options = mixFirst ? [...mixed(), ...same()] : [...same(), ...mixed()];
    for (const [pa, pb, other] of options) {
      if (seen(pa, pb, 0) && clearance(pa, pb) >= COMMON.duo.bodyGap) return shifted(pa, pb, item, other);
    }
    return null;
  }

  /** 什么都放不下：单人退回 T 字；双人退回两人叉腰（两个人并排也摆得下）。绝不卡死。 */
  private lastResort(spots: Spot[]): Placement {
    const pose = getPose(spots.length === 2 ? 'hips' : 't')!;
    const item = toItem({ pose });
    const first: Hole = { item, pose, holeX: spots[0].home };
    return spots.length === 2 ? { ...first, mate: { item, pose, holeX: spots[1].home } } : first;
  }

  /** 摆这个姿势站在 x 处，每个关节是否都在这位玩家的摄像头看得见的范围里。 */
  private fits(pose: PoseSpec, x: number, spot: Spot): boolean {
    const view = spot.view;
    if (!view) return true;
    const sk = poseToSkeleton(pose, spot.profile, { x });
    for (const j of spot.mode === 'upper' ? UPPER_JOINTS : FULL_JOINTS) {
      const p = sk[j];
      if (p.x < view.left + COMMON.viewMargin || p.x > view.right - COMMON.viewMargin || p.y > view.top - COMMON.viewMargin || p.y < view.bottom) return false;
    }
    return true;
  }
}
