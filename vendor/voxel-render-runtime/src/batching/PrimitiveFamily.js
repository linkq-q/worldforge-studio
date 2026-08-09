/**
 * PrimitiveFamily — maps VoxelPart mesh data to batchable unit-geometry families.
 *
 * Phase 1.3: box, sphere, ellipsoid, cylinder, cone, frustum.
 * All families: opaque MeshStandardMaterial, matrix-scale mapping onto a shared
 * per-topology unit geometry. A primitive batches only with others of the same
 * family AND topology (segment counts, openEnded/theta, and — for frustum — the
 * top/bottom radius ratio) AND material signature.
 *
 * Authority: VoxelPart.mesh.{type,geometry,material} is the source of truth.
 * The unit geometries below MUST match js/LocalTemplates.js GEOMETRY_BUILDERS so
 * unit-geometry × matrix-scale is vertex-exact with the non-batched mesh path.
 */

import * as THREE from 'three';
import { DEFAULT_PBR_METALNESS, DEFAULT_PBR_ROUGHNESS } from '../materials/MaterialDefaults.js';

// ── Default geometry params (MUST mirror js/LocalTemplates.js GEOMETRY_BUILDERS) ──
// Defaults live HERE (not scattered in RenderCache) per the Phase 1.3 spec.
export const FAMILY_DEFAULTS = {
  sphere:   { widthSegments: 8, heightSegments: 6 },
  cylinder: { radialSegments: 8, heightSegments: 1, openEnded: false, thetaStart: 0, thetaLength: Math.PI * 2 },
  cone:     { radialSegments: 8, heightSegments: 1, openEnded: false, thetaStart: 0, thetaLength: Math.PI * 2 },
};

/** Quantize to 3 decimals — used for thetaStart/Length and frustum ratio. */
function q3(n) { return Math.round(Number(n) * 1000) / 1000; }

// ── Per-topology unit geometry cache (shared & long-lived, like the old _unitBox) ──
/** @type {Map<string, THREE.BufferGeometry>} topologyKey → unit geometry */
const _unitGeoCache = new Map();

/**
 * Build (or fetch cached) the unit geometry for a classification.
 * Keyed by topologyKey so all batches/models with the same topology share one
 * geometry. NOT disposed on scene reload (bounded set of topologies).
 * @param {Classification} c
 * @returns {THREE.BufferGeometry}
 */
export function buildUnitGeometry(c) {
  const key = c.topologyKey;
  let geo = _unitGeoCache.get(key);
  if (geo) return geo;
  const gp = c.geometryParams || {};
  switch (c.family) {
    case 'box':
      geo = new THREE.BoxGeometry(1, 1, 1);
      break;
    case 'sphere':
    case 'ellipsoid':
      // unit sphere; ellipsoid differs only by non-uniform instance scale
      geo = new THREE.SphereGeometry(1, gp.widthSegments, gp.heightSegments);
      break;
    case 'cylinder':
      geo = new THREE.CylinderGeometry(1, 1, 1, gp.radialSegments, gp.heightSegments, gp.openEnded, gp.thetaStart, gp.thetaLength);
      break;
    case 'cone':
      geo = new THREE.ConeGeometry(1, 1, gp.radialSegments, gp.heightSegments, gp.openEnded, gp.thetaStart, gp.thetaLength);
      break;
    case 'frustum':
      // unit frustum: top radius = ratio, bottom radius = 1, height = 1.
      // scaled by [radiusBottom, height, radiusBottom] → exact source frustum.
      geo = new THREE.CylinderGeometry(gp.radiusTopUnit, 1, 1, gp.radialSegments, gp.heightSegments, gp.openEnded, gp.thetaStart, gp.thetaLength);
      break;
    case 'icosahedron':
      geo = new THREE.IcosahedronGeometry(1, gp.detail);
      break;
    case 'torus':
      // unit torus: major radius 1, tube = tubeRatio. rotateX bakes the same
      // orientation LocalTemplates applies. Scaled uniformly by radius →
      // major = radius, tube = tubeRatio*radius = source tube (within q3 quant).
      geo = new THREE.TorusGeometry(1, gp.tubeRatio, gp.radialSegments, gp.tubularSegments);
      geo.rotateX(-Math.PI / 2);
      break;
    case 'wedge': {
      // unit right-triangle prism (w=h=d=1), MUST mirror LocalTemplates wedge():
      // Shape(-0.5,-0.5)→(0.5,-0.5)→(-0.5,0.5), extrude depth 1, translate -0.5 in z.
      // Right-angle vertex at local origin, legs on local X/Y → non-uniform
      // instance scale {w,h,d} stays shear-free and vertex-exact.
      const s = new THREE.Shape();
      s.moveTo(-0.5, -0.5); s.lineTo(0.5, -0.5); s.lineTo(-0.5, 0.5); s.closePath();
      geo = new THREE.ExtrudeGeometry(s, { steps: 1, depth: 1, bevelEnabled: false });
      geo.translate(0, 0, -0.5);
      geo.computeVertexNormals();
      break;
    }
    default:
      geo = new THREE.BoxGeometry(1, 1, 1);
  }
  _unitGeoCache.set(key, geo);
  return geo;
}

