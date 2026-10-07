import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createEffectRuntime } from '@voxel-studio/render-runtime/effects';
import { addMaterialShaderPatch } from '@voxel-studio/render-runtime/utils/MaterialShaderPatchChain.js';
import { OutdoorMaterialRuntime } from '../src/client/outdoorMaterialRuntime';

function taggedMaterial(layer: string, params: Record<string, unknown>) {
  const material = new THREE.MeshStandardMaterial({ color: '#b7b3a1', roughness: 0.53, metalness: 0 });
  createEffectRuntime().runtime.applyToMaterial(material, {
    schemaVersion: '1.0', materialLayers: [layer], layerParams: { [layer]: params }
  });
  return material;
}

function compile(material: THREE.Material, type: 'standard' | 'normal' | 'depth' | 'distanceRGBA' = 'standard') {
  const shader = {
    uniforms: {}, vertexShader: THREE.ShaderLib[type].vertexShader,
    fragmentShader: THREE.ShaderLib[type].fragmentShader
  } as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

describe('opt-in outdoor material treatment', () => {
  it('keeps instanced stone textures and micro normals while moving color before lighting, then restores them', () => {
    const material = taggedMaterial('Triplanar', {
      pattern: 3, scale: 2, strength: 0.55, macroStrength: 0.5,
      marbleRoughnessVariation: 0.3, marbleNormalStrength: 0.01
    });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), material, 2);
    mesh.userData.materialTags = [{ tag: 'base', value: 'stone', variant: 'marble' }];
    const root = new THREE.Group().add(mesh);
    const tags = JSON.stringify(mesh.userData.materialTags);
    const originalColor = material.color.getHex();
    const before = compile(material);
    const runtime = new OutdoorMaterialRuntime();
    runtime.apply(root, 1);
    const after = compile(material);

    expect(material.roughness).toBeCloseTo(0.86);
    expect(material.color.getHex()).toBe(originalColor);
    expect(JSON.stringify(mesh.userData.materialTags)).toBe(tags);
    expect(after.uniforms.uTriplanarScale.value).toBeCloseTo(1.44);
    expect(after.uniforms.uTriplanarStrength.value).toBeGreaterThan(0);
    expect(after.uniforms.uTriplanarMacroStrength.value).toBeCloseTo(0.14);
    expect(after.fragmentShader).toContain('stoneBumpedNormal');
    expect(after.fragmentShader).toContain('diffuseColor.rgb *= mix(vec3(1.0), triTint');
    expect(after.fragmentShader.indexOf('diffuseColor.rgb *= mix')).toBeLessThan(after.fragmentShader.indexOf('#include <lights_physical_fragment>'));
    expect(after.fragmentShader).not.toContain('gl_FragColor.rgb * triTint');
    expect(after.fragmentShader).toContain('mix(0.58, 0.96, uOutdoorMaterialStrength)');
    // HDRI completion restores tag surface properties; shader treatment survives.
    material.roughness = 0.53;
    const afterEnvironment = compile(material);
    expect(afterEnvironment.uniforms.uOutdoorSurfaceRoughness.value).toBe(0.86);
    expect(afterEnvironment.fragmentShader).toContain('roughnessFactor = clamp(uOutdoorSurfaceRoughness + roughnessFactor - roughness');

    runtime.clear();
    const restored = compile(material);
    expect(material.roughness).toBe(0.53);
    expect(restored.uniforms.uTriplanarScale.value).toBe(2);
    expect(restored.uniforms.uTriplanarMacroStrength.value).toBe(0.5);
    expect(restored.fragmentShader).toBe(before.fragmentShader);
    expect(mesh.count).toBe(2);
  });

  it('keeps foliage pattern and wind patches, uses the actual sun direction, and restores authored values', () => {
    const material = taggedMaterial('Foliage', { transmission: 0.5, aoStrength: 0.17, quantSteps: 0 });
    addMaterialShaderPatch(material, 'test:wind', shader => {
      shader.vertexShader += '\n// authored-wind';
    }, { order: 125 });
    const root = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const runtime = new OutdoorMaterialRuntime();
    runtime.apply(root, 1, new THREE.Vector3(0, 2, 2));
    const shader = compile(material);
    expect(shader.fragmentShader).toContain('foliageCoverage < uFoliageCutoutThreshold');
    expect(shader.vertexShader).toContain('// authored-wind');
    expect(shader.fragmentShader).toContain('normalize(mat3(viewMatrix) * uOutdoorSunDirection)');
    expect(shader.fragmentShader).toContain('outdoorLeafTransmission');
    expect(shader.uniforms.uFoliageTransmission.value).toBe(0.85);
    expect(shader.uniforms.uOutdoorSunDirection.value.y).toBeCloseTo(Math.SQRT1_2);
    expect(shader.uniforms.uOutdoorSunDirection.value.length()).toBeCloseTo(1);
    runtime.setSunDirection(new THREE.Vector3(1, 0, 0));
    expect(shader.uniforms.uOutdoorSunDirection.value.toArray()).toEqual([1, 0, 0]);
    runtime.dispose();
    expect(compile(material).vertexShader).toContain('// authored-wind');
    expect(material.userData.effectVariant.uniforms.uFoliageTransmission.value).toBe(0.5);
  });

  it('leaves untagged intrinsic materials and materials shared outside modelsRoot unchanged', () => {
    const outside = taggedMaterial('Triplanar', { pattern: 1 });
    const slate = new THREE.MeshStandardMaterial({ color: '#304354', roughness: 0.78, metalness: 0 });
    const root = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), outside), new THREE.Mesh(new THREE.BoxGeometry(), slate));
    new THREE.Scene().add(root, new THREE.Mesh(new THREE.BoxGeometry(), outside));
    const runtime = new OutdoorMaterialRuntime();
    runtime.apply(root, 1);
    expect(outside.roughness).toBe(0.53);
    expect(slate.roughness).toBe(0.78);
    expect(slate.color.getHexString()).toBe('304354');
    expect(compile(outside).fragmentShader).not.toContain('uOutdoorMaterialStrength');
    runtime.clear();
  });

  it('reapplies to replacement materials and respects changes made by a subsequent scheme', () => {
    const first = taggedMaterial('Triplanar', { pattern: 1, scale: 3.7 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), first);
    const root = new THREE.Group().add(mesh);
    const runtime = new OutdoorMaterialRuntime();
    runtime.apply(root, 1);
    // The tag runtime restores uniforms before another scheme application.
    first.userData.effectVariant.uniforms.uTriplanarScale.value = 4;
    first.roughness = 0.9;
    runtime.apply(root, 1);
    expect(first.userData.effectVariant.uniforms.uTriplanarScale.value).toBeCloseTo(2.88);
    const replacement = taggedMaterial('Triplanar', { pattern: 0, scale: 2 });
    mesh.material = replacement;
    runtime.apply(root, 1);
    expect(first.roughness).toBe(0.9);
    expect(first.userData.effectVariant.uniforms.uTriplanarScale.value).toBe(4);
    expect(replacement.roughness).toBe(0.78);
    runtime.apply(root, 0);
    expect(replacement.roughness).toBe(0.53);
    expect(compile(first).fragmentShader).not.toContain('uOutdoorMaterialStrength');
    runtime.apply(root, 0.5);
    expect(compile(replacement).uniforms.uOutdoorSurfaceRoughness.value).toBeCloseTo((0.53 + 0.78) / 2);
    runtime.clear();
  });

  it('v2 fixes surface response at zero detail, while v1 zero still restores the authored look', () => {
    const stone = taggedMaterial('Triplanar', { pattern: 3, strength: 0.55, marbleNormalStrength: 0.018 });
    const bark = taggedMaterial('Triplanar', { pattern: 5, strength: 0.7, barkNormalStrength: 0.06 });
    const metal = new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0.8 });
    metal.userData.worldforgeMaterialMatcapUniforms = { uTextureMatcapBlend: { value: 0.9 } };
    const root = new THREE.Group().add(...[stone, bark, metal].map(material => new THREE.Mesh(new THREE.BoxGeometry(), material)));
    const runtime = new OutdoorMaterialRuntime();
    runtime.apply(root, 0, undefined, 2);
    expect(stone.roughness).toBe(0.8);
    expect(bark.roughness).toBe(0.82);
    expect(metal.roughness).toBe(0.38);
    expect(metal.metalness).toBe(1);
    expect(metal.userData.worldforgeMaterialMatcapUniforms.uTextureMatcapBlend.value).toBe(0);
    const shader = compile(stone);
    expect(shader.uniforms.uTriplanarStrength.value).toBe(0);
    expect(shader.uniforms.uTriplanarMarbleNormalStrength.value).toBe(0);
    expect(shader.uniforms.uTriplanarMarbleRoughnessVariation.value).toBe(0);
    expect(shader.uniforms.uOutdoorSurfaceRoughness.value).toBe(0.8);
    expect(compile(bark).uniforms.uTriplanarBarkNormalStrength.value).toBe(0);
    runtime.apply(root, 0.5, undefined, 2);
    expect(stone.roughness).toBe(0.8);
    expect(compile(stone).uniforms.uTriplanarMarbleNormalStrength.value).toBeCloseTo(0.009);
    runtime.apply(root, 0);
    expect(stone.roughness).toBe(0.53);
    expect(compile(stone).uniforms.uTriplanarStrength.value).toBe(0.55);
    expect(metal.userData.worldforgeMaterialMatcapUniforms.uTextureMatcapBlend.value).toBe(0.9);
    expect(compile(stone).fragmentShader).not.toContain('uOutdoorSurfaceRoughness');
  });

  it('v2 shares the visible leaf mask, instanced normals and wind with depth/distance/normal passes', () => {
    const material = taggedMaterial('Foliage', { transmission: 0.5, puffiness: 0.7 });
    createEffectRuntime().runtime.applyToMaterial(material, {
      schemaVersion: '1.0', materialLayers: ['Foliage', 'VegetationSway'],
      layerParams: { Foliage: { transmission: 0.5, puffiness: 0.7 }, VegetationSway: { amplitude: 0.12 } }
    });
    const geometry = new THREE.BoxGeometry();
    const mesh = new THREE.InstancedMesh(geometry, material, 2);
    mesh.setMatrixAt(1, new THREE.Matrix4().makeRotationY(1.73).scale(new THREE.Vector3(1.8, 1.1, 0.8)));
    mesh.userData.materialTags = [{ tag: 'foliage', value: 'leaf' }];
    const oldDepth = new THREE.MeshDepthMaterial();
    const oldDistance = new THREE.MeshDistanceMaterial();
    const oldNormal = new THREE.MeshNormalMaterial();
    mesh.customDepthMaterial = oldDepth;
    mesh.customDistanceMaterial = oldDistance;
    mesh.userData.outdoorNormalMaterial = oldNormal;
    const transform = Array.from(mesh.instanceMatrix.array);
    const tags = JSON.stringify(mesh.userData.materialTags);
    const root = new THREE.Group().add(mesh);
    const runtime = new OutdoorMaterialRuntime();
    const oldBounds = material.userData.effectVariant.uniforms.uEffLayerBoundsMin.value;
    runtime.apply(root, 0, new THREE.Vector3(1, 2, 3), 2);
    const main = compile(material);
    const normal = compile(mesh.userData.outdoorNormalMaterial, 'normal');
    const depth = compile(mesh.customDepthMaterial!, 'depth');
    const distance = compile(mesh.customDistanceMaterial!, 'distanceRGBA');
    expect(main.vertexShader).toContain('mat3 outdoorFoliageInstance = mat3(instanceMatrix)');
    expect(main.vertexShader).toContain('mat3 outdoorFoliageBatch = mat3(batchingMatrix)');
    expect(main.vertexShader).not.toContain('mat3(modelMatrix) * foliagePuffNormal');
    expect(Array.from(main.uniforms.uEffLayerBoundsMin.value)).toEqual([-0.5, -0.5, -0.5]);
    expect(main.fragmentShader).toContain('dot(foliageTangent, foliageTangent) > 1e-16');
    expect(main.fragmentShader).toContain('dot(foliageBitangent, foliageBitangent) > 1e-16');
    expect(main.fragmentShader).not.toContain('foliageFoldSide * 0.42');
    expect(main.fragmentShader).not.toContain('sign(foliageLeafLocal.x) * 0.035');
    expect(main.fragmentShader).toContain('foliageLeafRadius * vec2(0.24, 0.10) * foliageLeafRelief');
    expect(main.uniforms.uFoliageCutoutThreshold.value).toBe(0.35);
    expect(main.uniforms.uFoliageCutoutScale.value).toBe(6);
    expect(main.fragmentShader.indexOf('normal = foliageLeafDetailViewNormal;'))
      .toBeLessThan(main.fragmentShader.indexOf('#include <lights_physical_fragment>'));
    expect(main.fragmentShader).toContain('outdoorLeafSunVisibility = receiveShadow ? getShadow(');
    expect(main.fragmentShader).not.toContain('gl_FragColor.rgb += foliageSpecularTint');
    expect(main.fragmentShader).not.toContain('gl_FragColor.rgb *= foliageFacetedShade');
    expect(main.fragmentShader).toContain('diffuseColor.rgb *= foliageFacetedShade');
    const mask = (shader: ReturnType<typeof compile>) => shader.fragmentShader.slice(
      shader.fragmentShader.indexOf('// wf-foliage-begin'),
      shader.fragmentShader.indexOf('if (foliageCoverage < uFoliageCutoutThreshold) discard;')
    );
    for (const shader of [normal, depth, distance]) {
      expect(mask(shader)).toBe(mask(main));
      expect(shader.vertexShader).toContain('uVegetationSwayAmplitude');
      expect(shader.uniforms.uTime).toBe(main.uniforms.uTime);
      expect(shader.uniforms.uFoliageCutoutThreshold).toBe(main.uniforms.uFoliageCutoutThreshold);
      expect(shader.uniforms.uEffLayerBoundsMin).toBe(main.uniforms.uEffLayerBoundsMin);
      expect(shader.vertexShader).toContain('outdoorFoliageNormal = outdoorFoliageInstance * outdoorFoliageNormal;');
      expect(shader.fragmentShader).not.toContain('outdoorLeafSunVisibility');
      expect(shader.fragmentShader).not.toContain('gl_FragColor.rgb *= foliageFacetedShade');
    }
    expect(normal.fragmentShader).toContain('normal = foliageLeafDetailViewNormal;');
    expect(normal.fragmentShader).toContain('foliageLeafRadius * vec2(0.24, 0.10) * foliageLeafRelief');
    expect(normal.fragmentShader).not.toContain('diffuseColor.rgb');
    expect(depth.vertexShader).toContain('#ifndef USE_DISPLACEMENTMAP\nvec3 objectNormal = vec3(normal);');
    expect(distance.vertexShader).toContain('#ifndef USE_DISPLACEMENTMAP\nvec3 objectNormal = vec3(normal);');
    expect(mesh.geometry).toBe(geometry);
    expect(Array.from(mesh.instanceMatrix.array)).toEqual(transform);
    expect(JSON.stringify(mesh.userData.materialTags)).toBe(tags);
    expect(material.userData.effectVariant.shaderRef).toBe(main);
    main.uniforms.uTime.value = 3.25;
    for (const shader of [normal, depth, distance]) expect(shader.uniforms.uTime.value).toBe(3.25);
    let disposed = 0;
    [mesh.customDepthMaterial!, mesh.customDistanceMaterial!, mesh.userData.outdoorNormalMaterial]
      .forEach(target => target.addEventListener('dispose', () => { disposed++; }));
    runtime.clear();
    expect(disposed).toBe(3);
    expect(mesh.customDepthMaterial).toBe(oldDepth);
    expect(mesh.customDistanceMaterial).toBe(oldDistance);
    expect(mesh.userData.outdoorNormalMaterial).toBe(oldNormal);
    expect(material.userData.effectVariant.uniforms.uEffLayerBoundsMin.value).toBe(oldBounds);
    expect(compile(material).uniforms.uFoliageCutoutThreshold.value).toBe(0);
    expect(compile(material).uniforms.uFoliageCutoutScale.value).toBe(3);
    expect(compile(material).vertexShader).toContain('mat3(modelMatrix) * foliagePuffNormal');
  });

  it('v2 keeps shared outside foliage untouched and does not erase a later pass owner on clear', () => {
    const shared = taggedMaterial('Foliage', {});
    const owned = taggedMaterial('Foliage', {});
    const geometry = new THREE.BoxGeometry();
    const insideShared = new THREE.Mesh(geometry, shared);
    const insideOwned = new THREE.Mesh(geometry, owned);
    const root = new THREE.Group().add(insideShared, insideOwned);
    new THREE.Scene().add(root, new THREE.Mesh(geometry, shared));
    const runtime = new OutdoorMaterialRuntime();
    runtime.apply(root, 0, undefined, 2);
    expect(shared.roughness).toBe(0.53);
    expect(compile(shared).uniforms.uFoliageCutoutThreshold.value).toBe(0);
    expect(compile(shared).vertexShader).not.toContain('outdoorFoliageNormal');
    expect(insideShared.customDepthMaterial).toBeUndefined();
    expect(insideShared.userData.outdoorNormalMaterial).toBeUndefined();
    expect(insideOwned.customDepthMaterial).toBeInstanceOf(THREE.MeshDepthMaterial);
    const laterDepth = new THREE.MeshDepthMaterial();
    const laterNormal = new THREE.MeshNormalMaterial();
    insideOwned.customDepthMaterial = laterDepth;
    insideOwned.userData.outdoorNormalMaterial = laterNormal;
    runtime.clear();
    expect(insideOwned.customDepthMaterial).toBe(laterDepth);
    expect(insideOwned.userData.outdoorNormalMaterial).toBe(laterNormal);
    expect(insideOwned.customDistanceMaterial).toBeUndefined();
  });
});
