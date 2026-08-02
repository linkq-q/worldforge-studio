import { CartoonGrassField } from '@voxel-studio/render-runtime';
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
  let interaction = new MapGrassInteraction(field.group);
  return {
    group: field.group,
    update: (deltaTime) => field.update(deltaTime),
    setStyle: (style) => {
      interaction.restore();
      field.setStyle(style);
      interaction = new MapGrassInteraction(field.group);
    },
    interact: (position, elapsedSeconds) => interaction.update(position, elapsedSeconds),
    clearInteraction: () => interaction.restore(),
    getStats: () => field.getStats(),
    dispose: () => {
      interaction.restore();
      field.dispose();
    },
  };
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