/**
 * @typedef {Object} Classification
 * @property {boolean} supported
 * @property {string} [reason] — when unsupported
 * @property {string} [family] — 'box'|'sphere'|'ellipsoid'|'cylinder'|'cone'|'frustum'
 * @property {string} [topologyKey]
 * @property {string} [materialKey]
 * @property {{x:number,y:number,z:number}} [instanceScale]
 * @property {object} [geometryParams]
 * @property {string} [geometryMode] — 'unit-matrix-scale'
 */

/**
 * Classify a VoxelPart into a batchable family (pure — no THREE, no material gating).
 * cylinder splits into 'cylinder' (radiusTop==radiusBottom) vs 'frustum' (≠).
 * @param {import('../../js/core/VoxelData.js').VoxelPart} part
 * @returns {Classification}
 */
export function classify(part) {
  if (part?.isGroup) return { supported: false, reason: 'is-group' };
  if (!part?.mesh) return { supported: false, reason: 'no-mesh' };
  const m = part.mesh;
  const type = String(m.type || '').toLowerCase();
  const g = m.geometry || {};
  const MODE = 'unit-matrix-scale';

  switch (type) {
    case 'box': {
      const w = g.width || 1, h = g.height || 1, d = g.depth || 1;
      if (w <= 0 || h <= 0 || d <= 0) return { supported: false, reason: 'invalid-scale' };
      return { supported: true, family: 'box', topologyKey: 'box:unit', geometryMode: MODE,
        geometryParams: {}, instanceScale: { x: w, y: h, z: d } };
    }
    case 'sphere': {
      const r = g.radius || 1; // matches LocalTemplates: radius||1 (0 → default 1)
      if (r < 0) return { supported: false, reason: 'invalid-scale' };
      const ws = g.widthSegments || FAMILY_DEFAULTS.sphere.widthSegments;
      const hs = g.heightSegments || FAMILY_DEFAULTS.sphere.heightSegments;
      return { supported: true, family: 'sphere', topologyKey: `sphere:ws=${ws}:hs=${hs}`, geometryMode: MODE,
        geometryParams: { widthSegments: ws, heightSegments: hs }, instanceScale: { x: r, y: r, z: r } };
    }
    case 'ellipsoid': {
      const rx = g.radiusX || g.radius || 1;
      const ry = g.radiusY || g.radius || 1;
      const rz = g.radiusZ || g.radius || 1;
      if (rx < 0 || ry < 0 || rz < 0) return { supported: false, reason: 'invalid-scale' };
      const ws = g.widthSegments || FAMILY_DEFAULTS.sphere.widthSegments;
      const hs = g.heightSegments || FAMILY_DEFAULTS.sphere.heightSegments;
      return { supported: true, family: 'ellipsoid', topologyKey: `ellipsoid:ws=${ws}:hs=${hs}`, geometryMode: MODE,
        geometryParams: { widthSegments: ws, heightSegments: hs }, instanceScale: { x: rx, y: ry, z: rz } };
    }
    case 'cylinder': {
      const rt = g.radiusTop != null ? g.radiusTop : 1;
      const rb = g.radiusBottom != null ? g.radiusBottom : 1;
      const h = g.height || 1;
      if (h <= 0 || rt < 0 || rb < 0) return { supported: false, reason: 'invalid-scale' };
      const rs = g.radialSegments || FAMILY_DEFAULTS.cylinder.radialSegments;
      const hs = g.heightSegments || FAMILY_DEFAULTS.cylinder.heightSegments;
      const open = g.openEnded === true;
      const ts = g.thetaStart || 0;
      const tl = g.thetaLength != null ? g.thetaLength : FAMILY_DEFAULTS.cylinder.thetaLength;
      const topoTail = `rs=${rs}:hs=${hs}:open=${open}:ts=${q3(ts)}:tl=${q3(tl)}`;
      if (Math.abs(rt - rb) < 1e-6) {
        const r = rt;
        if (r <= 0) return { supported: false, reason: 'invalid-scale' };
        return { supported: true, family: 'cylinder', topologyKey: `cylinder:${topoTail}`, geometryMode: MODE,
          geometryParams: { radialSegments: rs, heightSegments: hs, openEnded: open, thetaStart: ts, thetaLength: tl },
          instanceScale: { x: r, y: h, z: r } };
      }
      // radiusTop != radiusBottom → frustum. Must NOT mix into cylinder batches.
      if (rb <= 0) return { supported: false, reason: 'invalid-scale' };
      const ratio = q3(rt / rb);
      return { supported: true, family: 'frustum', topologyKey: `frustum:ratio=${ratio}:${topoTail}`, geometryMode: MODE,
        geometryParams: { radiusTopUnit: ratio, ratio, radialSegments: rs, heightSegments: hs, openEnded: open, thetaStart: ts, thetaLength: tl },
        instanceScale: { x: rb, y: h, z: rb } };
    }
    case 'cone': {
      const r = g.radius || 1; // matches LocalTemplates: radius||1
      const h = g.height || 1;
      if (r < 0 || h < 0) return { supported: false, reason: 'invalid-scale' };
      const rs = g.radialSegments || FAMILY_DEFAULTS.cone.radialSegments;
      const hs = g.heightSegments || FAMILY_DEFAULTS.cone.heightSegments;
      const open = g.openEnded === true;
      const ts = g.thetaStart || 0;
      const tl = g.thetaLength != null ? g.thetaLength : FAMILY_DEFAULTS.cone.thetaLength;
      return { supported: true, family: 'cone', topologyKey: `cone:rs=${rs}:hs=${hs}:open=${open}:ts=${q3(ts)}:tl=${q3(tl)}`, geometryMode: MODE,
        geometryParams: { radialSegments: rs, heightSegments: hs, openEnded: open, thetaStart: ts, thetaLength: tl },
        instanceScale: { x: r, y: h, z: r } };
    }
    case 'icosahedron': {
      const r = g.radius || 1; // matches LocalTemplates: radius||1
      if (r < 0) return { supported: false, reason: 'invalid-scale' };
      const detail = g.detail || 0;
      return { supported: true, family: 'icosahedron', topologyKey: `icosahedron:detail=${detail}`, geometryMode: MODE,
        geometryParams: { detail }, instanceScale: { x: r, y: r, z: r } };
    }
    case 'torus': {
      const r = g.radius || 1;    // matches LocalTemplates: radius||1
      const tube = g.tube || 0.3; // matches LocalTemplates: tube||0.3
      if (r <= 0 || tube < 0) return { supported: false, reason: 'invalid-scale' };
      // torus uses UNIFORM instance scale (radius). Non-uniform object scale would
      // shear the ring out of TorusGeometry(radius,tube) semantics → keep it fallback.
      const psx = part.scale?.x ?? 1, psy = part.scale?.y ?? 1, psz = part.scale?.z ?? 1;
      if (Math.abs(psx - psy) > 1e-6 || Math.abs(psy - psz) > 1e-6) {
        return { supported: false, reason: 'torus-nonuniform-scale' };
      }
      const rs = g.radialSegments || 8;    // LocalTemplates default 8
      const ts = g.tubularSegments || 12;  // LocalTemplates default 12
      // tubeRatio = tube/radius is baked into topology; radius is the uniform scale.
      // Quantized so floating tube/radius noise doesn't shatter batches.
      const tubeRatio = q3(tube / r);
      return { supported: true, family: 'torus', topologyKey: `torus:rs=${rs}:ts=${ts}:tubeRatio=${tubeRatio}`, geometryMode: MODE,
        geometryParams: { tubeRatio, radialSegments: rs, tubularSegments: ts }, instanceScale: { x: r, y: r, z: r } };
    }
    case 'wedge': {
      const w = g.width || 1, h = g.height || 1, d = g.depth || 1;
      if (w <= 0 || h <= 0 || d <= 0) return { supported: false, reason: 'invalid-scale' };
      // Right-triangle prism: shape is fixed (no segments), so one unit topology.
      // Legs align to local X/Y → {w,h,d} scale is shear-free (non-uniform OK).
      return { supported: true, family: 'wedge', topologyKey: 'wedge:unit', geometryMode: MODE,
        geometryParams: {}, instanceScale: { x: w, y: h, z: d } };
    }
    case 'tri':
    case 'patch':
      // Arbitrary-vertex geometry: NOT unit-geometry + matrix-scale expressible.
      // Batched via per-part geometry in a THREE.BatchedMesh (geometryMode below).
      // No topologyKey/instanceScale meaning — the batcher buckets these by
      // materialKey and builds each part's real geometry. instanceScale=1 so the
      // part transform applies to the real local coords unchanged.
      return { supported: true, family: type, geometryMode: 'batched-mesh',
        topologyKey: `${type}:batched`, geometryParams: {}, instanceScale: { x: 1, y: 1, z: 1 } };
    default:
      return { supported: false, reason: `unsupported-family:${type || 'unknown'}` };
  }
}

