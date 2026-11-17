import { sampleField, type WallField } from '../field';

/**
 * 把一面墙的墙体（不含洞）切成错缝的砖。
 *
 * 墙碎的时候不是"凭空变出一堆小方块"：碎之前的一瞬间，这些砖正好拼成原来那面墙——洞还在，颜色还在——
 * 然后每块砖各飞各的（debris.ts）。所以碎裂的那一下看得出是"这面墙"碎了。
 */
export interface Tile {
  /** 砖的中心（墙面坐标，米） */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 砖比高宽一点，看着像砖 */
const ASPECT = 1.2;
/** 窄于这个的边角料不要 */
const MIN_WIDTH = 0.05;

/**
 * size：砖高（米），宽是它的 1.2 倍。max：最多要多少块；超出就均匀地少要一些（低画质用）。
 * 一块砖算不算数，看它的中心在不在墙体上、是不是大半都在墙体上。
 */
export function tileWall(field: WallField, size = 0.3, max = Infinity): Tile[] {
  const b = field.bounds;
  const rows = Math.max(1, Math.round((b.y1 - b.y0) / size));
  const h = (b.y1 - b.y0) / rows;
  // 砖宽凑成正好铺满整面墙（不超过 size × 1.2）：这样墙边不会剩下一条几厘米的边角料
  const cols = Math.max(1, Math.ceil((b.x1 - b.x0) / (size * ASPECT) - 1e-9));
  const w = (b.x1 - b.x0) / cols;
  const tiles: Tile[] = [];

  for (let r = 0; r < rows; r++) {
    const y = b.y0 + (r + 0.5) * h;
    // 错缝：隔一行往左挪半块，两头用半块砖补齐
    for (let left = b.x0 - (r % 2 ? w / 2 : 0); left < b.x1 - 1e-9; left += w) {
      const x0 = Math.max(left, b.x0);
      const x1 = Math.min(left + w, b.x1);
      if (x1 - x0 < MIN_WIDTH) continue;
      const x = (x0 + x1) / 2;
      if (!(sampleField(field, x, y) > 0)) continue;
      // 九宫格取样：大半在墙体上才要（洞边上的砖只留靠墙的那些）
      let solid = 0;
      for (const fy of [-0.33, 0, 0.33]) for (const fx of [-0.33, 0, 0.33]) if (sampleField(field, x + fx * (x1 - x0), y + fy * h) > 0) solid++;
      if (solid >= 5) tiles.push({ x, y, w: x1 - x0, h });
    }
  }

  if (tiles.length <= max) return tiles;
  return Array.from({ length: max }, (_, k) => tiles[Math.floor((k * tiles.length) / max)]);
}
