import type { RawPose } from '../input/types';

/** 把 MediaPipe 的输出格式转成我们自己的 RawPose（visibility → v，缺省当作完全可见）。 */
export function toRawPose(
  landmarks: { x: number; y: number; z: number; visibility?: number }[],
  world: { x: number; y: number; z: number }[],
): RawPose {
  return {
    image: landmarks.map((p) => ({ x: p.x, y: p.y, z: p.z, v: p.visibility ?? 1 })),
    world: world.map((p, i) => ({ x: p.x, y: p.y, z: p.z, v: landmarks[i]?.visibility ?? 1 })),
  };
}
