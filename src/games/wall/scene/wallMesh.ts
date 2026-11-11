import * as THREE from 'three';
import type { BuiltWall } from '../build';
import { COLORS, WATER_Y } from './stage';

/** 墙的颜色轮着用。 */
export const WALL_COLORS: number[] = [COLORS.coral, COLORS.sun, COLORS.mint, 0x8f6cff, 0xff7ab8, 0xff9a3c];

const THICKNESS = 0.3;
const DISPLAY_FONT = "'ZCOOL QingKe HuangYou', 'PingFang SC', 'Microsoft YaHei', sans-serif";

/** 泡沫板表面的斜条纹：让人看得出墙在动、有多大。 */
function stripeTexture(color: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const base = new THREE.Color(color);
  g.fillStyle = `#${base.getHexString()}`;
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = `#${base.clone().lerp(new THREE.Color(0xffffff), 0.22).getHexString()}`;
  g.lineWidth = 12;
  for (let i = -64; i <= 128; i += 32) {
    g.beginPath();
    g.moveTo(i, 64);
    g.lineTo(i + 64, 0);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // 拉伸出来的面，UV 就是墙面上的米数：每 0.8 米重复一次
  tex.repeat.set(1 / 0.8, 1 / 0.8);
  return tex;
}

/** 墙顶上的名牌。字体可能还没加载好，加载完会重画一次。 */
function labelMesh(text: string): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const draw = (): void => {
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, 512, 128);
    g.fillStyle = '#f7fdff';
    g.strokeStyle = '#14213d';
    g.lineWidth = 8;
    g.beginPath();
    g.roundRect(6, 6, 500, 116, 28);
    g.fill();
    g.stroke();
    g.fillStyle = '#14213d';
    g.font = `76px ${DISPLAY_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 256, 70, 460);
    tex.needsUpdate = true;
  };
  draw();
  void document.fonts?.load(`76px ${DISPLAY_FONT}`, text).then(draw, () => {});
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.4), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  mesh.position.set(0, 2.72, THICKNESS / 2 + 0.03);
  return mesh;
}

/**
 * 把一面造好的墙变成 3D 物体：轮廓拉伸成有厚度的泡沫板，洞就是轮廓上的缺口。
 * 墙面和侧面（洞的切口）用两种深浅，洞口才显得有厚度。墙两侧各有一个浮筒托着它在水上滑。
 */
export function buildWallMesh(wall: BuiltWall, color: number): THREE.Group {
  const group = new THREE.Group();
  const face = new THREE.MeshStandardMaterial({ map: stripeTexture(color), roughness: 0.85 });
  const side = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.62), roughness: 0.9 });

  for (const outline of wall.outlines) {
    const shape = new THREE.Shape(outline.outer.map((p) => new THREE.Vector2(p.x, p.y)));
    for (const hole of outline.holes) shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p.x, p.y))));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: THICKNESS - 0.06, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: 2, curveSegments: 1 });
    geo.translate(0, 0, -(THICKNESS - 0.06) / 2);
    // ExtrudeGeometry 的材质分组：0 是前后两面，1 是侧面
    const slab = new THREE.Mesh(geo, [face, side]);
    slab.castShadow = true;
    group.add(slab);
  }

  // 两侧的支架和浮筒（都在浮台的宽度以外，不会和浮台穿插）
  const strut = new THREE.MeshStandardMaterial({ color: COLORS.ink, roughness: 0.7 });
  const pontoon = new THREE.MeshStandardMaterial({ color: COLORS.foam, roughness: 0.5 });
  const b = wall.field.bounds;
  for (const s of [-1, 1]) {
    const edge = s > 0 ? b.x1 : b.x0;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.12), strut);
    arm.position.set(edge + s * 0.16, 0.14, 0);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.14 - WATER_Y, 8), strut);
    post.position.set(edge + s * 0.32, (0.14 + WATER_Y) / 2, 0);
    const float = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.9, 6, 12), pontoon);
    float.rotation.x = Math.PI / 2;
    float.position.set(edge + s * 0.32, WATER_Y + 0.06, 0);
    group.add(arm, post, float);
  }

  const label = labelMesh(wall.label);
  // 名牌放在洞的正上方，但别超出墙
  label.position.x = Math.min(b.x1 - 0.9, Math.max(b.x0 + 0.9, wall.spec.holeX));
  group.add(label);
  return group;
}
