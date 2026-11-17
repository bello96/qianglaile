import type * as THREE from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { JOINTS, NEUTRAL, poseToSkeleton, type Skeleton } from '../../../engine/body/pose';
import type { BodyProfile } from '../../../engine/body/profile';
import { clamp01, damp, lerp } from '../../../engine/util/math';
import type { PartId } from '../bodyShape';
import type { BuiltWall } from '../build';
import { DebrisSim } from '../fx/debris';
import { tileWall } from '../fx/tiles';
import type { GameEvent, WallGameState } from '../game';
import { COMMON } from '../tuning';
import { Avatar, type PartTint } from './avatar';
import { DebrisMesh } from './debrisMesh';
import { Fireworks } from './fireworks';
import { Fx } from './fx';
import { buildGhost, resizeGhost } from './ghost';
import { createSea, type Sea } from './sea';
import { createStage, disposeObject, WATER_Y, type Stage } from './stage';
import { buildWallMesh, WALL_COLORS } from './wallMesh';

/**
 * 场景编排：游戏逻辑（game.ts）的"观众"。
 * 它只做两件事：收到事件时做演出（出墙、碎墙、撞飞、庆祝），每帧把状态画出来。
 * 它不做任何判定——判定全在 game.ts 里，所以画面出问题不会影响输赢，反过来也一样。
 *
 * 慢动作和顿帧也只在这里：它们放慢的是**画面的时钟**（墙、碎块、粒子、小人走得慢了），
 * 游戏的时钟照常走。判定在墙到达的那一刻已经做完了，演出怎么放都改变不了结果。
 *
 * 单人：一个小人。双人：两个小人（1 号蓝色在左，2 号紫色在右），台子和墙都宽一些。
 */

/** 墙现在在干什么：驶来 → 穿过去（过关）/ 把人推下去（撞墙）。 */
type WallAct = 'approach' | 'passing' | 'pushing';

/** 过关后，墙继续往前走到这里再碎掉（米） */
const PASS_BURST_Z = 0.7;
/** 撞墙后，墙推着人走到台子边上停住，过这么久碎掉（秒） */
const PUSH_STOP_Z = 0.85;
const PUSH_BURST_AFTER = 1.0;
/** 墙有多厚（和 wallMesh.ts 里拉伸的厚度差不多） */
const WALL_THICKNESS = 0.24;

// ---- 演出的手感：想让它更夸张 / 更克制，改这里 ----
/** 撞墙的那一下，画面顿住这么久（秒） */
const HIT_STOP_SEC = 0.08;
/** 撞墙之后，镜头低头看着台子前面的水这么久（秒）：小人落水、水花溅起来都在那儿 */
const HIT_LOOK_SEC = 1.9;
/** 过墙的慢动作：画面放慢到几成、持续多久（真实时间，秒）、镜头往前推多少（米）。三星更明显 */
const SLOWMO = { pass: { scale: 0.42, sec: 0.3, push: 0.28 }, perfect: { scale: 0.26, sec: 0.42, push: 0.55 } };
/** 洞口那一圈光：扩到多大、多久散掉 */
const RIM = { grow: 0.32, sec: 0.5 };
/** 过关：镜头抬高多少（米） */
const CLEAR_LIFT = 0.4;
/** 过关时天上放的几发烟花，各在庆祝开始后几秒升空 */
const CLEAR_FIREWORKS = [0.1, 0.45, 0.85, 1.3, 1.75];
/** 通关：天色用几秒变成晚霞；镜头用几秒绕小人转半圈；彩纸撒几秒 */
const FINALE = { duskSec: 2, orbitSec: 9, rainSec: 7 };
/** 最后一面墙碎成的金色 */
const GOLD = 0xffc531;

/** 小人的衣服颜色和背上的号码。单人还是原来的 7 号；双人是 1 号（蓝）和 2 号（紫） */
const SOLO_LOOK = [{ suit: 0x2b4c8c, bib: '7' }];
const DUO_LOOK = [
  { suit: 0x2b4c8c, bib: '1' },
  { suit: 0x7a4fd6, bib: '2' },
];

/** 这一帧画面里发生了什么——给声音用（见 WallPlay）。 */
export interface FrameReport {
  /** 有小人落水 */
  splashed: boolean;
  /** 有几块碎块落水 */
  plops: number;
  /** 墙碎了 */
  shattered: boolean;
  /** 墙正从小人身上穿过去 */
  whoosh: boolean;
  /** 烟花：升空了几发、炸开了几发 */
  launches: number;
  bursts: number;
}

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

