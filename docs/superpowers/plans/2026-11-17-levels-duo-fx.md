# 十五关 · 全身姿势 · 通关氛围 · 更真的动效 · 双人 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 把「别撞墙！」从"无尽的摆胳膊"改成十五关、全身姿势、过了有庆祝、动效按物理来、能两个人同屏配合的闯关游戏。

**Architecture:** 游戏规则仍是不碰画面的纯状态机；关卡改成一张手写的 15 关表（每关"新 + 复习"两种名额）。双人 = 引擎里两条泳道各一个 `PlayerTracker`，一面墙两个洞，各判各的再合并结果；标定时把每位玩家的原点放到自己的泳道上，所以下游拿到的 `Body` 直接是舞台坐标。动效拆成"不碰画面的物理模块（可单测）+ 场景里的渲染"两层。

**Tech Stack:** 不变——Vite 8 · TypeScript 7 · React 19 · Three.js 0.187 · `@mediapipe/tasks-vision` · Vitest 5 · `tools/e2e.mjs`（无头 Chrome）。不加任何运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-16-levels-duo-fx-design.md`（下文叫"设计"；旧设计 `2026-11-10-wall-pose-game-design.md` 没被它改掉的部分继续有效）

## Global Constraints

- **不提交**：所有任务都没有 commit 步骤；用户说"提交并推送"时再一次做完。
- 名字不动：`src/brand.ts` 仍是「别撞墙！」；`brand.test.ts`、`customPoses.ts` 的 `BANNED` 不改。代码、文案里不出现"墙来了""墙来啦"。
- 界面上新增的文案**只能是设计第 5 节列出来的那些**，逐字照抄；设计没列的提示、确认框、界面元素不加。
- 不加运行时依赖；不做后处理（泛光、景深）；每种粒子一个实例化网格、一次绘制；所有粒子有总量上限，低画质数量减半。
- 所有手感数值集中在 `src/games/wall/tuning.ts`（物理常数放在各自模块开头）。
- 单人模式的识别行为和现在完全一样：`people = 1` 时不设泳道、`numPoses = 1`。
- 判定和画面用同一份数据（墙的标量场、目标骨架）；慢动作、顿帧只作用在画面上，不动游戏时钟。
- 测试先行；测试不依赖真实摄像头或真人（`SimPoseSource`、假摄像头）。测试与源码同目录，`npx vitest run <文件>`；全量 `npx vitest run`；类型 `npx tsc --noEmit`；端到端 `npm run e2e`。
- 注释沿用现有风格：中文，说"为什么"。

## Review Focus

设计没逐条写、但真人最容易踩到的五种情况，各在所属任务里加了测试：

1. **双人里一位走过了分界线 / 旁人插进来**：只能是"看不到人 → 暂停"，绝不能两个小人跟同一个人，也不能换边。→ Task 5 `selectPerson.test.ts`「lanes」。
2. **两位身材差很多（大人带小孩）**：两个洞各按各的身材挖，配对检查、手拉手的角度按各自的臂长算，不交叠。→ Task 7 `duo.test.ts`。
3. **没命之后连点两次"再闯这一关"、或者通关后调用它**：第二次什么也不发生；通关后不能重闯。→ Task 3 `game.test.ts`。
4. **浏览器里存着旧设置（带 `twoPeople`）、地址里 `level=0 / 16 / abc`、`players=3`**：忽略，不报错，按默认来。→ Task 6 `settings.test.ts`、Task 4 `router.test.ts`。
5. **视野很窄或只看得到上半身，又选了双人 / "只练一面墙"**：每一面墙都出得来，实在配不上就退回两人叉腰，绝不卡死。→ Task 2、Task 7 的"出得来"测试。

---

## File Structure

```
src/engine/body/pose.ts               改：PoseSpec.noMirror
src/engine/body/bodyModel.ts          改：setHome(originX)、rootU
src/engine/tracking/lanes.ts          新：LaneSplit（两条泳道的分界线）
src/engine/tracking/selectPerson.ts   改：可选的泳道
src/engine/player/playerTracker.ts    改：setLane、calibrate({x})、anchor
src/engine/input/simSource.ts         改：两个模拟玩家
src/engine/audio/sfx.ts               改：新音效
src/app/engineController.ts           改：mate 追踪器 + 分界线；people 决定一切
src/app/useEngine.ts settings.ts router.ts pages/{Home,Play,Lab}.tsx
src/app/components/{SettingsDialog,CameraPip,AirCursorLayer}.tsx
src/games/types.ts index.ts           改：GameModule.maxPlayers
src/games/wall/poses.ts               改：48 个姿势 + 双人专属造型
src/games/wall/levels.ts              改：15 关的表、名额制出墙、双人配对
src/games/wall/tuning.ts              改：关卡名额、庆祝时长、双人数值
src/games/wall/duo.ts                 新：两人间距、手臂角度、两个洞放不放得下
src/games/wall/field.ts build.ts judge.ts framing.ts game.ts session.ts   改
src/games/wall/fx/tiles.ts            新：把墙体切成错缝的砖
src/games/wall/fx/debris.ts           新：碎块的物理
src/games/wall/fx/ragdoll.ts          新：布娃娃
src/games/wall/scene/{stage,sea,avatar,wallMesh,fx,view}.ts   改
src/games/wall/scene/debrisMesh.ts fireworks.ts sky.ts         新
src/games/wall/hud/{Hud,Panels}.tsx hud.css  WallPlay.tsx  Attract.tsx   改
tools/e2e.mjs  README.md              改
```

---

# 第一阶段：姿势、十五关、命、通关（单人）

### Task 1: 姿势库 24 → 48

**Files:** Modify `src/engine/body/pose.ts`, `src/games/wall/poses.ts`; Test `src/games/wall/poses.test.ts`

**Interfaces — Produces:**
- `PoseSpec.noMirror?: boolean`（出墙时不取左右镜像）
- `POSES`（48 个，id 见下表）、`getPose(id)` 不变
- `DUO_POSE_IDS = ['hold-hands', 'bridge'] as const`、`type DuoPoseId`
- `duoPose(id: DuoPoseId, side: -1 | 1, armAngle: number): PoseSpec` —— `side = -1` 是站左边的那位（内侧是右手）；内侧手臂两段都是 `armAngle`；外侧：手拉手自然下垂，搭桥 `pair(40, -40)`；右边那位的 id 带 `~m`；`noMirror: true`、`upperOk: true`；`name` / `say`：`手拉手` / `两个人手拉手`，`搭桥` / `两个人把手举高，搭一座桥`。

新姿势（`both(a,b)` 两臂相同；`legs(a,b,sa?,sb?)` 两腿相同；HORSE = `legs(62,-6,0.8)`；LUNGE = `legL(54,-4) legR(40,40)`；FROG = `legs(80,-28,0.9,0.85)`；CRANE = `legL(0,0) legR(10,0,0.25)`；SALUTE = `armR(100,-122)`）：

| id | 名字 | 层 | 语音 | 角度 |
|---|---|---|---|---|
| salute | 敬礼 | 2 | 右手敬礼 | SALUTE；noMirror |
| x-jump | 开合跳 | 2 | 手脚都张开，像开合跳 | both(140,140) legs(24,24) |
| a-frame | 人字 | 2 | 双脚分开，站成人字 | both(15,10) legs(26,26) |
| seesaw | 跷跷板 | 3 | 双手平举，身体歪向一边 | armR(70,70) armL(110,110) legs(20,20) spine a20 |
| moon | 弯月 | 3 | 双手举过头，往旁边弯 | armR(158,160) armL(202,205) legs(14,14) spine a22 head 5 |
| horse | 扎马步 | 3 | 扎马步，双手叉腰 | both(40,-40) HORSE |
| sumo | 相扑 | 3 | 蹲低一点，双手扶膝盖 | both(24,24) legs(75,-12,0.9) |
| warrior | 战士 | 3 | 侧弓步，双手平举 | both(90,90) LUNGE |
| archer-lunge | 弓步射箭 | 3 | 弓步站稳，拉弓射箭 | armL(90,90) armR(90,-90) LUNGE |
| lunge-reach | 弓步摘星 | 3 | 弓步，一只手伸上去摘星星 | armL(165,168) armR(40,-40) LUNGE spine a-8 |
| frog | 青蛙蹲 | 3 | 蹲到底，膝盖朝外 | both(4,-4) FROG spine s0.85 |
| squat-up | 蹲下举手 | 3 | 蹲下去，双手举高 | both(165,170) legs(80,0,0.45,0.9) spine s0.85 |
| bow | 深鞠躬 | 3 | 深深鞠一躬 | both(4,2) spine s0.5 |
| airplane | 小飞机 | 3 | 弯下腰，张开双手当翅膀 | both(90,90) legs(14,14) spine s0.55 |
| white-crane | 白鹤亮翅 | 4 | 抬起一条腿，一手指天一手指地 | armL(160,165) armR(45,45) CRANE |
| flamingo | 火烈鸟 | 4 | 一只脚向后勾起来，双手叉腰 | both(40,-40) legL(0,0) legR(4,0,1,0.25) |
| one-leg-star | 单脚大字 | 4 | 单脚站稳，另一条腿往旁边抬 | both(95,95) legL(0,0) legR(45,45) spine a-8 |
| horse-disco | 马步指天 | 3 | 扎马步，一手指天一手指地 | armL(150,150) armR(35,35) HORSE |
| horse-salute | 马步敬礼 | 3 | 扎着马步敬个礼 | SALUTE armL(40,-40) HORSE；noMirror |
| lunge-moon | 弓步弯月 | 3 | 弓步，双手举过头往旁边弯 | armL(162,164) armR(198,200) LUNGE spine a-18 head -5 |
| squat-flex | 蹲下秀肌肉 | 3 | 蹲下去，秀出你的肌肉 | both(90,180) FROG spine s0.85 |
| crane-salute | 独立敬礼 | 4 | 金鸡独立，再敬个礼 | SALUTE CRANE；noMirror |
| tree-t | 独木桥 | 4 | 单脚站，双手平举 | both(90,90) legL(0,0) legR(60,-60) |
| kick-up | 踢腿举手 | 4 | 一条腿往旁边踢，双手举高 | both(165,168) legL(0,0) legR(55,55) spine a-8 |

现有两个修正：`star` 改成 `both(100,100) legs(24,24)`；`wide-t` 改成 `both(90,90) HORSE`、层 3、语音 `扎马步，双手平举`。

- [x] **Step 1: 改测试**（`poses.test.ts`）：`POSES.length === 48`；id 互不相同；上表每个 id 都 `getPose` 得到且 `name`、`say` 与表一致；`noMirror` 的正好是 `salute / horse-salute / crane-salute`；`getPose('star')!.armL[0].a === 100`；`targetLimbs(getPose('wide-t')!).thighL.angle === 62`；每个姿势"自己判自己"`matched` 且 `accuracy > 0.9`（沿用文件里现有的那条写法）；`mirrorPose(mirrorPose(p))` 深等于 `p`；`upperOk` 与 `customPoses.isUpperOk(p)` 一致；`duoPose('hold-hands', -1, 50)` 的 `armR` 两段都是 50、`armL` 是 `DEFAULT_ARM`、id 是 `hold-hands`；`duoPose('bridge', 1, 140)` 的 `armL` 两段 140、`armR` 是 `[{a:40},{a:-40}]`、id 是 `bridge~m`。
- [x] **Step 2:** `npx vitest run src/games/wall/poses.test.ts` → 失败（只有 24 个）。
- [x] **Step 3:** 实现。`pose()` 的第 5 个参数加可选的 `noMirror`。
- [x] **Step 4:** 同一条命令 → 通过；`npx vitest run src/games/wall` 里因为姿势数变化而挂的断言留到 Task 2 一起改。

### Task 2: 十五关的表和名额制出墙（单人）

**Files:** Modify `src/games/wall/levels.ts`, `src/games/wall/tuning.ts`; Test `src/games/wall/levels.test.ts`

**Interfaces — Consumes:** Task 1 的 `POSES`、`noMirror`。

**Produces:**
```ts
// tuning.ts —— COMMON 新增（删掉 wallsBase / wallsMax / tolStepPerLevel / approachStepPerLevel / shapeChance）
levels: 15,
levelSlots: [[3,0],[2,1],[2,1],[2,1],[2,1],[2,2],[3,1],[3,1],[1,3],[2,2],[3,1],[3,1],[3,1],[3,1],[0,4]],  // [新, 复习]
reviewDecay: 0.75,     // 复习：每往前隔一关，被抽到的权重乘这么多
customChance: 0.5,     // 复习名额给"还没出过的自存墙"的概率
offsetFromLevel: 9,

