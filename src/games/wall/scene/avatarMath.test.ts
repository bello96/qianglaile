import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../engine/util/math';
import { createRng } from '../../../engine/util/rng';
import { capsuleTransform } from './avatarMath';

/** 用四元数旋转一个向量。 */
function rotate(q: [number, number, number, number], v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // v' = v + 2w(q×v) + 2 q×(q×v)
  const cx = y * v.z - z * v.y;
  const cy = z * v.x - x * v.z;
  const cz = x * v.y - y * v.x;
  return {
    x: v.x + 2 * (w * cx + (y * cz - z * cy)),
    y: v.y + 2 * (w * cy + (z * cx - x * cz)),
    z: v.z + 2 * (w * cz + (x * cy - y * cx)),
  };
}
const UP: Vec3 = { x: 0, y: 1, z: 0 };

describe('capsuleTransform', () => {
  it('leaves an upright limb unrotated, centred between its ends', () => {
    const t = capsuleTransform({ x: 0, y: 0, z: 0 }, { x: 0, y: 2, z: 0 });
    expect(t.position).toEqual({ x: 0, y: 1, z: 0 });
    expect(t.length).toBeCloseTo(2);
    expect(t.quaternion[0]).toBeCloseTo(0);
    expect(t.quaternion[1]).toBeCloseTo(0);
    expect(t.quaternion[2]).toBeCloseTo(0);
    expect(t.quaternion[3]).toBeCloseTo(1);
  });

  it('turns +Y onto +X for a sideways limb', () => {
    const t = capsuleTransform({ x: 1, y: 1, z: 1 }, { x: 3, y: 1, z: 1 });
    const d = rotate(t.quaternion, UP);
    expect(d.x).toBeCloseTo(1);
    expect(d.y).toBeCloseTo(0);
    expect(d.z).toBeCloseTo(0);
    expect(t.position).toEqual({ x: 2, y: 1, z: 1 });
  });

  it('handles a limb pointing straight down', () => {
    const t = capsuleTransform({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 });
    const d = rotate(t.quaternion, UP);
    expect(d.y).toBeCloseTo(-1);
    expect(Math.hypot(d.x, d.z)).toBeCloseTo(0);
    for (const c of t.quaternion) expect(Number.isFinite(c)).toBe(true);
  });

  it('does not blow up when both ends coincide', () => {
    const t = capsuleTransform({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 });
    expect(t.length).toBe(0);
    expect(t.quaternion).toEqual([0, 0, 0, 1]);
    expect(t.position).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('always rotates +Y onto the limb direction, with a unit quaternion', () => {
    const rng = createRng(17);
    for (let i = 0; i < 20; i++) {
      const a = { x: rng.gauss(), y: rng.gauss(), z: rng.gauss() };
      const b = { x: rng.gauss(), y: rng.gauss(), z: rng.gauss() };
      const t = capsuleTransform(a, b);
      const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      const d = rotate(t.quaternion, UP);
      expect(t.length).toBeCloseTo(len);
      expect(d.x).toBeCloseTo((b.x - a.x) / len);
      expect(d.y).toBeCloseTo((b.y - a.y) / len);
      expect(d.z).toBeCloseTo((b.z - a.z) / len);
      expect(Math.hypot(...t.quaternion)).toBeCloseTo(1);
    }
  });
});
