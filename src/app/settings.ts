import { useSyncExternalStore } from 'react';
import type { ModelKind } from '../engine/vision/poseDetector';
import type { Difficulty } from '../games/wall/tuning';

/** 玩家可以改的设置，存在浏览器本地。 */
export interface Settings {
  difficulty: Difficulty;
  /** 识别模型：auto 先用标准模型，帧率不够自动换轻量的 */
  model: 'auto' | ModelKind;
  sound: boolean;
  /** 语音播报姿势名 */
  voice: boolean;
  /** 显示摄像头小窗 */
  pip: boolean;
  /** 在小窗上叠加骨架 */
  skeleton: boolean;
  quality: 'auto' | 'low' | 'high';
  cameraId: string;
  /**
   * 让识别模型同时找两个人。家里人多、常有人从镜头前走过时打开：旁人在场也能一直跟住玩家。
   * 代价是每帧多花十来毫秒，所以默认关着。
   */
  twoPeople: boolean;
}

export const SETTINGS_KEY = 'mw.settings';

export const DEFAULT_SETTINGS: Settings = { difficulty: 'normal', model: 'auto', sound: true, voice: true, pip: true, skeleton: false, quality: 'auto', cameraId: '', twoPeople: false };

const oneOf =
  <T extends string>(...allowed: T[]) =>
  (v: unknown): v is T =>
    typeof v === 'string' && (allowed as string[]).includes(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** 每个字段各自的合法性检查：存储里的东西可能是旧版本留下的，也可能被人改过。 */
const VALID: { [K in keyof Settings]: (v: unknown) => v is Settings[K] } = {
  difficulty: oneOf('easy', 'normal', 'hard'),
  model: oneOf('auto', 'lite', 'full'),
  sound: isBool,
  voice: isBool,
  pip: isBool,
  skeleton: isBool,
  quality: oneOf('auto', 'low', 'high'),
  cameraId: (v): v is string => typeof v === 'string',
  twoPeople: isBool,
};

const browserStorage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // 隐私模式下连访问都可能抛错
  }
};

export function loadSettings(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): Settings {
  const out = { ...DEFAULT_SETTINGS };
  let saved: unknown;
  try {
    saved = JSON.parse(storage?.getItem(SETTINGS_KEY) ?? 'null');
  } catch {
    return out;
  }
  if (typeof saved !== 'object' || saved === null) return out;
  for (const key of Object.keys(VALID) as (keyof Settings)[]) {
    const value = (saved as Record<string, unknown>)[key];
    if (VALID[key](value)) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export function saveSettings(s: Settings, storage: Pick<Storage, 'setItem'> | undefined = browserStorage()): void {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // 存不上（配额满、隐私模式）就算了，这一次的设置在内存里照样生效
  }
}

// ---- React 里用的全局设置 ----
let current: Settings | null = null;
const listeners = new Set<() => void>();
const snapshot = (): Settings => (current ??= loadSettings());

export function getSettings(): Settings {
  return snapshot();
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...snapshot(), ...patch };
  saveSettings(current);
  listeners.forEach((l) => l());
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const value = useSyncExternalStore((cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }, snapshot);
  return [value, updateSettings];
}
