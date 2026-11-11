# 体感框架 + 「别撞墙！」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出一套浏览器摄像头体感框架和一个 3D 穿墙摆姿势游戏「别撞墙！」，外加姿势实验室和一个示例小游戏。

**Architecture:** 六层流水线，全部在浏览器本地：`PoseSource`（摄像头 / 模拟 / 回放）产出原始关键点 → `PlayerTracker` 选人、换算成米制、滤波、算动作特征 → 游戏读 `PlayerState`。墙是网格上的标量场（人形洞由正向运动学骨架膨胀而来，几何洞由 SDF 基本形状拼成），同一份数据生成 3D 网格并用于几何判定；人形洞按关节角判定。游戏逻辑是不依赖渲染的纯状态机，可用模拟玩家整局测试。

**Tech Stack:** Vite 8 · TypeScript 7 · React 19 · Three.js 0.187 · `@mediapipe/tasks-vision` 1.2 · Vitest 5 · 零依赖的 Chrome DevTools 协议脚本做端到端检查。

**Spec:** `docs/superpowers/specs/2026-11-10-wall-pose-game-design.md`（背景分析见 `docs/tech-analysis.md`）

## Global Constraints

- 安装依赖必须绕开代理并走镜像：`env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy npm install --registry=https://registry.npmmirror.com`；项目自带 `.npmrc`（`registry=https://registry.npmmirror.com`）。
- 模型从 `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_{lite|full}/float16/latest/…` 用 `curl` 下载（走环境代理）；运行时**不依赖任何外部 CDN**，识别库和模型都在 `public/` 下。
- **项目不是 git 仓库，用户没要求提交：所有任务都没有 commit 步骤。**
- 命名：游戏「别撞墙！」，项目「体感工坊」，集中在 `src/brand.ts`。代码、文案、文件名里**不得出现**"墙来了""动动乐园"；不使用站酷快乐体、Nunito；不使用原站配色 `#ff6b6b #ffd93d #6bcb77 #4d96ff #b983ff`、奶油色卡片加粉褐厚边、糖果积木标题字的观感。
- 界面文案全部中文；不引入任何外部美术或音频素材（几何体、着色器、Web Audio 合成）。
- 摄像头画面不得进入任何网络请求。
- 所有可调数值集中在 `src/games/wall/tuning.ts`。人形洞角度容差：轻松 40°、标准 32°、挑战 25°。
- 测试不得依赖真实摄像头或真人：单元测试用 `SimPoseSource`，端到端用假摄像头。
- 坐标约定（全项目统一）：**舞台空间**单位米，`x` 向玩家右手为正（屏幕右）、`y` 向上、`z` 朝观众为正（小人面朝 `-z`，墙从 `-z` 驶来），地面 `y = 0`，玩家标定位置 `x = 0`。朝向角：`0°` 朝下、`90°` 水平朝该侧外、`180°` 朝上。左 / 右一律指**玩家自己的**左右。
- 单元测试与源码同目录：`src/**/*.test.ts`，运行 `npx vitest run <文件>`。

## Review Focus

规格没逐条写、但真人用起来最容易踩到的五种情况，每条都在对应任务里有测试钉住：

1. **摄像头打不开**（拒绝授权 / 没有设备 / 被占用）：应给出中文原因和解决办法，并提供"用演示模式看看"的出路，而不是白屏。→ Task 18 `mapCameraError` 测试。
2. **人走出画面，或旁人闯入**：应自动暂停、不扣命；应继续跟住原来的玩家。→ Task 8、Task 17 测试。
3. **只看得到上半身，或举手出画**：不应出需要看不见部位的墙。→ Task 16 测试。
4. **标签页切到后台 / 帧间隔暴增**：不应让墙瞬间"到达"判撞。→ Task 17 `maxDtSec` 测试。
5. **模型或识别库加载失败、GPU 不可用**：应回退 CPU；仍失败时给出含 `npm run setup` 的提示和重试。→ Task 18 测试。

---

## File Structure

```
package.json  .npmrc  .gitignore  tsconfig.json  vite.config.ts  index.html  README.md
scripts/setup-assets.mjs            复制 wasm、下载模型和测试照片
tools/cdp.mjs                       零依赖 Chrome DevTools 协议驱动
tools/make-fake-cam.mjs             照片 → 720p 基线 JPEG → MJPEG 假摄像头文件
tools/e2e.mjs                       端到端检查
public/models/  public/mediapipe/wasm/   （脚本生成，不入库）   public/custom-poses.json（按需生成）
src/
  main.tsx  App.tsx  brand.ts
  engine/
    util/        math.ts  sdf.ts  rng.ts  emitter.ts
    body/        landmarks.ts  profile.ts  metric.ts  pose.ts  bodyModel.ts  __fixtures__/warrior-full.json
    tracking/    oneEuro.ts  selectPerson.ts
    input/       types.ts  simSource.ts  cameraSource.ts  replaySource.ts  recorder.ts
    motion/      features.ts
    player/      playerTracker.ts
    camera/      camera.ts
    vision/      assets.ts  convert.ts  poseDetector.ts
    audio/       sfx.ts  speech.ts
    ui/          airCursor.ts
  games/
    types.ts  index.ts              GameModule 接口与注册表
    wall/        tuning.ts  poses.ts  shapes.ts  bodyShape.ts  field.ts  contour.ts  judge.ts  levels.ts  build.ts  game.ts  customPoses.ts
                 scene/ stage.ts  sea.ts  avatar.ts  wallMesh.ts  ghost.ts  fx.ts  view.ts
                 WallPlay.tsx  hud/*.tsx
    bubbles/     index.ts
  app/           router.ts  settings.ts  useEngine.ts  pages/Home.tsx  pages/Play.tsx  pages/Lab.tsx  components/*.tsx  styles/*.css
```

---

### Task 1: 脚手架与资源脚本

**Files:**
- Create: `package.json` `.npmrc` `.gitignore` `tsconfig.json` `vite.config.ts` `index.html` `src/main.tsx` `src/App.tsx` `src/brand.ts` `src/vite-env.d.ts` `scripts/setup-assets.mjs` `src/brand.test.ts`

**Interfaces:**
- Produces: npm 脚本 `dev` `build`（`tsc --noEmit && vite build`）`preview` `test`（`vitest run`）`setup`（`node scripts/setup-assets.mjs`）`e2e`（`node tools/e2e.mjs`）；`BRAND = { studio: '体感工坊', studioEn: 'Motion Workshop', wallGame: '别撞墙！' } as const`；开发服务器端口 `5188`。

- [ ] **Step 1:** 写 `package.json`：dependencies `react ^19.3` `react-dom ^19.3` `three ^0.187` `@mediapipe/tasks-vision ^1.2.2` `@fontsource/zcool-qingke-huangyou ^5.3`；devDependencies `vite ^8.3` `typescript ^7.0` `vitest ^5.1` `@vitejs/plugin-react ^6.3` `@types/react ^19.3` `@types/react-dom ^19.3` `@types/three ^0.187` `@types/node ^24`。`.npmrc` 写镜像源。`.gitignore`：`node_modules dist public/models public/mediapipe tests/fixtures/photos *.mjpeg`。
- [ ] **Step 2:** `tsconfig.json`（`strict`、`target ES2022`、`module ESNext`、`moduleResolution bundler`、`jsx react-jsx`、`noUnusedLocals`、`resolveJsonModule`、`types: ["vite/client"]`）；`vite.config.ts`（react 插件、`server.port 5188`、`test: { include: ['src/**/*.test.ts'], environment: 'node' }`）。
- [ ] **Step 3:** 按 Global Constraints 的命令安装依赖。Expected：退出码 0，`node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm` 存在。
- [ ] **Step 4:** 写 `scripts/setup-assets.mjs`：把 `node_modules/@mediapipe/tasks-vision/wasm/*` 复制到 `public/mediapipe/wasm/`；用 `curl -L --fail --max-time 300 -o` 下载 `pose_landmarker_lite.task`（应为 5777746 字节）、`pose_landmarker_full.task`（9398198 字节）到 `public/models/`，以及 `https://storage.googleapis.com/mediapipe-assets/pose.jpg`（44100 字节）到 `tests/fixtures/photos/pose.jpg`；已存在且大小正确则跳过；任何一项失败以非零码退出并打印是哪一项。
- [ ] **Step 5:** Run `npm run setup`。Expected：五类文件逐项打印 `ok`，再跑一次全部打印 `skip`。
- [ ] **Step 6:** 写 `src/brand.ts` 和占位的 `index.html` / `main.tsx` / `App.tsx`（只渲染项目名）。写 `src/brand.test.ts`：

```ts
it('uses the agreed names and none of the banned ones', () => {
  expect(BRAND.wallGame).toBe('别撞墙！');
  expect(BRAND.studio).toBe('体感工坊');
  expect(JSON.stringify(BRAND)).not.toMatch(/墙来了|动动乐园/);
});
```

- [ ] **Step 7:** Run `npm test` → PASS；Run `npm run build` → 退出码 0，生成 `dist/index.html`。

---

### Task 2: 基础工具（数学、SDF、随机数、事件）

**Files:**
- Create: `src/engine/util/math.ts` `sdf.ts` `rng.ts` `emitter.ts` 及各自的 `.test.ts`

**Interfaces — Produces:**

```ts
// math.ts
export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }
export const clamp: (v: number, lo: number, hi: number) => number
export const clamp01: (v: number) => number
export const lerp: (a: number, b: number, t: number) => number
export const damp: (cur: number, target: number, lambda: number, dt: number) => number  // cur + (target-cur)*(1-exp(-lambda*dt))
export const deg2rad: (d: number) => number
export const rad2deg: (r: number) => number
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number
export function polygonArea(pts: Vec2[]): number            // 有符号，逆时针为正
export function pointInPolygon(p: Vec2, pts: Vec2[]): boolean
export function median(xs: number[]): number
export function percentile(xs: number[], p: number): number // p∈[0,1]，线性插值
// sdf.ts —— 约定：洞内为负
export type Sdf = (x: number, y: number) => number
export function sdCircle(cx: number, cy: number, r: number): Sdf
export function sdBox(cx: number, cy: number, hx: number, hy: number, round?: number): Sdf
export function sdCapsule(ax: number, ay: number, bx: number, by: number, r: number): Sdf
export function sdTriangle(a: Vec2, b: Vec2, c: Vec2): Sdf
export function union(...s: Sdf[]): Sdf
export function inflate(s: Sdf, d: number): Sdf
// rng.ts
export interface Rng { next(): number; int(lo: number, hi: number): number; pick<T>(xs: readonly T[]): T; shuffle<T>(xs: readonly T[]): T[]; chance(p: number): boolean; gauss(): number }
export function createRng(seed: number): Rng   // mulberry32
// emitter.ts
export class Emitter<T> { on(cb: (v: T) => void): () => void; emit(v: T): void; clear(): void }
```

- [ ] **Step 1: 写失败的测试**（节选关键断言，其余同类）：

