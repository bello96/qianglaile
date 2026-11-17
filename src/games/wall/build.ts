import { poseToSkeleton, type PoseSpec, type Skeleton } from '../../engine/body/pose';
import type { BodyProfile } from '../../engine/body/profile';
import type { Vec2 } from '../../engine/util/math';
import type { Sdf } from '../../engine/util/sdf';
import { skeletonCapsules } from './bodyShape';
import { holeEdges, wallOutlines, type WallOutline } from './contour';
import { mergeHoles } from './duo';
import { buildField, capsulesHole, DUO_BOUNDS, type WallField } from './field';
import type { WallSpec } from './levels';
import type { ShapeSpec } from './shapes';
import type { Tuning } from './tuning';

/** 一面造好的墙：判定和渲染需要的东西都在这里。 */
export interface BuiltWall {
  spec: WallSpec;
  /** 标量场：几何洞的判定查它，3D 墙体也从它来。双人时两个洞在同一张场里 */
  field: WallField;
  /** 墙体轮廓，交给渲染层拉伸成 3D */
  outlines: WallOutline[];
  /** 洞口的边线，画"落位轮廓"用 */
  ghost: Vec2[][];
  /** 人形洞：目标骨架（过关吸附的目标）。几何洞：示范姿势的骨架（只作提示）。双人时是 1 号（左边那位）的 */
  target: Skeleton;
  /** 双人：2 号（右边那位）的目标骨架 */
  mate?: { target: Skeleton };
  /** 屏幕底部显示的造型名。双人摆不同造型时是"左 甲 · 右 乙" */
  label: string;
  /** 墙上的名牌：每个洞上方一块 */
  labels: { text: string; x: number }[];
  /** 墙出现时播报的话 */
  say: string;
}

/** 一个洞：给谁挖的、挖成什么样。 */
interface Hole {
  target: Skeleton;
  sdf: Sdf;
  name: string;
  say: string;
  /** 造型的 id（去掉镜像后缀），用来判断两个人是不是同款 */
  id: string;
}

function holeFor(what: { pose?: PoseSpec; shape?: ShapeSpec }, x: number, profile: BodyProfile, t: Tuning, index: number): Hole {
  if (what.pose) {
    const target = poseToSkeleton(what.pose, profile, { x });
    return { target, sdf: capsulesHole(skeletonCapsules(target, profile), t.holeMargin), name: what.pose.name, say: what.pose.say ?? what.pose.name, id: what.pose.id.replace(/~m$/, '') };
  }
  if (what.shape) {
    const shape = what.shape;
    return { target: poseToSkeleton(shape.demo, profile, { x }), sdf: shape.build(profile, { x }), name: shape.name, say: shape.say ?? shape.name, id: shape.id };
  }
  throw new Error(`wall ${index} has neither a pose nor a shape`);
}

/**
 * 按"订单"造一面墙。洞是照着**这位玩家的身材**挖的：
 * 人形洞 = 把目标姿势的关节角套到玩家自己的骨长上，得到他摆这个姿势时的身体轮廓，再向外放一圈余量。
 *
 * 双人（spec.mate 存在）：一面更宽的墙，两个洞，各按各的身材挖（mateProfile 是 2 号的身材）。
 */
export function buildWall(spec: WallSpec, profile: BodyProfile, t: Tuning, mateProfile: BodyProfile = profile): BuiltWall {
  const a = holeFor(spec, spec.holeX, profile, t, spec.index);

  if (!spec.mate) {
    const field = buildField(a.sdf);
    return { spec, field, outlines: wallOutlines(field), ghost: holeEdges(field), target: a.target, label: a.name, labels: [{ text: a.name, x: spec.holeX }], say: a.say };
  }

  const b = holeFor(spec.mate, spec.mate.holeX, mateProfile, t, spec.index);
  const field = buildField(mergeHoles(a.sdf, b.sdf), DUO_BOUNDS);
  // 两个人同款（一人原样一人镜像也算同款）：名字只写一个，提示语说"一起"。手拉手、搭桥这两个专属造型用它们自己的话
  const same = a.id === b.id;
  return {
    spec,
    field,
    outlines: wallOutlines(field),
    ghost: holeEdges(field),
    target: a.target,
    mate: { target: b.target },
    label: same ? a.name : `左 ${a.name} · 右 ${b.name}`,
    // 每个洞上方一块名牌；手拉手、搭桥的两个洞连成了一个，名牌也只挂一块，在正中
    labels: spec.duo
      ? [{ text: a.name, x: (spec.holeX + spec.mate.holeX) / 2 }]
      : [
          { text: a.name, x: spec.holeX },
          { text: b.name, x: spec.mate.holeX },
        ],
    say: spec.duo ? a.say : same ? `两个人一起：${a.say}` : `左边${a.name}，右边${b.name}`,
  };
}
