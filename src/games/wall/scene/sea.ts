import * as THREE from 'three';
import { SKY } from './sky';
import { COLORS, WATER_Y } from './stage';

/**
 * 水面：一张大平面 + 一段着色器。还是卡通的海，但多了三样让它"像水"的东西：
 *
 *   反光 —— 水面越是斜着看越像镜子（菲涅耳）：远处映着天的颜色，近处看得见水的本色。
 *   太阳的高光 —— 朝着太阳那一片水面上跳动的亮斑。
 *   涟漪 —— 东西落水的地方，一圈水波真的向外传开（最多同时 8 处，旧的被新的顶掉）。
 *
 * 法线是直接从波的公式里求导出来的，不用法线贴图。没有真的反射、折射（不渲染第二遍场景）——
 * 集成显卡也跑得动，而且识别模型还要用显卡。低画质连"映着天"这一项也省掉。
 */
const RIPPLES = 8;

const VERT = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    wp.y += sin(wp.x * 0.55 + uTime * 1.1) * 0.05 + sin(wp.z * 0.42 + uTime * 0.8) * 0.06;
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uReflect;
  uniform vec3 uNear;
  uniform vec3 uFar;
  uniform vec3 uGlint;
  uniform vec3 uHorizon;
  uniform vec3 uSkyTop;
  uniform vec3 uSunDir;
  uniform vec3 uSunCol;
  uniform vec4 uRipples[${RIPPLES}]; // x, z, 开始的时刻, 力度
  varying vec3 vWorld;

  void main() {
    vec2 p = vWorld.xz;
    float d = length(p - cameraPosition.xz);

    // ---- 水面的起伏：几道方向不同的波，直接求出坡度 ----
    vec2 slope = vec2(0.0);
    slope += vec2(1.6, 0.0) * cos(p.x * 1.6 + uTime * 0.9) * 0.05;
    slope += vec2(0.0, 2.3) * cos(p.y * 2.3 - uTime * 1.2) * 0.04;
    slope += vec2(1.1, 1.1) * cos((p.x + p.y) * 1.1 + uTime * 0.5) * 0.05;
    slope += vec2(3.7, -2.9) * cos(p.x * 3.7 - p.y * 2.9 + uTime * 1.7) * 0.012;

    // ---- 涟漪：一圈向外走的波 ----
    float foam = 0.0;
    for (int i = 0; i < ${RIPPLES}; i++) {
      vec4 r = uRipples[i];
      float age = uTime - r.z;
      if (r.w <= 0.0 || age < 0.0 || age > 4.0) continue;
      vec2 off = p - r.xy;
      float dist = length(off) + 1e-4;
      float radius = 0.25 + age * 2.1;
      float fade = r.w * exp(-age * 1.15);
      // 波峰在 radius 处，后面跟着两道小的
      float wave = (dist - radius) * 7.0;
      float ring = exp(-wave * wave * 0.12);
      slope += (off / dist) * cos(wave) * ring * fade * 0.55;
      foam += smoothstep(0.75, 1.0, cos(wave) * ring) * fade;
    }

    vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
    vec3 v = normalize(cameraPosition - vWorld);

    // ---- 水的本色：近处浅、远处深 ----
    vec3 col = mix(uNear, uFar, smoothstep(3.0, 45.0, d));

    // ---- 映着天：越斜着看反得越多 ----
    vec3 refl = reflect(-v, n);
    float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
    vec3 sky = mix(uHorizon, uSkyTop, pow(clamp(refl.y, 0.0, 1.0), 0.6));
    col = mix(col, sky, clamp(fres, 0.0, 1.0) * 0.75 * uReflect);

    // ---- 太阳的高光 ----
    float spec = pow(max(dot(refl, uSunDir), 0.0), 220.0);
    col += uSunCol * spec * 1.6;

    // ---- 波光：最亮的那一小段波峰（原来的卡通亮纹，留着） ----
    float w = sin(p.x * 1.6 + uTime * 0.9) + sin(p.y * 2.3 - uTime * 1.2) + sin((p.x + p.y) * 1.1 + uTime * 0.5);
    float glint = smoothstep(1.75, 2.05, w) * (1.0 - smoothstep(8.0, 48.0, d));
    col = mix(col, uGlint, glint * 0.5);

    // ---- 涟漪上的一圈白沫 ----
    col = mix(col, vec3(1.0), clamp(foam, 0.0, 1.0) * 0.7);

    col = mix(col, uHorizon, smoothstep(40.0, 115.0, d));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export interface Sea {
  mesh: THREE.Object3D;
  update(dt: number): void;
  /** 在 (x, z) 处起一圈涟漪，strength 约 0～1 */
  ripple(x: number, z: number, strength?: number): void;
  /** 0 白天 → 1 晚霞：水色、映的天色、太阳的颜色一起变 */
  setTone(k: number): void;
}

/** 白天、晚霞各一套水色 */
const TONE = {
  day: { near: 0x35d6e4, far: COLORS.deep, sun: 0xfff6d8 },
  dusk: { near: 0x3a8fb5, far: 0x1d2f6b, sun: 0xff9a52 },
};
/** 太阳的方向（和 stage.ts 里画的太阳一致：左前上方）；晚霞时落到地平线附近 */
const SUN_DAY = new THREE.Vector3(-34, 34, -110).normalize();
const SUN_DUSK = new THREE.Vector3(-34, 7, -110).normalize();

export function createSea(quality: 'low' | 'high'): Sea {
  const group = new THREE.Group();
  const seg = quality === 'high' ? 110 : 48;
  const ripples = Array.from({ length: RIPPLES }, () => new THREE.Vector4(0, 0, -99, 0));
  const uniforms = {
    uTime: { value: 0 },
    // 低画质不算"映着天"这一项
    uReflect: { value: quality === 'high' ? 1 : 0 },
    uNear: { value: new THREE.Color(TONE.day.near) },
    uFar: { value: new THREE.Color(TONE.day.far) },
    uGlint: { value: new THREE.Color(0xffffff) },
    uHorizon: { value: new THREE.Color(SKY.day.horizon) },
    uSkyTop: { value: new THREE.Color(SKY.day.top) },
    uSunDir: { value: SUN_DAY.clone() },
    uSunCol: { value: new THREE.Color(TONE.day.sun) },
    uRipples: { value: ripples },
  };
  const material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(260, 260, seg, seg), material);
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_Y;
  group.add(water);

  const c = (hex: number): THREE.Color => new THREE.Color(hex);
  const day = { near: c(TONE.day.near), far: c(TONE.day.far), sun: c(TONE.day.sun), horizon: c(SKY.day.horizon), top: c(SKY.day.top) };
  const dusk = { near: c(TONE.dusk.near), far: c(TONE.dusk.far), sun: c(TONE.dusk.sun), horizon: c(SKY.dusk.horizon), top: c(SKY.dusk.top) };
  let next = 0;
  let time = 0;

  return {
    mesh: group,
    update(dt) {
      time += dt;
      uniforms.uTime.value = time;
    },
    ripple(x, z, strength = 1) {
      ripples[next++ % RIPPLES].set(x, z, time, strength);
    },
    setTone(k) {
      uniforms.uNear.value.lerpColors(day.near, dusk.near, k);
      uniforms.uFar.value.lerpColors(day.far, dusk.far, k);
      uniforms.uSunCol.value.lerpColors(day.sun, dusk.sun, k);
      uniforms.uHorizon.value.lerpColors(day.horizon, dusk.horizon, k);
      uniforms.uSkyTop.value.lerpColors(day.top, dusk.top, k);
      uniforms.uSunDir.value.lerpVectors(SUN_DAY, SUN_DUSK, k).normalize();
    },
  };
}