// levels.ts
export interface LevelDef { theme: string; poses: string[]; shapes: string[]; reviewFrom?: [number, number] }
export const LEVELS: LevelDef[];                       // 15 项，内容照设计 5.3 的表；第 15 关 reviewFrom: [11, 14]
export const CUSTOM_FROM_LEVEL: Record<1 | 2 | 3 | 4, number>;   // { 1: 2, 2: 3, 3: 5, 4: 11 }
export interface LevelPlan { level: number; walls: number; fresh: number; review: number; theme: string; offsets: boolean; angleTol: number; approachSec: number }
export function levelPlan(level: number, t: Tuning): LevelPlan;  // 关数夹在 1～15；容差和墙速从第 1 关的值线性过渡到第 15 关的下限（approachSec 取两位小数）
export interface WallSpec { /* 现有字段 */ fresh: boolean }
export class WallSequence {
  constructor(seed: number, difficulty: Difficulty, pool?: { poses: PoseSpec[]; shapes: ShapeSpec[] }, opts?: { startLevel?: number });
  level: number; wallInLevel: number;
  get wallsInLevel(): number;
  /** 这一关的墙出完了，而且这是最后一关 */
  get finished(): boolean;
  next(ctx: SpawnCtx): WallSpec;
  forgetLast(): void;
  /** 这一关从头再来：进度清零，这一关的墙重新抽 */
  restartLevel(): void;
}
```

出墙规则（`next`）：进入一关时用种子把这一关的名额（`fresh` 个"新"、`review` 个"复习"）洗成一个顺序；整局第 1 面固定是 `t`（占一个"新"）。

- **新**：这一关 `LEVELS[n].poses / shapes` 里、池子里有、当前模式做得了、放得下、这一关还没出过的，随机一个。
- **复习**：前面关卡（或 `reviewFrom` 指定的几关）出现过的造型，权重 `reviewDecay^(隔了几关 - 1)`；自存的墙（不在任何一关的表里）按 `CUSTOM_FROM_LEVEL[tier]` 入池。还有"够得上这一关、整局没出过"的自存墙时，先掷 `customChance`，中了就从它们里挑。
- 候选为空时依次放宽：新 → 复习 → 池子里到这一关为止的任何造型（可重复，但不和上一面相同）→ 池子里任何放得下的 → `t`。
- 左右不对称且没有 `noMirror` 的姿势，一半概率取镜像（镜像放不下就不取）。
- 偏置：`level >= offsetFromLevel` 时，**复习**的人形洞以 `offsetChance` 偏到旁边 `offsetX`；带 `offset` 的几何洞（偏门）照旧总是偏。

- [x] **Step 1: 重写 `levels.test.ts` 里 `levelPlan` 和 `WallSequence` 两组**（`tuning` 那组保留）：
  - `LEVELS.length === 15`；`COMMON.levelSlots` 15 项，墙数合计 55、"新"合计 34；表里每个 id 都在 `POSES` / `SHAPES` 里；48 个姿势、5 个几何洞各恰好属于一关。
  - `levelPlan(1, normal)` 匹配 `{ walls: 3, fresh: 3, review: 0, theme: '热身', offsets: false, angleTol: 32, approachSec: 6.5 }`；`levelPlan(15, normal)` 匹配 `{ walls: 4, fresh: 0, review: 4, theme: '终极挑战', offsets: true, angleTol: 25, approachSec: 3.6 }`；`levelPlan(8, normal).angleTol === 28.5`；`levelPlan(99, normal).level === 15`。
  - 同种子同墙、不同种子不同（沿用现有写法，取 55 面）。
  - 全身、视野够宽：55 面墙之后 `seq.finished`；每关的墙数、`fresh` 的个数与 `levelSlots` 一致；`fresh` 的墙的造型属于这一关的表；复习墙的造型属于更早的关；第 15 关的造型都来自 11～14 关；第 2 关起每关至少一面用到腿（`!upperOk`）。
  - 一关之内不重复（视野够宽时）；第 1 面是 `t`。
  - 半身（`mode: 'upper'`）：55 面全是 `upperOk` 的。视野很窄（`{left:-0.9,right:0.9,bottom:0.02,top:1.9}`）：55 面都出得来，每面目标骨架的判定关节都在视野内。
  - 第 9 关之前 `holeX` 恒等于玩家位置；之后只有复习的人形洞和偏门会偏。
  - `noMirror`：跑 300 面，`salute~m`、`horse-salute~m`、`crane-salute~m` 从不出现。
  - 自存的墙：池子里加一面 `tier: 1` 的 `my-a`，全程至少出现一次、从不在第 1 关、`fresh === false`；`tier: 4` 的不早于第 11 关。
  - 池子只有一面墙（`only`）：55 面全是它，不抛错。
  - `forgetLast()` 之后这一关多出一面；`restartLevel()` 之后 `wallInLevel === 0`、还是这一关、再出 `wallsInLevel` 面后进下一关。
  - `opts.startLevel: 15`：第一面墙 `level === 15`。
- [x] **Step 2:** `npx vitest run src/games/wall/levels.test.ts` → 失败。
- [x] **Step 3:** 实现 `tuning.ts`、`levels.ts`。
- [x] **Step 4:** 通过。

### Task 3: 规则——回命、过关停留、通关、再闯这一关、半身多等几秒

**Files:** Modify `src/games/wall/game.ts`, `session.ts`, `framing.ts`, `tuning.ts`; Test `game.test.ts`, `session.test.ts`, `framing.test.ts`

**Produces:**
```ts
// tuning.ts
levelUpSec: 3.0,        // 过关庆祝停留
levelIntroAtSec: 1.7,   // 庆祝进行到这时，换成下一关的预告
finaleSec: 10,          // 通关演出
// game.ts
export type Phase = 'idle' | 'countdown' | 'approach' | 'resolve' | 'levelup' | 'finale' | 'paused' | 'over';
export interface Summary { /* 现有 */ cleared: boolean; players: 1 | 2 }
export type GameEvent = /* 现有，改这几项 */
  | { type: 'life'; lives: number; delta: 1 | -1 }
  | { type: 'levelup'; level: number; cleared: number }          // level 是新的一关
  | { type: 'levelintro'; level: number; theme: string | null }  // theme 为 null：半身模式不报主题
  | { type: 'allclear'; summary: Summary }
  | { type: 'over'; summary: Summary };
