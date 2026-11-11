import { lerp, rad2deg, deg2rad, type Vec3 } from '../util/math';
import { ANKLE_H, type BodyProfile } from './profile';

/**
 * 用"关节角"描述一个姿势，而不是用关节坐标。
 * 好处：与身材无关。同一份数据套到不同的肢体长度上，就得到每个人自己的目标骨架。
 *
 * 朝向角都在**正面**（墙所在的平面）里量：0° 朝下，90° 水平朝该侧外，180° 朝上；
 * 负值表示越过身体中线伸向另一侧。左 / 右一律指玩家自己的左右。
 */
export interface Limb {
  /** 朝向角（度） */
  a: number;
  /** 正面长度比例，缺省 1。肢体朝向镜头时在正面看会变短，比如深蹲时的大腿。 */
  s?: number;
}

export interface PoseSpec {
  id: string;
  /** 显示给玩家看的名字 */
  name: string;
  /** 难度层：1 最容易 */
  tier: 1 | 2 | 3 | 4;
  /** 只看得到上半身时能不能做 */
  upperOk: boolean;
  /** 墙出现时语音提示的话 */
  say?: string;
  /** [上臂, 前臂] */
  armL: [Limb, Limb];
  armR: [Limb, Limb];
  /** [大腿, 小腿] */
  legL: [Limb, Limb];
  legR: [Limb, Limb];
  /** a：倾角，0 直立，正值朝玩家右侧；s 同时作用于躯干和颈部（弯腰前倾时两者一起变短） */
  spine?: Limb;
  /** 头相对脊柱的偏角 */
  head?: number;
}

export const JOINTS = [
  'head', 'neck',
  'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'handL', 'handR',
  'hipC', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR', 'toeL', 'toeR',
] as const;
export type JointName = (typeof JOINTS)[number];

/** 舞台空间里的一副骨架（x 朝玩家右手、y 朝上、地面 y = 0）。 */
export type Skeleton = Record<JointName, Vec3>;

export const LIMBS = ['upperArmL', 'forearmL', 'upperArmR', 'forearmR', 'thighL', 'shinL', 'thighR', 'shinR', 'spine'] as const;
export type LimbId = (typeof LIMBS)[number];

/** 自然下垂的手臂、自然站立的腿。 */
export const DEFAULT_ARM: [Limb, Limb] = [{ a: 8 }, { a: 4 }];
export const DEFAULT_LEG: [Limb, Limb] = [{ a: 4 }, { a: 0 }];

/** 自然站立：手臂下垂、双脚微分。 */
export const NEUTRAL: PoseSpec = {
  id: 'stand',
  name: '站好',
  tier: 1,
  upperOk: true,
  armL: DEFAULT_ARM,
  armR: DEFAULT_ARM,
  legL: DEFAULT_LEG,
  legR: DEFAULT_LEG,
};

/** 肢体的朝向角。side：-1 是左侧肢体，+1 是右侧肢体。结果在 (-180, 180]。 */
export function limbAngle(fromX: number, fromY: number, toX: number, toY: number, side: -1 | 1): number {
  const outward = (toX - fromX) * side + 0; // + 0 把 -0 变成 0，免得正上方算出 -180
  return rad2deg(Math.atan2(outward, -(toY - fromY)));
}

