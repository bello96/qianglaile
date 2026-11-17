import { LM } from '../body/landmarks';
import type { RawPose } from '../input/types';

/** 一个人在画面里的位置和大小——选人（selectPerson.ts）和分泳道（lanes.ts）都用它。 */
export interface PersonInFrame {
  pose: RawPose;
  /** 肩髋质心在画面里的位置，以画面高度为单位（没镜像：u 越大越靠画面右边） */
  u: number;
  v: number;
  /** 肩宽，以画面高度为单位 */
  size: number;
}

/** 一个人在画面里的位置（肩髋质心）和大小（肩宽）；双肩看不清的不算数。 */
export function describePerson(pose: RawPose, aspect: number): PersonInFrame | null {
  const ls = pose.image[LM.leftShoulder];
  const rs = pose.image[LM.rightShoulder];
  if (ls.v < 0.5 || rs.v < 0.5) return null;
  let u = 0;
  let v = 0;
  let n = 0;
  for (const i of [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip]) {
    const p = pose.image[i];
    if (p.v < 0.5) continue;
    u += p.x * aspect;
    v += p.y;
    n++;
  }
  return { pose, u: u / n, v: v / n, size: Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y) };
}
