import { closeCamera, openCamera, watchCamera } from '../camera/camera';
import { Emitter } from '../util/emitter';
import { createPoseDetector, loadModelBytes, type ModelKind } from '../vision/poseDetector';
import { canUseWorker, createWorkerDetector, wrapSync, type AsyncDetector } from '../vision/workerDetector';
import type { PoseSource, RawFrame, SourceStats } from './types';

/** 连续这么多次识别都没出结果（一两秒），就认为识别引擎坏了 */
const MAX_FAILURES = 45;
/** 交给识别器一帧之后，这么久（毫秒）还没有回音，就认为它卡死了 */
const HANG_MS = 8000;
/**
 * 头一帧例外，等得久得多：识别器的第一次识别要编译着色器、分配内存，是"热身"。
 * 无头浏览器里实测超过 5 秒，慢的电脑上更久——那不是卡死，不能报错把人挡在门外。
 */
const WARMUP_HANG_MS = 30000;
/**
 * 算"它已经忙了多久"时，两次查看之间最多记这么多毫秒。
 * 电脑睡了一觉、标签页在后台待了半天，时钟会一下子跳出去很远，而那段时间里识别器并没有真的在"卡"——
 * 只把我们亲眼看着它忙的时间加起来，就不会被这种跳变骗到。
 */
const MAX_WATCH_STEP_MS = 250;

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number) => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

/**
 * 这个类用到的"外面的东西"：摄像头、识别器、时钟、屏幕刷新回调。
 * 平时用真的（见 REAL）；测试里换成假的，这样不开浏览器也能把它的每一条规矩测到。
 */
export interface CameraSourceDeps {
  openCamera(opts: { deviceId?: string }): Promise<HTMLVideoElement>;
  closeCamera(video: HTMLVideoElement | null): void;
  watchCamera(video: HTMLVideoElement, onProblem: (kind: 'ended' | 'frozen') => void): () => void;
  loadModelBytes(model: ModelKind, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array>;
  canUseWorker(): boolean;
  createWorkerDetector(opts: { model: ModelKind; bytes: Uint8Array; numPoses: number }): Promise<AsyncDetector>;
  createMainDetector(opts: { model: ModelKind; bytes: Uint8Array; numPoses: number }): Promise<AsyncDetector>;
  now(): number;
  requestFrame(cb: () => void): number;
  cancelFrame(id: number): void;
}

const REAL: CameraSourceDeps = {
  openCamera,
  closeCamera,
  watchCamera,
  loadModelBytes,
  canUseWorker,
  createWorkerDetector,
  createMainDetector: async (opts) => wrapSync(await createPoseDetector(opts)),
  now: () => performance.now(),
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (id) => cancelAnimationFrame(id),
};

/**
 * 真实的姿态来源：摄像头 + 识别模型。
 *
 * 识别跟着**摄像头的新帧**走，而不是跟着屏幕刷新走——摄像头每秒只出 30 帧，
 * 屏幕刷新 60 次的话有一半时间画面根本没变，重复识别是白费力气。
 * 浏览器支持 requestVideoFrameCallback 时用它（每来一帧新画面回调一次），否则退回到
 * requestAnimationFrame 并自己比较 currentTime 去重。
 *
 * 识别本身优先放在 Web Worker 里跑（不卡画面）；Worker 起不来就退回主线程，功能不变。
 */
export class CameraPoseSource implements PoseSource {
  readonly kind = 'camera' as const;
  video: HTMLVideoElement | null = null;

  private readonly deps: CameraSourceDeps;
  private readonly numPoses: number;
  private readonly frames = new Emitter<RawFrame>();
  private detector: AsyncDetector | null = null;
  private stopWatching: (() => void) | null = null;
  private running = false;
  private starting = false;
  /** 还在启动的时候就有人叫停了：等摄像头和识别器到手，立刻把它们关掉 */
  private stopRequested = false;
  // ---- 看识别器有没有卡死 ----
  /** 识别器拿着一帧没给回音，（在我们看着的时候）已经过了多久 */
  private busyMs = 0;
  /** 上一次查看是什么时候 */
  private watchedAt = 0;
  /** 这个识别器回过话没有：还没回过，说明在热身，多等等 */
  private warm = false;
  private hangReported = false;
  /** 取消已经排上的下一次回调 */
  private cancelNext: (() => void) | null = null;
  /** 连续多少次识别没出结果 */
  private failures = 0;
  private lastVideoTime = -1;
  private lastTs = 0;
  private lastResultAt = 0;
  private fps = 0;
  private detectMs = 0;

  constructor(
    private readonly opts: {
      model: ModelKind;
      deviceId?: string;
      /** false：不用 Worker，识别留在主线程 */
      worker?: boolean;
      /**
       * 最多识别几个人，默认 1。设成 2 时旁人入镜也能一直跟住玩家（见 PersonSelector），
       * 代价是画面里只有一个人时，模型每帧都要多找一遍"第二个人"，大约多花 12 毫秒。
       */
      numPoses?: number;
      onProgress?: (loaded: number, total: number) => void;
      /** ended / frozen：摄像头断了、画面停了；detect：识别引擎连续出错 */
      onProblem?: (kind: 'ended' | 'frozen' | 'detect') => void;
      deps?: Partial<CameraSourceDeps>;
    },
  ) {
    this.deps = { ...REAL, ...opts.deps };
    this.numPoses = opts.numPoses ?? 1;
  }

