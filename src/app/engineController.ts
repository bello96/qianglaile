import { CameraError } from '../engine/camera/camera';
import { CameraPoseSource } from '../engine/input/cameraSource';
import type { Recording } from '../engine/input/recorder';
import { ReplayPoseSource } from '../engine/input/replaySource';
import { SimPoseSource } from '../engine/input/simSource';
import type { PoseSource } from '../engine/input/types';
import { PlayerTracker } from '../engine/player/playerTracker';
import { decodeChoice, encodeChoice, pickModel, SAMPLE_FRAMES, typicalDetectMs, WARMUP_FRAMES } from '../engine/vision/autoModel';
import { VisionError, type ModelKind } from '../engine/vision/poseDetector';

export type EngineStatus = 'loading' | 'ready' | 'error';
/** 数据从哪来：真摄像头、模拟玩家，还是一段录制 */
export type SourceKind = 'camera' | 'sim' | 'replay';

/** 引擎该怎么跑。页面把设置和地址栏里的开关拼成这个交进来；变了，引擎自己决定要不要重启。 */
export interface EngineConfig {
  /** 地址栏的 sim 开关；不是 'off' 就用模拟玩家（除非下面的 replay 给了一段录制，那个更优先） */
  sim: 'off' | 'auto' | 'wrong' | 'manual';
  seed: number | null;
  model: 'auto' | ModelKind;
  cameraId: string;
  /** 识别放不放进 Web Worker */
  worker: boolean;
  /** 模型同时找几个人 */
  people: 1 | 2;
  /** 用这段录制代替摄像头；null 表示不用 */
  replay: Recording | null;
}

export interface EngineSnapshot {
  status: EngineStatus;
  /** 模型下载进度（字节） */
  progress: { loaded: number; total: number } | null;
  /** 加载到哪一步了：下载 → 启动 → 测速 */
  step: 'download' | 'start' | 'measure';
  error: { title: string; hint: string } | null;
  source: PoseSource | null;
  video: HTMLVideoElement | null;
  kind: SourceKind;
}

/** 控制器用到的"外面的东西"。平时是真的，测试里换成假的。 */
export interface EngineDeps {
  makeCamera(opts: {
    model: ModelKind;
    deviceId?: string;
    worker: boolean;
    numPoses: number;
    onProgress(loaded: number, total: number): void;
    onProblem(kind: 'ended' | 'frozen' | 'detect'): void;
  }): PoseSource;
  makeSim(opts: { seed: number }): PoseSource;
  makeReplay(rec: Recording): PoseSource;
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  /** 日历时间（毫秒），用来给记住的结论盖日期 */
  wallClock(): number;
  /** 单调时钟（毫秒），用来算"上一帧是多久以前" */
  clock(): number;
  /** 过 ms 毫秒后调用 fn；返回取消它的函数 */
  timeout(fn: () => void, ms: number): () => void;
}

function realDeps(): EngineDeps {
  let storage: EngineDeps['storage'] = null;
  try {
    storage = globalThis.localStorage ?? null;
  } catch {
    /* 隐私模式下连访问都可能抛错 */
  }
  return {
    makeCamera: (o) => new CameraPoseSource(o),
    makeSim: (o) => new SimPoseSource({ noise: 0.006, seed: o.seed }),
    makeReplay: (rec) => new ReplayPoseSource(rec, { loop: true }),
    storage,
    wallClock: () => Date.now(),
    clock: () => performance.now(),
    timeout: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  };
}

const LOADING: Omit<EngineSnapshot, 'kind'> = { status: 'loading', progress: null, step: 'download', error: null, source: null, video: null };
/** 上次测速选出来的模型记在浏览器里（带日期，过一阵子作废重测）。找一个人、找两个人各一条 */
const AUTO_KEY = { 1: 'mw.autoModel', 2: 'mw.autoModel.2' } as const;
/** 测速最多等这么久；到时候识别次数还不够，这次就不下结论 */
const MEASURE_TIMEOUT_MS = 7000;

const describe = (err: unknown): { title: string; hint: string } =>
  err instanceof CameraError || err instanceof VisionError ? { title: err.title, hint: err.hint } : { title: '出了点问题', hint: err instanceof Error ? err.message : String(err) };