/**
 * Build a lightweight family object from a classification, exposing the small
 * surface AIPrimitiveBatcher expects (name, getUnitGeometry, makeTopologyKey,
 * shapeMappingMode). getUnitGeometry closes over the classification so no-arg
 * calls (existing call sites) still work and stay topology-correct.
 * @param {Classification} c
 */
function makeFamilyObject(c) {
  return {
    name: c.family,
    shapeMappingMode: c.geometryMode === 'batched-mesh' ? 'batched-mesh' : 'matrix-scale',
    classification: c,
    getUnitGeometry() { return buildUnitGeometry(c); },
    makeTopologyKey() { return c.topologyKey; },
    extractScale() { return c.instanceScale; },
  };
}

/**
 * Back-compat shim. Returns a minimal family object for a primitive type using
 * default params (no per-part geometry). Prefer assessPart()/classify().
 * @param {string} primitiveType
 * @returns {object|null}
 */
export function getFamily(primitiveType) {
  const c = classify({ mesh: { type: primitiveType, geometry: {} } });
  return c.supported ? makeFamilyObject(c) : null;
}

/**
 * Check if a VoxelPart is eligible for source-level batching.
 * Phase 1.3: box/sphere/ellipsoid/cylinder/cone/frustum, opaque
 * MeshStandardMaterial, no textures/transparency/shader/alphaTest.
 *
 * @param {import('../../js/core/VoxelData.js').VoxelPart} part
 * @param {{renderMode?: string, celAllowed?: boolean}} options
 * @returns {{ eligible: boolean, reason?: string, family?: object, scale?: {x:number,y:number,z:number}, classification?: Classification }}
 */
