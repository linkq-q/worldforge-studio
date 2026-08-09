import * as THREE from 'three';

interface UniformPass {
  enabled: boolean;
  uniforms: Record<string, { value: unknown }>;
}

interface WaterEnvironmentSurface {
  setWaterEnvMap(texture: THREE.Texture | null): void;
  setWaterReflectionParams(params: Record<string, unknown>): void;
}

interface WaterReflectionSurface {
  setWaterReflectionParams(params: Record<string, unknown>): void;
  setPlanarReflectionParams(params: Record<string, unknown>): void;
}

interface WaterShoreSurface {
  setShoreDistanceTexture(texture: THREE.Texture | null): void;
  setShoreWorldRegion(centerXZ: { x: number; y: number } | null, size?: number): void;
}

export interface WaterShoreBinding {
  texture: THREE.Texture;
  center: [number, number];
  size: number;
}

export interface WaterReflectionSettings {
  planarStrength: number;
  environmentStrength: number;
  environmentExposure?: number;
  distortion?: number;
  fresnelBoost?: number;
}

export function distanceAtFogOpacity(
  density: number,
  opacity = 0.995,
  exponent = 2,
  startDistance = 0
): number {
  const safeDensity = Number.isFinite(density) ? Math.max(0, density) : 0;
  if (safeDensity === 0) return Number.POSITIVE_INFINITY;
  const safeOpacity = THREE.MathUtils.clamp(Number.isFinite(opacity) ? opacity : 0.995, 0, 0.999999);
  const safeExponent = Math.max(0.0001, Number.isFinite(exponent) ? exponent : 2);
  return Math.max(0, startDistance) + Math.pow(-Math.log(1 - safeOpacity), 1 / safeExponent) / safeDensity;
}

export function configureDistanceFogPass(pass: UniformPass, color: string, density: number): void {
  const normalizedDensity = Math.max(0, Number.isFinite(density) ? density : 0);
  pass.enabled = normalizedDensity > 0;
  const fogColor = pass.uniforms.uFogColor?.value as THREE.Vector3 | undefined;
  const source = new THREE.Color(color);
  fogColor?.set(source.r, source.g, source.b);
  if (pass.uniforms.uFogDensity) pass.uniforms.uFogDensity.value = normalizedDensity;
  if (pass.uniforms.uFogStartDistance) pass.uniforms.uFogStartDistance.value = 0;
  if (pass.uniforms.uFogExpPow) pass.uniforms.uFogExpPow.value = 2;
  if (pass.uniforms.uFogSkyFade) pass.uniforms.uFogSkyFade.value = 0;
}

export function bindDistanceFogDepth(
  pass: UniformPass,
  depthTexture: THREE.DepthTexture,
  camera: THREE.PerspectiveCamera
): void {
  if (pass.uniforms.tDepth) pass.uniforms.tDepth.value = depthTexture;
  if (pass.uniforms.uCameraNear) pass.uniforms.uCameraNear.value = camera.near;
  if (pass.uniforms.uCameraFar) pass.uniforms.uCameraFar.value = camera.far;
}

export function syncWaterSurfaceEnvironment(
  surface: WaterEnvironmentSurface,
  environmentMap: THREE.Texture | null
): void {
  surface.setWaterEnvMap(environmentMap);
  surface.setWaterReflectionParams({ useSceneEnvironment: true });
}

export function syncWaterSurfaceShore(
  surface: WaterShoreSurface,
  binding: WaterShoreBinding
): void {
  surface.setShoreDistanceTexture(binding.texture);
  surface.setShoreWorldRegion({ x: binding.center[0], y: binding.center[1] }, binding.size);
}

export function configureWaterReflection(
  surface: WaterReflectionSurface,
  settings: WaterReflectionSettings
): void {
  surface.setWaterReflectionParams({
    strength: settings.environmentStrength,
    exposure: settings.environmentExposure
  });
  surface.setPlanarReflectionParams({
    strength: settings.planarStrength,
    distortion: settings.distortion,
    fresnelBoost: settings.fresnelBoost
  });
}
