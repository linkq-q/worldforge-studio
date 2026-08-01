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

export interface WaterReflectionSettings {
  strength: number;
  distortion?: number;
  fresnelBoost?: number;
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

export function configureWaterReflection(
  surface: WaterReflectionSurface,
  settings: WaterReflectionSettings
): void {
  surface.setWaterReflectionParams({ strength: settings.strength });
  surface.setPlanarReflectionParams({
    strength: settings.strength,
    distortion: settings.distortion,
    fresnelBoost: settings.fresnelBoost
  });
}
