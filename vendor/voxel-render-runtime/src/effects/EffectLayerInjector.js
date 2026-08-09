/**
 * EffectLayerInjector.js — Effect Layer → 材质 GLSL 注入器（任务书 #02）
 *
 * 职责：把一个真实 EffectLayer 的 uniform 声明 / vertex body / fragment body 注入到 three 材质。
 *   - 复用 src/utils/MaterialShaderPatchChain.js（项目统一 patch chain），**不裸写 onBeforeCompile**。
 *   - 提供统一 varying 服务：世界空间位置/法线，以及稳定附着于模型的局部位置，
 *     供 Layer 在 fragment 消费（FresnelRim 即依赖之）。
 *   - 幂等：同一 material 同一 layer 只注入一次 patch；重复 apply 只更新 uniform.value，不重 patch / 不重编译。
 *   - 跳过规则：非 mesh / 无 material / gizmo / helper / 环境 / 水面 / 后处理 / 显式 skip 标记。
 *
 * 本文件**允许 import three**（真实注入层），与协议层（EffectLayer/LayerRegistry/manifest）解耦。
 *
 * 注入点（针对 MeshStandardMaterial / MeshPhysicalMaterial 等标准材质）：
 *   - varying 声明：vertex + fragment 的 `#include <common>` 后
 *   - 世界坐标计算：vertex 的 `#include <begin_vertex>` 后（transformed/objectNormal 就绪）
 *   - 可选法线 body：fragment 的 `#include <normal_fragment_maps>` 后（normal map 后、光照前）
 *   - uniform 声明 + fragment body：fragment 的 `#include <tonemapping_fragment>` 前（光照后、tonemapping 前）
 *   找不到 fragment 锚点的材质 → 安全跳过，不抛错、不破坏渲染。
 */

import * as THREE from 'three';
import {
  addMaterialShaderPatch,
  removeMaterialShaderPatch,
  hasMaterialShaderPatch,
} from '../utils/MaterialShaderPatchChain.js';
import { FresnelRimLayer } from './layers/FresnelRimLayer.js';

// 注入锚点
const COMMON_INCLUDE = '#include <common>';
const BEGIN_VERTEX_INCLUDE = '#include <begin_vertex>';
const NORMAL_MAPS_INCLUDE = '#include <normal_fragment_maps>';
const FRAGMENT_ANCHOR = '#include <tonemapping_fragment>';

// 世界空间 varying（唯一名，防与 three core `vWorldPosition` / ShaderLibrary `vShaderLibWorldPosition` 撞名）
const V_WORLD_POS = 'vEffLayerWorldPos';
const V_WORLD_NORMAL = 'vEffLayerWorldNormal';
const V_LOCAL_POS = 'vEffLayerLocalPos';
const U_BOUNDS_MIN = 'uEffLayerBoundsMin';
const U_BOUNDS_SIZE = 'uEffLayerBoundsSize';
const U_OBJECT_PHASE = 'uEffLayerObjectPhase';

// patch order：> ShaderLibrary pbrOverlay(100)，确保 FresnelRim 的 gl_FragColor 叠加在 cartoon 覆写之后
function patchOrderForStage(stage) {
  return stage === 'base' || stage === 'surface' ? 50 : 200;
}

// Variant 已包含 stylization 阶段后的组合 shader，固定在 ShaderLibrary 覆写之后。
const EFFECT_LAYER_PATCH_ORDER = 200;

function ensureObjectUniforms(uniforms) {
  if (!uniforms[U_BOUNDS_MIN]) uniforms[U_BOUNDS_MIN] = { value: new Float32Array(3) };
  if (!uniforms[U_BOUNDS_SIZE]) uniforms[U_BOUNDS_SIZE] = { value: new Float32Array([1, 1, 1]) };
  if (!uniforms[U_OBJECT_PHASE]) uniforms[U_OBJECT_PHASE] = { value: 0 };
  return uniforms;
}

function objectPhase(object) {
  const text = String(object?.userData?.nodeId || object?.userData?.partId || object?.name || object?.uuid || 'effect');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967295;
}

