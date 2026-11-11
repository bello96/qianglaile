import { describe, expect, it } from 'vitest';
import { CameraError } from '../engine/camera/camera';
import type { Recording } from '../engine/input/recorder';
import { SimPoseSource } from '../engine/input/simSource';
import type { PoseSource, RawFrame } from '../engine/input/types';
import { encodeChoice, REMEMBER_DAYS, SAMPLE_FRAMES, WARMUP_FRAMES } from '../engine/vision/autoModel';
import { EngineController, type EngineConfig, type EngineDeps } from './engineController';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 10, 11);

/** 假的姿态来源：start() 什么时候成功、失败，帧什么时候来，都由测试说了算。 */
function fakeSource(kind: PoseSource['kind'], made: Record<string, unknown>) {
  const listeners = new Set<(f: RawFrame) => void>();
  let settle: { ok: () => void; fail: (err: unknown) => void } | null = null;
  const s = {
    kind,
    video: kind === 'camera' ? ({ tag: 'video' } as unknown as HTMLVideoElement) : null,
    made,
    started: 0,
    stopped: 0,
    lastMs: 30,
    start(): Promise<void> {
      s.started++;
      return new Promise<void>((ok, fail) => (settle = { ok, fail }));
    },
    stop(): void {
      s.stopped++;
    },
    onFrame(cb: (f: RawFrame) => void): () => void {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    stats: () => ({ fps: 30, detectMs: s.lastMs, lastMs: s.lastMs, delegate: 'GPU', model: String(made.model ?? kind) }),
    /** 来源启动成功 / 失败 */
    finishStart: (): void => settle?.ok(),
    failStart: (err: unknown): void => settle?.fail(err),
    emit: (f: RawFrame): void => listeners.forEach((cb) => cb(f)),
  };
  return s;
}
type Fake = ReturnType<typeof fakeSource>;

function rig(stored: string | null = null, over: Partial<EngineDeps> = {}) {
  const sources: Fake[] = [];
  const store = new Map<string, string>();
  if (stored !== null) store.set('mw.autoModel', stored);
  let clock = 0;
  const timeouts: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const people = new SimPoseSource({ noise: 0 });

  const make = (kind: PoseSource['kind']) => (opts: object) => {
    const s = fakeSource(kind, opts as Record<string, unknown>);
    sources.push(s);
    return s as unknown as PoseSource;
  };
  const deps: EngineDeps = {
    makeCamera: make('camera'),
    makeSim: make('sim'),
    makeReplay: (rec) => make('replay')({ rec }),
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    wallClock: () => NOW,
    clock: () => clock,
    timeout: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timeouts.push(t);
      return () => (t.cancelled = true);
    },
    ...over,
  };
  const engine = new EngineController(deps);
  let changes = 0;
  engine.subscribe(() => changes++);
  return {
    engine,
    sources,
    store,
    timeouts,
    last: (): Fake => sources[sources.length - 1],
    changes: () => changes,
    tick: (ms: number) => (clock += ms),
    /** 一帧里有一个站着的人 */
    frame: (): RawFrame => people.step(33),
    /** 让最新的那个来源启动成功，并等状态更新完 */
    async up(): Promise<Fake> {
      const s = sources[sources.length - 1];
      s.finishStart();
      await flush();
      return s;
    },
  };
}

const config = (over: Partial<EngineConfig> = {}): EngineConfig => ({ sim: 'off', seed: null, model: 'full', cameraId: '', worker: true, people: 1, replay: null, ...over });
const RECORDING: Recording = { version: 1, aspect: 16 / 9, frames: [] };

