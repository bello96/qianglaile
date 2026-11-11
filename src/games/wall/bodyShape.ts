import { JOINTS, type JointName, type LimbId, type Skeleton } from '../../engine/body/pose';
import type { BodyProfile } from '../../engine/body/profile';

/**
 * 把骨架"加粗"成身体轮廓：每个部位是一个胶囊体（线段 + 半径），头和手是圆。
 * 同一套胶囊有三个用处：挖人形洞、几何洞的碰撞判定、画 3D 小人——所以三者天然对得上。
 */
export const PART_IDS = [
  'head', 'torso',
  'upperArmL', 'forearmL', 'handL', 'upperArmR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
] as const;
export type PartId = (typeof PART_IDS)[number];

/** 正面（墙所在平面）里的一个胶囊体，米。 */
export interface Capsule {
  id: PartId;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
  /** 这个部位这一帧看不看得清；看不清的不参与判定 */
  ok: boolean;
}

export function skeletonCapsules(sk: Skeleton, p: BodyProfile, ok?: Partial<Record<JointName, boolean>>): Capsule[] {
  const seen = (j: JointName): boolean => ok?.[j] ?? true;
  const cap = (id: PartId, a: JointName, b: JointName, r: number): Capsule => ({
    id,
    ax: sk[a].x,
    ay: sk[a].y,
    bx: sk[b].x,
    by: sk[b].y,
    r,
    ok: seen(a) && seen(b),
  });
  return [
    cap('head', 'head', 'head', p.headR),
    // 躯干：一根粗脊柱，加上肩线和骨盆两根横杠
    cap('torso', 'hipC', 'neck', p.r.torso),
    cap('torso', 'shoulderL', 'shoulderR', p.r.shoulder),
    cap('torso', 'hipL', 'hipR', p.r.pelvis),
    cap('upperArmL', 'shoulderL', 'elbowL', p.r.arm),
    cap('forearmL', 'elbowL', 'wristL', p.r.forearm),
    cap('handL', 'handL', 'handL', p.r.hand),
    cap('upperArmR', 'shoulderR', 'elbowR', p.r.arm),
    cap('forearmR', 'elbowR', 'wristR', p.r.forearm),
    cap('handR', 'handR', 'handR', p.r.hand),
    cap('thighL', 'hipL', 'kneeL', p.r.thigh),
    cap('shinL', 'kneeL', 'ankleL', p.r.shin),
    cap('footL', 'ankleL', 'toeL', p.r.foot),
    cap('thighR', 'hipR', 'kneeR', p.r.thigh),
    cap('shinR', 'kneeR', 'ankleR', p.r.shin),
    cap('footR', 'ankleR', 'toeR', p.r.foot),
  ];
}

const LIMB_PARTS: Record<LimbId, PartId[]> = {
  upperArmL: ['upperArmL'],
  forearmL: ['forearmL', 'handL'],
  upperArmR: ['upperArmR'],
  forearmR: ['forearmR', 'handR'],
  thighL: ['thighL'],
  shinL: ['shinL', 'footL'],
  thighR: ['thighR'],
  shinR: ['shinR', 'footR'],
  spine: ['torso', 'head'],
};

/** 姿势判定说"这几段肢体没摆对"，换算成小人身上该变红的部位。 */
export function limbsToParts(limbs: LimbId[]): PartId[] {
  const out: PartId[] = [];
  for (const limb of limbs) for (const part of LIMB_PARTS[limb]) if (!out.includes(part)) out.push(part);
  return out;
}

/** 全部关节都算可见的 ok 表。 */
export function allJointsOk(): Record<JointName, boolean> {
  return Object.fromEntries(JOINTS.map((j) => [j, true])) as Record<JointName, boolean>;
}
