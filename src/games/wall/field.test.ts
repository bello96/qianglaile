import { describe, expect, it } from 'vitest';
import { poseToSkeleton } from '../../engine/body/pose';
import { defaultProfile } from '../../engine/body/profile';
import { sdBox, sdCapsule, sdCircle, union } from '../../engine/util/sdf';
import { skeletonCapsules, type Capsule } from './bodyShape';
import { buildField, capsulesHole, sampleField, WALL_BOUNDS } from './field';
import { getPose } from './poses';

const cap = (ax: number, ay: number, bx: number, by: number, r: number): Capsule => ({ id: 'torso', ax, ay, bx, by, r, ok: true });

describe('capsulesHole', () => {
  it('is the union of the capsules, inflated by the margin', () => {
    const hole = capsulesHole([cap(0, 0.5, 0, 1.5, 0.05), cap(1, 1, 1, 1, 0.1)], 0.1);
    expect(hole(0, 1)).toBeCloseTo(-0.15);
    expect(hole(0.15, 1)).toBeCloseTo(0);
    expect(hole(1.2, 1)).toBeCloseTo(0);
    expect(hole(0.5, 1)).toBeGreaterThan(0);
  });
});

describe('buildField', () => {
  it('covers the wall rectangle on a fine grid', () => {
    const f = buildField(sdCircle(0, 1.5, 0.5));
    expect(f.bounds).toEqual(WALL_BOUNDS);
    expect(f.cell).toBeCloseTo(0.025);
    expect(f.data).toHaveLength(f.nx * f.ny);
    expect(f.nx).toBeGreaterThan(160);
    expect(f.ny).toBeGreaterThan(115);
  });

  it('is negative in the hole, positive in the wall, about zero on the edge', () => {
    const f = buildField(sdCapsule(0, 0.5, 0, 1.5, 0.2));
    expect(sampleField(f, 0, 1)).toBeLessThan(-0.15);
    expect(sampleField(f, 1.5, 1.5)).toBeGreaterThan(0.5);
    expect(Math.abs(sampleField(f, 0.2, 1))).toBeLessThan(0.03);
    expect(Math.abs(sampleField(f, -0.2, 1))).toBeLessThan(0.03);
  });

  it('reports depth inside the wall as the distance to the nearest edge', () => {
    const f = buildField(sdCircle(0, 1.5, 0.5));
    expect(sampleField(f, 0.7, 1.5)).toBeCloseTo(0.2, 1); // 离洞边 0.2
    expect(sampleField(f, 2.0, 1.5)).toBeCloseTo(0.1, 1); // 离墙的右边 0.1，比离洞近
  });

  it('is not solid outside the wall rectangle', () => {
    const f = buildField(sdCircle(0, 1.5, 0.5));
    expect(sampleField(f, 2.13, 1)).toBeLessThan(0);
    expect(sampleField(f, 0, 3.03)).toBeLessThan(0);
    expect(sampleField(f, 3, 1)).toBe(-1);
    expect(sampleField(f, 0, 3.5)).toBe(-1);
    expect(sampleField(f, 0, -0.5)).toBe(-1);
  });

  it('keeps a window that floats in the middle of the wall', () => {
    const f = buildField(sdCircle(0, 1.5, 0.5));
    expect(sampleField(f, 0, 1.5)).toBeLessThan(0);
    expect(sampleField(f, 0, 0.5)).toBeGreaterThan(0); // 窗下面的墙还在，它连着两边
  });

  it('opens a doorway all the way to the floor', () => {
    const f = buildField(sdBox(0, 0.8, 0.4, 1.1));
    expect(sampleField(f, 0, 0.02)).toBeLessThan(0);
    expect(sampleField(f, 0, 1.5)).toBeLessThan(0);
    expect(sampleField(f, 1, 0.02)).toBeGreaterThan(0);
  });
});

describe('connectivity fix: wall material must hang from the top or the sides', () => {
  it('removes the wedge between spread legs', () => {
    const legs = union(sdCapsule(0, 0.85, 0.4, 0.05, 0.18), sdCapsule(0, 0.85, -0.4, 0.05, 0.18));
    expect(legs(0, 0.3)).toBeGreaterThan(0.03); // 原始形状里，两腿之间是实心的
    const f = buildField(legs);
    expect(sampleField(f, 0, 0.3)).toBeLessThan(0);
    expect(sampleField(f, 0, 0.1)).toBeLessThan(0);
    expect(sampleField(f, 1.0, 0.3)).toBeGreaterThan(0); // 腿外侧的墙连着墙边，保留
  });

  it('removes the island enclosed by a hand-on-hip arm', () => {
    const akimbo = union(sdCapsule(0, 0.9, 0, 1.4, 0.15), sdCapsule(0.2, 1.4, 0.5, 1.15, 0.08), sdCapsule(0.5, 1.15, 0.2, 0.9, 0.08));
    expect(akimbo(0.3, 1.15)).toBeGreaterThan(0.02);
    const f = buildField(akimbo);
    expect(sampleField(f, 0.3, 1.15)).toBeLessThan(0);
    expect(sampleField(f, 0.9, 1.15)).toBeGreaterThan(0);
  });

  it('leaves every real pose with a single connected wall', () => {
    const profile = defaultProfile();
    for (const id of ['star', 'hips', 'teapot', 'tree', 'lunge']) {
      const caps = skeletonCapsules(poseToSkeleton(getPose(id)!, profile), profile);
      const f = buildField(capsulesHole(caps, 0.1));
      // 从左上角出发做洪水填充，应当能到达所有实心格子
      const seen = new Uint8Array(f.nx * f.ny);
      const start = f.nx * (f.ny - 4) + 4;
      expect(f.data[start], id).toBeGreaterThan(0);
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const k = stack.pop()!;
        const i = k % f.nx;
        const j = (k - i) / f.nx;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= f.nx || nj >= f.ny) continue;
          const nk = nj * f.nx + ni;
          if (seen[nk] || !(f.data[nk] > 0)) continue;
          seen[nk] = 1;
          stack.push(nk);
        }
      }
      let orphans = 0;
      for (let k = 0; k < f.data.length; k++) if (f.data[k] > 0 && !seen[k]) orphans++;
      expect(orphans, id).toBe(0);
    }
  });
});