```ts
expect(segDist(0, 1, -1, 0, 1, 0)).toBeCloseTo(1); expect(segDist(3, 0, -1, 0, 1, 0)).toBeCloseTo(2);
expect(polygonArea([{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}])).toBeCloseTo(1);
expect(damp(0, 1, Math.LN2, 1)).toBeCloseTo(0.5);
expect(percentile([1,2,3,4,5], 0.9)).toBeCloseTo(4.6); expect(median([3,1,2])).toBe(2);
expect(sdCircle(0,0,1)(2,0)).toBeCloseTo(1); expect(sdCircle(0,0,1)(0,0)).toBeCloseTo(-1);
expect(sdBox(0,0,1,2)(3,0)).toBeCloseTo(2); expect(sdBox(0,0,1,2)(0,0)).toBeCloseTo(-1);
expect(sdCapsule(0,0,0,2,0.5)(1,1)).toBeCloseTo(0.5);
expect(sdTriangle({x:-1,y:0},{x:1,y:0},{x:0,y:2})(0,0.5)).toBeLessThan(0);
expect(sdTriangle({x:-1,y:0},{x:1,y:0},{x:0,y:2})(0,-1)).toBeCloseTo(1);
expect(inflate(sdCircle(0,0,1), 0.5)(1.5,0)).toBeCloseTo(0);
// rng：同种子序列相同；int(2,5) 抽 1000 次都在 [2,5] 且 2 和 5 都出现；shuffle 是排列；
// 4000 个 gauss 的均值绝对值 < 0.08、标准差在 1±0.08
```

- [ ] **Step 2:** Run `npx vitest run src/engine/util` → FAIL（模块不存在）。
- [ ] **Step 3:** 实现四个文件。
- [ ] **Step 4:** Run `npx vitest run src/engine/util` → PASS。

---

### Task 3: 一欧元滤波器

**Files:** Create `src/engine/tracking/oneEuro.ts` `oneEuro.test.ts`

**Interfaces — Produces:**

```ts
export interface OneEuroOpts { minCutoff: number; beta: number; dCutoff: number }   // 默认 { minCutoff: 1.5, beta: 3, dCutoff: 1.2 }
export class OneEuro { constructor(opts?: Partial<OneEuroOpts>); filter(x: number, tSec: number): number; reset(): void }
export class OneEuroArray { constructor(n: number, opts?: Partial<OneEuroOpts>); filter(input: ArrayLike<number>, tSec: number, out?: Float32Array): Float32Array; reset(): void }
```

- [ ] **Step 1: 写失败的测试**
  - 第一个样本原样返回。
  - 静止带噪信号（`1 + 0.01·gauss`，30 Hz，3 秒）：后 60 个输出的标准差 < 输入标准差的 0.4 倍。
  - 阶跃 0→1：阶跃后 0.2 秒内输出 > 0.9。
  - 时间戳不前进（`dt <= 0`）时返回上一次的值，不产生 `NaN`。
  - `OneEuroArray` 对每个分量的结果与单独的 `OneEuro` 相同。
- [ ] **Step 2:** Run → FAIL。 **Step 3:** 实现（`alpha(cutoff, dt) = 1 / (1 + 1/(2π·cutoff·dt))`）。 **Step 4:** Run → PASS。

---

### Task 4: 关键点索引、输入类型、身材参数

**Files:** Create `src/engine/body/landmarks.ts` `src/engine/input/types.ts` `src/engine/body/profile.ts` `profile.test.ts`

**Interfaces — Produces:**

```ts
// landmarks.ts
export const LM = { nose: 0, leftEye: 2, rightEye: 5, leftEar: 7, rightEar: 8, leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16, leftPinky: 17, rightPinky: 18, leftIndex: 19, rightIndex: 20, leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28, leftHeel: 29, rightHeel: 30, leftFoot: 31, rightFoot: 32 } as const
export const LM_COUNT = 33
export const CORE_LM: readonly number[]   // [0,11,12,13,14,15,16,23,24,25,26,27,28]
// input/types.ts
export interface Lm { x: number; y: number; z: number; v: number }
export interface RawPose { image: Lm[]; world: Lm[] }        // image：未镜像的归一化坐标；world：MediaPipe 世界坐标（米）
export interface RawFrame { t: number; aspect: number; poses: RawPose[] }   // t 毫秒、单调递增；aspect = 视频宽 / 高
export interface SourceStats { fps: number; detectMs: number; delegate: string; model: string }
export interface PoseSource { readonly kind: 'camera' | 'sim' | 'replay'; readonly video: HTMLVideoElement | null;
  start(): Promise<void>; stop(): void; onFrame(cb: (f: RawFrame) => void): () => void; stats(): SourceStats }
// profile.ts
export interface BodyProfile { shoulderW: number; hipW: number; torso: number; neck: number; headR: number; upperArm: number; forearm: number; hand: number;
  thigh: number; shin: number; foot: number;
  r: { arm: number; forearm: number; hand: number; thigh: number; shin: number; foot: number; torso: number; shoulder: number; pelvis: number } }
export const ANKLE_H = 0.07
export function defaultProfile(): BodyProfile
export function standHipHeight(p: BodyProfile): number     // thigh + shin + ANKLE_H
export function standHeight(p: BodyProfile): number        // standHipHeight + torso + neck + headR
export function scaleProfile(p: BodyProfile, k: number): BodyProfile
```

`defaultProfile()` 的值（来自对真实模型输出的测量）：`shoulderW .32, hipW .20, torso .50, neck .19, headR .11, upperArm .26, forearm .24, hand .08, thigh .37, shin .38, foot .16`；`r: arm .045, forearm .04, hand .05, thigh .07, shin .055, foot .045, torso .13, shoulder .06, pelvis .085`。

- [ ] **Step 1: 测试** `standHipHeight(defaultProfile())` ≈ 0.82；`standHeight` ≈ 1.62；`scaleProfile(p, 0.8).thigh` ≈ 0.296 且 `.r.arm` ≈ 0.036；`defaultProfile()` 每次返回新对象。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。

---

### Task 5: 图像坐标 → 米制（相似变换拟合）

**Files:** Create `src/engine/vision/convert.ts` `src/engine/body/metric.ts` `metric.test.ts` `src/engine/body/__fixtures__/warrior-full.json`

夹具：把草稿目录里 `sample/probe-full.json` 的 `{ w, h, landmarks, world }` 四个字段原样存入（官方 full 模型对 MediaPipe 公开测试图的输出，纯数字）。

**Interfaces — Produces:**

```ts
// convert.ts
export function toRawPose(landmarks: { x: number; y: number; z: number; visibility?: number }[], world: { x: number; y: number; z: number }[]): RawPose
// metric.ts
export interface Similarity { s: number; tu: number; tv: number; n: number }     // image(u = x·aspect, v = y) ≈ s·world(x, y) + (tu, tv)
export function fitSimilarity(pose: RawPose, aspect: number, minVis?: number): Similarity | null   // 用 CORE_LM 中可见度 ≥ minVis(0.5) 的点加权最小二乘；少于 4 个或退化返回 null
export interface MetricPose { joints: Vec3[]; vis: number[]; sim: Similarity }  // 以髋为原点、舞台轴向
export function toMetric(pose: RawPose, aspect: number, sim: Similarity, zGain?: number): MetricPose
// 映射：x = -(u - tu)/s，y = -(v - tv)/s，z = world.z · zGain（默认 0.6）
```

- [ ] **Step 1: 写失败的测试**（夹具，`aspect = 1000/667`）：

```ts
const sim = fitSimilarity(pose, 1000 / 667)!;
expect(sim.n).toBe(13); expect(sim.s).toBeGreaterThan(0.455); expect(sim.s).toBeLessThan(0.480);
const m = toMetric(pose, 1000 / 667, sim);
expect(m.joints[LM.leftWrist].x).toBeLessThan(-0.58);   // 玩家的左手在 -x
expect(m.joints[LM.rightWrist].x).toBeGreaterThan(0.56);
expect(m.joints[LM.nose].y).toBeGreaterThan(0.52);      // 头在髋上方
expect(m.joints[LM.leftAnkle].y).toBeLessThan(-0.38);
expect(m.joints[LM.nose].z).toBeLessThan(0);            // 身体正面朝 -z
// 13 个核心点：米制正面位置与"镜像后的世界坐标正面投影"的平均距离 < 0.03
expect(fitSimilarity(allInvisible, 1.5)).toBeNull();
expect(fitSimilarity(onlyThreeVisible, 1.5)).toBeNull();
```

- [ ] **Step 2–4:** FAIL → 实现 → PASS。

---

### Task 6: 姿势描述、正向运动学、角度测量、身材估计

**Files:** Create `src/engine/body/pose.ts` `pose.test.ts`；Modify `src/engine/body/profile.ts`（加 `ProfileEstimator`）`profile.test.ts`

**Interfaces — Produces:**

```ts
export interface Limb { a: number; s?: number }            // a：朝向角；s：正面长度比例（缺省 1，<1 表示朝向镜头而缩短）
export interface PoseSpec { id: string; name: string; tier: 1 | 2 | 3 | 4; upperOk: boolean; say?: string;
  armL: [Limb, Limb]; armR: [Limb, Limb];                   // [上臂, 前臂]
  legL: [Limb, Limb]; legR: [Limb, Limb];                   // [大腿, 小腿]
  spine?: Limb;                                             // a：倾角，0 直立，正值朝玩家右侧；s 同时作用于躯干和颈部
  head?: number }                                           // 头相对脊柱的偏角
export const JOINTS = ['head','neck','shoulderL','shoulderR','elbowL','elbowR','wristL','wristR','handL','handR','hipC','hipL','hipR','kneeL','kneeR','ankleL','ankleR','toeL','toeR'] as const
export type JointName = typeof JOINTS[number]
export type Skeleton = Record<JointName, Vec3>             // 舞台空间
export const LIMBS = ['upperArmL','forearmL','upperArmR','forearmR','thighL','shinL','thighR','shinR','spine'] as const
export type LimbId = typeof LIMBS[number]
export const DEFAULT_ARM: [Limb, Limb]   // [{a:8},{a:4}]
export const DEFAULT_LEG: [Limb, Limb]   // [{a:4},{a:0}]
export function limbAngle(fromX: number, fromY: number, toX: number, toY: number, side: -1 | 1): number   // (-180, 180]
export function angleDiff(a: number, b: number): number     // 0..180
export function poseToSkeleton(spec: PoseSpec, profile: BodyProfile, at?: { x?: number }): Skeleton   // 最低的脚踝落在 y = ANKLE_H
export function measureLimbs(sk: Skeleton, profile: BodyProfile): Record<LimbId, { angle: number; scale: number }>
export function targetLimbs(spec: PoseSpec): Record<LimbId, { angle: number; scale: number }>
export function poseFromSkeleton(sk: Skeleton, profile: BodyProfile): Pick<PoseSpec, 'armL' | 'armR' | 'legL' | 'legR' | 'spine'>  // 角度取整到 1°，比例到 0.05
export function mirrorPose(spec: PoseSpec): PoseSpec        // id 加后缀 '~m'
export function lerpSkeleton(a: Skeleton, b: Skeleton, k: number): Skeleton
// profile.ts 追加
export class ProfileEstimator { constructor(base?: BodyProfile); observe(sk: Skeleton, ok: Record<JointName, boolean>): void; readonly profile: BodyProfile; readonly ready: boolean; reset(): void }
```

正向运动学的定义（实现者不能自定的部分）：右侧肢体方向向量 `(sin a, −cos a)`，左侧 `(−sin a, −cos a)`；脊柱从 `hipC` 指向 `(sin lean, cos lean)`，肩线垂直于脊柱；`hipL = hipC − (hipW/2, 0)`；`head = neck + neck长·s·(sin(lean+head), cos(lean+head))`；`hand = wrist + hand长·前臂方向`；`toe = ankle + (侧向 0.05, −0.05)`；先以 `hipC = (0,0)` 算腿，再整体上移使 `min(ankleL.y, ankleR.y) = ANKLE_H`。`ProfileEstimator`：每段骨头保留最近 90 个正面长度（左右合并），取 90 分位，夹在默认值的 0.7～1.4 倍；手臂和躯干各有 ≥ 20 个样本后 `ready`，之前返回 `base`。

