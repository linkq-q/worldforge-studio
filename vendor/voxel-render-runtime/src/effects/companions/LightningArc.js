// LightningArc — arc_crackle 环绕电弧 companion（任务书 particle-system-v1 Phase 1）。
// 结构照抄 FlameAura（quad + 程序化 shader + userData.companionEffects 存引用 + 外部 tick）。
// FlameAura 头部注释预约的第二个 companion 就是它；共享 runtime 抽取在 Phase 3（两实例已凑齐）。
// 与 FlameAura 的差异：每块 quad 独立材质实例（uArcSeed 不同,否则旋转复制的弧形一模一样）。
import * as THREE from 'three';
import { RENDER_ORDER } from '../../render/RenderOrders.js';

export const DEFAULT_LIGHTNING_ARC_PARAMS = Object.freeze({
  color: Object.freeze([0.55, 0.75, 1.0]),
  intensity: 1.6,
  speed: 12.0,      // 每秒重掷折线形状的次数
  jitter: 0.35,     // 折线位移幅度（quad 高度比例）
  width: 0.035,     // 弧心宽度
  alpha: 0.9,
  arcCount: 3,      // quad 数量
  sizeMultiplier: 1.25,
});

const EFFECT_NAME = 'LightningArc';
const NUMERIC_UNIFORMS = Object.freeze({
  intensity: 'uArcIntensity',
  speed: 'uArcSpeed',
  jitter: 'uArcJitter',
  width: 'uArcWidth',
  alpha: 'uArcAlpha',
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
uniform vec3 uArcColor;
uniform float uArcIntensity;
uniform float uArcSpeed;
uniform float uArcJitter;
uniform float uArcWidth;
uniform float uArcAlpha;
uniform float uArcSeed;
varying vec2 vUv;

float hash11(float p) {
  return fract(sin(p * 12.9898) * 43758.5453);
}

// 1D value noise：折线路径用
float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  return mix(hash11(i), hash11(i + 1.0), u);
}

void main() {
  // 重掷：uTime 分槽,每槽一个种子 → 折线形状高频跳变（闪电的"噼啪"感,零 CPU）
  float slot = floor(uTime * uArcSpeed);
  float seed = hash11(slot + uArcSeed * 91.7);

  // 这一槽该弧是否出现（间歇性,不是常亮）
  float gate = step(0.35, hash11(seed * 7.31 + uArcSeed));

  float x = vUv.x;
  float path = 0.5
    + (noise1(x * 3.0 + seed * 100.0) - 0.5) * uArcJitter
    + (noise1(x * 9.0 + seed * 300.0) - 0.5) * uArcJitter * 0.5;

  float d = abs(vUv.y - path);
  float core = smoothstep(uArcWidth, 0.0, d);
  float glow = smoothstep(uArcWidth * 4.0, 0.0, d) * 0.4;
  float endFade = smoothstep(0.0, 0.12, x) * smoothstep(1.0, 0.88, x);
  float a = (core + glow) * endFade * gate * uArcAlpha;
  if (a <= 0.001) discard;
  gl_FragColor = vec4(uArcColor * uArcIntensity * (core * 1.5 + glow), a);
}
`;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isColorArray(value) {
  return Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(isFiniteNumber);
}

function markCompanionObject(object) {
  object.isLightningArc = true;
  object.userData.isLightningArc = true;
  object.userData.skipSelection = true;
  object.userData.skipBatching = true;
  object.userData.skipShaderApply = true;
}

function getStoredArc(target) {
  return target?.userData?.companionEffects?.[EFFECT_NAME] || null;
}

function computeLocalMeshBounds(target) {
  if (typeof target.updateWorldMatrix !== 'function' || !target.matrixWorld) return null;
  target.updateWorldMatrix(true, true);
  const inverseTarget = new THREE.Matrix4().copy(target.matrixWorld).invert();
  const localBounds = new THREE.Box3().makeEmpty();
  let hasMeshBounds = false;
  target.traverse((object) => {
    if (!object.isMesh || !object.geometry || object.userData?.isLightningArc === true) return;
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

function collectArcEntries(root) {
  if (!root || typeof root.traverse !== 'function') return [];
  const entries = [];
  const seen = new Set();
  root.traverse((target) => {
    const arc = getStoredArc(target);
    if (!arc || seen.has(arc)) return;
    seen.add(arc);
    entries.push({ target, arc });
  });
  return entries;
}

function makeMaterial(params, seedIndex) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uArcColor: { value: new THREE.Color(...params.color) },
      uArcIntensity: { value: params.intensity },
      uArcSpeed: { value: params.speed },
      uArcJitter: { value: params.jitter },
      uArcWidth: { value: params.width },
      uArcAlpha: { value: params.alpha },
      uArcSeed: { value: seedIndex + 1 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function applyParamsToArc(arc, params = {}) {
  for (const plane of arc.children) {
    const uniforms = plane.material?.uniforms;
    if (!uniforms) continue;
    if (isColorArray(params.color)) uniforms.uArcColor.value.setRGB(params.color[0], params.color[1], params.color[2]);
    for (const [name, uniformName] of Object.entries(NUMERIC_UNIFORMS)) {
      if (isFiniteNumber(params[name])) uniforms[uniformName].value = params[name];
    }
  }
  if (isFiniteNumber(params.sizeMultiplier) && params.sizeMultiplier > 0) {
    const baseSize = arc.userData.lightningArcBaseSize;
    if (Array.isArray(baseSize)) {
      arc.scale.set(
        baseSize[0] * params.sizeMultiplier,
        baseSize[1] * params.sizeMultiplier,
        baseSize[0] * params.sizeMultiplier,
      );
    }
  }
}

export function createLightningArcForObject(target, options = {}) {
  if (!target || typeof target.traverse !== 'function' || typeof target.add !== 'function') return null;

  const existing = getStoredArc(target);
  if (existing) {
    applyParamsToArc(existing, options);
    return existing;
  }

  const bounds = computeLocalMeshBounds(target);
  if (!bounds) return null;

  const localCenter = bounds.getCenter(new THREE.Vector3());
  const localSize = bounds.getSize(new THREE.Vector3());
  const baseWidth = Math.max(localSize.x, localSize.z, 0.05);
  const baseHeight = Math.max(localSize.y, 0.05);
  const params = {
    ...DEFAULT_LIGHTNING_ARC_PARAMS,
    ...options,
    color: isColorArray(options.color) ? options.color : DEFAULT_LIGHTNING_ARC_PARAMS.color,
  };
  for (const name of [...Object.keys(NUMERIC_UNIFORMS), 'sizeMultiplier', 'arcCount']) {
    if (!isFiniteNumber(params[name])) params[name] = DEFAULT_LIGHTNING_ARC_PARAMS[name];
  }

  const group = new THREE.Group();
  markCompanionObject(group);
  group.renderOrder = RENDER_ORDER.EFFECTS;
  group.position.copy(localCenter);
  group.scale.set(
    baseWidth * params.sizeMultiplier,
    baseHeight * params.sizeMultiplier,
    baseWidth * params.sizeMultiplier,
  );
  group.userData.lightningArcBaseSize = [baseWidth, baseHeight];

  const geometry = new THREE.PlaneGeometry(1, 1);
  const count = Math.max(1, Math.min(4, Math.round(params.arcCount)));
  for (let index = 0; index < count; index += 1) {
    const plane = new THREE.Mesh(geometry, makeMaterial(params, index));
    plane.rotation.y = index * Math.PI / count;
    plane.rotation.z = (index % 2 === 0 ? 1 : -1) * 0.2;
    markCompanionObject(plane);
    group.add(plane);
  }

  target.add(group);
  if (!target.userData) target.userData = {};
  if (!target.userData.companionEffects) target.userData.companionEffects = {};
  target.userData.companionEffects[EFFECT_NAME] = group;
  return group;
}

export function updateLightningArcParams(targetOrRoot, params = {}) {
  const entries = collectArcEntries(targetOrRoot);
  for (const { arc } of entries) applyParamsToArc(arc, params);
  return entries.length;
}

export function clearLightningArcFromObject(target) {
  const arc = getStoredArc(target);
  if (!arc) return false;

  const geometries = new Set();
  const materials = new Set();
  arc.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) {
      if (material) materials.add(material);
    }
  });
  if (arc.parent && typeof arc.parent.remove === 'function') arc.parent.remove(arc);
  for (const geometry of geometries) geometry.dispose?.();
  for (const material of materials) material.dispose?.();

  const effects = target.userData.companionEffects;
  delete effects[EFFECT_NAME];
  if (Object.keys(effects).length === 0) delete target.userData.companionEffects;
  return true;
}

export function clearLightningArcFromRoot(root) {
  const entries = collectArcEntries(root);
  let cleared = 0;
  for (const { target } of entries) {
    if (clearLightningArcFromObject(target)) cleared += 1;
  }
  return cleared;
}

export function tickLightningArc(root, time) {
  const entries = collectArcEntries(root);
  for (const { arc } of entries) {
    for (const plane of arc.children) {
      const uniforms = plane.material?.uniforms;
      if (uniforms?.uTime) uniforms.uTime.value = time;
    }
  }
  return entries.length;
}

export function getLightningArcStats(root) {
  const entries = collectArcEntries(root);
  let planeCount = 0;
  for (const { arc } of entries) {
    arc.traverse((object) => {
      if (object.isMesh && object.userData?.isLightningArc === true) planeCount += 1;
    });
  }
  return { targetCount: entries.length, arcCount: entries.length, planeCount };
}
