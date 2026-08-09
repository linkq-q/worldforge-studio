/**
 * ComplexMaterialOverrideRuntime — execution layer of the hybrid render cache.
 *
 * Applies a complex material (emissive / glass / transparent / shader category /
 * FresnelRim effect layer / matcap / textures) to an INDEPENDENT Mesh that has
 * left its shared InstancedMesh batch (an "extracted" or "fallback" part).
 *
 * Pure module: every collaborator is injected, so it unit-tests in Node with
 * mocks and never imports THREE or touches the DOM.
 *   - getShaderLibrary() → ShaderLibrary (setCategory / getMesh)
 *   - getEffectRuntime() → EffectPackageRuntime (applyToObject3D)
 *   - matcapManager      → MatcapSystem (setObjectMatcap)
 *   - resolveTexture(url) → Promise<Texture>
 *
 * It is the EXECUTION layer only. The decision of WHICH part to extract and when
 * to apply this belongs to MaterialOverrideController (Task 5). This runtime is
 * told "apply this material to this independent mesh" and does exactly that —
 * always cloning the material first so the shared batch material is never mutated.
 */

const SHADER_MODES = new Set(['default', 'cartoon']);
// Mirrors ShaderLibrary.SHADER_CATEGORIES (building / glass / default). Extend
// here AND in ShaderLibrary if new assignable categories (e.g. ground/emissive)
// are added. Emissive glow itself uses the standard material.emissive field,
// not a shader category, so it needs no entry here.
const SHADER_CATEGORIES = new Set(['building', 'glass', 'default']);
const TEXTURE_FIELDS = ['map', 'alphaMap', 'normalMap', 'bumpMap'];

function materialsOf(object) {
  return Array.isArray(object.material) ? object.material : [object.material];
}

/** Clone the object's material(s) once so edits never touch the shared batch material. */
function cloneMaterials(object) {
  if (object.userData?.complexMaterialIsolated === true) return;
  object.material = Array.isArray(object.material)
    ? object.material.map(material => material.clone())
    : object.material.clone();
  object.userData ||= {};
  object.userData.complexMaterialIsolated = true;
}

function writeUniform(uniform, value) {
  if (!uniform) return false;
  if (uniform.value?.isColor || typeof uniform.value?.set === 'function') uniform.value.set(value);
  else uniform.value = value;
  return true;
}

export class ComplexMaterialOverrideRuntime {
  constructor(options = {}) {
    this.getShaderLibrary = options.getShaderLibrary || (() => null);
    this.getEffectRuntime = options.getEffectRuntime || (() => null);
    this.matcapManager = options.matcapManager || null;
    this.resolveTexture = options.resolveTexture || null;
  }

  /**
   * @param {object} object — an independent (non-instanced) Mesh
   * @param {object} override — material override descriptor
   * @returns {Promise<{ok:boolean, reason?:string, applied?:string[]}>}
   */
  async apply(object, override = {}) {
    if (!object?.isMesh || object.isInstancedMesh) return { ok: false, reason: 'independent-mesh-required' };

    // ── Validate schema BEFORE cloning/mutating so a bad override is a no-op ──
    const shader = override.shader || override.shaderPackage;
    if (shader && !SHADER_MODES.has(shader.mode)) return { ok: false, reason: 'unsupported-shader-mode', mode: shader.mode };
    if (shader && !SHADER_CATEGORIES.has(shader.category)) return { ok: false, reason: 'unsupported-shader-category', category: shader.category };
    if (override.effectLayer && override.effectLayer.type !== 'FresnelRim') {
      return { ok: false, reason: 'unsupported-effect-layer', type: override.effectLayer.type };
    }
    if (override.materialLayers && (
      override.materialLayers.length !== 1 || override.materialLayers[0] !== 'FresnelRim'
    )) return { ok: false, reason: 'unsupported-material-layers' };

    cloneMaterials(object);
    const applied = [];

    // ── Shader category (must run before standard fields: ShaderLibrary may
    //    replace object.material) ──
    if (shader) {
      const library = this.getShaderLibrary();
      if (!library) return { ok: false, reason: 'shader-library-unavailable' };
      if (!library.getMesh?.(object.uuid)) return { ok: false, reason: 'shader-target-unregistered' };
      library.setCategory(object.uuid, shader.category, shader.mode);
      for (const mat of materialsOf(object)) {
        const uniforms = mat.userData?.shaderLibraryUniforms
          || mat.userData?.shader?.uniforms
          || mat.userData?.pbrAnimationUniforms
          || mat.uniforms
          || {};
        for (const [name, value] of Object.entries(shader.parameters || {})) {
          if (!writeUniform(uniforms[name], value)) return { ok: false, reason: 'unknown-shader-uniform', uniform: name };
        }
      }
      applied.push('shader');
    }

    // ── Standard PBR fields (after category swap so they survive a replacement) ──
    for (const mat of materialsOf(object)) {
      if (override.color !== undefined) mat.color?.set?.(override.color);
      if (override.transparent !== undefined) mat.transparent = !!override.transparent;
      if (override.opacity !== undefined) mat.opacity = Number(override.opacity);
      if (override.alphaTest !== undefined) mat.alphaTest = Number(override.alphaTest);
      if (override.roughness !== undefined) mat.roughness = Number(override.roughness);
      if (override.metalness !== undefined) mat.metalness = Number(override.metalness);
      if (override.emissive !== undefined) mat.emissive?.set?.(override.emissive);
      if (override.emissiveIntensity !== undefined) mat.emissiveIntensity = Number(override.emissiveIntensity);
      if (override.opacity !== undefined && Number(override.opacity) < 1) mat.transparent = true;
      mat.needsUpdate = true;
    }
    applied.push('material');

    // ── Textures (string URL → resolveTexture, or a ready Texture) ──
    for (const field of TEXTURE_FIELDS) {
      const value = override[field];
      if (value === undefined) continue;
      let texture = value;
      if (!value?.isTexture) {
        if (typeof value !== 'string') return { ok: false, reason: 'invalid-texture-override', field };
        if (!this.resolveTexture) return { ok: false, reason: 'texture-resolver-unavailable', field };
        texture = await this.resolveTexture(value);
      }
      for (const mat of materialsOf(object)) {
        mat[field] = texture;
        mat.needsUpdate = true;
      }
      applied.push(field);
    }

    // ── FresnelRim effect layer (reuse EffectPackageRuntime) ──
    const effect = override.effectLayer;
    const materialLayers = effect ? ['FresnelRim'] : override.materialLayers;
    if (effect || materialLayers) {
      const effectRuntime = this.getEffectRuntime();
      if (!effectRuntime) return { ok: false, reason: 'effect-runtime-unavailable' };
      const params = effect
        ? { color: effect.color, power: effect.power, intensity: effect.intensity }
        : override.layerParams?.FresnelRim || {};
      effectRuntime.applyToObject3D(object, {
        schemaVersion: '1.0',
        materialLayers: ['FresnelRim'],
        layerParams: { FresnelRim: params },
      });
      applied.push('effectLayer');
    }

    // ── Matcap (reuse MatcapSystem) ──
    if (override.matcap) {
      if (!this.matcapManager) return { ok: false, reason: 'matcap-manager-unavailable' };
      this.matcapManager.setObjectMatcap(object, override.matcap);
      applied.push('matcap');
    }

    return { ok: true, applied };
  }
}

export default ComplexMaterialOverrideRuntime;