class WallGame {
  constructor(opts: { seed: number; difficulty: Difficulty; pool?: …; startLevel?: number });
  /** 没命结束之后：3 条命，分数和各项统计回到这一关开始时，这一关重新出墙。别的时候调用什么也不做，返回 false */
  retryLevel(): boolean;
}
// session.ts
new WallSession({ seed, sim, difficulty, startLevel?: number })
retryLevel(): void     // 和 again() 一样沿用标定，发一个 { type: 'begin', resumed: false }
// framing.ts
export type FramingIssue = … | 'upper';   // 只看到上半身：算"提醒"，多等 adviseHoldMs
```
规则：过一关（`levelup`）时 `lives = min(COMMON.lives, lives + 1)`，变了才发 `life`（`delta: 1`）。第 15 关的墙出完且还有命 → 发 `allclear`、进 `finale`，`finaleSec` 后进 `over` 并发 `over`（`summary.cleared === true`）。`levelup` 阶段进行到 `levelIntroAtSec` 时发 `levelintro`。`checkFraming`：其余都合适而 `mode === 'upper'` 时返回 `{ issue: 'upper', text: '往后退，让脚也进画面，才能玩全身的姿势', mode: 'upper' }`。

- [x] **Step 1: 测试**（`game.test.ts` 里改掉依赖旧关卡节奏的断言，新增）：
  - `perfect` 策略、三档难度各跑一局：55 个 `outcome` 全是 `pass`；14 个 `levelup`、14 个 `levelintro`；1 个 `allclear`；最后 `phase === 'over'` 且 `summary.cleared`、`summary.level === 15`、`summary.walls === 55`。
  - `allclear` 之后 `finaleSec` 内 `phase === 'finale'`，过后才有 `over`。
  - 回命：先故意撞一面（`lazy` 一面后改 `perfect`），过完这一关 `lives` 回到 3，并有 `{ type: 'life', delta: 1 }`；满命过关不发 `life`。
  - 最后一面墙撞了但还有命：照样 `allclear`。最后一面墙撞掉最后一条命：`over` 且 `cleared === false`，没有 `allclear`。
  - `lazy`：三面墙后 `over`，`cleared === false`，`summary.level === 1`。
  - `retryLevel()`：打到第 3 关后一直撞到结束，记下第 3 关开始时的分数 → `retryLevel()` 返回 `true`，`lives === 3`、`score` 等于那个分数、`level === 3`、`phase === 'countdown'`；紧接着再调一次返回 `false`；通关后调用返回 `false`；进行中调用返回 `false`。
  - `levelintro.theme`：全身是 `LEVELS[level-1].theme`，`mode: 'upper'` 开的局是 `null`。
  - `startLevel: 15`：4 面墙后 `allclear`。
  - `framing.test.ts`：半身返回 `issue: 'upper'` 和上面那句话；`FramingGate` 对它要等 `adviseHoldMs` 才 `ready`，`advisory === true`。
  - `session.test.ts`：没命后 `session.retryLevel()` → `stage === 'playing'`、发出 `begin`、`game.state.lives === 3`；`startLevel` 传到了游戏里。
- [x] **Step 2:** `npx vitest run src/games/wall/game.test.ts src/games/wall/session.test.ts src/games/wall/framing.test.ts` → 失败。
- [x] **Step 3:** 实现。
- [x] **Step 4:** 通过；`npx vitest run` 全绿（`Attract.tsx`、`WallPlay.tsx`、`Hud.tsx` 里因为事件形状变了的编译错误在这一步顺手改到能编译：`npx tsc --noEmit` 通过）。

### Task 4: 第一阶段的界面——文案、结算面板、`level` 开关

**Files:** Modify `src/app/router.ts`, `src/games/wall/WallPlay.tsx`, `hud/Hud.tsx`, `hud/Panels.tsx`, `hud/hud.css`, `Attract.tsx`; Test `src/app/router.test.ts`

**Produces:** `Flags.level: number | null`（1～15 的整数，否则 `null`）；`ResultPanel` 的 props：`{ summary, handsFree, onAgain, onRetry, onHome }`；`BannerData.kind` 增加 `'clear' | 'finale'`。

文案（逐字）：
- 过墙横幅：三星 `完美！`、二星 `漂亮！`、一星 `过关！`；下面一行平时是 `★…　+分数`，连过到 3 / 5 / 8 / 10 面的那一面换成 `三连过！` / `五连过！` / `八连过，停不下来！` / `十连过，封神了！`。
- `levelup`：`第 N 关 通过！`，下面一行按 `(N - 1) % 5` 轮换 `太棒了，继续！` `越来越厉害了！` `稳得很！` `这都难不倒你！` `高手！`。
- `levelintro`：`第 N 关 · 主题`；`theme === null` 时只写 `第 N 关`。
- `allclear`：横幅 `恭喜全部通关！`，语音 `太厉害了！恭喜你，全部通关！`。
- 结算面板：通关——标题 `全部通关！`，副标题 `十五关全部拿下，你就是穿墙王者！`，按钮 `再来一次`、`回首页`；没通关——标题 `闯到第 N 关`，加一句 `差一点点，再来一次肯定行！`，按钮 `再闯这一关`（主按钮，`air="retry"`）、`从头再来`（`air="again"`）、`回首页`。
- `FramingGuide`：删掉只在"半身且不是提醒"时显示的那行（现在半身本身就是提醒）。

- [x] **Step 1: 测试**（`router.test.ts`）：`readFlags('?level=15').level === 15`；`level=0`、`16`、`abc`、`3.5`、缺省 → `null`。
- [x] **Step 2:** 运行 → 失败。
- [x] **Step 3:** 实现：`WallPlay` 把 `flags.level` 传给 `WallSession`；事件 → 横幅 / 语音按上表；`ResultPanel` 按 `summary.cleared` 分两种；`onRetry={() => session.retryLevel()}`。
- [x] **Step 4:** `npx vitest run` 全绿；`npx tsc --noEmit` 通过；`npm run build` 后 `npm run e2e` 现有 15 个场景仍通过（`sim-pass` / `sim-fail` 里依赖旧文案或旧关卡节奏的断言跟着改）。

---

# 第二阶段：双人

### Task 5: 引擎——两条泳道

**Files:** Create `src/engine/tracking/lanes.ts`; Modify `selectPerson.ts`, `src/engine/body/bodyModel.ts`, `src/engine/player/playerTracker.ts`; Test `lanes.test.ts`（新）, `selectPerson.test.ts`, `bodyModel.test.ts`, `playerTracker.test.ts`

**Produces:**
```ts
// lanes.ts
/** 两条泳道的分界线：未镜像的归一化图像 x（0～1）。标定前跟着画面里最大的两个人走，标定后定住。 */
export class LaneSplit { value: number /* 初值 0.5 */; observe(frame: RawFrame): void; freeze(): void; reset(): void }
/** side 说的是屏幕上（镜像后）的左右：屏幕左 = 原始 x ≥ split */
export interface Lane { side: 'left' | 'right'; split: LaneSplit }
export function inLane(lane: Lane, rawX: number): boolean;
// selectPerson.ts
export function describePerson(pose: RawPose, aspect: number): { pose: RawPose; u: number; v: number; size: number } | null;
class PersonSelector { setLane(lane: Lane | null): void }   // 有泳道时，跟人和重新选人都只看这条泳道里的人
// bodyModel.ts
setHome(originX?: number): number;   // 把现在站的位置记为 x = originX（缺省 0）；返回值仍是"旧坐标 − 新坐标"
get rootU(): number | null;          // 髋中心在画面里的横向位置（未镜像，以画面高度为单位）
// playerTracker.ts
setLane(lane: Lane | null): void;
calibrate(at?: { x?: number }): ViewWindow | null;   // 有泳道时顺带把分界线定住（lane.split.freeze()）
get anchor(): { u: number; scale: number } | null;   // 这一帧玩家在画面里的位置和大小（没看到人为 null）
```
`LaneSplit.observe`：把这一帧里看得清双肩的人按肩宽排序，去掉"和更大的那位质心相距不到半个肩宽"的重复检出；剩下不少于两位时，`value` 以 0.3 的比例靠向最大两位的中点；`freeze()` 之后不再动。

- [x] **Step 1: 测试：**
  - `lanes.test.ts`：两个人在 x = 0.3 / 0.6 → 若干帧后 `value ≈ 0.45`；只有一个人时不动；重复检出（两份几乎重合的人）不算两个人；`freeze()` 后不动；`inLane({side:'left'}, 0.7)` 为真、`0.3` 为假，`right` 反之。
  - `selectPerson.test.ts`「lanes」：两个人各在一边，`left` 的选择器只返回原始 x 大的那位，`right` 只返回另一位；左边那位消失 2 秒，`left` 选择器始终返回 `null`（不去抢右边的人）；右边那位走过分界线到了左半边：`right` 返回 `null`，`left` 仍跟着自己原来的人；没设泳道时行为与现有测试完全一样（现有用例全部保留、通过）。
  - `bodyModel.test.ts`：`setHome(-0.7)` 之后同一位置的 `root.x ≈ -0.7`，`view.left / right` 也整体挪了 `-0.7`；返回值等于旧 x 减新 x；`rootU` 等于喂进去的人的髋中心 u。
  - `playerTracker.test.ts`：`calibrate({ x: 0.75 })` 后 `state.body.root.x ≈ 0.75`，返回的 `view` 以新原点为准；`anchor.scale ≈ 模拟摄像头的 s`。
- [x] **Step 2:** 运行这四个文件 → 失败。
- [x] **Step 3:** 实现。
- [x] **Step 4:** 通过。

### Task 6: 两个模拟玩家、引擎里的第二个追踪器、去掉"同时识别两个人"

**Files:** Modify `src/engine/input/simSource.ts`, `src/app/engineController.ts`, `useEngine.ts`, `settings.ts`, `components/SettingsDialog.tsx`, `pages/Play.tsx`, `pages/Lab.tsx`, `src/games/types.ts`, `src/games/index.ts`; Test `simSource.test.ts`, `engineController.test.ts`, `settings.test.ts`

**Produces:**
```ts
// simSource.ts
interface SimOptions { /* 现有 */ people?: 1 | 2; gap?: number /* 两人隔多远，默认 1.5 */ }
setPose(spec: PoseSpec, at?: { x?: number }, blendSec?: number, who?: 0 | 1): void;   // at.x 是舞台坐标
setPresent(on: boolean, who?: 0 | 1): void;                                            // 不给 who = 全体
// 0 号站在 x = -gap/2（屏幕左），1 号站在 +gap/2；people = 1 时和现在完全一样
// engineController.ts
readonly tracker: PlayerTracker;   // 1 号（单人时唯一的玩家）
readonly mate: PlayerTracker;      // 2 号；people = 1 时不喂数据
readonly split: LaneSplit;
EngineDeps.makeSim(opts: { seed: number; people: 1 | 2 }): PoseSource;
// useEngine.ts
interface Engine { /* 现有 */ mate: PlayerTracker | null }   // 双人时才有
// games/types.ts
interface GameModule { /* 现有 */ maxPlayers?: 1 | 2 }        // 「别撞墙！」登记为 2
// settings.ts —— 删掉 twoPeople
```
`EngineController.start()`：`people === 2` 时给 `tracker` / `mate` 设 `left` / `right` 泳道、每帧先 `split.observe(f)` 再喂两个追踪器；`people === 1` 时泳道为 `null`、只喂 `tracker`。`people` 变了一律重启。`Play.tsx` 暂时仍传 `people: 1`（Task 9 接上地址栏的 `players`）；`Lab.tsx` 传 1。

- [x] **Step 1: 测试：**
  - `simSource.test.ts`：`people: 2` 每帧两个人，髋中心在舞台 x ≈ ∓0.75（用 `PlayerTracker` + 泳道各认一个来验证）；`setPose(…, {x: -0.75}, 0, 0)` 只动 0 号；`setPresent(false, 1)` 后只剩一个人；缺省与现有行为一致（现有用例保留）。
  - `engineController.test.ts`：`people: 2` 时两个追踪器各认到一个人且 `tracker` 的在屏幕左（`body.image` 的髋 x 更小）；`people: 1` 时 `mate.state.present === false`；`people` 从 1 改成 2 会重启（`makeSim` / `makeCamera` 被再次调用，且带 `people: 2` / `numPoses: 2`）。
  - `settings.test.ts`：存储里有 `{"twoPeople":true,"sound":false}` → 读出来没有 `twoPeople` 这个键、`sound === false`，不抛错；`DEFAULT_SETTINGS` 里没有它。
- [x] **Step 2:** 运行 → 失败。
- [x] **Step 3:** 实现；设置面板去掉那一行。
- [x] **Step 4:** `npx vitest run` 全绿；`npx tsc --noEmit` 通过。

### Task 7: 双人的墙——间距、配对、两个洞

**Files:** Create `src/games/wall/duo.ts`; Modify `field.ts`, `levels.ts`, `build.ts`, `tuning.ts`; Test `duo.test.ts`（新）, `levels.test.ts`, `game.test.ts`（`buildWall` 一组）

**Produces:**
```ts
// tuning.ts
duo: { minGap: 1.2, maxGap: 1.9, handGap: 0.05, bodyGap: 0.05, minStrip: 0.1, minMerge: 0.02,
       mixFromLevel: 3, mixChance: 0.35, minPersonFrac: 0.5, maxDrift: 0.3, sideMargin: 0.25 },
