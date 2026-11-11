import { median } from '../util/math';
import type { ModelKind } from './poseDetector';

/**
 * 自动选模型：标准模型（full）更准，轻量模型（lite）更快。
 * 做法是开局前先用标准模型实跑一小会儿，量出**识别一次要多久**；太慢就换轻量的。
 *
 * 几个容易踩的坑，都在这里处理了：
 *   - 头几次特别慢（显卡在编译着色器），不能算数 → 丢掉前 WARMUP_FRAMES 次；
 *   - 偶尔一次卡一下很正常 → 用中位数，而不是平均数；
 *   - 量的是"识别一次的耗时"，不是"每秒出几帧结果"——后者还受摄像头帧率的限制，
 *     光线暗时摄像头可能掉到每秒 15 帧，那不代表电脑慢，换成轻量模型也快不起来；
 *   - 量不出来（标签页在后台、摄像头迟迟不出画面）就不下结论，下次再量，而不是认定"电脑慢"；
 *   - 记住的结论会过期：一次倒霉的测量不至于管一辈子。
 */
export const WARMUP_FRAMES = 8;
export const SAMPLE_FRAMES = 25;
/** 标准模型识别一次超过这么久（毫秒）就算跟不上：每秒出不了 20 次结果，动作会明显一顿一顿的 */
export const MAX_DETECT_MS = 50;
/** 量出来的结论记多少天 */
export const REMEMBER_DAYS = 14;
const MIN_SAMPLES = 5;

/** 由每次识别的耗时（毫秒，按先后顺序）算出"通常要多久"；次数太少、算不出来时返回 null。 */
export function typicalDetectMs(times: number[]): number | null {
  const usable = times.slice(WARMUP_FRAMES).filter((t) => Number.isFinite(t) && t > 0);
  return usable.length >= MIN_SAMPLES ? median(usable) : null;
}

/** 够快用标准模型，太慢用轻量模型；没量出来就不下结论（返回 null）。 */
export function pickModel(detectMs: number | null): ModelKind | null {
  if (detectMs === null) return null;
  return detectMs <= MAX_DETECT_MS ? 'full' : 'lite';
}

/** 把结论和得出它的时间一起存起来。 */
export function encodeChoice(model: ModelKind, nowMs: number): string {
  return JSON.stringify({ model, at: nowMs });
}

/** 读回上次的结论；没有、读不懂、过期了，都返回 null（意思是"重新量"）。 */
export function decodeChoice(raw: string | null, nowMs: number): ModelKind | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { model?: unknown; at?: unknown } | null;
    if (typeof v !== 'object' || v === null) return null;
    if (v.model !== 'lite' && v.model !== 'full') return null;
    if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return null;
    const age = nowMs - v.at;
    return age >= 0 && age <= REMEMBER_DAYS * 24 * 3600 * 1000 ? v.model : null;
  } catch {
    return null;
  }
}
