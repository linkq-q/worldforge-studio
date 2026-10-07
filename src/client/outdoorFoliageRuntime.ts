import * as THREE from 'three';

type Shader = THREE.WebGLProgramParametersWithUniforms;
const BEGIN = '// wf-foliage-begin';
const MASK_END = '// wf-foliage-mask-end';
const NORMAL_END = '// wf-foliage-normal-end';
const END = '// wf-foliage-end';

/** The normal must undergo the same instance/batch transforms as the leaf positions. */
const INSTANCE_NORMAL = `
vec3 outdoorFoliageNormal = foliagePuffNormal;
#ifdef USE_BATCHING
  mat3 outdoorFoliageBatch = mat3(batchingMatrix);
  outdoorFoliageNormal /= max(vec3(dot(outdoorFoliageBatch[0], outdoorFoliageBatch[0]), dot(outdoorFoliageBatch[1], outdoorFoliageBatch[1]), dot(outdoorFoliageBatch[2], outdoorFoliageBatch[2])), vec3(1e-8));
  outdoorFoliageNormal = outdoorFoliageBatch * outdoorFoliageNormal;
#endif
#ifdef USE_INSTANCING
  mat3 outdoorFoliageInstance = mat3(instanceMatrix);
  outdoorFoliageNormal /= max(vec3(dot(outdoorFoliageInstance[0], outdoorFoliageInstance[0]), dot(outdoorFoliageInstance[1], outdoorFoliageInstance[1]), dot(outdoorFoliageInstance[2], outdoorFoliageInstance[2])), vec3(1e-8));
  outdoorFoliageNormal = outdoorFoliageInstance * outdoorFoliageNormal;
#endif
vEffLayerWorldNormal = normalize(inverseTransformDirection(normalMatrix * outdoorFoliageNormal, viewMatrix));`;