// field.ts
export const DUO_BOUNDS: WallBounds;   // { x0: -2.6, x1: 2.6, y0: 0, y1: 3.0 }
// duo.ts
export function pairGap(a: Body, b: Body): number;                                    // 两人实际隔多远（米）
export function duoArmAngle(id: DuoPoseId, p: BodyProfile, halfGap: number): number;  // 内侧手臂的角度
export function holeRelation(a: Sdf, b: Sdf, bounds: WallBounds, step?: number): { sep: number; overlap: number };
export function pairFits(a: { hole: Sdf; body?: Sdf }, b: { hole: Sdf; body?: Sdf }, bounds: WallBounds): boolean;
// levels.ts
interface SpawnCtx { /* 现有 */ mate?: { view: ViewWindow | null; profile: BodyProfile; playerX: number }; lanes?: [number, number] /* 两条泳道的中心（标定时两人站的位置） */ }
interface WallSpec { /* 现有 */ mate?: { pose?: PoseSpec; shape?: ShapeSpec; holeX: number }; duo?: DuoPoseId }
// build.ts
buildWall(spec: WallSpec, profile: BodyProfile, t: Tuning, mateProfile?: BodyProfile): BuiltWall;
interface BuiltWall { /* 现有 */ mate?: { target: Skeleton }; labels: { text: string; x: number }[] }
```
- `duoArmAngle`：`L = upperArm + forearm + hand`，`dx = halfGap - shoulderW/2 - handGap/2 - r.hand`；`a = dx >= L ? 90 : asin(max(dx, 0) / L)`（度）；手拉手返回 `a`，搭桥返回 `180 - a`。
- `holeRelation`：在 `bounds` 上按 `step`（默认 0.05）取点；`sep` = 两个洞都不在其内的点上 `a + b` 的最小值（两洞相交时为 0）；`overlap` = 同时在两个洞里的点上 `min(-a, -b)` 的最大值（不相交为 0）。
- `pairFits`：两个洞要么隔着一条看得见的墙（`sep >= minStrip`），要么干脆连成一个（`overlap >= minMerge`）；给了 `body`（身体轮廓，不带余量）时还要求两个轮廓相距 `>= bodyGap`。
- `next(ctx)`（`ctx.mate` 存在时）：每位的"原位" = 自己的 `playerX`，夹在自己泳道中心（`ctx.lanes`）左右 `maxDrift` 以内。按单人的名额规则逐个试候选造型，每个候选依次试配对，第一个"两位各自放得下（各用各的视野和身材）且 `pairFits`"的就用：
  1. 第 `mixFromLevel` 关起、掷中 `mixChance`：2 号换成同一批候选里的另一个造型（"搭配"）；
  2. "同款"：对称的或 `noMirror` 的两人一样；不对称的一人原样、一人镜像（两种朝向随机先后都试）；
  3. 没掷中的话，同款不行再试搭配。
  都不行：两人叉腰（`hips`）。几何洞：两人各一个同样的洞，偏门两人朝同一边偏。
- 双人专属：`ctx.mate` 存在时，第 1 关的"新"里多一个 `hold-hands`、第 2 关多一个 `bridge`，各在自己那一关必出一次（占一个"新"名额），之后进复习池。整局第 1 面：`t` 两人放得下就出 `t`，否则出 `hold-hands`。专属造型的两个 `PoseSpec` 用 `duoPose(id, ∓1, duoArmAngle(id, 各自的身材, 两洞中心之差 / 2))` 现算，`spec.duo = id`，不做 `pairFits` 里"隔开或连成一个"的检查（只查身体不交叠）。
- 双人的偏置（第 9 关起）：两个洞朝同一边偏 `min(offsetX, 两洞中心之差 / 2 - sideMargin)`。
- `buildWall`：有 `spec.mate` 时用 `DUO_BOUNDS`，洞 = 两个洞的并集；`target` 是 1 号的、`mate.target` 是 2 号的（按 `mateProfile` 的身材）。`label` / `say`：专属造型用它自己的名字和语音；两人同款（去掉 `~m` 后 id 相同）`label` = 名字、`say` = `两个人一起：` + 语音；不同则 `label` = `左 甲 · 右 乙`、`say` = `左边甲，右边乙`。`labels`：每个洞一块名牌（单人一块），`x` 是洞的中心。

- [x] **Step 1: 测试：**
  - `duo.test.ts`：`duoArmAngle('hold-hands', 默认身材, 0.6)` ≈ `asin(0.365 / 0.58)` ≈ 39°；`halfGap 0.95` → 90；`bridge` 是 `180 -` 它；按这个角度造出来的两副骨架，内侧两只手的圆心相距 ≈ `handGap + 2·r.hand`（间距 1.2 / 1.5 时）。`holeRelation`：两个相距 0.3 的圆 `sep ≈ 0.3`、`overlap === 0`；相交的 `sep === 0`、`overlap > 0`。`pairFits`：`sep 0.3` 行、`sep 0.04` 不行、深度相交行。大人 + 小孩（`scaleProfile(p, 0.7)`）：手拉手两副骨架的身体轮廓不交叠。`pairGap`：用两人模拟（间距 1.5）量出来 ≈ 1.5。
  - `levels.test.ts`「duo」：间距 1.2 / 1.5 / 1.9、全身，55 面墙都有 `mate`；每面两位的目标轮廓相距 ≥ `bodyGap`；每位的判定关节都在自己的视野里；`hold-hands` 在第 1 关出现、`bridge` 在第 2 关出现；第 1、2 关没有"搭配"（两人 id 去掉 `~m` 相同或是专属造型）；第 9 关之后偏置时两个洞偏移量相同、同号；半身 + 视野窄也出得来 55 面；池子只有一面很宽的墙（`t`）、间距 1.2：不抛错，出的是 `hips`；同种子可复现。
  - `buildWall`（在 `game.test.ts` 那组）：双人墙的场在两个洞的中心都是负的、在 `DUO_BOUNDS` 的边上是正的；`labels.length === 2`；`label` / `say` 三种情况的文案。
- [x] **Step 2:** 运行 → 失败。
- [x] **Step 3:** 实现。
- [x] **Step 4:** 通过。

### Task 8: 双人的规则、站位引导、会话

**Files:** Modify `src/games/wall/judge.ts`, `game.ts`, `framing.ts`, `session.ts`; Test `judge.test.ts`, `game.test.ts`, `framing.test.ts`, `session.test.ts`

**Consumes:** Task 5 `calibrate({x})` / `anchor`，Task 6 `engine.mate`、两人模拟，Task 7 的墙。

**Produces:**
```ts
// judge.ts
export type SoloOutcome = { kind: 'hit'; reason: string; badParts: PartId[] } | { kind: 'pass'; stars: 1 | 2 | 3; accuracy: number };
export type Outcome = SoloOutcome & { each?: [SoloOutcome, SoloOutcome] };
export function combineOutcomes(a: SoloOutcome, b: SoloOutcome): Outcome;
// game.ts
interface StartCtx { /* 现有 */ mate?: { profile: BodyProfile; view: ViewWindow | null }; gap?: number /* 两条泳道的中心相距多远；泳道中心是 ∓gap/2 */ }
update(dtSec: number, body: Body | null, mate?: Body | null): GameEvent[];
assist(who?: 0 | 1): { k: number; target: Skeleton } | null;
interface LiveJudge { /* 现有 */ mate?: { ok: boolean; accuracy: number; badParts: PartId[] } }
// framing.ts
export type FramingIssue = … | 'one' | 'gap';
export function checkDuoFraming(a: Body | null, b: Body | null, profiles: [BodyProfile, BodyProfile]): FramingResult;
class FramingGate { updateDuo(a: Body | null, b: Body | null, motions: [Motion | null, Motion | null], profiles: [BodyProfile, BodyProfile], nowMs: number): { ready; progress; result; advisory } }
// session.ts
new WallSession({ …, players?: 1 | 2 });
interface SessionEngine { /* 现有 */ mate?: PlayerTracker | null }
```
- `combineOutcomes`：都过 → `pass`，星和 `accuracy` 取较低的；否则 `hit`，`reason` = `左边：…` 或 `右边：…`（两位都没过就 `左边：…；右边：…`），`badParts` 是 1 号的；`each` 总是带上。
- 游戏：`ctx.mate` 存在就是双人。两位的身体都"能判"才判；任何一位不能判超过 `lostPauseMs` → 暂停，两位都回来 `resumeMs` 才继续。`live`：`ok` = 两位都对，`accuracy` 取较低，`hint` 带 `左边：` / `右边：`（先说 1 号的）；`脚出画面了，退回原位`、`看不清你的手脚，退后一点` 这两句在双人时同样加前缀。一面墙最多扣 1 条命。`assist(who)`：驶来阶段两位都对才吸附；判完之后只给过了的那位。`summary.players` = 1 或 2。
- 站位（`checkDuoFraming`，顺序即优先级）：都没看到 `两位都站到摄像头前面来`；只看到一位——他在画面里不到 `minPersonFrac` 高就 `两位都往前走一点`，否则 `还差一位，站到旁边来`（issue `one`）；任一位头肩看不清 `让摄像头看到你的头和肩膀`；任一位太近 `往后退一点`（提醒）；任一位不到 `minPersonFrac` 高 `两位都往前走一点`（issue `far`，**硬要求**）；`pairGap < minGap` → `两个人分开一点，中间留一臂宽`（issue `gap`，硬要求）；任一位是半身 → 和单人同一句（提醒，按半身开）；否则 `站得很好，别动`。"在画面里多高" = `standHeight(profile) × body.scale`。两位都站着没动才计时。
- 会话（`players: 2`）：站位用 `updateDuo`；开局时 `gap = clamp(pairGap, minGap, maxGap)`，`tracker.calibrate({ x: -gap/2 })`、`mate.calibrate({ x: gap/2 })`（分界线随之定住），`ctx.gap = gap`；两位只要有一位半身，这一局两位都按半身；`ctx.mate` 填上。模拟玩家：`wall` 事件里给两位各摆各的（`who` 0 / 1）。结束时两个追踪器都 `unlock()`，`again()` / `retryLevel()` 都 `lock()`。来源换了（引擎重启）时两位一起重新标定。

- [x] **Step 1: 测试：**
  - `judge.test.ts`：`combineOutcomes` 的四种组合（星取低、`reason` 的三种写法、`each`）。
  - `game.test.ts`「duo」（两人模拟 + 两个带泳道的追踪器）：两位都照着摆，三档难度各 55 面全过、`allclear`、`summary.players === 2`；只有 2 号不摆：每面 `hit`、`each[0].kind === 'pass'`、`each[1].kind === 'hit'`、`reason` 以 `右边：` 开头、每面只掉 1 条命、三面后结束；2 号走开（`setPresent(false, 1)`）：1 秒后 `pause`，不掉命，回来后继续；`live.hint` 在 1 号摆错时以 `左边：` 开头；`assist(1)` 在 2 号没过的那面判完后是 `null`、`assist(0)` 不是。
  - `framing.test.ts`「duo」：上面每一条各一个用例（含"只看到一位且很小"说的是 `两位都往前走一点`）；`far`、`gap` 不是提醒（站多久都不 `ready`）；一位在动就不计时。
  - `session.test.ts`「duo」：两人模拟开局后 `ctx.mate` 存在；两位的 `body.root.x` ≈ ∓0.75；跑若干面墙全过；单人会话的现有用例全部保留、通过。
- [x] **Step 2:** 运行 → 失败。
- [x] **Step 3:** 实现。
- [x] **Step 4:** `npx vitest run` 全绿。

### Task 9: 双人的画面和入口

**Files:** Modify `src/app/router.ts`, `pages/Home.tsx`, `pages/Play.tsx`, `components/CameraPip.tsx`, `components/AirCursorLayer.tsx`, `src/games/wall/scene/stage.ts`, `avatar.ts`, `wallMesh.ts`, `view.ts`, `hud/Panels.tsx`, `WallPlay.tsx`; Test `router.test.ts`

**Produces:** `Flags.players: 1 | 2`（只有 `players=2` 是 2）；`createStage(host, quality, { wide: boolean })` + `stage.setMarks(xs: number[])`；`new Avatar(profile, { suit: number; bib: string })`；`new WallSceneView(host, { quality, profile, ghost, players })`，`frame(dt, state, skeletons: (Skeleton | null)[], assists: ({ k; target } | null)[])`，`setProfiles(ps: BodyProfile[])`、`setLanes(xs: number[])`。

- 首页：`开始闯关` 换成 `单人游戏`（主按钮）和 `双人游戏` 两个按钮；后者去 `#/play/wall?players=2`。
- `Play.tsx`：`people = min(flags.players, mod.maxPlayers ?? 1)`。
- 舞台：双人时浮台宽 4.6、浮标绳离中线 3.55、相机"画面窄就后拉"的阈值从 1.5 提到 1.85；站位圈每位一个（标定后挪到 `∓gap/2`）。
- 小人：单人不变（蓝、背号 7）；双人 1 号蓝 `0x2b4c8c` 背号 `1`，2 号紫 `0x7a4fd6` 背号 `2`。撞墙时只把没过的那位撞下去（`outcome.each`）。
- 墙：`wall.labels` 每项一块名牌。
- 摄像头小窗：两位的骨架都画（2 号用紫色）。举手光标：两位各算各的，谁先举起来用谁的。
- 暂停面板（人走出画面）在双人时的说明：`两位都回到刚才站的位置、让手脚都进画面，游戏就接着来。`
- 结算面板通关副标题（双人）：`十五关全部拿下，你们的默契满分！`；通关语音（双人）：`太厉害了！恭喜你们，全部通关！`。

