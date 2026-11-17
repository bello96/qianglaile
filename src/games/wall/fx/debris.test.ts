import { describe, expect, it } from 'vitest';
import { createRng } from '../../../engine/util/rng';
import { DebrisSim, type DebrisEnv } from './debris';
import type { Tile } from './tiles';

const ENV: DebrisEnv = { deckHalfW: 1.8, deckHalfD: 0.85, waterY: -0.9 };

/** 一面 4.2 × 3 米的墙切成的砖（中间不挖洞，够用了）。 */
function bricks(): Tile[] {
  const out: Tile[] = [];
  for (let y = 0.15; y < 3; y += 0.3) for (let x = -1.92; x < 2.1; x += 0.36) out.push({ x, y, w: 0.36, h: 0.3 });
  return out;
}

function shattered(capacity = 400, z = 0.7): DebrisSim {
  const sim = new DebrisSim(ENV, capacity);
  sim.shatter(bricks(), z, 0.24, 0xff5d4a, { x: 0, y: 1.2, power: 4, forward: 1.2 }, createRng(3).next);
  return sim;
}
const run = (sim: DebrisSim, sec: number, dt = 1 / 60): { x: number; z: number; speed: number }[] => {
  const splashes = [];
  for (let t = 0; t < sec; t += dt) splashes.push(...sim.step(dt));
  return splashes;
};
const speedOf = (c: { vx: number; vy: number; vz: number }): number => Math.hypot(c.vx, c.vy, c.vz);

describe('DebrisSim (the wall breaking into foam blocks)', () => {
  it('starts as the wall: one block per brick, where the brick was', () => {
    const sim = shattered();
    expect(sim.chunks).toHaveLength(bricks().length);
    expect(sim.chunks.every((c) => c.state === 'air' && c.z === 0.7)).toBe(true);
    expect(sim.chunks[0]).toMatchObject({ x: -1.92, y: 0.15 });
    expect(sim.chunks[0].sx).toBeLessThanOrEqual(0.36);
  });

  it('blows outwards from the centre of the blast', () => {
    const sim = shattered();
    for (const c of sim.chunks) {
      if (c.x > 0.6) expect(c.vx).toBeGreaterThan(0);
      if (c.x < -0.6) expect(c.vx).toBeLessThan(0);
    }
  });

  it('after a few seconds every block has either come to rest on the deck or is floating in the water', () => {
    const sim = shattered();
    run(sim, 4.5);
    expect(sim.chunks.length).toBeGreaterThan(50);
    for (const c of sim.chunks) {
      if (c.state === 'deck') {
        expect(speedOf(c)).toBeLessThan(0.3);
        expect(Math.abs(c.x)).toBeLessThanOrEqual(ENV.deckHalfW + 1e-6);
        expect(c.y).toBeGreaterThan(0);
      } else {
        expect(c.state).toBe('water');
        expect(Math.abs(c.y - ENV.waterY)).toBeLessThan(0.3);
      }
    }
    expect(sim.chunks.some((c) => c.state === 'deck')).toBe(true);
    expect(sim.chunks.some((c) => c.state === 'water')).toBe(true);
  });

  it('nothing flies off to infinity, sinks out of sight, or turns into NaN', () => {
    for (const dt of [1 / 60, 1 / 20, 0.1]) {
      const sim = shattered();
      for (let t = 0; t < 5; t += dt) {
        sim.step(dt);
        for (const c of sim.chunks) {
          for (const v of [c.x, c.y, c.z, c.vx, c.vy, c.vz, c.rx, c.ry, c.rz]) expect(Number.isFinite(v)).toBe(true);
          expect(Math.abs(c.x)).toBeLessThan(30);
          expect(Math.abs(c.z)).toBeLessThan(30);
          expect(c.y).toBeGreaterThan(ENV.waterY - 1);
          expect(c.y).toBeLessThan(12);
        }
      }
    }
  });

  it('reports each splash once, where it happened', () => {
    const sim = shattered();
    const splashes = run(sim, 3);
    const wet = sim.chunks.filter((c) => c.state === 'water').length;
    expect(splashes).toHaveLength(wet);
    for (const s of splashes) {
      expect(s.speed).toBeGreaterThan(0);
      // 台子正下方不会有水花：要么在台子外面
      expect(Math.abs(s.x) > ENV.deckHalfW || Math.abs(s.z) > ENV.deckHalfD).toBe(true);
    }
  });

  it('blocks fade away when their time is up', () => {
    const sim = shattered();
    run(sim, 9);
    expect(sim.chunks).toHaveLength(0);
  });

  it('never holds more than its capacity: the oldest go first', () => {
    const sim = shattered(60);
    expect(sim.chunks).toHaveLength(60);
    const more = bricks().slice(0, 30);
    sim.shatter(more, 0.2, 0.24, 0x3ddc97, { x: 0, y: 1.2, power: 3 }, createRng(4).next);
    expect(sim.chunks).toHaveLength(60);
    // 新来的 30 块都在（排在最后），被挤掉的是最老的
    expect(sim.chunks.slice(-30).map((c) => [c.x, c.y, c.z])).toEqual(more.map((t) => [t.x, t.y, 0.2]));
  });

  it('a block resting near the edge that gets nudged off falls into the water', () => {
    const sim = new DebrisSim(ENV, 10);
    sim.shatter([{ x: 1.7, y: 0.4, w: 0.3, h: 0.3 }], 0, 0.24, 1, { x: 0, y: 0.4, power: 0 }, () => 0.5);
    run(sim, 1.5);
    expect(sim.chunks[0].state).toBe('deck');
    sim.chunks[0].vx = 2.5;
    run(sim, 2);
    expect(sim.chunks[0].state).toBe('water');
  });
});
