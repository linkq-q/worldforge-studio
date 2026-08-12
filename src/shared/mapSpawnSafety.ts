import {
  PLAYER_MAX_WALKABLE_SLOPE,
  getMapPlayerMetrics,
  getMapBounds,
  getMapObjectAabbs,
  getRoomShellAabbs,
  getTerrainCliffAabbs,
  type EditableMap
} from './map';
import { terrainSlopeDegrees } from './mapTerrainAnalysis';
import { isNearWater } from './mapWater';
import { isPointInsidePlayableArea } from './mapLayout';

export function isSpawnPositionSafe(map: EditableMap, x: number, z: number): boolean {
  const bounds = getMapBounds(map);
  const { radius } = getMapPlayerMetrics(map);
  if (x < bounds.minX + radius || x > bounds.maxX - radius) return false;
  if (z < bounds.minZ + radius || z > bounds.maxZ - radius) return false;
  if (!isPointInsidePlayableArea(map.layout, map.box.size, x, z)) return false;
  for (let index = 0; index < 8; index += 1) {
    const angle = index / 8 * Math.PI * 2;
    if (!isPointInsidePlayableArea(
      map.layout,
      map.box.size,
      x + Math.cos(angle) * radius,
      z + Math.sin(angle) * radius
    )) return false;
  }
  if (isNearWater(map, x, z, radius + 0.2)) return false;
  if (terrainSlopeDegrees(map, x, z) > PLAYER_MAX_WALKABLE_SLOPE) return false;
  const roomWalls = getRoomShellAabbs(map).filter((obstacle) => (
    !obstacle.objectId.includes(':floor:') && !obstacle.objectId.includes(':ceiling:')
  ));
  return ![...getMapObjectAabbs(map), ...getTerrainCliffAabbs(map), ...roomWalls].some((obstacle) => {
    const closestX = clamp(x, obstacle.min[0], obstacle.max[0]);
    const closestZ = clamp(z, obstacle.min[2], obstacle.max[2]);
    return Math.hypot(x - closestX, z - closestZ) < radius + 0.1;
  });
}

export function findSafeSpawnPosition(map: EditableMap, requestedX: number, requestedZ: number): [number, number] {
  const bounds = getMapBounds(map);
  const { radius: playerRadius } = getMapPlayerMetrics(map);
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
        bounds.minX + playerRadius,
        bounds.maxX - playerRadius
      );
      const z = clamp(
        requestedZ + Math.sin(angle) * radius,
        bounds.minZ + playerRadius,
        bounds.maxZ - playerRadius
      );
      if (isSpawnPositionSafe(map, x, z)) return [x, z];
    }
  }
  return [
    clamp(requestedX, bounds.minX + playerRadius, bounds.maxX - playerRadius),
    clamp(requestedZ, bounds.minZ + playerRadius, bounds.maxZ - playerRadius)
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