- [ ] **Step 1: 写失败的测试**

```ts
expect(limbAngle(0,0, 0,-1, 1)).toBeCloseTo(0);  expect(limbAngle(0,0, 1,0, 1)).toBeCloseTo(90);
expect(limbAngle(0,0, -1,0, -1)).toBeCloseTo(90); expect(limbAngle(0,0, 0,1, 1)).toBeCloseTo(180);
expect(limbAngle(0,0, -1,0, 1)).toBeCloseTo(-90);
expect(angleDiff(170, -170)).toBeCloseTo(20);     expect(angleDiff(10, 350)).toBeCloseTo(20);
const st = poseToSkeleton(STAND, defaultProfile());            // 测试内自建 STAND / T / 深蹲等 PoseSpec
expect(st.hipC.y).toBeCloseTo(0.82, 2); expect(st.ankleL.y).toBeCloseTo(0.07); expect(st.head.y).toBeCloseTo(1.51, 2);
expect(st.shoulderR.x).toBeCloseTo(0.16); expect(st.shoulderL.x).toBeCloseTo(-0.16);
const t = poseToSkeleton(T, defaultProfile());
expect(t.wristR.x).toBeCloseTo(0.66); expect(t.wristR.y).toBeCloseTo(1.32); expect(t.wristL.x).toBeCloseTo(-0.66);
expect(poseToSkeleton(CROUCH, defaultProfile()).hipC.y).toBeLessThan(0.7);
expect(poseToSkeleton(T, defaultProfile(), { x: 0.4 }).hipC.x).toBeCloseTo(0.4);
// 往返：对 T、Y、不对称、侧倾 20°、深蹲五个姿势，poseFromSkeleton(poseToSkeleton(p)) 的角度差 ≤ 0.5°、比例差 ≤ 0.03
// mirrorPose(mirrorPose(p)) 与 p 深度相等（id 除外）；mirror 后的骨架是原骨架的 x 翻转
// ProfileEstimator：用自定身材（thigh .30, upperArm .22, shoulderW .26）的 FK 骨架喂 60 帧随机手臂角度、5mm 噪声，
//   估计值与真值相差 < 0.015；其中 30% 帧肢体缩短到 0.5 时仍 < 0.02；不足 20 帧时 profile 等于 base 且 ready 为 false
```

- [ ] **Step 2–4:** FAIL → 实现 → PASS。

---

### Task 7: 模拟玩家

**Files:** Create `src/engine/input/simSource.ts` `simSource.test.ts`

**Interfaces:**
- Consumes: `poseToSkeleton`、`fitSimilarity`、`toMetric`、`createRng`。
- Produces:

```ts
export interface SimCamera { aspect: number; s: number; groundV: number }    // 默认 { 16/9, 0.42, 0.95 }：u = aspect/2 − x·s，v = groundV − y·s
export function skeletonToJoints33(sk: Skeleton, profile: BodyProfile): { joints: Vec3[]; vis: number[] }   // 补齐鼻、眼、耳、指根、脚跟等 33 个点
export function jointsToRawPose(joints: Vec3[], vis: number[], cam: SimCamera, zGain?: number): RawPose
export class SimPoseSource implements PoseSource {
  constructor(opts?: { cam?: Partial<SimCamera>; profile?: BodyProfile; noise?: number; seed?: number; fps?: number; legs?: boolean });
  setPose(spec: PoseSpec, at?: { x?: number }, blendSec?: number): void;   // 默认 0.25 秒过渡
  setLift(metres: number): void;                                            // 整个人离地（模拟跳）
  setPresent(on: boolean): void;
  step(dtMs: number): RawFrame;                                             // 手动推进（测试用），同时通知监听者
}
```

`noise` 默认 0.008 米（高斯，加在舞台坐标上）；`legs: false` 时膝、踝、脚各点可见度置 0.1。`start()` 用定时器按 `fps`（默认 30）调用 `step`。

- [ ] **Step 1: 写失败的测试**
  - 无噪声：`jointsToRawPose` 的结果经 `fitSimilarity` + `toMetric`，`sim.s` ≈ `cam.s`（1e-6），各关节与输入（减去髋）相差 < 1e-6。
  - `step(33)` 返回的 `t` 每次增加 33，`poses.length === 1`；`setPresent(false)` 后为 0。
  - `setPose(T, {}, 0.5)`：250 毫秒后右腕 x 介于起点与 0.66 之间；600 毫秒后与 0.66 相差 < 0.03。
  - 同种子的两个实例产出逐帧相等的结果。
  - `legs: false`：`LM.leftAnkle` 的 `v` 为 0.1。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。

---

### Task 8: 选定并跟住玩家

**Files:** Create `src/engine/tracking/selectPerson.ts` `selectPerson.test.ts`

**Interfaces — Produces:**

```ts
export class PersonSelector { constructor(opts?: { maxJump?: number; lostMs?: number }); pick(frame: RawFrame): RawPose | null; reset(): void }
```

规则：没有目标时选得分最高者，得分 = 图像肩宽 − 1.5·|肩髋质心 u/aspect − 0.5|；有目标时选质心离上一帧最近且位移 < `maxJump`（默认 0.25，按画面高归一）的人；连续 `lostMs`（默认 500）毫秒找不到才重新选人。

- [ ] **Step 1: 写失败的测试**（用 `jointsToRawPose` 造人；Review Focus 2）
  - 两个人：居中且更大的被选中。
  - 被选中的人向左走，同时一个更居中的旁人出现 → 仍然选原来的人。
  - 目标消失 300 毫秒 → `pick` 返回 `null`（不切换）；消失 600 毫秒 → 选中旁人。
  - 空帧返回 `null`。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。

---

### Task 9: 身体模型（米制骨架、落地、半身、可见范围）

**Files:** Create `src/engine/body/bodyModel.ts` `bodyModel.test.ts`

**Interfaces:**
- Consumes: `fitSimilarity`、`toMetric`、`OneEuro*`、`ProfileEstimator` 的骨架格式、`SimPoseSource`（仅测试）。
- Produces:

```ts
export interface ViewWindow { left: number; right: number; bottom: number; top: number }   // 摄像头在玩家所在平面能看到的范围，舞台米
export interface Body { t: number; skeleton: Skeleton; ok: Record<JointName, boolean>; root: Vec3; mode: 'full' | 'upper';
  view: ViewWindow; image: { x: number; y: number; v: number }[] }    // image：镜像后的归一化坐标（x 已取 1−x）
export class BodyBuilder {
  constructor(opts?: { zGain?: number; visOk?: number; filter?: Partial<OneEuroOpts> });
  forceMode: 'auto' | 'full' | 'upper';
  readonly hasHome: boolean;
  setHome(): void;                                    // 把当前左右位置记为 x = 0
  update(pose: RawPose, tMs: number, aspect: number, profile: BodyProfile): Body | null;
  reset(): void;
}
```

规则：缩放 `s` 用 `OneEuro({ minCutoff: 0.6, beta: 0.5 })` 平滑后再求平移；关节用 `OneEuroArray` 平滑（z 用 `minCutoff 0.8, beta 1`）；`root.x = −(tu − homeU)/s`，首帧自动 `setHome`；全身模式 `root.y = −min(踝的髋相对 y) + ANKLE_H`；半身模式 `root.y = standHipHeight(profile)`，腿部关节用默认站姿合成且 `ok` 为 `true`；腿可见 = 双膝双踝可见度 > `visOk`（0.5），带 0.5 秒滞回；关节映射：`head` = 两耳中点，`neck` = 两肩中点，`hand` = 食指根与小指根中点，`toe` = 脚尖点；`view` 由画面四边换算。拟合失败返回 `null`。

- [ ] **Step 1: 写失败的测试**（无噪声模拟，默认相机）
  - T：`skeleton.wristR` 与 FK 的 T 相差 < 0.01，`root.y` ≈ 0.82，`mode === 'full'`。
  - 深蹲：`root.y < 0.72` 且两踝 `y` ≈ 0.07。
  - `setHome()` 后模拟玩家移到 `x = 0.4`：`root.x` ≈ 0.4（±0.01）。
  - `legs: false`：`mode === 'upper'`，`skeleton.ankleL.y` ≈ 0.07，`root.y` ≈ 0.82。
  - `view.top` ≈ 2.262（±0.02），`view.bottom` ≈ −0.119，`view.left` ≈ −2.116，`view.right` ≈ 2.116。
  - 噪声 0.008：静止 30 帧后右腕抖动标准差 < 0.006。
  - 全不可见的姿态返回 `null`。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。

---

### Task 10: 动作特征与事件

**Files:** Create `src/engine/motion/features.ts` `features.test.ts`；Modify `simSource.ts`（已含 `setLift`）

**Interfaces — Produces:**

```ts
export interface Motion { energy: number; lean: number; armLiftL: number; armLiftR: number; squat: number; feetApart: number; kneeLiftL: number; kneeLiftR: number }
export type MotionEvent = 'jump' | 'squatDown' | 'squatUp' | 'handUpL' | 'handUpR'
export class MotionAnalyzer { update(body: Body, profile: BodyProfile): { motion: Motion; events: Set<MotionEvent> }; reset(): void }
```

定义：`energy` = 腕、肘、膝、踝、头的速度（米/秒）去掉最快两个后的均值，指数平滑 τ = 0.2 秒，除以 1.5 后夹到 0～1；`lean` = 脊柱倾角 / 30°，夹到 ±1；`armLift` = (腕高 − 肩高) / (上臂 + 前臂)；`squat` = clamp01((站立髋高 − root.y) / (0.45·站立髋高))；`feetApart` = 两踝水平距离 / 肩宽；`kneeLift` = clamp01((膝高 − (ANKLE_H + shin)) / (0.8·thigh))。事件用回滞：`squatDown` 在 squat 升过 0.45，之后降到 0.15 以下出 `squatUp`；`handUp` 在 armLift 升过 0.6（降到 0.4 以下复位）；`jump` 看镜像图像坐标里髋相对慢基线（τ = 0.7 秒）上升超过图像躯干长的 0.18，冷却 0.4 秒。

- [ ] **Step 1: 写失败的测试**（模拟序列，30 Hz）
  - 站着不动 2 秒：`energy < 0.05`。每 0.3 秒在两个手臂姿势间切换：`energy > 0.3`。
  - T：`|armLiftR| < 0.1`；举高：`> 0.7`；站立：`< -0.8`。
  - 站 → 深蹲 → 站：事件依次恰好出现一次 `squatDown`、一次 `squatUp`。
  - 侧倾 20° 的姿势：`lean` 在 0.67 ± 0.1。
  - `setLift(0.25)` 保持 0.3 秒再落回：恰好一次 `jump`。
  - 举起左手：出现 `handUpL`，不出现 `handUpR`。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。

---

### Task 11: PlayerTracker、录制与回放

**Files:** Create `src/engine/player/playerTracker.ts` `playerTracker.test.ts` `src/engine/input/recorder.ts` `replaySource.ts` `recorder.test.ts`

**Interfaces — Produces:**

