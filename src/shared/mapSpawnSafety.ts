import {
  PLAYER_RADIUS,
  getMapBounds,
  getMapObjectAabbs,
  getTerrainCliffAabbs,
  type EditableMap
} from './map';
import { terrainSlopeDegrees } from './mapTerrainAnalysis';
import { isNearWater } from './mapWater';
import { isPointInsidePlayableArea } from './mapLayout';

export function isSpawnPositionSafe(map: EditableMap, x: number, z: number): boolean {
  const bounds = getMapBounds(map);
  if (x < bounds.minX + PLAYER_RADIUS || x > bounds.maxX - PLAYER_RADIUS) return false;
  if (z < bounds.minZ + PLAYER_RADIUS || z > bounds.maxZ - PLAYER_RADIUS) return false;
  if (!isPointInsidePlayableArea(map.layout, map.box.size, x, z)) return false;
  for (let index = 0; index < 8; index += 1) {
    const angle = index / 8 * Math.PI * 2;
    if (!isPointInsidePlayableArea(
      map.layout,
      map.box.size,
      x + Math.cos(angle) * PLAYER_RADIUS,
      z + Math.sin(angle) * PLAYER_RADIUS
    )) return false;
  }
  if (isNearWater(map, x, z, PLAYER_RADIUS + 0.2)) return false;
  if (terrainSlopeDegrees(map, x, z) > 35) return false;
  return ![...getMapObjectAabbs(map), ...getTerrainCliffAabbs(map)].some((obstacle) => {
    const closestX = clamp(x, obstacle.min[0], obstacle.max[0]);
    const closestZ = clamp(z, obstacle.min[2], obstacle.max[2]);
    return Math.hypot(x - closestX, z - closestZ) < PLAYER_RADIUS + 0.1;
  });
}

export function findSafeSpawnPosition(map: EditableMap, requestedX: number, requestedZ: number): [number, number] {
  const bounds = getMapBounds(map);
  const terrainStep = Math.max(
    1,
    Math.min(
      map.box.size[0] / Math.max(1, map.terrain.resolutionX - 1),
      map.box.size[2] / Math.max(1, map.terrain.resolutionZ - 1)
    )
  );
  const maxRadius = Math.min(map.box.size[0], map.box.size[2]) / 3;
  for (let radius = 0; radius <= maxRadius; radius += terrainStep) {
    const candidateCount = radius === 0 ? 1 : Math.max(8, Math.ceil(Math.PI * 2 * radius / terrainStep));
    for (let index = 0; index < candidateCount; index += 1) {
      const angle = candidateCount === 1 ? 0 : index / candidateCount * Math.PI * 2;
      const x = clamp(
        requestedX + Math.cos(angle) * radius,
        bounds.minX + PLAYER_RADIUS,
        bounds.maxX - PLAYER_RADIUS
      );
      const z = clamp(
        requestedZ + Math.sin(angle) * radius,
        bounds.minZ + PLAYER_RADIUS,
        bounds.maxZ - PLAYER_RADIUS
      );
      if (isSpawnPositionSafe(map, x, z)) return [x, z];
    }
  }
  return [
    clamp(requestedX, bounds.minX + PLAYER_RADIUS, bounds.maxX - PLAYER_RADIUS),
    clamp(requestedZ, bounds.minZ + PLAYER_RADIUS, bounds.maxZ - PLAYER_RADIUS)
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
