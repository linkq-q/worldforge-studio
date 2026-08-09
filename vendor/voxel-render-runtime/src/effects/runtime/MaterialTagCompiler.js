import { stableStringify } from './EffectRuntimeTypes.js';
import { resolveModelMaterialTags } from './MaterialTagResolver.js';
import { mergeLayerManifests } from './LayerManifestDefaults.js';
import { triplanarStyleParams } from './TriplanarStylePresets.js';

const LAYER_MANIFESTS = mergeLayerManifests();

// enum tags whose layers must ride the batchable base recipe (materialTagBaseRecipe) so they
// reach InstancedMesh/BatchedMesh batch materials — NOT the runtime path, which skips batched
// meshes. Base materials, block-canopy foliage and vertex-only plant sway belong here.
const BASE_RECIPE_TAGS = new Set(['base', 'foliage', 'vegetation']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function isBlockCanopyPart(part) {
  const semanticName = `${part?.id || ''} ${part?.name || ''}`;
  if (/lotus|water.?lily|bamboo|grass|flower|petal|blade|frond|palm|vine|荷叶|睡莲|竹叶|竹子|草|花瓣|棕榈|藤/i.test(semanticName)) {
    return false;
  }
  if (part?.mesh?.type !== 'box') return false;
  const geometry = part.mesh.geometry || part.mesh.params || {};
  const scale = part.scale || part.transform?.scale || {};
  const dimensions = [
    (Number(geometry.width) || 1) * (Math.abs(Number(scale.x)) || 1),
    (Number(geometry.height) || 1) * (Math.abs(Number(scale.y)) || 1),
    (Number(geometry.depth) || 1) * (Math.abs(Number(scale.z)) || 1),
  ].map(Math.abs).sort((a, b) => a - b);
  // A long hedge may be much longer than its cross-section and is still a block.
  // Reject sheet-like boxes by comparing thickness with the middle axis instead.
  return dimensions[0] / Math.max(dimensions[1], 1e-6) >= 0.18;
}

function routeFoliageTagsForShape(effectiveTags, part, vocabulary) {
  const foliageIndex = effectiveTags.findIndex(
    entry => entry.tag === 'foliage' && entry.value === 'leaf',
  );
  if (foliageIndex < 0 || isBlockCanopyPart(part)) return effectiveTags;
  if (!vocabulary?.tags?.vegetation?.runtime?.presets?.sway) return effectiveTags;

  const alreadyHasSway = effectiveTags.some(
    entry => entry.tag === 'vegetation' && entry.value === 'sway',
  );
  return effectiveTags.flatMap((entry, index) => {
    if (index !== foliageIndex) return [entry];
    return alreadyHasSway ? [] : [{ tag: 'vegetation', value: 'sway' }];
  });
}

function tokenize(expression) {
  const tokens = [];
  let index = 0;
  while (index < expression.length) {
    const rest = expression.slice(index);
    const whitespace = rest.match(/^\s+/);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }
    const match = rest.match(/^(>=|<=|===|==|>|<|\+|-|\*|\/|\(|\)|value|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i);
    if (!match) throw new Error(`unsupported token near "${rest.slice(0, 16)}"`);
    tokens.push(match[1]);
    index += match[1].length;
  }
  return tokens;
}

function roundNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1e12) / 1e12
    : value;
}

