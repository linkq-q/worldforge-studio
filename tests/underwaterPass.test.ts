import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  absorptionFromTransmittance,
  createUnderwaterPass
} from '@voxel-studio/render-runtime/postprocess';

describe('underwater post-process', () => {
  it('derives stronger red absorption from a blue-green transmission color', () => {
    const absorption = absorptionFromTransmittance(new THREE.Color(0.18, 0.55, 0.72), 35);

    expect(absorption.x).toBeGreaterThan(absorption.y);
    expect(absorption.y).toBeGreaterThan(absorption.z);
    expect(absorption.x).toBeCloseTo(-Math.log(0.18) / 35, 6);
  });

  it('uses scene depth and an analytic water-plane exit instead of tinting the whole frame uniformly', () => {
    const pass = createUnderwaterPass();
    const shader = pass.material.fragmentShader;

    expect(shader).toContain('texture2D(tDepth, vUv)');
    expect(shader).toContain('uProjectionMatrixInverse');
    expect(shader).toContain('uCameraMatrixWorld');
    expect(shader).toContain('(uWaterLevel - uCameraPosition.y) / verticalDelta');
    expect(shader).toContain('cameraUnderwater ? planeFraction : 1.0 - planeFraction');
    expect(shader).toContain('cameraUnderwater');
    expect(shader).toContain('sceneUnderwater');
    expect(shader).toContain('exp(-uAbsorption * max(waterDistance, 0.0))');
    expect(shader).toContain('mix(inColor.rgb, scattered, uSubmersion)');
    expect(shader).not.toContain('texture2D(tDiffuse, vUv +');

    pass.dispose();
  });

  it('adds restrained animated caustics only to real submerged scene geometry', () => {
    const pass = createUnderwaterPass();
    const shader = pass.material.fragmentShader;

    expect(pass.uniforms.uTime.value).toBe(0);
    expect(pass.uniforms.uCausticStrength.value).toBe(0.12);
    expect(shader).toContain('if (sceneUnderwater && depthSample < 0.9999)');
    expect(shader).toContain('vec2 causticPosition = scenePosition.xz * 1.4');
    expect(shader).toContain('uTime * 0.65');
    expect(shader).toContain('uTime * 0.52');
    expect(shader).toContain('exp(-waterDepth * 0.18)');
    expect(shader).toContain('scattered += vec3(0.38, 0.72, 0.82) * caustic');

    pass.dispose();
  });
});
