import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { OutdoorEdgeNormals } from '../src/client/outdoorEdgeNormals';

function compile(material: THREE.Material) {
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

describe('outdoor box edge shading', () => {
  it('adds metre-based highlights without editing geometry, then restores the material', () => {
    const geometry = new THREE.BoxGeometry(2, 4, 6);
    const vertices = Array.from(geometry.attributes.position.array);
    const material = new THREE.MeshStandardMaterial({roughness:0.7});
    const mesh = new THREE.InstancedMesh(geometry,material,2);
    const runtime = new OutdoorEdgeNormals();
    runtime.apply(new THREE.Group().add(mesh),0.04,0.85);
    const shader = compile(material);
    expect(shader.uniforms.uOutdoorEdgeMin.value.toArray()).toEqual([-1,-2,-3]);
    expect(shader.uniforms.uOutdoorEdgeMax.value.toArray()).toEqual([1,2,3]);
    expect(shader.vertexShader).toContain('outdoorEdgeTransform *= instanceMatrix');
    expect(shader.uniforms.uOutdoorRoughnessScale.value).toBe(0.85);
    expect(Array.from(geometry.attributes.position.array)).toEqual(vertices);
    expect(material.roughness).toBe(0.7);
    runtime.clear();
    expect(compile(material).fragmentShader).toBe(THREE.ShaderLib.standard.fragmentShader);
  });

  it('leaves foliage, incompatible geometry and external shared materials unchanged', () => {
    const shared = new THREE.MeshStandardMaterial();
    const mixed = new THREE.MeshStandardMaterial();
    const foliage = new THREE.MeshStandardMaterial(); foliage.userData.effectVariant = {uniforms:{uFoliageTransmission:{value:1}}};
    const geometry = new THREE.BoxGeometry();
    const root = new THREE.Group().add(new THREE.Mesh(geometry,shared), new THREE.Mesh(geometry,mixed),
      new THREE.Mesh(new THREE.SphereGeometry(),mixed),new THREE.Mesh(geometry,foliage));
    new THREE.Scene().add(root,new THREE.Mesh(geometry,shared));
    new OutdoorEdgeNormals().apply(root,0.05);
    for (const material of [shared,mixed,foliage]) expect(compile(material).fragmentShader).toBe(THREE.ShaderLib.standard.fragmentShader);
  });
});
