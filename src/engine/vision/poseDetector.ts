import type { RawPose } from '../input/types';
import { ASSETS, fetchWithProgress, HttpError } from './assets';
import { toRawPose } from './convert';

/**
 * 识别层：把一帧视频变成每个人的 33 个关键点。
 *
 * 用的是 Google 开源的 MediaPipe Pose Landmarker，以 WebAssembly 的形式跑在浏览器里——
 * 画面不离开这台电脑。这里只做三件事：下载模型（带进度）、选推理后端（GPU 不行就退回 CPU）、
 * 把库的输出转成我们自己的 RawPose。
 */
export type ModelKind = 'lite' | 'full';

/** 给人看的识别层错误。 */
export class VisionError extends Error {
  constructor(
    readonly title: string,
    readonly hint: string,
  ) {
    super(title);
    this.name = 'VisionError';
  }
}

/** 我们用到的识别库接口（只有这两个方法），方便在测试里换成假的。 */
export interface LandmarkerLike {
  detectForVideo(
    video: unknown,
    timestampMs: number,
  ): { landmarks: { x: number; y: number; z: number; visibility?: number }[][]; worldLandmarks: { x: number; y: number; z: number }[][] };
  close(): void;
}

export interface DetectorDeps {
  loadModel(model: ModelKind, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array>;
  create(delegate: 'GPU' | 'CPU', model: Uint8Array, numPoses: number): Promise<LandmarkerLike>;
}

export interface PoseDetector {
  /** timestampMs 必须严格递增 */
  detect(video: HTMLVideoElement, timestampMs: number): RawPose[];
  readonly delegate: 'GPU' | 'CPU';
  readonly model: ModelKind;
  close(): void;
}

const realDeps: DetectorDeps = {
  loadModel: (model, onProgress) => fetchWithProgress(ASSETS.modelUrl(model), onProgress),
  async create(delegate, model, numPoses) {
    // 识别库有一百多 KB，用到时才加载
    const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks(ASSETS.wasmBase);
    return PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: model, delegate },
      runningMode: 'VIDEO', // 视频模式：会利用上一帧的结果做追踪，比逐帧独立识别又快又稳
      numPoses,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  },
};

/**
 * 下载模型文件，并把下载失败翻译成给人看的提示。
 * 单独拿出来，是因为模型内容可能要交给 Worker，也可能留在主线程用，下载一次就够了。
 */
export async function loadModelBytes(model: ModelKind, onProgress?: (loaded: number, total: number) => void, loadModel: DetectorDeps['loadModel'] = realDeps.loadModel): Promise<Uint8Array> {
  try {
    return await loadModel(model, onProgress);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new VisionError('识别模型文件不见了', '在项目目录运行 npm run setup 把模型下载下来，然后刷新页面。');
    }
    throw new VisionError('识别模型没加载成功', `可能是网络不太好，点"再试一次"。（${err instanceof Error ? err.message : String(err)}）`);
  }
}

export async function createPoseDetector(opts: {
  model: ModelKind;
  /** 已经下载好的模型内容；给了就不再下载 */
  bytes?: Uint8Array;
  /**
   * 最多识别几个人，默认 1。
   * 不要随手调大：实测只要"还没找够人"，模型每一帧都会多跑一遍找人的检测器，
   * 单人在画面里时设成 2 比设成 1 每帧慢 12 毫秒左右。只识别 1 个人时，模型靠上一帧的位置跟踪，
   * 本身就会一直跟着同一个人。
   */
  numPoses?: number;
  onProgress?: (loaded: number, total: number) => void;
  deps?: DetectorDeps;
}): Promise<PoseDetector> {
  const deps = opts.deps ?? realDeps;
  const numPoses = opts.numPoses ?? 1;

  const model = opts.bytes ?? (await loadModelBytes(opts.model, opts.onProgress, deps.loadModel));

  let landmarker: LandmarkerLike;
  let delegate: 'GPU' | 'CPU' = 'GPU';
  try {
    landmarker = await deps.create('GPU', model, numPoses);
  } catch (gpuErr) {
    console.warn('[vision] GPU 用不了，改用 CPU：', gpuErr);
    delegate = 'CPU';
    try {
      landmarker = await deps.create('CPU', model, numPoses);
    } catch (cpuErr) {
      // 最常见的原因是识别库的文件（public/mediapipe/wasm）没准备好，其次才是浏览器太旧
      throw new VisionError(
        '识别引擎启动失败',
        `先在项目目录运行 npm run setup（它会把识别库的文件准备好），然后刷新页面；还不行的话，换最新版的 Chrome 或 Edge。（${cpuErr instanceof Error ? cpuErr.message : String(cpuErr)}）`,
      );
    }
  }

  return {
    delegate,
    model: opts.model,
    detect(video, timestampMs) {
      const r = landmarker.detectForVideo(video, timestampMs);
      return r.landmarks.map((lm, i) => toRawPose(lm, r.worldLandmarks[i] ?? []));
    },
    close: () => landmarker.close(),
  };
}
