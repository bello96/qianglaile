import { describe, expect, it } from 'vitest';
import { BubbleGame, type Hand } from './logic';

const FRAME = 1 / 60;
const step = (g: BubbleGame, seconds: number, hands: Hand[] = []): void => {
  for (let i = 0; i < Math.round(seconds * 60); i++) g.update(FRAME, hands);
};

describe('BubbleGame', () => {
  it('spawns a bubble about every 0.6 seconds', () => {
    const g = new BubbleGame(1);
    const seen = new Set<number>();
    for (let i = 0; i < 600; i++) {
      g.update(FRAME, []);
      for (const b of g.state.bubbles) seen.add(b.id);
    }
    expect(seen.size).toBeGreaterThanOrEqual(15);
    expect(seen.size).toBeLessThanOrEqual(18);
  });

  it('bubbles come in below the bottom edge, inside the picture sideways, and float up', () => {
    const g = new BubbleGame(1);
    step(g, 0.62);
    const [b] = g.state.bubbles;
    expect(b.y).toBeGreaterThan(1);
    expect(b.x - b.r).toBeGreaterThanOrEqual(0);
    expect(b.x + b.r).toBeLessThanOrEqual(1);
    const before = b.y;
    step(g, 1);
    expect(g.state.bubbles[0].id).toBe(b.id);
    expect(g.state.bubbles[0].y).toBeLessThan(before - 0.1);
  });

  it('a hand touching a bubble pops it: reported, scored, gone', () => {
    const g = new BubbleGame(1);
    step(g, 2);
    const target = g.state.bubbles[0];
    const { popped } = g.update(FRAME, [{ x: target.x, y: target.y, r: 0.05 }]);
    expect(popped.map((b) => b.id)).toEqual([target.id]);
    expect(g.state.score).toBe(1);
    expect(g.state.bubbles.some((b) => b.id === target.id)).toBe(false);
  });

  it('measures the distance in true proportions, not stretched by the wide picture', () => {
    // 画面是 16:9 的：横向 0.06 个"画面宽"其实是 0.107 个"画面高"
    const aspect = 16 / 9;
    const make = (): { g: BubbleGame; b: { x: number; y: number; r: number } } => {
      const g = new BubbleGame(5, 45, aspect);
      step(g, 2);
      return { g, b: { ...g.state.bubbles[0] } };
    };
    const hand = 0.03;

    const near = make();
    const justInside = (near.b.r + hand - 0.012) / aspect;
    expect(near.g.update(FRAME, [{ x: near.b.x + justInside, y: near.b.y, r: hand }]).popped).toHaveLength(1);

    const far = make();
    const justOutside = (far.b.r + hand + 0.012) / aspect;
    expect(far.g.update(FRAME, [{ x: far.b.x + justOutside, y: far.b.y, r: hand }]).popped).toHaveLength(0);
    expect(far.g.state.score).toBe(0);
  });

  it('without hands nothing pops', () => {
    const g = new BubbleGame(1);
    step(g, 20);
    expect(g.state.score).toBe(0);
  });

  it('two hands on the same bubble count once; one sweep can pop several', () => {
    const g = new BubbleGame(1);
    step(g, 2);
    const t = g.state.bubbles[0];
    const twice = g.update(FRAME, [
      { x: t.x, y: t.y, r: 0.05 },
      { x: t.x, y: t.y, r: 0.05 },
    ]);
    expect(twice.popped).toHaveLength(1);
    expect(g.state.score).toBe(1);

    step(g, 3);
    const many = g.state.bubbles.length;
    expect(many).toBeGreaterThan(2);
    const sweep = g.update(FRAME, [{ x: 0.5, y: 0.5, r: 5 }]);
    expect(sweep.popped).toHaveLength(many);
    expect(g.state.score).toBe(1 + many);
    expect(g.state.bubbles).toHaveLength(0);
  });

  it('removes bubbles that float out of the top', () => {
    const g = new BubbleGame(1);
    step(g, 1);
    const first = g.state.bubbles[0].id;
    step(g, 14);
    expect(g.state.bubbles.some((b) => b.id === first)).toBe(false);
    for (const b of g.state.bubbles) expect(b.y + b.r).toBeGreaterThanOrEqual(0);
    expect(g.state.bubbles.length).toBeLessThan(20);
  });

  it('counts down, ends after the set time, and then nothing changes any more', () => {
    const g = new BubbleGame(1, 45);
    expect(g.state.timeLeft).toBe(45);
    step(g, 44.5);
    expect(g.state.over).toBe(false);
    expect(g.state.timeLeft).toBeCloseTo(0.5, 1);
    step(g, 1);
    expect(g.state.over).toBe(true);
    expect(g.state.timeLeft).toBe(0);

    const frozen = JSON.stringify(g.state);
    const after = g.update(FRAME, [{ x: 0.5, y: 0.5, r: 5 }]);
    expect(after.popped).toEqual([]);
    expect(JSON.stringify(g.state)).toBe(frozen);
  });

  it('plays the same with the same seed and differently with another', () => {
    const run = (seed: number): string => {
      const g = new BubbleGame(seed);
      step(g, 8);
      return JSON.stringify(g.state.bubbles);
    };
    expect(run(3)).toBe(run(3));
    expect(run(3)).not.toBe(run(4));
  });

  it('a long gap between frames does not fast-forward the game', () => {
    // 标签页切到后台再回来，两帧之间可能隔了好几十秒
    const g = new BubbleGame(1);
    g.update(30, []);
    expect(g.state.timeLeft).toBeGreaterThan(44);
    expect(g.state.over).toBe(false);
    expect(g.state.bubbles.length).toBeLessThanOrEqual(1);
  });

  it('ignores nonsense time steps', () => {
    const g = new BubbleGame(1);
    g.update(-5, []);
    g.update(Number.NaN, []);
    expect(g.state.timeLeft).toBe(45);
    expect(g.state.bubbles).toHaveLength(0);
  });
});