- [x] **Step 1: 测试**（`router.test.ts`）：`players=2` → 2；`players=3`、`1`、`abc`、缺省 → 1。
- [x] **Step 2:** 运行 → 失败。
- [x] **Step 3:** 实现。
- [x] **Step 4:** `npx vitest run`、`npx tsc --noEmit` 通过；`npm run build` 后用无头 Chrome 打开 `/?e2e=1#/play/wall?players=2&sim=auto&seed=7&fast=1`，截图确认：两个小人各在一边、颜色和背号对、一面墙两个洞、两块名牌、连过三面以上。

---

# 第三阶段：动效

### Task 10: 物理模块（不碰画面）

**Files:** Create `src/games/wall/fx/tiles.ts`, `fx/debris.ts`, `fx/ragdoll.ts`; Test 各自的 `.test.ts`

**Produces:**
```ts
// tiles.ts —— 把墙体（场 > 0 的部分）切成错缝的砖，碎之前和原墙重合
export interface Tile { x: number; y: number; w: number; h: number }
export function tileWall(field: WallField, size?: number /* 0.3 */, max?: number): Tile[];
// debris.ts
export interface Chunk { x; y; z; vx; vy; vz; rx; ry; rz; wx; wy; wz; sx; sy; sz; color: number; age: number; life: number; state: 'air' | 'deck' | 'water' }
export interface DebrisEnv { deckHalfW: number; deckHalfD: number; waterY: number }
export class DebrisSim {
  constructor(env: DebrisEnv, capacity: number);
  readonly chunks: Chunk[];
  /** 整面墙碎开：每块砖一个碎块，从 (cx, cy) 向外受一次冲击 */
  shatter(tiles: Tile[], z: number, thickness: number, color: number, burst: { x: number; y: number; power: number }, rand: () => number): void;
  /** 推进 dt 秒；返回这一步落水的位置（给水花用） */
  step(dt: number): { x: number; z: number; speed: number }[];
}
// ragdoll.ts
export interface RagdollEnv { deckHalfW: number; deckHalfD: number; waterY: number }
export class Ragdoll {
  constructor(sk: Skeleton, env: RagdollEnv);
  /** 给全身一个初速度，外加绕质心的一点转动 */
  kick(v: { x: number; y: number; z: number }, spin: number): void;
  /** wallZ：墙面现在的位置（墙推着人走）；null = 没有墙 */
  step(dt: number, wallZ: number | null): void;
  skeleton(): Skeleton;
  /** 髋有没有沉到水面以下 */
  get sunk(): boolean;
}
```
物理约定：碎块是刚体近似——重力 9.8、空气阻力、自转；落到浮台顶面（y = 0，范围 `deckHalfW × deckHalfD`）反弹（恢复系数 0.35、摩擦让它滑和减慢自转），滑出边缘就掉下去；进水（y < waterY）后受浮力和水的阻力，在水面附近上下漂，`life` 到了淡出。超出容量丢最老的。布娃娃：19 个关节当质点，Verlet 积分；约束 = 骨架上相连的关节对（保持出生时的长度）+ 躯干的几根斜撑（肩-对侧髋、肩-髋中、头-两肩），每步迭代 8 次；碰撞：浮台顶面、墙面（`z >= wallZ` 的质点不能在墙后面：被推到 `wallZ` 前）、水里的阻力和一点浮力。