describe('EngineController: life cycle', () => {
  it('is loading until the source has started, then ready', async () => {
    const r = rig();
    r.engine.configure(config({ sim: 'auto', seed: 7 }));
    expect(r.engine.snapshot).toMatchObject({ status: 'loading', kind: 'sim', source: null, error: null });
    expect(r.last().made).toMatchObject({ seed: 7 });
    expect(r.last().started).toBe(1);

    await r.up();
    expect(r.engine.snapshot).toMatchObject({ status: 'ready', kind: 'sim' });
    expect(r.engine.snapshot.source).toBe(r.last());
  });

  it('tells subscribers about every change and stops telling them once they unsubscribe', async () => {
    const r = rig();
    let mine = 0;
    const off = r.engine.subscribe(() => mine++);
    r.engine.configure(config({ sim: 'auto' }));
    await r.up();
    expect(mine).toBeGreaterThanOrEqual(2);
    off();
    const before = mine;
    r.engine.retry();
    expect(mine).toBe(before);
    expect(r.changes()).toBeGreaterThan(before);
  });

  it('hands the same snapshot object back until something changes', async () => {
    const r = rig();
    r.engine.configure(config({ sim: 'auto' }));
    const a = r.engine.snapshot;
    expect(r.engine.snapshot).toBe(a);
    await r.up();
    expect(r.engine.snapshot).not.toBe(a);
  });

  it('feeds every frame to the player tracker and knows how long ago the last one arrived', async () => {
    const r = rig();
    r.engine.configure(config({ sim: 'auto' }));
    const s = await r.up();
    expect(r.engine.sinceFrame()).toBe(Infinity);

    r.tick(1000);
    s.emit(r.frame());
    expect(r.engine.tracker.state.present).toBe(true);
    expect(r.engine.sinceFrame()).toBe(0);
    r.tick(250);
    expect(r.engine.sinceFrame()).toBe(250);
    expect(r.engine.sinceFrame(5000)).toBe(4000);
  });

  it('opens the camera with what the settings ask for', () => {
    const r = rig();
    r.engine.configure(config({ model: 'lite', cameraId: 'cam-2', worker: false, people: 2 }));
    expect(r.engine.snapshot.kind).toBe('camera');
    expect(r.last().made).toMatchObject({ model: 'lite', deviceId: 'cam-2', worker: false, numPoses: 2 });
  });

  it('shows the camera picture once ready', async () => {
    const r = rig();
    r.engine.configure(config());
    expect(r.engine.snapshot.video).toBeNull();
    const s = await r.up();
    expect(r.engine.snapshot.video).toBe(s.video);
  });

  it('reports download progress while loading, and which step it is on', () => {
    const r = rig();
    r.engine.configure(config());
    const onProgress = r.last().made.onProgress as (loaded: number, total: number) => void;
    onProgress(3, 10);
    expect(r.engine.snapshot).toMatchObject({ progress: { loaded: 3, total: 10 }, step: 'download' });
    onProgress(10, 10);
    expect(r.engine.snapshot.step).toBe('start');
  });
});

describe('EngineController: when things go wrong', () => {
  it('shows why the camera could not be opened, and "try again" tries again', async () => {
    const r = rig();
    r.engine.configure(config());
    r.last().failStart(new CameraError('摄像头没有获得许可', '点地址栏左边的图标……', 'denied'));
    await flush();
    expect(r.engine.snapshot).toMatchObject({ status: 'error', error: { title: '摄像头没有获得许可', hint: '点地址栏左边的图标……' }, source: null });

    r.engine.retry();
    expect(r.sources).toHaveLength(2);
    expect(r.engine.snapshot.status).toBe('loading');
    await r.up();
    expect(r.engine.snapshot.status).toBe('ready');
  });

  it('explains an unexpected failure too', async () => {
    const r = rig();
    r.engine.configure(config());
    r.last().failStart(new Error('boom'));
    await flush();
    expect(r.engine.snapshot.error).toEqual({ title: '出了点问题', hint: 'boom' });
  });

  it('demo mode replaces the camera with the simulated player', async () => {
    const r = rig();
    r.engine.configure(config());
    r.last().failStart(new CameraError('没有找到摄像头', '…', 'notfound'));
    await flush();

    r.engine.useDemo();
    expect(r.engine.snapshot).toMatchObject({ status: 'loading', kind: 'sim', error: null });
    await r.up();
    expect(r.engine.snapshot).toMatchObject({ status: 'ready', kind: 'sim' });
  });

  it('turns a frozen camera and a dead recogniser into an explanation', async () => {
    const frozen = rig();
    frozen.engine.configure(config());
    await frozen.up();
    (frozen.last().made.onProblem as (kind: string) => void)('frozen');
    expect(frozen.engine.snapshot).toMatchObject({ status: 'error', error: { title: '摄像头画面停住了' } });

    const dead = rig();
    dead.engine.configure(config());
    await dead.up();
    (dead.last().made.onProblem as (kind: string) => void)('detect');
    expect(dead.engine.snapshot.error?.title).toBe('识别引擎停了');
    expect(dead.engine.snapshot.error?.hint).toContain('再试一次');
  });
});