```ts
export interface PlayerState { t: number; present: boolean; lostMs: number; body: Body | null; motion: Motion; events: Set<MotionEvent>; profile: BodyProfile; profileReady: boolean }
export class PlayerTracker {
  constructor(opts?: { profile?: BodyProfile });
  ingest(frame: RawFrame): PlayerState;
  readonly state: PlayerState;
  calibrate(): void;                               // 当前位置记为 x = 0，并冻结身材估计
  setMode(m: 'auto' | 'full' | 'upper'): void;
  sample(nowMs: number): Skeleton | null;          // 渲染帧率的指数跟随（λ = 30/秒）
  reset(): void;
}
export interface Recording { version: 1; aspect: number; frames: { t: number; poses: number[][] }[] }   // 每个人 33×(x,y,z,v) + 33×(x,y,z)，保留 4 位小数
export class FrameRecorder { start(source: PoseSource): void; stop(): Recording; readonly recording: boolean }
export class ReplayPoseSource implements PoseSource { constructor(rec: Recording, opts?: { loop?: boolean }); step(dtMs: number): RawFrame | null }
```

`present`：连续 300 毫秒拿不到 `Body` 才变 `false`；`lostMs` 是从最后一次有身体算起的毫秒数。

- [ ] **Step 1: 写失败的测试**
  - 喂模拟帧：第一帧后 `present === true`，`body` 非空。
  - 模拟玩家消失 600 毫秒：`present === false` 且 `lostMs >= 600`。
  - `sample()`：两次识别帧之间取样，腕的位置落在前后两帧之间。
  - `calibrate()` 后玩家移动 0.3 米：`body.root.x` ≈ 0.3。
  - 录 20 帧 → `JSON.parse(JSON.stringify(rec))` → 回放：帧数相同，`t` 间隔相同，坐标相差 < 1e-3。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。

---

### Task 12: 造型库（人形姿势、几何洞、身体胶囊）

**Files:** Create `src/games/wall/poses.ts` `shapes.ts` `bodyShape.ts` 及 `.test.ts`

**Interfaces — Produces:**

```ts
// poses.ts
export const STAND: PoseSpec
export const POSES: PoseSpec[]                    // 24 个原创姿势
export function getPose(id: string): PoseSpec | undefined
// shapes.ts
export interface ShapeSpec { id: string; name: string; tier: 2 | 3; upperOk: boolean; say?: string; offset?: number;   // offset：洞相对玩家的左右偏移（偏门用）
  build(p: BodyProfile, at: { x: number }): Sdf;                    // 洞内为负
  demo: PoseSpec }                                                  // 能钻过去的示范姿势（模拟玩家、提示小人、测试用）
export const SHAPES: ShapeSpec[]
// bodyShape.ts
export type PartId = 'head'|'torso'|'upperArmL'|'forearmL'|'handL'|'upperArmR'|'forearmR'|'handR'|'thighL'|'shinL'|'footL'|'thighR'|'shinR'|'footR'
export interface Capsule { id: PartId; ax: number; ay: number; bx: number; by: number; r: number; ok: boolean }
export function skeletonCapsules(sk: Skeleton, p: BodyProfile, ok?: Partial<Record<JointName, boolean>>): Capsule[]   // torso 由脊柱、肩线、骨盆三个胶囊组成
export function limbsToParts(limbs: LimbId[]): PartId[]             // upperArmL → ['upperArmL']，forearmL → ['forearmL','handL']，shinL → ['shinL','footL']，spine → ['torso','head']
```

姿势库（id · 名 · 层 · 上半身可做）——角度在实现时对着图鉴页调，下列为初值：

| 层 | 姿势 |
|---|---|
| 1（对称、只动手、都可半身） | `t` 一字平举 [90,90] · `y` 举高高 [148,150] · `up` 顶天 [176,178] · `a` 小企鹅 [40,40] · `flex` 大力士 [90,180] · `hips` 叉腰 [40,−40] · `scarecrow` 稻草人 [90,0] · `head` 抱头 [130,−140] |
| 2 | `disco` 指天指地（左 [150,150] 右 [35,35]）· `signal` 交警（左 [90,90] 右 [178,178]）· `teapot` 小茶壶（左 [40,−40] 右 [90,150]）· `wave` 打招呼（右 [90,170]）· `archer` 拉弓（左 [90,90] 右 [90,−90]）——以上可半身；`star` 大字（臂 [125,125]，腿 [22,22]）· `wide-t` 马步平举（臂 T，腿 [25,5]）——不可半身 |
| 3 | `side-bend` 侧弯腰（脊柱 22°，左 [165,165] 右 [10,5]，可半身）· `squat` 蹲马步（大腿 a65 s.75，小腿 −8，臂 [60,60]）· `low` 小矮人（大腿 a80 s.45，小腿 s.9，脊柱 s.6，臂 [15,10]）· `lunge` 侧弓步（左腿 [50,0] 右腿 [38,38]，叉腰）· `hero` 超人（脊柱 12°，右 [165,165]，左叉腰，腿 [18,18]） |
| 4 | `crane` 金鸡独立（右大腿 a10 s.25，臂 T）· `side-kick` 侧踢（右腿 [60,60]，脊柱 −10°）· `skater` 滑冰（脊柱 18°，右腿 [40,55]）· `tree` 树式（右腿 [60,−60]，臂 [170,175]） |

几何洞（`H = standHeight(p)`，`SW = p.shoulderW`）：`slot` 窄缝（层 2，可半身；竖条，半宽 `SW/2 + 0.14`，高到 `H + 0.2`；示范 `STAND`）· `keyhole` 钥匙孔（层 2，可半身；肩部高度一个半径 0.48 的圆 + 下方半宽 `hipW/2 + 0.14` 的竖条；示范 `head`）· `low-door` 矮门（层 3；从地面到 `0.62·H`、半宽 `SW/2 + 0.42` 的圆角矩形；示范 `low`）· `round` 圆洞（层 3；半径 `0.36·H`、圆心高 `0.36·H − 0.10`；示范 `low`）· `side-door` 偏门（层 3，可半身，`offset 0.55`；半宽 `SW/2 + 0.36`、高到 `H + 0.2`；示范 `STAND`）。

- [ ] **Step 1: 写失败的测试**
  - `POSES` 有 24 个、`id` 和 `name` 各不重复、名字不含"墙来了""动动乐园"。
  - 第 1 层全部 `upperOk`，且 `armL` 与 `armR` 深度相等、腿为 `DEFAULT_LEG`；`upperOk` 的姿势 ≥ 10 个。
  - 每个姿势用默认身材做 FK：所有关节 `x ∈ [−1.4, 1.4]`、`y ∈ [0, 2.25]`，最低的踝在 0.07。
  - `skeletonCapsules`：14 种 `PartId` 都出现；头是 `a == b`、半径 0.11 的圆；上臂胶囊从肩到肘、半径 0.045；某关节 `ok` 为 `false` 时相关部位 `ok` 为 `false`。
  - `limbsToParts(['forearmL','spine'])` 等于 `['forearmL','handL','torso','head']`。
  - 每个 `SHAPES[i].build(p, {x:0})` 在示范姿势的 `hipC` 处为负。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。

---

### Task 13: 墙的标量场

**Files:** Create `src/games/wall/field.ts` `field.test.ts`

**Interfaces — Produces:**

```ts
export interface WallBounds { x0: number; x1: number; y0: number; y1: number }
export const WALL_BOUNDS: WallBounds          // { x0: -2.1, x1: 2.1, y0: 0, y1: 3.0 }
export interface WallField { nx: number; ny: number; cell: number; gx0: number; gy0: number; data: Float32Array; bounds: WallBounds }   // 墙体内为正（陷入深度），洞内和墙外为负
export function capsulesHole(caps: Capsule[], margin: number): Sdf     // min(到轴线距离 − (r + margin))
export function buildField(hole: Sdf, bounds?: WallBounds, cell?: number): WallField   // cell 默认 0.025；网格四周各多出 2 格
export function sampleField(f: WallField, x: number, y: number): number   // 双线性；网格外返回 −1
```

`buildField`：值 = `min(hole(x,y), 到墙矩形边界的内部距离)`（矩形外为负）；随后做连通性修正——从顶行和左右两列的墙体格子出发做洪水填充（四邻域、只走值 > 0 的格子），没被走到的墙体格子改为 `−cell/2`。底边不是起点。

- [ ] **Step 1: 写失败的测试**
  - 中间一根竖直胶囊洞：轴线上为负，远处为正，洞边界处 `|sampleField| < 0.03`。
  - 倒 V 形两条腿（髋 (0,0.85) 到脚 (±0.4,0.05)）：两腿之间 (0, 0.3) 处原始 SDF 为正，`buildField` 后为负。
  - 叉腰围出的封闭三角：修正后为负。
  - 一个不触底的圆窗（圆心高 1.5、半径 0.5）：圆内为负，圆正下方 (0, 0.5) 仍为正。
  - 墙矩形外 `(3, 1)`、`(0, 3.5)` 为负；网格外返回 −1。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。

---

### Task 14: 轮廓提取

**Files:** Create `src/games/wall/contour.ts` `contour.test.ts`

**Interfaces — Produces:**

```ts
export interface WallOutline { outer: Vec2[]; holes: Vec2[][] }      // 墙体区域：外圈逆时针，内孔顺时针
export function wallOutlines(f: WallField, eps?: number): WallOutline[]    // marching squares（线性插值）→ 连成闭环 → Douglas–Peucker 简化（eps 默认 0.008）
export function holeEdges(f: WallField, eps?: number): Vec2[][]           // 洞的边界折线（去掉落在墙矩形边上的段），给落位轮廓用
```

- [ ] **Step 1: 写失败的测试**
  - 圆窗：1 块墙体，外圈面积 ≈ 12.6（±2%），1 个内孔，面积绝对值 ≈ 0.785（±5%），外圈逆时针、内孔顺时针。
  - 触底的门（宽 0.8、高 1.9）：1 块墙体、0 个内孔，面积 ≈ 12.6 − 1.52（±3%）；`holeEdges` 返回 1 条折线，两端的 `y` 都 < 0.05。
  - 所有环的点数 < 400，相邻点不重合。
  - 用 `t` 姿势的洞：`wallOutlines` 恰好 1 块、无自交（任取不相邻的两条边不相交）。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。

---

### Task 15: 判定

**Files:** Create `src/games/wall/judge.ts` `judge.test.ts`

**Interfaces:**
- Consumes: `measureLimbs`、`targetLimbs`、`angleDiff`、`sampleField`、`skeletonCapsules`、`limbsToParts`、`Body`。
- Produces:

```ts
export interface PoseJudge { kind: 'pose'; matched: boolean; accuracy: number; errors: Partial<Record<LimbId, number>>; bad: LimbId[]; posOk: boolean; dx: number }
export function judgePose(target: PoseSpec, holeX: number, body: Body, profile: BodyProfile, tol: { angle: number; pos: number }): PoseJudge
export interface ShapeJudge { kind: 'shape'; hit: boolean; clean: boolean; worst: number; bad: PartId[] }
export function judgeShape(field: WallField, caps: Capsule[], tol: { slack: number; hitFrac: number }): ShapeJudge
export type Outcome = { kind: 'hit'; reason: string; badParts: PartId[] } | { kind: 'pass'; stars: 1 | 2 | 3; accuracy: number }
export function resolveOutcome(samples: (PoseJudge | ShapeJudge)[]): Outcome
export function reasonText(j: PoseJudge | ShapeJudge | null): string
```