function updateObjectUniforms(object, uniforms) {
  if (!object?.geometry || !uniforms) return;
  if (!object.geometry.boundingBox) object.geometry.computeBoundingBox?.();
  const bounds = object.geometry.boundingBox;
  if (bounds && !bounds.isEmpty()) {
    const min = uniforms[U_BOUNDS_MIN]?.value;
    const size = uniforms[U_BOUNDS_SIZE]?.value;
    if (min && size) {
      min[0] = bounds.min.x;
      min[1] = bounds.min.y;
      min[2] = bounds.min.z;
      size[0] = bounds.max.x - bounds.min.x;
      size[1] = bounds.max.y - bounds.min.y;
      size[2] = bounds.max.z - bounds.min.z;
    }
  }
  if (uniforms[U_OBJECT_PHASE]) uniforms[U_OBJECT_PHASE].value = objectPhase(object);
}

function patchKey(layerId) {
  return `effectLayer:${layerId}`;
}

/**
 * 判断一个 object3D 是否应被注入跳过（brief §6.1）。
 * @returns {string|null} 跳过原因（字符串）或 null（不跳过）
 */
export function getSkipReason(object) {
  if (!object) return 'null object';
  if (!object.isMesh) return 'not a mesh';
  if (!object.material) return 'no material';
  const ud = object.userData || {};
  if (ud.skipShaderApply === true) return 'userData.skipShaderApply';
  if (ud.skipEffectLayer === true) return 'userData.skipEffectLayer';
  if (ud.isHelper === true || ud.isHelperRoot === true) return 'helper object';
  if (ud.isEnvironment === true || ud.isEnvironmentObject === true) return 'environment object';
  if (ud.isWater === true || ud.isWaterSurface === true) return 'water surface';
  if (ud.isPostProcess === true) return 'post-process material';
  // TransformControls / gizmo：类型名兜底（其整树已被打 skipShaderApply，这里双保险）
  const type = object.type || '';
  if (type.includes('TransformControls') || type === 'GizmoMaterial') return 'transform controls / gizmo';
  return null;
}

/**
 * 单个 material 是否应跳过（独立于 object，供数组材质逐个判断）。
 * @returns {string|null}
 */
function getMaterialSkipReason(material) {
  if (!material) return 'no material';
  if (material.userData?.skipEffectLayer === true) return 'material.userData.skipEffectLayer';
  // 只支持带标准片元锚点的材质（MeshStandard/Physical）。ShaderMaterial/RawShaderMaterial 无锚点 → 跳过。
  if (material.isShaderMaterial || material.isRawShaderMaterial) return 'ShaderMaterial has no standard anchor';
  if (material.isMeshBasicMaterial) return 'MeshBasicMaterial (likely helper/pivot)';
  return null;
}

/**
 * 构造注入 patchFn。捕获 layer + 稳定的 uniformsObj（引用共享，供运行时调参）。
 */
function makePatchFn(layer, uniformsObj) {
  const uniformDecls = layer.getUniformDeclarations();
  const vertexBody = layer.getVertexBody();
  const normalBody = layer.getNormalBody?.() || '';
  const fragmentBody = layer.getFragmentBody();

  return function patchFn(shader, _renderer, material) {
    // 锚点缺失 → 不动 shader，标记跳过原因（防止破坏非标准材质）
    if (!shader.fragmentShader.includes(FRAGMENT_ANCHOR)) {
      const entry = material.userData?.effectLayers?.[layer.id];
      if (entry) entry.skipped = 'no <tonemapping_fragment> anchor in fragment shader';
      return;
    }
    if (normalBody && !shader.fragmentShader.includes(NORMAL_MAPS_INCLUDE)) {
      const entry = material.userData?.effectLayers?.[layer.id];
      if (entry) entry.skipped = 'no <normal_fragment_maps> anchor in fragment shader';
      return;
    }

    // 1) 注入 uniform 引用（引用共享，运行时改 value 即生效）
    Object.assign(shader.uniforms, uniformsObj);

    // 调试：暴露编译后的 shader（layer 专属 key，避免与 ShaderLibrary 的 userData.shader 冲突）
    const dbgEntry = material.userData?.effectLayers?.[layer.id];
    if (dbgEntry) dbgEntry.shaderRef = shader;

    // 2) varying 声明（vertex + fragment）
    shader.vertexShader = shader.vertexShader.replace(
      COMMON_INCLUDE,
      `${COMMON_INCLUDE}\nvarying vec3 ${V_WORLD_POS};\nvarying vec3 ${V_WORLD_NORMAL};\nvarying vec3 ${V_LOCAL_POS};`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      COMMON_INCLUDE,
      `${COMMON_INCLUDE}\nvarying vec3 ${V_WORLD_POS};\nvarying vec3 ${V_WORLD_NORMAL};\nvarying vec3 ${V_LOCAL_POS};\n${uniformDecls}`
    );

    // 3) 世界空间计算（vertex，begin_vertex 后；transformed + objectNormal 就绪）
    //    + Layer 自定义 vertex body（FresnelRim 为空）
    const worldCalc = `${BEGIN_VERTEX_INCLUDE}
${V_WORLD_POS} = (modelMatrix * vec4(transformed, 1.0)).xyz;
${V_WORLD_NORMAL} = mat3(modelMatrix) * objectNormal;
${V_LOCAL_POS} = transformed;${vertexBody ? `\n${vertexBody}` : ''}`;
    shader.vertexShader = shader.vertexShader.replace(BEGIN_VERTEX_INCLUDE, worldCalc);

    // 4) 可选法线 body（normal map 后、光照前）
    if (normalBody) {
      shader.fragmentShader = shader.fragmentShader.replace(
        NORMAL_MAPS_INCLUDE,
        `${NORMAL_MAPS_INCLUDE}\n${normalBody}`
      );
    }

    // 5) fragment body（tonemapping 前，光照后）
    shader.fragmentShader = shader.fragmentShader.replace(
      FRAGMENT_ANCHOR,
      `${fragmentBody}\n${FRAGMENT_ANCHOR}`
    );
  };
}

