import type { Lm, RawPose } from '../input/types';

/**
 * 识别结果在 Worker 和主线程之间传递时的格式：一个扁平的 Float32Array。
 *   [人数, 然后每个人：33 个图像点 (x, y, z, v)，接着 33 个世界点 (x, y, z)]
 * 用类型化数组是为了能"转移"（transfer）而不是"复制"：把内存的所有权直接交给对方，零拷贝。
 */
const POINTS = 33;
const PER_POSE = POINTS * 4 + POINTS * 3;

export function packPoses(poses: RawPose[]): Float32Array {
  const out = new Float32Array(1 + poses.length * PER_POSE);
  out[0] = poses.length;
  let k = 1;
  for (const pose of poses) {
    for (const l of pose.image) {
      out[k++] = l.x;
      out[k++] = l.y;
      out[k++] = l.z;
      out[k++] = l.v;
    }
    for (const l of pose.world) {
      out[k++] = l.x;
      out[k++] = l.y;
      out[k++] = l.z;
    }
  }
  return out;
}

export function unpackPoses(data: Float32Array): RawPose[] {
  const poses: RawPose[] = [];
  const count = data[0];
  for (let p = 0; p < count; p++) {
    const base = 1 + p * PER_POSE;
    const image: Lm[] = [];
    const world: Lm[] = [];
    for (let i = 0; i < POINTS; i++) {
      const a = base + i * 4;
      const b = base + POINTS * 4 + i * 3;
      image.push({ x: data[a], y: data[a + 1], z: data[a + 2], v: data[a + 3] });
      world.push({ x: data[b], y: data[b + 1], z: data[b + 2], v: data[a + 3] });
    }
    poses.push({ image, world });
  }
  return poses;
}