规则：
- `judgePose`：只判 `ok` 的肢体；半身模式不判腿。目标 `scale < 0.6` 的肢体误差 = `|实际比例 − 目标比例| × 80`，否则误差 = `angleDiff`。`matched` = 至少判了 2 段、每段误差 ≤ `tol.angle`、且 `posOk`（`|body.root.x − holeX| ≤ tol.pos`）。`accuracy` = 各段 `clamp01(1 − 误差 / (2·tol.angle))` 的均值。
- `judgeShape`：每个 `ok` 的胶囊沿轴线每 0.06 米取一点（至少 2 点），陷入深度 = `sampleField + r`；某部位"撞"= 深度 > `slack` 的采样点占比 ≥ `hitFrac`，或任一点深度 > `2·slack`。`clean` = 全身最大深度 ≤ 0。
- `resolveOutcome`：空 → 撞（原因"没看到你"）；人形 → 过半样本 `matched` 才过，星级按样本 `accuracy` 中位数：≥ 0.8 三星、≥ 0.6 两星、否则一星；几何 → 过半样本不 `hit` 才过，过半 `clean` 三星否则两星。
- `reasonText`：站位偏了 → "往左站一点" / "往右站一点"；否则按最差部位："左手没摆对""右腿没摆对""身体没摆正""头撞到了"等。

- [ ] **Step 1: 写失败的测试**（默认身材，标准档 `angle 32, pos 0.26, slack 0.05, hitFrac 0.2`；`Body` 用模拟玩家 + `BodyBuilder` 得到）
  - 玩家摆的就是目标：`matched`，`accuracy > 0.95` → 三星。
  - 目标 `t`，玩家手臂各偏 12° → 三星；偏 22° → 两星；偏 30° → 一星；偏 36° → 撞，`bad` 含 `upperArmL/R`。
  - 目标 `t`，玩家 `STAND` → 撞；目标 `STAND`，玩家 `t` → 撞。
  - 玩家站在 `x = 0.4`、洞在 `x = 0` → `posOk === false`，撞，原因是"往左站一点"。
  - 半身模式：腿与目标完全不同 → 仍 `matched`。
  - 目标 `low`（大腿比例 0.45），玩家 `STAND` → 撞。目标 `squat`，玩家 `squat` → 过。
  - `judgeShape`：`low-door` 对 `STAND` → `hit`，`bad` 含 `head`；对 `low` → 不 `hit`。`side-door`（洞在 0.55）对站在 0 的 `STAND` → `hit`；对站在 0.55 的 → 不 `hit`。每个 `SHAPES` 的示范姿势在默认身材和 `scaleProfile(0.72)` 的儿童身材下都不 `hit`。
  - `ok` 为 `false` 的部位不参与：右臂伸出洞外但 `ok=false` → 不 `hit`。
  - `resolveOutcome`：7 个样本 4 个 `matched` → 过；3 个 → 撞；空数组 → 撞且 `reason === '没看到你'`。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。

---

### Task 16: 可调参数与关卡生成

**Files:** Create `src/games/wall/tuning.ts` `levels.ts` `levels.test.ts`

**Interfaces — Produces:**

```ts
export type Difficulty = 'easy' | 'normal' | 'hard'
export interface Tuning { angleTol: number; angleTolFloor: number; posTol: number; holeMargin: number; shapeSlack: number; approach: number; approachFloor: number; ghost: boolean }
export const TUNING: Record<Difficulty, Tuning>
export const COMMON: { lives: 3; judgeWindowMs: 250; hitFrac: 0.2; assistSec: 0.35; lostPauseMs: 1000; resumeMs: 500; countdownSec: 3;
  resolvePassSec: 1.1; resolveHitSec: 2.6; levelUpSec: 1.8; maxDtSec: 0.1; spawnZ: -26; offsetX: 0.45; shapeChance: 0.3; offsetChance: 0.35 }
export interface LevelPlan { level: number; walls: number; tiers: number[]; shapes: boolean; offsets: boolean; angleTol: number; approachSec: number }
export function levelPlan(level: number, t: Tuning): LevelPlan
export interface WallSpec { index: number; level: number; kind: 'pose' | 'shape'; pose?: PoseSpec; shape?: ShapeSpec; holeX: number; approachSec: number; angleTol: number }
export interface SpawnCtx { mode: 'full' | 'upper'; view: ViewWindow | null; profile: BodyProfile; playerX: number }
export class WallSequence { constructor(seed: number, difficulty: Difficulty, pool?: { poses: PoseSpec[]; shapes: ShapeSpec[] });
  next(ctx: SpawnCtx): WallSpec; readonly level: number; readonly wallInLevel: number; readonly wallsInLevel: number }
```

`TUNING`：

| | angleTol | angleTolFloor | posTol | holeMargin | shapeSlack | approach | approachFloor | ghost |
|---|---|---|---|---|---|---|---|---|
| easy | 40 | 32 | 0.30 | 0.12 | 0.06 | 7.5 | 4.5 | true |
| normal | 32 | 25 | 0.26 | 0.10 | 0.05 | 6.5 | 3.6 | true |
| hard | 25 | 20 | 0.22 | 0.08 | 0.04 | 5.5 | 3.0 | false |

`levelPlan`：`walls = min(8, 4 + level)`；`angleTol = max(floor, tol − 1.5·(level−1))`；`approachSec = max(floor, approach − 0.4·(level−1))`；层：第 1 关 `[1]`，第 2 关 `[1,2]`，第 3 关 `[1,2]` 且 `shapes`（只出层 2 的几何洞），第 4 关 `[2,3]` 且 `shapes`、`offsets`，第 5 关起 `[2,3,4]` 且 `shapes`、`offsets`。
`next`：整局第一面墙固定是 `t`；`shapes` 开启时以 `shapeChance` 出几何洞；候选须满足层、半身模式下 `upperOk`、以及"目标骨架（示范姿势）每个关节都在 `view` 内缩 0.05 米的范围里"；不对称姿势一半概率取镜像；不与上一面重复，同一关内用过的先排除、用尽再重置；`holeX` 默认取 `ctx.playerX`，`offsets` 开启时以 `offsetChance` 再加 `±offsetX`，几何洞的 `offset` 随机取正负；最终夹到 `[-0.9, 0.9]`。候选为空时退回 `t`。

- [ ] **Step 1: 写失败的测试**
  - `levelPlan(1, TUNING.normal)`：`walls 5, tiers [1], shapes false, offsets false, angleTol 32, approachSec 6.5`；`levelPlan(6, …)`：`walls 8, angleTol 25, approachSec 4.5`；`levelPlan(20, …).approachSec === 3.6`。
  - 同种子、同上下文连抽 40 面：`id` 序列完全相同；不同种子不同。
  - 第一面是 `t`；第 1 关的 5 面全是层 1；第 6 面起 `level === 2`。
  - 前两关没有几何洞；第 3 关的几何洞只有层 2；第 4 关之前 `holeX === playerX`。
  - 连续两面不重复。
  - `mode: 'upper'`：抽 60 面全部 `upperOk`。
  - `view.top = 1.7`：抽 60 面，没有目标关节 `y > 1.65` 的（`up`、`y` 被排除）。
  - `view` 极小导致无候选：返回 `t` 而不抛错。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。

---

### Task 17: 造墙与游戏状态机

**Files:** Create `src/games/wall/build.ts` `game.ts` `game.test.ts`

**Interfaces:**
- Consumes: Task 12–16 的全部产出、`Body`、`SimPoseSource`、`PlayerTracker`（测试）。
- Produces:

```ts
// build.ts
export interface BuiltWall { spec: WallSpec; field: WallField; outlines: WallOutline[]; ghost: Vec2[][]; target: Skeleton; label: string; say: string }
export function buildWall(spec: WallSpec, profile: BodyProfile, t: Tuning): BuiltWall     // target：人形洞为目标骨架，几何洞为示范姿势的骨架
// game.ts
export type Phase = 'idle' | 'countdown' | 'approach' | 'resolve' | 'levelup' | 'paused' | 'over'
export interface Summary { level: number; walls: number; score: number; bestCombo: number; stars: [number, number, number]; seed: number; difficulty: Difficulty }
export type GameEvent =
  | { type: 'countdown'; n: number } | { type: 'wall'; wall: BuiltWall } | { type: 'tick'; n: number }
  | { type: 'outcome'; outcome: Outcome; wall: BuiltWall; gained: number } | { type: 'life'; lives: number }
  | { type: 'levelup'; level: number } | { type: 'pause'; on: boolean } | { type: 'over'; summary: Summary }
export interface LiveJudge { accuracy: number; ok: boolean; badParts: PartId[]; hint: string }
export interface WallGameState { phase: Phase; level: number; wallIndex: number; wallInLevel: number; wallsInLevel: number; lives: number; score: number; combo: number;
  wall: BuiltWall | null; progress: number; timeLeft: number; live: LiveJudge | null; last: Outcome | null }
export class WallGame {
  constructor(opts: { seed: number; difficulty: Difficulty; pool?: { poses: PoseSpec[]; shapes: ShapeSpec[] } });
  start(ctx: { profile: BodyProfile; mode: 'full' | 'upper'; view: ViewWindow | null }): void;
  update(dtSec: number, body: Body | null): GameEvent[];
  setPaused(on: boolean): void;                       // 手动暂停（标签页隐藏、按暂停键）
  assist(): { k: number; target: Skeleton } | null;   // 过关吸附：最后 assistSec 内且当前判定为 ok 时返回 k∈(0,1]
  readonly state: WallGameState;
  readonly summary: Summary;
}
```

时序：`start` 进入 `countdown`（每秒一个 `countdown` 事件，3、2、1）→ 出第一面墙（`wall` 事件）→ `approach`：`progress += dt / approachSec`，每帧做实时判定并把结果连同时间戳存入窗口；最后 3 秒每整秒一个 `tick`；`body` 连续为空 `lostPauseMs` → `paused`（`pause` 事件），回来连续 `resumeMs` 后恢复 → `progress ≥ 1` 时用最近 `judgeWindowMs` 内的样本 `resolveOutcome` → `resolve`（过 `resolvePassSec`，撞 `resolveHitSec`）；撞则命减一（`life` 事件），命为 0 时 `resolve` 结束后 `over` → 本关墙数用完则 `levelup`（`levelUpSec`）→ 下一面。`update` 内 `dt` 先夹到 `maxDtSec`。
计分：人形过关 `100 × 星数`，几何洞过关 200、干净 300；乘以 `1 + 0.1·min(combo, 10)` 后取整；过关 `combo + 1`，撞墙清零；升关奖励 `500 × 新关卡号`。

- [ ] **Step 1: 写失败的测试**（辅助函数 `runGame(policy, seconds)`：用 `SimPoseSource` + `PlayerTracker` 以 1/60 秒步进，`policy` 在每个 `wall` 事件时决定模拟玩家摆什么）
  - 完美策略（摆 `wall.spec` 对应的目标 / 示范姿势，站到 `holeX`，噪声 0.008）跑完前两关（11 面墙）：`lives === 3`，11 个 `outcome` 全是 `pass`，恰好在第 5 面之后出现 `levelup` 且 `level === 2`，`score > 0`。
  - 错误策略（永远 `STAND` 不动）：第一面 `t` 就撞；最终 `phase === 'over'`，`lives === 0`，`over` 事件的 `summary.walls` 等于过关数。
  - 事件顺序：`countdown 3,2,1` → `wall` → …→ `outcome`；`outcome` 为撞时紧跟 `life`。
  - 墙驶来途中 `body` 连续为空 1.2 秒：出现 `pause on`，期间 `progress` 不变、`lives` 不变；恢复后出现 `pause off`（Review Focus 2）。
  - `update(5, body)`（一帧 5 秒）：`progress` 增量不超过 `0.1 / approachSec`，不会直接判定（Review Focus 4）。
  - `setPaused(true)` 期间 `update` 不推进任何计时。
  - 同种子 + 同策略：两次运行的事件日志（类型和关键字段）完全相同。
  - `assist()`：`progress` 对应剩余时间 > `assistSec` 时为 `null`；最后 0.2 秒且姿势正确时 `k > 0` 且 `target` 是该墙的目标骨架；姿势错误时为 `null`。
  - 计分：连续两面三星人形墙，第二面得分是 `round(300 × 1.1)`。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。