/** Opt-in v2: authored leaf coverage and normals feed the ordinary PBR light/shadow path. */
export function patchOutdoorFoliage(shader: Shader): void {
  shader.vertexShader = shader.vertexShader.replace(
    'vEffLayerWorldNormal = normalize(mat3(modelMatrix) * foliagePuffNormal);', INSTANCE_NORMAL
  );
  const start = shader.fragmentShader.indexOf(BEGIN);
  const normalEnd = shader.fragmentShader.indexOf(NORMAL_END, start);
  const end = shader.fragmentShader.indexOf(END, normalEnd);
  if (start < 0 || normalEnd < 0 || end < 0) return;
  const body = shader.fragmentShader.slice(start, normalEnd)
    .replace('gl_FragColor.rgb *= foliageFacetedShade', 'diffuseColor.rgb *= foliageFacetedShade')
    .replace('sign(foliageLeafLocal.x) * 0.035', 'foliageLeafLocal.x * 0.025')
    .replace(/float foliageFoldSide =[^;]+;\s*vec2 foliageFoldSlopeLeaf =[^;]+;/, `
// The old two flat V-shaped lobes become large triangular light patches under PBR.
// A shallow, rounded leaf returns to the canopy normal at its edge instead.
vec2 foliageLeafRadius = foliageLeafLocal / vec2(0.48, 0.72);
float foliageLeafRelief = pow(max(0.0, 1.0 - dot(foliageLeafRadius, foliageLeafRadius)), 2.0) * foliageLeafMask;
vec2 foliageFoldSlopeLeaf = foliageLeafRadius * vec2(0.24, 0.10) * foliageLeafRelief;`)
    .replace(/vec3 foliageViewUp =[\s\S]*?vec3 foliageLeafBitangentView =[^;]+;/, `
// Follow the authored face UVs, including rotated/nonuniform instances.
vec3 foliageDpdx = dFdx(vEffLayerWorldPos);
vec3 foliageDpdy = dFdy(vEffLayerWorldPos);
vec2 foliageDuvdx = dFdx(foliageFaceUv);
vec2 foliageDuvdy = dFdy(foliageFaceUv);
float foliageUvSign = sign(foliageDuvdx.x * foliageDuvdy.y - foliageDuvdx.y * foliageDuvdy.x);
vec3 foliageTangent = mat3(viewMatrix) *
  ((foliageDpdx * foliageDuvdy.y - foliageDpdy * foliageDuvdx.y) * foliageUvSign);
vec3 foliageBitangent = mat3(viewMatrix) *
  ((foliageDpdy * foliageDuvdx.x - foliageDpdx * foliageDuvdy.x) * foliageUvSign);
vec3 foliageReferenceUp = normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0));
vec3 foliageReferenceRight = normalize(mat3(viewMatrix) * vec3(1.0, 0.0, 0.0));
vec3 foliageBasisReference = abs(dot(foliageBaseViewNormal, foliageReferenceUp)) < 0.9 ? foliageReferenceUp : foliageReferenceRight;
vec3 foliageLeafTangentView = normalize(cross(foliageBasisReference, foliageBaseViewNormal));
vec3 foliageLeafBitangentView = normalize(cross(foliageBaseViewNormal, foliageLeafTangentView));
// Clamped face UVs and subpixel leaves can have zero derivatives, including during probe capture.
if (dot(foliageTangent, foliageTangent) > 1e-16 && dot(foliageBitangent, foliageBitangent) > 1e-16) {
  foliageLeafTangentView = normalize(foliageTangent);
  foliageLeafBitangentView = normalize(foliageBitangent);
}`);
  shader.fragmentShader = shader.fragmentShader.slice(0, start) + shader.fragmentShader.slice(end + END.length);
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>',
    `${body}\nnormal = foliageLeafDetailViewNormal;\n${NORMAL_END}\n#include <lights_physical_fragment>`);
  // No post-lighting painted highlight. Thin-leaf transmission uses sun radiance and its shadow.
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
#if NUM_DIR_LIGHTS > 0
  vec3 outdoorLeafSun = normalize(mat3(viewMatrix) * uOutdoorSunDirection);
  float outdoorLeafSunVisibility = 1.0;
  #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow outdoorLeafShadow = directionalLightShadows[0];
    outdoorLeafSunVisibility = receiveShadow ? getShadow(directionalShadowMap[0], outdoorLeafShadow.shadowMapSize,
      outdoorLeafShadow.shadowBias, outdoorLeafShadow.shadowRadius, vDirectionalShadowCoord[0]) : 1.0;
  #endif
  float outdoorLeafBack = pow(max(dot(normalize(vViewPosition), -outdoorLeafSun), 0.0), 3.0);
  float outdoorLeafWrap = clamp(0.5 - dot(normal, outdoorLeafSun) * 0.5, 0.0, 1.0);
  float outdoorLeafTransmission = (0.12 * outdoorLeafWrap + 0.35 * outdoorLeafBack)
    * uFoliageTransmission * mix(0.35, 1.0, foliageLeafMask) * outdoorLeafSunVisibility;
  reflectedLight.directDiffuse += diffuseColor.rgb * directionalLights[0].color
    * vec3(0.66, 0.90, 0.42) * outdoorLeafTransmission * RECIPROCAL_PI;
#endif`);
}

interface FoliagePasses {
  depth: THREE.MeshDepthMaterial;
  distance: THREE.MeshDistanceMaterial;
  normal: THREE.MeshNormalMaterial;
}

