import { describe, expect, it, vi } from 'vitest';
import type { RawPose } from '../input/types';
import { createWorkerDetector, packPoses, unpackPoses, type WorkerLike } from './workerDetector';

const pose = (seed: number): RawPose => ({
  image: Array.from({ length: 33 }, (_, i) => ({ x: (i + seed) / 100, y: 0.5 + seed / 10, z: -0.1, v: 0.9 })),
  world: Array.from({ length: 33 }, (_, i) => ({ x: i / 50 - seed, y: -0.2, z: 0.3, v: 0.9 })),
});

describe('packPoses / unpackPoses', () => {
  it('round-trips any number of people through one flat array', () => {
    for (const poses of [[], [pose(1)], [pose(1), pose(2)]]) {
      const back = unpackPoses(packPoses(poses));
      expect(back).toHaveLength(poses.length);
      for (let p = 0; p < poses.length; p++) {
        for (const i of [0, 15, 32]) {
          expect(back[p].image[i].x).toBeCloseTo(poses[p].image[i].x, 5);
          expect(back[p].image[i].v).toBeCloseTo(poses[p].image[i].v, 5);
          expect(back[p].world[i].x).toBeCloseTo(poses[p].world[i].x, 5);
          expect(back[p].world[i].z).toBeCloseTo(poses[p].world[i].z, 5);
        }
      }
    }
  });

  it('packs into a transferable Float32Array of the expected size', () => {
    const packed = packPoses([pose(1), pose(2)]);
    expect(packed).toBeInstanceOf(Float32Array);
    expect(packed).toHaveLength(1 + 2 * (33 * 4 + 33 * 3));
    expect(packed[0]).toBe(2);
  });
});

/** 假的 Worker：把主线程发来的消息记下来，测试里手动"回话"。 */
function fakeWorker() {
  const sent: { msg: any; transfer?: Transferable[] }[] = [];
  const worker: WorkerLike & { reply(data: unknown): void; fail(message: string): void; terminated: boolean } = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage(msg, transfer) {
      sent.push({ msg, transfer });
    },
    terminate() {
      this.terminated = true;
    },
    reply(data) {
      this.onmessage?.({ data } as MessageEvent);
    },
    fail(message) {
      this.onerror?.({ message } as ErrorEvent);
    },
  };
  return { worker, sent };
}
const frame = { close: vi.fn() } as unknown as ImageBitmap;
const grab = async () => frame;

