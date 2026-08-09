import { CartoonGrassField } from '@voxel-studio/render-runtime';
import * as THREE from 'three';
import { sampleTerrainHeight, type EditableMap } from '../shared/map';
import { isNearWater } from '../shared/mapWater';
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

/** Render-only contact mask. Persisted/manual grass densities remain untouched. */
export function deriveContactAwareGrassMap(map: EditableMap): EditableMap {
  if (map.waterBodies.length === 0 && map.objects.length === 0) return map;
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  const obstacles = map.objects
    .filter((object) => object.visible)
    .map((object) => {
      const asset = object.assetId ? assets.get(object.assetId) : undefined;
      const scale = Math.max(object.transform.scale[0], object.transform.scale[2]);
      return {
        x: object.transform.position[0],
        z: object.transform.position[2],
        radius: Math.max(0.25, (asset?.footprintRadius ?? Math.max(object.transform.size[0], object.transform.size[2]) * 0.5) * scale)
      };
    });
  const grassLayers = map.grassLayers.map((layer) => {
    const densities = [...layer.densities];
    for (let zIndex = 0; zIndex < layer.resolutionZ; zIndex += 1) {
      const z = indexToWorld(zIndex, map.box.size[2], layer.resolutionZ);
      for (let xIndex = 0; xIndex < layer.resolutionX; xIndex += 1) {
        const index = zIndex * layer.resolutionX + xIndex;
        if ((densities[index] ?? 0) <= 0.001) continue;
        const x = indexToWorld(xIndex, map.box.size[0], layer.resolutionX);
        let factor = isNearWater(map, x, z, 0.2) ? 0 : isNearWater(map, x, z, 1.25) ? 0.28 : 1;
        for (const obstacle of obstacles) {
          const edgeDistance = Math.hypot(x - obstacle.x, z - obstacle.z) - obstacle.radius;
          if (edgeDistance <= 0) factor = Math.min(factor, 0.08);
          else if (edgeDistance < 1.2) factor = Math.min(factor, 0.08 + edgeDistance / 1.2 * 0.92);
        }
        densities[index] *= factor;
      }
    }
    return { ...layer, densities };
  });
  return { ...map, grassLayers };
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

function indexToWorld(index: number, extent: number, resolution: number): number {
  return resolution <= 1 ? 0 : index / (resolution - 1) * extent - extent / 2;
}