/**
 * 把一个 EffectLayer 注入单个 material。
 *
 * @param {THREE.Material} material
 * @param {EffectLayer} layer - 必须实现 getUniformDeclarations/getVertexBody/getFragmentBody/getThreeUniforms
 * @param {object} [options]
 * @param {object} [options.uniforms] - 覆盖默认 uniform 值 { color:[r,g,b], power, intensity }
 * @returns {{applied:boolean, reason?:string, updated?:boolean}}
 */
export function applyEffectLayerToMaterial(material, layer, options = {}) {
  const matSkip = getMaterialSkipReason(material);
  if (matSkip) return { applied: false, reason: matSkip };

  if (!material.userData) material.userData = {};
  material.userData.effectLayers = material.userData.effectLayers || {};

  const existing = material.userData.effectLayers[layer.id];

  // 幂等：已注入 → 只更新 uniform 值，不重 patch、不重编译
  if (existing && existing.applied && hasMaterialShaderPatch(material, patchKey(layer.id))) {
    if (options.uniforms) updateLayerUniforms(material, layer.id, options.uniforms);
    return { applied: true, updated: true };
  }

  // 首次注入：建稳定 uniformsObj（引用共享给 shader），存入 userData 供调参 / 重编译复用
  const uniformsObj = ensureObjectUniforms(layer.getThreeUniforms(THREE, options.uniforms || {}));
  material.userData.effectLayers[layer.id] = {
    applied: true,
    layer,
    uniforms: uniformsObj,
    skipped: null,
  };

  addMaterialShaderPatch(
    material,
    patchKey(layer.id),
    makePatchFn(layer, uniformsObj),
    { order: patchOrderForStage(layer.stage), cacheKey: () => `${patchKey(layer.id)}:v1` }
  );

  return { applied: true, updated: false };
}

/**
 * 遍历 root，对每个合格 mesh 的材质注入 layer。跳过 gizmo/helper/环境/水面/后处理等。
 *
 * @param {THREE.Object3D} root
 * @param {EffectLayer} layer
 * @param {object} [options]
 * @returns {{appliedMaterials:number, skipped:Array<{name:string, reason:string}>}}
 */
export function applyEffectLayerToObject3D(root, layer, options = {}) {
  const result = { appliedMaterials: 0, skipped: [] };
  if (!root) return result;

  root.traverse((object) => {
    const skip = getSkipReason(object);
    if (skip) {
      // 只记录"看起来本该是模型却被跳过"的 mesh，避免日志噪声
      if (object.isMesh) result.skipped.push({ name: object.name || object.type, reason: skip });
      return;
    }
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      const r = applyEffectLayerToMaterial(material, layer, options);
      if (r.applied) {
        updateObjectUniforms(object, material.userData?.effectLayers?.[layer.id]?.uniforms);
        result.appliedMaterials += 1;
      }
      else result.skipped.push({ name: object.name || object.type, reason: r.reason });
    }
  });

  return result;
}

