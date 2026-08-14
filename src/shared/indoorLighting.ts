import type { EditableMap } from './map';

export interface IndoorLightCoverage {
  sampleCount: number;
  coveredSamples: number;
  ratio: number;
  practicalLightCount: number;
}

/** Estimates worst-case practical-light coverage without depending on Three.js. */
export function evaluateIndoorLightCoverage(map: EditableMap): IndoorLightCoverage {
  const room = map.sceneMode === 'indoor' ? map.room : null;
  if (!room) return { sampleCount: 0, coveredSamples: 0, ratio: 1, practicalLightCount: 0 };
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  const lights = map.objects.flatMap((object) => {
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    if (!asset?.light || object.parentId || object.visible === false) return [];
    const scale = object.transform.scale;
    const offset = asset.light.offset ?? [0, 0, 0];
    return [{
      x: object.transform.position[0] + offset[0] * scale[0],
      y: object.transform.position[1] + offset[1] * scale[1],
      z: object.transform.position[2] + offset[2] * scale[2],
      intensity: Math.max(0, asset.light.intensity),
      range: Math.max(0.1, asset.light.range)
    }];
  });
  const samples: Array<[number, number, number]> = [];
  for (let z = 0; z < 4; z += 1) {
    for (let x = 0; x < 4; x += 1) {
      samples.push([
        room.position[0] + (x / 3 - 0.5) * Math.max(0, room.size[0] - room.wallThickness * 4),
        room.position[1] + Math.min(1, room.size[1] * 0.35),
        room.position[2] + (z / 3 - 0.5) * Math.max(0, room.size[2] - room.wallThickness * 4)
      ]);
    }
  }
  const coveredSamples = samples.filter(([x, y, z]) => lights.reduce((sum, light) => {
    const distance = Math.hypot(x - light.x, y - light.y, z - light.z);
    if (distance > light.range) return sum;
    return sum + light.intensity / Math.max(1, distance * distance);
  }, 0) >= 0.085).length;
  return {
    sampleCount: samples.length,
    coveredSamples,
    ratio: samples.length > 0 ? coveredSamples / samples.length : 1,
    practicalLightCount: lights.length
  };
}
