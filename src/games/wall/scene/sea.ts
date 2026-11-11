import * as THREE from 'three';
import { COLORS, WATER_Y } from './stage';

/**
 * 卡通水面：一张大平面 + 一小段着色器。
 *   顶点：叠两道正弦波，让水面缓缓起伏；
 *   片元：近处浅、远处深；再用几道正弦波叠出来的"亮纹"当波光，最后融进地平线的颜色。
 * 没有反射、没有折射——集成显卡也跑得动，而且识别模型还要用显卡。
 */
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
  uniform vec3 uNear;
  uniform vec3 uFar;
  uniform vec3 uGlint;
  uniform vec3 uHorizon;
  varying vec3 vWorld;
  void main() {
    float d = length(vWorld.xz - cameraPosition.xz);
    vec3 col = mix(uNear, uFar, smoothstep(3.0, 45.0, d));
    // 波光：三道方向不同的波叠加，只留最亮的一小段
    float w = sin(vWorld.x * 1.6 + uTime * 0.9) + sin(vWorld.z * 2.3 - uTime * 1.2) + sin((vWorld.x + vWorld.z) * 1.1 + uTime * 0.5);
    float glint = smoothstep(1.75, 2.05, w) * (1.0 - smoothstep(8.0, 48.0, d));
    col = mix(col, uGlint, glint * 0.6);
    col = mix(col, uHorizon, smoothstep(40.0, 115.0, d));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export interface Sea {
  mesh: THREE.Object3D;
  update(dt: number): void;
  /** 在 (x, z) 处溅起一圈水纹 */
  splash(x: number, z: number): void;
}

export function createSea(quality: 'low' | 'high'): Sea {
  const group = new THREE.Group();
  const seg = quality === 'high' ? 110 : 48;
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uNear: { value: new THREE.Color(0x35d6e4) },
      uFar: { value: new THREE.Color(COLORS.deep) },
      uGlint: { value: new THREE.Color(0xffffff) },
      uHorizon: { value: new THREE.Color(COLORS.horizon) },
    },
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(260, 260, seg, seg), material);
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_Y;
  group.add(water);

  // 水纹：几个扁圆环轮流用，放大的同时变淡
  const rings = Array.from({ length: 4 }, () => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    group.add(ring);
    return { ring, age: 99 };
  });
  let nextRing = 0;
  let time = 0;

  return {
    mesh: group,
    update(dt) {
      time += dt;
      material.uniforms.uTime.value = time;
      for (const r of rings) {
        if (!r.ring.visible) continue;
        r.age += dt;
        const k = r.age / 1.1;
        if (k >= 1) {
          r.ring.visible = false;
          continue;
        }
        // age 为负表示还在等（第二圈比第一圈晚一点出来）
        r.ring.scale.setScalar(0.3 + Math.max(0, k) * 2.4);
        (r.ring.material as THREE.MeshBasicMaterial).opacity = k < 0 ? 0 : 0.85 * (1 - k);
      }
    },
    splash(x, z) {
      // 连出两圈，一大一小
      for (const delay of [0, 0.18]) {
        const r = rings[nextRing++ % rings.length];
        r.ring.position.set(x, WATER_Y + 0.09, z);
        r.age = -delay;
        r.ring.visible = true;
        r.ring.scale.setScalar(0.3);
      }
    },
  };
}
