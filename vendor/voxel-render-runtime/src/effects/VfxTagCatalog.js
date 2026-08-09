/**
 * VfxTagCatalog.js — VFX 词表加载器
 *
 * 镜像 MaterialTagCatalog.js，但更精简：
 *   - 词表文件：../../model/vfx-tags-v1.json（由 build.mjs 镜像到 model/ 和 cloudflare-editor/model/）
 *   - 通过 fetch 加载，缓存单例
 *   - 通过 resolveVfxVocabulary(value) 接受外部传入（false → null，object → 校验后返回，undefined → fetch）
 *
 * 调用方（APIClient）传 vfxTags 字段到后端动画端点，后端 buildVfxPrompt() 序列化进 system prompt。
 */

const DEFAULT_URL = new URL('../../model/vfx-tags-v1.json', import.meta.url).href;

let cachedPromise = null;
let cachedUrl = null;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function getDefaultVfxVocabularyUrl() {
  return DEFAULT_URL;
}

/**
 * 校验 vocab 基本结构。与 backend buildVfxPrompt 的契约一致。
 */
export function validateVfxVocabulary(vocabulary) {
  const errors = [];
  if (!isObject(vocabulary)) {
    return { valid: false, presetCount: 0, errors: ['vocabulary must be an object'] };
  }
  if (!isObject(vocabulary.README)) errors.push('README must be an object');
  if (!isObject(vocabulary.presets)) errors.push('presets must be an object');

  const presetEntries = isObject(vocabulary.presets) ? Object.entries(vocabulary.presets) : [];
  for (const [name, definition] of presetEntries) {
    if (!isObject(definition)) {
      errors.push(`presets.${name} must be an object`);
      continue;
    }
    if (typeof definition.description !== 'string' || !definition.description.trim()) {
      errors.push(`presets.${name}.description must be a non-empty string`);
    }
    if (definition.trigger !== undefined && definition.trigger !== 'continuous' && definition.trigger !== 'event') {
      errors.push(`presets.${name}.trigger must be 'continuous' or 'event'`);
    }
  }

  const eventEntries = isObject(vocabulary.events) ? Object.entries(vocabulary.events) : [];
  for (const [name, definition] of eventEntries) {
    if (!isObject(definition)) {
      errors.push(`events.${name} must be an object`);
      continue;
    }
    if (typeof definition.description !== 'string' || !definition.description.trim()) {
      errors.push(`events.${name}.description must be a non-empty string`);
    }
  }

  return { valid: errors.length === 0, presetCount: presetEntries.length, eventCount: eventEntries.length, errors };
}

export function resetVfxVocabularyCache() {
  cachedPromise = null;
  cachedUrl = null;
}

export async function getVfxVocabulary(options = {}) {
  const url = options.url || getDefaultVfxVocabularyUrl();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('VFX vocabulary fetch is unavailable');
  if (cachedPromise && cachedUrl === url) return cachedPromise;

  cachedUrl = url;
  cachedPromise = (async () => {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response?.ok) throw new Error(`VFX vocabulary request failed: ${response?.status ?? 'unknown'}`);
    const vocabulary = await response.json();
    const validation = validateVfxVocabulary(vocabulary);
    if (!validation.valid) {
      throw new Error(`invalid VFX vocabulary: ${validation.errors.join('; ')}`);
    }
    return vocabulary;
  })().catch((error) => {
    cachedPromise = null;
    cachedUrl = null;
    throw error;
  });

  return cachedPromise;
}

/**
 * 解析外部传入的 vocab 值：
 *   - false → null（明确禁用）
 *   - object → 校验后返回
 *   - undefined / null → fetch 默认 URL
 *   - 其他类型 → 抛错
 */
export async function resolveVfxVocabulary(value, options = {}) {
  if (value === false) return null;
  if (isObject(value)) {
    const validation = validateVfxVocabulary(value);
    if (!validation.valid) {
      throw new Error(`invalid VFX vocabulary: ${validation.errors.join('; ')}`);
    }
    return value;
  }
  if (value === undefined || value === null) {
    return await getVfxVocabulary(options);
  }
  throw new Error(`vfxTags must be false, an object, or undefined; got ${typeof value}`);
}

/**
 * 查 preset 对应的 runtime.particlePreset（用于前端运行时把动画 vfx 名映射到 ParticlePresets 名）。
 * 返回 null 表示 preset 不存在或没有 runtime 映射。
 */
export function resolveParticlePresetName(vocabulary, presetName) {
  const def = vocabulary?.presets?.[presetName];
  if (!isObject(def)) return null;
  const runtimeName = def.runtime?.particlePreset;
  if (typeof runtimeName !== 'string') return null;
  return runtimeName;
}

/**
 * 查 event 的 default_preset（用于前端运行时按事件名找默认 preset）。
 */
export function resolveEventDefaultPreset(vocabulary, eventName) {
  const def = vocabulary?.events?.[eventName];
  if (!isObject(def)) return null;
  return typeof def.default_preset === 'string' ? def.default_preset : null;
}
