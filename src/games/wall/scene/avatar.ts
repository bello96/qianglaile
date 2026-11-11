import * as THREE from 'three';
import { NEUTRAL, poseToSkeleton, type JointName, type Skeleton } from '../../../engine/body/pose';
import type { BodyProfile } from '../../../engine/body/profile';
import type { PartId } from '../bodyShape';
import { capsuleTransform } from './avatarMath';
import { COLORS, WATER_Y } from './stage';

/**
 * 3D 小人：没有骨骼绑定，没有模型文件。
 * 每段肢体是一根圆柱，每个关节是一个球；每一帧按骨架的关节位置把它们摆好。
 * 这些圆柱和球的粗细，和判定用的身体轮廓（bodyShape.ts）是同一组半径。
 *
 * 我们总是从背后看他，所以给他背上缝了一块号码布。
 */
export type PartTint = 'idle' | 'ok' | 'bad';

const SUIT = 0x2b4c8c;
const SKIN = 0xfff3e2;
const BAD = COLORS.coral;

type Bone = { part: PartId; a: JointName; b: JointName; radius: (p: BodyProfile) => number; color: number };
type Ball = { part: PartId; at: JointName; radius: (p: BodyProfile) => number; color: number };

const BONES: Bone[] = [
  { part: 'torso', a: 'hipC', b: 'neck', radius: (p) => p.r.torso, color: SUIT },
  { part: 'torso', a: 'shoulderL', b: 'shoulderR', radius: (p) => p.r.shoulder, color: SUIT },
  { part: 'torso', a: 'hipL', b: 'hipR', radius: (p) => p.r.pelvis, color: SUIT },
  { part: 'head', a: 'neck', b: 'head', radius: () => 0.04, color: SKIN },
  { part: 'upperArmL', a: 'shoulderL', b: 'elbowL', radius: (p) => p.r.arm, color: SUIT },
  { part: 'forearmL', a: 'elbowL', b: 'wristL', radius: (p) => p.r.forearm, color: SUIT },
  { part: 'upperArmR', a: 'shoulderR', b: 'elbowR', radius: (p) => p.r.arm, color: SUIT },
  { part: 'forearmR', a: 'elbowR', b: 'wristR', radius: (p) => p.r.forearm, color: SUIT },
  { part: 'thighL', a: 'hipL', b: 'kneeL', radius: (p) => p.r.thigh, color: SUIT },
  { part: 'shinL', a: 'kneeL', b: 'ankleL', radius: (p) => p.r.shin, color: SUIT },
  { part: 'footL', a: 'ankleL', b: 'toeL', radius: (p) => p.r.foot, color: SKIN },
  { part: 'thighR', a: 'hipR', b: 'kneeR', radius: (p) => p.r.thigh, color: SUIT },
  { part: 'shinR', a: 'kneeR', b: 'ankleR', radius: (p) => p.r.shin, color: SUIT },
  { part: 'footR', a: 'ankleR', b: 'toeR', radius: (p) => p.r.foot, color: SKIN },
];

const BALLS: Ball[] = [
  { part: 'head', at: 'head', radius: (p) => p.headR, color: SKIN },
  { part: 'torso', at: 'neck', radius: (p) => p.r.torso, color: SUIT },
  { part: 'torso', at: 'hipC', radius: (p) => p.r.torso, color: SUIT },
  { part: 'upperArmL', at: 'shoulderL', radius: (p) => p.r.shoulder, color: SUIT },
  { part: 'upperArmR', at: 'shoulderR', radius: (p) => p.r.shoulder, color: SUIT },
  { part: 'forearmL', at: 'elbowL', radius: (p) => p.r.arm, color: SUIT },
  { part: 'forearmR', at: 'elbowR', radius: (p) => p.r.arm, color: SUIT },
  { part: 'handL', at: 'handL', radius: (p) => p.r.hand, color: SKIN },
  { part: 'handR', at: 'handR', radius: (p) => p.r.hand, color: SKIN },
  { part: 'thighL', at: 'hipL', radius: (p) => p.r.pelvis, color: SUIT },
  { part: 'thighR', at: 'hipR', radius: (p) => p.r.pelvis, color: SUIT },
  { part: 'shinL', at: 'kneeL', radius: (p) => p.r.thigh * 0.92, color: SUIT },
  { part: 'shinR', at: 'kneeR', radius: (p) => p.r.thigh * 0.92, color: SUIT },
  { part: 'footL', at: 'ankleL', radius: (p) => p.r.shin, color: SKIN },
  { part: 'footR', at: 'ankleR', radius: (p) => p.r.shin, color: SKIN },
  { part: 'footL', at: 'toeL', radius: (p) => p.r.foot, color: SKIN },
  { part: 'footR', at: 'toeR', radius: (p) => p.r.foot, color: SKIN },
];

function bibTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f7fdff';
  g.fillRect(0, 0, 128, 128);
  g.lineWidth = 8;
  g.strokeStyle = '#14213d';
  g.strokeRect(4, 4, 120, 120);
  g.fillStyle = '#14213d';
  g.font = '900 84px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('7', 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

type Flight = 'none' | 'flying' | 'sunk' | 'landing';

export class Avatar {
  /** 加进场景的就是它 */
  readonly group = new THREE.Group();

  /** 跟着髋走；被撞飞时整体平移、翻滚的也是它 */
  private readonly inner = new THREE.Group();
  private readonly shadow: THREE.Mesh;
  private readonly bib: THREE.Mesh;
  private readonly cap: THREE.Mesh;
  private readonly bones: { def: Bone; mesh: THREE.Mesh }[] = [];
  private readonly balls: { def: Ball; mesh: THREE.Mesh }[] = [];
  private readonly materials = new Map<PartId, { mat: THREE.MeshStandardMaterial; base: number }[]>();
  private readonly cylinder = new THREE.CylinderGeometry(1, 1, 1, 14, 1);
  private readonly sphere = new THREE.SphereGeometry(1, 18, 14);

  private profile: BodyProfile;
  private hip = new THREE.Vector3(0, 0.82, 0);

  private flight: Flight = 'none';
  private flightT = 0;
  private readonly offset = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly spin = new THREE.Vector3();

  constructor(profile: BodyProfile) {
    this.profile = profile;
    const material = (part: PartId, color: number): THREE.MeshStandardMaterial => {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
      const list = this.materials.get(part) ?? [];
      list.push({ mat, base: color });
      this.materials.set(part, list);
      return mat;
    };
    const add = (geo: THREE.BufferGeometry, part: PartId, color: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, material(part, color));
      mesh.castShadow = true;
      this.inner.add(mesh);
      return mesh;
    };
    for (const def of BONES) this.bones.push({ def, mesh: add(this.cylinder, def.part, def.color) });
    for (const def of BALLS) this.balls.push({ def, mesh: add(this.sphere, def.part, def.color) });