- [ ] **Step 5:** Run `npm test` → 全部通过；Run `npx tsc --noEmit` → 无错误。

---

### Task 18: 摄像头、识别器、摄像头姿态源

**Files:** Create `src/engine/camera/camera.ts` `camera.test.ts` `src/engine/vision/assets.ts` `poseDetector.ts` `poseDetector.test.ts` `src/engine/input/cameraSource.ts`

**Interfaces — Produces:**

```ts
// camera.ts
export class CameraError extends Error { readonly title: string; readonly hint: string; readonly code: 'denied' | 'notfound' | 'busy' | 'unsupported' | 'unknown' }
export function mapCameraError(err: unknown): CameraError
export async function openCamera(opts?: { deviceId?: string }): Promise<HTMLVideoElement>   // 理想 1280×720@30，facingMode 'user'；指定设备找不到时退回默认
export function closeCamera(video: HTMLVideoElement | null): void
export function watchCamera(video: HTMLVideoElement, onProblem: (kind: 'ended' | 'frozen') => void, frozenMs?: number): () => void
// assets.ts
export const ASSETS: { wasmBase: string; modelUrl(m: ModelKind): string; modelSize: Record<ModelKind, number> }
export async function fetchWithProgress(url: string, onProgress?: (loaded: number, total: number) => void, fetchFn?: typeof fetch): Promise<Uint8Array>
// poseDetector.ts
export type ModelKind = 'lite' | 'full'
export class VisionError extends Error { readonly title: string; readonly hint: string }
export interface LandmarkerLike { detectForVideo(video: unknown, ts: number): { landmarks: any[][]; worldLandmarks: any[][] }; close(): void }
export interface DetectorDeps { loadModel(m: ModelKind, onProgress?: (l: number, t: number) => void): Promise<Uint8Array>; create(delegate: 'GPU' | 'CPU', model: Uint8Array, numPoses: number): Promise<LandmarkerLike> }
export interface PoseDetector { detect(video: HTMLVideoElement, tsMs: number): RawPose[]; readonly delegate: 'GPU' | 'CPU'; readonly model: ModelKind; close(): void }
export async function createPoseDetector(opts: { model: ModelKind; numPoses?: number; onProgress?: (loaded: number, total: number) => void; deps?: DetectorDeps }): Promise<PoseDetector>
// cameraSource.ts
export class CameraPoseSource implements PoseSource { constructor(opts: { model: ModelKind; deviceId?: string; onProgress?: (loaded: number, total: number) => void; onProblem?: (kind: 'ended' | 'frozen') => void }) }
```

识别参数：`runningMode 'VIDEO'`、`numPoses 2`、三个置信度阈值 0.5。循环优先 `requestVideoFrameCallback`，否则 `requestAnimationFrame` + `currentTime` 去重；时间戳严格递增；`stats()` 的 `fps`、`detectMs` 用指数平滑。

- [ ] **Step 1: 写失败的测试**（Review Focus 1、5）

```ts
expect(mapCameraError({ name: 'NotAllowedError' }).code).toBe('denied');
expect(mapCameraError({ name: 'NotFoundError' }).code).toBe('notfound');
expect(mapCameraError({ name: 'NotReadableError' }).code).toBe('busy');
expect(mapCameraError(new Error('x')).code).toBe('unknown');
for (const n of ['NotAllowedError','NotFoundError','NotReadableError']) { const e = mapCameraError({ name: n }); expect(e.title.length).toBeGreaterThan(0); expect(e.hint.length).toBeGreaterThan(0); }
// poseDetector：注入 deps
//  - create('GPU') 抛错、create('CPU') 成功 → detector.delegate === 'CPU'
//  - 两者都抛错 → 抛 VisionError
//  - loadModel 抛出带 status 404 的错误 → VisionError.hint 含 'npm run setup'
//  - detect() 把假 landmarker 的输出转成 RawPose[]（长度、v 取自 visibility）
// fetchWithProgress：注入返回分块流的假 fetch，onProgress 的最后一次是 (total, total)，结果字节正确
```

- [ ] **Step 2–4:** FAIL → 实现 → PASS。
- [ ] **Step 5（浏览器验证，随 Task 19 的调试钩子一起做）:** 假摄像头下 `CameraPoseSource` 能出帧；记录本机 `detectMs`。中位数 > 8 毫秒时在 README 的"性能"一节写明，并把"识别挪进 Worker"列为后续项（规格 5.2-3）。

---

### Task 19: 应用外壳（路由、设置、引擎钩子、设计基调、首页）

**Files:** Create `src/app/router.ts` `router.test.ts` `settings.ts` `settings.test.ts` `useEngine.ts` `pages/Home.tsx` `components/{Button,LoadingCard,ErrorCard,SettingsDialog,CameraPip,DebugOverlay}.tsx` `styles/{tokens,base,components}.css`；Modify `src/App.tsx` `src/main.tsx`；Create `src/engine/audio/sfx.ts` `speech.ts`

**先调用 `frontend-design:frontend-design` 技能确定视觉方向**，约束见 Global Constraints 的避让清单。基调（实现者可在此之内细化）：晴天海上闯关、体育节目的字幕感——深海军蓝描边、硬朗的偏移投影、倾斜的标签；色板 `ink #14213d · sea #0fb5c9 · deep #0a7ea4 · sky #bfe9ff · sun #ffc531 · coral #ff5d4a · mint #3ddc97 · foam #ffffff · sand #fff4d6`；展示字体 `ZCOOL QingKe HuangYou`，正文系统中文字体。

**Interfaces — Produces:**

```ts
// router.ts
export type Route = { page: 'home' } | { page: 'play'; game: string } | { page: 'lab' }
export function parseRoute(hash: string): Route          // '#/'、'#/play/wall'、'#/lab'；未知 → home
export function routeHref(r: Route): string
export function readFlags(search: string): { sim: 'off' | 'auto' | 'wrong' | 'manual'; seed: number | null; debug: boolean; e2e: boolean; fast: boolean }
// settings.ts
export interface Settings { difficulty: Difficulty; model: 'auto' | ModelKind; sound: boolean; voice: boolean; pip: boolean; skeleton: boolean; quality: 'auto' | 'low' | 'high'; cameraId: string }
export const DEFAULT_SETTINGS: Settings      // normal, auto, true, true, true, false, auto, ''
export function loadSettings(storage?: Pick<Storage, 'getItem'>): Settings      // 损坏或缺字段时用默认值补齐
export function saveSettings(s: Settings, storage?: Pick<Storage, 'setItem'>): void
export function useSettings(): [Settings, (patch: Partial<Settings>) => void]
// useEngine.ts
export type EngineStatus = 'idle' | 'loading' | 'ready' | 'error'
export interface Engine { status: EngineStatus; progress: { loaded: number; total: number } | null; error: { title: string; hint: string } | null;
  source: PoseSource | null; tracker: PlayerTracker; video: HTMLVideoElement | null; retry(): void; useDemo(): void }
export function useEngine(opts: { sim: 'off' | 'auto' | 'wrong' | 'manual'; model: 'auto' | ModelKind; cameraId: string }): Engine
// audio
export type SfxName = 'tick' | 'go' | 'spawn' | 'pass' | 'perfect' | 'hit' | 'splash' | 'levelup' | 'over' | 'click' | 'hover'
export class Sfx { resume(): void; setEnabled(on: boolean): void; play(name: SfxName, opts?: { pitch?: number }): void; setApproach(progress: number | null): void; dispose(): void }
export function speak(text: string, opts?: { interrupt?: boolean }): void
export function setVoiceEnabled(on: boolean): void
```

`useEngine`：`sim !== 'off'` 时用 `SimPoseSource`（`start()` 实时发帧）；否则 `CameraPoseSource`。`model: 'auto'` 先用 `full`，就绪后 3 秒内 `stats().fps < 18` 则换 `lite` 重建。`useDemo()` 把来源切到模拟玩家（Review Focus 1 的出路）。`e2e` 或开发模式下把 `{ tracker, source }` 挂到 `window.__mw`。

- [ ] **Step 1: 写失败的测试**
  - `parseRoute('#/play/wall')` → `{ page: 'play', game: 'wall' }`；`parseRoute('#/nope')` → `{ page: 'home' }`；`routeHref` 与 `parseRoute` 互逆。
  - `readFlags('?sim=auto&seed=7&e2e=1')` → `sim 'auto', seed 7, e2e true, debug false, fast false`；`?sim=1` 视为 `'auto'`；非法 seed → `null`。
  - `loadSettings`：空存储 → 默认值；存了 `{"difficulty":"hard"}` → 其余字段补默认；存了坏 JSON → 默认值；`difficulty: 'weird'` → 回落 `normal`。
- [ ] **Step 2–4:** FAIL → 实现 `router.ts`、`settings.ts` → PASS。
- [ ] **Step 5:** 实现样式基调、组件、`useEngine`、音频、首页（三个入口：开始闯关、示例游戏、姿势实验室；设置按钮）。`ErrorCard` 显示 `title`、`hint`、"再试一次"和"用演示模式看看"两个按钮。
- [ ] **Step 6（验证）:** `npm run build` 通过；起预览服务，用 `tools/cdp.mjs`（Task 23 之前先把草稿目录的版本拷进 `tools/`）截首页图，人工确认：没有控制台报错、字体已加载、观感不落入避让清单。

---

### Task 20: 3D 舞台、海面、小人

**Files:** Create `src/games/wall/scene/stage.ts` `sea.ts` `avatar.ts` `avatarMath.ts` `avatarMath.test.ts`

**Interfaces — Produces:**

```ts
// stage.ts
export interface Stage { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; resize(w: number, h: number): void; render(): void; shake(amount: number): void; update(dt: number): void; dispose(): void }
export function createStage(canvas: HTMLCanvasElement, quality: 'low' | 'high'): Stage
// sea.ts
export function createSea(quality: 'low' | 'high'): { mesh: THREE.Object3D; update(t: number): void; splash(x: number, z: number): void }
// avatarMath.ts（纯函数，可测）
export function capsuleTransform(a: Vec3, b: Vec3): { position: Vec3; quaternion: [number, number, number, number]; length: number }   // 把沿 +Y 的单位胶囊摆到 a→b
// avatar.ts
export type PartTint = 'idle' | 'ok' | 'bad'
export class Avatar { readonly group: THREE.Group; constructor(profile: BodyProfile, color?: number);
  setProfile(p: BodyProfile): void; pose(sk: Skeleton): void; tint(parts: Partial<Record<PartId, PartTint>>): void;
  knock(): void; respawn(): void; update(dt: number): { splashed: boolean; done: boolean }; readonly busy: boolean; dispose(): void }
```

