import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createSky, SKY } from './sky';

/**
 * 3D 舞台：晴天海面上的一座浮台。全部是代码生成的几何体，没有外部模型和贴图。
 *
 * 坐标就是全项目统一的"舞台空间"：x 朝玩家右手（屏幕右）、y 朝上、z 朝观众；
 * 小人站在原点、面朝 -z，墙从 -z 远处驶来。相机在小人背后偏上方。
 */
export const COLORS = {
  ink: 0x14213d,
  sea: 0x0fb5c9,
  deep: 0x0a7ea4,
  foam: 0xf7fdff,
  sun: 0xffc531,
  coral: 0xff5d4a,
  mint: 0x3ddc97,
  skyTop: 0x3fa9ee,
  skyMid: 0xa9defa,
  horizon: 0xe9f9ff,
};

/** 水面的高度。浮台顶面在 y = 0。 */
export const WATER_Y = -0.9;
const PLATFORM = { width: 3.6, depth: 1.7, thickness: 0.55 };
/** 泳道浮标绳离中线多远 */
const LANE_X = 3.0;
/** 双人：浮台和墙都加宽 1 米（墙的宽度见 field.ts 的 DUO_BOUNDS），浮标绳跟着往外挪 */
const WIDE = { platformWidth: 4.6, laneX: 3.55 };

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  resize(w: number, h: number): void;
  /** 每帧调用：云飘动、镜头震动衰减 */
  update(dt: number): void;
  render(): void;
  /** 震一下镜头，amount 约 0～1 */
  shake(amount: number): void;
  /** 台面上的站位圈：每位玩家脚下一个，xs 是他们各自站的左右位置 */
  setMarks(xs: number[]): void;
  /** 天色：0 白天 → 1 晚霞。天空、雾、灯光、太阳、云一起变（海面由 sea.setTone 跟着变） */
  setDusk(k: number): void;
  /**
   * 镜头的演出，每帧由 view.ts 写：
   *   push  往前推多少米（过墙的那一下）
   *   lift  抬高多少米（过关）
   *   orbit 绕着小人转过多少弧度（通关）
   *   tilt  0～1：退后一点、低头看台子前面的水（小人被撞下去的时候——平时那片水在画面下边缘以外）
   */
  cameraFx: { push: number; lift: number; orbit: number; tilt: number };
  /** 浮台的半宽、半深（碎块、彩纸、布娃娃碰它要用） */
  deck: { halfW: number; halfD: number };
  dispose(): void;
}

/** 晚霞时的灯光和雾（白天的就是下面创建它们时用的值） */
const DUSK = { fog: 0xf0a37c, hemiSky: 0xffe2cc, hemiGround: 0x7a78b8, hemi: 1.25, sun: 0xffb27a, sunPower: 1.5, disc: 0xffa24a, cloud: 0xffc4ac, discY: 9 };

/**
 * host：场景画在哪个元素里。画布由这里自己创建、销毁时自己拿走，不借用页面上现成的 <canvas>——
 * 这样销毁时可以放心地把 3D 上下文立刻还给浏览器（见 dispose）。
 */
