import type { RawFrame } from '../input/types';
import { describePerson, type PersonInFrame } from './person';

/**
 * 双人模式：画面按左右分成两条"泳道"，一条泳道一个玩家、一个追踪器。
 *
 * 为什么按位置分，而不是"模型输出的第 0 个人、第 1 个人"：模型每帧输出的顺序并不固定，而且会把同一个人报两遍。
 * 按位置分，两个追踪器看到的候选人天然不重叠——两个小人不可能跟着同一个人动，旁人插进来也串不了边。
 * 代价是玩家不能换边、不能走过分界线（走过去的那位会被当作"不见了"，游戏暂停——宁可暂停，不能判错人）。
 */

/** 分界线每帧往"两人中点"靠这么大比例：够快（一秒内到位），又不跟着单帧的抖动跳 */
const FOLLOW = 0.3;
/** 两个检出的质心相距不到"较大那位的肩宽"的这么多倍，就当作同一个人被报了两遍 */
const SAME_PERSON = 0.5;

/**
 * 两条泳道的分界线：**没镜像**的归一化图像横坐标（0～1，0.5 是画面正中）。
 *
 * 标定之前它跟着人走——画面里有两个人时，线就在他们中间，所以两个人不用正好分站在画面中线两侧；
 * 标定（开局）时定住，之后谁也不能把线带跑。
 */
export class LaneSplit {
  value = 0.5;
  private held = false;

  get frozen(): boolean {
    return this.held;
  }

  /** 每来一帧识别结果调用一次（要在两个追踪器处理这一帧之前）。 */
  observe(frame: RawFrame): void {
    if (this.held) return;
    const seen = frame.poses
      .map((pose) => describePerson(pose, frame.aspect))
      .filter((c): c is PersonInFrame => c !== null)
      .sort((a, b) => b.size - a.size);
    // 从大到小挑，和已经挑中的人几乎重合的不要（同一个人报了两遍）
    const people: PersonInFrame[] = [];
    for (const c of seen) {
      if (!people.some((p) => Math.hypot(c.u - p.u, c.v - p.v) < SAME_PERSON * p.size)) people.push(c);
    }
    if (people.length < 2) return;
    const middle = (people[0].u + people[1].u) / 2 / frame.aspect;
    this.value += (middle - this.value) * FOLLOW;
  }

  /** 定住（标定时调用）。 */
  freeze(): void {
    this.held = true;
  }

  reset(): void {
    this.value = 0.5;
    this.held = false;
  }
}

/** 一条泳道。side 说的是**屏幕上**（照镜子那样镜像之后）的左右，也就是舞台上的左右。 */
export interface Lane {
  side: 'left' | 'right';
  split: LaneSplit;
}

/** rawX 处的人在不在这条泳道里。rawX 是没镜像的归一化图像横坐标——画面的右边是屏幕的左边。 */
export function inLane(lane: Lane, rawX: number): boolean {
  return lane.side === 'left' ? rawX >= lane.split.value : rawX < lane.split.value;
}