  /** 下载模型，然后优先在 Worker 里建识别器；不行就在主线程建。 */
  private async makeDetector(): Promise<AsyncDetector> {
    const { model } = this.opts;
    const bytes = await this.deps.loadModelBytes(model, this.opts.onProgress);
    const want = { model, bytes, numPoses: this.numPoses };
    if (this.opts.worker !== false && this.deps.canUseWorker()) {
      try {
        return await this.deps.createWorkerDetector(want);
      } catch (err) {
        console.warn('[vision] 识别 Worker 没起来，改在主线程识别：', err);
      }
    }
    return this.deps.createMainDetector(want);
  }

  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.starting = true;
    this.stopRequested = false;
    try {
      // 开摄像头和准备识别器同时进行；任何一个失败都要把另一个收拾掉
      const [cam, det] = await Promise.allSettled([this.deps.openCamera({ deviceId: this.opts.deviceId }), this.makeDetector()]);
      if (cam.status === 'rejected' || det.status === 'rejected') {
        if (cam.status === 'fulfilled') this.deps.closeCamera(cam.value);
        if (det.status === 'fulfilled') det.value.close();
        throw cam.status === 'rejected' ? cam.reason : (det as PromiseRejectedResult).reason;
      }
      if (this.stopRequested) {
        // 启动到一半被叫停了（比如页面已经离开）：摄像头刚打开，马上关掉，不能就这么跑起来
        this.deps.closeCamera(cam.value);
        det.value.close();
        return;
      }
      this.video = cam.value;
      this.detector = det.value;
      this.running = true;
      this.failures = 0;
      // 新的识别器：它又要热身，卡没卡死从头算
      this.busyMs = 0;
      this.watchedAt = this.deps.now();
      this.warm = false;
      this.hangReported = false;
      if (this.opts.onProblem) this.stopWatching = this.deps.watchCamera(this.video, this.opts.onProblem);
      this.schedule();
    } finally {
      this.starting = false;
    }
  }

  private schedule(): void {
    if (!this.running || !this.video) return;
    const video = this.video as VideoWithFrameCallback;
    // 两种排法各有各的取消办法，编号不通用，所以把"怎么取消"和编号一起记下来
    if (video.requestVideoFrameCallback) {
      const id = video.requestVideoFrameCallback(() => {
        this.tick();
        this.schedule();
      });
      this.cancelNext = () => video.cancelVideoFrameCallback?.(id);
    } else {
      const id = this.deps.requestFrame(() => {
        if (this.video && this.video.currentTime !== this.lastVideoTime) this.tick();
        this.schedule();
      });
      this.cancelNext = () => this.deps.cancelFrame(id);
    }
  }

  private tick(): void {
    const video = this.video;
    const detector = this.detector;
    if (!video || !detector || video.readyState < 2) return;
    this.lastVideoTime = video.currentTime;
    const clock = this.deps.now();
    const watched = Math.min(Math.max(0, clock - this.watchedAt), MAX_WATCH_STEP_MS);
    this.watchedAt = clock;
    if (detector.busy) {
      // 上一帧还没识别完：这一帧不要了，不排队。
      // 但要是它拿着上一帧太久都没回音，那是卡死了——它一直"忙"就再也收不到新帧，上面那个"连续失败"也数不起来，所以单独看
      this.busyMs += watched;
      if (!this.hangReported && this.busyMs > (this.warm ? HANG_MS : WARMUP_HANG_MS)) {
        this.hangReported = true;
        this.opts.onProblem?.('detect');
      }
      return;
    }

    // 识别库要求时间戳严格递增
    const ts = Math.max(clock, this.lastTs + 1);
    this.lastTs = ts;
    this.busyMs = 0;
    const aspect = video.videoWidth / Math.max(1, video.videoHeight);

    void detector.detect(video, ts).then((poses) => {
      // 已经停了，或者停过又重新启动、换了识别器：这是上一轮欠下的答案，不要了
      if (!this.running || this.detector !== detector) return;
      this.warm = true;
      if (!poses) {
        // 偶尔一帧没出结果不要紧；一直不出（比如显卡上下文丢了）就得告诉外面，不然玩家只会看到"没人"
        if (++this.failures === MAX_FAILURES) this.opts.onProblem?.('detect');
        return;
      }
      this.failures = 0;
      const now = this.deps.now();
      // 指数平滑，读数不乱跳
      this.detectMs += (detector.lastMs - this.detectMs) * (this.detectMs ? 0.1 : 1);
      if (this.lastResultAt) {
        const instant = 1000 / Math.max(1, now - this.lastResultAt);
        this.fps += (instant - this.fps) * (this.fps ? 0.1 : 1);
      }
      this.lastResultAt = now;
      this.frames.emit({ t: ts, aspect, poses });
    });
  }

  stop(): void {
    if (this.starting) this.stopRequested = true;
    this.running = false;
    this.cancelNext?.();
    this.cancelNext = null;
    this.stopWatching?.();
    this.stopWatching = null;
    if (this.video) this.deps.closeCamera(this.video);
    this.video = null;
    this.detector?.close();
    this.detector = null;
  }

  onFrame(cb: (f: RawFrame) => void): () => void {
    return this.frames.on(cb);
  }

  stats(): SourceStats {
    const d = this.detector;
    return {
      fps: this.fps,
      detectMs: this.detectMs,
      lastMs: d?.lastMs,
      delegate: d?.delegate ?? '-',
      model: this.opts.model,
      thread: d?.thread,
      people: this.numPoses,
    };
  }
}