export function createStage(host: HTMLElement, quality: 'low' | 'high', opts: { /** 双人：台子加宽 */ wide?: boolean } = {}): Stage {
  const platformWidth = opts.wide ? WIDE.platformWidth : PLATFORM.width;
  const laneX = opts.wide ? WIDE.laneX : LANE_X;
  // 画面的宽高比小于这个数，就把相机往后拉，保证整面墙都在画面里。双人的墙宽，所以更早开始拉
  const fitAspect = opts.wide ? 1.85 : 1.5;
  const renderer = new THREE.WebGLRenderer({ antialias: quality === 'high', powerPreference: 'high-performance' });
  const canvas = renderer.domElement;
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  host.appendChild(canvas);
  // 识别模型也在用显卡，画面这边不贪：像素比封顶
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'high' ? 2 : 1));
  renderer.shadowMap.enabled = quality === 'high';
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const sky = createSky();
  scene.add(sky.mesh);
  const fog = new THREE.Fog(COLORS.horizon, 34, 120);
  scene.fog = fog;

  // ---- 光 ----
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8fd6e6, 1.25);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1cf, 1.7);
  sun.position.set(4.5, 9, 6.5);
  sun.target.position.set(0, 0, -2);
  sun.castShadow = quality === 'high';
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -5;
  sun.shadow.camera.right = 5;
  sun.shadow.camera.top = 6;
  sun.shadow.camera.bottom = -4;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 30;
  sun.shadow.bias = -0.0015;
  scene.add(sun, sun.target);

  // ---- 太阳和云（不受雾影响，画在最远处） ----
  const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(6, 40), new THREE.MeshBasicMaterial({ color: 0xfff3b8, fog: false }));
  sunDisc.position.set(-34, 34, -110);
  const halo = new THREE.Mesh(new THREE.CircleGeometry(11, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, fog: false }));
  halo.position.set(-34, 34, -110.5);
  scene.add(halo, sunDisc);

  const cloudGeo = new THREE.SphereGeometry(1, 14, 10);
  const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
  const clouds: THREE.Group[] = [];
  const cloudSpots: [number, number, number, number][] = [
    [-46, 20, -105, 1.3],
    [-8, 27, -115, 1.0],
    [30, 17, -100, 1.5],
    [58, 26, -112, 1.1],
    [14, 12, -108, 0.8],
  ];
  for (const [x, y, z, s] of cloudSpots) {
    const cloud = new THREE.Group();
    const puffs: [number, number, number][] = [
      [0, 0, 3.4],
      [3.2, -0.3, 2.6],
      [-3.4, -0.4, 2.4],
      [1.2, 1.3, 2.4],
    ];
    for (const [px, py, r] of puffs) {
      const puff = new THREE.Mesh(cloudGeo, cloudMat);
      puff.position.set(px, py, 0);
      puff.scale.set(r, r * 0.62, r * 0.5);
      cloud.add(puff);
    }
    cloud.position.set(x, y, z);
    cloud.scale.setScalar(s);
    clouds.push(cloud);
    scene.add(cloud);
  }

  // ---- 浮台 ----
  const platform = new THREE.Group();
  const deck = new THREE.Mesh(new RoundedBoxGeometry(platformWidth, PLATFORM.thickness, PLATFORM.depth, 4, 0.1), new THREE.MeshStandardMaterial({ color: COLORS.foam, roughness: 0.8 }));
  deck.position.y = -PLATFORM.thickness / 2;
  deck.receiveShadow = true;
  // 一圈珊瑚色的防撞条
  const bumper = new THREE.Mesh(
    new RoundedBoxGeometry(platformWidth + 0.18, 0.26, PLATFORM.depth + 0.18, 4, 0.12),
    new THREE.MeshStandardMaterial({ color: COLORS.coral, roughness: 0.6 }),
  );
  bumper.position.y = -0.3;
  // 四角的黄色浮筒
  const floatGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.7, 16);
  const floatMat = new THREE.MeshStandardMaterial({ color: COLORS.sun, roughness: 0.5 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const f = new THREE.Mesh(floatGeo, floatMat);
      f.position.set(sx * (platformWidth / 2 - 0.25), WATER_Y + 0.1, sz * (PLATFORM.depth / 2 - 0.2));
      platform.add(f);
    }
  }
  // 站位标记：告诉人"站这儿"。每位玩家一个圈，位置由 setMarks 定
  const markGeo = new THREE.RingGeometry(0.34, 0.42, 40);
  const markMat = new THREE.MeshBasicMaterial({ color: COLORS.sea, transparent: true, opacity: 0.55 });
  const marks: THREE.Mesh[] = [];
  platform.add(deck, bumper);
  scene.add(platform);

  // ---- 泳道浮标绳：从远处一直排到浮台两侧，给"墙有多远"一个参照 ----
  const beadCount = 150;
  const beads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshStandardMaterial({ roughness: 0.5 }), beadCount);
  const m4 = new THREE.Matrix4();
  const tint = new THREE.Color();
  for (let i = 0; i < beadCount; i++) {
    const side = i % 2 ? 1 : -1;
    const k = Math.floor(i / 2);
    m4.makeScale(1, 0.9, 2.2).setPosition(side * laneX, WATER_Y + 0.03, 3.5 - k * 0.62);
    beads.setMatrixAt(i, m4);
    beads.setColorAt(i, tint.setHex(k % 2 ? COLORS.foam : COLORS.coral));
  }
  beads.instanceMatrix.needsUpdate = true;
  if (beads.instanceColor) beads.instanceColor.needsUpdate = true;
  scene.add(beads);

  // ---- 相机 ----
  const camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.1, 400);
  const basePos = new THREE.Vector3(0, 2.55, 5.6);
  const lookAt = new THREE.Vector3(0, 1.2, -3);
  /** 绕着转的时候看着小人头顶上方一点（多露出些天，烟花在那儿），而不是看着远处墙来的方向 */
  const focus = new THREE.Vector3(0, 2.0, 0);
  /** 低头看水的时候看这儿：台子前面的水面 */
  const water = new THREE.Vector3(0, -0.6, 1.6);
  const aim = new THREE.Vector3();
  const toAim = new THREE.Vector3();
  let shakeAmt = 0;
  let time = 0;

  // 白天 / 晚霞两套颜色之间插值用
  const tone = (day: number, dusk: number): { day: THREE.Color; dusk: THREE.Color } => ({ day: new THREE.Color(day), dusk: new THREE.Color(dusk) });
  const tones = {
    fog: tone(SKY.day.horizon, DUSK.fog),
    hemiSky: tone(0xffffff, DUSK.hemiSky),
    hemiGround: tone(0x8fd6e6, DUSK.hemiGround),
    sun: tone(0xfff1cf, DUSK.sun),
    disc: tone(0xfff3b8, DUSK.disc),
    cloud: tone(0xffffff, DUSK.cloud),
  };
  const discMat = sunDisc.material as THREE.MeshBasicMaterial;
  const haloMat = halo.material as THREE.MeshBasicMaterial;

  const stage: Stage = {
    renderer,
    scene,
    camera,
    resize(w, h) {
      renderer.setSize(w, h, false);
      const aspect = w / Math.max(1, h);
      camera.aspect = aspect;
      // 画面窄（竖屏、小窗口）时把相机往后拉，保证整面墙都在画面里
      const pull = aspect < fitAspect ? Math.pow(fitAspect / aspect, 0.95) : 1;
      basePos.set(0, 2.55 + (pull - 1) * 1.2, 5.6 * pull);
      camera.updateProjectionMatrix();
    },
    update(dt) {
      time += dt;
      shakeAmt *= Math.exp(-7 * dt);
      for (let i = 0; i < clouds.length; i++) clouds[i].position.x += dt * (0.25 + i * 0.05);
      for (const c of clouds) if (c.position.x > 90) c.position.x = -90;
      const { push, lift, orbit, tilt } = stage.cameraFx;
      camera.position.copy(basePos);
      camera.position.y += 0.9 * tilt;
      camera.position.z += 1.4 * tilt;
      // 绕着小人转：相机在以小人为圆心的圆上走；转起来之后改成看着小人
      if (orbit !== 0) {
        const r = Math.hypot(basePos.x, basePos.z);
        camera.position.x = Math.sin(orbit) * r;
        camera.position.z = Math.cos(orbit) * r;
      }
      camera.position.y += lift;
      aim.lerpVectors(lookAt, focus, Math.min(1, Math.abs(orbit) * 2.5));
      if (tilt > 0) aim.lerp(water, tilt);
      if (push !== 0) camera.position.add(toAim.subVectors(aim, camera.position).normalize().multiplyScalar(push));
      if (shakeAmt > 0.002) {
        camera.position.x += Math.sin(time * 71) * shakeAmt * 0.14;
        camera.position.y += Math.sin(time * 93 + 1) * shakeAmt * 0.1;
      }
      camera.lookAt(aim);
    },
    render() {
      renderer.render(scene, camera);
    },
    shake(amount) {
      shakeAmt = Math.max(shakeAmt, amount);
    },
    cameraFx: { push: 0, lift: 0, orbit: 0, tilt: 0 },
    deck: { halfW: platformWidth / 2, halfD: PLATFORM.depth / 2 },
    setDusk(k) {
      sky.setDusk(k);
      fog.color.lerpColors(tones.fog.day, tones.fog.dusk, k);
      hemi.color.lerpColors(tones.hemiSky.day, tones.hemiSky.dusk, k);
      hemi.groundColor.lerpColors(tones.hemiGround.day, tones.hemiGround.dusk, k);
      hemi.intensity = 1.25 + (DUSK.hemi - 1.25) * k;
      sun.color.lerpColors(tones.sun.day, tones.sun.dusk, k);
      sun.intensity = 1.7 + (DUSK.sunPower - 1.7) * k;
      discMat.color.lerpColors(tones.disc.day, tones.disc.dusk, k);
      haloMat.color.lerpColors(tones.cloud.day, tones.disc.dusk, k);
      // 太阳落到地平线附近
      sunDisc.position.y = halo.position.y = 34 + (DUSK.discY - 34) * k;
      cloudMat.color.lerpColors(tones.cloud.day, tones.cloud.dusk, k);
    },
    setMarks(xs) {
      while (marks.length < xs.length) {
        const mark = new THREE.Mesh(markGeo, markMat);
        mark.rotation.x = -Math.PI / 2;
        mark.position.y = 0.004;
        marks.push(mark);
        platform.add(mark);
      }
      marks.forEach((mark, i) => {
        mark.visible = i < xs.length;
        if (i < xs.length) mark.position.x = xs[i];
      });
    },
    dispose() {
      disposeObject(scene);
      renderer.dispose();
      // 浏览器同时能开的 3D 上下文有限（Chrome 是 16 个）。光 dispose 不会把上下文还回去，要等画布被垃圾回收；
      // 进进出出几次就可能攒到上限。所以明确地还掉。上下文一旦还掉，这块画布就再也用不了了——
      // 这正是画布要由场景自己创建的原因：下一个场景会建一块新的。
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
  stage.setMarks([0]);
  stage.resize(host.clientWidth || 1280, host.clientHeight || 720);
  stage.update(0);
  return stage;
}

/** 释放一个物体（及其子孙）占用的显存：几何体、材质、贴图。标了 userData.shared 的贴图是几个物体共用的，不在这里释放。 */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const mat of mats) {
      for (const value of Object.values(mat)) if (value instanceof THREE.Texture && !value.userData.shared) value.dispose();
      mat.dispose();
    }
  });
}
