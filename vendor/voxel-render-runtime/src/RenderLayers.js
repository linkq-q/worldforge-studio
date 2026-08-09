import { shouldSkipShaderApply } from './utils/ShaderApplyGuard.js';

/**
 * Three.js layer index reserved for objects that should receive bloom.
 * Layer 0 is the default (all cameras see it). BLOOM_LAYER = 1 is invisible
 * to the main camera by default; v2 bloomComposer will enable it explicitly.
 * Ref: docs/tasks/selective-bloom.md
 */
export const BLOOM_LAYER = 1;

function hasEmissiveGlow(material) {
  if (!material) return false;
  const mats = Array.isArray(material) ? material : [material];
  return mats.some(mat => {
    // 必须同时满足：emissive 非黑 且 intensity > 0。MeshStandardMaterial 默认
    // emissiveIntensity=1（emissive 黑），旧的 `nonBlack || hasIntensity` 会把
    // 所有标准材质标上 BLOOM_LAYER——selective 黑化退化为 no-op（2026-07-17 实测 70/70 全标）。
    const emissive = mat.emissive;
    const nonBlack = !!emissive && (emissive.r > 0 || emissive.g > 0 || emissive.b > 0);
    if (!nonBlack) return false;
    const intensity = typeof mat.emissiveIntensity === 'number' ? mat.emissiveIntensity : 1;
    return intensity > 0;
  });
}

/**
 * Traverse modelsRoot and enable/disable BLOOM_LAYER on each mesh based on
 * whether its material is emissive or mesh.userData.forceBloom === true.
 *
 * Only processes isMesh objects not excluded by shouldSkipShaderApply
 * (gizmos, sky, water, helpers, editor objects are all skipped).
 * Must NOT be called with the raw scene — pass the user-content root only.
 *
 * @param {object} modelsRoot - Three.js Object3D (or scene) containing user models
 * @returns {{ traversed: number, enabled: number, disabled: number }}
 */
export function markBloomObjects(modelsRoot) {
  const result = { traversed: 0, enabled: 0, disabled: 0 };
  if (!modelsRoot?.traverse) return result;

  modelsRoot.traverse(object => {
    if (!object.isMesh) return;
    if (shouldSkipShaderApply(object)) return;

    result.traversed++;
    const shouldBloom = hasEmissiveGlow(object.material)
      || object.userData?.forceBloom === true
      || object.userData?.effectForceBloom === true;

    if (shouldBloom) {
      object.layers.enable(BLOOM_LAYER);
      result.enabled++;
    } else {
      object.layers.disable(BLOOM_LAYER);
      result.disabled++;
    }
  });

  return result;
}

/**
 * Return (and console.log) the names of all meshes currently on BLOOM_LAYER.
 * May be exposed by the consumer's debug API for browser verification.
 *
 * @param {object} root - same root passed to markBloomObjects
 * @returns {string[]}
 */
export function listBloomObjects(root) {
  const names = [];
  if (!root?.traverse) return names;

  root.traverse(object => {
    if (!object.isMesh) return;
    if (object.layers?.isEnabled?.(BLOOM_LAYER)) {
      names.push(object.name || `(unnamed ${object.uuid?.slice(0, 8) ?? ''})`);
    }
  });

  console.log('[RenderLayers] BLOOM_LAYER objects:', names);
  return names;
}
