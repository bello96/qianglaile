import type { ViewWindow } from '../../engine/body/bodyModel';
import { JOINTS, mirrorPose, poseToSkeleton, type JointName, type PoseSpec } from '../../engine/body/pose';
import type { BodyProfile } from '../../engine/body/profile';
import { clamp } from '../../engine/util/math';
import { createRng, type Rng } from '../../engine/util/rng';
import { getPose, POSES } from './poses';
import { SHAPES, type ShapeSpec } from './shapes';
import { COMMON, TUNING, type Difficulty, type Tuning } from './tuning';

/** 一关的规则：出几面墙、出哪些造型、多快、多严。 */
export interface LevelPlan {
  level: number;
  walls: number;
  /** 这一关出哪几层的人形姿势 */
  tiers: number[];
  /** 是否出几何洞，以及最高出到哪一层（0 = 不出） */
  shapes: boolean;
  shapeTier: number;
  /** 洞是否可能开在玩家旁边（需要挪步） */
  offsets: boolean;
  angleTol: number;
  approachSec: number;
}

/**
 * 关卡节奏：
 *   第 1 关 对称的手臂姿势 → 第 2 关 加入不对称 → 第 3 关 加入几何洞 →
 *   第 4 关 侧弯 / 下蹲 / 挪步 → 第 5 关起 单脚平衡。同时墙越来越快、容差越来越紧，直到各自的下限。
 */
