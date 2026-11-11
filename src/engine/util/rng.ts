/**
 * 带种子的伪随机数。同一个种子永远给出同一串数字——
 * 关卡出墙顺序靠它可复现，模拟玩家的噪声靠它让测试稳定。
 */
export interface Rng {
  /** [0, 1) */
  next(): number;
  /** 闭区间 [lo, hi] 上的整数 */
  int(lo: number, hi: number): number;
  pick<T>(xs: readonly T[]): T;
  /** 返回新数组，不改原数组 */
  shuffle<T>(xs: readonly T[]): T[];
  chance(p: number): boolean;
  /** 标准正态分布 N(0, 1) */
  gauss(): number;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  // mulberry32
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  return {
    next,
    int,
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    shuffle: (xs) => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    chance: (p) => next() < p,
    gauss: () => {
      // Box–Muller；1 - next() 保证不取到 log(0)
      const u = 1 - next();
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}
