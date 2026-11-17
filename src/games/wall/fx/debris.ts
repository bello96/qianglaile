import type { Tile } from './tiles';

/**
 * 碎块的物理：墙碎成的泡沫块怎么飞、怎么落。不碰画面（画它的是 scene/debrisMesh.ts），所以能直接测。
 *
 * 不是严格的刚体模拟，是"看着对"的近似：
 *   空中 —— 重力、空气阻力、自转；
 *   落到浮台上 —— 弹一下（泡沫，弹不高），几下之后停住；在台面上会滑，滑出台边就掉下去；
 *   落进水里 —— 报告一次水花，然后被浮力托着在水面上下漂，慢慢停；
 *   时间到了 —— 消失（画的时候最后一小段时间会缩小淡出）。
 */
export interface Chunk {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** 朝向（欧拉角）和转速 */
  rx: number; ry: number; rz: number;
  wx: number; wy: number; wz: number;
  /** 三个方向的边长（米） */
  sx: number; sy: number; sz: number;
  color: number;
  age: number;
  life: number;
  state: 'air' | 'deck' | 'water';
}

/** 碎块会碰到的东西：浮台（顶面在 y = 0，中心在原点）和水面。 */
export interface DebrisEnv {
  /** 浮台半宽（x 方向）、半深（z 方向） */
  deckHalfW: number;
  deckHalfD: number;
  waterY: number;
}

const GRAVITY = 9.8;
/** 空气阻力（1/秒）：泡沫轻，飞不远 */
const AIR_DRAG = 0.7;
/** 落到台面上弹起来的比例 */
const BOUNCE = 0.35;
/** 落地速度低于它就不弹了，停在台面上 */
const REST_SPEED = 0.9;
/** 台面的摩擦（1/秒）：滑动和转动各自的衰减 */
const DECK_FRICTION = 4;
const DECK_SPIN_FRICTION = 6;
/** 浮力像弹簧一样把块托在水面：刚度和阻尼 */
const FLOAT_SPRING = 22;
const FLOAT_DAMP = 4.5;
/** 浮着的时候，块的中心在水面下这么多 */
const FLOAT_DEPTH = 0.03;
const WATER_DRAG = 1.6;
/** 一次最多推进这么久；更长的间隔拆成几步，免得一步穿过台面 */
const MAX_STEP = 1 / 60;

export class DebrisSim {
  readonly chunks: Chunk[] = [];

  constructor(
    private readonly env: DebrisEnv,
    private readonly capacity: number,
  ) {}

  /**
   * 整面墙碎开：每块砖一个碎块，就在砖原来的位置。
   * z、thickness：墙面在哪、墙多厚。burst：爆心（墙面上的一点）和力道；forward 是顺着墙前进方向带出去的速度。
   * rand：给 [0, 1) 的随机数（测试里用带种子的）。
   */
  shatter(tiles: Tile[], z: number, thickness: number, color: number, burst: { x: number; y: number; power: number; forward?: number }, rand: () => number): void {
    const light = lighten(color, 0.3);
    tiles.forEach((t, i) => {
      const dx = t.x - burst.x;
      const dy = t.y - burst.y;
      const d = Math.hypot(dx, dy) || 1;
      // 离爆心近的飞得快
      const k = (burst.power * (0.55 + 0.45 * rand())) / (0.6 + d);
      this.chunks.push({
        x: t.x, y: t.y, z,
        vx: (dx / d) * k * 1.2 + (rand() - 0.5) * 0.4,
        vy: (dy / d) * k * 0.7 + 1.2 + rand() * 1.6,
        vz: (burst.forward ?? 0) * (0.4 + rand()) + (rand() - 0.5) * 1.2 * Math.min(1, burst.power),
        rx: 0, ry: 0, rz: 0,
        wx: (rand() - 0.5) * 12, wy: (rand() - 0.5) * 8, wz: (rand() - 0.5) * 12,
        // 留一条缝，碎之前就能隐约看出是一块块砖
        sx: t.w * 0.94, sy: t.h * 0.94, sz: thickness,
        color: i % 3 === 0 ? light : color,
        age: 0,
        life: 5 + rand() * 2.5,
        state: 'air',
      });
    });
    while (this.chunks.length > this.capacity) this.chunks.shift();
  }

