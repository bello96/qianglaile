import * as THREE from 'three';
import type { BuiltWall } from '../build';
import { sampleField } from '../field';
import { COLORS, WATER_Y } from './stage';

/**
 * 粒子特效：彩带、墙碎成的泡沫块、水珠——其实是同一种东西：一堆会飞的小方块。
 * 全部画在一个 InstancedMesh 里（一次绘制调用），活着的粒子排在前面。
 */
interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  sx: number; sy: number; sz: number;
  wx: number; wy: number; wz: number;
  age: number;
  life: number;
  gravity: number;
  drag: number;
  color: number;
}

const CAPACITY = 700;
const PARTY = [COLORS.coral, COLORS.sun, COLORS.mint, 0xffffff, 0x8f6cff, 0xff7ab8];
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

export class Fx {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private particles: Particle[] = [];
  private readonly dummy = new THREE.Object3D();
  private readonly tint = new THREE.Color();

  constructor() {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), CAPACITY);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  private spawn(p: Omit<Particle, 'age' | 'rx' | 'ry' | 'rz'>): void {
    if (this.particles.length >= CAPACITY) this.particles.shift();
    this.particles.push({ ...p, age: 0, rx: rand(0, 6), ry: rand(0, 6), rz: rand(0, 6) });
  }

  /** 一蓬彩带，从 (x, y, z) 往上喷。 */
  confetti(x: number, y: number, z: number, count = 90): void {
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2);
      const out = rand(0.4, 2.6);
      this.spawn({
        x, y, z,
        vx: Math.cos(a) * out, vy: rand(3, 7.5), vz: Math.sin(a) * out * 0.6,
        sx: 0.09, sy: 0.14, sz: 0.012,
        wx: rand(-12, 12), wy: rand(-12, 12), wz: rand(-12, 12),
        life: rand(1.6, 2.6), gravity: 5, drag: 1.4,
        color: PARTY[i % PARTY.length],
      });
    }
  }

  /** 墙碎成泡沫块：只从墙体（不含洞）的位置生出碎块，所以碎裂的形状还是那面墙。 */
  shatter(wall: BuiltWall, z: number, color: number, count = 120): void {
    const b = wall.field.bounds;
    const lighter = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.3).getHex();
    let made = 0;
    for (let tries = 0; tries < 600 && made < count; tries++) {
      const x = rand(b.x0, b.x1);
      const y = rand(b.y0, b.y1);
      if (sampleField(wall.field, x, y) < 0.04) continue;
      const dx = x - wall.spec.holeX;
      const dy = y - 1.2;
      const d = Math.hypot(dx, dy) || 1;
      const s = rand(0.14, 0.3);
      this.spawn({
        x, y, z,
        vx: (dx / d) * rand(1.5, 4.5), vy: (dy / d) * rand(1, 3) + rand(1, 3.5), vz: rand(-0.6, 1.4),
        sx: s, sy: s, sz: s,
        wx: rand(-8, 8), wy: rand(-8, 8), wz: rand(-8, 8),
        life: rand(0.9, 1.5), gravity: 11, drag: 0.3,
        color: made++ % 3 ? color : lighter,
      });
    }
  }

  /** 水花：一圈水珠从水面蹦起来。 */
  droplets(x: number, z: number, count = 46): void {
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2);
      const out = rand(0.3, 2.2);
      const s = rand(0.05, 0.1);
      this.spawn({
        x: x + Math.cos(a) * 0.2, y: WATER_Y + 0.05, z: z + Math.sin(a) * 0.2,
        vx: Math.cos(a) * out, vy: rand(3, 7), vz: Math.sin(a) * out,
        sx: s, sy: s * 1.6, sz: s,
        wx: 0, wy: 0, wz: 0,
        life: rand(0.7, 1.1), gravity: 13, drag: 0.2,
        color: i % 3 ? 0xffffff : 0xbdf3fb,
      });
    }
  }

  update(dt: number): void {
    const alive: Particle[] = [];
    for (const p of this.particles) {
      p.age += dt;
      if (p.age >= p.life) continue;
      const damp = Math.exp(-p.drag * dt);
      p.vx *= damp;
      p.vz *= damp;
      p.vy = p.vy * damp - p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rx += p.wx * dt;
      p.ry += p.wy * dt;
      p.rz += p.wz * dt;
      alive.push(p);
    }
    this.particles = alive;

    for (let i = 0; i < alive.length; i++) {
      const p = alive[i];
      const fade = Math.min(1, (p.life - p.age) / 0.25); // 快消失时缩小
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.rotation.set(p.rx, p.ry, p.rz);
      this.dummy.scale.set(p.sx * fade, p.sy * fade, p.sz * fade);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, this.tint.setHex(p.color));
    }
    this.mesh.count = alive.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