export class WallSceneView {
  private readonly stage: Stage;
  private readonly sea: Sea;
  private readonly avatars: Avatar[];
  private readonly fx: Fx;
  private readonly debris: DebrisSim;
  private readonly debrisMesh: DebrisMesh;
  private readonly fireworks: Fireworks;
  /** 低画质：砖大一点（碎块少一半） */
  private readonly brick: number;
  /** 是否显示落位轮廓（挑战难度不显示）。下一面墙起生效 */
  showGhost: boolean;

  private wall: BuiltWall | null = null;
  private wallMesh: THREE.Group | null = null;
  private wallColor = WALL_COLORS[0];
  private act: WallAct = 'approach';
  private actT = 0;
  private speed = 4;
  private ghost: THREE.Group | null = null;
  /** 浮筒划水留下的水沫：离上一次留已经走了多远 */
  private wake = 0;

  /** 每个小人最近一次的骨架（这一帧没有新的就沿用） */
  private lastSkeletons: Skeleton[];
  private profiles: BodyProfile[];
  /** 每个小人被撞时该变红的部位 */
  private hitParts: PartId[][];
  private lastState: WallGameState | null = null;
  private width = 1280;
  private height = 720;

  // ---- 演出的状态 ----
  /** 画面时钟的倍速（1 正常，慢动作时小于 1）和慢动作还剩多久 */
  private timeScale = 1;
  private slowLeft = 0;
  private slowScale = 1;
  /** 顿帧还剩多久 */
  private freeze = 0;
  /** 镜头低头看水还剩多久 */
  private lookDown = 0;
  /** 这面墙是整局的最后一面：碎成金色 */
  private golden = false;
  /** 洞口的光圈 */
  private rim: { group: THREE.Group; t: number; cx: number } | null = null;
  /** 排好时间的烟花：还有几秒升空 */
  private queue: number[] = [];
  /** 小人落水后的第二圈涟漪：还有几秒、在哪 */
  private echoes: { t: number; x: number; z: number }[] = [];
  /** 通关演出进行了多久；null = 没在演 */
  private finale: number | null = null;
  private dusk = 0;
  private nextRocket = 0;
  private rainOwed = 0;
  private pending = { shattered: false, whoosh: false, launches: 0 };

  /** host：场景画在哪个元素里（场景会在里面放一块自己的画布，销毁时拿走）。players：几个小人。 */
  constructor(host: HTMLElement, opts: { quality: 'low' | 'high'; profile: BodyProfile; ghost: boolean; players?: 1 | 2 }) {
    const looks = opts.players === 2 ? DUO_LOOK : SOLO_LOOK;
    const high = opts.quality === 'high';
    this.stage = createStage(host, opts.quality, { wide: opts.players === 2 });
    const deck = this.stage.deck;
    this.sea = createSea(opts.quality);
    this.avatars = looks.map((look) => new Avatar(opts.profile, { ...look, deck }));
    // 所有粒子都有总量上限；低画质数量减半
    this.fx = new Fx({ capacity: high ? 900 : 450, density: high ? 1 : 0.5, deckHalfW: deck.halfW, deckHalfD: deck.halfD });
    this.debris = new DebrisSim({ deckHalfW: deck.halfW, deckHalfD: deck.halfD, waterY: WATER_Y }, high ? 260 : 130);
    this.debrisMesh = new DebrisMesh(high ? 260 : 130, high);
    this.fireworks = new Fireworks(high ? 2400 : 1200, high ? 1 : 0.5);
    this.brick = high ? 0.3 : 0.42;
    this.showGhost = opts.ghost;
    this.profiles = looks.map(() => opts.profile);
    this.hitParts = looks.map(() => []);
    this.lastSkeletons = [];
    this.stage.scene.add(this.sea.mesh, ...this.avatars.map((a) => a.group), this.debrisMesh.mesh, this.fx.group, this.fireworks.points);
    // 还没标定时先摆个大概：单人站正中，双人隔开 1.5 米
    this.setLanes(looks.length === 2 ? [-0.75, 0.75] : [0]);
  }

