import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { STALE_MS } from '../engine/input/types';
import type { PlayerTracker } from '../engine/player/playerTracker';
import type { ModelKind } from '../engine/vision/poseDetector';
import { EngineController, type EngineSnapshot } from './engineController';
import { useReplayOverride } from './replayOverride';
import type { Flags } from './router';

export type { EngineStatus } from './engineController';

// 多久算旧，定义在引擎那一层（engine/input/types.ts）；从这里也能拿到，页面组件不用多记一个路径
export { STALE_MS };

/** 页面拿到的"引擎"：一个姿态来源 + 一个玩家追踪器，以及加载过程中的状态。 */
export interface Engine extends EngineSnapshot {
  tracker: PlayerTracker;
  /**
   * 距离上一次识别结果过了多久（毫秒）；还没有过结果时是无穷大。
   * tracker.state 永远是"最后一次"的结果——用它之前先看这个数，太久了（比如超过 STALE_MS）就当作没看到人。
   */
  sinceFrame(nowMs?: number): number;
  /** 再试一次 */
  retry(): void;
  /** 不用摄像头了，换成模拟玩家（演示模式） */
  useDemo(): void;
}

/**
 * 在页面里用引擎。真正的逻辑都在 EngineController 里（见 engineController.ts），这里只做三件事：
 *   - 页面挂上来时建一个控制器，卸掉时停掉它（摄像头的灯会灭）；
 *   - 把页面的设置交给它（设置变了由它决定要不要重启）；
 *   - 它的状态变了，让页面重新渲染。
 */
export function useEngine(opts: {
  sim: Flags['sim'];
  seed?: number | null;
  model: 'auto' | ModelKind;
  cameraId: string;
  /** 同时识别几个人，默认 1 */
  people?: 1 | 2;
  expose?: boolean;
  worker?: boolean;
}): Engine {
  const ref = useRef<EngineController | null>(null);
  ref.current ??= new EngineController();
  const controller = ref.current;

  const snap = useSyncExternalStore(controller.subscribe, () => controller.snapshot);
  const replay = useReplayOverride();

  const { sim, model, cameraId } = opts;
  const seed = opts.seed ?? null;
  const worker = opts.worker ?? true;
  const people = opts.people ?? 1;
  useEffect(() => {
    controller.configure({ sim, seed, model, cameraId, worker, people, replay });
  }, [controller, sim, seed, model, cameraId, worker, people, replay]);

  // 页面卸掉：停掉。（开发模式下 React 会"挂上、卸掉、再挂上"各做一遍；卸掉之后上面那个 effect 会重新 configure）
  useEffect(() => () => controller.dispose(), [controller]);

  // 开发和自动化检查时，把内部对象挂到 window.__mw 上，方便在控制台里看
  useEffect(() => {
    if (!opts.expose || snap.status !== 'ready') return;
    const w = window as unknown as { __mw?: Record<string, unknown> };
    w.__mw = { ...w.__mw, tracker: controller.tracker, source: snap.source };
  }, [opts.expose, snap, controller]);

  return useMemo(() => ({ ...snap, tracker: controller.tracker, sinceFrame: controller.sinceFrame, retry: controller.retry, useDemo: controller.useDemo }), [snap, controller]);
}