/**
 * 运行时更新已注入 layer 的 uniform 值（不重编译）。
 * @param {THREE.Material} material
 * @param {string} layerId
 * @param {object} values - { color:[r,g,b], power, intensity }（部分字段可省略）
 * @returns {boolean} 是否更新成功
 */
export function updateLayerUniforms(material, layerId, values = {}) {
  const entry = material?.userData?.effectLayers?.[layerId];
  if (!entry || !entry.uniforms) return false;
  const names = FresnelRimLayer.UNIFORM_NAMES; // FresnelRim 专用映射；多 layer 时可按 layerId 分派
  const u = entry.uniforms;
  if (values.color && u[names.color]) {
    u[names.color].value.setRGB(values.color[0], values.color[1], values.color[2]);
  }
  if (typeof values.power === 'number' && u[names.power]) u[names.power].value = values.power;
  if (typeof values.intensity === 'number' && u[names.intensity]) u[names.intensity].value = values.intensity;
  return true;
}

/**
 * 移除某 material 上的 layer 注入（reset 预留接口）。
 * TODO(#03+): 完整 reset 还应恢复被该 layer 改写的 shader 文本缓存；当前依赖重编译生成干净 shader。
 * @param {THREE.Material} material
 * @param {string} layerId
 */
export function removeEffectLayerFromMaterial(material, layerId) {
  removeMaterialShaderPatch(material, patchKey(layerId));
  if (material?.userData?.effectLayers?.[layerId]) {
    delete material.userData.effectLayers[layerId];
  }
  material.needsUpdate = true; // 强制重编译 → 拿回未注入的干净 shader
}

/**
 * 遍历 root 移除某 layer（reset 预留）。
 * @param {THREE.Object3D} root
 * @param {string} layerId
 */
export function removeEffectLayerFromObject3D(root, layerId) {
  if (!root) return;
  root.traverse((object) => {
    if (!object.isMesh || !object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) removeEffectLayerFromMaterial(material, layerId);
  });
}

/**
 * 诊断：返回单个 material 的注入信息（供 debug API printSelectedMaterialInfo 使用）。
 * @param {THREE.Material} material
 * @param {string} [layerId='FresnelRim']
 */
export function describeMaterialInjection(material, layerId = 'FresnelRim') {
  if (!material) return { error: 'no material' };
  const entry = material.userData?.effectLayers?.[layerId];
  const shader = entry?.shaderRef || material.userData?.shader;
  return {
    type: material.type,
    hasOnBeforeCompile: typeof material.onBeforeCompile === 'function',
    hasShaderPatchChain: Array.isArray(material.userData?.shaderPatchChain),
    hasEffectLayers: !!material.userData?.effectLayers,
    hasLayer: !!entry,
    layerApplied: entry?.applied ?? false,
    layerSkipped: entry?.skipped ?? null,
    patchRegistered: hasMaterialShaderPatch(material, patchKey(layerId)),
    materialSkipReason: getMaterialSkipReason(material),
    customProgramCacheKey:
      typeof material.customProgramCacheKey === 'function' ? material.customProgramCacheKey() : null,
    shaderUniformKeys: shader?.uniforms ? Object.keys(shader.uniforms).filter(k => k.startsWith('uFresnelRim')) : [],
  };
}

// ════════════════════════════════════════════════════════════════════════
// 任务书 #03 — EffectVariant 注入（多 Layer 组合 + 缓存复用）
// 策略：一个 material 只允许一个 EffectVariant（patch key 固定 'effectVariant'）。
//       切换 variant 时覆盖旧 patch 并 needsUpdate；相同 variantKey 重复 apply 只更新 uniform。
// 与 #02 单层 API（effectLayer:<id>）正交共存，向后兼容。
// ════════════════════════════════════════════════════════════════════════

const VARIANT_PATCH_KEY = 'effectVariant';

/**
 * 把 descriptor.uniformDefaults（{glslName: value}）转成 three uniform 对象。
 * 启发式：数组 → vec3 颜色（THREE.Color）；数字 → float；布尔 → 原样。
 */
function buildVariantThreeUniforms(uniformDefaults = {}) {
  const out = {};
  for (const [name, value] of Object.entries(uniformDefaults)) {
    if (Array.isArray(value) && value.length === 3) {
      out[name] = { value: new THREE.Color(value[0], value[1], value[2]) };
    } else {
      out[name] = { value };
    }
  }
  return out;
}