export function assessPart(part, options = {}) {
  const renderMode = options.renderMode || 'pbr';
  const celAllowed = options.celAllowed === true;

  // Must be a mesh part
  if (part.isGroup) return { eligible: false, reason: 'is-group' };
  if (!part.mesh) return { eligible: false, reason: 'no-mesh' };
  if (part.materialTagBaseRecipe?.batchPolicy === 'standaloneOnly') {
    return { eligible: false, reason: 'material-tag-standalone-only' };
  }
  if (part.materialTagRequiresRuntimeStandalone === true) {
    return { eligible: false, reason: 'material-tag-runtime-effects' };
  }

  // Geometry/topology classification (family split happens here)
  const c = classify(part);
  if (!c.supported) return { eligible: false, reason: c.reason };

  // Material checks (opaque PBR MeshStandardMaterial only)
  const mat = part.mesh.material || {};
  if (mat.transparent === true) return { eligible: false, reason: 'transparent' };
  if (Number(mat.opacity ?? 1) < 0.999) return { eligible: false, reason: 'opacity-lt-one' };
  if (Number(mat.alphaTest ?? 0) > 0) return { eligible: false, reason: 'alpha-test' };
  if (mat.depthWrite === false) return { eligible: false, reason: 'depth-write-false' };
  if (mat.blending && mat.blending !== THREE.NormalBlending) return { eligible: false, reason: 'non-normal-blending' };
  if (mat.map || mat.normalMap || mat.alphaMap || mat.bumpMap || mat.roughnessMap || mat.metalnessMap) return { eligible: false, reason: 'has-texture' };
  if (mat.isShaderMaterial === true) return { eligible: false, reason: 'shader-material' };

  // CEL mode: skip unless explicitly allowed
  if (renderMode === 'cel' && !celAllowed) return { eligible: false, reason: 'cel-mode-disabled' };

  // BatchedMesh path (tri/patch) is opt-in per host — off by default so the
  // js/main runtime keeps falling these back to independent meshes unchanged.
  if (c.geometryMode === 'batched-mesh' && options.batchedMeshAllowed !== true) {
    return { eligible: false, reason: 'batched-mesh-disabled' };
  }

  return { eligible: true, family: makeFamilyObject(c), scale: c.instanceScale, classification: c };
}

