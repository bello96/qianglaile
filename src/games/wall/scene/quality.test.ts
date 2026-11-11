import { describe, expect, it } from 'vitest';
import { AutoQuality } from './quality';

/** 假的浏览器存储 */
function memory(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k: string): string | null => map.get(k) ?? null,
    setItem: (k: string, v: string): void => void map.set(k, v),
    dump: (): Record<string, string> => Object.fromEntries(map),
  };
}

// 识别端的三种情况：显卡 + 标准模型（电脑够用）、显卡 + 轻量模型、只能靠 CPU
const STRONG = { model: 'full', delegate: 'GPU' };
const LITE = { model: 'lite', delegate: 'GPU' };
const NO_GPU = { model: 'full', delegate: 'CPU' };

describe('AutoQuality', () => {
  it('does what the player chose when the setting is not automatic', () => {
    const q = new AutoQuality(memory());
    expect(q.pick('low', STRONG)).toBe('low');
    expect(q.pick('high', NO_GPU)).toBe('high');
  });

  it('automatic: low when recognition needs the light model or has to run on the CPU, high otherwise', () => {
    expect(new AutoQuality(memory()).pick('auto', STRONG)).toBe('high');
    expect(new AutoQuality(memory()).pick('auto', LITE)).toBe('low');
    expect(new AutoQuality(memory()).pick('auto', NO_GPU)).toBe('low');
  });

  it('automatic: high until something is known about this machine', () => {
    const q = new AutoQuality(memory());
    expect(q.pick('auto', null)).toBe('high');
    // 识别器还没建好时没有"用的是显卡还是 CPU"可言：不能当成"不是 CPU，所以够强"
    expect(q.pick('auto', { model: 'lite', delegate: '-' })).toBe('high');
  });

  it('keeps its decision while the engine reloads, instead of flipping back to high', () => {
    // 引擎重启的那几秒里拿不到识别端的状态。这时要是退回"高"，3D 场景会白白重建两次（高 → 低）
    const q = new AutoQuality(memory());
    expect(q.pick('auto', NO_GPU)).toBe('low');
    expect(q.pick('auto', null)).toBe('low');
    expect(q.pick('auto', undefined)).toBe('low');
    expect(q.pick('auto', NO_GPU)).toBe('low');
  });

  it('starts from what it decided on the last visit', () => {
    const store = memory();
    expect(new AutoQuality(store).pick('auto', LITE)).toBe('low');
    // 下次打开页面：摄像头还没起来，就已经知道这台电脑用低画质（首页的演示也用得上）
    expect(new AutoQuality(store).pick('auto', null)).toBe('low');
  });

  it('changes its mind when the machine turns out differently this time', () => {
    const store = memory();
    new AutoQuality(store).pick('auto', NO_GPU);
    const q = new AutoQuality(store);
    expect(q.pick('auto', null)).toBe('low');
    expect(q.pick('auto', STRONG)).toBe('high');
    expect(new AutoQuality(store).pick('auto', null)).toBe('high');
  });

  it('keeps learning while the player has a fixed quality selected', () => {
    // 选着"高"的时候照样记下这台电脑的情况：之后改回"自动"，马上就是对的，不用等引擎重启
    const q = new AutoQuality(memory());
    expect(q.pick('high', NO_GPU)).toBe('high');
    expect(q.pick('auto', null)).toBe('low');
  });

  it('ignores junk in storage', () => {
    for (const junk of ['medium', '', '{"q":"low"}', 'LOW']) {
      expect(new AutoQuality(memory({ 'mw.autoQuality': junk })).pick('auto', null)).toBe('high');
    }
  });

  it('works without storage, and with storage that throws', () => {
    expect(new AutoQuality(null).pick('auto', LITE)).toBe('low');
    const hostile = {
      getItem: (): string | null => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: (): void => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    };
    const q = new AutoQuality(hostile);
    expect(q.pick('auto', null)).toBe('high');
    expect(q.pick('auto', NO_GPU)).toBe('low');
    expect(q.pick('auto', null)).toBe('low');
  });

  it('only writes to storage when the decision changes', () => {
    const writes: string[] = [];
    const store = { getItem: (): string | null => null, setItem: (_k: string, v: string): void => void writes.push(v) };
    const q = new AutoQuality(store);
    for (let i = 0; i < 5; i++) q.pick('auto', NO_GPU); // 每次渲染都会问一遍
    q.pick('auto', STRONG);
    expect(writes).toEqual(['low', 'high']);
  });
});