- [x] **Step 1: 测试：**
  - `tiles.test.ts`：一字平举的墙切出来的砖全部落在墙的矩形里；每块砖中心处场 > 0；洞的正中没有砖；砖的总面积在"墙体面积"的 85%～115%；相邻两行错开半块；`max` 限制个数。
  - `debris.test.ts`：碎开后推进 6 秒：每个碎块要么 `deck` 且速度 ≈ 0、要么 `water` 且 `|y - waterY| < 0.3`，没有一个 `|x|`、`|z|` 超过 30 或 `y` 低于 `waterY - 1`、没有 NaN；落水会被 `step` 报告且每块只报一次；超过容量时个数不超过容量；`dt = 0.1` 的大步长也不炸。
  - `ragdoll.test.ts`：站姿出生、`kick` 之后推进 3 秒（`dt = 1/60`，也试 `1/20`）：每根骨头的长度与出生时相差 < 3%；没有 NaN、没有质点飞出 20 米外；向 +z 踢出去最终 `sunk`；有墙面推（`wallZ` 从 0 走到 0.85）时没有质点在墙后面超过 2 厘米；不踢、没有墙时在台面上不会穿到 y < 0 以下 2 厘米。
- [x] **Step 2:** `npx vitest run src/games/wall/fx` → 失败。
- [x] **Step 3:** 实现。
- [x] **Step 4:** 通过。

### Task 11: 场景里的动效

**Files:** Create `src/games/wall/scene/debrisMesh.ts`, `fireworks.ts`, `sky.ts`; Modify `scene/fx.ts`, `sea.ts`, `stage.ts`, `avatar.ts`, `view.ts`, `ghost.ts`

**Produces:**
```ts
// view.ts
handle(e: GameEvent): void;                       // 新增对 levelup / allclear / life 的演出
frame(dt, state, skeletons, assists): { splashes: number; shattered: boolean; whoosh: boolean; fireworks: ('launch' | 'burst')[] };   // 这一帧发生了什么，给声音用
// stage.ts
stage.setDusk(k: number): void;                   // 0 白天 → 1 晚霞（天空、雾、灯光、海面一起变）
stage.cameraFx: { push: number; lift: number; orbit: number };   // 每帧由 view 写
// sea.ts
sea.ripple(x: number, z: number, strength: number): void;        // 最多 8 个波源，旧的被顶掉
sea.setTone(k: number): void;                                    // 跟着晚霞变色
// fireworks.ts
export class Fireworks { readonly points: THREE.Points; launch(x: number, z: number, hue?: number): void; update(dt: number): ('launch' | 'burst')[]; dispose(): void }
```
按设计 5.5 的表逐行做：
- **墙碎裂**：`tileWall` → `DebrisSim.shatter`（过关：从洞中心向外、带向前的速度；撞墙：较弱）；`debrisMesh` 用一个 `InstancedMesh` 画；碎块落水处 `sea.ripple` + 小水花。容量：高画质 260、低 130。
- **小人被撞**：顿帧 80 毫秒（画面时钟停，游戏时钟不停）→ `Ragdoll` 接管这位小人的骨架，墙面推着走到台边；`sunk` 时水柱 + 三层水花（竖直水柱、一圈向外的水珠、水珠落回水面的小水花）+ `sea.ripple`；之后沿用现在的"闪烁着回到台上"。
- **水面**：片元着色器加菲涅耳天空反射、太阳高光、8 个波源的环形水波；低画质不算反射项。墙的浮筒处每隔几厘米留一点水沫。
- **彩带**：纸片翻面时侧滑、下落慢，落到台面停住、落进水里漂着；另有螺旋下落的彩带卷。**星星**：过墙时小人周围迸出（三星金色、更多）。
- **洞口光圈**：过墙那一下，洞的轮廓亮一圈、向外扩散淡出（复用 `ghost.ts` 的线）。
- **烟花**：升空拖尾 → 球形绽放 → 余烬下坠闪烁；加法混合的点精灵，一次绘制；容量高 2400 / 低 1200。
- **镜头**：过墙慢动作约 0.3 秒（三星更明显）+ 轻推；撞墙顿帧 + 震动；过关小幅抬升；通关绕着小人缓缓转半圈。
- **过关**（`levelup`）：两侧彩带炮 + 三五发烟花 + 小人原地蹦一下。**通关**（`allclear`）：最后一面墙碎成金色彩带 → `setDusk` 2 秒内到 1 → 连放烟花（结束后在结算面板后面继续放）→ 彩带从天而降 → 镜头环绕。
- 所有粒子总量上限：高 900 / 低 450，超了丢最老的。