/**
 * 引擎：把"姿态来源 → 玩家追踪器"这条线接起来，并管它的一生。
 *
 *   configure(设置)  → 建一个姿态来源（摄像头 / 模拟玩家 / 录制），启动它，把每一帧喂给 tracker
 *   设置变了         → 有实际影响才重启：停掉旧来源（摄像头的灯会灭），清掉标定，重新来
 *   出错了           → snapshot 里有给人看的原因；retry() 再试，useDemo() 改用模拟玩家
 *
 * 模型设为"自动"时，第一次会先用标准模型量一下这台电脑识别一次要多久，**量完才算就绪**——
 * 不能等游戏开始了才发现跟不上再换模型，那样引擎会在游戏中途重启。
 *
 * 这个类不依赖 React（useEngine 只是订阅它），所以能直接测。
 */
export class EngineController {
  readonly tracker = new PlayerTracker();

  private readonly deps: EngineDeps;
  private readonly listeners = new Set<() => void>();
  private snap: EngineSnapshot = { ...LOADING, kind: 'camera' };
  private config: EngineConfig | null = null;
  private demo = false;
  /**
   * 自动模式下定下来的模型；null 表示还没量过。找一个人和找两个人各记各的：
   * 找两个人每次识别要多花十来毫秒，"只找一个人时够快"的结论不能直接套过去。
   */
  private readonly auto: Record<1 | 2, ModelKind | null>;
  private lastFrameAt = -Infinity;
  /** 正在跑的这一轮；重启时把它作废 */
  private run: { stop(): void } | null = null;

  constructor(deps: Partial<EngineDeps> = {}) {
    this.deps = { ...realDeps(), ...deps };
    this.auto = { 1: this.remembered(1), 2: this.remembered(2) };
  }

