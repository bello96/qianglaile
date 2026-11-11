// 识别 Worker：在另一个线程里跑 MediaPipe Pose Landmarker。
// 主线程那一侧的代码和通信约定见 workerDetector.ts。
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { toRawPose } from './convert';
import { packPoses } from './posePacking';

type FromMain = { type: 'init'; model: ArrayBuffer; numPoses: number; wasmBase: string } | { type: 'frame'; bitmap: ImageBitmap; ts: number } | { type: 'close' };

// 这个文件运行在 Worker 里；项目的类型配置是按网页写的，所以只声明用到的那两样
const scope = self as unknown as { onmessage: ((e: MessageEvent<FromMain>) => void) | null; postMessage(msg: unknown, transfer?: Transferable[]): void };

let landmarker: PoseLandmarker | null = null;

async function init(msg: Extract<FromMain, { type: 'init' }>): Promise<void> {
  // 第二个参数 true：用 ES 模块版的 wasm 胶水代码。模块 Worker 里没有 importScripts，只能这样加载
  const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase, true);
  const model = new Uint8Array(msg.model);
  const create = (delegate: 'GPU' | 'CPU'): Promise<PoseLandmarker> =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: model, delegate },
      runningMode: 'VIDEO',
      numPoses: msg.numPoses,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  let delegate: 'GPU' | 'CPU' = 'GPU';
  try {
    landmarker = await create('GPU');
  } catch (err) {
    console.warn('[vision worker] GPU 用不了，改用 CPU：', err);
    delegate = 'CPU';
    landmarker = await create('CPU');
  }
  scope.postMessage({ type: 'ready', delegate });
}

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    init(msg).catch((err: unknown) => scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
  } else if (msg.type === 'frame') {
    const t0 = performance.now();
    let data: Float32Array | null = null;
    try {
      if (landmarker) {
        const r = landmarker.detectForVideo(msg.bitmap, msg.ts);
        data = packPoses(r.landmarks.map((lm, i) => toRawPose(lm, r.worldLandmarks[i] ?? [])));
      }
    } catch (err) {
      console.warn('[vision worker] 这一帧识别出错：', err);
    } finally {
      msg.bitmap.close(); // 位图用完要手动释放，否则显存会越占越多
    }
    scope.postMessage({ type: 'result', ts: msg.ts, data, ms: performance.now() - t0 }, data ? [data.buffer] : []);
  } else if (msg.type === 'close') {
    landmarker?.close();
    landmarker = null;
  }
};
