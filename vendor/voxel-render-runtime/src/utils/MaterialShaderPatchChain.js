// Composable onBeforeCompile / customProgramCacheKey patch chain for Three.js materials.
//
// Multiple systems (CSM shadows, ShaderLibrary toon/PBR overlay, debug visualizations, ...)
// each want to mutate the compiled shader of the same material via `onBeforeCompile`.
// Three.js only allows a single `onBeforeCompile` function per material, so naive
// `material.onBeforeCompile = fn` assignments stomp on each other. This module installs
// a single dispatcher on the material that runs all registered patches in `order`.

const materialChainState = new WeakMap();
// Separate from removable chain state so an empty-chain remove -> reinstall still advances.
const materialPatchGenerations = new WeakMap();

function nextPatchGeneration(material, key) {
  let generations = materialPatchGenerations.get(material);
  if (!generations) {
    generations = new Map();
    materialPatchGenerations.set(material, generations);
  }
  const generation = (generations.get(key) || 0) + 1;
  generations.set(key, generation);
  return generation;
}

function installChain(material) {
  const originalOnBeforeCompile = material.onBeforeCompile;
  const originalCustomProgramCacheKey = material.customProgramCacheKey;
  material.userData.shaderPatchChain = [];

  const dispatcher = function (shader, renderer) {
    const chain = material.userData.shaderPatchChain || [];
    for (const item of chain) {
      item.patchFn(shader, renderer, material);
    }
  };

  const cacheKeyDispatcher = function () {
    const chain = material.userData.shaderPatchChain || [];
    return chain
      .map((item) => {
        const baseKey = typeof item.cacheKeyFn === 'function' ? item.cacheKeyFn() : item.key;
        return `${baseKey}#g${item.generation}`;
      })
      .join('|');
  };

  material.onBeforeCompile = dispatcher;
  material.customProgramCacheKey = cacheKeyDispatcher;
  materialChainState.set(material, {
    originalOnBeforeCompile,
    originalCustomProgramCacheKey,
    dispatcher,
    cacheKeyDispatcher,
  });
}

/**
 * Register (or replace) a shader patch on a material.
 * @param {THREE.Material} material
 * @param {string} key - unique id for this patch; re-registering the same key replaces it
 * @param {(shader, renderer, material) => void} patchFn - runs inside onBeforeCompile
 * @param {object} [options]
 * @param {number} [options.order=0] - lower runs first
 * @param {() => string} [options.cacheKey] - dynamic base fragment; install generation is appended automatically
 */
export function addMaterialShaderPatch(material, key, patchFn, options = {}) {
  if (!material || typeof patchFn !== 'function') return;
  if (!material.userData) material.userData = {};

  if (!materialChainState.has(material)) {
    const reusablePatches = Array.isArray(material.userData.shaderPatchChain)
      ? material.userData.shaderPatchChain.filter(item => typeof item?.patchFn === 'function')
      : [];
    installChain(material);
    material.userData.shaderPatchChain.push(...reusablePatches.map(item => ({
      ...item,
      generation: nextPatchGeneration(material, item.key),
    })));
    material.userData.shaderPatchChain.sort((a, b) => a.order - b.order);
  } else {
    // 所有权自愈：第三方代码可能直接 delete/覆盖 material.onBeforeCompile（实例：
    // three CSM.dispose() 对其 shaders map 里的每个材质 delete onBeforeCompile），
    // dispatcher 被清掉而链状态仍标记"已安装"——此后整条链（csm/cel/rim/matcap）
    // 静默失效。重新挂 patch 时检测并装回，warn 以便暴露肇事方。
    const state = materialChainState.get(material);
    if (material.onBeforeCompile !== state.dispatcher) {
      console.warn('[MaterialShaderPatchChain] dispatcher 被外部覆盖后重装 — 该材质补丁链曾静默失效', material.type);
      material.onBeforeCompile = state.dispatcher;
    }
    if (material.customProgramCacheKey !== state.cacheKeyDispatcher) {
      material.customProgramCacheKey = state.cacheKeyDispatcher;
    }
  }

  const order = options.order ?? 0;
  const cacheKeyFn = typeof options.cacheKey === 'function' ? options.cacheKey : null;
  const chain = material.userData.shaderPatchChain;
  const existingIndex = chain.findIndex(item => item.key === key);
  const generation = nextPatchGeneration(material, key);
  const patch = { key, order, patchFn, cacheKeyFn, generation };

  if (existingIndex >= 0) {
    chain[existingIndex] = patch;
  } else {
    chain.push(patch);
  }
  chain.sort((a, b) => a.order - b.order);

  material.needsUpdate = true;
}

export function removeMaterialShaderPatch(material, key) {
  const chain = material?.userData?.shaderPatchChain;
  if (!Array.isArray(chain)) return false;
  const index = chain.findIndex(item => item.key === key);
  if (index < 0) return false;

  chain.splice(index, 1);
  if (chain.length === 0) {
    const state = materialChainState.get(material);
    if (state) {
      if (material.onBeforeCompile === state.dispatcher) {
        material.onBeforeCompile = state.originalOnBeforeCompile;
      }
      if (material.customProgramCacheKey === state.cacheKeyDispatcher) {
        material.customProgramCacheKey = state.originalCustomProgramCacheKey;
      }
    }
    delete material.userData.shaderPatchChain;
    materialChainState.delete(material);
  }
  material.needsUpdate = true;
  return true;
}

export function hasMaterialShaderPatch(material, key) {
  return materialChainState.has(material)
    && !!material?.userData?.shaderPatchChain?.some(item => item.key === key);
}

export function listMaterialShaderPatches(material) {
  return (material?.userData?.shaderPatchChain || []).map(item => item.key);
}
