import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { buildOutdoorLightingGeometry, sampleOutdoorIrradiance, OutdoorSpatialLighting } from '../src/client/outdoorSpatialLighting';

function wall(width: number, height: number, depth: number, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial({ color:'#dfc5a1' }));
  mesh.position.set(x, y, z); mesh.castShadow = true; return mesh;
}
describe('spatial outdoor indirect light', () => {
  it('enclosed alcoves receive less sky than open points without changing direct sunlight', () => {
    const root = new THREE.Group().add(wall(12, 0.5, 12, 0, 0, 0), wall(12, 0.5, 12, 0, 6, 0), wall(0.5, 6, 12, -6, 3, 0), wall(0.5, 6, 12, 6, 3, 0), wall(12, 6, 0.5, 0, 3, -6));
    const geometry = buildOutdoorLightingGeometry(root)!;
    const bvh = new MeshBVH(geometry);
    const direction = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color(4, 3.6, 3);
    const enclosed = sampleOutdoorIrradiance(bvh, geometry, new THREE.Vector3(0, 2, 0), direction, color);
    const open = sampleOutdoorIrradiance(bvh, geometry, new THREE.Vector3(20, 2, 0), direction, color);
    expect(enclosed.positive.y).toBeLessThan(open.positive.y * 0.5);
    expect(open.positive.y).toBeGreaterThan(0.9);
    geometry.dispose();
  });

  it('expands translated instances for the bake and preserves source geometry', () => {
    const source = new THREE.BoxGeometry(2, 2, 2);
    const mesh = new THREE.InstancedMesh(source, new THREE.MeshStandardMaterial(), 2);
    mesh.castShadow = true;
    mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(10, 0, 0));
    mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(-10, 0, 0));
    mesh.position.y = 5;
    const geometry = buildOutdoorLightingGeometry(new THREE.Group().add(mesh))!;
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.toArray()).toEqual([-11, 4, -1]);
    expect(geometry.boundingBox!.max.toArray()).toEqual([11, 6, 1]);
    expect(source.getAttribute('position').count).toBe(24);
    geometry.dispose();
  });

  it('warms nearby shaded surfaces with a lit diffuse bounce and skips back faces', () => {
    const root = new THREE.Group().add(wall(40, 0.5, 40, 0, 0, 0));
    const geometry = buildOutdoorLightingGeometry(root)!;
    const bvh = new MeshBVH(geometry);
    const sample = sampleOutdoorIrradiance(bvh, geometry, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0,1,0), new THREE.Color(4,3,2));
    expect(sample.bounce.x).toBeGreaterThan(0.4);
    expect(sample.bounce.x).toBeGreaterThan(sample.bounce.z);
    geometry.dispose();
  });

  it('receives ground bounce from below without adding energy to upward-facing surfaces', () => {
    const floor = wall(1000, 0.1, 1000, 0, 0, 0);
    floor.material.color.setRGB(1, 1, 1);
    const geometry = buildOutdoorLightingGeometry(new THREE.Group().add(floor))!;
    const bvh = new MeshBVH(geometry);
    const sample = sampleOutdoorIrradiance(bvh, geometry, new THREE.Vector3(0, 0.2, 0), new THREE.Vector3(0, 1, 0), new THREE.Color(1, 1, 1));
    const received = (normal: THREE.Vector3) => sample.bounce.clone()
      .addScaledVector(sample.bounceX, normal.x * 2)
      .addScaledVector(sample.bounceY, normal.y * 2)
      .addScaledVector(sample.bounceZ, normal.z * 2)
      .max(new THREE.Vector3());
    // A white Lambert floor under unit irradiance returns unit irradiance downward.
    expect(received(new THREE.Vector3(0, -1, 0)).x).toBeCloseTo(1, 6);
    expect(received(new THREE.Vector3(0, 1, 0)).length()).toBeLessThan(1e-6);
    expect(sample.bounce.x).toBeCloseTo(0.5, 6);
    const unlit = sampleOutdoorIrradiance(bvh, geometry, new THREE.Vector3(0, 0.2, 0), new THREE.Vector3(0, 1, 0), new THREE.Color(0, 0, 0));
    expect(unlit.bounce.length()).toBe(0);
    geometry.dispose();
    floor.geometry.dispose(); floor.material.dispose();
  });

  it('patches only indirect terms and removes its resources when disabled', () => {
    const mesh = wall(4,4,4,0,2,0);
    const root = new THREE.Group().add(mesh);
    const runtime = new OutdoorSpatialLighting();
    const sun = new THREE.DirectionalLight(); sun.position.set(-20,30,20);
    runtime.apply(root,sun,0.5);
    const shader = { uniforms:{}, vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
    mesh.material.onBeforeCompile(shader,{} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('irradiance = irradiance * outdoorVisibility');
    expect(shader.fragmentShader).not.toContain('outdoorBounce * PI');
    expect(shader.fragmentShader).toContain('outdoorBounceX * outdoorWorldNormal.x');
    for (const key of ['uOutdoorLocalBounce', 'uOutdoorLocalBounceX', 'uOutdoorLocalBounceY', 'uOutdoorLocalBounceZ']) {
      expect(shader.uniforms[key].value.type).toBe(THREE.HalfFloatType);
    }
    expect(shader.fragmentShader).not.toContain('reflectedLight.directDiffuse *=');
    expect(shader.fragmentShader).toContain('#include <lights_fragment_begin>');
    expect(shader.vertexShader).toContain('instanceMatrix * outdoorLightPosition');
    while (runtime.getProgress() < 1) runtime.update(100);
    expect(shader.uniforms.uOutdoorSpatialReady.value).toBe(1);
    const yMoment = shader.uniforms.uOutdoorLocalBounceY.value as THREE.Data3DTexture;
    expect(Array.from(yMoment.image.data as Uint16Array).some(value => THREE.DataUtils.fromHalfFloat(value) < 0)).toBe(true);
    runtime.clear();
    const restored = {uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader} as THREE.WebGLProgramParametersWithUniforms;
    mesh.material.onBeforeCompile(restored,{} as THREE.WebGLRenderer);
    expect(restored.fragmentShader).not.toContain('uOutdoorVisibilityPositive');
  });

  it('keeps irradiance identical when a symmetric receiver is mirrored', () => {
    const floor = wall(40,0.5,40,0,0,0);
    const root = new THREE.Group().add(floor);
    const sample = () => {
      const geometry = buildOutdoorLightingGeometry(root)!;
      const bvh = new MeshBVH(geometry);
      const result = sampleOutdoorIrradiance(bvh,geometry,new THREE.Vector3(0,1,0),new THREE.Vector3(0,1,0),new THREE.Color(4,3,2));
      geometry.dispose();
      return result.bounce.toArray();
    };
    const original = sample(); floor.scale.x = -1;
    expect(sample()).toEqual(original);
  });

  it('uses the supplied sky only for diffuse IBL and leaves reflection sampling intact', () => {
    const mesh = wall(4, 4, 4, 0, 2, 0);
    const root = new THREE.Group().add(mesh);
    const sky = new THREE.Texture(); sky.mapping = THREE.CubeUVReflectionMapping;
    sky.image = { width: 768, height: 1024 };
    const disposed = { value: false }; sky.addEventListener('dispose', () => { disposed.value = true; });
    const runtime = new OutdoorSpatialLighting();
    runtime.apply(root, new THREE.DirectionalLight(), 0.5, root, sky);
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
    mesh.material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.uOutdoorDiffuseSky.value).toBe(sky);
    expect(shader.fragmentShader).toContain('iblIrradiance += getOutdoorSkyIrradiance( geometryNormal );');
    expect(shader.fragmentShader).not.toContain('iblIrradiance += getIBLIrradiance( geometryNormal );');
    expect(shader.fragmentShader).toContain('textureCubeUV( uOutdoorDiffuseSky, worldNormal, 1.0 )');
    expect(shader.fragmentShader).toContain('return PI * skyRadiance.rgb * envMapIntensity;');
    const specular = THREE.ShaderChunk.lights_fragment_maps.slice(THREE.ShaderChunk.lights_fragment_maps.indexOf('#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )'));
    expect(shader.fragmentShader).toContain(specular);
    runtime.clear();
    expect(disposed.value).toBe(false);
    runtime.apply(root, new THREE.DirectionalLight(), 0.5);
    const restored = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
    mesh.material.onBeforeCompile(restored, {} as THREE.WebGLRenderer);
    expect(restored.fragmentShader).not.toContain('getOutdoorSkyIrradiance');
    expect(restored.fragmentShader).toContain('#include <lights_fragment_maps>');
    runtime.clear(); sky.dispose(); mesh.geometry.dispose(); mesh.material.dispose();
  });
});
