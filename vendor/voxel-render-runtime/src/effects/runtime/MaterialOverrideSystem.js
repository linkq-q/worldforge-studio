import * as THREE from 'three';
import { createInkSurfaceMaterial } from '../../materials/InkSurfaceMaterial.js';
import { addMaterialShaderPatch } from '../../utils/MaterialShaderPatchChain.js';
import { RENDER_ORDER } from '../../render/RenderOrders.js';

function colorFrom(value, fallback = [1, 1, 1]) {
  if (value instanceof THREE.Color) return value.clone ? value.clone() : new THREE.Color(value);
  if (Array.isArray(value)) return new THREE.Color(value[0], value[1], value[2]);
  if (typeof value === 'number' || typeof value === 'string') return new THREE.Color(value);
  return new THREE.Color(fallback[0], fallback[1], fallback[2]);
}

function visitMeshes(target, callback) {
  if (!target) return 0;
  let count = 0;
  if (target.isMesh && !target.isInstancedMesh) {
    callback(target);
    return 1;
  }
  if (typeof target.traverse === 'function') {
    target.traverse((object) => {
      if (!object.isMesh || object.isInstancedMesh) return;
      callback(object);
      count++;
    });
  }
  return count;
}

function ensureOriginalMaterial(mesh) {
  if (!mesh?.userData) return;
  if (!mesh.userData.effectOriginalMaterial) {
    mesh.userData.effectOriginalMaterial = mesh.material || null;
    mesh.userData.effectOriginalRenderOrder = mesh.renderOrder;
  }
}

// ── RoundedBoxGeometry ──────────────────────────────────────────────
// Creates a box with rounded edges/corners for better glass reflections.
// Uses SDF-based vertex displacement on a higher-segment BoxGeometry.

function createRoundedBoxGeometry(width, height, depth, radius, segments = 2) {
  const seg = Math.max(1, Math.round(segments));
  const geometry = new THREE.BoxGeometry(width, height, depth, seg * 2, seg * 2, seg * 2);

  const pos = geometry.attributes.position;
  const halfW = width / 2;
  const halfH = height / 2;
  const halfD = depth / 2;
  const innerW = Math.max(0.0001, halfW - radius);
  const innerH = Math.max(0.0001, halfH - radius);
  const innerD = Math.max(0.0001, halfD - radius);

  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);

    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);

    // Only modify vertices that protrude beyond the inner box
    if (ax > innerW || ay > innerH || az > innerD) {
      const ex = Math.max(0, ax - innerW);
      const ey = Math.max(0, ay - innerH);
      const ez = Math.max(0, az - innerD);
      const cornerLen = Math.sqrt(ex * ex + ey * ey + ez * ez);

      if (cornerLen > 0.0001) {
        const scale = Math.min(1, radius / cornerLen);
        x = Math.sign(x) * (innerW + ex * scale);
        y = Math.sign(y) * (innerH + ey * scale);
        z = Math.sign(z) * (innerD + ez * scale);
      }
    }

    pos.setXYZ(i, x, y, z);
  }

  geometry.computeVertexNormals();
  return geometry;
}

function isBoxLikeGeometry(geometry) {
  if (!geometry) return false;
  // Check by type name
  if (geometry.type === 'BoxGeometry') return true;
  // Check by constructor name (subclasses or wrapped)
  const ctorName = geometry.constructor?.name || '';
  if (ctorName.includes('BoxGeometry')) return true;
  return false;
}

function getBoxDimensions(geometry) {
  if (!geometry?.attributes?.position) return null;
  const pos = geometry.attributes.position;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return {
    width: maxX - minX,
    height: maxY - minY,
    depth: maxZ - minZ,
    minDim: Math.min(maxX - minX, maxY - minY, maxZ - minZ),
  };
}

function estimateGlassThickness(target, fallback = 0.25) {
  const dims = getBoxDimensions(target?.geometry);
  if (!dims || !Number.isFinite(dims.minDim) || dims.minDim <= 0) return fallback;
  const scale = target?.scale;
  const scaledDims = [
    dims.width * Math.abs(scale?.x ?? 1),
    dims.height * Math.abs(scale?.y ?? 1),
    dims.depth * Math.abs(scale?.z ?? 1),
  ].filter(value => Number.isFinite(value) && value > 0.0001);
  if (scaledDims.length === 0) return fallback;
  return Math.min(1.5, Math.max(0.05, Math.min(...scaledDims) * 0.35));
}

