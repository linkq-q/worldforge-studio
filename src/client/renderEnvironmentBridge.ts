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
}

interface WaterShoreSurface {
  setShoreDistanceTexture(texture: THREE.Texture | null): void;
  setShoreWorldRegion(centerXZ: { x: number; y: number } | null, size?: number): void;
}

interface WaterOceanSurface {
  setOceanTerrainTexture(texture: THREE.Texture | null, config?: object): boolean;
  setOceanShoreSplashPoints(points: Array<[number, number]>): THREE.Points | null;
}

export interface WaterShoreBinding {
  texture: THREE.Texture;
  depthTexture?: THREE.Texture;
  center: [number, number];
  size: number;
  worldSpace?: boolean;
  distanceScale?: number;
}

export interface WaterOceanTerrainBinding {
  texture: THREE.Texture;
  terrainSize: [number, number];
  mapSize: [number, number];
  center: [number, number];
  level: number;
  apronWidth: number;
  sinkTarget: number;
  splashPoints: Array<[number, number]>;
}

export function shouldUseSceneDepthForWater(binding: WaterShoreBinding | undefined): boolean {
  return !binding?.texture?.isTexture;
}

export interface WaterReflectionSettings {
  environmentStrength: number;
  environmentExposure?: number;
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
  if (binding.worldSpace === false) surface.setShoreWorldRegion(null);
  else surface.setShoreWorldRegion({ x: binding.center[0], y: binding.center[1] }, binding.size);
}

export function syncWaterSurfaceOcean(
  surface: WaterOceanSurface,
  binding: WaterOceanTerrainBinding
): THREE.Points | null {
  const enabled = surface.setOceanTerrainTexture(binding.texture, binding);
  return enabled ? surface.setOceanShoreSplashPoints(binding.splashPoints) : null;
}

export function configureWaterReflection(
  surface: WaterReflectionSurface,
  settings: WaterReflectionSettings
): void {
  surface.setWaterReflectionParams({
    strength: settings.environmentStrength,
    exposure: settings.environmentExposure
  });
}

// One small, tileable normal field shared by the existing water-material bindings.
export function createWaterDetailTexture(): THREE.DataTexture {
  const size = 128, data = new Uint8Array(size * size * 4);
  const waves = [[2,3],[5,-2],[-3,7],[8,5],[-7,-4],[11,-3],[-5,9],[3,-11]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let dx = 0, dy = 0;
    waves.forEach(([kx, ky], i) => {
      const slope = Math.cos(2 * Math.PI * (kx * x + ky * y) / size + i * 2.39996) * 0.075 / Math.hypot(kx, ky);
      dx += kx * slope; dy += ky * slope;
    });
    const length = Math.hypot(dx, dy, 1), offset = (y * size + x) * 4;
    data[offset] = Math.round((dx / length * 0.5 + 0.5) * 255);
    data[offset + 1] = Math.round((dy / length * 0.5 + 0.5) * 255);
    data[offset + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
    data[offset + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.name = 'water-detail-normal';
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

const waterLightTarget = new THREE.Vector3();
export function syncWaterSurfaceLight(material: THREE.ShaderMaterial, light: THREE.DirectionalLight | null): void {
  const uniforms = material.uniforms;
  if (!uniforms.uUseSceneWaterLight) return;
  uniforms.uUseSceneWaterLight.value = Boolean(light);
  if (!light) return;
  light.getWorldPosition(uniforms.uSceneWaterLightDirection.value);
  light.target.getWorldPosition(waterLightTarget);
  uniforms.uSceneWaterLightDirection.value.sub(waterLightTarget).normalize();
  uniforms.uSceneWaterLightColor.value.copy(light.color).multiplyScalar(light.visible ? Math.min(2, light.intensity / 2.5) : 0);
}
