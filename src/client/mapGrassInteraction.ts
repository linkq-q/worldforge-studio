import * as THREE from 'three';
import type { Vec3 } from '../shared/protocol';

interface GrassMeshIndex {
  mesh: THREE.InstancedMesh;
  matrices: Float32Array;
  grid: Map<string, number[]>;
  active: Set<number>;
}

/** Local CPU interaction for the small set of grass instances around the player. */
export class MapGrassInteraction {
  private readonly meshes: GrassMeshIndex[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly scale = new THREE.Matrix4();
  private lastUpdateAt = -Infinity;

  constructor(root: THREE.Object3D, private readonly radius = 1.35) {
    root.traverse((object) => {
      const mesh = object as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh || !mesh.userData.grassBladeCount) return;
      const matrices = new Float32Array(mesh.count * 16);
      const grid = new Map<string, number[]>();
      for (let index = 0; index < mesh.count; index += 1) {
        mesh.getMatrixAt(index, this.matrix);
        matrices.set(this.matrix.elements, index * 16);
        const key = cellKey(this.matrix.elements[12], this.matrix.elements[14], this.radius);
        const bucket = grid.get(key) ?? [];
        bucket.push(index);
        grid.set(key, bucket);
      }
      this.meshes.push({ mesh, matrices, grid, active: new Set() });
    });
  }

  update(position: Vec3, elapsedSeconds: number): void {
    if (elapsedSeconds - this.lastUpdateAt < 0.045) return;
    this.lastUpdateAt = elapsedSeconds;
    for (const entry of this.meshes) this.updateMesh(entry, position[0], position[2]);
  }

  restore(): void {
    for (const entry of this.meshes) {
      for (const index of entry.active) {
        this.matrix.fromArray(entry.matrices, index * 16);
        entry.mesh.setMatrixAt(index, this.matrix);
      }
      if (entry.active.size) entry.mesh.instanceMatrix.needsUpdate = true;
      entry.active.clear();
    }
  }

  private updateMesh(entry: GrassMeshIndex, x: number, z: number): void {
    let changed = false;
    for (const index of entry.active) {
      this.matrix.fromArray(entry.matrices, index * 16);
      entry.mesh.setMatrixAt(index, this.matrix);
      changed = true;
    }
    entry.active.clear();

    const cellX = Math.floor(x / this.radius);
    const cellZ = Math.floor(z / this.radius);
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (const index of entry.grid.get(`${cellX + dx}:${cellZ + dz}`) ?? []) {
          this.matrix.fromArray(entry.matrices, index * 16);
          const offsetX = this.matrix.elements[12] - x;
          const offsetZ = this.matrix.elements[14] - z;
          const distance = Math.hypot(offsetX, offsetZ);
          if (distance >= this.radius) continue;
          const influence = 1 - distance / this.radius;
          const length = Math.max(0.001, distance);
          this.matrix.elements[12] += offsetX / length * influence * 0.32;
          this.matrix.elements[14] += offsetZ / length * influence * 0.32;
          this.scale.makeScale(1, 1 - influence * 0.45, 1);
          this.matrix.multiply(this.scale);
          entry.mesh.setMatrixAt(index, this.matrix);
          entry.active.add(index);
          changed = true;
        }
      }
    }
    if (changed) entry.mesh.instanceMatrix.needsUpdate = true;
  }
}

function cellKey(x: number, z: number, size: number): string {
  return `${Math.floor(x / size)}:${Math.floor(z / size)}`;
}
