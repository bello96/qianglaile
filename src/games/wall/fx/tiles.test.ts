import { describe, expect, it } from 'vitest';
import { defaultProfile } from '../../../engine/body/profile';
import { buildWall } from '../build';
import { sampleField, type WallField } from '../field';
import { getPose } from '../poses';
import { TUNING } from '../tuning';
import { tileWall } from './tiles';

const profile = defaultProfile();
const wallOf = (id: string, mate = false): WallField =>
  buildWall({ index: 1, level: 1, kind: 'pose', pose: getPose(id)!, holeX: mate ? -0.75 : 0, approachSec: 6, angleTol: 32, fresh: true, ...(mate ? { mate: { pose: getPose(id)!, holeX: 0.75 } } : {}) }, profile, TUNING.normal).field;

/** 墙体（不含洞）的面积，按格点数出来。 */
function solidArea(f: WallField): number {
  let cells = 0;
  for (let j = 0; j < f.ny; j++) {
    for (let i = 0; i < f.nx; i++) {
      const x = f.gx0 + i * f.cell;
      const y = f.gy0 + j * f.cell;
      if (x >= f.bounds.x0 && x <= f.bounds.x1 && y >= f.bounds.y0 && y <= f.bounds.y1 && f.data[j * f.nx + i] > 0) cells++;
    }
  }
  return cells * f.cell * f.cell;
}

describe('tileWall (cutting the wall into the bricks it will break into)', () => {
  const field = wallOf('t');
  const tiles = tileWall(field);

  it('covers the wall with bricks about 30 cm across', () => {
    expect(tiles.length).toBeGreaterThan(70);
    expect(tiles.length).toBeLessThan(160);
    for (const t of tiles) {
      expect(t.h).toBeCloseTo(0.3, 6);
      expect(t.w).toBeGreaterThan(0.15);
      expect(t.w).toBeLessThanOrEqual(0.36 + 1e-9);
    }
  });

  it('every brick lies inside the wall, on solid wall', () => {
    const b = field.bounds;
    for (const t of tiles) {
      expect(t.x - t.w / 2).toBeGreaterThanOrEqual(b.x0 - 1e-9);
      expect(t.x + t.w / 2).toBeLessThanOrEqual(b.x1 + 1e-9);
      expect(t.y - t.h / 2).toBeGreaterThanOrEqual(b.y0 - 1e-9);
      expect(t.y + t.h / 2).toBeLessThanOrEqual(b.y1 + 1e-9);
      expect(sampleField(field, t.x, t.y)).toBeGreaterThan(0);
    }
  });

  it('leaves the hole empty, so the debris still shows the shape of the hole', () => {
    // 一字平举：胸口和两臂是洞
    for (const [x, y] of [[0, 1.2], [0.5, 1.33], [-0.5, 1.33], [0, 0.5]]) {
      expect(tiles.some((t) => Math.abs(t.x - x) < t.w / 2 && Math.abs(t.y - y) < t.h / 2), `(${x}, ${y})`).toBe(false);
    }
  });

  it('accounts for about as much area as the wall has', () => {
    const area = tiles.reduce((sum, t) => sum + t.w * t.h, 0);
    const solid = solidArea(field);
    expect(area).toBeGreaterThan(solid * 0.85);
    expect(area).toBeLessThan(solid * 1.15);
  });

  it('staggers the rows like brickwork', () => {
    const rowY = [...new Set(tiles.map((t) => Math.round(t.y * 1000)))].sort((p, q) => p - q);
    const leftEdges = (y: number): number[] => tiles.filter((t) => Math.round(t.y * 1000) === y).map((t) => t.x - t.w / 2);
    // 取顶上两行（那里没有洞）：第二行的砖缝正对着第一行砖的中间
    const top = leftEdges(rowY[rowY.length - 1]).sort((p, q) => p - q);
    const below = leftEdges(rowY[rowY.length - 2]).sort((p, q) => p - q);
    const joint = top[3];
    expect(below.some((e) => Math.abs(e - joint) < 0.02)).toBe(false);
    expect(below.some((e) => Math.abs(e - (joint + 0.18)) < 0.02 || Math.abs(e - (joint - 0.18)) < 0.02)).toBe(true);
  });

  it('can be told to use bigger bricks, or to stop at a number of them', () => {
    expect(tileWall(field, 0.45).length).toBeLessThan(tiles.length * 0.6);
    expect(tileWall(field, 0.3, 40)).toHaveLength(40);
    expect(tileWall(field, 0.3, 9999)).toHaveLength(tiles.length);
  });

  it('works for the wider two-player wall too', () => {
    const duo = wallOf('up', true);
    const bricks = tileWall(duo);
    expect(bricks.length).toBeGreaterThan(tiles.length);
    for (const t of bricks) expect(sampleField(duo, t.x, t.y)).toBeGreaterThan(0);
  });
});
