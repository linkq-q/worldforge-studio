function formatBatchValue(value) {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toFixed(6)) : String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (value?.uuid) return value.uuid;
  if (Array.isArray(value)) return `[${value.map(item => formatBatchValue(item)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${key}:${formatBatchValue(value[key])}`).join(',')}}`;
  }
  return String(value);
}

function readParam(source, names, fallback = undefined) {
  for (const name of names) {
    if (source?.[name] !== undefined) return source[name];
  }
  return fallback;
}

function primitiveParamsFor(mesh) {
  const geometry = mesh?.geometry || {};
  const userData = mesh?.userData || {};
  return userData.primitiveParams
    || userData.node?.geometry
    || geometry.parameters
    || geometry.userData?.primitiveParams
    || null;
}

function primitiveTypeFor(mesh) {
  const geometry = mesh?.geometry || {};
  const userData = mesh?.userData || {};
  return String(
    userData.primitiveType
    || userData.node?.type
    || userData.type
    || geometry.userData?.primitiveType
    || geometry.type
    || 'geometry'
  ).toLowerCase();
}

function makePrimitiveGeometryKey(mesh) {
  const params = primitiveParamsFor(mesh);
  if (!params) return null;

  const type = primitiveTypeFor(mesh);
  if (type.includes('box')) {
    return `box:width=${formatBatchValue(readParam(params, ['width', 'w'], 1))},height=${formatBatchValue(readParam(params, ['height', 'h'], 1))},depth=${formatBatchValue(readParam(params, ['depth', 'd'], 1))}`;
  }
  if (type.includes('cylinder')) {
    return `cylinder:radiusTop=${formatBatchValue(readParam(params, ['radiusTop'], 1))},radiusBottom=${formatBatchValue(readParam(params, ['radiusBottom'], 1))},height=${formatBatchValue(readParam(params, ['height', 'h'], 1))},radialSegments=${formatBatchValue(readParam(params, ['radialSegments'], 8))}`;
  }
  if (type.includes('sphere')) {
    return `sphere:radius=${formatBatchValue(readParam(params, ['radius'], 1))},widthSegments=${formatBatchValue(readParam(params, ['widthSegments'], 8))},heightSegments=${formatBatchValue(readParam(params, ['heightSegments'], 6))}`;
  }
  if (type.includes('wedge')) {
    return `wedge:width=${formatBatchValue(readParam(params, ['width', 'w'], 1))},height=${formatBatchValue(readParam(params, ['height', 'h'], 1))},depth=${formatBatchValue(readParam(params, ['depth', 'd'], 1))}`;
  }

  const stable = Object.keys(params).sort().map(key => `${key}=${formatBatchValue(params[key])}`).join(',');
  return `${type}:${stable}`;
}

export function makeGeometryBatchKey(mesh) {
  const userData = mesh?.userData || {};
  if (userData.geometryTraceKey) return String(userData.geometryTraceKey);
  if (userData.primitiveKey) return String(userData.primitiveKey);

  const primitiveKey = makePrimitiveGeometryKey(mesh);
  if (primitiveKey) return primitiveKey;

  const geometry = mesh?.geometry;
  if (geometry?.uuid) return `geometry.uuid:${geometry.uuid}`;
  return `${primitiveTypeFor(mesh)}:{}`;
}

export function makeMaterialBatchKey(material) {
  const source = Array.isArray(material) ? material[0] : material;
  if (!source) return 'material:null';
  const userData = source.userData || {};
  const shaderMode = userData.shaderMode
    || userData.shaderAppliedMode
    || userData.shaderAppliedVariant
    || userData.shaderCategory
    || userData.shaderLibraryShared
    || '';
  const fields = {
    type: source.type || source.constructor?.name || 'Material',
    color: source.color?.getHexString?.() || source.color,
    roughness: source.roughness,
    metalness: source.metalness,
    opacity: source.opacity,
    transparent: source.transparent,
    side: source.side,
    alphaTest: source.alphaTest,
    flatShading: source.flatShading,
    map: source.map?.uuid || '',
    normalMap: source.normalMap?.uuid || '',
    emissive: source.emissive?.getHexString?.() || source.emissive,
    shaderMode,
  };
  return Object.keys(fields).map(key => `${key}=${formatBatchValue(fields[key])}`).join(',');
}

export function makeBatchKey(mesh, options = {}) {
  const geometryKey = options.geometryKey || makeGeometryBatchKey(mesh);
  const materialKey = options.materialKey || makeMaterialBatchKey(mesh?.material);
  return `${geometryKey}|mat:${materialKey}`;
}

export function canBatchMaterial(material) {
  const source = Array.isArray(material) ? material[0] : material;
  if (!source || Array.isArray(material)) return false;
  if (source.transparent || source.opacity < 1) return false;
  if (source.alphaMap || source.transmission > 0) return false;
  return true;
}

export function canBatchMesh(mesh) {
  if (!mesh || !mesh.isMesh || mesh.isInstancedMesh) return false;
  if (mesh.visible === false) return false;
  if (!mesh.geometry || !mesh.material) return false;
  if (!canBatchMaterial(mesh.material)) return false;
  const userData = mesh.userData || {};
  if (
    userData.skipBatching === true
    || userData.skipShaderApply === true
    || userData.isWater === true
    || userData.isSky === true
    || userData.isGlass === true
    || userData.isGizmo === true
    || userData.isHelper === true
    || userData.isEnvironment === true
    || userData.isEnvironmentObject === true
    || userData.isEditorObject === true
    || userData.isOutline === true
    || userData.shaderOutline === true
    || userData.isDebugMesh === true
    || userData.animated === true
  ) {
    return false;
  }
  if (mesh.isSkinnedMesh || mesh.morphTargetInfluences || mesh.morphTargetDictionary) return false;

  let current = mesh;
  while (current) {
    const name = String(current.name || '').toLowerCase();
    const type = String(current.type || '').toLowerCase();
    if (
      name.includes('water')
      || name.includes('sky')
      || name.includes('glass')
      || name.includes('gizmo')
      || name.includes('helper')
      || name.includes('grid')
      || name.includes('selection')
      || name.includes('debug')
      || name.includes('transformcontrols')
      || type.includes('helper')
      || type === 'transformcontrols'
      || current.name === 'TransformControlsPlane'
      || current.userData?.skipBatching === true
      || current.userData?.skipShaderApply === true
      || current.userData?.isStaticBatchRoot === true
    ) {
      return false;
    }
    current = current.parent;
  }
  return true;
}
