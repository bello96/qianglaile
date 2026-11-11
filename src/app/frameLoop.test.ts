import { describe, expect, it, vi } from 'vitest';
import { startFrameLoop } from './frameLoop';

/** 假的屏幕刷新：排上的回调先存着，由测试一帧一帧地放。 */
function fakeScreen() {
  let nextId = 1;
  const queued = new Map<number, (now: number) => void>();
  return {
    raf(cb: (now: number) => void): number {
      queued.set(nextId, cb);
      return nextId++;
    },
    caf(id: number): void {
      queued.delete(id);
    },
    /** 放一帧：把排着的回调都叫一遍（它们新排上的要等下一帧） */
    paint(now: number): void {
      const due = [...queued.values()];
      queued.clear();
      for (const cb of due) cb(now);
    },
    get waiting(): number {
      return queued.size;
    },
  };
}

describe('startFrameLoop', () => {
  it('calls the frame function once per painted frame, with that frame’s time', () => {
    const screen = fakeScreen();
    const seen: number[] = [];
    startFrameLoop((now) => seen.push(now), vi.fn(), screen);
    expect(seen).toEqual([]); // 排上了，还没到下一帧
    screen.paint(16);
    screen.paint(33);
    screen.paint(50);
    expect(seen).toEqual([16, 33, 50]);
  });

  it('stops when told to', () => {
    const screen = fakeScreen();
    const frame = vi.fn();
    const stop = startFrameLoop(frame, vi.fn(), screen);
    screen.paint(16);
    stop();
    screen.paint(33);
    screen.paint(50);
    expect(frame).toHaveBeenCalledTimes(1);
    expect(screen.waiting).toBe(0);
  });

  it('a frame that throws ends the loop and hands the error over, once', () => {
    const screen = fakeScreen();
    const boom = new Error('boom');
    const onError = vi.fn();
    let calls = 0;
    startFrameLoop(
      () => {
        if (++calls === 2) throw boom;
      },
      onError,
      screen,
    );
    for (const t of [16, 33, 50, 66, 83]) screen.paint(t);

    // 不这样的话，同一个错每秒会抛六十次，画面僵在那儿，页面却不知道出事了
    expect(calls).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
    expect(screen.waiting).toBe(0);
  });

  it('stopping after it has already ended is harmless', () => {
    const screen = fakeScreen();
    const onError = vi.fn();
    const stop = startFrameLoop(
      () => {
        throw new Error('boom');
      },
      onError,
      screen,
    );
    screen.paint(16);
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a frame may stop its own loop', () => {
    const screen = fakeScreen();
    let calls = 0;
    const stop = startFrameLoop(
      () => {
        calls++;
        stop();
      },
      vi.fn(),
      screen,
    );
    screen.paint(16);
    screen.paint(33);
    expect(calls).toBe(1);
    expect(screen.waiting).toBe(0);
  });
});
