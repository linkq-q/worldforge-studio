import { stableStringify } from './EffectRuntimeTypes.js';

function renderMaterialState(target) {
  const material = target?.material || null;
  const color = material?.color?.getHexString?.()
    || (material?.color ? stableStringify(material.color) : null);
  const textureKey = (texture) => texture?.uuid || texture?.name || texture?.source?.uuid || null;
  return {
    materialType: material?.userData?.effectMaterialType || material?.type || material?.constructor?.name || 'unknown',
    transparent: !!material?.transparent,
    depthWrite: material?.depthWrite !== false,
    renderOrder: target?.renderOrder || 0,
    shaderDefines: material?.defines || {},
    baseAppearance: {
      color,
      roughness: material?.roughness ?? null,
      metalness: material?.metalness ?? null,
      opacity: material?.opacity ?? 1,
      alphaTest: material?.alphaTest ?? 0,
      side: material?.side ?? null,
      flatShading: material?.flatShading ?? null,
      map: textureKey(material?.map),
      normalMap: textureKey(material?.normalMap),
      roughnessMap: textureKey(material?.roughnessMap),
      metalnessMap: textureKey(material?.metalnessMap),
      alphaMap: textureKey(material?.alphaMap),
    },
  };
}

export class EffectBatchKeyBuilder {
  build({ target, layer, geometryFamily } = {}) {
    if (!layer) return null;
    const manifestKey = layer.manifest?.getEffectBatchKey?.(layer.params, { target, layer });
    if (manifestKey === null) return null;
    const effectKey = manifestKey || `${layer.type}|${stableStringify(layer.params || {})}`;
    const material = renderMaterialState(target);
    const family = geometryFamily
      || target?.userData?.geometryFamily
      || target?.geometry?.userData?.geometryFamily
      || target?.geometry?.type
      || target?.geometry?.constructor?.name
      || 'unknownGeometry';

    return [
      family,
      material.materialType,
      layer.route,
      effectKey,
      material.transparent ? 'transparent' : 'opaque',
      material.depthWrite ? 'depthWriteOn' : 'depthWriteOff',
      `renderOrder:${material.renderOrder}`,
      stableStringify(material.shaderDefines),
      stableStringify(material.baseAppearance),
    ].join('|');
  }
}
