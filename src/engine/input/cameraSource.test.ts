import { describe, expect, it, vi } from 'vitest';
import { CameraError } from '../camera/camera';
import type { AsyncDetector } from '../vision/workerDetector';
import { CameraPoseSource, type CameraSourceDeps } from './cameraSource';
import type { RawFrame, RawPose } from './types';

const POSE: RawPose = { image: [], world: [] };
/** 让已经排上的异步回调跑完。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 假的 <video>：测试里调 frame() 表示"摄像头出了一帧新画面"。 */
function fakeVideo(withFrameCallback = true) {
  const waiting = new Map<number, () => void>();
  const cancelled: number[] = [];
  let nextId = 1;
  const video: Record<string, unknown> = { readyState: 4, videoWidth: 1280, videoHeight: 720, currentTime: 0 };
  if (withFrameCallback) {
    video.requestVideoFrameCallback = (cb: () => void): number => {
      waiting.set(nextId, cb);
      return nextId++;
    };
    video.cancelVideoFrameCallback = (id: number): void => {
      cancelled.push(id);
      waiting.delete(id);
    };
  }
  return {
    video: video as unknown as HTMLVideoElement,
    cancelled,
    waiting,
    frame(): void {
      (video.currentTime as number) += 0.033;
      const run = [...waiting.values()];
      waiting.clear();
      for (const cb of run) cb();
    },
  };
}

/** 假的识别器。answer 决定它下一次怎么回答：给出一个人 / 没出结果 / 一直算不完。 */
function fakeDetector(thread: 'worker' | 'main') {
  const d = {
    delegate: 'GPU' as const,
    model: 'full' as const,
    thread,
    busy: false,
    lastMs: 12,
    closed: false,
    answer: 'pose' as 'pose' | 'nothing' | 'never',
    stamps: [] as number[],
    detect(_video: HTMLVideoElement, ts: number): Promise<RawPose[] | null> {
      d.stamps.push(ts);
      if (d.answer === 'never') {
        d.busy = true;
        return new Promise(() => {});
      }
      return Promise.resolve(d.answer === 'pose' ? [POSE] : null);
    },
    close(): void {
      d.closed = true;
    },
  };
  return d;
}

function rig(opts: { frameCallback?: boolean; deps?: Partial<CameraSourceDeps>; source?: Partial<ConstructorParameters<typeof CameraPoseSource>[0]> } = {}) {
  const cam = fakeVideo(opts.frameCallback ?? true);
  const worker = fakeDetector('worker');
  const main = fakeDetector('main');
  const closedCameras: unknown[] = [];
  const animation = new Map<number, () => void>();
  const cancelledAnimation: number[] = [];
  let animationId = 100;
  let clock = 1000;
  let watching = 0;
  const problems: string[] = [];

  const deps: CameraSourceDeps = {
    openCamera: vi.fn(async () => cam.video),
    closeCamera: (v) => void closedCameras.push(v),
    watchCamera: () => {
      watching++;
      return () => void watching--;
    },
    loadModelBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    canUseWorker: () => true,
    createWorkerDetector: vi.fn(async () => worker as AsyncDetector),
    createMainDetector: vi.fn(async () => main as AsyncDetector),
    now: () => clock,
    requestFrame: (cb) => {
      animation.set(animationId, cb);
      return animationId++;
    },
    cancelFrame: (id) => {
      cancelledAnimation.push(id);
      animation.delete(id);
    },
    ...opts.deps,
  };
  const source = new CameraPoseSource({ model: 'full', onProblem: (kind) => problems.push(kind), ...opts.source, deps });
  const frames: RawFrame[] = [];
  source.onFrame((f) => frames.push(f));
  return {
    source,
    deps,
    cam,
    worker,
    main,
    frames,
    problems,
    closedCameras,
    cancelledAnimation,
    watching: () => watching,
    /** 把时钟往前拨 */
    tick: (ms: number): void => void (clock += ms),
    /** 屏幕刷新了一次（没有 requestVideoFrameCallback 时靠它轮询） */
    refresh(): void {
      const run = [...animation.values()];
      animation.clear();
      for (const cb of run) cb();
    },
  };
}

