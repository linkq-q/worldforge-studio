import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { RenderRuntimeAdapter } from '../src/client/renderRuntimeAdapter';

const { SharedSSAOPass } = await import(new URL(
  '../vendor/voxel-render-runtime/src/passes/SharedSSAOPass.js', import.meta.url
).href);

function makePass() {
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1500);
  const pass = new SharedSSAOPass(new THREE.Scene(), camera, 64, 48, 16);
  // Exercise real per-frame uniform updates without requiring a GPU in Vitest.
  pass._renderPass = vi.fn();
  return { pass, camera };
}

describe('SSAO quality', () => {
  it('keeps contact distances in scene units when camera clipping changes', () => {
    const { pass, camera } = makePass();
    try {
      pass.minDistance = 0.02;
      pass.maxDistance = 0.75;
      for (const far of [80, 1500]) {
        camera.far = far;
        camera.updateProjectionMatrix();
        pass.render({}, null, { texture: null });
        const span = camera.far - camera.near;
        expect(pass.ssaoMaterial.uniforms.minDistance.value * span).toBeCloseTo(0.02);
        expect(pass.ssaoMaterial.uniforms.maxDistance.value * span).toBeCloseTo(0.75);
      }
    } finally { pass.dispose(); }
  });

  it('uses a full turn of stable angular noise, not two collinear directions', () => {
    const { pass } = makePass();
    const { pass: second } = makePass();
    try {
      const data = Array.from(pass.noiseTexture.image.data) as number[];
      expect(data.every((value) => value >= 0 && value < 1)).toBe(true);
      expect(new Set(data).size).toBe(16);
      expect(second.noiseTexture.image.data).toEqual(pass.noiseTexture.image.data);
      expect(pass.ssaoMaterial.fragmentShader).toContain('cos(angle)');
      expect(pass.ssaoMaterial.fragmentShader).toContain('sin(angle)');
      expect(pass.ssaoMaterial.fragmentShader).not.toContain('vec3 random = vec3(');
      expect(pass.ssaoMaterial.fragmentShader).toContain('samplePoint.z >= -cameraNear');
      expect(pass.ssaoMaterial.fragmentShader).toContain('greaterThan(samplePointUv');
    } finally { pass.dispose(); second.dispose(); }
  });

  it('limits AO darkening without scaling the scene copy or background', () => {
    const { pass } = makePass();
    try {
      pass.strength = 0.35;
      pass.render({}, null, { texture: null });
      expect(pass.blurMaterial.uniforms.strength.value).toBe(0.35);
      expect(pass.blurMaterial.fragmentShader).toContain('mix(1.0, occlusion, strength)');
      expect(pass.blurMaterial.fragmentShader).toContain('uniform highp sampler2D tDepth');
      expect(pass.copyMaterial.uniforms.opacity.value).toBe(1);
      pass.strength = 0;
      pass.render({}, null, { texture: null });
      expect(pass.blurMaterial.uniforms.strength.value).toBe(0);
    } finally { pass.dispose(); }
  });

  it('makes soft local and weaker than strong, while off disables the pass', () => {
    const { pass } = makePass();
    const adapter = Object.assign(Object.create(RenderRuntimeAdapter.prototype), {
      ssaoPass: pass,
      bloomPass: {},
      frameCoordinator: { setPassEnabled: (id: string, enabled: boolean) => {
        if (id === 'ssao') pass.enabled = enabled;
      } }
    }) as RenderRuntimeAdapter;
    try {
      adapter.applyPostQuality({ ssao: 'soft', bloom: 'off', depthOfField: 'off' });
      expect(pass.enabled).toBe(true);
      expect(pass.kernelRadius).toBeGreaterThan(0);
      expect(pass.kernelRadius).toBeLessThanOrEqual(1);
      expect(pass.minDistance).toBeLessThan(0.05);
      expect(pass.maxDistance).toBeLessThanOrEqual(1);
      expect(pass.strength).toBeGreaterThan(0);
      expect(pass.strength).toBeLessThanOrEqual(0.4);
      const softStrength = pass.strength;
      adapter.applyPostQuality({ ssao: 'strong', bloom: 'off', depthOfField: 'off' });
      expect(pass.strength).toBeGreaterThan(softStrength);
      expect(pass.strength).toBeLessThan(1);
      adapter.applyPostQuality({ ssao: 'off', bloom: 'off', depthOfField: 'off' });
      expect(pass.enabled).toBe(false);
    } finally { pass.dispose(); }
  });
});