function makeVariantPatchFn(descriptor, uniformsObj) {
  const { uniformDeclarations, vertexBody, normalBody = '', fragmentBody, variantKey } = descriptor;
  return function patchFn(shader, _renderer, material) {
    if (!shader.fragmentShader.includes(FRAGMENT_ANCHOR)) {
      const entry = material.userData?.effectVariant;
      if (entry) entry.skipped = 'no <tonemapping_fragment> anchor in fragment shader';
      return;
    }
    if (normalBody && !shader.fragmentShader.includes(NORMAL_MAPS_INCLUDE)) {
      const entry = material.userData?.effectVariant;
      if (entry) entry.skipped = 'no <normal_fragment_maps> anchor in fragment shader';
      return;
    }
    Object.assign(shader.uniforms, uniformsObj);

    const entry = material.userData?.effectVariant;
    if (entry) entry.shaderRef = shader;

    // varying 声明 + uniform 声明。uniformDeclarations 同时注入 vertex + fragment：
    // vertex-displacement 层（如 Foliage 风摆动）需要在顶点着色器里读可调 uniform；未用到的
    // uniform/函数在 vertex 里保留无害（GLSL 允许未用声明，两 shader 是独立编译单元）。
    shader.vertexShader = shader.vertexShader.replace(
      COMMON_INCLUDE,
      `${COMMON_INCLUDE}\nvarying vec3 ${V_WORLD_POS};\nvarying vec3 ${V_WORLD_NORMAL};\nvarying vec3 ${V_LOCAL_POS};\n${uniformDeclarations}`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      COMMON_INCLUDE,
      `${COMMON_INCLUDE}\nvarying vec3 ${V_WORLD_POS};\nvarying vec3 ${V_WORLD_NORMAL};\nvarying vec3 ${V_LOCAL_POS};\n${uniformDeclarations}`
    );

    // 世界空间计算 + 合并的 vertex body
    const worldCalc = `${BEGIN_VERTEX_INCLUDE}
${V_WORLD_POS} = (modelMatrix * vec4(transformed, 1.0)).xyz;
${V_WORLD_NORMAL} = mat3(modelMatrix) * objectNormal;
${V_LOCAL_POS} = transformed;${vertexBody ? `\n${vertexBody}` : ''}`;
    shader.vertexShader = shader.vertexShader.replace(BEGIN_VERTEX_INCLUDE, worldCalc);

    if (normalBody) {
      shader.fragmentShader = shader.fragmentShader.replace(
        NORMAL_MAPS_INCLUDE,
        `${NORMAL_MAPS_INCLUDE}\n${normalBody}`
      );
    }

    // 合并的 fragment body（按 stage 顺序拼接）
    shader.fragmentShader = shader.fragmentShader.replace(
      FRAGMENT_ANCHOR,
      `// effectVariant: ${variantKey}\n${fragmentBody}\n${FRAGMENT_ANCHOR}`
    );
  };
}

/**
 * wool（Triplanar pattern=6）+ frayAmount>0 时把材质切 DoubleSide（D12）：discard 打的洞如果只渲染
 * 正面，洞后面直接透到背景，看起来像蛀洞而非毛发深处。开双面后 TriplanarLayer.getFragmentBody 会
 * 用 gl_FrontFacing 把背面片元压暗，洞里露出的是压暗的邻面/对面内壁。
 *
 * 只在条件成立时前进设置，不成立时不touch——避免覆盖其它原因（比如 Glass）设置的 side。这是特意
 * 放在 injector 里的特判而非新建一条通用 layer→material 属性绑定通道：只有这一个消费者，属于该在
 * "materialBindings 才值得新增抽象"的门槛之下（YAGNI）。
 */
export function applyTriplanarWoolSideOverride(material, descriptor) {
  if (!material) return;
  if (!material.userData) material.userData = {};
  const u = descriptor?.uniformDefaults;
  const enabled = u?.uTriplanarPattern === 6 && (u.uTriplanarFrayAmount || 0) > 0.001;
  const state = material.userData.effectVariantWoolSide;
  if (enabled) {
    if (!state) material.userData.effectVariantWoolSide = { originalSide: material.side };
    if (material.side !== THREE.DoubleSide) {
      material.side = THREE.DoubleSide;
      material.needsUpdate = true;
    }
  } else if (state) {
    if (material.side !== state.originalSide) {
      material.side = state.originalSide;
      material.needsUpdate = true;
    }
    delete material.userData.effectVariantWoolSide;
  }
}

