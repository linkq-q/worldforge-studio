import * as THREE from 'three';
import { PlanarReflectionPass } from '@voxel-studio/render-runtime';
import type { WaterSurface } from '@voxel-studio/render-runtime/environment';

export interface PlanarWaterBinding {
  mesh: THREE.Mesh;
  surface: WaterSurface;
}

export interface PlanarWaterTarget {
  mesh: THREE.Mesh;
  setPlanarReflectionTexture(texture: THREE.Texture | null): void;
  setPlanarReflectionMatrix(matrix: THREE.Matrix4): void;
}

export function createPlanarWaterTarget(binding: PlanarWaterBinding): PlanarWaterTarget {
  return {
    mesh: binding.mesh,
    setPlanarReflectionTexture: (texture) => binding.surface.setPlanarReflectionTexture(texture),
    setPlanarReflectionMatrix: (matrix) => binding.surface.setPlanarReflectionMatrix(matrix)
  };
}

export class PlanarWaterReflection {
  private readonly pass: PlanarReflectionPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.pass = new PlanarReflectionPass({ renderer, scene, camera, waterMesh: null });
  }

  setBindings(bindings: readonly PlanarWaterBinding[]): void {
    this.pass.setWaterSurfaces(bindings.map(createPlanarWaterTarget));
  }

  syncSize(): void {
    this.pass.syncToRendererSize();
  }

  render(): void {
    this.pass.render();
  }

  dispose(): void {
    this.pass.dispose();
  }
}