/** 两个角度之间的最小夹角，0～180。 */
export function angleDiff(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

const dirOf = (a: number, side: -1 | 1) => ({ x: side * Math.sin(deg2rad(a)), y: -Math.cos(deg2rad(a)) });
const sc = (l: Limb): number => l.s ?? 1;

/**
 * 正向运动学：姿势（关节角）+ 身材（骨长）→ 骨架（关节坐标）。
 * 脚踩地：两只脚里较低的那只，踝关节落在 y = ANKLE_H。
 */
export function poseToSkeleton(spec: PoseSpec, p: BodyProfile, at: { x?: number } = {}): Skeleton {
  const chain = (ox: number, oy: number, limbs: [Limb, Limb], lens: [number, number], side: -1 | 1) => {
    const d0 = dirOf(limbs[0].a, side);
    const d1 = dirOf(limbs[1].a, side);
    const midX = ox + lens[0] * sc(limbs[0]) * d0.x;
    const midY = oy + lens[0] * sc(limbs[0]) * d0.y;
    return {
      mid: { x: midX, y: midY },
      end: { x: midX + lens[1] * sc(limbs[1]) * d1.x, y: midY + lens[1] * sc(limbs[1]) * d1.y },
      endDir: d1,
    };
  };

  // 先把髋放在原点摆腿，看哪只脚低，再整体抬到脚踩地
  const legL = chain(-p.hipW / 2, 0, spec.legL, [p.thigh, p.shin], -1);
  const legR = chain(p.hipW / 2, 0, spec.legR, [p.thigh, p.shin], 1);
  const hipY = ANKLE_H - Math.min(legL.end.y, legR.end.y);
  const hipX = at.x ?? 0;

  const lean = deg2rad(spec.spine?.a ?? 0);
  const spineScale = spec.spine?.s ?? 1;
  const neckX = hipX + p.torso * spineScale * Math.sin(lean);
  const neckY = hipY + p.torso * spineScale * Math.cos(lean);
  // 肩线垂直于脊柱
  const axisX = Math.cos(lean);
  const axisY = -Math.sin(lean);
  const shR = { x: neckX + (axisX * p.shoulderW) / 2, y: neckY + (axisY * p.shoulderW) / 2 };
  const shL = { x: neckX - (axisX * p.shoulderW) / 2, y: neckY - (axisY * p.shoulderW) / 2 };
  const headTilt = lean + deg2rad(spec.head ?? 0);

  const armL = chain(shL.x, shL.y, spec.armL, [p.upperArm, p.forearm], -1);
  const armR = chain(shR.x, shR.y, spec.armR, [p.upperArm, p.forearm], 1);

  const v = (x: number, y: number): Vec3 => ({ x, y, z: 0 });
  return {
    head: v(neckX + p.neck * spineScale * Math.sin(headTilt), neckY + p.neck * spineScale * Math.cos(headTilt)),
    neck: v(neckX, neckY),
    shoulderL: v(shL.x, shL.y),
    shoulderR: v(shR.x, shR.y),
    elbowL: v(armL.mid.x, armL.mid.y),
    elbowR: v(armR.mid.x, armR.mid.y),
    wristL: v(armL.end.x, armL.end.y),
    wristR: v(armR.end.x, armR.end.y),
    handL: v(armL.end.x + p.hand * armL.endDir.x, armL.end.y + p.hand * armL.endDir.y),
    handR: v(armR.end.x + p.hand * armR.endDir.x, armR.end.y + p.hand * armR.endDir.y),
    hipC: v(hipX, hipY),
    hipL: v(hipX - p.hipW / 2, hipY),
    hipR: v(hipX + p.hipW / 2, hipY),
    kneeL: v(hipX + legL.mid.x, hipY + legL.mid.y),
    kneeR: v(hipX + legR.mid.x, hipY + legR.mid.y),
    ankleL: v(hipX + legL.end.x, hipY + legL.end.y),
    ankleR: v(hipX + legR.end.x, hipY + legR.end.y),
    toeL: v(hipX + legL.end.x - 0.05, hipY + legL.end.y - 0.05),
    toeR: v(hipX + legR.end.x + 0.05, hipY + legR.end.y - 0.05),
  };
}

/** 每段肢体的起止关节、所在侧、对应的骨长。 */
const LIMB_DEF: Record<Exclude<LimbId, 'spine'>, { from: JointName; to: JointName; side: -1 | 1; len: (p: BodyProfile) => number }> = {
  upperArmL: { from: 'shoulderL', to: 'elbowL', side: -1, len: (p) => p.upperArm },
  forearmL: { from: 'elbowL', to: 'wristL', side: -1, len: (p) => p.forearm },
  upperArmR: { from: 'shoulderR', to: 'elbowR', side: 1, len: (p) => p.upperArm },
  forearmR: { from: 'elbowR', to: 'wristR', side: 1, len: (p) => p.forearm },
  thighL: { from: 'hipL', to: 'kneeL', side: -1, len: (p) => p.thigh },
  shinL: { from: 'kneeL', to: 'ankleL', side: -1, len: (p) => p.shin },
  thighR: { from: 'hipR', to: 'kneeR', side: 1, len: (p) => p.thigh },
  shinR: { from: 'kneeR', to: 'ankleR', side: 1, len: (p) => p.shin },
};

/** 每段肢体用到哪两个关节（判定时据此决定这段"看不看得见"）。 */
export function limbJoints(limb: LimbId): [JointName, JointName] {
  return limb === 'spine' ? ['hipC', 'neck'] : [LIMB_DEF[limb].from, LIMB_DEF[limb].to];
}

/** 从骨架量出每段肢体的朝向角和正面长度比例（poseToSkeleton 的逆运算）。 */
export function measureLimbs(sk: Skeleton, p: BodyProfile): Record<LimbId, { angle: number; scale: number }> {
  const out = {} as Record<LimbId, { angle: number; scale: number }>;
  for (const limb of LIMBS) {
    if (limb === 'spine') {
      const dx = sk.neck.x - sk.hipC.x;
      const dy = sk.neck.y - sk.hipC.y;
      out.spine = { angle: rad2deg(Math.atan2(dx, dy)), scale: Math.hypot(dx, dy) / p.torso };
      continue;
    }
    const def = LIMB_DEF[limb];
    const a = sk[def.from];
    const b = sk[def.to];
    out[limb] = { angle: limbAngle(a.x, a.y, b.x, b.y, def.side), scale: Math.hypot(b.x - a.x, b.y - a.y) / def.len(p) };
  }
  return out;
}

/** 姿势数据里写的目标角度和比例，整理成和 measureLimbs 一样的结构，方便逐段比较。 */
export function targetLimbs(spec: PoseSpec): Record<LimbId, { angle: number; scale: number }> {
  const t = (l: Limb) => ({ angle: l.a, scale: sc(l) });
  return {
    upperArmL: t(spec.armL[0]),
    forearmL: t(spec.armL[1]),
    upperArmR: t(spec.armR[0]),
    forearmR: t(spec.armR[1]),
    thighL: t(spec.legL[0]),
    shinL: t(spec.legL[1]),
    thighR: t(spec.legR[0]),
    shinR: t(spec.legR[1]),
    spine: { angle: spec.spine?.a ?? 0, scale: spec.spine?.s ?? 1 },
  };
}

/**
 * 把一副骨架"读"成姿势数据（实验室里"存成新墙"用）。角度取整到 1°，比例取整到 0.05。
 * 比例在 0.92 以上的一律当作"没缩短"：伸直的肢体量出来短个百分之几，是关键点的抖动和身材估计的误差，不是姿势。
 */
export function poseFromSkeleton(sk: Skeleton, p: BodyProfile): Pick<PoseSpec, 'armL' | 'armR' | 'legL' | 'legR' | 'spine'> {
  const m = measureLimbs(sk, p);
  const limb = (id: LimbId): Limb => {
    const a = Math.round(m[id].angle) + 0;
    const s = Math.min(1, Math.round(m[id].scale * 20) / 20);
    return s >= 0.92 ? { a } : { a, s };
  };
  const spine = limb('spine');
  return {
    armL: [limb('upperArmL'), limb('forearmL')],
    armR: [limb('upperArmR'), limb('forearmR')],
    legL: [limb('thighL'), limb('shinL')],
    legR: [limb('thighR'), limb('shinR')],
    ...(spine.a !== 0 || spine.s !== undefined ? { spine } : {}),
  };
}

/** 左右镜像。id 加上（或去掉）'~m' 后缀，所以镜像两次回到原样。 */
export function mirrorPose(spec: PoseSpec): PoseSpec {
  const out: PoseSpec = {
    ...spec,
    id: spec.id.endsWith('~m') ? spec.id.slice(0, -2) : `${spec.id}~m`,
    armL: spec.armR,
    armR: spec.armL,
    legL: spec.legR,
    legR: spec.legL,
  };
  if (spec.spine) out.spine = { ...spec.spine, a: 0 - spec.spine.a };
  if (spec.head !== undefined) out.head = 0 - spec.head;
  return out;
}

export function lerpSkeleton(a: Skeleton, b: Skeleton, k: number): Skeleton {
  const out = {} as Skeleton;
  for (const j of JOINTS) out[j] = { x: lerp(a[j].x, b[j].x, k), y: lerp(a[j].y, b[j].y, k), z: lerp(a[j].z, b[j].z, k) };
  return out;
}
