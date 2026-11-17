import type { Body } from '../../engine/body/bodyModel';
import { standHeight, type BodyProfile } from '../../engine/body/profile';
import type { Motion } from '../../engine/motion/features';
import { clamp01 } from '../../engine/util/math';
import { pairGap } from './duo';
import { COMMON } from './tuning';

/**
 * 站位引导：开局前看一眼玩家站得合不合适，用一句大白话告诉他怎么调。
 * 判断依据是 Body 里现成的两样东西：哪些关节看得清，以及摄像头在玩家所在的平面能看到多大范围。
 */
export type FramingIssue = 'none' | 'nobody' | 'partial' | 'close' | 'far' | 'left' | 'right' | 'upper' | 'one' | 'gap';

export interface FramingResult {
  /** left / right 说的是玩家现在偏在哪一边 */
  issue: FramingIssue;
  text: string;
  /** 按现在的站位，这一局是全身还是半身；没看到人时为 null */
  mode: 'full' | 'upper' | null;
}

const F = COMMON.framing;
/**
 * 这几种只是"提醒"：站位不理想，但不是不能玩。
 * upper（只看到上半身）也在里面：十五关里大半的姿势要用腿，所以先请他退到脚也进画面；
 * 退不了（坐在桌前）就站着别动，多等几秒照样开局，这一局只出上半身做得了的墙。
 */
const ADVICE = new Set<FramingIssue>(['close', 'far', 'left', 'right', 'upper']);

export function checkFraming(body: Body | null): FramingResult {
  if (!body) return { issue: 'nobody', text: '站到摄像头前面来', mode: null };
  const mode = body.mode;
  if (!body.ok.head || !body.ok.shoulderL || !body.ok.shoulderR) return { issue: 'partial', text: '让摄像头看到你的头和肩膀', mode };

  const height = body.view.top - body.view.bottom;
  if (height < F.minViewHeight) return { issue: 'close', text: '往后退一点', mode };
  if (height > F.maxViewHeight) return { issue: 'far', text: '往前走一点', mode };

  // root.x 是相对标定原点的，不是相对画面中心的；画面中心在舞台上的位置是可见范围的中点
  const offCentre = body.root.x - (body.view.left + body.view.right) / 2;
  if (offCentre > F.maxOffCentre) return { issue: 'right', text: '往左站一点', mode };
  if (offCentre < -F.maxOffCentre) return { issue: 'left', text: '往右站一点', mode };

  if (mode === 'upper') return { issue: 'upper', text: '往后退，让脚也进画面，才能玩全身的姿势', mode };
  return { issue: 'none', text: '站得很好，别动', mode };
}

/**
 * 双人的站位：两位都要看得到，而且——和单人不一样——有两条是硬要求，不满足就不开局：
 *
 *   站得太远（人在画面里不到一半高）。单人时这只是建议；双人时人一小，识别模型就只找得到一个人
 *   （实测：每人占画面高度 43% 时两个都认得出，34% 时只认得出一个），开了局也玩不了。
 *   靠得太近（不到 minGap）。再近，两个人的手臂会互相挡住。
 *
 * 只看到一位、而且这一位在画面里很小：多半是另一位也在，只是太远了没被找到，所以也说"往前走一点"。
 * 太近（看到的范围太小）、只看到上半身，仍然只是提醒。左右偏不偏不管：两个人本来就一左一右。
 */
const DUO_ADVICE = new Set<FramingIssue>(['close', 'upper']);

export function checkDuoFraming(a: Body | null, b: Body | null, profiles: [BodyProfile, BodyProfile]): FramingResult {
  /** 这位在画面里是不是太小了 */
  const small = (body: Body, p: BodyProfile): boolean => standHeight(p) * body.scale < COMMON.duo.minPersonFrac;

  if (!a && !b) return { issue: 'nobody', text: '两位都站到摄像头前面来', mode: null };
  if (!a || !b) {
    const [one, p] = a ? [a, profiles[0]] : [b!, profiles[1]];
    return small(one, p) ? { issue: 'far', text: '两位都往前走一点', mode: one.mode } : { issue: 'one', text: '还差一位，站到旁边来', mode: one.mode };
  }

  // 只要有一位只看到上半身，这一局两位都按半身来
  const mode = a.mode === 'upper' || b.mode === 'upper' ? 'upper' : 'full';
  const bodies = [a, b];
  if (bodies.some((body) => !body.ok.head || !body.ok.shoulderL || !body.ok.shoulderR)) return { issue: 'partial', text: '让摄像头看到你的头和肩膀', mode };
  // 先查两条硬要求，再查只是提醒的：提醒的那几条站着不动几秒就放行，要是排在前面，会把硬要求盖过去
  if (small(a, profiles[0]) || small(b, profiles[1])) return { issue: 'far', text: '两位都往前走一点', mode };
  if (pairGap(a, b) < COMMON.duo.minGap) return { issue: 'gap', text: '两个人分开一点，中间留一臂宽', mode };
  if (bodies.some((body) => body.view.top - body.view.bottom < F.minViewHeight)) return { issue: 'close', text: '往后退一点', mode };
  if (mode === 'upper') return { issue: 'upper', text: '往后退，让脚也进画面，才能玩全身的姿势', mode };
  return { issue: 'none', text: '站得很好，别动', mode };
}

/**
 * 站位"闸门"：看得到头和肩、而且站着没动，连续保持一段时间才放行（然后标定、开局）。
 * 中途乱动，或者看不到人了，计时从头来。
 *
 * 站位不理想（太近、太远、偏了、只看到上半身）只提醒、不强求：屋子小退不了那么远，或者就是坐在桌前，都很常见。
 * 提醒过了人还是站着不动，多等一会儿（adviseHoldMs）也放行，按现在看得到的范围开局。
 */
export class FramingGate {
  private since: number | null = null;

  constructor(
    private readonly holdMs: number = F.holdMs,
    private readonly adviseHoldMs: number = F.adviseHoldMs,
  ) {}

  update(body: Body | null, motion: Motion | null, nowMs: number): { ready: boolean; progress: number; result: FramingResult; advisory: boolean } {
    const result = checkFraming(body);
    return this.step(result, ADVICE.has(result.issue), motion !== null && motion.energy < F.stillEnergy, nowMs);
  }

  /** 双人：两位都站位合适、都站着没动，才计时。哪些算"只是提醒"和单人不同，见 checkDuoFraming。 */
  updateDuo(
    a: Body | null,
    b: Body | null,
    motions: [Motion | null, Motion | null],
    profiles: [BodyProfile, BodyProfile],
    nowMs: number,
  ): { ready: boolean; progress: number; result: FramingResult; advisory: boolean } {
    const result = checkDuoFraming(a, b, profiles);
    const still = motions.every((m) => m !== null && m.energy < F.stillEnergy);
    return this.step(result, DUO_ADVICE.has(result.issue), still, nowMs);
  }

  private step(result: FramingResult, advisory: boolean, still: boolean, nowMs: number): { ready: boolean; progress: number; result: FramingResult; advisory: boolean } {
    if ((result.issue !== 'none' && !advisory) || !still) {
      this.since = null;
      return { ready: false, progress: 0, result, advisory };
    }
    this.since ??= nowMs;
    const progress = clamp01((nowMs - this.since) / (advisory ? this.adviseHoldMs : this.holdMs));
    return { ready: progress >= 1, progress, result, advisory };
  }

  reset(): void {
    this.since = null;
  }
}
