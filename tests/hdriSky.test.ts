import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createRotatedHdriEnvironmentScene } from '../src/client/hdriSky';

describe('HDRI environment orientation', () => {
  it('uses the visible sky rotation when preparing the PMREM source scene', () => {
    const texture = new THREE.Texture();
    const prepared = createRotatedHdriEnvironmentScene(texture, 24);
    const mesh = prepared.scene.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.ShaderMaterial;

    expect(material.uniforms.uMap.value).toBe(texture);
    expect(material.uniforms.uRotationY.value).toBeCloseTo(THREE.MathUtils.degToRad(24));

    prepared.dispose();
  });
});
