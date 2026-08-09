const DEFAULT_URL = new URL('../../model/material-tags-v1.json', import.meta.url).href;

let cachedPromise = null;
let cachedUrl = null;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const EXPLICIT_SILVER_PATTERN = /\b(?:silver|sterling|argent)\b|白银|纯银|镀银|银(?:色|白|质|制|饰|剑|刃|柄|甲|盔)/i;
const STRUCTURAL_TAGS = new Set(['base', 'water']);

function nodeTags(node) {
  return Array.isArray(node?.tags) ? node.tags : [];
}

function isCompanionTag(tagName, vocabulary) {
  return isObject(vocabulary?.tags?.[tagName]?.runtime?.companion);
}

/**
 * Normalize and validate material tags returned by the generation backend.
 * Existing imported models are intentionally not passed through this boundary.
 */
export function prepareGeneratedMaterialTags(modelJson, {
  description = '',
  vocabulary = null,
  normalizeSilver = false,
} = {}) {
  const nodes = Array.isArray(modelJson?.nodes) ? modelJson.nodes : [];
  const errors = [];
  let normalizedSilver = 0;
  let normalizedCompanionGroups = 0;
  let inferredCompanionGroups = 0;

  if (normalizeSilver && !EXPLICIT_SILVER_PATTERN.test(description)) {
    for (const node of nodes) {
      for (const tag of nodeTags(node)) {
        if (tag?.tag === 'base' && tag.value === 'silver') {
          tag.value = 'metal';
          delete tag.variant;
          normalizedSilver++;
        }
      }
    }
  }

  if (isCompanionTag('fire', vocabulary)) {
    const directChildren = new Map();
    for (const node of nodes) {
      if (!node?.parent) continue;
      const children = directChildren.get(node.parent) || [];
      children.push(node);
      directChildren.set(node.parent, children);
    }
    for (const node of nodes) {
      const semantic = `${node?.id || ''} ${node?.name || ''} ${node?.description || ''}`;
      const children = directChildren.get(node?.id) || [];
      if (node?.mesh
        || !node?.parent
        || nodeTags(node).length
        || !/(?:flame|fire|火焰|火苗|火环|火圈)/i.test(semantic)
        || !/(?:_fx\b|\beffect\b|特效|效果|占位|placeholder)/i.test(semantic)
        || !children.length
        || children.some(child => !child?.mesh)) continue;
      node.tags = [{ tag: 'fire', value: 1 }];
      inferredCompanionGroups++;
    }
  }

  const usedIds = new Set(nodes.map(node => node?.id).filter(Boolean));
  const claimId = (baseId) => {
    let id = baseId;
    for (let suffix = 2; usedIds.has(id); suffix++) id = `${baseId}_${suffix}`;
    usedIds.add(id);
    return id;
  };
  const wrappedRoots = new Map();
  for (const node of nodes) {
    if (node?.parent) continue;
    const tags = nodeTags(node);
    if (!tags.some(tag => isCompanionTag(tag?.tag, vocabulary))
      || tags.some(tag => STRUCTURAL_TAGS.has(tag?.tag))) continue;

    const rootId = claimId(`${node.id || 'effect'}_model_root`);
    wrappedRoots.set(node, {
      id: rootId,
      name: `${node.name || node.id || 'Effect'} Root`,
      transform: { pos: [0, 0, 0] },
    });
    node.parent = rootId;
    normalizedCompanionGroups++;
  }

  const promotedGroups = new Map();
  for (const node of [...nodes]) {
    if (!node?.mesh || !node.parent) continue;
    const tags = nodeTags(node);
    const companionTags = tags.filter(tag => isCompanionTag(tag?.tag, vocabulary));
    if (!companionTags.length
      || tags.some(tag => STRUCTURAL_TAGS.has(tag?.tag))) continue;

    const groupId = claimId(`${node.id || 'effect'}_effect_fx`);
    const group = {
      id: groupId,
      name: `${node.name || node.id || 'Effect'} FX`,
      parent: node.parent,
      tags: companionTags.map(tag => ({ ...tag })),
      transform: { pos: [0, 0, 0] },
    };
    promotedGroups.set(node, group);
    node.parent = groupId;
    node.tags = tags.filter(tag => !isCompanionTag(tag?.tag, vocabulary));
    normalizedCompanionGroups++;
  }
  if (wrappedRoots.size || promotedGroups.size) {
    modelJson.nodes = nodes.flatMap(node => {
      const root = wrappedRoots.get(node);
      const group = promotedGroups.get(node);
      return [
        ...(root ? [root] : []),
        ...(group ? [group] : []),
        node,
      ];
    });
  }

  const normalizedNodes = Array.isArray(modelJson?.nodes) ? modelJson.nodes : nodes;

  // Generated effect placeholders may be wrapped in more than one neutral transform
  // group (`fire_fx -> ring -> arc -> mesh`). Normalize the whole unambiguous
  // placeholder subtree instead of handling only one wrapper depth. Terminal groups
  // receive the companion tag; mixed groups get an identity child for their direct
  // meshes so every tagged group still owns mesh children directly.
  const nestedChildrenByParent = new Map();
  for (const node of normalizedNodes) {
    if (!node?.parent) continue;
    const children = nestedChildrenByParent.get(node.parent) || [];
    children.push(node);
    nestedChildrenByParent.set(node.parent, children);
  }
  const insertedEffectGroups = [];
  for (const node of [...normalizedNodes]) {
    if (node?.mesh) continue;
    const companionTags = nodeTags(node).filter(tag => isCompanionTag(tag?.tag, vocabulary));
    const children = nestedChildrenByParent.get(node?.id) || [];
    if (!companionTags.length || children.every(child => child?.mesh)) continue;

    const descendantGroups = [];
    const pending = children.filter(child => !child?.mesh);
    let purePlaceholderTree = children.length > 0;
    while (pending.length && purePlaceholderTree) {
      const group = pending.pop();
      const tags = nodeTags(group);
      const groupChildren = nestedChildrenByParent.get(group.id) || [];
      if (tags.some(tag => STRUCTURAL_TAGS.has(tag?.tag)
        || isCompanionTag(tag?.tag, vocabulary))
        || groupChildren.length === 0
        || groupChildren.some(child =>
          nodeTags(child).some(tag => STRUCTURAL_TAGS.has(tag?.tag)))) {
        purePlaceholderTree = false;
        break;
      }
      descendantGroups.push(group);
      pending.push(...groupChildren.filter(child => !child?.mesh));
    }
    if (!purePlaceholderTree) continue;

    const tagDirectMeshes = (group, groupChildren) => {
      const directMeshes = groupChildren.filter(child => child?.mesh);
      if (!directMeshes.length) return 0;
      const nestedGroups = groupChildren.filter(child => !child?.mesh);
      if (nestedGroups.length === 0 && group !== node) {
        group.tags = [
          ...nodeTags(group).filter(tag => !isCompanionTag(tag?.tag, vocabulary)),
          ...companionTags.map(tag => ({ ...tag })),
        ];
        return 1;
      }
      const effectGroup = {
        id: claimId(`${group.id || companionTags[0]?.tag || 'effect'}_effect_fx`),
        name: `${group.name || group.id || 'Effect'} FX`,
        parent: group.id,
        tags: companionTags.map(tag => ({ ...tag })),
        transform: { pos: [0, 0, 0] },
      };
      insertedEffectGroups.push(effectGroup);
      nestedChildrenByParent.set(effectGroup.id, directMeshes);
      for (const mesh of directMeshes) mesh.parent = effectGroup.id;
      nestedChildrenByParent.set(group.id, [...nestedGroups, effectGroup]);
      return 1;
    };

    let normalizedTargets = tagDirectMeshes(node, children);
    for (const group of descendantGroups) {
      normalizedTargets += tagDirectMeshes(
        group,
        nestedChildrenByParent.get(group.id) || [],
      );
    }
    if (normalizedTargets === 0) continue;
    node.tags = nodeTags(node).filter(tag => !isCompanionTag(tag?.tag, vocabulary));
    normalizedCompanionGroups += normalizedTargets;
  }
  if (insertedEffectGroups.length) {
    normalizedNodes.push(...insertedEffectGroups);
    modelJson.nodes = normalizedNodes;
  }

  const byId = new Map(normalizedNodes.map(node => [node?.id, node]));
  const childrenByParent = new Map();
  for (const node of normalizedNodes) {
    if (!node?.parent) continue;
    const children = childrenByParent.get(node.parent) || [];
    children.push(node);
    childrenByParent.set(node.parent, children);
  }

  for (const node of normalizedNodes) {
    const companionTags = nodeTags(node).filter(tag => isCompanionTag(tag?.tag, vocabulary));
    if (!companionTags.length) continue;

    for (const tag of companionTags) {
      if (node?.mesh) {
        errors.push({
          nodeId: node.id,
          tag: tag.tag,
          reason: 'companion tag must be declared on an effect group, not a mesh',
        });
        continue;
      }

      if (!node.parent) {
        errors.push({
          nodeId: node.id,
          tag: tag.tag,
          reason: 'companion effect group cannot be the model root',
        });
      }

      let ancestor = byId.get(node.parent);
      while (ancestor) {
        const inheritedConflict = nodeTags(ancestor).find(candidate =>
          STRUCTURAL_TAGS.has(candidate?.tag) || isCompanionTag(candidate?.tag, vocabulary));
        if (inheritedConflict) {
          errors.push({
            nodeId: node.id,
            tag: tag.tag,
            reason: `companion effect group inherits conflicting '${inheritedConflict.tag}' from ancestor '${ancestor.id}'`,
          });
          break;
        }
        ancestor = byId.get(ancestor.parent);
      }

      for (const child of childrenByParent.get(node.id) || []) {
        if (!child.mesh) {
          errors.push({
            nodeId: node.id,
            tag: tag.tag,
            reason: `companion effect group must contain direct mesh children; '${child.id}' is a nested group`,
          });
          continue;
        }
        const childConflict = nodeTags(child).find(candidate => STRUCTURAL_TAGS.has(candidate?.tag));
        if (childConflict) {
          errors.push({
            nodeId: child.id,
            tag: tag.tag,
            reason: `companion mesh cannot also declare structural '${childConflict.tag}'`,
          });
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    normalizedSilver,
    normalizedCompanionGroups,
    inferredCompanionGroups,
    modelJson,
  };
}

export function getDefaultMaterialTagVocabularyUrl() {
  return DEFAULT_URL;
}

export function validateMaterialTagVocabulary(vocabulary) {
  const errors = [];
  if (!isObject(vocabulary)) {
    return { valid: false, tagCount: 0, errors: ['vocabulary must be an object'] };
  }
  if (!isObject(vocabulary.README)) errors.push('README must be an object');
  if (!isObject(vocabulary.tags)) errors.push('tags must be an object');

  const entries = isObject(vocabulary.tags) ? Object.entries(vocabulary.tags) : [];
  for (const [name, definition] of entries) {
    if (!isObject(definition)) {
      errors.push(`tags.${name} must be an object`);
      continue;
    }
    if (definition.mode !== 'enum' && definition.mode !== 'blend') {
      errors.push(`tags.${name}.mode must be enum or blend`);
    }
    if (typeof definition.description !== 'string' || !definition.description.trim()) {
      errors.push(`tags.${name}.description must be a non-empty string`);
    }
    if (definition.mode === 'enum' && (!Array.isArray(definition.values) || definition.values.length === 0)) {
      errors.push(`tags.${name}.values must be a non-empty array`);
    }
    if (definition.variantEnum !== undefined && !Array.isArray(definition.variantEnum)) {
      errors.push(`tags.${name}.variantEnum must be an array`);
    }
  }

  return { valid: errors.length === 0, tagCount: entries.length, errors };
}

export function resetMaterialTagVocabularyCache() {
  cachedPromise = null;
  cachedUrl = null;
}

export async function getMaterialTagVocabulary(options = {}) {
  const url = options.url || getDefaultMaterialTagVocabularyUrl();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('material tag vocabulary fetch is unavailable');
  if (cachedPromise && cachedUrl === url) return cachedPromise;

  cachedUrl = url;
  cachedPromise = (async () => {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response?.ok) throw new Error(`material tag vocabulary request failed: ${response?.status ?? 'unknown'}`);
    const vocabulary = await response.json();
    const validation = validateMaterialTagVocabulary(vocabulary);
    if (!validation.valid) {
      throw new Error(`invalid material tag vocabulary: ${validation.errors.join('; ')}`);
    }
    return vocabulary;
  })().catch((error) => {
    cachedPromise = null;
    cachedUrl = null;
    throw error;
  });

  return cachedPromise;
}

export async function resolveMaterialTagVocabulary(value, options = {}) {
  if (value === false) return null;
  if (isObject(value)) {
    const validation = validateMaterialTagVocabulary(value);
    if (!validation.valid) {
      throw new Error(`invalid material tag vocabulary: ${validation.errors.join('; ')}`);
    }
    return value;
  }
  return getMaterialTagVocabulary(options);
}
