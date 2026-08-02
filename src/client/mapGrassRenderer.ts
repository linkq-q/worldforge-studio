import { CartoonGrassField } from '@voxel-studio/render-runtime';
import * as THREE from 'three';
import { sampleTerrainHeight, type EditableMap } from '../shared/map';
import type { RuntimeGrassStyle } from '../shared/renderPlan';
import type { Vec3 } from '../shared/protocol';
import { MapGrassInteraction } from './mapGrassInteraction';

export interface RenderedGrassField {
  group: import('three').Group;
  update(deltaTime: number): void;
  setStyle(style: RuntimeGrassStyle): void;
  interact(position: Vec3, elapsedSeconds: number): void;
  clearInteraction(): void;
  getStats(): { layerCount: number; bladeCount: number; flowerCount: number; drawCalls: number };
  dispose(): void;
}

export function buildMapGrassField(map: EditableMap, style?: RuntimeGrassStyle): RenderedGrassField | null {
  if (!map.grassLayers.some((layer) => layer.visible && layer.densities.some((density) => density > 0.001))) {
    return null;
  }
  const field = new CartoonGrassField({
    layers: map.grassLayers,
    width: map.box.size[0],
    depth: map.box.size[2],
    sampleHeight: (x, z) => sampleTerrainHeight(map, x, z),
    sampleNormal: (x, z) => sampleTerrainNormal(map, x, z),
    // Building with the style avoids a second full rebuild from setStyle.
    ...(style ? { style } : {}),
  });
  refineFlowerGeometry(field.group);
  let interaction = new MapGrassInteraction(field.group);
  return {
    group: field.group,
    update: (deltaTime) => field.update(deltaTime),
    setStyle: (style) => {
      interaction.restore();
      disposeRefinedFlowerGeometry(field.group);
      field.setStyle(style);
      refineFlowerGeometry(field.group);
      interaction = new MapGrassInteraction(field.group);
    },
    interact: (position, elapsedSeconds) => interaction.update(position, elapsedSeconds),
    clearInteraction: () => interaction.restore(),
    getStats: () => field.getStats(),
    dispose: () => {
      interaction.restore();
      disposeRefinedFlowerGeometry(field.group);
      field.dispose();
    },
  };
}

function refineFlowerGeometry(root: import('three').Object3D): void {
  root.traverse((object) => {
    const mesh = object as import('three').InstancedMesh;
    if (!mesh.isInstancedMesh || !mesh.userData.grassFlowerCount) return;
    mesh.geometry.dispose();
    mesh.geometry = createFlowerGeometry();
    mesh.userData.worldForgeFlowerGeometry = mesh.geometry;
  });
}

function disposeRefinedFlowerGeometry(root: import('three').Object3D): void {
  root.traverse((object) => {
    const geometry = object.userData.worldForgeFlowerGeometry as THREE.BufferGeometry | undefined;
    geometry?.dispose();
    delete object.userData.worldForgeFlowerGeometry;
  });
}

function createFlowerGeometry(): THREE.BufferGeometry {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let petal = 0; petal < 5; petal += 1) {
    const angle = petal / 5 * Math.PI * 2;
    const base = vertices.length / 3;
    for (const [radius, offset, height] of [
      [0.025, 0, 0.018],
      [0.095, -0.42, 0.035],
      [0.16, 0, 0.045],
      [0.095, 0.42, 0.035]
    ] as const) {
      vertices.push(Math.cos(angle + offset) * radius, height, Math.sin(angle + offset) * radius);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(vertices.length).fill(1), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function sampleTerrainNormal(map: EditableMap, x: number, z: number): [number, number, number] {
  const stepX = map.box.size[0] / Math.max(1, map.terrain.resolutionX - 1);
  const stepZ = map.box.size[2] / Math.max(1, map.terrain.resolutionZ - 1);
  const dx = sampleTerrainHeight(map, x + stepX, z) - sampleTerrainHeight(map, x - stepX, z);
  const dz = sampleTerrainHeight(map, x, z + stepZ) - sampleTerrainHeight(map, x, z - stepZ);
  const nx = -dx / Math.max(0.001, stepX * 2);
  const nz = -dz / Math.max(0.001, stepZ * 2);
  const length = Math.hypot(nx, 1, nz) || 1;
  return [nx / length, 1 / length, nz / length];
}