export function evaluateMaterialTagExpression(expression, value) {
  if (typeof expression === 'number' || typeof expression === 'boolean') return expression;
  if (typeof expression !== 'string') throw new Error('material tag expression must be a string');
  const tokens = tokenize(expression);
  let cursor = 0;

  function peek() { return tokens[cursor]; }
  function take() { return tokens[cursor++]; }

  function primary() {
    const token = take();
    if (token === '(') {
      const result = comparison();
      if (take() !== ')') throw new Error('material tag expression is missing )');
      return result;
    }
    if (token?.toLowerCase() === 'value') return Number(value);
    const number = Number(token);
    if (!Number.isFinite(number)) throw new Error(`unsupported material tag token ${token}`);
    return number;
  }

  function unary() {
    if (peek() === '+') { take(); return Number(unary()); }
    if (peek() === '-') { take(); return -Number(unary()); }
    return primary();
  }

  function product() {
    let result = unary();
    while (peek() === '*' || peek() === '/') {
      const operator = take();
      const right = unary();
      result = operator === '*' ? Number(result) * Number(right) : Number(result) / Number(right);
    }
    return result;
  }

  function sum() {
    let result = product();
    while (peek() === '+' || peek() === '-') {
      const operator = take();
      const right = product();
      result = operator === '+' ? Number(result) + Number(right) : Number(result) - Number(right);
    }
    return result;
  }

  function comparison() {
    const left = sum();
    const operator = peek();
    if (!['>=', '<=', '>', '<', '==', '==='].includes(operator)) return left;
    take();
    const right = sum();
    if (operator === '>=') return left >= right;
    if (operator === '<=') return left <= right;
    if (operator === '>') return left > right;
    if (operator === '<') return left < right;
    return left === right;
  }

  const result = comparison();
  if (cursor !== tokens.length) throw new Error(`unsupported material tag expression tail ${tokens.slice(cursor).join(' ')}`);
  return roundNumber(result);
}

function applyDrive(target, drive, value, diagnostics, tag) {
  for (const [name, expression] of Object.entries(drive || {})) {
    try {
      target[name] = evaluateMaterialTagExpression(expression, value);
    } catch (error) {
      diagnostics.push({ tag, reason: 'invalid-drive-expression', param: name, message: error.message });
    }
  }
}

function compileEnum(entry, definition, layers, materialBindings, unsupported, style) {
  // Water is a routing tag consumed by ModelWaterInstances, not a material layer.
  if (definition.runtime?.routingOnly) return;
  const preset = definition.runtime?.presets?.[entry.value];
  if (!preset || preset.status === 'notImplemented') {
    unsupported.push({ tag: entry.tag, value: entry.value, reason: 'not-implemented' });
    return;
  }
  const variant = entry.variant || definition.variantEnum?.[0];
  let implemented = false;
  const presetLayers = Array.isArray(preset.layers)
    ? preset.layers
    : (preset.layer ? [{ type: preset.layer, params: preset.params || {} }] : []);
  for (const layerDefinition of presetLayers) {
    const layerType = layerDefinition?.type;
    if (!layerType) continue;
    let params = clone(layerDefinition.params || {});
    // Triplanar wood/stone: layer structure params come from the model's generation
    // style (voxel/curve/…) merged over the vocab preset colors. Merged BEFORE the
    // baseRecipe key is stringified below, so different styles land in different batches.
    if (layerType === 'Triplanar') {
      // Order: vocab preset -> generation style baseline -> per-variant branch:
      //   default variant  -> shared saved `tuning` (unchanged legacy behavior).
      //   explicit variant -> that variant's structural override (`presetByVariant`)
      //     THEN that variant's OWN saved tuning (`tuningByVariant`) — never the
      //     shared `tuning`. Each stone/wood look is tuned and saved independently;
      //     adjusting e.g. stone:brick must never bleed into stone:marble or the
      //     default rubble look (that cross-contamination was the old bug: a single
      //     shared `tuning` applied under every variant).
      const isDefaultVariant = !variant || variant === 'default';
      params = {
        ...params,
        ...triplanarStyleParams(entry.value, style),
        ...(isDefaultVariant
          ? (preset.tuning || {})
          : {
              ...clone(preset.presetByVariant?.[variant] || {}),
              ...clone(preset.tuningByVariant?.[variant] || {}),
            }),
      };
    } else {
      params = {
        ...params,
        ...clone(preset.presetByVariant?.[variant] || {}),
      };
    }
    const existing = layers.find(layer => layer.type === layerType);
    if (existing) {
      existing.params = { ...(existing.params || {}), ...params };
    } else {
      layers.push({
        id: `material-tag:${entry.tag}:${layerType}${variant && variant !== 'default' ? `:${variant}` : ''}`,
        type: layerType,
        params,
      });
    }
    implemented = true;
  }
  const surface = {
    ...clone(preset.surface || {}),
    ...clone(preset.surfaceByVariant?.[variant] || {}),
    ...clone(preset.surfaceTuningByVariant?.[variant] || {}),
  };
  if (Object.keys(surface).length > 0) {
    materialBindings.surface = surface;
    implemented = true;
  }
  if (preset.matcap) {
    materialBindings.matcap = clone(preset.matcap);
    implemented = true;
  }
  if (!implemented) unsupported.push({ tag: entry.tag, value: entry.value, reason: 'not-implemented' });
}

