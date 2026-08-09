const BLEND_STEPS = new Set([0, 0.25, 0.5, 0.75, 1]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function replaceExclusiveRenderTag(effective, entry, vocabulary) {
  const slot = vocabulary?.tags?.[entry.tag]?.exclusiveRenderSlot;
  if (typeof slot === 'string' && slot) {
    for (const [tag, previous] of effective) {
      if (tag !== entry.tag && vocabulary?.tags?.[previous.tag]?.exclusiveRenderSlot === slot) {
        effective.delete(tag);
      }
    }
  }
  effective.set(entry.tag, entry);
}

function validateEntry(entry, vocabulary) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { valid: false, reason: 'entry-not-object' };
  }
  const name = typeof entry.tag === 'string' ? entry.tag : '';
  const definition = vocabulary?.tags?.[name];
  if (!name || !definition) return { valid: false, reason: 'unknown-tag', tag: name || null };

  if (definition.mode === 'enum') {
    if (!definition.values?.includes(entry.value)) {
      return { valid: false, reason: 'invalid-enum-value', tag: name, value: entry.value };
    }
  } else if (definition.mode === 'blend') {
    if (!BLEND_STEPS.has(entry.value)) {
      return { valid: false, reason: 'invalid-blend-value', tag: name, value: entry.value };
    }
  } else {
    return { valid: false, reason: 'unsupported-tag-mode', tag: name, mode: definition.mode };
  }

  if (entry.variant !== undefined && !definition.variantEnum?.includes(entry.variant)) {
    return { valid: false, reason: 'invalid-variant', tag: name, variant: entry.variant };
  }

  const normalized = { tag: name, value: entry.value };
  if (entry.variant !== undefined) normalized.variant = entry.variant;
  return { valid: true, entry: normalized };
}

export function resolveModelMaterialTags(model, vocabulary) {
  const parts = Array.isArray(model?.parts) ? model.parts : [];
  const byId = new Map(parts.map(part => [part.id, part]));
  const byPartId = new Map();
  const diagnostics = [];
  const visiting = new Set();

  function resolvePart(part) {
    if (byPartId.has(part.id)) return byPartId.get(part.id);
    if (visiting.has(part.id)) {
      diagnostics.push({ partId: part.id, reason: 'parent-cycle' });
      byPartId.set(part.id, []);
      return [];
    }

    visiting.add(part.id);
    const effective = new Map();
    const parent = part.parent ? byId.get(part.parent) : null;
    if (parent) {
      for (const entry of resolvePart(parent)) {
        // 2026-07-22: point-source effect tags (fire/emissive/smoke/electric/poison) declare
        // inherits:false — they describe a specific burning/glowing spot, not the whole object,
        // so a tag placed on a big parent must not silently light up every descendant.
        if (vocabulary?.tags?.[entry.tag]?.inherits === false) continue;
        effective.set(entry.tag, clone(entry));
      }
    } else if (part.parent) {
      diagnostics.push({ partId: part.id, parentId: part.parent, reason: 'missing-parent' });
    }

    for (const rawEntry of Array.isArray(part.tags) ? part.tags : []) {
      const result = validateEntry(rawEntry, vocabulary);
      if (!result.valid) {
        diagnostics.push({ partId: part.id, ...result });
        continue;
      }
      // A locally declared base material is more specific than an inherited one.
      // For example, tree canopies inherit their trunk's base:wood tag but must
      // replace it with foliage:leaf rather than compiling both base shaders.
      replaceExclusiveRenderTag(effective, result.entry, vocabulary);
    }

    visiting.delete(part.id);
    const resolved = [...effective.values()];
    byPartId.set(part.id, resolved);
    return resolved;
  }

  for (const part of parts) resolvePart(part);
  return { byPartId, diagnostics };
}

export default resolveModelMaterialTags;