场景尺寸：浮台顶面 `y = 0`，x 方向宽 3.4、z 方向深 1.6，水面 `y = −0.9`；相机在 `(0, 2.5, 5.4)` 看向 `(0, 1.15, −3)`，竖直视角 46°，宽高比小于 1.2 时把相机拉远到整面墙入画；像素比上限 `high 2 / low 1`；雾和天空用渐变。小人背后有号码布（画布贴图）。`knock()`：小人带着当前姿势向 `+z`、向上抛出并翻滚，越过水面时 `update` 返回一次 `splashed`，随后 `respawn()` 从水里弹回浮台。

- [ ] **Step 1: 写失败的测试**（`avatarMath`）：`capsuleTransform((0,0,0),(0,2,0))` → 位置 (0,1,0)、单位四元数、长度 2；`(0,0,0)→(2,0,0)`：把 +Y 转到 +X（用该四元数旋转 (0,1,0) 得 (1,0,0)）；`a == b` 时长度 0 且不出 `NaN`；任意方向下旋转后的 +Y 与 `normalize(b − a)` 一致（随机 20 组）。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。
- [ ] **Step 5:** 实现 `stage.ts`、`sea.ts`、`avatar.ts`。
- [ ] **Step 6（验证）:** 临时调试路由 `#/lab?sim=manual` 下只渲染舞台 + 小人，截图确认：小人站在浮台上、背对镜头、T 姿势时右手在屏幕右侧；无控制台报错。

---

### Task 21: 墙体网格、落位轮廓、特效、场景编排

**Files:** Create `src/games/wall/scene/wallMesh.ts` `ghost.ts` `fx.ts` `view.ts`

**Interfaces — Produces:**

```ts
export function buildWallMesh(wall: BuiltWall, color: number): THREE.Group        // ExtrudeGeometry（厚 0.3、带倒角）+ 洞口深色切边 + 顶部名牌
export function disposeObject(o: THREE.Object3D): void
export function buildGhost(edges: Vec2[][], color: number): THREE.Object3D        // 立在 z = 0 的发光轮廓
export class Fx { readonly group: THREE.Group; burstWall(mesh: THREE.Object3D, color: number): void; confetti(x: number, y: number): void; droplets(x: number, z: number): void; update(dt: number): void; dispose(): void }
export const WALL_COLORS: number[]      // coral、sun、mint、紫 0x8f6cff、粉 0xff7ab8、橙 0xff9a3c
export class WallSceneView {
  constructor(canvas: HTMLCanvasElement, opts: { quality: 'low' | 'high'; profile: BodyProfile });
  handle(e: GameEvent): void;                                     // wall → 造墙并放到 spawnZ；outcome → 过：碎墙 + 彩带；撞：停墙、knock、震屏
  frame(dt: number, state: WallGameState, skeleton: Skeleton | null, assist: { k: number; target: Skeleton } | null): { splashed: boolean };
  resize(w: number, h: number): void; dispose(): void;
}
```

`frame`：墙的 z = `lerp(spawnZ, 0, progress)`；小人姿势 = 有 `assist` 时 `lerpSkeleton(live, target, k)`，否则 `live`；`skeleton` 为空时保持上一姿势；按 `state.live.badParts` 给小人上色；`tuning.ghost` 为假时不建落位轮廓。墙体网格每面墙建一次，旧墙在碎裂动画结束后 `disposeObject`。

- [ ] **Step 1:** 实现四个文件。
- [ ] **Step 2（验证）:** 在 Task 22 的页面接好之后，用 `?sim=auto&seed=7&e2e=1` 跑到第 3 面墙，分别在"墙驶来途中""穿过瞬间"截图；用 `?sim=wrong` 截"撞墙落水"。人工确认：洞的形状与小人的目标姿势一致、落位轮廓套在小人身上、过关时不穿模、落水有水花；控制台无报错、无 WebGL 警告。连续跑 30 面墙后 `renderer.info.memory.geometries` 不持续增长（经 `window.__mw` 读取）。

---

### Task 22: 游戏页（流程、HUD、站位标定、举手悬停、结算）

**Files:** Create `src/games/types.ts` `src/games/index.ts` `src/games/wall/framing.ts` `framing.test.ts` `src/games/wall/WallPlay.tsx` `src/games/wall/hud/{Hud,Banner,FitMeter,LifeRings,FramingGuide,ResultPanel,PauseOverlay}.tsx` `src/engine/ui/airCursor.ts` `airCursor.test.ts` `src/app/components/AirCursorLayer.tsx` `src/app/pages/Play.tsx`

**Interfaces — Produces:**

```ts
// games/types.ts
export interface GameProps { engine: Engine; settings: Settings; flags: ReturnType<typeof readFlags>; onExit(): void }
export interface GameModule { id: string; name: string; blurb: string; Component: React.LazyExoticComponent<React.ComponentType<GameProps>> }
// games/index.ts
export const GAMES: GameModule[]                 // wall、bubbles
// wall/framing.ts（纯函数）
export type FramingIssue = 'none' | 'nobody' | 'partial' | 'close' | 'far' | 'left' | 'right'
export interface FramingResult { issue: FramingIssue; text: string; mode: 'full' | 'upper' | null }
export function checkFraming(body: Body | null): FramingResult
export class FramingGate { constructor(holdMs?: number); update(body: Body | null, motion: Motion | null, nowMs: number): { ready: boolean; progress: number; result: FramingResult }; reset(): void }
// engine/ui/airCursor.ts（纯函数 + 小状态机）
export interface CursorState { active: boolean; x: number; y: number; hand: 'L' | 'R' | null }      // x、y 为视口 0..1
export class AirCursor { update(body: Body | null, profile: BodyProfile): CursorState; reset(): void }
export class DwellClicker { constructor(dwellMs?: number); update(targetId: string | null, nowMs: number): { progress: number; fire: string | null } }
```

规则：
- `checkFraming`：`null` → `nobody`「站到摄像头前面来」；头或双肩 `ok` 为假 → `partial`「让摄像头看到你的头和肩膀」；`view` 高度（`top − bottom`）< 1.1 → `close`「往后退一点」；> 5 → `far`「往前走一点」；`|root.x 相对画面中心| > 0.6` → `left` / `right`「往左站一点 / 往右站一点」；否则 `none`「站得很好，别动」。`mode` 取 `body.mode`。
- `FramingGate`：`issue === 'none'` 且 `motion.energy < 0.12` 连续 `holdMs`（默认 1200）→ `ready`；条件中断则进度清零。
- `AirCursor`：腕高于同侧肩 0.05 米即激活（两只手都举时取更高的）；光标 = 手相对"以肩为中心、宽 1.0 高 0.7 米的框"的位置映射到视口，指数平滑；手放下 0.3 秒后失活。
- `DwellClicker`：同一目标上停留 `dwellMs`（默认 1100）触发一次；换目标或离开清零；触发后须离开再回来才能再次触发。
- `WallPlay` 流程：`engine.status` 为 `loading` 显示 `LoadingCard`（下载进度）→ `error` 显示 `ErrorCard` → `ready` 后站位引导（`FramingGuide` 显示提示语和进度环，全身装不下时附带"或者把屏幕往后仰一点"）→ `ready` 时 `tracker.calibrate()`、`tracker.setMode(result.mode)`、`game.start(...)` → 游戏中 `Hud` → `over` 后 `ResultPanel`（闯到第几关、过了几面墙、得分、最高连击、三种星的数量；按钮"再来一次""回首页"）。`sim` 为 `auto` / `wrong` 时跳过站位引导，由策略驱动模拟玩家；`fast` 把墙速 ×3（端到端用）。
- 标签页隐藏时 `game.setPaused(true)`；`Esc` 或暂停按钮切换暂停。暂停层和结算层的按钮带 `data-air="<id>"`，`AirCursorLayer` 用 `document.elementsFromPoint` 找目标并画光标和进度环。
- 事件 → 声音与语音：`wall` 播 `spawn` 并 `speak(wall.say)`；`tick`、`countdown` 播 `tick`；过关 `pass` / `perfect`；撞墙 `hit`，落水时 `splash`；`levelup`、`over` 各一。`setApproach(progress)` 驱动驶来的风声。
- `e2e` 或开发模式下把 `game` 挂到 `window.__mw.game`。

- [ ] **Step 1: 写失败的测试**
  - `checkFraming(null).issue === 'nobody'`；头 `ok=false` → `partial`；默认相机下的站立玩家 → `none` 且 `mode 'full'`；`legs:false` → `none` 且 `mode 'upper'`；`cam.s = 1.2`（离得很近、`view` 高 0.83）→ `close`；玩家在 `x = 1.0` → `right` 或 `left`（与方向一致，测试里两侧各测一次）。
  - `FramingGate`：静止 1200 毫秒后 `ready`；第 800 毫秒时 `energy` 变 0.5 → 进度清零、需重新累计。
  - `AirCursor`：双手下垂 → `active false`；举右手到肩上方正中 → `active true`、`hand 'R'`、`x` 在 0.5±0.15；手向玩家右侧移动 0.3 米 → `x` 增大；放下 0.4 秒后失活。
  - `DwellClicker`：同一目标 1100 毫秒 → `fire` 一次；继续停留不再触发；离开再回来可再次触发；中途换目标清零。
- [ ] **Step 2–4:** FAIL → 实现纯逻辑 → PASS。
- [ ] **Step 5:** 实现 `WallPlay.tsx`、各 HUD 组件、`AirCursorLayer`、`Play.tsx`（按 `route.game` 从 `GAMES` 取组件，`Suspense` 包裹）。
- [ ] **Step 6（验证）:** 执行 Task 21 的 Step 2；另外用 `?sim=wrong&fast=1&e2e=1` 等到 `window.__mw.game.state.phase === 'over'`，截结算页。

---

### Task 23: 姿势实验室与自定义墙

**Files:** Create `src/games/wall/customPoses.ts` `customPoses.test.ts` `src/app/pages/Lab.tsx` `src/app/components/{SkeletonCanvas,FeatureMeters,PoseGallery,RecorderPanel}.tsx`；Modify `vite.config.ts`（开发期写盘接口）

**Interfaces — Produces:**

```ts
export function validatePose(input: unknown): PoseSpec | null          // 结构、数值范围、id 字符集校验；名字里有禁用词或空名返回 null
export function estimateTier(spec: Pick<PoseSpec, 'armL' | 'armR' | 'legL' | 'legR' | 'spine'>): 1 | 2 | 3 | 4
export function isUpperOk(spec: Pick<PoseSpec, 'legL' | 'legR'>): boolean   // 两腿都接近 DEFAULT_LEG（角度差 ≤ 12°、比例 ≥ 0.85）
export function capturePose(sk: Skeleton, profile: BodyProfile, name: string): PoseSpec   // id 形如 'my-<时间戳36进制>'
export async function loadCustomPoses(): Promise<PoseSpec[]>           // /custom-poses.json（404 视为空）与 localStorage 'mw.customPoses' 合并去重
export async function saveCustomPose(spec: PoseSpec): Promise<'file' | 'local'>   // 先 POST /__poses，失败则存本地
export async function deleteCustomPose(id: string): Promise<void>
export function poseToCode(spec: PoseSpec): string                     // 可直接贴进 poses.ts 的 TypeScript 字面量
```