  /** 每位玩家的身材（开局标定之后调用）。 */
  setProfiles(ps: BodyProfile[]): void {
    this.avatars.forEach((avatar, i) => {
      this.profiles[i] = ps[i] ?? ps[0];
      avatar.setProfile(this.profiles[i]);
    });
  }

  /**
   * 每位玩家站在舞台的哪儿（开局标定之后调用）：台面上的站位圈挪过去；
   * 在第一帧识别结果到来之前，小人也先站在那儿。新的一局从这里开始，所以上一局的通关演出也在这里收掉。
   */
  setLanes(xs: number[]): void {
    this.stage.setMarks(xs.slice(0, this.avatars.length));
    this.lastSkeletons = this.avatars.map((_, i) => poseToSkeleton(NEUTRAL, this.profiles[i], { x: xs[i] ?? 0 }));
    this.endShow();
  }

  /** 通关演出收场：天色回到白天，镜头回到原位，不再放烟花。 */
  private endShow(): void {
    this.finale = null;
    this.queue = [];
    this.golden = false;
  }

  /** 游戏发来的事件：出墙、判定结果、升关、通关。 */
  handle(e: GameEvent): void {
    if (e.type === 'countdown') {
      if (this.finale !== null) this.endShow();
    } else if (e.type === 'wall') {
      this.removeWall();
      this.wall = e.wall;
      this.wallColor = WALL_COLORS[(e.wall.spec.index - 1) % WALL_COLORS.length];
      this.wallMesh = buildWallMesh(e.wall, this.wallColor);
      this.wallMesh.position.z = COMMON.spawnZ;
      this.stage.scene.add(this.wallMesh);
      this.act = 'approach';
      this.speed = Math.max(3, -COMMON.spawnZ / e.wall.spec.approachSec);
      this.hitParts = this.avatars.map(() => []);
      this.golden = false;
      if (this.showGhost) {
        this.ghost = buildGhost(e.wall.ghost);
        resizeGhost(this.ghost, this.width, this.height);
        this.stage.scene.add(this.ghost);
      }
    } else if (e.type === 'outcome') {
      this.removeGhost();
      this.actT = 0;
      if (e.outcome.kind === 'pass') this.onPass(e.wall, e.outcome.stars === 3);
      else this.onHit(e.outcome.each ?? [e.outcome]);
    } else if (e.type === 'skip') {
      // 这面墙不算数：就地碎掉，给下一面让路
      this.shatter(2, 0);
    } else if (e.type === 'levelup') {
      this.onLevelClear();
    } else if (e.type === 'allclear') {
      this.finale = 0;
      this.nextRocket = 0.2;
      this.rainOwed = 0;
    }
  }

  /** 过了：慢动作里墙从小人身上穿过去，洞口亮一圈，星星迸出来。三星是金色的，更隆重。 */
  private onPass(wall: BuiltWall, perfect: boolean): void {
    this.act = 'passing';
    const feel = perfect ? SLOWMO.perfect : SLOWMO.pass;
    this.slowLeft = feel.sec;
    this.slowScale = feel.scale;
    this.stage.cameraFx.push = feel.push;
    this.pending.whoosh = true;
    // 这是不是整局最后一面墙（第 15 关的最后一面）：是的话碎成金色
    const s = this.lastState;
    this.golden = wall.spec.level >= COMMON.levels && !!s && s.wallInLevel >= s.wallsInLevel;

    const centres = holeCentres(wall);
    for (const x of centres) this.fx.stars(x, 1.2, 0.2, perfect ? 26 : 13, perfect);

    this.removeRim();
    const group = buildGhost(wall.ghost);
    resizeGhost(group, this.width, this.height);
    const [, over] = group.userData.materials as LineMaterial[];
    over.color.setHex(perfect ? GOLD : 0x8dffcf);
    this.stage.scene.add(group);
    this.rim = { group, t: 0, cx: centres.reduce((a, b) => a + b, 0) / centres.length };
  }

  /** 撞了：画面顿一下，没过的那位变成布娃娃被墙推下去。results：每位玩家各自的结果（单人只有一个）。 */
  private onHit(results: readonly { kind: 'hit' | 'pass'; badParts?: PartId[] }[]): void {
    this.act = 'pushing';
    this.freeze = HIT_STOP_SEC;
    this.lookDown = HIT_LOOK_SEC;
    this.avatars.forEach((avatar, i) => {
      const mine = results[i];
      if (!mine || mine.kind !== 'hit') return;
      this.hitParts[i] = mine.badParts ?? [];
      avatar.knock();
    });
    this.stage.shake(1);
  }