  get snapshot(): EngineSnapshot {
    return this.snap;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** 交进新的设置。和现在的没有实际区别就什么也不做。 */
  configure(config: EngineConfig): void {
    const before = this.config;
    this.config = config;
    if (before && this.run && !this.matters(before, config)) return;
    this.start();
  }

  /** 再试一次 */
  retry = (): void => {
    if (this.config) this.start();
  };

  /** 不用摄像头了，换成模拟玩家（演示模式） */
  useDemo = (): void => {
    this.demo = true;
    if (this.config) this.start();
  };

  /**
   * 距离上一次识别结果过了多久（毫秒）；还没有过结果时是无穷大。
   * tracker.state 永远是"最后一次"的结果——用它之前先看这个数，太久了就当作没看到人。
   */
  sinceFrame = (nowMs: number = this.deps.clock()): number => nowMs - this.lastFrameAt;

  /** 停掉一切。之后还可以再 configure。 */
  dispose(): void {
    this.run?.stop();
    this.run = null;
    this.config = null;
  }

  // ---------------------------------------------------------------- 内部

  private kindOf(c: EngineConfig): SourceKind {
    // 录制排最前：点"用这段代替摄像头"是最明确的一次选择，地址里带着 sim 开关、或者正处在演示模式，也照样生效
    if (c.replay) return 'replay';
    return c.sim !== 'off' || this.demo ? 'sim' : 'camera';
  }

  /** 两份设置的差别对正在用的那种来源有没有影响。 */
  private matters(a: EngineConfig, b: EngineConfig): boolean {
    const kind = this.kindOf(b);
    if (kind !== this.kindOf(a)) return true;
    if (kind === 'sim') return a.seed !== b.seed;
    if (kind === 'replay') return a.replay !== b.replay;
    // 模型看的是"实际会用哪个"：把"自动"改成它正在用的那个（或者反过来），不算变化
    return this.modelFor(a) !== this.modelFor(b) || a.cameraId !== b.cameraId || a.worker !== b.worker || a.people !== b.people;
  }

  /** 按这份设置，实际用哪个模型。"自动"而又还没量过时，先用标准的。 */
  private modelFor(c: EngineConfig): ModelKind {
    return c.model === 'auto' ? (this.auto[c.people] ?? 'full') : c.model;
  }

  private set(next: EngineSnapshot): void {
    this.snap = next;
    for (const listener of [...this.listeners]) listener();
  }

  private remembered(people: 1 | 2): ModelKind | null {
    try {
      return decodeChoice(this.deps.storage?.getItem(AUTO_KEY[people]) ?? null, this.deps.wallClock());
    } catch {
      return null;
    }
  }

  private remember(people: 1 | 2, model: ModelKind): void {
    this.auto[people] = model;
    try {
      this.deps.storage?.setItem(AUTO_KEY[people], encodeChoice(model, this.deps.wallClock()));
    } catch {
      /* 存不上就下次再量 */
    }
  }

  private start(): void {
    this.run?.stop();
    const config = this.config!;
    const kind = this.kindOf(config);
    // 新的来源看到的画面可能完全不同：之前的标定（原点、身材、认准的人）都作废
    this.tracker.reset();
    this.lastFrameAt = -Infinity;
    this.set({ ...LOADING, kind });

    const people = config.people;
    const model = this.modelFor(config);
    const measuring = kind === 'camera' && config.model === 'auto' && this.auto[people] === null;

    let cancelled = false;
    const cleanup: (() => void)[] = [];
    /** 这一轮到此为止：不再理它发来的任何东西，把来源关掉（摄像头的灯灭掉）。可以重复调用 */
    const stop = (): void => {
      if (cancelled) return;
      cancelled = true;
      for (const undo of cleanup) undo();
      source.stop();
    };
    /** 出错了：这一轮结束，页面上换成说明。出错卡片底下不该还开着摄像头、还在往追踪器里喂数据 */
    const fail = (err: unknown): void => {
      if (cancelled) return;
      stop();
      this.set({ ...LOADING, kind, status: 'error', error: describe(err) });
    };

    const source =
      kind === 'sim'
        ? this.deps.makeSim({ seed: config.seed ?? 1 })
        : kind === 'replay'
          ? this.deps.makeReplay(config.replay!)
          : this.deps.makeCamera({
              model,
              deviceId: config.cameraId || undefined,
              worker: config.worker,
              numPoses: config.people,
              onProgress: (loaded, total) => {
                if (!cancelled && this.snap.status === 'loading') this.set({ ...this.snap, progress: { loaded, total }, step: loaded >= total ? 'start' : 'download' });
              },
              onProblem: (problem) =>
                fail(
                  problem === 'detect'
                    ? new VisionError('识别引擎停了', '它连续好一会儿没出结果（可能是显卡被别的程序占了，或者电脑刚从休眠里醒来）。点"再试一次"。')
                    : new CameraError('摄像头画面停住了', '看看摄像头是不是被拔掉了，或者被别的程序占用了，然后点"再试一次"。', 'busy'),
                ),
            });

    cleanup.push(
      source.onFrame((f) => {
        if (cancelled) return;
        this.tracker.ingest(f);
        this.lastFrameAt = this.deps.clock();
      }),
    );
    this.run = { stop };

    const ready = (): void => {
      if (!cancelled) this.set({ ...LOADING, kind, status: 'ready', source, video: source.video });
    };

    source.start().then(() => {
      if (cancelled) {
        source.stop(); // 等它启动的工夫已经换了别的来源：立刻关掉（摄像头的灯不能一直亮着）
        return;
      }
      if (!measuring) return ready();

      // ---- 测速：这台电脑用标准模型识别一次要多久 ----
      this.set({ ...this.snap, step: 'measure' });
      const times: number[] = [];
      let decided = false;
      const decide = (): void => {
        if (decided) return;
        decided = true;
        stopListening();
        cancelTimer();
        if (cancelled) return;
        // 量的工夫里，人已经在设置里亲手选了模型：听他的，量出来的不作数
        if (this.config?.model !== 'auto') return ready();
        const picked = pickModel(typicalDetectMs(times));
        // 量不出来（picked 为 null）：这次先用正在跑的标准模型，不记结论，下次再量
        if (picked) this.remember(people, picked);
        if (picked === 'lite') this.start(); // 换轻量模型重来一遍（这一轮不用再量）
        else ready();
      };
      const stopListening = source.onFrame(() => {
        times.push(source.stats().lastMs ?? 0);
        if (times.length >= WARMUP_FRAMES + SAMPLE_FRAMES) decide();
      });
      const cancelTimer = this.deps.timeout(decide, MEASURE_TIMEOUT_MS);
      cleanup.push(stopListening, cancelTimer);
    }, fail);
  }
}
