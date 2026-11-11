import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraError, mapCameraError, openCamera } from './camera';

describe('mapCameraError', () => {
  it('recognises a denied permission', () => {
    expect(mapCameraError({ name: 'NotAllowedError' }).code).toBe('denied');
    expect(mapCameraError({ name: 'SecurityError' }).code).toBe('denied');
  });

  it('recognises a missing camera', () => {
    expect(mapCameraError({ name: 'NotFoundError' }).code).toBe('notfound');
    expect(mapCameraError({ name: 'OverconstrainedError' }).code).toBe('notfound');
  });

  it('recognises a camera that another program is holding', () => {
    expect(mapCameraError({ name: 'NotReadableError' }).code).toBe('busy');
    expect(mapCameraError({ name: 'AbortError' }).code).toBe('busy');
  });

  it('falls back to unknown and keeps the original message', () => {
    const e = mapCameraError(new Error('boom'));
    expect(e.code).toBe('unknown');
    expect(e.hint).toContain('boom');
    expect(mapCameraError('weird').code).toBe('unknown');
    expect(mapCameraError(null).code).toBe('unknown');
  });

  it('always gives a title and a way out, in Chinese', () => {
    for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'Whatever']) {
      const e = mapCameraError({ name });
      expect(e).toBeInstanceOf(CameraError);
      expect(e.title, name).toMatch(/[一-鿿]/);
      expect(e.hint.length, name).toBeGreaterThan(4);
      expect(e.message).toBe(e.title);
    }
  });

  it('passes an existing CameraError through untouched', () => {
    const original = new CameraError('标题', '提示', 'unsupported');
    expect(mapCameraError(original)).toBe(original);
  });
});

describe('openCamera', () => {
  /** 假的浏览器环境：一个摄像头、一个 <video>。 */
  const fakeBrowser = (opts: { playFails?: boolean; neverShowsPicture?: boolean } = {}) => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    const video = {
      muted: false,
      playsInline: false,
      srcObject: null as unknown,
      videoWidth: opts.neverShowsPicture ? 0 : 1280,
      play: () => (opts.playFails ? Promise.reject(new Error('play() was interrupted')) : Promise.resolve()),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
    vi.stubGlobal('document', { createElement: () => video });
    return { track, video };
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('hands back a playing video wired to the camera', async () => {
    const { video, track } = fakeBrowser();
    expect(await openCamera()).toBe(video);
    expect(video.srcObject).not.toBeNull();
    expect(video.muted).toBe(true);
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('switches the camera off again when the video cannot start', async () => {
    // 摄像头已经打开了（指示灯亮了），只是画面没放起来：不关掉的话灯会一直亮着
    const { track } = fakeBrowser({ playFails: true });
    const err = await openCamera().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('gives up, and switches the camera off, when no picture ever arrives', async () => {
    vi.useFakeTimers();
    const { track } = fakeBrowser({ neverShowsPicture: true });
    const pending = openCamera().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20000);
    expect(await pending).toBeInstanceOf(CameraError);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('says so when the browser has no camera support at all', async () => {
    vi.stubGlobal('navigator', {});
    const err = await openCamera().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect((err as CameraError).code).toBe('unsupported');
  });
});