/**
 * Build a material batch key from VoxelPart material params.
 * color + roughness + metalness + flatShading. Textures/transparency excluded
 * (those parts are already filtered out by assessPart).
 *
 * @param {object} material — part.mesh.material
 * @returns {string}
 */
export function makeMaterialKey(material) {
  const m = material || {};
  let color = 'cccccc';
  if (typeof m.color === 'number') {
    color = m.color.toString(16).padStart(6, '0');
  } else if (typeof m.color === 'string') {
    color = m.color.trim().replace(/^#/, '').toLowerCase() || color;
  }
  const roughness = Number(m.roughness ?? DEFAULT_PBR_ROUGHNESS).toFixed(3);
  const metalness = Number(m.metalness ?? DEFAULT_PBR_METALNESS).toFixed(3);
  const flatShading = m.flatShading !== false ? 'flat' : 'smooth';
  return `mat:c=${color},r=${roughness},m=${metalness},fs=${flatShading}`;
}

/**
 * Build a full batch key for a VoxelPart: family + topology + mode + material.
 * Two parts batch together iff this key matches.
 *
 * @param {import('../../js/core/VoxelData.js').VoxelPart} part
 * @param {object} family — from assessPart().family
 * @returns {string}
 */
export function makeBatchKey(part, family) {
  const topo = family.makeTopologyKey(part);
  const matKey = makeMaterialKey(part.mesh?.material);
  const baseKey = part.materialTagBaseRecipe?.key || 'default';
  const mode = family.shapeMappingMode;
  return `${family.name}:${topo}:${mode}:${matKey}:base=${baseKey}`;
}

/** Family name from a batchKey (first ':'-delimited segment). */
export function familyFromBatchKey(batchKey) {
  if (!batchKey) return 'unknown';
  const i = String(batchKey).indexOf(':');
  return i === -1 ? String(batchKey) : String(batchKey).slice(0, i);
}

/**
 * Compute the accumulated local-to-model-root matrix from a part's parent group chain.
 * Returns identity if the part has no parent groups.
 *
 * Walks from immediate parent up to root, multiplying T*R*S for each group.
 * Result is: T(p1)*R(p1)*S(p1) * T(p2)*R(p2)*S(p2) * ...
 * where p1 is the immediate parent, p2 is the grandparent, etc.
 *
 * @param {object} model — VoxelModel with .getPart(id) method
 * @param {object} part — VoxelPart whose parent chain to compute
 * @param {THREE.Matrix4} [target] — optional output matrix
 * @returns {THREE.Matrix4}
 */
export function computeParentChainMatrix(model, part, target) {
  const m = target || new THREE.Matrix4();
  m.identity();
  if (!part?.parent || !model?.getPart) return m;

  // Collect ancestors from immediate parent up to root
  const ancestors = [];
  let currentId = part.parent;
  const visited = new Set();
  while (currentId) {
    if (visited.has(currentId)) break; // cycle guard
    visited.add(currentId);
    const parent = model.getPart(currentId);
    if (!parent) break;
    ancestors.push(parent);
    currentId = parent.parent;
  }

  // Build from root-most ancestor down to immediate parent
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const p = ancestors[i];
    const pt = new THREE.Matrix4().makeTranslation(
      p.offset.x || 0, p.offset.y || 0, p.offset.z || 0
    );
    let pr = null;
    if (p.quaternion) {
      pr = new THREE.Matrix4().makeRotationFromQuaternion(
        new THREE.Quaternion(p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w)
      );
    } else if (p.rotation) {
      const rx = p.rotation.x || 0, ry = p.rotation.y || 0, rz = p.rotation.z || 0;
      if (rx !== 0 || ry !== 0 || rz !== 0) {
        pr = new THREE.Matrix4().makeRotationFromEuler(
          new THREE.Euler(rx, ry, rz, 'XYZ')
        );
      }
    }
    const psc = new THREE.Matrix4().makeScale(
      p.scale?.x ?? 1, p.scale?.y ?? 1, p.scale?.z ?? 1
    );
    // Build parent local: T * R * S
    const local = new THREE.Matrix4();
    if (pr) {
      local.multiplyMatrices(pt, pr).multiply(psc);
    } else {
      local.multiplyMatrices(pt, psc);
    }
    // Accumulate: m = m * local (root→leaf order)
    m.multiply(local);
  }

  return m;
}