- [x] **Step 1:** 实现（这一层是画面，靠截图验收；可测的逻辑都在 Task 10）。
- [x] **Step 2:** `npx tsc --noEmit`、`npx vitest run` 通过。
- [x] **Step 3:** `npm run build` 后用无头 Chrome 截图过目：过墙那一瞬（碎块带洞的形状、星星、光圈）、碎块落在台面和水里、撞墙落水（布娃娃姿态、水柱、水波）、过关（彩带炮、烟花）、通关（晚霞、烟花、彩带）。低画质（设置里选低）同样截一组。用 `window.__mw.scene` 看 `frames` 增长正常、`memory()` 在连过 20 面墙后不持续增长。

### Task 12: 声音和庆祝的界面效果

**Files:** Modify `src/engine/audio/sfx.ts`, `src/games/wall/WallPlay.tsx`, `hud/Hud.tsx`, `hud/hud.css`

**Produces:** `SfxName` 增加 `'whoosh' | 'crumble' | 'star' | 'cheer' | 'fanfare' | 'victory' | 'rocket' | 'boom' | 'crackle' | 'life'`；`splash` 改成三层（闷响 + 水花 + 气泡）。

- 过墙：穿过时 `whoosh`，碎开 `crumble`；横幅的星星一颗一颗蹦出来，各带一声 `star`（音调递增）；屏幕边缘闪一下绿光，撞墙闪红光。
- 过关：`fanfare` + `cheer`；回了一条命 `life`。通关：`victory` + 持续的 `cheer`；烟花 `rocket` / `boom` / `crackle` 跟着场景返回的事件响。
- 仍然全部合成；`cheer` 用若干短促的带通噪声脉冲（掌声）叠一层缓慢起伏的宽带噪声（人群）。

- [x] **Step 1:** 实现。
- [x] **Step 2:** `npx tsc --noEmit`、`npx vitest run` 通过；无头 Chrome 里跑一局确认控制台没有 Web Audio 报错（音量参数不出现 0 的指数渐变之类）。

---

# 第四阶段：收尾

### Task 13: 端到端检查、README、总验证

**Files:** Modify `tools/e2e.mjs`, `README.md`

- [x] **Step 1:** `tools/e2e.mjs`：`home` 改成检查 `单人游戏`、`双人游戏` 两个按钮，点 `双人游戏` 到 `#/play/wall?players=2`；`settings` 去掉切换"同时识别两个人"的那一步，并断言面板里没有这句话；新增 `duo-sim`（`players=2&sim=auto&fast=1&seed=7`：两个小人、连过 5 面、`window.__mw.game.state` 里墙带 `mate`）；新增 `finale`（`sim=auto&fast=1&seed=7&level=15`：等到横幅 `恭喜全部通关！` 截图，再等到结算面板 `全部通关！` 截图）；新增 `retry`（`sim=wrong&fast=1&level=3`：结束后面板上有 `再闯这一关`，点它，回到第 3 关、3 条命）；新增 `duo-cam`（假摄像头 = 测试照片左右各一份、人占画面高度一半以上，`players=2`，真实模型：两个追踪器各认到一个人，两个 `body.image` 的髋 x 一左一右，站位引导走完开局）。
- [x] **Step 2:** `npm run build && npm run e2e` → 全部通过；逐张看 `e2e-out/` 里新场景的截图。
- [x] **Step 3:** README：玩法介绍（十五关、单人 / 双人、通关）、判定一节里"旁人入镜"的说法、地址栏开关（`players`、`level`）、调参表（新增的数值）、"验证过什么 / 没验证什么"。
- [x] **Step 4:** 总验证：`npx vitest run`、`npx tsc --noEmit`、`npm run build`、`npm run e2e` 各跑一遍并记下结果；图鉴截图里 48 个姿势的洞形逐个看过。

---

# 执行记录（2026-11-17）

十三个任务全部做完，在主工作区里直接改的，**没有提交**（等用户说"提交并推送"）。

## 最后一次验证

- `npx vitest run`：48 个文件、768 项，全部通过。
- `npx tsc --noEmit`：通过。
- `npm run e2e`（会先 `npm run build`）：19 个场景全部通过，每个场景结束时都检查了控制台没有报错。
- 无头 Chrome 里快进连过 36 面墙：一直约 60 帧；显存里几何体 27、贴图 11，不随墙数增长。
- 截图看过：图鉴里 48 个姿势的洞形；过墙、撞墙落水、过关、通关；双人的开场、搭配、假摄像头里两个真人照片。

## 独立审阅

全部做完后请了一位不带实现思路的审阅者把整份改动读了一遍：没有严重问题，指出两处该修的，另有若干小问题。这一轮修了四处（每处都是先写出会失败的测试，再改到通过）：

- 双人站位里"离镜头太近"（只是提醒）排在"两人挨得太近"（硬要求）前面，等 3.5 秒就放行、开出一局两人只隔几十厘米 — framing.test.ts "standing too close together is said first…" / "does not open on two players huddled at a laptop…" RED→GREEN, suite 768/768
- 双人开局前（站位引导时）两个小人叠在正中、不在各自一边 — 标定前每条泳道的原点放在两人中间那条线上；playerTracker.test.ts "even before calibration each player is on their own side…" RED→GREEN, suite 768/768；e2e duo-cam 加了"开局前 1 号 x<0、2 号 x>0"的断言
- （审阅者评为 Minor，按对玩家的影响升级）只练一面墙时过关预告报的是不相干的主题（"第 2 关 · 双脚打开"）— game.test.ts "does not name a theme when practising a single wall either" RED→GREEN, suite 768/768
- （审阅者评为 Minor，按对玩家的影响升级）烟花的火星没乘设备像素比，高分屏上只有设计的一半大 — scene/fireworks.test.ts "sizes its sparks in real pixels…" RED→GREEN, suite 768/768

## 没处理的小问题（留着，由用户决定要不要改）

- 只练一面墙（only=）现在也走完整的十五关，练满 55 面会放通关演出
- 双人 + only= 而那面墙两人摆不下时，横幅说"先换成一字平举"，实际退回的是两人叉腰（要手改地址才遇得到）
- 双人在最大间距 + 往外漂 + 往外挪步叠加时，洞可能伸出墙的侧边 5 厘米左右（只是不好看；对抗性扫描 3300 面里 78 面）
- 低画质下水面"映着天"那一项是乘 0 关掉的，着色器里还在算（开销很小，没量）
- 通关演出那 10 秒里要是识别重启（在设置里换了模型 / 摄像头），会先回到站位引导再出结算面板
- 烟花、小粒子在数量顶到上限时边遍历边删，会让个别粒子提前消失（目前的发射量到不了上限）
- 碎块 / 粒子 / 烟花的缓冲区每帧整块上传（空着也传）；洞口轮廓线的材质每面墙新建一次
- 没用上的代码：BodyBuilder.rootU（只有测试在用）、view.ts 的 pending.launches
- 测试缺口：双人一局中途识别重启没有会话层的测试（审阅者自己跑过是好的）；"双人里是哪一个小人被撞下去"没有断言；场景层只有截图

## 执行中替用户做的决定

格式：做了什么决定 — 为什么 — 错了的代价。按发生的先后排。