describe('createWorkerDetector', () => {
  it('initialises the worker with the model and waits for it to be ready', async () => {
    const { worker, sent } = fakeWorker();
    const bytes = new Uint8Array([1, 2, 3]);
    const pending = createWorkerDetector({ model: 'lite', bytes, numPoses: 1, spawn: () => worker, grab });
    expect(sent[0].msg).toMatchObject({ type: 'init', numPoses: 1 });
    expect(sent[0].msg.model).toBeInstanceOf(ArrayBuffer);
    expect(sent[0].transfer).toEqual([sent[0].msg.model]);
    worker.reply({ type: 'ready', delegate: 'GPU' });
    const d = await pending;
    expect(d).toMatchObject({ delegate: 'GPU', model: 'lite', thread: 'worker', busy: false });
  });

  it('tells the worker where the wasm files are with a complete address', async () => {
    // 只给 "/mediapipe/wasm" 的话，开发服务器会把 Worker 里对它的动态 import 改写成 "...?import"，
    // 而 public/ 下的文件不许那样导入 —— 结果是 npm run dev 时 Worker 起不来。带上域名的完整地址它不碰。
    const { worker, sent } = fakeWorker();
    const pending = createWorkerDetector({ model: 'lite', bytes: new Uint8Array(1), numPoses: 1, spawn: () => worker, grab, pageUrl: 'http://localhost:5188/some/page?x=1#/lab' });
    expect(sent[0].msg.wasmBase).toBe('http://localhost:5188/mediapipe/wasm');
    worker.reply({ type: 'ready', delegate: 'GPU' });
    await pending;

    const other = fakeWorker();
    void createWorkerDetector({ model: 'lite', bytes: new Uint8Array(1), numPoses: 1, spawn: () => other.worker, grab, pageUrl: 'https://example.org/' }).catch(() => {});
    expect(other.sent[0].msg.wasmBase).toBe('https://example.org/mediapipe/wasm');
    other.worker.reply({ type: 'error', message: 'stop' });
  });

  it('rejects, and stops the worker, when initialisation fails', async () => {
    const a = fakeWorker();
    const p1 = createWorkerDetector({ model: 'lite', bytes: new Uint8Array(1), numPoses: 1, spawn: () => a.worker, grab });
    a.worker.reply({ type: 'error', message: 'no wasm here' });
    await expect(p1).rejects.toThrow('no wasm here');
    expect(a.worker.terminated).toBe(true);

    const b = fakeWorker();
    const p2 = createWorkerDetector({ model: 'lite', bytes: new Uint8Array(1), numPoses: 1, spawn: () => b.worker, grab });
    b.worker.fail('script failed to load');
    await expect(p2).rejects.toThrow('script failed to load');
  });

  it('gives up if the worker never answers', async () => {
    vi.useFakeTimers();
    const { worker } = fakeWorker();
    const p = createWorkerDetector({ model: 'lite', bytes: new Uint8Array(1), numPoses: 1, spawn: () => worker, grab, timeoutMs: 5000 });
    const caught = p.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await caught).toMatch(/没有响应|timed out/);
    expect(worker.terminated).toBe(true);
    vi.useRealTimers();
  });

  it('sends one frame at a time and resolves with the unpacked poses', async () => {
    const { worker, sent } = fakeWorker();
    const pending = createWorkerDetector({ model: 'full', bytes: new Uint8Array(1), numPoses: 1, spawn: () => worker, grab });
    worker.reply({ type: 'ready', delegate: 'CPU' });
    const d = await pending;

    const result = d.detect({} as HTMLVideoElement, 1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(d.busy).toBe(true);
    expect(sent[1].msg).toMatchObject({ type: 'frame', ts: 1000 });
    expect(sent[1].transfer).toEqual([frame]);
    // 上一帧还没回来：这一帧直接放弃，不排队
    expect(await d.detect({} as HTMLVideoElement, 1033)).toBeNull();

    worker.reply({ type: 'result', ts: 1000, data: packPoses([pose(3)]), ms: 12.5 });
    const poses = await result;
    expect(poses).toHaveLength(1);
    expect(poses![0].image[0].x).toBeCloseTo(0.03, 5);
    expect(d.busy).toBe(false);
    expect(d.lastMs).toBeCloseTo(12.5);
  });

  it('survives a frame the worker could not process', async () => {
    const { worker } = fakeWorker();
    const pending = createWorkerDetector({ model: 'full', bytes: new Uint8Array(1), numPoses: 1, spawn: () => worker, grab });
    worker.reply({ type: 'ready', delegate: 'GPU' });
    const d = await pending;
    const result = d.detect({} as HTMLVideoElement, 1);
    await Promise.resolve();
    await Promise.resolve();
    worker.reply({ type: 'result', ts: 1, data: null, ms: 0 });
    expect(await result).toBeNull();
    expect(d.busy).toBe(false);
  });

  it('close tells the worker to stop', async () => {
    const { worker, sent } = fakeWorker();
    const pending = createWorkerDetector({ model: 'full', bytes: new Uint8Array(1), numPoses: 1, spawn: () => worker, grab });
    worker.reply({ type: 'ready', delegate: 'GPU' });
    (await pending).close();
    expect(sent[sent.length - 1].msg).toEqual({ type: 'close' });
    expect(worker.terminated).toBe(true);
  });
});
