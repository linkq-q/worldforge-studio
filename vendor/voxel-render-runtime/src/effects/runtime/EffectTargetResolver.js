function humanizeId(value) {
  return String(value || 'Object')
    .split(':').pop()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function objectName(object) {
  return object?.userData?.displayName
    || object?.userData?.sceneModelId
    || object?.name
    || object?.userData?.nodeId
    || object?.userData?.partId
    || 'Object';
}

export class EffectTargetResolver {
  constructor(options = {}) {
    this.runtimeIndex = options.runtimeIndex || null;
    this.sceneManager = options.sceneManager || null;
  }

  resolveFromHit(hit) {
    const sourceHit = hit?.hit || hit;
    const partId = hit?.partId || this.runtimeIndex?.getPartIdFromHit?.(sourceHit) || null;
    const root = hit?.root || this._rootForPart(partId) || hit?.object || sourceHit?.object || null;
    if (partId) {
      // Prefer explicit semanticGroupId from hit result or mesh userData, then fall back to runtimeIndex lookup.
      const explicitGroupId = hit?.semanticGroupId || sourceHit?.object?.userData?.semanticGroupId || root?.userData?.semanticGroupId || null;
      const groupId = explicitGroupId
        || this.runtimeIndex?.getGroupIdForPart?.(partId)
        || this.runtimeIndex?.getAncestorGroups?.(partId)?.[0]
        || null;
      if (groupId) {
        const groupRef = this.runtimeIndex?.getGroupRef?.(groupId) || {};
        const object = this.sceneManager?.getRootGroup?.(groupRef.modelId) || root;
        return {
          object,
          targetType: 'semantic-group',
          targetId: `semantic:${groupId}`,
          semanticGroupId: groupId,
          partIds: this.runtimeIndex?.getGroupLeafParts?.(groupId) || [partId],
          rootModelId: groupRef.modelId || this._modelIdFromPart(partId),
          displayName: groupRef.name || humanizeId(groupId),
          sourceHit,
          partId,
        };
      }
      const ref = this.runtimeIndex?.getRenderRef?.(partId) || {};
      const object = this.sceneManager?.getRootGroup?.(ref.modelId) || ref.object || root;
      if (object) {
        return {
          object,
          targetType: ref.modelId ? 'model-root' : 'mesh',
          targetId: ref.modelId ? `model:${ref.modelId}` : `mesh:${partId}`,
          semanticGroupId: sourceHit?.object?.userData?.semanticGroupId || root?.userData?.semanticGroupId || null,
          partIds: [partId],
          rootModelId: ref.modelId || this._modelIdFromPart(partId),
          displayName: ref.modelId ? humanizeId(ref.modelId) : humanizeId(partId),
          sourceHit,
          partId,
        };
      }
    }
    return this.resolveFromObject(root || sourceHit?.object || hit?.object || null);
  }

  resolveFromObject(object) {
    if (!object) return null;
    const partId = object.userData?.nodeId || object.userData?.partId || null;
    const modelId = object.userData?.sceneModelId || this._modelIdFromPart(partId);
    return {
      object,
      targetType: modelId ? 'model-root' : 'mesh',
      targetId: modelId ? `model:${modelId}` : `mesh:${partId || object.name || 'object'}`,
      semanticGroupId: object.userData?.semanticGroupId || null,
      partIds: partId ? [partId] : [],
      rootModelId: modelId,
      displayName: objectName(object),
      sourceHit: null,
      partId,
    };
  }

  resolveFromPartId(partId) {
    if (!partId) return null;
    const ref = this.runtimeIndex?.getRenderRef?.(partId) || {};
    return this.resolveFromHit({ partId, root: this.sceneManager?.getRootGroup?.(ref.modelId) || ref.object || null });
  }

  resolveFromSelection(selection) {
    if (!selection) return null;
    if (selection.object || selection.root || selection.hit) return this.resolveFromHit(selection);
    return this.resolveFromObject(selection);
  }

  _rootForPart(partId) {
    const ref = this.runtimeIndex?.getRenderRef?.(partId);
    return this.sceneManager?.getRootGroup?.(ref?.modelId) || ref?.object || null;
  }

  _modelIdFromPart(partId) {
    return typeof partId === 'string' && partId.includes(':') ? partId.split(':')[0] : null;
  }
}

export default EffectTargetResolver;