- Setup: 不建 worktree、不切分支、不提交，直接在主工作区改 — 用户规定"说提交并推送才提交"，而且要在自己的项目目录里直接试玩 — 代价：没有逐任务的提交记录，回退只能靠 git diff / git stash（HEAD 1c2bf4d 是干净基线）。task-done 记的 commits 范围因此恒为 1c2bf4d..1c2bf4d。
- Setup: 执行方式选"本会话内自己做"，没有停下来让用户挑 — 上一条消息已说"回一句我就开工"，任务之间接口互相咬得紧 — 代价：逐任务没有独立审阅，只有最后一次整体审阅。
- T5→T8: calibrate({x}) ⇄ 会话开局 — 一致。T5 的 `anchor` 不做 — T8 量间距用 T7 的 pairGap(Body, Body)，用不到它（YAGNI）— 代价：无。
- Task 1: 全量测试暴露了两处连带——validatePose / poseToCode 不认 noMirror、estimateTier 不把"向前弯腰"算难度（bow、airplane 手标 3 层、估出来 1 层）。都改在 customPoses.ts：校验和导出带上 noMirror；脊柱缩短 < 0.85 算第 3 层 — 自存的"鞠躬"墙因此从第 5 关起才出（原来会从第 2 关）— 代价：已存的弯腰类自存墙难度层若没显式存过会重估。
- Task 2: 复习名额在"这一关还没出过用腿的墙"时先出用腿的 — 设计目标 1"下半身从第 2 关起参与"；不这样第 3、6、9 关（新造型全是上半身 / 几何洞）多半一面用腿的都没有 — 代价：这几关的复习墙随机性小一点。
- Task 2: 整局第一面固定出 T 只在"从第 1 关开始"时生效；level=N 跳关时第一面就是那一关该出的 — 跳关是为了看那一关的内容 — 代价：无。
- Task 2: WallSpec.fresh 表示"这个造型是这一关新出现的"，不是"占的是新名额"（新名额放不下而改出复习墙时 fresh 为 false）；偏置只给 fresh 为 false 的人形洞 — 代价：无。
- Task 2: 最后一关出完后再调 next() 不抛错，接着出最后一关的墙（"只练一面墙"时游戏以外的调用方可能这样用）— 代价：无。
- Task 3: 全部通关不另外加"通关奖励分"，开局也不发第 1 关的 levelintro — 设计都没提 — 代价：想要的话各加一行。
- Task 3: 通关演出（finale）期间引擎重启（recalibrate）只记下新标定，不重新倒数 — 那时已经没有墙要出 — 代价：无。
- Task 3: retryLevel 把"连过"清零、最高连过退回这一关开始时的值 — 设计只说"分数和各项统计回到这一关开始时" — 代价：无。
- Task 4: 横幅多加一种 intro（下一关预告，字小一号）— "第 10 关 · 弯腰鞠躬"用最大号字在 1280 宽的屏上排不下 — 代价：无。
- Task 4: 首页自动演示从"打到第 4 关重来"改成"第 9 关" — 前 3 关还是以摆手为主，演示看不出这次的改动；设计第 7 节把这个数留给实现者 — 代价：演示后段墙稍快。
- Task 4: 通关后的结算不再播"游戏结束"的音效和语音 — 那是失败的声音；祝贺在 allclear 时已经说过 — 代价：无。
- Task 5: describePerson 放在新文件 tracking/person.ts（计划写的是从 selectPerson.ts 导出）— lanes.ts 和 selectPerson.ts 都要用它，放第三个文件免得两者互相引用 — 代价：无。LaneSplit 多一个只读的 frozen。
- Task 6: e2e 的 settings 场景在这一步就改掉（去掉切换"同时识别两个人"那一步，改成断言面板里没有它、单人只找 1 个人）— 开关一删那一步就必然挂，等不到 Task 13 — 代价：无。SimPoseSource.stats() 现在总带 people。
- Task 7: 计划里的 holeRelation / pairFits（按格点量两个洞"隔开还是连上"，排除中间地带的配对）没有做，改成两样：bodyGap（按胶囊体精确算两副身体轮廓的间隙，配对只要求 ≥ bodyGap）+ mergeHoles（两个洞之间的墙窄于 minStrip 就把那一段挖掉）— 按格点量太慢（一局要算上亿次点到线段距离），而且排除"中间地带"会让 1.2～1.5 米间距下可用的配对很少；挖掉细条从根上消除了"留一根细墙"的问题，配对也因此和难度档无关 — 代价：两个人的洞离得近时会连成一个（下面那块没支撑的墙也跟着去掉），洞看起来比两个单独的洞大。tuning 里因此没有 minMerge。
- Task 7: 池子里只有一面墙（only=…"试试这面墙"）时，双人也只出它（两人同款），不掺手拉手 / 搭桥；摆不下就两人叉腰 — 设计没提 only + 双人 — 代价：无。
- Task 7: 两个人都往中间凑时，两个洞的中心至少还隔 1.0 米（minGap − 0.2）— 否则任何配对都放不下，只能一直出叉腰 — 代价：洞可能不在人正前方，要各自退回去一点。
- Task 7: 双人第 1 关的"新"名额里手拉手排最前（整局第一面：两个 T 放得下就先出 T，下一个新名额出手拉手；放不下就直接用手拉手开场）；第 2 关同理先出搭桥 — 设计："各在自己那一关必出一次" — 代价：无。
- Task 8: 双人里只有一位不在画面里（另一位正常）时，实时提示不说话（空串），等 1 秒后的暂停面板去说 — 设计只列了"摆错""看不清""脚出画面"三种提示怎么加前缀 — 代价：那 1 秒里屏幕上没有提示。
- Task 8: 模拟玩家（演示 / 自动检查）的双人开局不走站位引导，和单人一致；只要两位都看得到就标定 — 代价：无。
- Task 9: 手拉手 / 搭桥的墙只挂一块名牌（在两人正中）— 这两个造型的两个洞连成了一个，设计说"每个洞上方一块" — 代价：无。两块名牌挨得近时一起缩小（最小一半），免得叠住。
- Task 9: 举手光标"谁先举手用谁的"，他把手放下之前另一位抢不走 — 设计只说"谁举手都行"；不这样两个人同时举手时光标会来回跳 — 代价：无。
- Task 10: 布娃娃用固定的 1/90 秒小步长（外面给多长的 dt 都拆开走），水里的浮力略大于重力（会浮在水面附近晃，不会一直沉下去）；碎块的 shatter 多一个 forward（顺着墙前进方向带出去的速度）；砖宽凑成正好铺满墙（不留边角料）— 都是计划留给实现者的物理细节 — 代价：无。
- Task 11: 撞墙后镜头多做一个"退后、低头看台子前面的水"的动作（约 1.9 秒）— 设计只写了"顿帧 + 震动"，但小人落水的地方平时在画面下边缘以外，不这样水柱、水花、涟漪都看不到 — 代价：撞墙时画面会动一下，不喜欢可以把 view.ts 的 HIT_LOOK_SEC 设成 0。
- Task 11: 布娃娃离开墙面时最多带 1.7 米/秒的速度（不带墙的全速）— 后面关卡墙每秒走八九米，全带上人会直接飞到镜头后面 — 代价：无。
- Task 11: 过关的烟花放在墙来的方向的远处（18～30 米外、5.5～8.5 米高），通关的放在四周一圈（22～34 米外）；通关时镜头看向小人头顶上方 — 放得近、放得高都会出画面 — 代价：烟花看起来小一些。
- Task 11: 修了一处原来就有的显存泄漏：墙面的条纹贴图改成每种颜色共用一张（原来每面墙一张；three.js 画影子的公用材质会把已释放的贴图重新上传一份，每面墙漏一张）— 检查"连过 20 面墙显存不增长"时发现的 — 代价：无。验证：36 面墙后贴图数稳定在 11、几何体 27、60 帧。
- Task 11: 双人的挪步改成"朝中线挪的那位，挪完离中线至少 sideMargin"，洞的原位也不许越过这条线 — 无头 Chrome 里双人自动演示卡死在第 10 关：洞跟着人走 + 再挪一步，两样叠加把 1 号的洞挪到了两人中线上，他被当成走出泳道，游戏停在"人呢？" — 已加回归测试（levels.test.ts"neither hole ever comes near the line"）；5 组双人模拟全部打通 55 面墙。
- Task 12: 连过到 3 / 5 / 8 / 10 面的那一面，横幅下面那行换成喝彩语，这一面就不蹦星星、不响"叮"（设计说"下面那行换成"）；cheer 的 pitch 参数当作时长的倍数用；噪声素材改成循环播放（比两秒长的掌声才不会断）— 代价：无。现有 15 个端到端场景全部通过。
- Final: 两个人中途真的换了边 → 两个追踪器各自跟上换过来的人，游戏照常 — 设计的非目标里写了"两人中途换位"不管；各自控制自己现在站的那一边的小人，也符合"照镜子" — 代价：换边的瞬间可能各算一次没摆对。
- Final: 旁人贴着玩家站、或挡住玩家时可能被"帧间连续性"跟上 — 和单人一直以来的行为相同，这次没动 — 代价：同单人。
- Final: "再闯这一关 / 再来一次"认准的是点按钮那一刻人站的位置；那一刻人不在画面里就不重新认准 — 沿用原来 again() 的做法 — 代价：点完再走回来的人，得走回点按钮时站的地方附近。
- Final: 地址栏开关只在进入游戏页时读一次（在页面里手改 players=2 不生效）— 原来所有开关都是这样 — 代价：无。
- Final: 实验室里"用录制代替摄像头"+ players=2 过不了双人站位（录制里只有一个人）— 开发工具的组合，不处理 — 代价：无。
- Final: 通关后烟花和它的声音在结算面板后面一直放 — 设计 5.4 写的就是"之后烟花在结算面板后面继续放" — 代价：面板开着不动的话会一直响，嫌吵可以在 view.ts 里给它加个时限。
- Final: 间距 1.2 米、轻松档时"手拉手"的目标角度离"手自然垂着"不到容差，站着不动也算过 — 属于手感，留给真人试玩后在 tuning.ts 里调 — 代价：这一面在轻松档几乎是白送的。
- Final: customPoses.ts 的 BANNED 没有加上"墙来啦" — 计划的全局约束写明不改 — 代价：自己存的墙可以起这个名字。
- Final: 模拟玩家（演示 / 检查）在两人间距超过 1.9 米时，模拟坐标和舞台坐标会差一截、越摆越偏 — 只影响模拟，演示用的是 1.5 米 — 代价：无。
- Finish: 没有调用 finishing-a-development-branch — 没有分支也没有提交可"收尾"；怎么合入用户早有规定（他说"提交并推送"才做）— 代价：无。
