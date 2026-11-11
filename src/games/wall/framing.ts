import type { Body } from '../../engine/body/bodyModel';
import type { Motion } from '../../engine/motion/features';
import { clamp01 } from '../../engine/util/math';
import { COMMON } from './tuning';

/**
 * 站位引导：开局前看一眼玩家站得合不合适，用一句大白话告诉他怎么调。
 * 判断依据是 Body 里现成的两样东西：哪些关节看得清，以及摄像头在玩家所在的平面能看到多大范围。
 */
export type FramingIssue = 'none' | 'nobody' | 'partial' | 'close' | 'far' | 'left' | 'right';

export interface FramingResult {
  /** left / right 说的是玩家现在偏在哪一边 */
  issue: FramingIssue;
  text: string;
  /** 按现在的站位，这一局是全身还是半身；没看到人时为 null */
  mode: 'full' | 'upper' | null;
}

const F = COMMON.framing;
/** 这几种只是"提醒"：站位不理想，但不是不能玩 */
const ADVICE = new Set<FramingIssue>(['close', 'far', 'left', 'right']);

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

  return { issue: 'none', text: mode === 'upper' ? '只看到上半身，这局按半身来玩。站好别动' : '站得很好，别动', mode };
}

/**
 * 站位"闸门"：看得到头和肩、而且站着没动，连续保持一段时间才放行（然后标定、开局）。
 * 中途乱动，或者看不到人了，计时从头来。
 *
 * 站位不理想（太近、太远、偏了）只提醒、不强求：屋子小退不了那么远，或者就是坐在桌前，都很常见。
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
    const advisory = ADVICE.has(result.issue);
    if ((result.issue !== 'none' && !advisory) || !motion || motion.energy >= F.stillEnergy) {
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