// ── Fresnel rim injection (P3) ─────────────────────────────────────
// Enabled through the shared MaterialShaderPatchChain so it composes with
// matcap, toon and effect-layer patches without replacing onBeforeCompile.

const FRESNEL_INJECT_MARKER = '__glassFresnelInjected';
const FRESNEL_PATCH_KEY = 'glassFresnel';

let _fresnelInjectionEnabled = true;

function isFresnelInjectionEnabled() {
  return _fresnelInjectionEnabled === true;
}

function enableFresnelInjection() {
  _fresnelInjectionEnabled = true;
  console.log('[GlassFresnel] P3 fresnel rim injection ENABLED (experimental)');
}

function disableFresnelInjection() {
  _fresnelInjectionEnabled = false;
  console.log('[GlassFresnel] P3 fresnel rim injection DISABLED');
}

function injectFresnelRim(material, params) {
  if (!isFresnelInjectionEnabled()) return;
  if (!material || material.userData?.[FRESNEL_INJECT_MARKER]) return;
  if (!('onBeforeCompile' in material)) return;

  const strength = params.fresnelStrength ?? 0.16;
  const power = params.fresnelPower ?? 2.0;
  const fresnelColor = colorFrom(params.fresnelColor || params.color || [0.985, 0.995, 1.0]);
  const attenuationColor = colorFrom(params.attenuationColor || [0.96, 0.99, 1.0]);
  const fresnelUniforms = {
    uGlassFresnelStrength: { value: strength },
    uGlassFresnelPower: { value: power },
    uGlassFresnelColor: { value: fresnelColor.clone() },
    uGlassFacetStrength: { value: params.facetStrength ?? 0.08 },
    uGlassDistortion: { value: params.distortion ?? 0.008 },
    uGlassScreenEdgeFade: { value: params.screenEdgeFade ?? 0.08 },
    uGlassSurfaceVariation: { value: params.surfaceVariation ?? 0.035 },
    uGlassSurfaceScale: { value: params.surfaceScale ?? 6.0 },
    uGlassEdgeTintStrength: { value: params.edgeTintStrength ?? 0.18 },
    uGlassAttenuationColor: { value: attenuationColor.clone() },
  };

  addMaterialShaderPatch(material, FRESNEL_PATCH_KEY, (shader) => {
    // Read latest fresnel params from userData (updated by tweak panel)
    const fData = material.userData._glassFresnelUniforms || {};

    // ── Uniforms ──
    Object.assign(shader.uniforms, fData.uniforms || fresnelUniforms);

    // ── Vertex: add varyings (outside main) + assignments (inside main) ──
    // Compute view-direction and view-space normal for consistent NdotV rim.
    // Step 1: declare varyings at module scope, before void main
    shader.vertexShader = shader.vertexShader.replace(
      /void main\s*\(\s*\)\s*\{/,
      `varying vec3 vFnViewPosition;
varying vec3 vFnViewNormal;
varying vec3 vFnWorldPosition;
void main() {`
    );
    // Step 2: assign varyings as first statements inside main body
    shader.vertexShader = shader.vertexShader.replace(
      /(\bvoid main\s*\(\s*\)\s*\{)/,
      `$1
  vFnViewPosition = -(modelViewMatrix * vec4(position, 1.0)).xyz;
  vFnViewNormal = normalize(mat3(modelViewMatrix) * normal.xyz);
  vFnWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;`
    );

    // ── Fragment: add uniforms + varyings at top ──
    shader.fragmentShader = `
      uniform float uGlassFresnelStrength;
      uniform float uGlassFresnelPower;
      uniform vec3 uGlassFresnelColor;
      uniform float uGlassFacetStrength;
      uniform float uGlassDistortion;
      uniform float uGlassScreenEdgeFade;
      uniform float uGlassSurfaceVariation;
      uniform float uGlassSurfaceScale;
      uniform float uGlassEdgeTintStrength;
      uniform vec3 uGlassAttenuationColor;
      varying vec3 vFnViewPosition;
      varying vec3 vFnViewNormal;
      varying vec3 vFnWorldPosition;
    ` + shader.fragmentShader;

    const roughnessAnchor = '#include <roughnessmap_fragment>';
    if (shader.fragmentShader.includes(roughnessAnchor)) {
      shader.fragmentShader = shader.fragmentShader.replace(
        roughnessAnchor,
        `${roughnessAnchor}
  float fnGlassSurface = sin(dot(vFnWorldPosition, vec3(0.73, 1.21, 1.57)) * uGlassSurfaceScale);
  fnGlassSurface *= sin(dot(vFnWorldPosition, vec3(-1.13, 0.61, 0.89)) * uGlassSurfaceScale * 0.63);
  roughnessFactor = clamp(roughnessFactor + fnGlassSurface * uGlassSurfaceVariation, 0.02, 1.0);`
      );
    }

    const transmissionChunk = THREE.ShaderChunk?.transmission_pars_fragment;
    if (transmissionChunk && shader.fragmentShader.includes('#include <transmission_pars_fragment>')) {
      const stableTransmissionChunk = transmissionChunk.replace(
        'refractionCoords /= 2.0;',
        `refractionCoords /= 2.0;
        vec2 glassUnrefractedCoords = gl_FragCoord.xy / transmissionSamplerSize;
        float glassEdgeDistance = min(min(refractionCoords.x, refractionCoords.y), min(1.0 - refractionCoords.x, 1.0 - refractionCoords.y));
        float glassEdgeWeight = smoothstep(0.0, max(uGlassScreenEdgeFade, 0.0001), glassEdgeDistance);
        refractionCoords = mix(glassUnrefractedCoords, clamp(refractionCoords, vec2(0.001), vec2(0.999)), glassEdgeWeight);`
      );
      shader.fragmentShader = shader.fragmentShader.replace('#include <transmission_pars_fragment>', stableTransmissionChunk);
    }

    const transmissionAnchor = '#include <transmission_fragment>';
    if (shader.fragmentShader.includes(transmissionAnchor)) {
      shader.fragmentShader = shader.fragmentShader.replace(
        transmissionAnchor,
        `{
  vec3 fnFaceNormal = normalize(cross(dFdx(vFnViewPosition), dFdy(vFnViewPosition)));
  fnFaceNormal *= dot(fnFaceNormal, normal) < 0.0 ? -1.0 : 1.0;
  normal = normalize(mix(normal, fnFaceNormal, clamp(uGlassDistortion * 6.0, 0.0, 0.24)));
}
${transmissionAnchor}`
      );
    }

    // ── Fragment: add rim to outgoingLight before gl_FragColor ──
    // MeshPhysicalMaterial computes `outgoingLight` then assigns
    // `gl_FragColor = vec4(outgoingLight, ...)`. We inject rim just
    // before that assignment so it composes with all lighting.
    const rimCode = `
  vec3 fnViewDir = normalize(vFnViewPosition);
  vec3 fnNormal = normalize(vFnViewNormal);
  float fnNdotV = abs(dot(fnNormal, fnViewDir));
  vec3 fnFaceNormal = normalize(cross(dFdx(vFnViewPosition), dFdy(vFnViewPosition)));
  fnFaceNormal *= dot(fnFaceNormal, fnNormal) < 0.0 ? -1.0 : 1.0;
  float fnEdge = clamp(1.0 - fnNdotV, 0.0, 1.0);
  float fnFacetLight = smoothstep(0.42, 0.82, dot(abs(fnFaceNormal), normalize(vec3(0.48, 0.78, 0.39))));
  float fnFresnel = pow(fnEdge, uGlassFresnelPower) * uGlassFresnelStrength + fnFacetLight * fnEdge * uGlassFacetStrength;
  gl_FragColor.rgb *= mix(vec3(1.0), uGlassAttenuationColor, fnEdge * fnEdge * uGlassEdgeTintStrength);
  gl_FragColor.rgb += uGlassFresnelColor * fnFresnel;`;
    const legacyRimCode = rimCode
      .replace('gl_FragColor.rgb *=', 'outgoingLight *=')
      .replace('gl_FragColor.rgb +=', 'outgoingLight +=');

    // Primary pattern: `gl_FragColor = vec4( outgoingLight, ...`
    const anchor = '#include <tonemapping_fragment>';
    let injected = shader.fragmentShader.includes(anchor);
    if (injected) shader.fragmentShader = shader.fragmentShader.replace(anchor, `${rimCode}\n${anchor}`);

    // Fallback 1: `gl_FragColor = vec4(outgoingLight, ...` (no spaces)
    if (!injected) {
      shader.fragmentShader = shader.fragmentShader.replace(
        /(gl_FragColor\s*=\s*vec4\(outgoingLight,)/,
        legacyRimCode + '\n  $1'
      );
      injected = shader.fragmentShader.includes('fnFresnel');
    }

    // Fallback 2: physical material uses `diffuseColor.a` not `opacity`
    if (!injected) {
      shader.fragmentShader = shader.fragmentShader.replace(
        /(gl_FragColor\s*=\s*vec4\(\s*outgoingLight\s*,\s*)([^;)]+)/,
        (match, prefix, alphaExpr) => legacyRimCode + `\n  gl_FragColor = vec4(outgoingLight, ${alphaExpr});`
      );
      // Remove the original line (it's now replaced by the block above)
      injected = shader.fragmentShader.includes('fnFresnel');
    }

    if (!injected) {
      console.warn('[GlassFresnel] Could not inject rim — gl_FragColor pattern not found. Rim highlight disabled.');
      material.userData[FRESNEL_INJECT_MARKER] = false;
      return;
    }
  }, { order: 220, cacheKey: () => 'glass-rim-v3' });

  material.userData[FRESNEL_INJECT_MARKER] = true;
  material.userData._glassFresnelUniforms = {
    strength,
    power,
    color: fresnelColor,
    facetStrength: params.facetStrength ?? 0.08,
    distortion: params.distortion ?? 0.008,
    screenEdgeFade: params.screenEdgeFade ?? 0.08,
    surfaceVariation: params.surfaceVariation ?? 0.035,
    surfaceScale: params.surfaceScale ?? 6.0,
    edgeTintStrength: params.edgeTintStrength ?? 0.18,
    attenuationColor,
    uniforms: fresnelUniforms,
  };
}

function updateFresnelUniforms(material, params) {
  if (!material?.userData?.[FRESNEL_INJECT_MARKER]) return false;
  // Store updated params for the next onBeforeCompile invocation.
  // customProgramCacheKey is already set (idempotent — we don't re-wrap).
  // Just force needsUpdate so the shader recompiles and picks up new uniforms.
  const data = material.userData._glassFresnelUniforms || {};
  if (params.fresnelStrength !== undefined) data.strength = params.fresnelStrength;
  if (params.fresnelPower !== undefined) data.power = params.fresnelPower;
  if (params.fresnelColor !== undefined) data.color = colorFrom(params.fresnelColor);
  if (params.facetStrength !== undefined) data.facetStrength = params.facetStrength;
  if (params.distortion !== undefined) data.distortion = params.distortion;
  if (params.screenEdgeFade !== undefined) data.screenEdgeFade = params.screenEdgeFade;
  if (params.surfaceVariation !== undefined) data.surfaceVariation = params.surfaceVariation;
  if (params.surfaceScale !== undefined) data.surfaceScale = params.surfaceScale;
  if (params.edgeTintStrength !== undefined) data.edgeTintStrength = params.edgeTintStrength;
  if (params.attenuationColor !== undefined) data.attenuationColor = colorFrom(params.attenuationColor);
  if (params.fresnelStrength !== undefined && data.uniforms?.uGlassFresnelStrength) {
    data.uniforms.uGlassFresnelStrength.value = params.fresnelStrength;
  }
  if (params.fresnelPower !== undefined && data.uniforms?.uGlassFresnelPower) {
    data.uniforms.uGlassFresnelPower.value = params.fresnelPower;
  }
  if (params.fresnelColor !== undefined && data.uniforms?.uGlassFresnelColor) {
    data.uniforms.uGlassFresnelColor.value.copy(data.color);
  }
  if (params.facetStrength !== undefined && data.uniforms?.uGlassFacetStrength) {
    data.uniforms.uGlassFacetStrength.value = params.facetStrength;
  }
  if (params.distortion !== undefined && data.uniforms?.uGlassDistortion) {
    data.uniforms.uGlassDistortion.value = params.distortion;
  }
  if (params.screenEdgeFade !== undefined && data.uniforms?.uGlassScreenEdgeFade) {
    data.uniforms.uGlassScreenEdgeFade.value = params.screenEdgeFade;
  }
  if (params.surfaceVariation !== undefined && data.uniforms?.uGlassSurfaceVariation) {
    data.uniforms.uGlassSurfaceVariation.value = params.surfaceVariation;
  }
  if (params.surfaceScale !== undefined && data.uniforms?.uGlassSurfaceScale) {
    data.uniforms.uGlassSurfaceScale.value = params.surfaceScale;
  }
  if (params.edgeTintStrength !== undefined && data.uniforms?.uGlassEdgeTintStrength) {
    data.uniforms.uGlassEdgeTintStrength.value = params.edgeTintStrength;
  }
  if (params.attenuationColor !== undefined && data.uniforms?.uGlassAttenuationColor) {
    data.uniforms.uGlassAttenuationColor.value.copy(data.attenuationColor);
  }
  material.userData._glassFresnelUniforms = data;

  // Sync glassParams so customProgramCacheKey reflects updated values
  const gp = material.userData.glassParams || {};
  if (params.fresnelStrength !== undefined) gp.fresnelStrength = params.fresnelStrength;
  if (params.fresnelPower !== undefined) gp.fresnelPower = params.fresnelPower;
  if (params.fresnelColor !== undefined) gp.fresnelColor = params.fresnelColor;
  if (params.facetStrength !== undefined) gp.facetStrength = params.facetStrength;
  if (params.distortion !== undefined) gp.distortion = params.distortion;
  if (params.screenEdgeFade !== undefined) gp.screenEdgeFade = params.screenEdgeFade;
  if (params.surfaceVariation !== undefined) gp.surfaceVariation = params.surfaceVariation;
  if (params.surfaceScale !== undefined) gp.surfaceScale = params.surfaceScale;
  if (params.edgeTintStrength !== undefined) gp.edgeTintStrength = params.edgeTintStrength;
  if (params.attenuationColor !== undefined) gp.attenuationColor = params.attenuationColor;
  material.userData.glassParams = gp;

  material.needsUpdate = true;
  return true;
}

export class MaterialOverrideSystem {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.envMapProvider = options.envMapProvider || null;
    this.scene = options.scene || null;
    // P2: auto-bevel enabled by default, can be disabled per-call via context
    this.autoBevelForGlass = options.autoBevelForGlass !== false;
  }

  apply(target, layers, context = {}) {
    let materialCount = 0;
    for (const layer of layers || []) {
      const count = visitMeshes(target, (mesh) => {
        ensureOriginalMaterial(mesh);
        // P2: auto-bevel for glass on box-like geometry
        if (layer?.type === 'Glass' && this.autoBevelForGlass && context.bevelForGlass !== false) {
          this._maybeBevelGeometry(mesh, layer.params || {}, context);
        }
        mesh.material = this.buildMaterialFromLayer(layer, mesh, context);
        // P3: inject fresnel rim after material is built
        if (layer?.type === 'Glass' && mesh.material) {
          injectFresnelRim(mesh.material, layer.params || {});
          mesh.renderOrder = layer.params?.renderOrder ?? RENDER_ORDER.WATER_GLASS;
        }
      });
      materialCount += count;
      this._log(`[MaterialOverride] type=${layer.type} result=${count > 0 ? 'success' : 'skipped'}`);
    }
    return { applied: materialCount };
  }

  buildMaterialFromLayer(layer, target, context = {}) {
    switch (layer?.type) {
      case 'InkSurface':
        return this._buildInkSurface(layer, target, context);
      case 'Glass':
        return this._buildGlass(layer, target, context);
      case 'WhiteStroke':
        return this._buildWhiteStroke(layer, target, context);
      default:
        return this._cloneSourceMaterial(target?.material, layer);
    }
  }

  _buildInkSurface(layer, target) {
    const params = layer.params || {};
    const sourceMaterial = Array.isArray(target?.material) ? target.material[0] : target?.material;
    const material = createInkSurfaceMaterial({
      paperColor: colorFrom(params.color, [0.45, 0.39, 0.32]),
      inkColor: colorFrom(params.crackColor, [0.12, 0.11, 0.1]),
      noiseScale: params.noiseScale ?? 3.0,
      noiseStrength: params.noiseStrength ?? params.crack ?? 0.25,
      brushScale: params.brushScale ?? Math.max(1.0, params.noiseScale ?? 2.0),
      brushStrength: params.brushStrength ?? Math.max(params.crack ?? 0, params.normalStrength ?? 0, 0.2),
      baseMap: sourceMaterial?.map ?? null,
      baseColor: sourceMaterial?.color ?? colorFrom(params.color, [0.45, 0.39, 0.32]),
      useOriginalAlbedo: params.useOriginalAlbedo ?? false,
      albedoInfluence: params.albedoInfluence ?? 0.25,
      useWorldSpaceNoise: params.useWorldSpaceNoise ?? true,
      densityEnabled: params.densityEnabled ?? true,
      densityScale: params.densityScale ?? 0.035,
      densityContrast: params.densityContrast ?? 1.2,
      macroNoiseScale: params.macroNoiseScale ?? 0.18,
      macroNoiseInfluence: params.macroNoiseInfluence ?? 0.35,
    });
    material.side = sourceMaterial?.side ?? material.side;
    material.transparent = false;
    material.opacity = 1;
    material.depthWrite = true;
    material.userData = {
      ...(material.userData || {}),
      effectMaterialType: 'InkSurface',
      effectLayerId: layer.id,
      sourceMaterialType: target?.material?.type || target?.material?.constructor?.name || null,
      inkSurfaceParams: { ...params },
      effectNotes: [
        'ink-surface-material',
        ...(params.normalMapId ? ['normal-map-id-reserved-for-loader'] : []),
      ],
    };
    return material;
  }

  _buildGlass(layer, target, context = {}) {
    const params = layer.params || {};
    const envMap = this._getCurrentEnvMap(context);

    // P1: Transmission-based glass defaults
    const roughness = params.roughness ?? 0.055;
    const metalness = params.metalness ?? 0.0;
    const transmission = params.transmission ?? 0.95;
    const ior = params.ior ?? 1.48;
    const envMapIntensity = params.envMapIntensity ?? 1.0;
    const clearcoat = params.clearcoat ?? 0.12;
    const clearcoatRoughness = params.clearcoatRoughness ?? 0.08;
    const specularIntensity = params.specularIntensity ?? 1.0;
    const autoThickness = params.autoThickness !== false;
    const thickness = autoThickness
      ? estimateGlassThickness(target, params.thickness ?? 0.25)
      : (params.thickness ?? 0.25);
    const attenuationColor = colorFrom(params.attenuationColor || [0.96, 0.99, 1.0]);
    const attenuationDistance = params.attenuationDistance ?? 6.0;

    // When transmission > 0, opacity stays at 1.0 (transparency comes from transmission, not opacity)
    const hasTransmission = transmission > 0;
    const opacity = hasTransmission ? 1.0 : (params.opacity ?? 0.62);
    // Keep container glass in the transparent list and out of the depth buffer so
    // transparent contents such as model water can render through its front face.
    const transparent = hasTransmission || opacity < 1;
    const depthWrite = !transparent;

    const MaterialCtor = THREE.MeshPhysicalMaterial || THREE.MeshStandardMaterial;
    const material = new MaterialCtor({
      color: colorFrom(params.color, [0.985, 0.995, 1.0]),
      roughness,
      metalness,
      transparent,
      opacity,
      depthWrite,
      envMap,
      envMapIntensity,
    });

    if ('clearcoat' in material) material.clearcoat = clearcoat;
    if ('clearcoatRoughness' in material) material.clearcoatRoughness = clearcoatRoughness;
    if ('specularIntensity' in material) material.specularIntensity = specularIntensity;
    if ('transmission' in material) material.transmission = transmission;
    if ('ior' in material) material.ior = ior;
    if ('thickness' in material) material.thickness = thickness;
    if ('attenuationColor' in material) material.attenuationColor = attenuationColor;
    if ('attenuationDistance' in material) material.attenuationDistance = attenuationDistance;

    material.userData = {
      ...(material.userData || {}),
      effectMaterialType: 'Glass',
      effectLayerId: layer.id,
      sourceMaterialType: target?.material?.type || target?.material?.constructor?.name || null,
      glassParams: {
        color: params.color ?? [0.985, 0.995, 1.0],
        opacity,
        roughness,
        metalness,
        envMapIntensity,
        clearcoat,
        clearcoatRoughness,
        specularIntensity,
        fresnelStrength: params.fresnelStrength ?? 0.16,
        fresnelPower: params.fresnelPower ?? 2.0,
        facetStrength: params.facetStrength ?? 0.08,
        distortion: params.distortion ?? 0.008,
        screenEdgeFade: params.screenEdgeFade ?? 0.08,
        surfaceVariation: params.surfaceVariation ?? 0.035,
        surfaceScale: params.surfaceScale ?? 6.0,
        edgeTintStrength: params.edgeTintStrength ?? 0.18,
        fresnelColor: params.fresnelColor || params.color || [0.985, 0.995, 1.0],
        transmission,
        ior,
        thickness,
        autoThickness,
        attenuationColor: params.attenuationColor || [0.96, 0.99, 1.0],
        attenuationDistance,
      },
      effectNotes: [
        'stylized-physical-glass',
        'transmission-driven',
        autoThickness ? 'auto-thickness' : 'fixed-thickness',
        envMap ? 'env-map-applied' : 'env-map-fallback-none',
        hasTransmission ? 'transmission-active' : 'opacity-fallback',
      ],
    };
    return material;
  }

  updateRuntimeParam(target, effectId, paramName, value) {
    let updated = 0;
    visitMeshes(target, (mesh) => {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (this.updateMaterialParam(material, effectId, paramName, value)) updated++;
      }
    });
    return updated;
  }

  updateMaterialParam(material, effectId, paramName, value) {
    if (!material?.userData) return false;
    if (material.userData.effectLayerId !== effectId) return false;
    if (material.userData.effectMaterialType !== 'Glass') return false;
    const params = material.userData.glassParams || {};
    params[paramName] = value;
    material.userData.glassParams = params;
    switch (paramName) {
      case 'opacity':
        if ((material.transmission ?? 0) > 0) {
          material.opacity = 1;
          material.transparent = true;
          material.depthWrite = false;
        } else {
          material.opacity = value;
          material.transparent = value < 1;
          material.depthWrite = value >= 1;
        }
        break;
      case 'roughness':
        material.roughness = value;
        break;
      case 'envMapIntensity':
        material.envMapIntensity = value;
        break;
      case 'clearcoat':
        if ('clearcoat' in material) material.clearcoat = value;
        break;
      case 'clearcoatRoughness':
        if ('clearcoatRoughness' in material) material.clearcoatRoughness = value;
        break;
      case 'specularIntensity':
        if ('specularIntensity' in material) material.specularIntensity = value;
        break;
      case 'metalness':
        material.metalness = value;
        break;
      case 'transmission':
        if ('transmission' in material) {
          material.transmission = value;
          if (value > 0) {
            material.opacity = 1;
            material.transparent = true;
            material.depthWrite = false;
          } else {
            material.opacity = params.opacity ?? 0.62;
            material.transparent = material.opacity < 1;
            material.depthWrite = material.opacity >= 1;
          }
        }
        break;
      case 'ior':
        if ('ior' in material) material.ior = value;
        break;
      case 'thickness':
        if ('thickness' in material) material.thickness = value;
        break;
      case 'attenuationColor':
        if ('attenuationColor' in material) material.attenuationColor = colorFrom(value);
        updateFresnelUniforms(material, { attenuationColor: value });
        break;
      case 'attenuationDistance':
        if ('attenuationDistance' in material) material.attenuationDistance = value;
        break;
      case 'fresnelStrength':
      case 'fresnelPower':
      case 'fresnelColor':
      case 'facetStrength':
      case 'distortion':
      case 'screenEdgeFade':
      case 'surfaceVariation':
      case 'surfaceScale':
      case 'edgeTintStrength':
        updateFresnelUniforms(material, { [paramName]: value });
        break;
      default:
        break;
    }
    material.needsUpdate = true;
    return true;
  }

  // ── P2: Auto-bevel for box geometry ──────────────────────────────

  _maybeBevelGeometry(mesh, params, context) {
    if (!mesh?.geometry) return;
    if (mesh.userData._glassBevelApplied) return;

    // Only bevel box-like geometries
    if (!isBoxLikeGeometry(mesh.geometry)) return;

    const dims = getBoxDimensions(mesh.geometry);
    if (!dims || dims.minDim <= 0) return;

    // A small single chamfer catches a glass highlight without rounding the part into plastic.
    const defaultRadius = Math.min(0.08, Math.max(0.01, dims.minDim * 0.028));
    const radius = params.bevelRadius ?? defaultRadius;
    if (radius <= 0) return;

    const segments = Math.max(1, params.bevelSegments ?? context.bevelSegments ?? 1);

    // Build rounded geometry
    const roundedGeometry = createRoundedBoxGeometry(
      dims.width, dims.height, dims.depth,
      radius, segments
    );

    // Transfer mesh transform: the original geometry is in local space,
    // but the BoxGeometry may have been centered.  Restore original
    // position offset if the original geometry had one.
    // (BoxGeometry is centered at origin by default, so no offset needed.)

    // Preserve original geometry for cleanup
    if (!mesh.userData._glassOriginalGeometry) {
      mesh.userData._glassOriginalGeometry = mesh.geometry;
    }

    mesh.geometry = roundedGeometry;
    mesh.userData._glassBevelApplied = true;
    mesh.userData._glassBevelRadius = radius;

    this._log(`[MaterialOverride] bevel box→roundedBox radius=${radius.toFixed(3)} segments=${segments} dims=${dims.width.toFixed(2)}×${dims.height.toFixed(2)}×${dims.depth.toFixed(2)}`);
  }

  /** Remove bevel and restore original geometry (for effect clear). */
  _restoreBevelGeometry(mesh) {
    if (!mesh?.userData?._glassOriginalGeometry) return;
    mesh.geometry = mesh.userData._glassOriginalGeometry;
    delete mesh.userData._glassOriginalGeometry;
    delete mesh.userData._glassBevelApplied;
    delete mesh.userData._glassBevelRadius;
  }

  _getCurrentEnvMap(context = {}) {
    return this.envMapProvider?.getCurrentEnvMap?.()
      || context.scene?.environment
      || this.scene?.environment
      || null;
  }

  // ── P3 toggle ────────────────────────────────────────────────────

  enableGlassFresnel() { enableFresnelInjection(); return true; }
  disableGlassFresnel() { disableFresnelInjection(); return false; }
  isGlassFresnelEnabled() { return isFresnelInjectionEnabled(); }

  // ── Glass debug (P0) ─────────────────────────────────────────────

  printGlassDebug(mesh) {
    if (!mesh?.isMesh) {
      console.warn('[glassDebug] Not a mesh:', mesh);
      return null;
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const result = {
      mesh: mesh.name || mesh.type || '(mesh)',
      uuid: mesh.uuid,
      geometryType: mesh.geometry?.type || mesh.geometry?.constructor?.name || null,
      isBeveled: !!mesh.userData?._glassBevelApplied,
      bevelRadius: mesh.userData?._glassBevelRadius || null,
      materials: materials.map((material, index) => ({
        index,
        type: material.type || material.constructor?.name,
        isGlass: material.userData?.effectMaterialType === 'Glass',
        transparent: material.transparent,
        opacity: material.opacity,
        depthWrite: material.depthWrite,
        roughness: material.roughness,
        metalness: material.metalness,
        transmission: material.transmission ?? 'n/a',
        thickness: material.thickness ?? 'n/a',
        ior: material.ior ?? 'n/a',
        envMapPresent: !!material.envMap,
        envMapIntensity: material.envMapIntensity,
        clearcoat: material.clearcoat ?? 'n/a',
        clearcoatRoughness: material.clearcoatRoughness ?? 'n/a',
        specularIntensity: material.specularIntensity ?? 'n/a',
        attenuationColor: material.attenuationColor
          ? `#${material.attenuationColor.getHexString()}`
          : 'n/a',
        attenuationDistance: material.attenuationDistance ?? 'n/a',
        sceneEnvironment: !!this.scene?.environment,
        fresnelInjected: !!material.userData?.[FRESNEL_INJECT_MARKER],
        fresnelParams: material.userData?._glassFresnelUniforms || null,
        effectNotes: material.userData?.effectNotes || [],
      })),
    };
    console.log('[glassDebug]', result);
    console.table(result.materials.map(m => ({
      idx: m.index,
      isGlass: m.isGlass,
      trans: m.transmission,
      rough: m.roughness,
      envMap: m.envMapPresent,
      envInt: m.envMapIntensity,
      fresnel: m.fresnelInjected,
    })));
    return result;
  }

  _buildWhiteStroke(layer, target) {
    const params = layer.params || {};
    const material = new THREE.MeshStandardMaterial({
      color: colorFrom(params.color, [1, 1, 1]),
      roughness: params.roughness ?? 1,
      metalness: params.metalness ?? 0,
      transparent: false,
      opacity: 1,
      depthWrite: true,
    });
    material.userData = {
      ...(material.userData || {}),
      effectMaterialType: 'WhiteStroke',
      effectLayerId: layer.id,
      sourceMaterialType: target?.material?.type || target?.material?.constructor?.name || null,
      whiteStrokeParams: { ...params },
      effectNotes: params.useLocalInkMask
        ? ['local-ink-mask-requested-but-mask-system-not-wired']
        : ['simplified-white-material-no-local-ink-mask'],
    };
    return material;
  }

  _cloneSourceMaterial(sourceMaterial, layer) {
    const material = sourceMaterial?.clone
      ? sourceMaterial.clone()
      : new THREE.MeshStandardMaterial({ color: 0xffffff });
    material.userData = {
      ...(material.userData || {}),
      effectMaterialType: layer?.type || 'MaterialOverride',
      effectLayerId: layer?.id,
    };
    return material;
  }

  _log(message) {
    if (this.logger?.enabled && Array.isArray(this.logger.entries)) this.logger.entries.push(message);
    if (this.logger?.enabled && this.logger.console === true) console.log(message);
  }
}
