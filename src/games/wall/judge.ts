import type { Body } from '../../engine/body/bodyModel';
import { angleDiff, limbJoints, LIMBS, measureLimbs, NEUTRAL, targetLimbs, type LimbId, type PoseSpec } from '../../engine/body/pose';
import type { BodyProfile } from '../../engine/body/profile';
import { clamp01, median } from '../../engine/util/math';
import { limbsToParts, type Capsule, type PartId } from './bodyShape';
import { sampleField, type WallField } from './field';
import { COMMON } from './tuning';

/**
 * 判定：玩家过不过得了这面墙。两类墙两种判法。
 *
 * 人形洞 —— 比**关节角**：每段肢体的朝向和目标姿势差多少度。
 *   好处是与站位远近、高矮胖瘦都无关，而且容差可以直接借用别人实测过的数（轻松 40°/标准 32°/挑战 25°）。
 * 几何洞 —— 查**身体陷进墙体多深**：没有目标姿势，整个人在洞里就行。
 *
 * 每一帧都判一次（用于实时反馈）；墙到达的那一刻，取最近一小段时间里的多次结果投票，
 * 这样单独一帧的抖动不会冤枉人。
 */

// ---------------------------------------------------------------- 人形洞

export interface PoseTol {
  /** 角度容差（度）。目标姿势用到的腿和脊柱会收紧，见 tolFactor */
  angle: number;
  /** 站位容差（米） */
  pos: number;
}

export interface PoseJudge {
  kind: 'pose';
  matched: boolean;
  /** 0～1。摆对时在 0.5～1 之间，用来评星 */
  accuracy: number;
  /** 每段肢体的误差（度）；没参与判定的肢体不在里面 */
  errors: Partial<Record<LimbId, number>>;
  /** 超出容差的肢体 */
  bad: LimbId[];
  posOk: boolean;
  /** 玩家相对洞的左右偏移（米），正值表示玩家偏右 */
  dx: number;
}

const LEG_LIMBS = new Set<LimbId>(['thighL', 'shinL', 'thighR', 'shinR']);
const STANDING = targetLimbs(NEUTRAL);

/**
 * 这段肢体的容差是基本容差的几倍。
 *
 * 手臂：1 倍。
 * 腿和脊柱：看这面墙用没用到它。
 *   用到了（目标明显不是自然站着：双脚分开、侧弯、下蹲……）→ 收紧（COMMON.legSpineTol，一半）。
 *     它们的活动范围比手臂小得多，"双脚分开 22°"和"站直"只差十几度，给足容差就等于怎么放都算对。
 *   没用到（只动手的墙）→ 1 倍。人随便站着就行，脚分开一点、身子歪一点不该判错。
 */
function tolFactor(limb: LimbId, want: { angle: number; scale: number }): number {
  if (limb !== 'spine' && !LEG_LIMBS.has(limb)) return 1;
  const used = angleDiff(want.angle, STANDING[limb].angle) > COMMON.neutralBandDeg || want.scale < 0.9;
  return used ? COMMON.legSpineTol : 1;
}

export function judgePose(target: PoseSpec, holeX: number, body: Body, profile: BodyProfile, tol: PoseTol): PoseJudge {
  const want = targetLimbs(target);
  const got = measureLimbs(body.skeleton, profile);
  const errors: PoseJudge['errors'] = {};
  const bad: LimbId[] = [];
  const normalised: number[] = [];

  for (const limb of LIMBS) {
    if (body.mode === 'upper' && LEG_LIMBS.has(limb)) continue; // 半身模式的腿是补出来的
    const [a, b] = limbJoints(limb);
    if (!body.ok[a] || !body.ok[b]) continue; // 看不清的不判，不冤枉人

    let err: number;
    if (want[limb].scale < COMMON.shortTarget) {
      err = Math.abs(got[limb].scale - want[limb].scale) * COMMON.scaleAsDeg;
    } else {
      err = angleDiff(got[limb].angle, want[limb].angle);
      if (got[limb].scale < COMMON.shortActual) err = Math.max(err, (want[limb].scale - got[limb].scale) * COMMON.scaleAsDeg);
    }
    errors[limb] = err;
    const n = err / (tol.angle * tolFactor(limb, want[limb]));
    normalised.push(n);
    if (n > 1) bad.push(limb);
  }

  const dx = body.root.x - holeX;
  const posOk = Math.abs(dx) <= tol.pos;

  // 准确度看"最差的一段"和"最差三段的平均"各占一半：
  // 只有一段歪得厉害也会被拉低，不会被其余摆得好的肢体平均掉
  let accuracy = 0;
  if (normalised.length) {
    const sorted = [...normalised].sort((p, q) => q - p);
    const top = sorted.slice(0, 3);
    const meanTop = top.reduce((p, q) => p + q, 0) / top.length;
    accuracy = clamp01(1 - (sorted[0] + meanTop) / 4);
  }

  return { kind: 'pose', matched: normalised.length >= COMMON.minJudgedLimbs && bad.length === 0 && posOk, accuracy, errors, bad, posOk, dx };
}

// ---------------------------------------------------------------- 几何洞