function applyFoliageSideOverride(material, descriptor) {
  const enabled = descriptor?.sortedLayerIds?.includes('Foliage') === true;
  const state = material.userData?.effectVariantFoliageSide;
  if (enabled) {
    if (!state) material.userData.effectVariantFoliageSide = { originalSide: material.side };
    if (material.side !== THREE.DoubleSide) {
      material.side = THREE.DoubleSide;
      material.needsUpdate = true;
    }
  } else if (state) {
    if (material.side !== state.originalSide) {
      material.side = state.originalSide;
      material.needsUpdate = true;
    }
    delete material.userData.effectVariantFoliageSide;
  }
}

function isFrayedWoolDescriptor(descriptor) {
  const u = descriptor?.uniformDefaults;
  return u?.uTriplanarPattern === 6 && (u.uTriplanarFrayAmount || 0) > 0.001;
}

function applyDynamicBoundsCullingOverride(object, descriptor) {
  const dynamicBounds = descriptor?.sortedLayerIds?.includes('VegetationSway') === true;
  const state = object.userData?.effectVariantFrustumCulling;
  if (dynamicBounds) {
    if (!state) object.userData.effectVariantFrustumCulling = { original: object.frustumCulled };
    object.frustumCulled = false;
  } else if (state) {
    object.frustumCulled = state.original;
    delete object.userData.effectVariantFrustumCulling;
  }
}

function coreDescriptorForWool(descriptor) {
  return {
    ...descriptor,
    uniformDefaults: {
      ...descriptor.uniformDefaults,
      uTriplanarFrayAmount: 0,
    },
  };
}

function materialList(material) {
  return Array.isArray(material) ? material : [material];
}

function disposeFurShell(core) {
  const shell = core?.userData?.furShell;
  if (!shell) return false;
  if (shell.parent) shell.parent.remove(shell);
  for (const material of materialList(shell.material)) material?.dispose?.();
  shell.dispose?.();
  delete core.userData.furShell;
  return true;
}

function cloneFurShellMaterials(material) {
  const clones = materialList(material).map((source) => {
    const clone = source.clone();
    removeEffectVariantFromMaterial(clone);
    clone.userData = { ...(clone.userData || {}) };
    delete clone.userData.effectVariantFurCore;
    clone.userData.effectVariantFurShell = true;
    clone.transparent = false;
    clone.depthWrite = true;
    clone.alphaToCoverage = true;
    return clone;
  });
  return Array.isArray(material) ? clones : clones[0];
}

function syncInstancedFurShell(shell) {
  const source = shell?._furShellSource;
  if (!source) return;
  shell.count = source.count;
  shell.instanceMatrix = source.instanceMatrix;
  shell.instanceColor = source.instanceColor;
}

function createFurShell(core, descriptor, shellMaterial) {
  let shell;
  if (core.isInstancedMesh && !core.isBatchedMesh) {
    shell = new THREE.InstancedMesh(
      core.geometry,
      shellMaterial,
      core.instanceMatrix?.count || Math.max(1, core.count || 1),
    );
    shell._furShellSource = core;
    syncInstancedFurShell(shell);
    shell.onBeforeRender = () => syncInstancedFurShell(shell);
  } else if (!core.isBatchedMesh && !core.isSkinnedMesh) {
    shell = new THREE.Mesh(core.geometry, shellMaterial);
  } else {
    for (const material of materialList(shellMaterial)) material?.dispose?.();
    return null;
  }

  shell.name = `${core.name || core.type}:FurShell`;
  shell.castShadow = false;
  shell.receiveShadow = core.receiveShadow;
  // Shader expansion can extend beyond the source geometry bounds.
  shell.frustumCulled = false;
  shell.renderOrder = core.renderOrder + 1;
  shell.layers.mask = core.layers.mask;
  shell.userData.isFurShell = true;
  shell.userData.skipSelection = true;
  shell.userData.skipBatching = true;

  core.add(shell);
  core.userData.furShell = shell;

  for (const material of materialList(shell.material)) {
    const applied = applyEffectVariantToMaterial(material, descriptor);
    if (applied.applied) updateObjectUniforms(shell, material.userData?.effectVariant?.uniforms);
  }
  return shell;
}

/**
 * 把一个 EffectVariantDescriptor 注入单个 material。
 *
 * @param {THREE.Material} material
 * @param {object} descriptor - EffectVariantBuilder.buildVariant() 的输出
 * @returns {{applied:boolean, reason?:string, updated?:boolean, switched?:boolean}}
 */
