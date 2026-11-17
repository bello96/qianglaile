import * as THREE from 'three';

/**
 * 烟花：升空（拖着一串火星）→ 到顶炸开成一个球 → 火星减速、下坠、闪烁着熄灭。
 *
 * 全部火星是一份点精灵（THREE.Points），加法混合，一次绘制。亮的东西叠在一起会更亮——这正是烟花该有的样子，
 * 也是它不需要"泛光"后处理的原因。白天的天空太亮，烟花显不出来，所以通关时天色会先暗成晚霞（见 sky.ts）。
 */
interface Spark {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number; g: number; b: number;
  size: number;
  age: number;
  life: number;
  /** rocket：正在升空的那一颗；到点了就炸。trail / ember：拖尾和炸开后的火星 */
  kind: 'rocket' | 'trail' | 'ember';
  /** rocket：炸成多少颗、什么颜色 */
  burst: number;
  hue: number;
  /** 闪烁的相位 */
  flicker: number;
}

const VERT = /* glsl */ `
  attribute float size;
  attribute vec3 tint;
  varying vec3 vTint;
  uniform float uScale;
  void main() {
    vTint = tint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * uScale / max(1.0, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const FRAG = /* glsl */ `
  varying vec3 vTint;
  void main() {
    // 圆形的光点：中心亮，边缘淡出
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float glow = smoothstep(1.0, 0.0, d);
    gl_FragColor = vec4(vTint * glow * glow, 1.0);
    #include <colorspace_fragment>
  }
`;

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
/** 烟花的几种颜色（色相，0～1） */
const HUES = [0.0, 0.08, 0.14, 0.33, 0.52, 0.62, 0.78, 0.9];

export class Fireworks {
  readonly points: THREE.Points;
  private readonly sparks: Spark[] = [];
  private readonly position: Float32Array;
  private readonly tint: Float32Array;
  private readonly size: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly colour = new THREE.Color();

  /** capacity：同时最多多少颗火星。density：每发炸成多少颗的倍数（低画质 0.5）。 */
  constructor(
    private readonly capacity: number,
    private readonly density: number,
  ) {
    this.position = new Float32Array(capacity * 3);
    this.tint = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    this.geometry.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uScale: { value: 600 } },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  /**
   * 画布的高度变了要说一声：点的大小是按像素算的。
   * pixelRatio：画布的一个 CSS 像素合几个设备像素。高分屏不乘上它，火星就只有设计的一半大。
   */
  resize(heightPx: number, pixelRatio = 1): void {
    this.material.uniforms.uScale.value = heightPx * pixelRatio * 0.9;
  }

  /** 从 (x, 水面, z) 放一发，升到 height 那么高炸开。 */
  launch(x: number, z: number, height = rand(7, 11), hue = HUES[Math.floor(Math.random() * HUES.length)]): void {
    // 竖直上抛：到顶正好是 height（减速度取 6，比重力小——火箭还在烧）
    const vy = Math.sqrt(2 * 6 * (height + 0.9));
    this.add({ x, y: -0.9, z, vx: rand(-0.4, 0.4), vy, vz: rand(-0.4, 0.4), r: 1, g: 0.85, b: 0.6, size: 0.5, age: 0, life: vy / 6, kind: 'rocket', burst: Math.round(rand(110, 170) * this.density), hue, flicker: 0 });
  }

  private add(s: Spark): void {
    if (this.sparks.length >= this.capacity) this.sparks.shift();
    this.sparks.push(s);
  }

  private explode(s: Spark): void {
    // 两层：外面一个大球，里面一小团换个颜色的
    for (const [share, speed, shift] of [[0.75, rand(4.2, 6), 0], [0.25, rand(2, 3), 0.1]] as const) {
      const n = Math.round(s.burst * share);
      this.colour.setHSL((s.hue + shift) % 1, 0.95, 0.6);
      for (let i = 0; i < n; i++) {
        // 球面上均匀取方向
        const u = rand(-1, 1);
        const a = rand(0, Math.PI * 2);
        const ring = Math.sqrt(1 - u * u);
        const v = speed * rand(0.85, 1.05);
        this.add({
          x: s.x, y: s.y, z: s.z,
          vx: ring * Math.cos(a) * v, vy: u * v, vz: ring * Math.sin(a) * v,
          r: this.colour.r, g: this.colour.g, b: this.colour.b,
          size: rand(0.34, 0.5), age: 0, life: rand(1.3, 2.1), kind: 'ember', burst: 0, hue: 0, flicker: rand(0, 6),
        });
      }
    }
  }

  /** 每帧调用。返回这一帧发生了什么（升空的声音在 launch 时由调用的人自己放；这里只报"炸了几发"）。 */
  update(dt: number): number {
    let bursts = 0;
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += dt;
      if (s.kind === 'rocket') {
        s.vy -= 6 * dt;
        // 拖尾：每帧留下一两颗很快熄灭的火星
        this.add({ x: s.x, y: s.y, z: s.z, vx: rand(-0.3, 0.3), vy: rand(-0.8, 0), vz: rand(-0.3, 0.3), r: 1, g: 0.7, b: 0.35, size: 0.28, age: 0, life: rand(0.25, 0.5), kind: 'trail', burst: 0, hue: 0, flicker: 0 });
      } else {
        // 火星：阻力大（很快慢下来），再慢慢往下坠
        const slow = Math.exp(-(s.kind === 'ember' ? 1.7 : 3) * dt);
        s.vx *= slow;
        s.vy = s.vy * slow - 1.6 * dt;
        s.vz *= slow;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      if (s.age >= s.life) {
        // 注意：explode 会往数组末尾加东西，不影响正在倒着走的下标
        this.sparks.splice(i, 1);
        if (s.kind === 'rocket') {
          this.explode(s);
          bursts++;
        }
      }
    }

    const n = Math.min(this.sparks.length, this.capacity);
    for (let i = 0; i < n; i++) {
      const s = this.sparks[i];
      const left = 1 - s.age / s.life;
      // 余烬快熄灭时闪：亮度抖动
      const twinkle = s.kind === 'ember' && left < 0.5 ? 0.55 + 0.45 * Math.sin(s.flicker + s.age * 38) : 1;
      const bright = Math.min(1, left * 2.2) * twinkle;
      this.position[i * 3] = s.x;
      this.position[i * 3 + 1] = s.y;
      this.position[i * 3 + 2] = s.z;
      this.tint[i * 3] = s.r * bright;
      this.tint[i * 3 + 1] = s.g * bright;
      this.tint[i * 3 + 2] = s.b * bright;
      this.size[i] = s.size;
    }
    this.geometry.setDrawRange(0, n);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.tint.needsUpdate = true;
    this.geometry.attributes.size.needsUpdate = true;
    return bursts;
  }

  /** 天上现在还有多少颗火星（检查用）。 */
  get alive(): number {
    return this.sparks.length;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
