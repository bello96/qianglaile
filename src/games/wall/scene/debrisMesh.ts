import * as THREE from 'three';
import type { Chunk } from '../fx/debris';

/**
 * 把碎块（fx/debris.ts 里算出来的）画出来：一个 InstancedMesh，全部碎块一次绘制。
 * 物理归物理、画归画——这里不改碎块的任何数据。
 */
export class DebrisMesh {
  readonly mesh: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  private readonly tint = new THREE.Color();

  constructor(
    private readonly capacity: number,
    shadows: boolean,
  ) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.88 }), capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadows;
  }

  /** 每帧调用：按碎块现在的位置、朝向、颜色摆好。快消失的那一小段时间里缩小。 */
  sync(chunks: readonly Chunk[]): void {
    const n = Math.min(chunks.length, this.capacity);
    for (let i = 0; i < n; i++) {
      const c = chunks[i];
      const fade = Math.min(1, (c.life - c.age) / 0.5);
      this.dummy.position.set(c.x, c.y, c.z);
      this.dummy.rotation.set(c.rx, c.ry, c.rz);
      this.dummy.scale.set(c.sx * fade, c.sy * fade, c.sz * fade);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, this.tint.setHex(c.color));
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