describe('CameraPoseSource: starting', () => {
  it('opens the camera and builds a detector in a Worker from the downloaded model', async () => {
    const r = rig();
    await r.source.start();
    expect(r.source.video).toBe(r.cam.video);
    expect(r.deps.createWorkerDetector).toHaveBeenCalledWith({ model: 'full', bytes: new Uint8Array([1, 2, 3]), numPoses: 1 });
    expect(r.deps.createMainDetector).not.toHaveBeenCalled();
    expect(r.source.stats()).toMatchObject({ thread: 'worker', delegate: 'GPU', model: 'full' });
    expect(r.watching()).toBe(1);
  });

  it('falls back to the main thread when a Worker cannot be used or will not start', async () => {
    const unsupported = rig({ deps: { canUseWorker: () => false } });
    await unsupported.source.start();
    expect(unsupported.source.stats().thread).toBe('main');
    expect(unsupported.deps.createWorkerDetector).not.toHaveBeenCalled();

    const broken = rig({ deps: { createWorkerDetector: vi.fn(async () => Promise.reject(new Error('worker script blocked'))) } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await broken.source.start();
    warn.mockRestore();
    expect(broken.source.stats().thread).toBe('main');
  });

  it('stays on the main thread when asked to', async () => {
    const r = rig({ source: { worker: false } });
    await r.source.start();
    expect(r.source.stats().thread).toBe('main');
    expect(r.deps.createWorkerDetector).not.toHaveBeenCalled();
  });

  it('can be told to look for two people', async () => {
    const r = rig({ source: { numPoses: 2 } });
    await r.source.start();
    expect(r.deps.createWorkerDetector).toHaveBeenCalledWith(expect.objectContaining({ numPoses: 2 }));
    expect(r.source.stats().people).toBe(2);
  });

  it('shuts the detector down again if the camera cannot be opened', async () => {
    const denied = new CameraError('摄像头没有获得许可', '…', 'denied');
    const r = rig({ deps: { openCamera: async () => Promise.reject(denied) } });
    await expect(r.source.start()).rejects.toBe(denied);
    expect(r.worker.closed).toBe(true);
    expect(r.source.video).toBeNull();
  });

  it('switches the camera off again if the detector cannot be built at all', async () => {
    const boom = new Error('no wasm');
    const r = rig({ deps: { canUseWorker: () => false, createMainDetector: async () => Promise.reject(boom) } });
    await expect(r.source.start()).rejects.toBe(boom);
    expect(r.closedCameras).toEqual([r.cam.video]);
  });

  it('reports download progress', async () => {
    const seen: [number, number][] = [];
    const r = rig({
      source: { onProgress: (loaded, total) => seen.push([loaded, total]) },
      deps: {
        loadModelBytes: async (_model, onProgress) => {
          onProgress?.(5, 10);
          onProgress?.(10, 10);
          return new Uint8Array(1);
        },
      },
    });
    await r.source.start();
    expect(seen).toEqual([[5, 10], [10, 10]]);
  });
});

describe('CameraPoseSource: frames', () => {
  it('recognises each new camera frame and passes the result on', async () => {
    const r = rig();
    await r.source.start();
    r.cam.frame();
    await flush();
    r.cam.frame();
    await flush();

    expect(r.frames).toHaveLength(2);
    expect(r.frames[0].poses).toEqual([POSE]);
    expect(r.frames[0].aspect).toBeCloseTo(1280 / 720);
    expect(r.frames[1].t).toBeGreaterThan(r.frames[0].t);
    expect(r.worker.stamps[1]).toBeGreaterThan(r.worker.stamps[0]);
    expect(r.source.stats().lastMs).toBe(12);
  });

  it('drops a frame, rather than queueing it, while the previous one is still being recognised', async () => {
    const r = rig();
    await r.source.start();
    r.worker.answer = 'never';
    r.cam.frame();
    await flush();
    r.cam.frame();
    r.cam.frame();
    await flush();
    expect(r.worker.stamps).toHaveLength(1);
    expect(r.frames).toHaveLength(0);
  });

  it('skips frames while the video is not ready', async () => {
    const r = rig();
    await r.source.start();
    (r.cam.video as unknown as { readyState: number }).readyState = 1;
    r.cam.frame();
    await flush();
    expect(r.worker.stamps).toHaveLength(0);
  });

  it('without requestVideoFrameCallback it polls on screen refresh and only recognises when the picture changed', async () => {
    const r = rig({ frameCallback: false });
    await r.source.start();
    const video = r.cam.video as unknown as { currentTime: number };
    video.currentTime = 0.5;
    r.refresh();
    await flush();
    r.refresh(); // 画面没变：不重复识别
    await flush();
    expect(r.worker.stamps).toHaveLength(1);
    video.currentTime = 0.533;
    r.refresh();
    await flush();
    expect(r.worker.stamps).toHaveLength(2);
  });

  it('tells the outside once when recognition keeps producing nothing', async () => {
    const r = rig();
    await r.source.start();
    r.worker.answer = 'nothing';
    for (let i = 0; i < 44; i++) {
      r.cam.frame();
      await flush();
    }
    expect(r.problems).toEqual([]);
    for (let i = 0; i < 30; i++) {
      r.cam.frame();
      await flush();
    }
    expect(r.problems).toEqual(['detect']);
    expect(r.frames).toHaveLength(0);
  });

  it('a result in between resets the count of failures', async () => {
    const r = rig();
    await r.source.start();
    for (let round = 0; round < 3; round++) {
      r.worker.answer = 'nothing';
      for (let i = 0; i < 30; i++) {
        r.cam.frame();
        await flush();
      }
      r.worker.answer = 'pose';
      r.cam.frame();
      await flush();
    }
    expect(r.problems).toEqual([]);
    expect(r.frames).toHaveLength(3);
  });
});

describe('CameraPoseSource: a recogniser that hangs', () => {
  /** 摄像头照常出帧，就这样过了 seconds 秒（每 200 毫秒来一帧）。 */
  const cameraRuns = (r: ReturnType<typeof rig>, seconds: number): void => {
    for (let t = 0; t < seconds * 1000; t += 200) {
      r.tick(200);
      r.cam.frame();
    }
  };

  it('once results have been flowing, a frame that gets no answer for several seconds is reported, once', async () => {
    // 识别器一直"忙"的话不会再收到新帧，也就不会有"连续失败"——得另外看它忙了多久
    const r = rig();
    await r.source.start();
    r.cam.frame();
    await flush();
    expect(r.frames).toHaveLength(1); // 头一帧有了结果：热身过了

    r.worker.answer = 'never';
    r.tick(33);
    r.cam.frame(); // 这一帧交出去，再也没有回音
    cameraRuns(r, 6);
    expect(r.problems).toEqual([]); // 才几秒：也许只是卡了一下
    cameraRuns(r, 3);
    expect(r.problems).toEqual(['detect']);
    cameraRuns(r, 20);
    expect(r.problems).toEqual(['detect']); // 只说一次
  });

  it('is far more patient with the very first frame, which the recogniser warms up on', async () => {
    // 头一次识别要编译着色器、分配内存，慢的电脑上要十几秒（无头浏览器里实测超过 5 秒）——那不是卡死
    const r = rig();
    await r.source.start();
    r.worker.answer = 'never';
    r.cam.frame();
    cameraRuns(r, 25);
    expect(r.problems).toEqual([]);
    cameraRuns(r, 10);
    expect(r.problems).toEqual(['detect']); // 可也不能无限等下去
  });

  it('a first frame that takes long but does come back is fine, and later frames are held to the stricter limit', async () => {
    const r = rig();
    await r.source.start();
    // 头一帧 20 秒才回来
    let answerFirst: (poses: RawPose[] | null) => void = () => {};
    r.worker.detect = (_video, ts) => {
      r.worker.stamps.push(ts);
      r.worker.busy = true;
      return new Promise((resolve) => {
        answerFirst = (poses) => {
          r.worker.busy = false;
          resolve(poses);
        };
      });
    };
    r.cam.frame();
    cameraRuns(r, 20);
    answerFirst([POSE]);
    await flush();
    expect(r.problems).toEqual([]);
    expect(r.frames).toHaveLength(1);

    // 之后的一帧没了回音：按平时的标准，几秒就报
    r.worker.detect = (_video, ts) => {
      r.worker.stamps.push(ts);
      r.worker.busy = true;
      return new Promise(() => {});
    };
    r.tick(33);
    r.cam.frame();
    cameraRuns(r, 9);
    expect(r.problems).toEqual(['detect']);
  });

  it('does not mistake a jump of the clock for a hang (the computer slept, or the tab sat in the background)', async () => {
    const r = rig();
    await r.source.start();
    r.cam.frame();
    await flush();
    r.worker.answer = 'never';
    r.tick(33);
    r.cam.frame(); // 交出去一帧……
    r.tick(3_600_000); // ……然后电脑睡了一个小时，这期间一帧画面也没有
    r.cam.frame(); // 醒来后的第一帧：识别器手里还是睡前的那一帧，这很正常
    expect(r.problems).toEqual([]);
    cameraRuns(r, 3);
    expect(r.problems).toEqual([]);
    cameraRuns(r, 6); // 醒着的时候又等了这么久还是没有回音：那才是真卡死了
    expect(r.problems).toEqual(['detect']);
  });

  it('a slow answer that does arrive is not a hang', async () => {
    const r = rig();
    await r.source.start();
    for (let i = 0; i < 5; i++) {
      r.tick(3000);
      r.cam.frame();
      await flush();
    }
    expect(r.problems).toEqual([]);
    expect(r.frames).toHaveLength(5);
  });

  it('starts counting afresh after a restart', async () => {
    // 停掉再启动，换了一个新的识别器：它又要热身，不能拿上一个的账来算
    const r = rig();
    await r.source.start();
    r.cam.frame();
    await flush();
    r.source.stop();
    await r.source.start();
    r.worker.answer = 'never';
    r.cam.frame();
    cameraRuns(r, 20);
    expect(r.problems).toEqual([]);
  });
});

describe('CameraPoseSource: stopping', () => {
  it('a stop that arrives while it is still starting is honoured as soon as the camera has opened', async () => {
    // 页面在"正在打开摄像头"的时候就离开了。摄像头稍后才打开：得马上关掉，不能就这么开着跑起来
    let opened!: (video: HTMLVideoElement) => void;
    const r = rig({ deps: { openCamera: () => new Promise<HTMLVideoElement>((resolve) => (opened = resolve)) } });
    const starting = r.source.start();
    r.source.stop();
    opened(r.cam.video);
    await starting;

    expect(r.closedCameras).toEqual([r.cam.video]);
    expect(r.worker.closed).toBe(true);
    expect(r.source.video).toBeNull();
    expect(r.watching()).toBe(0);
    r.cam.frame();
    await flush();
    expect(r.worker.stamps).toHaveLength(0);
    expect(r.frames).toHaveLength(0);
  });

  it('can be started again after such an interrupted start', async () => {
    let opened!: (video: HTMLVideoElement) => void;
    let first = true;
    const cam = fakeVideo();
    const r = rig({ deps: { openCamera: () => (first ? ((first = false), new Promise<HTMLVideoElement>((resolve) => (opened = resolve))) : Promise.resolve(cam.video)) } });
    const starting = r.source.start();
    r.source.stop();
    opened(r.cam.video);
    await starting;
    await r.source.start();
    expect(r.source.video).toBe(cam.video);
    cam.frame();
    await flush();
    expect(r.frames).toHaveLength(1);
  });

  it('cancels the pending video-frame callback with the video API, and closes camera and detector', async () => {
    const r = rig();
    await r.source.start();
    const pending = [...r.cam.waiting.keys()];
    expect(pending).toHaveLength(1);
    r.source.stop();

    expect(r.cam.cancelled).toEqual(pending);
    expect(r.cancelledAnimation).toEqual([]); // 两套编号不通用：不能拿视频回调的编号去取消屏幕刷新的回调
    expect(r.closedCameras).toEqual([r.cam.video]);
    expect(r.worker.closed).toBe(true);
    expect(r.watching()).toBe(0);
    expect(r.source.video).toBeNull();
  });

  it('cancels the screen-refresh callback when that is what it was using', async () => {
    const r = rig({ frameCallback: false });
    await r.source.start();
    r.source.stop();
    expect(r.cancelledAnimation).toHaveLength(1);
  });

  it('emits nothing after stop, even if a recognition was still in flight', async () => {
    const r = rig();
    await r.source.start();
    r.cam.frame(); // 识别已经发出去了
    r.source.stop();
    await flush();
    expect(r.frames).toHaveLength(0);
    r.cam.frame();
    await flush();
    expect(r.worker.stamps).toHaveLength(1);
  });

  it('an answer that belongs to a previous start is not passed on after a restart', async () => {
    // 停掉、马上又启动：上一个识别器还欠着一帧的答案。它回来的时候不能混进新的那一轮里
    const first = fakeDetector('worker');
    const second = fakeDetector('worker');
    const made = [first, second];
    const r = rig({ deps: { createWorkerDetector: vi.fn(async () => made.shift() as AsyncDetector) } });
    await r.source.start();
    let answerLate: (poses: RawPose[] | null) => void = () => {};
    first.detect = () => new Promise((resolve) => (answerLate = resolve));
    r.cam.frame();
    r.source.stop();
    await r.source.start();

    answerLate([POSE]);
    await flush();
    expect(r.frames).toEqual([]);
  });

  it('start twice is one start; stop before start is harmless', async () => {
    const r = rig();
    r.source.stop();
    await r.source.start();
    await r.source.start();
    expect(r.deps.openCamera).toHaveBeenCalledTimes(1);
  });
});