export interface ShapeTol {
  /** 泡沫墙的"弹性"：陷进墙体不超过这么深不算撞（米） */
  slack: number;
  /** 一个部位有多大比例陷进去了才算撞 */
  hitFrac: number;
}

export interface ShapeJudge {
  kind: 'shape';
  hit: boolean;
  /** 全身没有任何地方碰到墙 */
  clean: boolean;
  /** 全身陷得最深的地方有多深（米）；负数表示离墙还有距离 */
  worst: number;
  /** 撞到的部位，陷得最深的排在最前 */
  bad: PartId[];
}

const SAMPLE_STEP = 0.06;

export function judgeShape(field: WallField, caps: Capsule[], tol: ShapeTol): ShapeJudge {
  const depthOf = new Map<PartId, number>();
  let worst = -Infinity;

  for (const c of caps) {
    if (!c.ok) continue;
    const n = Math.max(1, Math.ceil(Math.hypot(c.bx - c.ax, c.by - c.ay) / SAMPLE_STEP));
    let deepest = -Infinity;
    let over = 0;
    for (let k = 0; k <= n; k++) {
      // 轴线上这一点在墙体里多深，再加上肢体自己的半径，就是肢体表面陷进去的深度
      const depth = sampleField(field, c.ax + ((c.bx - c.ax) * k) / n, c.ay + ((c.by - c.ay) * k) / n) + c.r;
      deepest = Math.max(deepest, depth);
      if (depth > tol.slack) over++;
    }
    worst = Math.max(worst, deepest);
    if (over / (n + 1) >= tol.hitFrac || deepest > tol.slack * 2) depthOf.set(c.id, Math.max(depthOf.get(c.id) ?? -Infinity, deepest));
  }

  const bad = [...depthOf.entries()].sort((p, q) => q[1] - p[1]).map(([id]) => id);
  return { kind: 'shape', hit: bad.length > 0, clean: worst <= 0, worst, bad };
}

// ---------------------------------------------------------------- 结果

export type Outcome = { kind: 'hit'; reason: string; badParts: PartId[] } | { kind: 'pass'; stars: 1 | 2 | 3; accuracy: number };

/** 墙到达时调用：把最近一小段时间里的判定结果汇总成最终结果。要过半数才算过。 */
export function resolveOutcome(samples: (PoseJudge | ShapeJudge)[]): Outcome {
  if (samples.length === 0) return { kind: 'hit', reason: reasonText(null), badParts: [] };

  if (samples[0].kind === 'pose') {
    const poses = samples.filter((s): s is PoseJudge => s.kind === 'pose');
    const good = poses.filter((s) => s.matched);
    if (good.length * 2 > poses.length) {
      const accuracy = median(good.map((s) => s.accuracy));
      return { kind: 'pass', stars: accuracy >= COMMON.threeStars ? 3 : accuracy >= COMMON.twoStars ? 2 : 1, accuracy };
    }
    const miss = [...poses].reverse().find((s) => !s.matched)!;
    return { kind: 'hit', reason: reasonText(miss), badParts: limbsToParts(miss.bad) };
  }

  const shapes = samples.filter((s): s is ShapeJudge => s.kind === 'shape');
  const clear = shapes.filter((s) => !s.hit);
  if (clear.length * 2 > shapes.length) {
    const cleanCount = shapes.filter((s) => s.clean).length;
    return { kind: 'pass', stars: cleanCount * 2 > shapes.length ? 3 : 2, accuracy: cleanCount / shapes.length };
  }
  const miss = [...shapes].reverse().find((s) => s.hit)!;
  return { kind: 'hit', reason: reasonText(miss), badParts: miss.bad };
}

const sideOf = (id: string): string => (id.endsWith('L') ? '左' : '右');

/** 一句话告诉玩家哪里不对。左右都是玩家自己的左右（屏幕上也是同一边）。 */
export function reasonText(j: PoseJudge | ShapeJudge | null): string {
  if (!j) return '没看到你';

  if (j.kind === 'pose') {
    if (!j.posOk) return j.dx > 0 ? '往左站一点' : '往右站一点';
    if (j.bad.length === 0) return '姿势不对';
    const worst = [...j.bad].sort((a, b) => (j.errors[b] ?? 0) - (j.errors[a] ?? 0))[0];
    if (worst === 'spine') return '身体没摆正';
    // 说最差的那一类（手或腿）；两边都不对就说"双"，免得只纠正了一边
    const isLeg = LEG_LIMBS.has(worst);
    const sameKind = j.bad.filter((l) => l !== 'spine' && LEG_LIMBS.has(l) === isLeg);
    const both = sameKind.some((l) => l.endsWith('L')) && sameKind.some((l) => l.endsWith('R'));
    return `${both ? '双' : sideOf(worst)}${isLeg ? '腿' : '手'}没摆对`;
  }

  const part = j.bad[0];
  if (!part) return '撞到墙了';
  if (part === 'head') return '头撞到了';
  if (part === 'torso') return '身体撞到了';
  return `${sideOf(part)}${/thigh|shin|foot/.test(part) ? '腿' : '手'}撞到了`;
}
