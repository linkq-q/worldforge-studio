import * as THREE from 'three';
import { absorptionFromTransmittance } from '@voxel-studio/render-runtime/postprocess';
import type { EditableMap } from '../shared/map';
import { isPointInsideWaterBody, waterSurfaceLevelAt } from '../shared/mapWater';
import { mapOceanCoast, sampleCoastGrid, type OceanCoastField } from '../shared/oceanCoast';
import type { RuntimeUnderwaterStyle } from '../shared/renderPlan';
import { worldMapSampler } from '../shared/worldMapState';

interface UnderwaterPassLike {
  uniforms: Record<string, { value: unknown }>;
}

const oceanCoastCache = new WeakMap<EditableMap, OceanCoastField | null>();

export function cameraWaterSurfaceLevel(map: EditableMap | null, x: number, z: number): number | null {
  if (!map) return null;
  if (map.world) return worldMapSampler(map.world)(x, z).waterLevel ?? null;
  const oceanCoast = cachedOceanCoast(map);
  let level: number | null = null;
  for (const water of map.waterBodies) {
    const candidate = waterSurfaceLevelAt(water, x, z);
    const inside = water.type === 'ocean'
      ? oceanCoast !== null && candidate - sampleCoastGrid(oceanCoast, x, z) > 0.025
      : isPointInsideWaterBody(water, x, z, map);
    if (!inside) continue;
    if (level === null || candidate > level) level = candidate;
  }
  return level;
}

function cachedOceanCoast(map: EditableMap): OceanCoastField | null {
  if (!oceanCoastCache.has(map)) oceanCoastCache.set(map, mapOceanCoast(map));
  return oceanCoastCache.get(map) ?? null;
}

export function advanceUnderwaterBlend(
  current: number,
  waterLevel: number | null,
  cameraY: number,
  deltaTime: number
): number {
  const depth = waterLevel === null ? Number.NEGATIVE_INFINITY : waterLevel - cameraY;
  const target = smoothstep(-0.08, 0.12, depth);
  const response = 1 - Math.exp(-12 * THREE.MathUtils.clamp(deltaTime, 0, 1));
  const next = THREE.MathUtils.lerp(THREE.MathUtils.clamp(current, 0, 1), target, response);
  return next < 0.0001 ? 0 : next > 0.9999 ? 1 : next;
}

export function configureUnderwaterPass(pass: UnderwaterPassLike, style: RuntimeUnderwaterStyle): void {
  const clear = style.mode !== 'coastal';
  const transmission = new THREE.Color(clear ? 0x2e8cb8 : 0x146185);
  const distance = style.visibilityDistance;
  (pass.uniforms.uAbsorption.value as THREE.Vector3).copy(absorptionFromTransmittance(transmission, distance));
  (pass.uniforms.uScatterColor.value as THREE.Color).set(style.tint);
  pass.uniforms.uScatterStrength.value = style.scatterStrength;
  pass.uniforms.uCausticStrength.value = clear ? 0.12 : 0.08;
}

export function bindUnderwaterDepth(
  pass: UnderwaterPassLike,
  depthTexture: THREE.DepthTexture,
  camera: THREE.PerspectiveCamera,
  waterLevel: number,
  submersion: number,
  elapsedSeconds: number
): void {
  pass.uniforms.tDepth.value = depthTexture;
  (pass.uniforms.uProjectionMatrixInverse.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
  (pass.uniforms.uCameraMatrixWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
  (pass.uniforms.uCameraPosition.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
  pass.uniforms.uCameraFar.value = camera.far;
  pass.uniforms.uWaterLevel.value = waterLevel;
  pass.uniforms.uSubmersion.value = submersion;
  pass.uniforms.uTime.value = elapsedSeconds;
}

function smoothstep(min: number, max: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}