  /** 过了一关：两侧彩带炮，天上几发烟花，小人蹦一下，镜头抬一抬。 */
  private onLevelClear(): void {
    const edge = this.stage.deck.halfW + 0.2;
    this.fx.cannon(-1, -edge, 0.5);
    this.fx.cannon(1, edge, 0.5);
    this.queue.push(...CLEAR_FIREWORKS);
    for (const avatar of this.avatars) avatar.hop();
    this.stage.cameraFx.lift = CLEAR_LIFT;
  }

  /** 墙碎成一块块砖。power：往外崩的力道；forward：顺着墙前进方向带出去的速度。 */
  private shatter(power: number, forward: number): void {
    const wall = this.wall;
    const mesh = this.wallMesh;
    if (!wall || !mesh) return;
    const centres = holeCentres(wall);
    const colour = this.golden ? GOLD : this.wallColor;
    this.debris.shatter(
      tileWall(wall.field, this.brick),
      mesh.position.z,
      WALL_THICKNESS,
      colour,
      { x: centres.reduce((a, b) => a + b, 0) / centres.length, y: 1.2, power, forward },
      Math.random,
    );
    this.pending.shattered = true;
    this.removeWall();
  }

  /**
   * 每帧调用。skeletons：每位玩家当前的骨架（没有就沿用上一帧的）；
   * assists：每位玩家的过关吸附（见 game.ts 的 assist()）。返回这一帧画面里发生了什么（给声音用）。
   */
  frame(dt: number, state: WallGameState, skeletons: (Skeleton | null)[], assists: ({ k: number; target: Skeleton } | null)[]): FrameReport {
    this.lastState = state;

    // ---- 画面的时钟：顿帧时停住，慢动作时放慢 ----
    if (this.slowLeft > 0) this.slowLeft -= dt;
    this.timeScale = damp(this.timeScale, this.slowLeft > 0 ? this.slowScale : 1, this.slowLeft > 0 ? 40 : 9, dt);
    let vdt = dt * this.timeScale;
    if (this.freeze > 0) {
      this.freeze -= dt;
      vdt = 0;
    }

    // ---- 墙 ----
    const mesh = this.wallMesh;
    if (mesh && this.wall) {
      this.actT += vdt;
      const before = mesh.position.z;
      if (this.act === 'approach') {
        mesh.position.z = lerp(COMMON.spawnZ, 0, state.progress);
      } else if (this.act === 'passing') {
        // 过关：墙从小人身上穿过去，走远一点再碎
        mesh.position.z += this.speed * vdt;
        if (mesh.position.z >= PASS_BURST_Z) {
          for (const x of holeCentres(this.wall)) this.fx.confetti(x, 1.5, 0.4, this.golden ? 170 : 45, this.golden);
          this.shatter(this.golden ? 5.5 : 4.2, this.speed * 0.3);
        }
      } else {
        // 撞墙：墙继续往前，把人推下台子，到台子边停住，然后碎掉让出视线
        mesh.position.z = Math.min(PUSH_STOP_Z, mesh.position.z + this.speed * vdt);
        if (this.actT >= PUSH_BURST_AFTER) this.shatter(2, 0.6);
      }
      // 浮筒划水：每走一小段留一点水沫
      if (this.wallMesh && this.wall) {
        this.wake += Math.abs(this.wallMesh.position.z - before);
        if (this.wake > 0.55) {
          this.wake = 0;
          const b = this.wall.field.bounds;
          for (const x of [b.x0 - 0.32, b.x1 + 0.32]) this.fx.foam(x, this.wallMesh.position.z - 0.55, 1, 0.12);
        }
      }
    }
    if (this.ghost) this.ghost.visible = state.phase === 'approach' || state.phase === 'paused';
    /** 墙面现在在哪：撞墙之后推着布娃娃走 */
    const pushing = this.act === 'pushing' && this.wallMesh ? this.wallMesh.position.z : null;

    // ---- 小人 ----
    let splashed = false;
    this.avatars.forEach((avatar, i) => {
      const sk = skeletons[i];
      if (sk) this.lastSkeletons[i] = sk;
      const assist = assists[i];
      avatar.pose(assist ? blendToward(this.lastSkeletons[i], assist.target, assist.k) : this.lastSkeletons[i]);

      // 墙驶来时：哪里没摆对哪里红（2 号的在 live.mate 里）；被撞之后：撞到的地方红
      const live = i === 0 ? state.live?.badParts : state.live?.mate?.badParts;
      const bad = live ?? (avatar.busy ? this.hitParts[i] : []);
      const tint: Partial<Record<PartId, PartTint>> = {};
      for (const part of bad) tint[part] = 'bad';
      avatar.tint(tint);

      const { splash } = avatar.update(vdt, pushing);
      if (splash) {
        // 小人落水：水柱、一圈水珠、水沫，水面起一圈大的涟漪，稍后再跟一圈小的
        this.fx.splash(splash.x, splash.z, 1);
        this.sea.ripple(splash.x, splash.z, 1);
        this.echoes.push({ t: 0.22, x: splash.x, z: splash.z });
        this.stage.shake(0.45);
        splashed = true;
      }
    });

    // ---- 碎块 ----
    const fell = this.debris.step(vdt);
    // 一帧里落水的可能有几十块：水花只给前几块，涟漪只给最大的一块（一共只有 8 个波源）
    fell.slice(0, 4).forEach((s) => this.fx.splash(s.x, s.z, 0.3));
    if (fell.length) {
      const biggest = fell.reduce((a, b) => (b.speed > a.speed ? b : a));
      this.sea.ripple(biggest.x, biggest.z, 0.4);
    }
    this.debrisMesh.sync(this.debris.chunks);

    for (let i = this.echoes.length - 1; i >= 0; i--) {
      const echo = this.echoes[i];
      if ((echo.t -= vdt) > 0) continue;
      this.sea.ripple(echo.x, echo.z, 0.55);
      this.echoes.splice(i, 1);
    }

    // ---- 庆祝 ----
    const launches = this.celebrate(dt);
    this.animateRim(dt);

    // ---- 镜头：推和抬都是"给一下，然后慢慢回去" ----
    const cam = this.stage.cameraFx;
    cam.push = damp(cam.push, 0, 3.2, dt);
    cam.lift = damp(cam.lift, 0, 1.5, dt);
    if (this.lookDown > 0) this.lookDown -= dt;
    cam.tilt = damp(cam.tilt, this.lookDown > 0 ? 1 : 0, this.lookDown > 0 ? 7 : 3.5, dt);
    const turn = this.finale === null ? 0 : Math.PI * smooth(this.finale / FINALE.orbitSec);
    cam.orbit = damp(cam.orbit, turn, this.finale === null ? 5 : 30, dt);

    // ---- 环境 ----
    this.dusk = damp(this.dusk, this.finale === null ? 0 : 1, this.finale === null ? 3 : 3 / FINALE.duskSec, dt);
    this.stage.setDusk(this.dusk);
    this.sea.setTone(this.dusk);
    this.sea.update(dt);
    this.fx.update(vdt);
    const bursts = this.fireworks.update(dt);
    this.stage.update(dt);
    this.stage.render();

    const report: FrameReport = { splashed, plops: fell.length, shattered: this.pending.shattered, whoosh: this.pending.whoosh, launches: launches + this.pending.launches, bursts };
    this.pending = { shattered: false, whoosh: false, launches: 0 };
    return report;
  }