describe('EngineController: a problem ends the run', () => {
  it('stops the source and ignores whatever it still sends', async () => {
    // 出错卡片底下，摄像头不该还开着、追踪器不该还在被喂数据
    const r = rig();
    r.engine.configure(config());
    const s = await r.up();
    (s.made.onProblem as (kind: string) => void)('frozen');
    expect(r.engine.snapshot).toMatchObject({ status: 'error', source: null });
    expect(s.stopped).toBe(1);
    s.emit(r.frame());
    expect(r.engine.tracker.state.present).toBe(false);
  });

  it('is not papered over by the measuring timer firing afterwards', async () => {
    const r = rig();
    r.engine.configure(config({ model: 'auto' }));
    const s = await r.up();
    expect(r.engine.snapshot.step).toBe('measure');
    (s.made.onProblem as (kind: string) => void)('frozen');
    for (const t of r.timeouts) t.fn(); // 就算取消没生效、定时器照样响了
    expect(r.engine.snapshot.status).toBe('error');
  });

  it('a second report about the same run changes nothing; "try again" still works', async () => {
    const r = rig();
    r.engine.configure(config());
    const s = await r.up();
    const report = s.made.onProblem as (kind: string) => void;
    report('frozen');
    const shown = r.engine.snapshot;
    report('detect');
    expect(r.engine.snapshot).toBe(shown);
    r.engine.retry();
    await r.up();
    expect(r.engine.snapshot.status).toBe('ready');
  });
});

describe('EngineController: restarting', () => {
  it('picking by hand the very model "auto" is already running does not restart anything', async () => {
    // 游戏进行到一半，在设置里把"自动"改成它实际在用的那个模型：没有任何变化，不该让人重新站位
    const r = rig(encodeChoice('full', NOW - DAY));
    r.engine.configure(config({ model: 'auto' }));
    await r.up();
    r.engine.configure(config({ model: 'full' }));
    r.engine.configure(config({ model: 'auto' }));
    expect(r.sources).toHaveLength(1);
    expect(r.engine.snapshot.status).toBe('ready');
    r.engine.configure(config({ model: 'lite' }));
    expect(r.sources).toHaveLength(2);
  });

  it('does not restart for settings that mean the same thing', async () => {
    const r = rig();
    r.engine.configure(config());
    await r.up();
    r.engine.configure(config());
    r.engine.configure(config({ seed: 9 })); // 种子只对模拟玩家有意义
    expect(r.sources).toHaveLength(1);
    expect(r.engine.snapshot.status).toBe('ready');

    const sim = rig();
    sim.engine.configure(config({ sim: 'auto', seed: 3 }));
    sim.engine.configure(config({ sim: 'wrong', seed: 3, model: 'lite', cameraId: 'x', people: 2 })); // 这些只对摄像头有意义
    expect(sim.sources).toHaveLength(1);
  });

  it('restarts, stopping the old source, when something that matters changes', async () => {
    for (const change of [{ cameraId: 'other' }, { model: 'lite' as const }, { worker: false }, { people: 2 as const }]) {
      const r = rig();
      r.engine.configure(config());
      const first = await r.up();
      r.engine.configure(config(change));
      expect(first.stopped, JSON.stringify(change)).toBe(1);
      expect(r.sources, JSON.stringify(change)).toHaveLength(2);
      expect(r.engine.snapshot.status).toBe('loading');
    }
  });

  it('forgets the calibration when it restarts — the new source may see a different picture', async () => {
    const r = rig();
    r.engine.configure(config());
    const s = await r.up();
    for (let i = 0; i < 40; i++) s.emit(r.frame());
    r.engine.tracker.calibrate();
    expect(r.engine.tracker.state.profileReady).toBe(true);

    r.engine.configure(config({ cameraId: 'other' }));
    expect(r.engine.tracker.state.profileReady).toBe(false);
    expect(r.engine.tracker.state.present).toBe(false);
    expect(r.engine.sinceFrame()).toBe(Infinity);
  });

  it('switches off a source that only finishes starting after it has been replaced', async () => {
    const r = rig();
    r.engine.configure(config());
    const slow = r.last();
    r.engine.configure(config({ cameraId: 'other' }));
    const stopsBefore = slow.stopped;
    slow.finishStart(); // 摄像头这时才打开：没人要它了，得马上关掉，不然指示灯一直亮着
    await flush();
    expect(slow.stopped).toBeGreaterThan(stopsBefore);
    expect(r.engine.snapshot.status).toBe('loading');
    expect(r.engine.snapshot.source).toBeNull();

    await r.up();
    expect(r.engine.snapshot.source).toBe(r.last());
  });

  it('frames from a replaced source are ignored', async () => {
    const r = rig();
    r.engine.configure(config());
    const old = await r.up();
    r.engine.configure(config({ cameraId: 'other' }));
    old.emit(r.frame());
    expect(r.engine.tracker.state.present).toBe(false);
  });

  it('dispose stops everything, and it can be configured again afterwards', async () => {
    // React 在开发模式下会把"挂载"做两遍：挂上、卸掉、再挂上
    const r = rig();
    r.engine.configure(config({ sim: 'auto' }));
    const first = await r.up();
    r.engine.dispose();
    expect(first.stopped).toBe(1);

    r.engine.configure(config({ sim: 'auto' }));
    expect(r.sources).toHaveLength(2);
    await r.up();
    expect(r.engine.snapshot.status).toBe('ready');
  });
});

