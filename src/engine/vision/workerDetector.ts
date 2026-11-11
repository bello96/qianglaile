import type { RawPose } from '../input/types';
import { ASSETS } from './assets';
import type { ModelKind, PoseDetector } from './poseDetector';
import { packPoses, unpackPoses } from './posePacking';

export { packPoses, unpackPoses };

/**
 * 把识别放到 Web Worker 里跑。
 *
 * 为什么：一次识别要十几到二十毫秒，而且是同步的。放在主线程，这一帧就超出 16.7 毫秒的预算，
 * 画面每秒被卡三十次。放进 Worker 之后，主线程只管渲染，识别在另一个线程慢慢算。
 *
 * 怎么传画面：主线程用 createImageBitmap 把视频当前帧"拍"成一张位图，转移给 Worker
 * （转移不是复制，几乎不花时间）；Worker 识别完，把关键点装进一个 Float32Array 转移回来。
 * Worker 还在算上一帧时，新来的帧直接丢掉——宁可少识别一帧，也不让帧排队越积越多。
 */

/** 不管识别在哪个线程跑，对外都是这个接口。 */
export interface AsyncDetector {
  /** 识别一帧。返回 null 表示这一帧没识别（上一帧还没算完，或者出错了）。 */
  detect(video: HTMLVideoElement, timestampMs: number): Promise<RawPose[] | null>;
  readonly delegate: 'GPU' | 'CPU';
  readonly model: ModelKind;
  readonly thread: 'worker' | 'main';
  readonly busy: boolean;
  /** 最近一次识别花了多少毫秒 */
  readonly lastMs: number;
  close(): void;
}

/** 我们用到的 Worker 接口，方便测试里换成假的。 */
export interface WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

type FromWorker =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'error'; message: string }
  | { type: 'result'; ts: number; data: Float32Array | null; ms: number };

const spawnWorker = (): WorkerLike => new Worker(new URL('./poseWorker.ts', import.meta.url), { type: 'module' });

/** 浏览器是否具备在 Worker 里识别所需的全部条件。 */
export function canUseWorker(): boolean {
  return typeof Worker !== 'undefined' && typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined';
}

export function createWorkerDetector(opts: {
  model: ModelKind;
  /** 模型文件的内容。这里会复制一份交给 Worker，调用者手里的那份不受影响 */
  bytes: Uint8Array;
  numPoses: number;
  spawn?: () => WorkerLike;
  grab?: (video: HTMLVideoElement) => Promise<ImageBitmap>;
  timeoutMs?: number;
  /** 当前页面的地址，用来把站内路径补成完整地址；默认取 location.href */
  pageUrl?: string;
}): Promise<AsyncDetector> {
  const worker = (opts.spawn ?? spawnWorker)();
  // 实测过把位图缩小再传（960 / 640 / 480 宽）：识别时间没有变化，所以原尺寸传，不损失精度
  const grab = opts.grab ?? ((video: HTMLVideoElement) => createImageBitmap(video));

  return new Promise<AsyncDetector>((resolve, reject) => {
    let settled = false;
    let busy = false;
    let lastMs = 0;
    let waiting: ((poses: RawPose[] | null) => void) | null = null;

    const giveUp = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(message));
    };
    const timer = setTimeout(() => giveUp('识别 Worker 没有响应'), opts.timeoutMs ?? 20000);

    const finish = (poses: RawPose[] | null): void => {
      busy = false;
      const done = waiting;
      waiting = null;
      done?.(poses);
    };

    worker.onerror = (e) => {
      if (!settled) giveUp(e.message || '识别 Worker 加载失败');
      else finish(null);
    };
    worker.onmessage = (e) => {
      const msg = e.data as FromWorker;
      if (msg.type === 'error') {
        giveUp(msg.message);
      } else if (msg.type === 'ready') {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const delegate = msg.delegate;
        resolve({
          delegate,
          model: opts.model,
          thread: 'worker',
          get busy() {
            return busy;
          },
          get lastMs() {
            return lastMs;
          },
          detect(video, timestampMs) {
            if (busy) return Promise.resolve(null);
            busy = true;
            return new Promise<RawPose[] | null>((done) => {
              waiting = done;
              grab(video).then(
                (bitmap) => worker.postMessage({ type: 'frame', bitmap, ts: timestampMs }, [bitmap]),
                () => finish(null), // 视频帧还没准备好之类：这一帧算了
              );
            });
          },
          close() {
            worker.postMessage({ type: 'close' });
            worker.terminate();
          },
        });
      } else if (msg.type === 'result') {
        lastMs = msg.ms;
        finish(msg.data ? unpackPoses(msg.data) : null);
      }
    };

    // 复制一份模型交给 Worker（转移之后这块内存主线程就不能再用了，所以不能转移调用者的那份）
    const model = opts.bytes.buffer.slice(opts.bytes.byteOffset, opts.bytes.byteOffset + opts.bytes.byteLength) as ArrayBuffer;
    // wasm 文件的位置要给带域名的完整地址。识别库在模块 Worker 里是用 import() 加载 wasm 胶水代码的；
    // 只给 "/mediapipe/wasm" 的话，开发服务器会把这个 import 改写成 "...?import"，而 public/ 下的文件不许那样导入。
    const pageUrl = opts.pageUrl ?? (typeof location !== 'undefined' ? location.href : undefined);
    const wasmBase = pageUrl ? new URL(ASSETS.wasmBase, pageUrl).href : ASSETS.wasmBase;
    worker.postMessage({ type: 'init', model, numPoses: opts.numPoses, wasmBase }, [model]);
  });
}

/** 把主线程上的同步识别器包装成同一个异步接口（Worker 用不了时的退路）。 */
export function wrapSync(detector: PoseDetector): AsyncDetector {
  let lastMs = 0;
  return {
    delegate: detector.delegate,
    model: detector.model,
    thread: 'main',
    busy: false,
    get lastMs() {
      return lastMs;
    },
    detect(video, timestampMs) {
      const t0 = performance.now();
      try {
        const poses = detector.detect(video, timestampMs);
        lastMs = performance.now() - t0;
        return Promise.resolve(poses);
      } catch (err) {
        console.warn('[vision] 这一帧识别出错：', err);
        return Promise.resolve(null);
      }
    },
    close: () => detector.close(),
  };
}