export function applyEffectVariantToMaterial(material, descriptor) {
  const matSkip = getMaterialSkipReason(material);
  if (matSkip) return { applied: false, reason: matSkip };

  if (!material.userData) material.userData = {};
  applyFoliageSideOverride(material, descriptor);
  applyTriplanarWoolSideOverride(material, descriptor);
  const existing = material.userData.effectVariant;

  // 同 variantKey 已应用 → 只更新 uniform 值，不重 patch / 不重编译
  if (existing && existing.variantKey === descriptor.variantKey
      && hasMaterialShaderPatch(material, VARIANT_PATCH_KEY)) {
    syncVariantUniformValues(existing.uniforms, descriptor.uniformDefaults);
    existing.paramUniformMaps = descriptor.paramUniformMaps;
    return { applied: true, updated: true };
  }

  // 切换到不同 variant：覆盖旧的（patch key 固定，addMaterialShaderPatch 同 key 替换）
  const switched = !!existing && existing.variantKey !== descriptor.variantKey;

  const uniformsObj = ensureObjectUniforms(buildVariantThreeUniforms(descriptor.uniformDefaults));
  // 系统/运行时 uniform（uTime…）：建 float {value:0}，由 runtime 每帧 tick。不在 paramUniformMaps，故调参不动它。
  for (const name of descriptor.runtimeUniforms || []) {
    if (!uniformsObj[name]) uniformsObj[name] = { value: 0 };
  }
  material.userData.effectVariant = {
    variantKey: descriptor.variantKey,
    sortedLayerIds: descriptor.sortedLayerIds,
    uniforms: uniformsObj,
    paramUniformMaps: descriptor.paramUniformMaps,
    runtimeUniforms: descriptor.runtimeUniforms || [],
    skipped: null,
  };

  addMaterialShaderPatch(
    material,
    VARIANT_PATCH_KEY,
    makeVariantPatchFn(descriptor, uniformsObj),
    { order: EFFECT_LAYER_PATCH_ORDER, cacheKey: () => descriptor.variantKey }
  );
  material.needsUpdate = true; // 结构变化 → 重编译

  return { applied: true, updated: false, switched };
}

/** 把 descriptor.uniformDefaults 的新值同步进已有 uniform 对象（不换引用）。 */
function syncVariantUniformValues(uniforms, uniformDefaults = {}) {
  for (const [name, value] of Object.entries(uniformDefaults)) {
    const u = uniforms[name];
    if (!u) continue;
    if (Array.isArray(value) && value.length === 3 && u.value?.setRGB) u.value.setRGB(value[0], value[1], value[2]);
    else u.value = value;
  }
}

/**
 * 遍历 root 注入 variant。复用 #02 的对象级跳过规则（gizmo/helper/环境/水面…）。
 * @returns {{appliedMaterials:number, switched:number, skipped:Array}}
 */
export function applyEffectVariantToObject3D(root, descriptor) {
  const result = { appliedMaterials: 0, switched: 0, skipped: [] };
  if (!root) return result;
  if (typeof root.traverse !== 'function') {
    console.warn('[EffectLayerInjector] applyEffectVariantToObject3D expected THREE.Object3D, got', root);
    return result;
  }
  const targets = [];
  root.traverse((object) => {
    if (object.userData?.isFurShell) return;
    if (object.isMesh) targets.push(object);
  });

  const wantsFurShell = isFrayedWoolDescriptor(descriptor);
  const coreDescriptor = wantsFurShell ? coreDescriptorForWool(descriptor) : descriptor;

  for (const object of targets) {
    const skip = getSkipReason(object);
    if (skip) {
      if (object.isMesh) result.skipped.push({ name: object.name || object.type, reason: skip });
      continue;
    }
    disposeFurShell(object);
    applyDynamicBoundsCullingOverride(object, descriptor);
    const canCreateShell = wantsFurShell && !object.isBatchedMesh && !object.isSkinnedMesh;
    const shellMaterial = canCreateShell ? cloneFurShellMaterials(object.material) : null;
    const materials = materialList(object.material);
    for (const material of materials) {
      if (!material.userData) material.userData = {};
      if (canCreateShell) material.userData.effectVariantFurCore = true;
      else delete material.userData.effectVariantFurCore;
      const r = applyEffectVariantToMaterial(material, canCreateShell ? coreDescriptor : descriptor);
      if (r.applied) {
        updateObjectUniforms(object, material.userData?.effectVariant?.uniforms);
        result.appliedMaterials += 1;
        if (r.switched) result.switched += 1;
      }
      else result.skipped.push({ name: object.name || object.type, reason: r.reason });
    }
    if (canCreateShell) {
      const shell = createFurShell(object, descriptor, shellMaterial);
      if (shell) result.appliedMaterials += materialList(shell.material).length;
    }
  }
  return result;
}