  /** 排好时间的烟花，和通关演出（连放烟花、撒彩纸）。返回这一帧升空了几发。 */
  private celebrate(dt: number): number {
    let launched = 0;
    // 过关的那几发：放在墙来的方向的天上
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if ((this.queue[i] -= dt) > 0) continue;
      this.queue.splice(i, 1);
      this.fireworks.launch(rand(-11, 11), rand(-30, -18), rand(5.5, 8.5));
      launched++;
    }
    if (this.finale === null) return launched;

    this.finale += dt;
    // 通关：四面八方连着放（镜头在转，哪个方向都得有）
    this.nextRocket -= dt;
    if (this.nextRocket <= 0) {
      this.nextRocket = rand(0.35, 0.8);
      for (let i = 0; i < (Math.random() < 0.35 ? 2 : 1); i++) {
        const a = rand(0, Math.PI * 2);
        const r = rand(22, 34);
        this.fireworks.launch(Math.sin(a) * r, Math.cos(a) * r, rand(6, 10));
        launched++;
      }
    }
    // 彩纸从天而降：开头密，后面稀
    if (this.finale < FINALE.rainSec) {
      this.rainOwed += dt * (this.finale < 3 ? 60 : 22);
      const n = Math.floor(this.rainOwed);
      if (n > 0) {
        this.rainOwed -= n;
        this.fx.rain(n, this.stage.deck.halfW + 1.2);
      }
    }
    return launched;
  }

  /** 洞口的光圈：以洞的中心为圆心往外扩，同时淡掉。 */
  private animateRim(dt: number): void {
    const rim = this.rim;
    if (!rim) return;
    rim.t += dt;
    const k = clamp01(rim.t / RIM.sec);
    if (k >= 1) return this.removeRim();
    const s = 1 + RIM.grow * (1 - (1 - k) * (1 - k));
    const cy = 1.05;
    rim.group.scale.setScalar(s);
    // 绕着 (cx, cy) 放大，而不是绕着原点
    rim.group.position.set(rim.cx * (1 - s), cy * (1 - s), 0.05);
    for (const m of rim.group.userData.materials as LineMaterial[]) m.opacity = (1 - k) * (m.linewidth > 8 ? 0.6 : 1);
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.stage.resize(w, h);
    this.fireworks.resize(h, this.stage.renderer.getPixelRatio());
    if (this.ghost) resizeGhost(this.ghost, w, h);
    if (this.rim) resizeGhost(this.rim.group, w, h);
  }

  /** 画了多少帧了，以及 3D 上下文还在不在（检查用）。 */
  get frames(): number {
    return this.stage.renderer.info.render.frame;
  }

  get alive(): boolean {
    return !this.stage.renderer.getContext().isContextLost();
  }

  /** 场景里有几个小人（检查用）。 */
  get players(): number {
    return this.avatars.length;
  }

  /** 现在各有多少：碎块、小粒子、烟花的火星；天色（0 白天～1 晚霞）（检查用）。 */
  get show(): { debris: number; particles: number; sparks: number; dusk: number } {
    return { debris: this.debris.chunks.length, particles: this.fx.alive, sparks: this.fireworks.alive, dusk: this.dusk };
  }

  /** 显存里现在有多少几何体和贴图（用来检查造墙、拆墙有没有泄漏）。 */
  memory(): { geometries: number; textures: number } {
    const m = this.stage.renderer.info.memory;
    return { geometries: m.geometries, textures: m.textures };
  }

  dispose(): void {
    this.removeWall();
    this.removeRim();
    for (const avatar of this.avatars) avatar.dispose();
    this.fx.dispose();
    this.debrisMesh.dispose();
    this.fireworks.dispose();
    this.stage.dispose();
  }

  private removeGhost(): void {
    if (!this.ghost) return;
    this.stage.scene.remove(this.ghost);
    disposeObject(this.ghost);
    this.ghost = null;
  }

  private removeRim(): void {
    if (!this.rim) return;
    this.stage.scene.remove(this.rim.group);
    disposeObject(this.rim.group);
    this.rim = null;
  }

  private removeWall(): void {
    this.removeGhost();
    if (this.wallMesh) {
      this.stage.scene.remove(this.wallMesh);
      disposeObject(this.wallMesh);
    }
    this.wallMesh = null;
    this.wall = null;
  }
}

/** 这面墙上每个洞的中心在哪（单人一个，双人两个）。 */
function holeCentres(wall: BuiltWall): number[] {
  return wall.spec.mate ? [wall.spec.holeX, wall.spec.mate.holeX] : [wall.spec.holeX];
}

/** 0→1 的平滑过渡（两头慢、中间快）。 */
const smooth = (k: number): number => {
  const t = clamp01(k);
  return t * t * (3 - 2 * t);
};

/** 把显示用的骨架往目标姿势拉 k（0～1）。只动正面的 x、y；深度保持真实动作的，免得小人被压扁。 */
function blendToward(live: Skeleton, target: Skeleton, k: number): Skeleton {
  const out = {} as Skeleton;
  for (const j of JOINTS) out[j] = { x: lerp(live[j].x, target[j].x, k), y: lerp(live[j].y, target[j].y, k), z: live[j].z };
  return out;
}
