import type { Vec3 } from '../../../engine/util/math';

/**
 * 小人的每段肢体是一根沿 +Y 方向、长度为 1 的圆柱。要把它摆到两个关节 a、b 之间，需要：
 *   位置 = 中点，长度 = 两点距离，旋转 = 把 +Y 转到 a→b 方向的四元数。
 * 这是纯数学，单独放一个文件方便测试。
 */
export function capsuleTransform(a: Vec3, b: Vec3): { position: Vec3; quaternion: [number, number, number, number]; length: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dy, dz);
  const position = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
  if (length < 1e-9) return { position, quaternion: [0, 0, 0, 1], length: 0 };

  const ux = dx / length;
  const uy = dy / length;
  const uz = dz / length;
  // 从 +Y 到方向 u 的最短旋转：轴 = Y × u = (uz, 0, -ux)，四元数 ∝ (轴, 1 + Y·u)
  const w = 1 + uy;
  if (w < 1e-6) return { position, quaternion: [1, 0, 0, 0], length }; // 正好朝下：绕 X 轴转 180°
  const norm = Math.hypot(uz, ux, w);
  return { position, quaternion: [uz / norm, 0, -ux / norm, w / norm], length };
}
