import type * as THREE from 'three';
import { JOINTS, NEUTRAL, poseToSkeleton, type Skeleton } from '../../../engine/body/pose';
import type { BodyProfile } from '../../../engine/body/profile';
import { lerp } from '../../../engine/util/math';
import type { PartId } from '../bodyShape';
import type { BuiltWall } from '../build';
import type { GameEvent, WallGameState } from '../game';
import { COMMON } from '../tuning';
import { Avatar, type PartTint } from './avatar';
import { Fx } from './fx';
import { buildGhost, resizeGhost } from './ghost';
import { createSea, type Sea } from './sea';
import { createStage, disposeObject, type Stage } from './stage';
import { buildWallMesh, WALL_COLORS } from './wallMesh';

/**
 * 场景编排：游戏逻辑（game.ts）的"观众"。
 * 它只做两件事：收到事件时做演出（出墙、碎墙、撞飞），每帧把状态画出来。
 * 它不做任何判定——判定全在 game.ts 里，所以画面出问题不会影响输赢，反过来也一样。
 */

/** 墙现在在干什么：驶来 → 穿过去（过关）/ 把人推下去（撞墙）。 */
type WallAct = 'approach' | 'passing' | 'pushing';

/** 过关后，墙继续往前走到这里再碎掉（米） */
const PASS_BURST_Z = 0.7;
/** 撞墙后，墙推着人走到台子边上停住，过这么久碎掉（秒） */
const PUSH_STOP_Z = 0.85;
const PUSH_BURST_AFTER = 1.0;

export class WallSceneView {
  private readonly stage: Stage;
  private readonly sea: Sea;
  private readonly avatar: Avatar;
  private readonly fx = new Fx();
  /** 是否显示落位轮廓（挑战难度不显示）。下一面墙起生效 */
  showGhost: boolean;

  private wall: BuiltWall | null = null;
  private wallMesh: THREE.Group | null = null;
  private wallColor = WALL_COLORS[0];
  private act: WallAct = 'approach';
  private actT = 0;
  private speed = 4;
  private ghost: THREE.Group | null = null;

  private lastSkeleton: Skeleton;
  private hitParts: PartId[] = [];
  private width = 1280;
  private height = 720;

  /** host：场景画在哪个元素里（场景会在里面放一块自己的画布，销毁时拿走）。 */
  constructor(host: HTMLElement, opts: { quality: 'low' | 'high'; profile: BodyProfile; ghost: boolean }) {
    this.stage = createStage(host, opts.quality);
    this.sea = createSea(opts.quality);
    this.avatar = new Avatar(opts.profile);
    this.showGhost = opts.ghost;
    this.lastSkeleton = poseToSkeleton(NEUTRAL, opts.profile);
    this.stage.scene.add(this.sea.mesh, this.avatar.group, this.fx.group);
  }

  setProfile(p: BodyProfile): void {
    this.avatar.setProfile(p);
  }

  /** 游戏发来的事件：出墙、判定结果、升关。 */
  handle(e: GameEvent): void {
    if (e.type === 'wall') {
      this.removeWall();
      this.removeGhost();
      this.wall = e.wall;
      this.wallColor = WALL_COLORS[(e.wall.spec.index - 1) % WALL_COLORS.length];
      this.wallMesh = buildWallMesh(e.wall, this.wallColor);
      this.wallMesh.position.z = COMMON.spawnZ;
      this.stage.scene.add(this.wallMesh);
      this.act = 'approach';
      this.speed = Math.max(3, -COMMON.spawnZ / e.wall.spec.approachSec);
      this.hitParts = [];
      if (this.showGhost) {
        this.ghost = buildGhost(e.wall.ghost);
        resizeGhost(this.ghost, this.width, this.height);
        this.stage.scene.add(this.ghost);
      }
    } else if (e.type === 'outcome') {
      this.removeGhost();
      this.actT = 0;
      if (e.outcome.kind === 'pass') {
        this.act = 'passing';
      } else {
        this.act = 'pushing';
        this.hitParts = e.outcome.badParts;
        this.avatar.knock();
        this.stage.shake(1);
      }
    } else if (e.type === 'skip') {
      // 这面墙不算数：就地碎掉，给下一面让路
      this.removeGhost();
      if (this.wall && this.wallMesh) this.fx.shatter(this.wall, this.wallMesh.position.z, this.wallColor, 55);
      this.removeWall();
    } else if (e.type === 'levelup') {
      this.fx.confetti(-1.3, 0.3, 0.2);
      this.fx.confetti(1.3, 0.3, 0.2);
    }
  }

