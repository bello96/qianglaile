import { useSyncExternalStore } from 'react';
import type { Recording } from '../engine/input/recorder';

/**
 * "用一段录制代替摄像头"的开关。
 *
 * 在姿势实验室的"录制"页打开之后，实验室和游戏里的引擎都改用这段录制当姿态来源——
 * 页面上该有的角度、特征、判定照常出来，只是数据来自录下来的那段动作，不是摄像头。
 * 调参数时很有用：同一段动作可以反复看。
 *
 * 只记在内存里：刷新页面或者关掉就恢复成用摄像头（免得忘了关，下次打开莫名其妙没有摄像头）。
 */
let current: Recording | null = null;
const listeners = new Set<() => void>();

export function getReplayOverride(): Recording | null {
  return current;
}

/** 传一段录制就开，传 null 就关（换回摄像头）。 */
export function setReplayOverride(rec: Recording | null): void {
  if (rec === current) return;
  current = rec;
  for (const listener of [...listeners]) listener();
}

export function subscribeReplayOverride(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** 在组件里读这个开关；它变了组件会重新渲染。 */
export function useReplayOverride(): Recording | null {
  return useSyncExternalStore(subscribeReplayOverride, getReplayOverride);
}