`estimateTier`：单脚（某条腿大腿比例 < 0.5 或两踝高度差明显）→ 4；`|脊柱倾角| > 10`、下蹲（大腿比例 < 0.85 或角度 > 45）→ 3；左右手臂不对称（角度差 > 20）或双腿张开（大腿角 > 14）→ 2；否则 1。
开发期接口（只在 `vite dev` 存在）：`POST /__poses`（请求体经 `validatePose`，追加到 `public/custom-poses.json`，同 id 覆盖）、`DELETE /__poses/<id>`；非法请求体返回 400。
`WallGame` 的 `pool` 由 `WallPlay` 传入：内置姿势 + 开启了"加入闯关"的自定义姿势（开关状态存 `localStorage 'mw.customEnabled'`，默认开）。
实验室三个页签：**实时**（摄像头小窗 + 骨架、各段朝向角、八个特征的条形表、事件闪烁、"存成新墙"表单）· **图鉴**（全部姿势和几何洞，用 2D 画布画墙洞轮廓 + 目标骨架；自定义的可改名、改层、删除、复制成代码、开关"加入闯关"）· **录制**（开始 / 停止、帧数、下载 JSON、载入 JSON 回放）。

- [ ] **Step 1: 写失败的测试**
  - `validatePose`：合法对象原样通过；缺 `armL`、角度非数字、`tier: 7`、名字为空、名字含"墙来了" → `null`；多余字段被丢弃。
  - `estimateTier`：`t` → 1，`disco` → 2，`star` → 2，`side-bend` → 3，`squat` → 3，`crane` → 4。
  - `isUpperOk`：`t` → `true`，`star` → `false`。
  - `capturePose(poseToSkeleton(T), profile, '我的T')`：臂的角度在 90±1，`tier 1`，`upperOk true`，`id` 以 `my-` 开头。
  - `poseToCode(spec)` 的输出用 `new Function` 求值后与 `spec` 深度相等。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。
- [ ] **Step 5:** 实现写盘接口和实验室页面。
- [ ] **Step 6（验证）:** 开发服务器下 `curl -X POST localhost:5188/__poses -d '<合法 JSON>'` → 200 且 `public/custom-poses.json` 出现该项；发非法 JSON → 400；`DELETE` 后消失。假摄像头（`tests/fixtures/photos/pose.jpg`）打开 `#/lab?e2e=1`：`window.__mw.tracker.state.present === true`，测得的左右上臂朝向角都在 90±25（照片里是平举）。截图鉴页，人工逐个看 24 个姿势和 5 个几何洞的形状是否像样，不像的回 Task 12 调角度。

---

### Task 24: 示例小游戏「戳泡泡」

**Files:** Create `src/games/bubbles/logic.ts` `logic.test.ts` `src/games/bubbles/index.tsx`

**Interfaces — Produces:**

```ts
export interface Bubble { id: number; x: number; y: number; r: number; vy: number; hue: number }     // 归一化画面坐标，y 向下
export interface BubbleState { bubbles: Bubble[]; score: number; timeLeft: number; over: boolean }
export class BubbleGame { constructor(seed: number, durationSec?: number);    // 默认 45 秒
  update(dtSec: number, hands: { x: number; y: number; r: number }[]): { popped: Bubble[] };
  readonly state: BubbleState }
```

规则：每 0.6 秒从底部生成一个泡泡上浮；手（`Body.image` 里的腕点，半径 0.05）碰到即破，+1 分；飘出顶部消失；时间到 `over`。整个示例控制在约 150 行，文件头注释说明"这是照着写新游戏的模板"。画面：镜像的摄像头画面铺底，Canvas 2D 画泡泡和分数；没有摄像头画面（模拟模式）时铺纯色并画骨架。

- [ ] **Step 1: 写失败的测试**：10 秒后生成过约 16 个泡泡（15～18）；手放在某个泡泡上 → 该泡泡进 `popped`、`score + 1`、从列表移除；没有手时分数不变；泡泡飘出顶部后被移除；45 秒后 `over` 且之后 `update` 不再改变状态；同种子序列相同。
- [ ] **Step 2–4:** FAIL → 实现 → PASS。
- [ ] **Step 5（验证）:** `#/play/bubbles?sim=manual&e2e=1` 截图，无控制台报错。

---

### Task 25: 端到端脚本、README、收尾

**Files:** Create `tools/cdp.mjs`（自草稿目录整理）`tools/make-fake-cam.mjs` `tools/e2e.mjs` `README.md`

**Interfaces — Produces:** `npm run e2e`：构建 → 起 `vite preview` → 依次跑下列场景 → 任一失败以非零码退出，并把截图存到 `e2e-out/`（已在 `.gitignore`）。

| 场景 | 地址 | 通过条件 |
|---|---|---|
| home | `/#/` | 标题含「体感工坊」；无控制台 error |
| sim-pass | `/#/play/wall?sim=auto&seed=7&fast=1&e2e=1` | 60 秒内 `__mw.game.state.wallIndex >= 6` 且 `lives === 3`；无 error |
| sim-fail | `/#/play/wall?sim=wrong&fast=1&e2e=1` | 60 秒内 `phase === 'over'` 且页面出现"再来一次" |
| lab-cam | `/#/lab?e2e=1` + 假摄像头 | 30 秒内 `__mw.tracker.state.present === true`；左右上臂朝向角在 90±25 |
| bubbles | `/#/play/bubbles?sim=manual&e2e=1` | 页面渲染出画布；无 error |
| denied | `/#/play/wall?e2e=1`，不给假摄像头且拒绝授权（`--deny-permission-prompts`） | 出现错误卡片和"用演示模式看看"按钮；点它后进入游戏 |

- [ ] **Step 1:** 整理 `tools/cdp.mjs`（保留 `--url --until --eval --shot --fake-video --flag` 等参数，并导出 `launch()` 供 `e2e.mjs` 复用）；写 `make-fake-cam.mjs`（经无头 Chrome 画布把照片转成 1280×720 基线 JPEG，再拼成 MJPEG）。
- [ ] **Step 2:** 写 `tools/e2e.mjs`。Run `npm run e2e` → 六个场景全部 `PASS`。
- [ ] **Step 3:** 逐张看 `e2e-out/` 的截图；发现的画面问题回到对应任务修，重跑直到满意。
- [ ] **Step 4:** 写 `README.md`：怎么装（镜像源、`npm run setup`）、怎么跑、目录与六层流水线对照、坐标约定、**如何加一面墙**（实验室存 / 手写 `PoseSpec`）、**如何加一个游戏**（照 `bubbles`）、可调参数在哪、性能（实测 `detectMs` 与 Worker 后续项）、已验证与未验证的范围。
- [ ] **Step 5（最终验证）:** `npm test`、`npx tsc --noEmit`、`npm run build`、`npm run e2e` 全部通过；`grep -r "墙来了\|动动乐园" src public README.md` 无结果。

---

## Self-Review 记录

- **规格覆盖**：4.1 流程与关卡 → Task 16、17、22；4.2 第 1～2 条 → Task 6、12；第 3 条 → Task 13、14；第 4、8 条 → Task 15、16；第 5～7 条 → Task 9、16、17；4.3 画面与声音 → Task 19～21；5.2 → Task 5、9、8、18；5.3 自定义墙 → Task 23；5.4 特征 → Task 10；举手悬停 → Task 22；模拟玩家 → Task 7；录制回放 → Task 11、23；示例游戏 → Task 24；验证 → 各任务 + Task 25。
- **未覆盖项**：规格"首页演示（模拟玩家在背景里自己玩）"没有单独任务——并入 Task 19 的首页，属加分项，时间不够可不做，README 里注明。
- **类型一致性**：`Skeleton` 全程是 `Record<JointName, Vec3>`；`Body.skeleton` / `Body.ok` 供判定和小人使用；`PartId`、`LimbId`、`limbsToParts` 在 Task 12 定义、Task 15、17、21 使用；`Tuning` 字段名与 Task 16 的表一致。

---

## 第二阶段（2026-11-11）：把第一版"没做的"补上

第一版交付后列出的六项未做内容，外加一处加固。约束沿用上面的 Global Constraints；每项都先写失败的测试。

### Task 26: 摄像头源可测

`CameraPoseSource` 的外部依赖（开摄像头、建识别器、排下一帧、时钟）改为可注入（`deps`），默认值是真的那一套；新增 `numPoses` 选项。
测试（假摄像头、假识别器，不碰浏览器）：启动时并行开摄像头和建识别器，任一失败收拾掉另一个；Worker 建不起来退回主线程；每来一帧识别一次、时间戳递增、识别器忙就丢帧；`stop` 用对的办法取消回调并关掉摄像头和识别器；连续失败只报一次 `detect`；`numPoses` 透传。

### Task 27: 引擎控制器

`src/app/engineController.ts`：把 `useEngine` 里的全部逻辑（建源、测速选模型、记结论、重试、演示模式、超时没帧）搬进一个不依赖 React 的类；`useEngine` 只剩订阅。来源三种：摄像头 / 模拟玩家 / 录制回放（`kind: 'replay'`）。
测试（假的姿态来源）：加载 → 就绪；出错 → 重试；演示模式；配置没变不重启、变了才重启；销毁后迟到的 `start()` 会被关掉；自动选模型的三种结局（够快 / 太慢换轻量并重启 / 量不出来不记）；记住的结论过期重测；`people`、`replay` 透传；重启时清掉标定。

### Task 28: 一局游戏的"会话"与中途重新标定

`WallGame.recalibrate(ctx)`：换一套标定接着玩——在飞的墙作废（`skip`），重新 3-2-1，分数 / 命 / 关卡不变。
`src/games/wall/session.ts` 的 `WallSession`：站位引导 → 标定 → 开局；过期数据当没人；模拟玩家照墙摆；**发现姿态来源换了（引擎重启过）就回到站位引导，过了之后 `recalibrate` 接着玩**；`again()` 沿用标定再来一局。`WallPlay` 只剩画面、声音、界面。
测试：真人要先站稳才开局；模拟玩家直接开；造型池没读完不开；标定后的可见范围是新原点下的；数据过期按没人处理；引擎重启后回到引导、再继续同一局；引擎没就绪时什么都不推进；`again()`。

### Task 29: 场景自带画布

`createStage(host, quality)` 自己创建 `<canvas>` 挂到 `host` 里，销毁时 `forceContextLoss()` 并移除画布（React 严格模式两次挂载各用各的画布）。重建场景时把正在飞的墙补回去。
验证：端到端反复进出游戏 20 次，没有"WebGL 上下文太多"的警告，最后一次画面正常。

### Task 30: 游戏中的设置

`GameProps.onSettings`；HUD 和暂停面板各有"设置"按钮，打开时自动暂停。设置对话框打开期间举手光标不工作。
验证（端到端，假摄像头）：游戏中打开设置、把模型换成轻量 → 引擎重启 → 站位引导 → 同一局继续（同一个游戏对象、命数没变）。

### Task 31: 同时识别两个人

设置项 `twoPeople`（默认关）→ `numPoses: 2`。调试信息里标出来。
验证：设置的校验测试；端到端（假摄像头）开着它能识别到人。真实的多人画面无法在这里验证。

### Task 32: 用录制代替摄像头

`src/app/replayOverride.ts`（本次打开期间有效）；实验室"录制"页："用这段代替摄像头 / 换回摄像头"；首页和实验室有提示。
验证：存取与通知的单元测试；端到端录一段 → 顶替 → 实时页照常出角度 → 换回。

### Task 33: 首页自动演示、接口只认本机、收尾

`src/games/wall/Attract.tsx`：用 `WallSession` + 模拟玩家在首页背景里自己玩（懒加载、不出声、系统要求"减少动态效果"时不启用）。
`checkWriteRequest` 增加来源地址：只认本机回环地址。
端到端补上述场景；README 更新；全部检查重跑；独立审查一遍，修一轮。
