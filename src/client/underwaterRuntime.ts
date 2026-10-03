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

export interface UnderwaterWaveProfile {
  amplitude: number;
  scale: number;
  speed: number;
  primaryDirection: [number, number];
  secondaryDirection: [number, number];
  foamColor: string;
  edgeStrength: number;
}

export const DEFAULT_UNDERWATER_WAVE_PROFILE: UnderwaterWaveProfile = {
  amplitude: 0.1,
  scale: 1.3,
  speed: 0.48,
  primaryDirection: [0.875, 0.485],
  secondaryDirection: [-0.615, 0.789],
  foamColor: '#eefcff',
  edgeStrength: 0.78
};

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
  if (deltaTime <= 0) return target;
  const response = 1 - Math.exp(-12 * THREE.MathUtils.clamp(deltaTime, 0, 1));
  const next = THREE.MathUtils.lerp(THREE.MathUtils.clamp(current, 0, 1), target, response);
  return next < 0.0001 ? 0 : next > 0.9999 ? 1 : next;
}

export function sampleUnderwaterWaveOffset(
  x: number,
  z: number,
  elapsedSeconds: number,
  profile: UnderwaterWaveProfile = DEFAULT_UNDERWATER_WAVE_PROFILE
): number {
  x = finiteNumber(x, 0);
  z = finiteNumber(z, 0);
  elapsedSeconds = finiteNumber(elapsedSeconds, 0);
  const primary = normalizedDirection(profile.primaryDirection, [1, 0.25]);
  const secondary = normalizedDirection(profile.secondaryDirection, [-0.35, 1]);
  const detail = normalizedDirection(
    [primary[0] + secondary[0], primary[1] + secondary[1]],
    [0.6, 1]
  );
  const scale = Math.max(0.001, profile.scale);
  const speed = profile.speed;
  const broad = Math.sin((x * primary[0] + z * primary[1]) * scale * 0.55 + elapsedSeconds * speed * 0.85);
  const cross = Math.sin((x * secondary[0] + z * secondary[1]) * scale * 0.83 - elapsedSeconds * speed * 0.62 + 1.7);
  const ripple = Math.sin((x * detail[0] + z * detail[1]) * scale * 1.6 + elapsedSeconds * speed * 1.15 - 0.4);
  return Math.max(0, profile.amplitude) * (broad * 0.55 + cross * 0.3 + ripple * 0.15);
}

export function underwaterSurfaceLevel(
  baseLevel: number,
  x: number,
  z: number,
  elapsedSeconds: number,
  profile: UnderwaterWaveProfile = DEFAULT_UNDERWATER_WAVE_PROFILE
): number {
  return baseLevel + sampleUnderwaterWaveOffset(x, z, elapsedSeconds, profile);
}

export function underwaterWaveProfileFromUniforms(
  uniforms: Record<string, { value: unknown }> | null | undefined
): UnderwaterWaveProfile {
  if (!uniforms) return { ...DEFAULT_UNDERWATER_WAVE_PROFILE };
  const primary = vector2Value(uniforms.uPrimaryWaveDirection?.value, DEFAULT_UNDERWATER_WAVE_PROFILE.primaryDirection);
  const secondary = vector2Value(uniforms.uSecondaryWaveDirection?.value, DEFAULT_UNDERWATER_WAVE_PROFILE.secondaryDirection);
  const foam = uniforms.uFoamColor?.value;
  const foamStrength = finiteNumber(uniforms.uFoamStrength?.value, 1);
  const shoreStrength = finiteNumber(uniforms.uShoreWaveStrength?.value, 0);
  return {
    amplitude: THREE.MathUtils.clamp(finiteNumber(uniforms.uWaveHeight?.value, DEFAULT_UNDERWATER_WAVE_PROFILE.amplitude), 0, 0.5),
    scale: THREE.MathUtils.clamp(finiteNumber(uniforms.uWaveScale?.value, DEFAULT_UNDERWATER_WAVE_PROFILE.scale), 0.001, 8),
    speed: THREE.MathUtils.clamp(finiteNumber(uniforms.uWaveSpeed?.value, DEFAULT_UNDERWATER_WAVE_PROFILE.speed), -4, 4),
    primaryDirection: primary,
    secondaryDirection: secondary,
    foamColor: foam instanceof THREE.Color ? `#${foam.getHexString()}` : DEFAULT_UNDERWATER_WAVE_PROFILE.foamColor,
    edgeStrength: THREE.MathUtils.clamp(0.45 + foamStrength * 0.25 + shoreStrength * 0.12, 0, 1.5)
  };
}

