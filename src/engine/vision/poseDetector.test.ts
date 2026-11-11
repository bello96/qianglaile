import { describe, expect, it, vi } from 'vitest';
import { fetchWithProgress, HttpError } from './assets';
import { createPoseDetector, loadModelBytes, VisionError, type DetectorDeps, type LandmarkerLike } from './poseDetector';

const fakeLandmarker = (): LandmarkerLike & { closed: boolean } => ({
  closed: false,
  detectForVideo: () => ({
    landmarks: [Array.from({ length: 33 }, (_, i) => ({ x: i / 100, y: 0.5, z: 0, visibility: 0.9 }))],
    worldLandmarks: [Array.from({ length: 33 }, (_, i) => ({ x: i / 10, y: -0.1, z: 0.2 }))],
  }),
  close() {
    this.closed = true;
  },
});

const deps = (over: Partial<DetectorDeps> = {}): DetectorDeps => ({
  loadModel: async () => new Uint8Array([1, 2, 3]),
  create: async () => fakeLandmarker(),
  ...over,
});

describe('createPoseDetector', () => {
  it('prefers the GPU', async () => {
    const create = vi.fn(async () => fakeLandmarker());
    const d = await createPoseDetector({ model: 'full', deps: deps({ create }) });
    expect(d.delegate).toBe('GPU');
    expect(d.model).toBe('full');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith('GPU', expect.any(Uint8Array), 1); // 默认只识别一个人
  });

  it('falls back to the CPU when the GPU cannot be used', async () => {
    const create = vi.fn(async (delegate: 'GPU' | 'CPU') => {
      if (delegate === 'GPU') throw new Error('no webgl');
      return fakeLandmarker();
    });
    const d = await createPoseDetector({ model: 'lite', numPoses: 2, deps: deps({ create }) });
    expect(d.delegate).toBe('CPU');
    expect(create.mock.calls.map((c) => c[0])).toEqual(['GPU', 'CPU']);
    expect(create).toHaveBeenLastCalledWith('CPU', expect.any(Uint8Array), 2);
  });

  it('explains itself when neither works', async () => {
    const create = async () => {
      throw new Error('wasm exploded');
    };
    const err = await createPoseDetector({ model: 'lite', deps: deps({ create }) }).catch((e) => e);
    expect(err).toBeInstanceOf(VisionError);
    expect(err.title).toMatch(/[一-鿿]/);
    expect(err.hint).toContain('wasm exploded');
    // 在这个项目里，最常见的原因是识别库的文件没准备好（没跑过 npm run setup），得先说这个
    expect(err.hint).toContain('npm run setup');
  });

  it('tells you to run the setup script when the model file is missing', async () => {
    const loadModel = async () => {
      throw new HttpError(404, '/models/x.task');
    };
    const err = await createPoseDetector({ model: 'full', deps: deps({ loadModel }) }).catch((e) => e);
    expect(err).toBeInstanceOf(VisionError);
    expect(err.hint).toContain('npm run setup');
  });

  it('suggests retrying on other download failures', async () => {
    const loadModel = async () => {
      throw new TypeError('Failed to fetch');
    };
    const err = await createPoseDetector({ model: 'full', deps: deps({ loadModel }) }).catch((e) => e);
    expect(err).toBeInstanceOf(VisionError);
    expect(err.hint).toContain('再试一次');
    expect(err.hint).not.toContain('npm run setup');
  });

  it('reports download progress', async () => {
    const seen: [number, number][] = [];
    const loadModel: DetectorDeps['loadModel'] = async (_m, onProgress) => {
      onProgress?.(50, 100);
      onProgress?.(100, 100);
      return new Uint8Array(1);
    };
    await createPoseDetector({ model: 'lite', onProgress: (l, t) => seen.push([l, t]), deps: deps({ loadModel }) });
    expect(seen).toEqual([[50, 100], [100, 100]]);
  });

  it('converts the model output into RawPose', async () => {
    const d = await createPoseDetector({ model: 'lite', deps: deps() });
    const poses = d.detect({} as HTMLVideoElement, 123);
    expect(poses).toHaveLength(1);
    expect(poses[0].image).toHaveLength(33);
    expect(poses[0].image[5]).toEqual({ x: 0.05, y: 0.5, z: 0, v: 0.9 });
    expect(poses[0].world[5]).toMatchObject({ x: 0.5, y: -0.1, z: 0.2 });
  });

  it('uses model bytes it is handed instead of downloading them again', async () => {
    const loadModel = vi.fn(async () => new Uint8Array(1));
    const create = vi.fn(async () => fakeLandmarker());
    const bytes = new Uint8Array([9, 9]);
    await createPoseDetector({ model: 'lite', bytes, deps: deps({ loadModel, create }) });
    expect(loadModel).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith('GPU', bytes, 1);
  });

  it('closes the underlying landmarker', async () => {
    const lm = fakeLandmarker();
    const d = await createPoseDetector({ model: 'lite', deps: deps({ create: async () => lm }) });
    d.close();
    expect(lm.closed).toBe(true);
  });
});

describe('loadModelBytes', () => {
  it('returns the bytes and passes progress through', async () => {
    const seen: number[] = [];
    const bytes = await loadModelBytes('lite', (l) => seen.push(l), async (_m, onProgress) => {
      onProgress?.(3, 3);
      return new Uint8Array([1, 2, 3]);
    });
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(seen).toEqual([3]);
  });

  it('turns a missing file into advice to run the setup script', async () => {
    const err = await loadModelBytes('full', undefined, async () => {
      throw new HttpError(404, '/models/x.task');
    }).catch((e) => e);
    expect(err).toBeInstanceOf(VisionError);
    expect(err.hint).toContain('npm run setup');
  });
});

describe('fetchWithProgress', () => {
  const streamOf = (chunks: number[][]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new Uint8Array(chunk));
        c.close();
      },
    });

  it('downloads in chunks and reports progress up to the total', async () => {
    const fetchFn = (async () => new Response(streamOf([[1, 2], [3], [4, 5, 6]]), { headers: { 'content-length': '6', 'content-type': 'application/octet-stream' } })) as typeof fetch;
    const seen: [number, number][] = [];
    const bytes = await fetchWithProgress('/x', (l, t) => seen.push([l, t]), fetchFn);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen[seen.length - 1]).toEqual([6, 6]);
    for (let i = 1; i < seen.length; i++) expect(seen[i][0]).toBeGreaterThanOrEqual(seen[i - 1][0]);
  });

  it('works without a content-length', async () => {
    const fetchFn = (async () => new Response(streamOf([[9, 9, 9]]))) as typeof fetch;
    const seen: [number, number][] = [];
    const bytes = await fetchWithProgress('/x', (l, t) => seen.push([l, t]), fetchFn);
    expect(bytes).toHaveLength(3);
    expect(seen[seen.length - 1]).toEqual([3, 3]);
  });

  it('throws an HttpError for a missing file', async () => {
    const fetchFn = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    const err = await fetchWithProgress('/models/x.task', undefined, fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
  });

  it('treats an HTML page served in place of the file as missing', async () => {
    // 开发服务器遇到不存在的路径会回首页（200 + text/html），不能把它当模型文件
    const fetchFn = (async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    const err = await fetchWithProgress('/models/x.task', undefined, fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
  });
});
