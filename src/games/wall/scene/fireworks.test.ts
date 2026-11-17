import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { Fireworks } from './fireworks';

const scaleOf = (f: Fireworks): number => (f.points.material as THREE.ShaderMaterial).uniforms.uScale.value as number;

describe('Fireworks', () => {
  it('sizes its sparks in real pixels: on a high-density screen they are drawn with proportionally more pixels', () => {
    // 点精灵的大小是按"设备像素"算的。屏幕缩放 2 倍时不跟着放大，烟花看起来就只有一半大
    const f = new Fireworks(100, 1);
    f.resize(720);
    const plain = scaleOf(f);
    f.resize(720, 2);
    expect(scaleOf(f)).toBeCloseTo(plain * 2, 6);
    f.resize(1080, 1.5);
    expect(scaleOf(f)).toBeCloseTo(plain * 1.5 * 1.5, 6);
  });

  it('a rocket goes up, bursts into sparks, and it all dies out', () => {
    const f = new Fireworks(2400, 1);
    f.launch(0, -20, 8, 0.1);
    let bursts = 0;
    let peak = 0;
    for (let t = 0; t < 8; t += 1 / 60) {
      bursts += f.update(1 / 60);
      peak = Math.max(peak, f.alive);
    }
    expect(bursts).toBe(1);
    expect(peak).toBeGreaterThan(100);
    expect(f.alive).toBe(0);
  });

  it('never holds more sparks than its capacity', () => {
    const f = new Fireworks(150, 1);
    for (let i = 0; i < 6; i++) f.launch(i, -20, 6, 0.3);
    for (let t = 0; t < 5; t += 1 / 60) {
      f.update(1 / 60);
      expect(f.alive).toBeLessThanOrEqual(150);
    }
  });
});