export function levelPlan(level: number, t: Tuning): LevelPlan {
  const n = Math.max(1, Math.floor(level));
  const tiers = n === 1 ? [1] : n <= 3 ? [1, 2] : n === 4 ? [2, 3] : [2, 3, 4];
  const shapeTier = n < 3 ? 0 : n === 3 ? 2 : 3;
  return {
    level: n,
    walls: Math.min(COMMON.wallsMax, COMMON.wallsBase + n),
    tiers,
    shapes: shapeTier > 0,
    shapeTier,
    offsets: n >= 4,
    angleTol: Math.max(t.angleTolFloor, t.angleTol - COMMON.tolStepPerLevel * (n - 1)),
    approachSec: Math.round(Math.max(t.approachFloor, t.approach - COMMON.approachStepPerLevel * (n - 1)) * 100) / 100,
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
}

/** 出墙那一刻的现场情况。 */
export interface SpawnCtx {
  mode: 'full' | 'upper';
  /** 摄像头看得见的范围；null 表示不限 */
  view: ViewWindow | null;
  profile: BodyProfile;
  /** 玩家现在站的左右位置 */
  playerX: number;
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

const baseId = (id: string): string => id.replace(/~m$/, '');

/**
 * 出墙顺序。给定种子、现场情况和造型池，出的墙完全确定——同一关可以重玩、可以和别人比。
 * 难度档位只影响速度和容差，不影响出墙顺序。
 */
export class WallSequence {
  private readonly rng: Rng;
  private readonly tuning: Tuning;
  private readonly poses: PoseSpec[];
  private readonly shapes: ShapeSpec[];
  private index = 0;
  private lastId = '';
  private used = new Set<string>();

  level = 1;
  /** 刚出的这面墙是本关第几面 */
  wallInLevel = 0;

  constructor(seed: number, difficulty: Difficulty, pool?: { poses: PoseSpec[]; shapes: ShapeSpec[] }) {
    this.rng = createRng(seed);
    this.tuning = TUNING[difficulty];
    this.poses = pool?.poses ?? POSES;
    this.shapes = pool?.shapes ?? SHAPES;
  }

  get wallsInLevel(): number {
    return levelPlan(this.level, this.tuning).walls;
  }

  next(ctx: SpawnCtx): WallSpec {
    if (this.index > 0 && this.wallInLevel >= this.wallsInLevel) {
      this.level++;
      this.wallInLevel = 0;
      this.used.clear();
    }
    this.index++;
    this.wallInLevel++;
    const plan = levelPlan(this.level, this.tuning);
    const home = clamp(ctx.playerX, -COMMON.maxHoleX, COMMON.maxHoleX);
    const common = { index: this.index, level: this.level, approachSec: plan.approachSec, angleTol: plan.angleTol };

    // 整局第一面墙固定是最好认的 T 字，算是热身
    const opener = this.index === 1 ? this.poses.find((p) => p.id === 't') : undefined;
    if (opener && this.fits(opener, home, ctx)) return this.remember({ ...common, kind: 'pose', pose: opener, holeX: home });

    // ---- 几何洞 ----
    if (plan.shapes && this.rng.chance(COMMON.shapeChance)) {
      const options: { shape: ShapeSpec; x: number }[] = [];
      for (const shape of this.shapes) {
        if (shape.tier > plan.shapeTier || !this.allowed(shape, ctx) || shape.id === this.lastId) continue;
        const sign = this.rng.chance(0.5) ? 1 : -1;
        // 偏门这类开在旁边的洞：随机选一边，那边放不下就换另一边
        const xs = shape.offset ? [home + sign * shape.offset, home - sign * shape.offset] : [home];
        const x = xs.map((v) => clamp(v, -COMMON.maxHoleX, COMMON.maxHoleX)).find((v) => this.fits(shape.demo, v, ctx));
        if (x !== undefined) options.push({ shape, x });
      }
      if (options.length) {
        // 本关还没出过的优先
        const fresh = options.filter((o) => !this.used.has(o.shape.id));
        const pick = this.rng.pick(fresh.length ? fresh : options);
        return this.remember({ ...common, kind: 'shape', shape: pick.shape, holeX: pick.x });
      }
    }

    // ---- 人形洞 ----
    const usable = this.poses.filter((p) => this.allowed(p, ctx) && this.fits(p, home, ctx));
    const inTier = usable.filter((p) => plan.tiers.includes(p.tier));
    // 候选逐步放宽：本关的层 → 任意层 → 允许重复；都没有就退回 T 字，绝不卡死
    const candidates = [inTier, usable].map((list) => list.filter((p) => !this.used.has(p.id) && p.id !== this.lastId)).find((list) => list.length) ??
      [inTier, usable].map((list) => list.filter((p) => p.id !== this.lastId)).find((list) => list.length) ??
      usable;
    if (!candidates.length) {
      return this.remember({ ...common, kind: 'pose', pose: getPose('t')!, holeX: home });
    }

    let pose = this.rng.pick(candidates);
    if (isAsymmetric(pose) && this.rng.chance(0.5)) {
      const mirrored = mirrorPose(pose);
      if (this.fits(mirrored, home, ctx)) pose = mirrored;
    }

    let holeX = home;
    if (plan.offsets && this.rng.chance(COMMON.offsetChance)) {
      const sign = this.rng.chance(0.5) ? 1 : -1;
      const shifted = [home + sign * COMMON.offsetX, home - sign * COMMON.offsetX]
        .map((v) => clamp(v, -COMMON.maxHoleX, COMMON.maxHoleX))
        .find((v) => this.fits(pose, v, ctx));
      if (shifted !== undefined) holeX = shifted;
    }
    return this.remember({ ...common, kind: 'pose', pose, holeX });
  }

  /**
   * 刚出的这面墙不算数（没判就作废了：人一直没被看到，或者中途重新标定了）：不计入这一关的进度。
   * 整局的编号（index）照常往后排。
   */
  forgetLast(): void {
    this.wallInLevel = Math.max(0, this.wallInLevel - 1);
  }

  private remember(spec: WallSpec): WallSpec {
    const id = baseId((spec.pose ?? spec.shape)!.id);
    this.lastId = id;
    this.used.add(id);
    return spec;
  }

  /** 这个造型当前模式下做不做得了，以及是不是刚出过。 */
  private allowed(item: { id: string; upperOk: boolean }, ctx: SpawnCtx): boolean {
    return ctx.mode === 'full' || item.upperOk;
  }

  /** 摆这个姿势站在 x 处，每个关节是否都在摄像头看得见的范围里。 */
  private fits(pose: PoseSpec, x: number, ctx: SpawnCtx): boolean {
    const view = ctx.view;
    if (!view) return true;
    const sk = poseToSkeleton(pose, ctx.profile, { x });
    for (const j of ctx.mode === 'upper' ? UPPER_JOINTS : FULL_JOINTS) {
      const p = sk[j];
      if (p.x < view.left + COMMON.viewMargin || p.x > view.right - COMMON.viewMargin || p.y > view.top - COMMON.viewMargin || p.y < view.bottom) return false;
    }
    return true;
  }
}