/**
 * 运行时更新 variant 参数（不重编译、不改 variantKey）。
 * @param {THREE.Material} material
 * @param {Object<string,object>} paramsPatch - { layerId: { paramName: value } }
 * @returns {boolean}
 */
export function updateVariantParams(material, paramsPatch = {}) {
  const entry = material?.userData?.effectVariant;
  if (!entry || !entry.uniforms) return false;
  const maps = entry.paramUniformMaps || {};
  for (const [layerId, params] of Object.entries(paramsPatch)) {
    const map = maps[layerId];
    if (!map) continue;
    for (const [paramName, value] of Object.entries(params)) {
      const glslName = map[paramName];
      const u = glslName && entry.uniforms[glslName];
      if (!u) continue;
      const nextValue = material.userData?.effectVariantFurCore
        && layerId === 'Triplanar'
        && paramName === 'frayAmount'
        ? 0
        : value;
      if (Array.isArray(nextValue) && nextValue.length === 3 && u.value?.setRGB) {
        u.value.setRGB(nextValue[0], nextValue[1], nextValue[2]);
      } else {
        u.value = nextValue;
      }
    }
  }
  return true;
}

/**
 * 运行时更新 variant 的系统/运行时 uniform（uTime…）。每帧调用，只改 value，不重编译、不改 variantKey。
 * 与 updateVariantParams 正交：后者按 paramUniformMap 走 layer 参数；本函数直接按 GLSL uniform 名设值。
 * @param {THREE.Material} material
 * @param {Object<string,number>} runtimeValues - { uTime: 1.234, ... }
 * @returns {boolean} 是否命中至少一个 runtime uniform
 */
export function updateVariantRuntimeUniforms(material, runtimeValues = {}) {
  const entry = material?.userData?.effectVariant;
  if (!entry || !entry.uniforms) return false;
  let any = false;
  for (const [name, value] of Object.entries(runtimeValues)) {
    const u = entry.uniforms[name];
    if (u) { u.value = value; any = true; }
  }
  return any;
}

/** 移除 material 上的 EffectVariant（重编译拿回干净 shader）。 */
export function removeEffectVariantFromMaterial(material) {
  removeMaterialShaderPatch(material, VARIANT_PATCH_KEY);
  if (material?.userData) {
    applyFoliageSideOverride(material, null);
    applyTriplanarWoolSideOverride(material, null);
    delete material.userData.effectVariantFurCore;
    delete material.userData.effectVariantFurShell;
  }
  if (material?.userData?.effectVariant) delete material.userData.effectVariant;
  if (material) material.needsUpdate = true;
}

export function removeEffectVariantFromObject3D(root) {
  if (!root) return;
  const targets = [];
  root.traverse((object) => {
    if (object.isMesh && !object.userData?.isFurShell) targets.push(object);
  });
  for (const object of targets) {
    disposeFurShell(object);
    applyDynamicBoundsCullingOverride(object, null);
    if (!object.material) continue;
    const materials = materialList(object.material);
    for (const material of materials) removeEffectVariantFromMaterial(material);
  }
}

/** 诊断：返回 material 的 EffectVariant 注入信息。 */
export function describeMaterialVariant(material) {
  if (!material) return { error: 'no material' };
  const entry = material.userData?.effectVariant;
  const shader = entry?.shaderRef;
  return {
    type: material.type,
    hasVariant: !!entry,
    variantKey: entry?.variantKey ?? null,
    layers: entry?.sortedLayerIds ?? [],
    skipped: entry?.skipped ?? null,
    patchRegistered: hasMaterialShaderPatch(material, VARIANT_PATCH_KEY),
    materialSkipReason: getMaterialSkipReason(material),
    customProgramCacheKey:
      typeof material.customProgramCacheKey === 'function' ? material.customProgramCacheKey() : null,
    shaderUniformKeys: shader?.uniforms ? Object.keys(shader.uniforms).filter(k => k.startsWith('u')) : [],
  };
}
