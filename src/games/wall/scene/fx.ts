import * as THREE from 'three';
import { COLORS, WATER_Y } from './stage';

/**
 * 小粒子：彩纸、彩带卷、星星、水珠、水沫。全部画在一个 InstancedMesh 里（一次绘制），都是小方片。
 * （墙碎成的大块不在这里，那是 fx/debris.ts + debrisMesh.ts；烟花是 fireworks.ts。）
 *
 * 各种粒子的"性格"不一样，这正是它们看起来像不像的关键：
 *   彩纸 —— 轻。下落很慢，一边翻一边左右滑；落到台面就停住，落进水里就漂着。
 *   彩带卷 —— 长条，绕着竖轴转着往下掉，像拧着的丝带。
 *   星星 —— 从一点迸出来，很快减速、缩小、消失；不受重力。
 *   水珠 —— 重。抛物线，落回水面时再溅起两三颗更小的。
 *   水沫 —— 贴在水面上，慢慢散开、淡掉。
 */
type Kind = 'paper' | 'streamer' | 'star' | 'drop' | 'foam';

interface Particle {
  kind: Kind;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  sx: number; sy: number; sz: number;
  wx: number; wy: number; wz: number;
  age: number;
  life: number;
  color: number;
  /** 彩纸飘动的相位；水珠：落水时还会不会再溅起小水珠 */
  phase: number;
  /** 已经落定了（停在台面上，或漂在水面） */
  settled: boolean;
}

const PARTY = [COLORS.coral, COLORS.sun, COLORS.mint, 0xffffff, 0x8f6cff, 0xff7ab8];
const GOLD = [0xffc531, 0xffe08a, 0xfff3c4, 0xffa41b];
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

export interface FxOpts {
  /** 同时最多多少个粒子；超了丢最老的 */
  capacity: number;
  /** 数量的倍数：低画质传 0.5 */
  density: number;
  /** 浮台的半宽、半深（彩纸落在上面会停住） */
  deckHalfW: number;
  deckHalfD: number;
}

export class Fx {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private particles: Particle[] = [];
  private readonly dummy = new THREE.Object3D();
  private readonly tint = new THREE.Color();