function compileBlend(entry, definition, layers, companions, diagnostics, unsupported) {
  if (definition.status === 'notImplemented') {
    unsupported.push({ tag: entry.tag, value: entry.value, reason: 'not-implemented' });
    return;
  }
  if (entry.value <= 0) return;
  const runtime = definition.runtime || {};
  const variant = entry.variant || definition.variantEnum?.[0];

  for (const layerDefinition of runtime.layers || []) {
    const params = {
      ...(clone(layerDefinition.preset || {})),
      ...(clone(layerDefinition.presetByVariant?.[variant] || {})),
    };
    applyDrive(params, layerDefinition.drive, entry.value, diagnostics, entry.tag);
    layers.push({
      id: `material-tag:${entry.tag}:${layerDefinition.type}`,
      type: layerDefinition.type,
      params,
    });
  }

  const companion = runtime.companion;
  if (companion?.type) {
    let enabled = true;
    if (companion.when !== undefined) {
      try {
        enabled = !!evaluateMaterialTagExpression(companion.when, entry.value);
      } catch (error) {
        diagnostics.push({ tag: entry.tag, reason: 'invalid-companion-condition', message: error.message });
        enabled = false;
      }
    }
    if (enabled) {
      const params = clone(companion.overridesByVariant?.[variant] || {});
      applyDrive(params, companion.drive, entry.value, diagnostics, entry.tag);
      companions.push({
        id: `material-tag:${entry.tag}:${companion.type}`,
        type: companion.type,
        params,
      });
    }
  }
}

function keepLastExclusiveBaseLayer(layers, diagnostics) {
  const kept = [];
  for (const layer of layers) {
    if (LAYER_MANIFESTS[layer.type]?.slot === 'baseShading') {
      const previous = kept.findIndex((candidate) => LAYER_MANIFESTS[candidate.type]?.slot === 'baseShading');
      if (previous >= 0) {
        const replaced = kept.splice(previous, 1)[0];
        diagnostics.push({
          reason: 'exclusive-base-shading-replaced',
          replacedLayer: replaced.type,
          keptLayer: layer.type,
        });
      }
    }
    kept.push(layer);
  }
  return kept;
}