/**
 * Compute instance matrix for a VoxelPart in a batch.
 * Uses unit geometry → matrix scale from geometry params.
 * Also applies part.offset, part.quaternion/rotation, and the full parent group chain.
 *
 * The result is the part's local-to-model-root transform, matching what
 * Three.js scene hierarchy produces for a non-batched Group child.
 *
 * @param {import('../../js/core/VoxelData.js').VoxelPart} part
 * @param {{x:number,y:number,z:number}} scale — from family.extractScale (geometry dims only)
 * @param {THREE.Matrix4} [target] — optional output matrix
 * @param {THREE.Matrix4} [parentChainMatrix] — accumulated local matrix from parent groups (root→immediate parent)
 * @param {THREE.Matrix4} [rootGroupWorldMatrix] — optional model-root world matrix. When null
 *   (the default), the result stays in model-local space, matching legacy per-model batch behavior.
 *   When provided, the instance is composed in world space (rootWorld * parentChain * partLocal),
 *   so a single shared batch can hold instances from differently-transformed model roots.
 * @returns {THREE.Matrix4}
 */
export function computeInstanceMatrix(part, scale, target, parentChainMatrix, rootGroupWorldMatrix = null) {
  // Combine geometry-derived scale (width/height/depth) with part-level transform.scale.
  // Non-batched VoxelRenderer._buildMeshPart applies part.scale via mesh.scale.set(),
  // so we must replicate that here for visual equivalence.
  const psx = (part.scale?.x ?? 1);
  const psy = (part.scale?.y ?? 1);
  const psz = (part.scale?.z ?? 1);
  const sx = scale.x * psx;
  const sy = scale.y * psy;
  const sz = scale.z * psz;

  // Build part-local TRS matrix (Three.js Object3D convention: M = T * R * S)
  const translation = new THREE.Matrix4().makeTranslation(
    part.offset.x, part.offset.y, part.offset.z
  );

  let rotation = null;
  if (part.quaternion) {
    const q = new THREE.Quaternion(
      part.quaternion.x, part.quaternion.y, part.quaternion.z, part.quaternion.w
    );
    rotation = new THREE.Matrix4().makeRotationFromQuaternion(q);
  } else if (part.rotation) {
    const rx = part.rotation.x || 0;
    const ry = part.rotation.y || 0;
    const rz = part.rotation.z || 0;
    if (rx !== 0 || ry !== 0 || rz !== 0) {
      rotation = new THREE.Matrix4().makeRotationFromEuler(
        new THREE.Euler(rx, ry, rz, 'XYZ')
      );
    }
  }

  const scaleMat = new THREE.Matrix4().makeScale(sx, sy, sz);
  const m = target || new THREE.Matrix4();

  // Build part-local matrix: T_p * R_p * S_p
  if (rotation) {
    m.multiplyMatrices(translation, rotation).multiply(scaleMat);
  } else {
    m.multiplyMatrices(translation, scaleMat);
  }

  // Prepend parent chain: parentChain * partLocal
  // InstancedMesh is a direct child of model rootGroup, so the instance matrix
  // must encode the full local-to-model-root transform including parent groups.
  if (parentChainMatrix) {
    m.multiplyMatrices(parentChainMatrix, m);
  }

  // Optionally lift into world space: rootWorld * (parentChain * partLocal).
  // Null keeps the legacy model-local result.
  if (rootGroupWorldMatrix) {
    m.multiplyMatrices(rootGroupWorldMatrix, m);
  }

  return m;
}