  /**
   * 每帧调用。skeleton 是玩家当前的骨架（没有就沿用上一帧的）；
   * assist 是过关吸附（见 game.ts 的 assist()）。返回这一帧小人有没有落水。
   */
  frame(dt: number, state: WallGameState, skeleton: Skeleton | null, assist: { k: number; target: Skeleton } | null): { splashed: boolean } {
    // ---- 小人 ----
    if (skeleton) this.lastSkeleton = skeleton;
    this.avatar.pose(assist ? blendToward(this.lastSkeleton, assist.target, assist.k) : this.lastSkeleton);

    const bad = state.live?.badParts ?? (this.avatar.busy ? this.hitParts : []);
    const tint: Partial<Record<PartId, PartTint>> = {};
    for (const part of bad) tint[part] = 'bad';
    this.avatar.tint(tint);

    // ---- 墙 ----
    const mesh = this.wallMesh;
    if (mesh && this.wall) {
      this.actT += dt;
      if (this.act === 'approach') {
        mesh.position.z = lerp(COMMON.spawnZ, 0, state.progress);
      } else if (this.act === 'passing') {
        // 过关：墙从小人身上穿过去，走远一点再碎成彩块
        mesh.position.z += this.speed * dt;
        if (mesh.position.z >= PASS_BURST_Z) {
          this.fx.shatter(this.wall, mesh.position.z, this.wallColor);
          this.fx.confetti(this.wall.spec.holeX, 1.5, 0.4);
          this.removeWall();
        }
      } else {
        // 撞墙：墙继续往前，把人推下台子，到台子边停住，然后碎掉让出视线
        mesh.position.z = Math.min(PUSH_STOP_Z, mesh.position.z + this.speed * dt);
        if (this.actT >= PUSH_BURST_AFTER) {
          this.fx.shatter(this.wall, mesh.position.z, this.wallColor, 55);
          this.removeWall();
        }
      }
    }
    if (this.ghost) this.ghost.visible = state.phase === 'approach' || state.phase === 'paused';

    // ---- 环境与特效 ----
    const { splash } = this.avatar.update(dt);
    if (splash) {
      this.sea.splash(splash.x, splash.z);
      this.fx.droplets(splash.x, splash.z);
      this.stage.shake(0.45);
    }
    this.sea.update(dt);
    this.fx.update(dt);
    this.stage.update(dt);
    this.stage.render();
    return { splashed: splash !== null };
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.stage.resize(w, h);
    if (this.ghost) resizeGhost(this.ghost, w, h);
  }

  /** 画了多少帧了，以及 3D 上下文还在不在（检查用）。 */
  get frames(): number {
    return this.stage.renderer.info.render.frame;
  }

  get alive(): boolean {
    return !this.stage.renderer.getContext().isContextLost();
  }

  /** 显存里现在有多少几何体和贴图（用来检查造墙、拆墙有没有泄漏）。 */
  memory(): { geometries: number; textures: number } {
    const m = this.stage.renderer.info.memory;
    return { geometries: m.geometries, textures: m.textures };
  }

  dispose(): void {
    this.removeWall();
    this.avatar.dispose();
    this.fx.dispose();
    this.stage.dispose();
  }

  private removeGhost(): void {
    if (!this.ghost) return;
    this.stage.scene.remove(this.ghost);
    disposeObject(this.ghost);
    this.ghost = null;
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

/** 把显示用的骨架往目标姿势拉 k（0～1）。只动正面的 x、y；深度保持真实动作的，免得小人被压扁。 */
function blendToward(live: Skeleton, target: Skeleton, k: number): Skeleton {
  const out = {} as Skeleton;
  for (const j of JOINTS) out[j] = { x: lerp(live[j].x, target[j].x, k), y: lerp(live[j].y, target[j].y, k), z: live[j].z };
  return out;
}