/** Reuse the actual compiled leaf mask/wind, so all passes use the same cells and time uniforms. */
function createPasses(source: THREE.MeshStandardMaterial): FoliagePasses {
  const passes = {
    depth: new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
    distance: new THREE.MeshDistanceMaterial(),
    normal: new THREE.MeshNormalMaterial()
  };
  for (const [kind, target] of Object.entries(passes)) {
    target.side = source.side;
    target.displacementMap = source.displacementMap;
    target.displacementScale = source.displacementScale;
    target.displacementBias = source.displacementBias;
    target.clippingPlanes = source.clippingPlanes;
    target.clipIntersection = source.clipIntersection;
    target.clipShadows = source.clipShadows;
    target.onBeforeCompile = (shader, renderer) => {
      const compiled = {
        uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
        fragmentShader: THREE.ShaderLib.standard.fragmentShader
      } as Shader;
      // Calling only the effect/outdoor surface patches avoids importing lighting into depth passes.
      const patches = source.userData.shaderPatchChain as Array<{
        key: string; patchFn: (shader: Shader, renderer: THREE.WebGLRenderer, material: THREE.Material) => void
      }>;
      const effectEntries = [source.userData.effectVariant, ...Object.values(source.userData.effectLayers ?? {})]
        .filter(Boolean) as Array<{ shaderRef?: Shader }>;
      const refs = effectEntries.map(entry => entry.shaderRef);
      try {
        for (const patch of patches ?? []) {
          if (patch.key === 'effectVariant' || patch.key.startsWith('effectLayer:') || patch.key === 'worldforge:outdoor-material') {
            patch.patchFn(compiled, renderer, source);
          }
        }
      } finally {
        effectEntries.forEach((entry, index) => { entry.shaderRef = refs[index]; });
      }
      Object.assign(shader.uniforms, compiled.uniforms);
      const declarations = compiled.fragmentShader.match(/#include <common>([\s\S]*?)#include <packing>/)?.[1] ?? '';
      const vertex = compiled.vertexShader.match(/#include <begin_vertex>([\s\S]*?)#include <morphtarget_vertex>/)?.[1] ?? '';
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${declarations}`);
      const objectNormal = kind === 'normal' ? '' : '\n#ifndef USE_DISPLACEMENTMAP\nvec3 objectNormal = vec3(normal);\n#endif\n';
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${objectNormal}${vertex}`);
      // MeshNormalMaterial lacks <common>; foliage helpers use its saturate/PI definitions.
      shader.fragmentShader = shader.fragmentShader.includes('#include <common>')
        ? shader.fragmentShader.replace('#include <common>', `#include <common>\n${declarations}`)
        : shader.fragmentShader.replace('#include <packing>', `#include <common>\n${declarations}\n#include <packing>`);
      const start = compiled.fragmentShader.indexOf(BEGIN);
      const end = compiled.fragmentShader.indexOf(kind === 'normal' ? NORMAL_END : MASK_END, start);
      if (start < 0 || end < 0) throw new Error('Outdoor foliage pass is missing the authored leaf mask');
      const body = compiled.fragmentShader.slice(start, end)
        .replace('diffuseColor.rgb *= foliageFacetedShade * foliageLeafTint * foliageHeightTint;', '');
      const anchor = kind === 'normal' ? '#include <normal_fragment_maps>' : '#include <alphatest_fragment>';
      shader.fragmentShader = shader.fragmentShader.replace(anchor, `${anchor}\n${body}`);
    };
    target.customProgramCacheKey = () => `outdoor-foliage-${kind}:${source.customProgramCacheKey()}`;
  }
  return passes;
}

export class OutdoorFoliagePasses {
  private readonly passes = new Map<THREE.MeshStandardMaterial, FoliagePasses>();
  private readonly objects: Array<{
    mesh: THREE.Mesh; passes: FoliagePasses;
    depth: THREE.Material | undefined; distance: THREE.Material | undefined; normal: unknown;
  }> = [];

  apply(mesh: THREE.Mesh, source: THREE.MeshStandardMaterial): void {
    let passes = this.passes.get(source);
    if (!passes) { passes = createPasses(source); this.passes.set(source, passes); }
    this.objects.push({ mesh, passes, depth: mesh.customDepthMaterial, distance: mesh.customDistanceMaterial,
      normal: mesh.userData.outdoorNormalMaterial });
    mesh.customDepthMaterial = passes.depth;
    mesh.customDistanceMaterial = passes.distance;
    mesh.userData.outdoorNormalMaterial = passes.normal;
  }

  clear(): void {
    for (const { mesh, passes, depth, distance, normal } of this.objects) {
      if (mesh.customDepthMaterial === passes.depth) mesh.customDepthMaterial = depth;
      if (mesh.customDistanceMaterial === passes.distance) mesh.customDistanceMaterial = distance;
      if (mesh.userData.outdoorNormalMaterial === passes.normal) {
        if (normal === undefined) delete mesh.userData.outdoorNormalMaterial;
        else mesh.userData.outdoorNormalMaterial = normal;
      }
    }
    for (const passes of this.passes.values()) Object.values(passes).forEach(material => material.dispose());
    this.passes.clear();
    this.objects.length = 0;
  }
}