  constructor(private readonly opts: FxOpts) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), opts.capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  private spawn(p: Omit<Particle, 'age' | 'settled' | 'rx' | 'ry' | 'rz' | 'phase'> & { phase?: number }): void {
    if (this.particles.length >= this.opts.capacity) this.particles.shift();
    this.particles.push({ ...p, age: 0, settled: false, rx: rand(0, 6), ry: rand(0, 6), rz: rand(0, 6), phase: p.phase ?? rand(0, 6) });
  }

  private count(n: number): number {
    return Math.max(1, Math.round(n * this.opts.density));
  }

  private paper(x: number, y: number, z: number, vx: number, vy: number, vz: number, colors: readonly number[]): void {
    this.spawn({
      kind: 'paper',
      x, y, z, vx, vy, vz,
      sx: rand(0.07, 0.11), sy: rand(0.1, 0.16), sz: 0.01,
      wx: rand(-9, 9), wy: rand(-9, 9), wz: rand(-9, 9),
      life: rand(4.5, 7),
      color: pick(colors),
    });
  }

  /** 一蓬彩纸，从 (x, y, z) 往上喷。gold：过了三星 / 通关时用金色的。 */
  confetti(x: number, y: number, z: number, n = 60, gold = false): void {
    for (let i = 0; i < this.count(n); i++) {
      const a = rand(0, Math.PI * 2);
      const out = rand(0.4, 2.4);
      this.paper(x, y, z, Math.cos(a) * out, rand(3, 7), Math.sin(a) * out * 0.6, gold ? GOLD : PARTY);
    }
  }

  /** 彩带炮：从台子一侧斜着朝中间上方打出一大蓬，带几条彩带卷。side：-1 左边，+1 右边。 */
  cannon(side: -1 | 1, x: number, z: number, n = 110): void {
    for (let i = 0; i < this.count(n); i++) {
      const speed = rand(5, 10.5);
      const lift = rand(0.9, 1.35); // 仰角（弧度）
      const fan = rand(-0.5, 0.5);
      this.paper(x, 0.2, z, -side * Math.cos(lift) * speed * Math.cos(fan), Math.sin(lift) * speed, Math.sin(fan) * speed * 0.5 - 0.5, PARTY);
    }
    for (let i = 0; i < this.count(6); i++) this.streamer(x - side * rand(0.3, 1.6), rand(2.6, 4.2), z + rand(-1.2, 0.6), -side * rand(0.3, 1.2));
  }

  /** 彩纸从天而降（通关）：在台子上方一大片范围里撒 n 片。 */
  rain(n: number, halfW: number, gold = true): void {
    for (let i = 0; i < this.count(n); i++) {
      this.paper(rand(-halfW, halfW), rand(5, 7.5), rand(-2.4, 1.6), rand(-0.3, 0.3), rand(-1, 0), rand(-0.2, 0.2), Math.random() < (gold ? 0.6 : 0) ? GOLD : PARTY);
    }
    for (let i = 0; i < this.count(Math.ceil(n / 24)); i++) this.streamer(rand(-halfW, halfW), rand(5, 7), rand(-2, 1.2), rand(-0.4, 0.4));
  }

  /** 一条彩带卷：细长的纸条，拧着往下掉。 */
  private streamer(x: number, y: number, z: number, vx: number): void {
    this.spawn({
      kind: 'streamer',
      x, y, z, vx, vy: rand(-0.4, 0.6), vz: rand(-0.2, 0.2),
      sx: 0.05, sy: rand(0.26, 0.42), sz: 0.008,
      wx: 0, wy: rand(5, 9) * (Math.random() < 0.5 ? -1 : 1), wz: 0,
      life: rand(5, 7.5),
      color: pick(PARTY),
    });
  }

  /** 星星：从 (x, y, z) 四散迸开。gold：三星。 */
  stars(x: number, y: number, z: number, n = 14, gold = false): void {
    for (let i = 0; i < this.count(n); i++) {
      const a = rand(0, Math.PI * 2);
      const speed = rand(2.2, 5);
      const s = rand(0.07, 0.13) * (gold ? 1.25 : 1);
      this.spawn({
        kind: 'star',
        x: x + Math.cos(a) * 0.25, y: y + Math.sin(a) * 0.45, z,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed * 0.9 + 0.6, vz: rand(-0.4, 1.2),
        sx: s, sy: s, sz: s * 0.25,
        wx: 0, wy: 0, wz: rand(-10, 10),
        life: rand(0.45, 0.8),
        color: gold ? pick(GOLD) : pick([0xffffff, 0xfff3c4, 0xbdf3fb]),
      });
    }
  }

  private drop(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, again: boolean): void {
    this.spawn({
      kind: 'drop',
      x, y, z, vx, vy, vz,
      sx: size, sy: size * 2.2, sz: size,
      wx: 0, wy: 0, wz: 0,
      life: 3,
      color: Math.random() < 0.3 ? 0xbdf3fb : 0xffffff,
      phase: again ? 1 : 0,
    });
  }

  /**
   * 水花，三层：正中一根水柱（往上蹿得高）、周围一圈往外飞的水珠、水面上一圈水沫。
   * 水珠落回水面时还会各自溅起两三颗更小的（在 update 里）。power：0～1，小人落水是 1，碎块落水零点几。
   */
  splash(x: number, z: number, power = 1): void {
    const big = power > 0.6;
    for (let i = 0; i < this.count(big ? 44 : 5); i++) {
      this.drop(x + rand(-0.14, 0.14), WATER_Y + 0.05, z + rand(-0.14, 0.14), rand(-0.6, 0.6), rand(4.5, 9) * (0.5 + 0.5 * power), rand(-0.6, 0.6), rand(0.035, 0.07), big);
    }
    for (let i = 0; i < this.count(big ? 52 : 6); i++) {
      const a = rand(0, Math.PI * 2);
      const out = rand(1.2, 3.4) * (0.4 + 0.6 * power);
      this.drop(x + Math.cos(a) * 0.25, WATER_Y + 0.05, z + Math.sin(a) * 0.25, Math.cos(a) * out, rand(2, 4.6) * (0.5 + 0.5 * power), Math.sin(a) * out, rand(0.025, 0.05), big);
    }
    this.foam(x, z, big ? 14 : 3, big ? 0.9 : 0.25);
  }

  /** 水沫：水面上的几片白，慢慢散开淡掉（墙的浮筒划过、东西落水的地方）。 */
  foam(x: number, z: number, n = 2, spread = 0.2): void {
    for (let i = 0; i < this.count(n); i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(0.07, 0.15);
      this.spawn({
        kind: 'foam',
        x: x + Math.cos(a) * rand(0, spread), y: WATER_Y + 0.07, z: z + Math.sin(a) * rand(0, spread),
        vx: Math.cos(a) * rand(0.1, 0.5), vy: 0, vz: Math.sin(a) * rand(0.1, 0.5),
        sx: s, sy: 0.012, sz: s * rand(0.6, 1.2),
        wx: 0, wy: rand(-0.6, 0.6), wz: 0,
        life: rand(0.9, 1.7),
        color: 0xffffff,
      });
    }
  }

  update(dt: number): void {
    const { deckHalfW, deckHalfD } = this.opts;
    const alive: Particle[] = [];
    for (const p of this.particles) {
      p.age += dt;
      if (p.age >= p.life) continue;

      if (p.kind === 'foam') {
        const slow = Math.exp(-1.5 * dt);
        p.vx *= slow;
        p.vz *= slow;
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        p.ry += p.wy * dt;
      } else if (p.kind === 'star') {
        const slow = Math.exp(-5 * dt);
        p.vx *= slow;
        p.vy *= slow;
        p.vz *= slow;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.rz += p.wz * dt;
      } else if (p.kind === 'drop') {
        p.vy -= 13 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        if (p.vy < 0 && p.y < WATER_Y) {
          // 落回水面：大的再溅起两三颗小的，自己消失
          if (p.phase > 0) for (let i = 0; i < 2; i++) this.drop(p.x, WATER_Y + 0.03, p.z, rand(-0.6, 0.6), rand(1, 2.2), rand(-0.6, 0.6), p.sx * 0.5, false);
          continue;
        }
      } else if (!p.settled) {
        // 彩纸、彩带卷：轻，下落慢。彩纸一边翻一边侧滑——翻到平着的时候落得慢、滑得快
        const flat = Math.abs(Math.cos(p.rx));
        const terminal = p.kind === 'streamer' ? 1.5 : 0.9 + 1.5 * (1 - flat);
        p.vy = Math.max(p.vy - 6.5 * dt, -terminal);
        const slow = Math.exp(-1.8 * dt);
        p.vx *= slow;
        p.vz *= slow;
        if (p.kind === 'paper' && p.vy < 0) {
          p.phase += dt * 4;
          p.vx += Math.cos(p.phase) * 1.6 * flat * dt;
          p.vz += Math.sin(p.phase * 0.7) * 1.0 * flat * dt;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.rx += p.wx * dt;
        p.ry += p.wy * dt;
        p.rz += p.wz * dt;

        const overDeck = Math.abs(p.x) < deckHalfW && Math.abs(p.z) < deckHalfD;
        if (p.vy < 0 && overDeck && p.y < 0.02 && p.y > -0.2) this.settle(p, 0.012);
        else if (p.y < WATER_Y + 0.03) this.settle(p, WATER_Y + 0.045);
      } else if (p.y < 0) {
        // 漂在水面上：跟着一点点水流
        p.x += 0.12 * dt;
        p.ry += 0.3 * dt;
      }
      alive.push(p);
    }
    this.particles = alive;

    for (let i = 0; i < alive.length; i++) {
      const p = alive[i];
      // 星星越飞越小；别的快消失时缩小
      const fade = p.kind === 'star' ? 1 - p.age / p.life : Math.min(1, (p.life - p.age) / 0.35);
      const grow = p.kind === 'foam' ? 1 + p.age * 1.4 : 1;
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.rotation.set(p.rx, p.ry, p.rz);
      this.dummy.scale.set(p.sx * fade * grow, p.sy * (p.kind === 'foam' ? 1 : fade), p.sz * fade * grow);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, this.tint.setHex(p.color));
    }
    this.mesh.count = alive.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** 彩纸、彩带落定了：平躺在 y 这个高度，不再动（再过一会儿淡掉）。 */
  private settle(p: Particle, y: number): void {
    p.settled = true;
    p.y = y;
    p.vx = p.vy = p.vz = 0;
    p.rx = Math.PI / 2; // 躺平
    p.rz = 0;
    if (p.kind === 'streamer') p.sy *= 0.7;
    p.life = Math.min(p.life, p.age + rand(2, 3.5));
  }

  /** 现在有多少个粒子（检查用）。 */
  get alive(): number {
    return this.particles.length;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
