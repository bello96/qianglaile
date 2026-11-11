import { poseToSkeleton, type Skeleton } from '../../engine/body/pose';
import type { BodyProfile } from '../../engine/body/profile';
import type { Vec2 } from '../../engine/util/math';
import { skeletonCapsules } from './bodyShape';
import { holeEdges, wallOutlines, type WallOutline } from './contour';
import { buildField, capsulesHole, type WallField } from './field';
import type { WallSpec } from './levels';
import type { Tuning } from './tuning';

/** 一面造好的墙：判定和渲染需要的东西都在这里。 */
export interface BuiltWall {
  spec: WallSpec;
  /** 标量场：几何洞的判定查它，3D 墙体也从它来 */
  field: WallField;
  /** 墙体轮廓，交给渲染层拉伸成 3D */
  outlines: WallOutline[];
  /** 洞口的边线，画"落位轮廓"用 */
  ghost: Vec2[][];
  /** 人形洞：目标骨架（过关吸附的目标）。几何洞：示范姿势的骨架（只作提示） */
  target: Skeleton;
  /** 墙上的名牌 */
  label: string;
  /** 墙出现时播报的话 */
  say: string;
}

/**
 * 按"订单"造一面墙。洞是照着**这位玩家的身材**挖的：
 * 人形洞 = 把目标姿势的关节角套到玩家自己的骨长上，得到他摆这个姿势时的身体轮廓，再向外放一圈余量。
 */
export function buildWall(spec: WallSpec, profile: BodyProfile, t: Tuning): BuiltWall {
  const at = { x: spec.holeX };
  let target: Skeleton;
  let field: WallField;
  let label: string;
  let say: string;

  if (spec.kind === 'pose' && spec.pose) {
    target = poseToSkeleton(spec.pose, profile, at);
    field = buildField(capsulesHole(skeletonCapsules(target, profile), t.holeMargin));
    label = spec.pose.name;
    say = spec.pose.say ?? spec.pose.name;
  } else if (spec.shape) {
    target = poseToSkeleton(spec.shape.demo, profile, at);
    field = buildField(spec.shape.build(profile, at));
    label = spec.shape.name;
    say = spec.shape.say ?? spec.shape.name;
  } else {
    throw new Error(`wall ${spec.index} has neither a pose nor a shape`);
  }

  return { spec, field, outlines: wallOutlines(field), ghost: holeEdges(field), target, label, say };
}