export function configureUnderwaterPass(pass: UnderwaterPassLike, style: RuntimeUnderwaterStyle): void {
  const clear = style.mode !== 'coastal';
  const transmission = new THREE.Color(clear ? 0x2e8cb8 : 0x146185);
  const distance = style.visibilityDistance;
  (pass.uniforms.uAbsorption.value as THREE.Vector3).copy(absorptionFromTransmittance(transmission, distance));
  (pass.uniforms.uScatterColor.value as THREE.Color).set(style.tint);
  pass.uniforms.uScatterStrength.value = style.scatterStrength;
}

export function bindUnderwaterDepth(
  pass: UnderwaterPassLike,
  depthTexture: THREE.DepthTexture,
  camera: THREE.PerspectiveCamera,
  waterLevel: number,
  submersion: number,
  elapsedSeconds = 0,
  wave: UnderwaterWaveProfile = DEFAULT_UNDERWATER_WAVE_PROFILE
): void {
  pass.uniforms.tDepth.value = depthTexture;
  (pass.uniforms.uProjectionMatrixInverse.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
  (pass.uniforms.uCameraMatrixWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
  (pass.uniforms.uCameraPosition.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
  pass.uniforms.uCameraFar.value = camera.far;
  pass.uniforms.uWaterLevel.value = waterLevel;
  pass.uniforms.uSubmersion.value = submersion;
  if (pass.uniforms.uTime) pass.uniforms.uTime.value = elapsedSeconds;
  if (pass.uniforms.uWaveHeight) pass.uniforms.uWaveHeight.value = Math.max(0, wave.amplitude);
  if (pass.uniforms.uWaveScale) pass.uniforms.uWaveScale.value = Math.max(0.001, wave.scale);
  if (pass.uniforms.uWaveSpeed) pass.uniforms.uWaveSpeed.value = wave.speed;
  if (pass.uniforms.uPrimaryWaveDirection) {
    (pass.uniforms.uPrimaryWaveDirection.value as THREE.Vector2).set(...normalizedDirection(wave.primaryDirection, [1, 0.25]));
  }
  if (pass.uniforms.uSecondaryWaveDirection) {
    (pass.uniforms.uSecondaryWaveDirection.value as THREE.Vector2).set(...normalizedDirection(wave.secondaryDirection, [-0.35, 1]));
  }
  if (pass.uniforms.uWaterlineColor) {
    (pass.uniforms.uWaterlineColor.value as THREE.Color).set(wave.foamColor);
  }
  if (pass.uniforms.uWaterlineStrength) {
    pass.uniforms.uWaterlineStrength.value = THREE.MathUtils.clamp(wave.edgeStrength, 0, 1.5);
  }
}

function normalizedDirection(direction: [number, number], fallback: [number, number]): [number, number] {
  const length = Math.hypot(direction[0], direction[1]);
  if (length > 0.000001) return [direction[0] / length, direction[1] / length];
  const fallbackLength = Math.hypot(fallback[0], fallback[1]) || 1;
  return [fallback[0] / fallbackLength, fallback[1] / fallbackLength];
}

function vector2Value(value: unknown, fallback: [number, number]): [number, number] {
  if (value instanceof THREE.Vector2) return [value.x, value.y];
  if (Array.isArray(value) && value.length >= 2) {
    return [finiteNumber(value[0], fallback[0]), finiteNumber(value[1], fallback[1])];
  }
  return [...fallback];
}

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function smoothstep(min: number, max: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}