    // 帽子：扣在头顶的半球
    this.cap = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), new THREE.MeshStandardMaterial({ color: COLORS.sun, roughness: 0.5 }));
    this.cap.castShadow = true;
    // 号码布：贴在后背（朝 +z，也就是朝观众）
    this.bib = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: bibTexture() }));
    this.inner.add(this.cap, this.bib);

    // 脚下的一团影子：没有阴影贴图时也能看出人站在台子上
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 28), new THREE.MeshBasicMaterial({ color: 0x0a2a44, transparent: true, opacity: 0.22, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.006;

    this.group.add(this.inner, this.shadow);
    this.pose(poseToSkeleton(NEUTRAL, profile));
  }

  setProfile(p: BodyProfile): void {
    this.profile = p;
  }

  /** 把小人摆成这副骨架的样子。 */
  pose(sk: Skeleton): void {
    const p = this.profile;
    const h = sk.hipC;
    this.hip.set(h.x, h.y, h.z);
    const rel = (j: JointName) => ({ x: sk[j].x - h.x, y: sk[j].y - h.y, z: sk[j].z - h.z });

    for (const { def, mesh } of this.bones) {
      const t = capsuleTransform(rel(def.a), rel(def.b));
      const r = def.radius(p);
      mesh.position.set(t.position.x, t.position.y, t.position.z);
      mesh.quaternion.set(...t.quaternion);
      mesh.scale.set(r, Math.max(t.length, 1e-4), r);
    }
    for (const { def, mesh } of this.balls) {
      const at = rel(def.at);
      mesh.position.set(at.x, at.y, at.z);
      mesh.scale.setScalar(def.radius(p));
    }

    const head = rel('head');
    const neck = rel('neck');
    this.cap.position.set(head.x, head.y + p.headR * 0.12, head.z);
    this.cap.scale.setScalar(p.headR * 1.08);

    // 号码布跟着脊柱倾斜，贴在后背外面一点
    const spine = capsuleTransform({ x: 0, y: 0, z: 0 }, neck);
    this.bib.quaternion.set(...spine.quaternion);
    this.bib.position.set(neck.x * 0.6, neck.y * 0.6, neck.z * 0.6 + p.r.torso * 1.02);
    this.bib.scale.setScalar(p.r.torso * 1.25);

    this.syncRoot();
  }

  /** 给部位上色：bad = 没摆对 / 会撞墙（变红），其余恢复本色。 */
  tint(parts: Partial<Record<PartId, PartTint>>): void {
    for (const [part, list] of this.materials) {
      const bad = parts[part] === 'bad';
      for (const { mat, base } of list) {
        mat.color.setHex(bad ? BAD : base);
        mat.emissive.setHex(bad ? 0x7a1408 : 0x000000);
      }
    }
  }

  get busy(): boolean {
    return this.flight !== 'none';
  }

  /** 被墙撞飞：向观众方向抛出去，翻滚着落水。 */
  knock(): void {
    this.flight = 'flying';
    this.flightT = 0;
    this.offset.set(0, 0, 0);
    this.velocity.set((Math.random() - 0.5) * 1.4, 4.4, 3.6);
    this.spin.set(3 + Math.random() * 3, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 5);
  }

  /** 每帧调用。落水的那一帧返回落水点，供水花和音效使用。 */
  update(dt: number): { splash: { x: number; z: number } | null } {
    let splash: { x: number; z: number } | null = null;
    this.flightT += dt;

    if (this.flight === 'flying') {
      this.velocity.y -= 13 * dt;
      this.offset.addScaledVector(this.velocity, dt);
      this.inner.rotation.x += this.spin.x * dt;
      this.inner.rotation.y += this.spin.y * dt;
      this.inner.rotation.z += this.spin.z * dt;
      if (this.hip.y + this.offset.y < WATER_Y) {
        splash = { x: this.hip.x + this.offset.x, z: this.hip.z + this.offset.z };
        this.flight = 'sunk';
        this.flightT = 0;
      }
    } else if (this.flight === 'sunk') {
      // 在水下再沉一小会儿，然后回到台上
      this.offset.y -= 1.2 * dt;
      if (this.flightT > 0.75) {
        this.flight = 'landing';
        this.flightT = 0;
        this.inner.rotation.set(0, 0, 0);
      }
    } else if (this.flight === 'landing') {
      // 从上方落回台面，带一点回弹；同时闪烁，表示"刚复活"
      const k = Math.min(1, this.flightT / 0.45);
      const bounce = Math.abs(Math.cos(k * Math.PI * 1.5)) * (1 - k);
      this.offset.set(0, bounce * 0.9, 0);
      this.inner.visible = Math.floor(this.flightT * 14) % 2 === 0 || k >= 1;
      if (this.flightT > 0.9) {
        this.flight = 'none';
        this.offset.set(0, 0, 0);
        this.inner.visible = true;
      }
    }

    this.syncRoot();
    return { splash };
  }

  private syncRoot(): void {
    this.inner.position.copy(this.hip).add(this.offset);
    const onDeck = this.flight === 'none' || this.flight === 'landing';
    this.shadow.visible = onDeck;
    this.shadow.position.x = this.hip.x;
    this.shadow.position.z = this.hip.z;
  }

  dispose(): void {
    this.cylinder.dispose();
    this.sphere.dispose();
    this.cap.geometry.dispose();
    (this.cap.material as THREE.Material).dispose();
    this.bib.geometry.dispose();
    (this.bib.material as THREE.MeshBasicMaterial).map?.dispose();
    (this.bib.material as THREE.Material).dispose();
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
    for (const list of this.materials.values()) for (const { mat } of list) mat.dispose();
  }
}
