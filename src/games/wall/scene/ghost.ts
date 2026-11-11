import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Vec2 } from '../../../engine/util/math';

/**
 * 落位轮廓：墙还在远处时，就在小人所在的平面上把洞口的形状描出来——
 * "墙到的时候，洞会在这儿"。玩家可以提前对好，不用等墙贴到脸上。
 *
 * 用的是 three.js 的"粗线"（Line2）：普通的线在大多数显卡上只有 1 像素宽，三米外看不见。
 * 每条线画两遍：下面一条深色的粗线垫底，上面一条白色的细线——这样不管背景是天、是海、
 * 还是哪种颜色的墙，轮廓都看得清。
 */
export function buildGhost(edges: Vec2[][]): THREE.Group {
  const group = new THREE.Group();
  const under = new LineMaterial({ color: 0x14213d, linewidth: 11, transparent: true, opacity: 0.85, depthTest: false });
  const over = new LineMaterial({ color: 0xffffff, linewidth: 5, transparent: true, opacity: 1, depthTest: false });
  for (const edge of edges) {
    if (edge.length < 2) continue;
    const pts = edge.map((p) => ({ ...p }));
    // 两端接到地面，看起来洞是"立在台子上"的
    for (const end of [pts[0], pts[pts.length - 1]]) if (end.y < 0.12) end.y = 0;
    const geo = new LineGeometry();
    geo.setPositions(pts.flatMap((p) => [p.x, p.y, 0]));
    const a = new Line2(geo, under);
    a.renderOrder = 9;
    const b = new Line2(geo, over);
    b.renderOrder = 10; // 画在小人和墙的上面
    group.add(a, b);
  }
  group.userData.materials = [under, over];
  return group;
}

/** 窗口大小变了要告诉粗线材质，否则线宽会不对。 */
export function resizeGhost(ghost: THREE.Object3D, w: number, h: number): void {
  for (const m of (ghost.userData.materials as LineMaterial[] | undefined) ?? []) m.resolution.set(w, h);
}
