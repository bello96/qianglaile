import { describe, expect, it } from 'vitest';
import { poseToSkeleton } from '../../engine/body/pose';
import { defaultProfile } from '../../engine/body/profile';
import { polygonArea, type Vec2 } from '../../engine/util/math';
import { sdBox, sdCircle, union } from '../../engine/util/sdf';
import { skeletonCapsules } from './bodyShape';
import { holeEdges, wallOutlines } from './contour';
import { buildField, capsulesHole } from './field';
import { getPose } from './poses';

const WALL_AREA = 4.2 * 3.0;
const profile = defaultProfile();
const poseField = (id: string) => buildField(capsulesHole(skeletonCapsules(poseToSkeleton(getPose(id)!, profile), profile), 0.1));

/** 两条线段是否相交（严格相交，共享端点不算）。 */
function crosses(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function selfIntersects(loop: Vec2[]): boolean {
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // 首尾相邻
      if (crosses(loop[i], loop[(i + 1) % n], loop[j], loop[(j + 1) % n])) return true;
    }
  }
  return false;
}

describe('wallOutlines', () => {
  it('a wall with no hole is one plain rectangle', () => {
    const out = wallOutlines(buildField(() => 1));
    expect(out).toHaveLength(1);
    expect(out[0].holes).toHaveLength(0);
    expect(polygonArea(out[0].outer)).toBeCloseTo(WALL_AREA, 1);
    expect(out[0].outer.length).toBeLessThan(12);
  });

  it('a floating round window becomes an inner hole', () => {
    const out = wallOutlines(buildField(sdCircle(0, 1.5, 0.5)));
    expect(out).toHaveLength(1);
    const { outer, holes } = out[0];
    expect(polygonArea(outer)).toBeGreaterThan(WALL_AREA * 0.98); // 外圈逆时针 → 面积为正
    expect(polygonArea(outer)).toBeLessThan(WALL_AREA * 1.02);
    expect(holes).toHaveLength(1);
    const a = polygonArea(holes[0]); // 内孔顺时针 → 面积为负
    expect(a).toBeLessThan(-Math.PI * 0.25 * 0.95);
    expect(a).toBeGreaterThan(-Math.PI * 0.25 * 1.05);
  });

  it('a doorway notches the outline instead of making an inner hole', () => {
    const out = wallOutlines(buildField(sdBox(0, 0.65, 0.4, 1.25)));
    expect(out).toHaveLength(1);
    expect(out[0].holes).toHaveLength(0);
    const want = WALL_AREA - 0.8 * 1.9;
    expect(polygonArea(out[0].outer)).toBeGreaterThan(want * 0.97);
    expect(polygonArea(out[0].outer)).toBeLessThan(want * 1.03);
  });

  it('handles a doorway and a window together', () => {
    const out = wallOutlines(buildField(union(sdBox(-1, 0.65, 0.3, 1.25), sdCircle(1, 2, 0.4))));
    expect(out).toHaveLength(1);
    expect(out[0].holes).toHaveLength(1);
  });

  it('gives clean loops: few points, no repeats, no self-intersection', () => {
    for (const id of ['t', 'star', 'hips', 'tree', 'low']) {
      const out = wallOutlines(poseField(id));
      expect(out, id).toHaveLength(1);
      expect(out[0].holes, id).toHaveLength(0); // 悬空碎片已并入洞，洞又通到地面，所以没有内孔
      const loop = out[0].outer;
      expect(loop.length, id).toBeGreaterThan(8);
      expect(loop.length, id).toBeLessThan(400);
      for (let i = 0; i < loop.length; i++) {
        const next = loop[(i + 1) % loop.length];
        expect(Math.hypot(loop[i].x - next.x, loop[i].y - next.y), id).toBeGreaterThan(1e-6);
      }
      expect(selfIntersects(loop), id).toBe(false);
      expect(polygonArea(loop), id).toBeGreaterThan(WALL_AREA * 0.6);
      expect(polygonArea(loop), id).toBeLessThan(WALL_AREA);
    }
  });
});

describe('holeEdges', () => {
  it('is empty for a wall with no hole', () => {
    expect(holeEdges(buildField(() => 1))).toEqual([]);
  });

  it('traces a doorway as one open line from floor to floor', () => {
    const edges = holeEdges(buildField(sdBox(0, 0.65, 0.4, 1.25)));
    expect(edges).toHaveLength(1);
    const line = edges[0];
    expect(line[0].y).toBeLessThan(0.05);
    expect(line[line.length - 1].y).toBeLessThan(0.05);
    expect(Math.max(...line.map((p) => p.y))).toBeCloseTo(1.9, 1);
    expect(Math.max(...line.map((p) => Math.abs(p.x)))).toBeCloseTo(0.4, 1);
  });

  it('traces a floating window as a closed line', () => {
    const edges = holeEdges(buildField(sdCircle(0, 1.5, 0.5)));
    expect(edges).toHaveLength(1);
    const line = edges[0];
    expect(line[0]).toEqual(line[line.length - 1]);
    for (const p of line) expect(Math.hypot(p.x, p.y - 1.5)).toBeCloseTo(0.5, 1);
  });

  it('never includes the wall\'s own outer edge', () => {
    for (const line of holeEdges(poseField('star'))) {
      for (const p of line) {
        expect(Math.abs(p.x)).toBeLessThan(2.05);
        expect(p.y).toBeLessThan(2.95);
      }
    }
  });
});