export function compileMaterialTagSet(effectiveTags, vocabulary, style) {
  const layers = [];
  const companions = [];
  const materialBindings = {};
  const baseLayers = [];
  const baseMaterialBindings = {};
  const diagnostics = [];
  const unsupportedTags = [];

  for (const entry of effectiveTags || []) {
    const definition = vocabulary?.tags?.[entry.tag];
    if (!definition) {
      unsupportedTags.push({ tag: entry.tag, reason: 'unknown-tag' });
      continue;
    }
    if (definition.mode === 'enum') {
      const isBaseRecipe = BASE_RECIPE_TAGS.has(entry.tag);
      const targetLayers = isBaseRecipe ? baseLayers : layers;
      const targetBindings = isBaseRecipe ? baseMaterialBindings : materialBindings;
      compileEnum(entry, definition, targetLayers, targetBindings, unsupportedTags, style);
    }
    else if (definition.mode === 'blend') {
      compileBlend(entry, definition, layers, companions, diagnostics, unsupportedTags);
    }
  }

  // Material tags are generated input. Keep a second guard at compilation time
  // so manually assembled or legacy effective tags cannot crash the renderer by
  // producing two mutually-exclusive baseShading layers.
  const normalizedBaseLayers = keepLastExclusiveBaseLayer(baseLayers, diagnostics);
  const normalizedRuntimeLayers = keepLastExclusiveBaseLayer(layers, diagnostics);
  const allLayers = keepLastExclusiveBaseLayer(
    [...normalizedBaseLayers, ...normalizedRuntimeLayers],
    diagnostics,
  );
  const allMaterialBindings = { ...baseMaterialBindings, ...materialBindings };
  const effectKey = stableStringify({ layers: allLayers, companions, materialBindings: allMaterialBindings });
  const effectPackage = allLayers.length > 0 || companions.length > 0
    ? {
        schemaVersion: 'v2',
        effectId: `material-tags:${effectKey}`,
        source: vocabulary?.version || 'material-tags',
        targetPolicy: { isolateBeforeApply: true },
        materialLayers: allLayers,
        companionEffects: companions,
      }
    : null;

  const runtimeEffectPackage = normalizedRuntimeLayers.length > 0 || companions.length > 0
    ? {
        schemaVersion: 'v2',
        effectId: `material-tags-runtime:${stableStringify({ layers: normalizedRuntimeLayers, companions })}`,
        source: vocabulary?.version || 'material-tags',
        targetPolicy: { isolateBeforeApply: true },
        materialLayers: normalizedRuntimeLayers,
        companionEffects: companions,
      }
    : null;

  const baseKey = stableStringify({ layers: normalizedBaseLayers, materialBindings: baseMaterialBindings });
  const baseRecipe = normalizedBaseLayers.length > 0 || Object.keys(baseMaterialBindings).length > 0
    ? {
        key: baseKey,
        batchPolicy: normalizedBaseLayers.some(layer => LAYER_MANIFESTS[layer.type]?.defaultBatchPolicy === 'standaloneOnly')
          ? 'standaloneOnly'
          : 'effectBatchable',
        effectPackage: normalizedBaseLayers.length > 0
          ? {
              schemaVersion: 'v2',
              effectId: `material-tag-base:${baseKey}`,
              source: vocabulary?.version || 'material-tags',
              targetPolicy: { isolateBeforeApply: false },
              materialLayers: normalizedBaseLayers,
              companionEffects: [],
            }
          : null,
        materialBindings: baseMaterialBindings,
      }
    : null;

  return {
    effectPackage,
    runtimeEffectPackage,
    baseRecipe,
    effectKey,
    materialBindings: allMaterialBindings,
    diagnostics,
    unsupportedTags,
  };
}

export function compileModelMaterialTags(model, vocabulary) {
  const resolved = resolveModelMaterialTags(model, vocabulary);
  const byPartId = new Map();
  const diagnostics = [...resolved.diagnostics];
  const style = model?.style;   // generation mode (voxel/curve/…); drives Triplanar structure params
  for (const part of model?.parts || []) {
    if (part.isGroup || !part.mesh) continue;
    const effectiveTags = routeFoliageTagsForShape(
      resolved.byPartId.get(part.id) || [],
      part,
      vocabulary,
    );
    const compiled = compileMaterialTagSet(effectiveTags, vocabulary, style);
    diagnostics.push(...compiled.diagnostics.map(item => ({ partId: part.id, ...item })));
    byPartId.set(part.id, { part, effectiveTags, ...compiled });
  }
  return { byPartId, diagnostics };
}

export function prepareModelMaterialTags(model, vocabulary) {
  const compiled = compileModelMaterialTags(model, vocabulary);
  for (const [partId, entry] of compiled.byPartId) {
    const part = entry.part || model?.parts?.find(candidate => candidate.id === partId);
    if (!part) continue;
    if (entry.baseRecipe) part.materialTagBaseRecipe = entry.baseRecipe;
    else delete part.materialTagBaseRecipe;
    if (entry.runtimeEffectPackage) part.materialTagRequiresRuntimeStandalone = true;
    else delete part.materialTagRequiresRuntimeStandalone;
  }
  return compiled;
}

export default compileModelMaterialTags;
