import * as THREE from 'three';

/**
 * 天空：一个从里面看的大球，着色器里按高度画三段渐变（天顶 → 中段 → 地平线）。
 *
 * 之所以不用一张固定的背景图：通关时天色要从白天**渐渐变成晚霞**——烟花在大白天的蓝天上显不出来。
 * 白天、晚霞两套颜色都在这里；别处（雾、灯光、海面、云）跟着同一个 0～1 的数一起变，见 stage.ts 的 setDusk。
 */
export const SKY = {
  day: { top: 0x3fa9ee, mid: 0xa9defa, horizon: 0xe9f9ff },
  dusk: { top: 0x26286b, mid: 0xb4557f, horizon: 0xffb56b },
};

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // 永远画在最远处
  }
`;
const FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uMid;
  uniform vec3 uHorizon;
  varying vec3 vDir;
  void main() {
    float h = clamp(vDir.y, 0.0, 1.0);
    // 地平线附近一条亮带，往上过渡到中段，再到天顶
    vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.22, h));
    col = mix(col, uTop, smoothstep(0.18, 0.75, h));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export interface Sky {
  mesh: THREE.Mesh;
  /** 0 白天 → 1 晚霞 */
  setDusk(k: number): void;
}

export function createSky(): Sky {
  const uniforms = {
    uTop: { value: new THREE.Color(SKY.day.top) },
    uMid: { value: new THREE.Color(SKY.day.mid) },
    uHorizon: { value: new THREE.Color(SKY.day.horizon) },
  };
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false }));
  mesh.scale.setScalar(300);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  const day = { top: new THREE.Color(SKY.day.top), mid: new THREE.Color(SKY.day.mid), horizon: new THREE.Color(SKY.day.horizon) };
  const dusk = { top: new THREE.Color(SKY.dusk.top), mid: new THREE.Color(SKY.dusk.mid), horizon: new THREE.Color(SKY.dusk.horizon) };
  return {
    mesh,
    setDusk(k) {
      uniforms.uTop.value.lerpColors(day.top, dusk.top, k);
      uniforms.uMid.value.lerpColors(day.mid, dusk.mid, k);
      uniforms.uHorizon.value.lerpColors(day.horizon, dusk.horizon, k);
    },
  };
}