describe('EngineController: choosing the model automatically', () => {
  const measure = async (r: ReturnType<typeof rig>, ms: number, frames = WARMUP_FRAMES + SAMPLE_FRAMES): Promise<Fake> => {
    const s = await r.up();
    s.lastMs = ms;
    for (let i = 0; i < frames; i++) s.emit(r.frame());
    await flush();
    return s;
  };

  it('starts with the standard model and is not ready until it has measured it', async () => {
    const r = rig();
    r.engine.configure(config({ model: 'auto' }));
    expect(r.last().made.model).toBe('full');
    const s = await r.up();
    expect(r.engine.snapshot).toMatchObject({ status: 'loading', step: 'measure' });
    s.emit(r.frame());
    expect(r.engine.snapshot.status).toBe('loading');
  });

  it('keeps the standard model when one detection is quick, and remembers that', async () => {
    const r = rig();
    r.engine.configure(config({ model: 'auto' }));
    await measure(r, 30);
    expect(r.engine.snapshot.status).toBe('ready');
    expect(r.sources).toHaveLength(1);
    expect(r.store.get('mw.autoModel')).toBe(encodeChoice('full', NOW));
  });

  it('switches to the light model when the standard one is slow — once, without measuring again', async () => {
    const r = rig();
    r.engine.configure(config({ model: 'auto' }));
    const slow = await measure(r, 90);
    expect(slow.stopped).toBe(1);
    expect(r.sources).toHaveLength(2);
    expect(r.last().made.model).toBe('lite');
    expect(r.store.get('mw.autoModel')).toBe(encodeChoice('lite', NOW));

    await r.up();
    expect(r.engine.snapshot).toMatchObject({ status: 'ready' });
    expect(r.sources).toHaveLength(2);
  });

  it('decides nothing when too few detections arrive in time: carries on, and will measure next time', async () => {
    const r = rig();
    r.engine.configure(config({ model: 'auto' }));
    const s = await r.up();
    for (let i = 0; i < 4; i++) s.emit(r.frame());
    const timer = r.timeouts.find((t) => !t.cancelled)!;
    expect(timer.ms).toBeGreaterThan(3000);
    timer.fn();
    expect(r.engine.snapshot.status).toBe('ready');
    expect(r.sources).toHaveLength(1);
    expect(r.store.has('mw.autoModel')).toBe(false);
  });

  it('cancels the measuring timeout once it has decided', async () => {
    const r = rig();
    r.engine.configure(config({ model: 'auto' }));
    await measure(r, 30);
    expect(r.timeouts.every((t) => t.cancelled)).toBe(true);
  });

  it('uses a remembered choice straight away', async () => {
    const r = rig(encodeChoice('lite', NOW - 2 * DAY));
    r.engine.configure(config({ model: 'auto' }));
    expect(r.last().made.model).toBe('lite');
    await r.up();
    expect(r.engine.snapshot.status).toBe('ready');
  });

  it('measures again once the remembered choice has expired', async () => {
    const r = rig(encodeChoice('lite', NOW - (REMEMBER_DAYS + 1) * DAY));
    r.engine.configure(config({ model: 'auto' }));
    expect(r.last().made.model).toBe('full');
    await r.up();
    expect(r.engine.snapshot.step).toBe('measure');
  });

  it('a model picked by hand while it was still measuring is respected: the measurement no longer decides', async () => {
    const r = rig();
    r.engine.configure(config({ model: 'auto' }));
    const s = await r.up();
    r.engine.configure(config({ model: 'full' })); // 正在跑的就是标准模型，不用重启
    expect(r.sources).toHaveLength(1);
    s.lastMs = 90; // 量出来其实很慢
    for (let i = 0; i < WARMUP_FRAMES + SAMPLE_FRAMES; i++) s.emit(r.frame());
    await flush();
    expect(r.sources).toHaveLength(1); // 没有擅自换成轻量模型
    expect(r.engine.snapshot.status).toBe('ready');
  });

  it('keeps separate choices for finding one person and for finding two', async () => {
    // 找两个人每次识别要多花十来毫秒：只找一个人时"够快"的结论，不能直接套到找两个人上
    const r = rig(encodeChoice('full', NOW - DAY));
    r.engine.configure(config({ model: 'auto', people: 2 }));
    expect(r.last().made).toMatchObject({ model: 'full', numPoses: 2 });
    await measure(r, 90); // 找两个人时太慢
    expect(r.last().made).toMatchObject({ model: 'lite', numPoses: 2 });
    await r.up();

    r.engine.configure(config({ model: 'auto', people: 1 }));
    expect(r.last().made).toMatchObject({ model: 'full', numPoses: 1 }); // 只找一个人的结论还是"标准"
    await r.up();
    expect(r.engine.snapshot.status).toBe('ready');

    r.engine.configure(config({ model: 'auto', people: 2 }));
    expect(r.last().made).toMatchObject({ model: 'lite', numPoses: 2 }); // 找两个人的结论也记着，不用再量
  });

  it('a model picked by hand is used as it is, without measuring', async () => {
    const r = rig(encodeChoice('lite', NOW));
    r.engine.configure(config({ model: 'full' }));
    expect(r.last().made.model).toBe('full');
    await r.up();
    expect(r.engine.snapshot.status).toBe('ready');
  });

  it('works when the browser offers no storage, or storage that throws', async () => {
    const none = rig(null, { storage: null });
    none.engine.configure(config({ model: 'auto' }));
    await measure(none, 30);
    expect(none.engine.snapshot.status).toBe('ready');

    const denied = (): never => {
      throw new Error('denied');
    };
    const throwing = rig(null, { storage: { getItem: denied, setItem: denied } });
    throwing.engine.configure(config({ model: 'auto' }));
    await measure(throwing, 30);
    expect(throwing.engine.snapshot.status).toBe('ready');
  });
});

