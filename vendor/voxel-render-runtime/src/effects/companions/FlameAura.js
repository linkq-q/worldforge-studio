// Minimal single-file v0: do not add CompanionEffectRuntime yet; extract a shared runtime only after FlameAura and LightningArc/HitBurst exist.
import * as THREE from 'three';
import { RENDER_ORDER } from '../../render/RenderOrders.js';
import { BLOOM_LAYER } from '../../RenderLayers.js';

export const DEFAULT_FLAME_AURA_PARAMS = Object.freeze({
  innerColor: Object.freeze([0.72, 0.92, 1.0]),
  outerColor: Object.freeze([0.05, 0.18, 0.8]),
  intensity: 1.15,
  speed: 1.25,
  noiseScale: 4.0,
  threshold: 0.5,
  alpha: 0.55,
  sizeMultiplier: 1.15,
});

const EFFECT_NAME = 'FlameAura';
const NUMERIC_UNIFORMS = Object.freeze({
  intensity: 'uFlameAuraIntensity',
  speed: 'uFlameAuraSpeed',
  noiseScale: 'uFlameAuraScale',
  threshold: 'uFlameAuraThreshold',
  alpha: 'uFlameAuraAlpha',
});

const VERTEX_SHADER = /* glsl */`
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */`
uniform float uTime;
uniform vec3 uFlameAuraInnerColor;
uniform vec3 uFlameAuraOuterColor;
uniform float uFlameAuraIntensity;
uniform float uFlameAuraSpeed;
uniform float uFlameAuraScale;
uniform float uFlameAuraThreshold;
uniform float uFlameAuraAlpha;
uniform float uFlameAuraSeed;
uniform float uFlameAuraLayer;
varying vec2 vUv;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + 1.0), u.x), u.y);
}

float fbm2D(vec2 p) {
  float value = noise2D(p) * 0.58;
  value += noise2D(p * 2.03 + 13.7) * 0.29;
  value += noise2D(p * 4.01 + 37.1) * 0.13;
  return value;
}

