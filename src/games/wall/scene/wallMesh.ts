import * as THREE from 'three';
import type { BuiltWall } from '../build';
import { COLORS, WATER_Y } from './stage';

/** 墙的颜色轮着用。 */
export const WALL_COLORS: number[] = [COLORS.coral, COLORS.sun, COLORS.mint, 0x8f6cff, 0xff7ab8, 0xff9a3c];

const THICKNESS = 0.3;
/** 名牌有多宽（米） */
const LABEL_WIDTH = 1.6;
const DISPLAY_FONT = "'ZCOOL QingKe HuangYou', 'PingFang SC', 'Microsoft YaHei', sans-serif";

/**
 * 每种颜色的条纹贴图只做一张，所有这个颜色的墙共用，墙拆掉时也不释放它（disposeObject 见到 shared 标记会跳过）。
 *
 * 为什么不是"每面墙一张、拆墙时释放"：墙板会投影子，而 three.js 画影子用的那个公用材质会一直记着上一张贴图。
 * 贴图释放之后，下一次画影子它又把这张贴图重新传给显卡一遍——这一份就再也没人释放了，每面墙漏一张。
 * 共用之后贴图总数就是颜色的种数，不随墙数增长。
 */
const stripes = new Map<number, THREE.Texture>();

/** 泡沫板表面的斜条纹：让人看得出墙在动、有多大。 */
function stripeTexture(color: number): THREE.Texture {
  const cached = stripes.get(color);
  if (cached) return cached;
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
  tex.userData.shared = true;
  stripes.set(color, tex);
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
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(LABEL_WIDTH, 0.4), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
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

  // 名牌：每个洞的正上方一块（别超出墙）。两块挨得近（双人站得近）就一起缩小，免得叠在一起
  const spacing = wall.labels.length > 1 ? Math.abs(wall.labels[1].x - wall.labels[0].x) : Infinity;
  const size = Math.min(1, Math.max(0.5, (spacing - 0.08) / LABEL_WIDTH));
  for (const plate of wall.labels) {
    const label = labelMesh(plate.text);
    label.scale.setScalar(size);
    const half = (LABEL_WIDTH * size) / 2 + 0.1;
    label.position.x = Math.min(b.x1 - half, Math.max(b.x0 + half, plate.x));
    group.add(label);
  }
  return group;
}
