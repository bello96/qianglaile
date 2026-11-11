import type { ModelKind } from './poseDetector';

/**
 * 识别库和模型文件都放在本站自己的 public/ 下（由 npm run setup 准备），运行时不依赖任何外部 CDN。
 */
export const ASSETS = {
  /** MediaPipe 的 wasm 运行时所在目录 */
  wasmBase: '/mediapipe/wasm',
  modelUrl: (m: ModelKind): string => `/models/pose_landmarker_${m}.task`,
  /** 用于在还没拿到 content-length 时显示下载进度 */
  modelSize: { lite: 5777746, full: 9398198 } satisfies Record<ModelKind, number>,
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

/**
 * 带进度的下载。模型有好几兆，第一次打开要等几秒，界面上得有进度条。
 * onProgress(已下载字节, 总字节)；服务器没给总大小时，总字节取已下载的量。
 */
export async function fetchWithProgress(url: string, onProgress?: (loaded: number, total: number) => void, fetchFn: typeof fetch = fetch): Promise<Uint8Array> {
  const res = await fetchFn(url);
  if (!res.ok) throw new HttpError(res.status, url);
  // 开发服务器对不存在的路径会回首页（200 + text/html）：那不是我们要的文件
  if ((res.headers.get('content-type') ?? '').includes('text/html')) throw new HttpError(404, url);

  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body?.getReader();
  if (!reader) {
    const all = new Uint8Array(await res.arrayBuffer());
    onProgress?.(all.length, all.length);
    return all;
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, Math.max(total, loaded));
  }
  const all = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  onProgress?.(loaded, loaded);
  return all;
}
