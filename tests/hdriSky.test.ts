import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createRotatedHdriEnvironmentScene } from '../src/client/hdriSky';

describe('HDRI environment orientation', () => {
  it('uses the visible sky rotation when preparing the PMREM source scene', () => {
    const texture = new THREE.Texture();
    const prepared = createRotatedHdriEnvironmentScene(texture, 24, {
      exposure: 0.9,
      saturation: 0.8,
      environmentIntensity: 0.55,
      tint: '#ffe8d0',
      tintStrength: 0.2
    });
    const mesh = prepared.scene.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.ShaderMaterial;

    expect(material.uniforms.uMap.value).toBe(texture);
    expect(material.uniforms.uRotationY.value).toBeCloseTo(THREE.MathUtils.degToRad(24));
    expect(material.uniforms.uExposure.value).toBe(0.9);
    expect(material.uniforms.uSaturation.value).toBe(0.8);
    expect(material.uniforms.uIntensity.value).toBe(0.55);
    expect(material.uniforms.uApplyTint.value).toBe(true);

    prepared.dispose();
  });
});
