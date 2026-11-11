import { LM } from '../body/landmarks';
import type { RawFrame, RawPose } from '../input/types';

/**
 * 画面里可能不止一个人，而且模型每帧输出的顺序并不固定。
 * 这个类负责回答："这一帧里，哪个是我们的玩家？"
 *
 * - 一开始：选最大、最靠中间的那个人。
 * - 之后：选离上一帧位置最近的那个人（帧间连续性）。旁人走过、甚至站到正中间，都抢不走控制权。
 * - 玩家暂时看不到：先等一等（默认 0.5 秒），不要立刻换人；等够了才重新选。
 * - 锁定之后（一局游戏进行中）：重新选人时只认回到玩家原位附近的人。
 *
 * 为什么需要"锁定"：默认情况下识别模型一次只给一个人（多找一个人每帧要多花十来毫秒）。
 * 它跟丢玩家之后，下一个给出来的可能是旁边路过的人——每帧都只有他一个，光靠"选最近的"拦不住。
 * 锁定之后这样的人不会被当成玩家；游戏那边看到的是"没人"，会暂停，而不是拿旁人的姿势去判撞墙。
 */

/** 锁定后重新认人的范围：离原位不超过这么多个肩宽（约 1.1 米——洞最远开在离原位 0.9 米处） */
const HOME_RADIUS = 3;

interface Candidate {
  pose: RawPose;
  /** 肩髋质心在画面里的位置，以画面高度为单位 */
  u: number;
  v: number;
  /** 肩宽，以画面高度为单位 */
  size: number;
}

export class PersonSelector {
  private readonly maxJump: number;
  private readonly lostMs: number;
  private last: { u: number; v: number; t: number; size: number } | null = null;
  private home: { u: number; size: number } | null = null;

  constructor(opts: { maxJump?: number; lostMs?: number } = {}) {
    // 相邻两帧之间，同一个人的质心最多移动多少（以画面高度为单位）
    this.maxJump = opts.maxJump ?? 0.25;
    this.lostMs = opts.lostMs ?? 500;
  }

  /** 锁定：记住玩家现在站的位置（标定时调用）。还没见过人时什么也不做。 */
  lock(): void {
    if (this.last) this.home = { u: this.last.u, size: this.last.size };
  }

  unlock(): void {
    this.home = null;
  }

  pick(frame: RawFrame): RawPose | null {
    const candidates = frame.poses.map((pose) => describe(pose, frame.aspect)).filter((c) => c !== null);

    if (this.last) {
      let best: Candidate | null = null;
      let bestDist = this.maxJump;
      for (const c of candidates) {
        const d = Math.hypot(c.u - this.last.u, c.v - this.last.v);
        if (d < bestDist) {
          best = c;
          bestDist = d;
        }
      }
      if (best) return this.follow(best, frame.t);
      if (frame.t - this.last.t < this.lostMs) return null; // 再等等，别急着换人
      this.last = null;
    }

    // 重新选人。锁定时只在原位附近找
    const home = this.home;
    const pool = home ? candidates.filter((c) => Math.abs(c.u - home.u) <= HOME_RADIUS * home.size) : candidates;
    let best: Candidate | null = null;
    let bestScore = -Infinity;
    for (const c of pool) {
      const score = c.size - 1.5 * Math.abs(c.u / frame.aspect - 0.5);
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    return best ? this.follow(best, frame.t) : null;
  }

  private follow(c: Candidate, t: number): RawPose {
    this.last = { u: c.u, v: c.v, t, size: c.size };
    return c.pose;
  }

  reset(): void {
    this.last = null;
    this.home = null;
  }
}

/** 一个人在画面里的位置（肩髋质心）和大小（肩宽）；双肩看不清的不算数。 */
function describe(pose: RawPose, aspect: number): Candidate | null {
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