  /** 推进 dt 秒。返回这段时间里落水的位置和入水速度（每块只报一次），给水花用。 */
  step(dt: number): { x: number; z: number; speed: number }[] {
    const splashes: { x: number; z: number; speed: number }[] = [];
    const n = Math.max(1, Math.ceil(dt / MAX_STEP));
    const h = dt / n;
    for (let k = 0; k < n; k++) for (const c of this.chunks) this.move(c, h, splashes);

    for (const c of this.chunks) c.age += dt;
    for (let i = this.chunks.length - 1; i >= 0; i--) if (this.chunks[i].age >= this.chunks[i].life) this.chunks.splice(i, 1);
    return splashes;
  }

  private move(c: Chunk, h: number, splashes: { x: number; z: number; speed: number }[]): void {
    const { deckHalfW, deckHalfD, waterY } = this.env;
    const overDeck = (): boolean => Math.abs(c.x) <= deckHalfW && Math.abs(c.z) <= deckHalfD;
    /** 平躺在台面上时，中心离台面多高 */
    const rest = Math.min(c.sx, c.sy, c.sz) / 2;

    if (c.state === 'deck') {
      const slow = Math.exp(-DECK_FRICTION * h);
      c.vx *= slow;
      c.vz *= slow;
      c.x += c.vx * h;
      c.z += c.vz * h;
      const spin = Math.exp(-DECK_SPIN_FRICTION * h);
      c.wx *= spin;
      c.wy *= spin;
      c.wz *= spin;
      c.ry += c.wy * h;
      if (!overDeck()) c.state = 'air'; // 滑出台边：掉下去
      return;
    }

    if (c.state === 'water') {
      c.vy += (-FLOAT_SPRING * (c.y - (waterY - FLOAT_DEPTH)) - FLOAT_DAMP * c.vy) * h;
      const slow = Math.exp(-WATER_DRAG * h);
      c.vx *= slow;
      c.vz *= slow;
      c.wx *= slow;
      c.wy *= slow;
      c.wz *= slow;
    } else {
      const slow = Math.exp(-AIR_DRAG * h);
      c.vx *= slow;
      c.vz *= slow;
      c.vy = c.vy * slow - GRAVITY * h;
    }

    const wasAbove = c.y - rest >= -1e-6;
    c.x += c.vx * h;
    c.y += c.vy * h;
    c.z += c.vz * h;
    c.rx += c.wx * h;
    c.ry += c.wy * h;
    c.rz += c.wz * h;
    if (c.state === 'water') return;

    // 落到台面上：只有从上面落下来的才算（从台边外面掉下去的，经过台面高度时已经不在台子上方了）
    if (wasAbove && c.vy < 0 && c.y < rest && overDeck()) {
      c.y = rest;
      if (-c.vy < REST_SPEED) {
        c.vy = 0;
        c.state = 'deck';
        // 躺平：不再前后翻，只可能在台面上打转
        c.rx = Math.round(c.rx / (Math.PI / 2)) * (Math.PI / 2);
        c.rz = Math.round(c.rz / (Math.PI / 2)) * (Math.PI / 2);
        c.wx = c.wz = 0;
      } else {
        c.vy = -c.vy * BOUNCE;
        c.vx *= 0.7;
        c.vz *= 0.7;
        c.wx *= 0.5;
        c.wy *= 0.5;
        c.wz *= 0.5;
      }
      return;
    }

    if (c.y < waterY) {
      splashes.push({ x: c.x, z: c.z, speed: Math.hypot(c.vx, c.vy, c.vz) });
      c.state = 'water';
      c.vy *= 0.25;
      c.vx *= 0.5;
      c.vz *= 0.5;
    }
  }
}

/** 把一个颜色往白里调 k（0～1）。 */
function lighten(color: number, k: number): number {
  const mix = (v: number): number => Math.round(v + (255 - v) * k);
  return (mix((color >> 16) & 255) << 16) | (mix((color >> 8) & 255) << 8) | mix(color & 255);
}
