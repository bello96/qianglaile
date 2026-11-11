import { useCallback, useState } from 'react';

/** "屏幕每刷新一次叫我一下"。平时就是浏览器的 requestAnimationFrame；测试里换成手动放帧的假屏幕。 */
export interface Screen {
  raf(cb: (now: number) => void): number;
  caf(id: number): void;
}

const REAL: Screen = {
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
};

/**
 * 开一个"每帧调用一次 frame"的循环，返回停掉它的函数。
 *
 * 和自己写 requestAnimationFrame 的区别只有一条：frame 里抛了错，循环**就此停下**，并把错误交给 onError。
 * 自己写的循环一般先排下一帧、再干活，于是同一个错每秒抛六十次：控制台刷屏，画面僵在那儿，
 * 而页面（React）根本不知道出事了——它只接得住渲染时抛的错，接不住这种回调里的。
 */
export function startFrameLoop(frame: (now: number) => void, onError: (err: unknown) => void, screen: Screen = REAL): () => void {
  let id = 0;
  let running = true;
  const stop = (): void => {
    running = false;
    screen.caf(id);
  };
  const tick = (now: number): void => {
    if (!running) return;
    try {
      frame(now);
    } catch (err) {
      stop();
      onError(err);
      return;
    }
    // frame 里可能已经把循环停了
    if (running) id = screen.raf(tick);
  };
  id = screen.raf(tick);
  return stop;
}

/**
 * 把"React 管不到的地方"（每帧循环、定时器、事件回调）出的错，送到最近的出错兜底（ErrorBoundary）那里：
 * 先存进状态，下一次渲染时再抛出来。返回的函数就是"报错"用的，交给 startFrameLoop 的 onError 正合适。
 */
export function useCrash(): (err: unknown) => void {
  const [crash, setCrash] = useState<{ err: unknown } | null>(null);
  if (crash) throw crash.err;
  return useCallback((err: unknown) => setCrash({ err }), []);
}