describe('EngineController: other sources', () => {
  it('a recording takes the place of the camera', async () => {
    const r = rig();
    r.engine.configure(config({ replay: RECORDING }));
    expect(r.engine.snapshot.kind).toBe('replay');
    expect(r.last().made.rec).toBe(RECORDING);
    await r.up();
    expect(r.engine.snapshot.status).toBe('ready');

    r.engine.configure(config({ replay: RECORDING, model: 'lite', cameraId: 'x' })); // 摄像头的设置这时无关
    expect(r.sources).toHaveLength(1);
    r.engine.configure(config({ replay: null }));
    expect(r.engine.snapshot.kind).toBe('camera');
    expect(r.sources).toHaveLength(2);
  });

  it('a recording wins over the simulated player too — choosing it is the more deliberate act', () => {
    // 地址里带着 sim=auto 的页面上，点了"用这段代替摄像头"也应当生效；演示模式下同理
    const flagged = rig();
    flagged.engine.configure(config({ sim: 'auto', replay: RECORDING }));
    expect(flagged.engine.snapshot.kind).toBe('replay');

    const demo = rig();
    demo.engine.configure(config());
    demo.engine.useDemo();
    expect(demo.engine.snapshot.kind).toBe('sim');
    demo.engine.configure(config({ replay: RECORDING }));
    expect(demo.engine.snapshot.kind).toBe('replay');
    demo.engine.configure(config({ replay: null }));
    expect(demo.engine.snapshot.kind).toBe('sim');
  });
});