void main() {
  float time = uTime * uFlameAuraSpeed;
  float y = clamp(vUv.y, 0.0, 1.0);
  float swayNoise = fbm2D(vec2(y * 1.8 - time * 0.58, uFlameAuraSeed + 2.7));
  float sway = (swayNoise - 0.5) * mix(0.04, 0.24, y);
  float x = vUv.x - 0.5 - sway;

  vec2 flowA = vec2(x * uFlameAuraScale * 1.25 + uFlameAuraSeed,
                    (y - time * 0.30) * uFlameAuraScale);
  vec2 flowB = vec2(x * uFlameAuraScale * 2.4 + 11.7 + uFlameAuraSeed,
                    (y - time * 0.62) * uFlameAuraScale * 1.65);
  float noiseA = fbm2D(flowA);
  float noiseB = fbm2D(flowB);

  float layerWidth = mix(1.0, 0.72, uFlameAuraLayer);
  float halfWidth = mix(0.48, 0.055, pow(y, 0.78)) * layerWidth;
  float edgeBreakup = (noiseB - 0.5) * mix(0.05, 0.18, y) * mix(1.0, 0.68, uFlameAuraLayer);
  float shape = 1.0 - smoothstep(halfWidth + edgeBreakup - 0.065, halfWidth + edgeBreakup, abs(x));
  float bottomFade = smoothstep(0.0, 0.12, vUv.y);
  float topBreakup = 1.0 - smoothstep(0.76, 1.02, y + (noiseB - 0.5) * 0.34);
  float energy = shape * mix(noiseA, noiseB, 0.42) * bottomFade * topBreakup;
  float layerThreshold = uFlameAuraThreshold + mix(-0.08, 0.06, uFlameAuraLayer);
  float flame = smoothstep(layerThreshold - 0.16, layerThreshold + 0.10, energy);
  float flameBands = floor(flame * 4.0 + 0.5) / 4.0;
  flame = mix(flame, flameBands, 0.34);
  float inner = smoothstep(0.30, 0.78, shape * noiseA) * (1.0 - y * 0.35) * mix(0.45, 1.0, uFlameAuraLayer);
  vec3 col = mix(uFlameAuraOuterColor, uFlameAuraInnerColor, inner);
  float layerAlpha = mix(0.62, 0.9, uFlameAuraLayer);
  gl_FragColor = vec4(col * uFlameAuraIntensity, flame * uFlameAuraAlpha * layerAlpha);
}
`;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isColorArray(value) {
  return Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(isFiniteNumber);
}

function setColor(color, value) {
  if (!isColorArray(value)) return false;
  color.setRGB(value[0], value[1], value[2]);
  return true;
}

function markCompanionObject(object) {
  object.isFlameAura = true;
  object.userData.isFlameAura = true;
  object.userData.skipSelection = true;
  object.userData.skipBatching = true;
  object.userData.skipShaderApply = true;
  object.layers?.enable?.(BLOOM_LAYER);
}

function getStoredAura(target) {
  return target?.userData?.companionEffects?.[EFFECT_NAME] || null;
}

function computeLocalMeshBounds(target) {
  if (typeof target.updateWorldMatrix !== 'function' || !target.matrixWorld) return null;
  target.updateWorldMatrix(true, true);
  const inverseTarget = new THREE.Matrix4().copy(target.matrixWorld).invert();
  const localBounds = new THREE.Box3().makeEmpty();
  let hasMeshBounds = false;
  target.traverse((object) => {
    if (!object.isMesh || !object.geometry || object.userData?.isFlameAura === true) return;
    if (!object.geometry.boundingBox && typeof object.geometry.computeBoundingBox === 'function') {
      object.geometry.computeBoundingBox();
    }
    const geometryBounds = object.geometry.boundingBox;
    if (!geometryBounds || geometryBounds.isEmpty()) return;
    const relativeMatrix = new THREE.Matrix4().multiplyMatrices(inverseTarget, object.matrixWorld);
    localBounds.union(geometryBounds.clone().applyMatrix4(relativeMatrix));
    hasMeshBounds = true;
  });
  return hasMeshBounds && !localBounds.isEmpty() ? localBounds : null;
}

function collectAuraEntries(root) {
  if (!root || typeof root.traverse !== 'function') return [];
  const entries = [];
  const seen = new Set();
  root.traverse((target) => {
    const aura = getStoredAura(target);
    if (!aura || seen.has(aura)) return;
    seen.add(aura);
    entries.push({ target, aura });
  });
  return entries;
}

function applyParamsToAura(aura, params = {}) {
  const uniforms = aura?.children?.[0]?.material?.uniforms;
  if (!uniforms) return;

  setColor(uniforms.uFlameAuraInnerColor.value, params.innerColor);
  setColor(uniforms.uFlameAuraOuterColor.value, params.outerColor);
  for (const [name, uniformName] of Object.entries(NUMERIC_UNIFORMS)) {
    if (isFiniteNumber(params[name])) uniforms[uniformName].value = params[name];
  }
  if (!isFiniteNumber(params.noiseScale) && isFiniteNumber(params.scale)) {
    uniforms.uFlameAuraScale.value = params.scale;
  }

  if (isFiniteNumber(params.sizeMultiplier) && params.sizeMultiplier > 0) {
    const baseSize = aura.userData.flameAuraBaseSize;
    if (Array.isArray(baseSize)) {
      aura.scale.set(
        baseSize[0] * params.sizeMultiplier,
        baseSize[1] * params.sizeMultiplier,
        baseSize[0] * params.sizeMultiplier,
      );
      aura.userData.flameAuraSizeMultiplier = params.sizeMultiplier;
    }
  }
}

function makeMaterial(params) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFlameAuraInnerColor: { value: new THREE.Color(...params.innerColor) },
      uFlameAuraOuterColor: { value: new THREE.Color(...params.outerColor) },
      uFlameAuraIntensity: { value: params.intensity },
      uFlameAuraSpeed: { value: params.speed },
      uFlameAuraScale: { value: params.noiseScale },
      uFlameAuraThreshold: { value: params.threshold },
      uFlameAuraAlpha: { value: params.alpha },
      uFlameAuraSeed: { value: 0 },
      uFlameAuraLayer: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

export function createFlameAuraForObject(target, options = {}) {
  if (!target || typeof target.traverse !== 'function' || typeof target.add !== 'function') return null;

  const existing = getStoredAura(target);
  if (existing) {
    applyParamsToAura(existing, options);
    return existing;
  }

  const bounds = computeLocalMeshBounds(target);
  if (!bounds) return null;

  const localCenter = bounds.getCenter(new THREE.Vector3());
  const localSize = bounds.getSize(new THREE.Vector3());
  const baseWidth = Math.max(localSize.x, localSize.z, 0.05);
  const baseHeight = Math.max(localSize.y, 0.05);
  const params = {
    ...DEFAULT_FLAME_AURA_PARAMS,
    ...options,
    innerColor: isColorArray(options.innerColor) ? options.innerColor : DEFAULT_FLAME_AURA_PARAMS.innerColor,
    outerColor: isColorArray(options.outerColor) ? options.outerColor : DEFAULT_FLAME_AURA_PARAMS.outerColor,
    noiseScale: isFiniteNumber(options.noiseScale)
      ? options.noiseScale
      : (isFiniteNumber(options.scale) ? options.scale : DEFAULT_FLAME_AURA_PARAMS.noiseScale),
  };
  for (const name of [...Object.keys(NUMERIC_UNIFORMS), 'sizeMultiplier']) {
    if (!isFiniteNumber(params[name])) params[name] = DEFAULT_FLAME_AURA_PARAMS[name];
  }
  if (params.sizeMultiplier <= 0) params.sizeMultiplier = DEFAULT_FLAME_AURA_PARAMS.sizeMultiplier;

  const group = new THREE.Group();
  markCompanionObject(group);
  group.renderOrder = RENDER_ORDER.EFFECTS;
  group.position.copy(localCenter);
  group.scale.set(
    baseWidth * params.sizeMultiplier,
    baseHeight * params.sizeMultiplier,
    baseWidth * params.sizeMultiplier,
  );
  group.userData.flameAuraBaseSize = [baseWidth, baseHeight];
  group.userData.flameAuraSizeMultiplier = params.sizeMultiplier;

  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = makeMaterial(params);
  for (let index = 0; index < 2; index += 1) {
    const plane = new THREE.Mesh(geometry, material);
    plane.scale.set(index === 0 ? 1.48 : 1.08, index === 0 ? 1.34 : 1.18, 1);
    plane.position.y = index === 0 ? 0.16 : 0.1;
    plane.position.z = index === 0 ? 0.018 : 0.026;
    plane.userData.flameAuraSeed = index * 19.37;
    plane.userData.flameAuraLayer = index;
    plane.onBeforeRender = () => {
      material.uniforms.uFlameAuraSeed.value = plane.userData.flameAuraSeed;
      material.uniforms.uFlameAuraLayer.value = plane.userData.flameAuraLayer;
    };
    markCompanionObject(plane);
    group.add(plane);
  }

  target.add(group);
  if (!target.userData) target.userData = {};
  if (!target.userData.companionEffects) target.userData.companionEffects = {};
  target.userData.companionEffects[EFFECT_NAME] = group;
  return group;
}

export function updateFlameAuraParams(targetOrRoot, params = {}) {
  const entries = collectAuraEntries(targetOrRoot);
  for (const { aura } of entries) applyParamsToAura(aura, params);
  return entries.length;
}

export function clearFlameAuraFromObject(target) {
  const aura = getStoredAura(target);
  if (!aura) return false;

  const geometries = new Set();
  const materials = new Set();
  aura.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) {
      if (material) materials.add(material);
    }
  });
  if (aura.parent && typeof aura.parent.remove === 'function') aura.parent.remove(aura);
  for (const geometry of geometries) geometry.dispose?.();
  for (const material of materials) material.dispose?.();

  const effects = target.userData.companionEffects;
  delete effects[EFFECT_NAME];
  if (Object.keys(effects).length === 0) delete target.userData.companionEffects;
  return true;
}

export function clearFlameAuraFromRoot(root) {
  const entries = collectAuraEntries(root);
  let cleared = 0;
  for (const { target } of entries) {
    if (clearFlameAuraFromObject(target)) cleared += 1;
  }
  return cleared;
}

export function tickFlameAura(root, time, camera) {
  const entries = collectAuraEntries(root);
  for (const { target, aura } of entries) {
    const uniforms = aura.children[0]?.material?.uniforms;
    if (uniforms?.uTime) uniforms.uTime.value = time;
    if (camera && typeof camera.getWorldPosition === 'function' && typeof target.worldToLocal === 'function') {
      const localCamera = camera.getWorldPosition(new THREE.Vector3());
      target.worldToLocal(localCamera);
      localCamera.sub(aura.position);
      aura.rotation.y = Math.atan2(localCamera.x, localCamera.z);
    }
  }
  return entries.length;
}

export function getFlameAuraStats(root) {
  const entries = collectAuraEntries(root);
  let planeCount = 0;
  for (const { aura } of entries) {
    aura.traverse((object) => {
      if (object.isMesh && object.userData?.isFlameAura === true) planeCount += 1;
    });
  }
  return {
    targetCount: entries.length,
    auraCount: entries.length,
    planeCount,
    estimatedDrawCalls: planeCount,
  };
}
