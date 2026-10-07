import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createOutdoorSky, OutdoorAtmosphereRuntime } from '../src/client/outdoorAtmosphereRuntime';
import { OutdoorSunShaftPass } from '../src/client/outdoorSunShaftPass';
import { BILLOWING_CLOUD_FUNCTIONS } from '../src/client/outdoorCloudVolumeV2';
import { isNormalDepthPrePassMesh } from '../src/client/renderPrePassPolicy';

describe('outdoor sky and air', () => {
  it('uses the light world direction in the sky and excludes the dome from geometry depth', () => {
    const sun = new THREE.DirectionalLight();
    sun.position.set(70, 40, -20);
    sun.target.position.set(10, 0, 5);
    const sky = createOutdoorSky(sun, { haze: 0.4, clouds: 0.35, reflections: 0.6 });
    const expected = new THREE.Vector3(60, 40, -25).normalize();
    expect(sky.material.uniforms.sunPosition.value.clone().normalize().distanceTo(expected)).toBeLessThan(1e-6);
    expect(isNormalDepthPrePassMesh(sky)).toBe(false);
    expect(sky.material.depthWrite).toBe(false);
    expect(sky.castShadow).toBe(false);
    expect(sky.material.uniforms.uSkyIntensity.value).toBeCloseTo(0.24);
    sky.geometry.dispose();
    sky.material.dispose();
  });

  it('binds scene depth and actual sun shadow coordinates and leaves owned textures alive', () => {
    const pass = new OutdoorSunShaftPass();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    camera.position.set(12, 8, 14);
    camera.lookAt(0, 4, 0);
    camera.updateMatrixWorld();
    const sun = new THREE.DirectionalLight('#ffe4bd', 3);
    sun.position.set(-20, 40, 30);
    sun.target.position.set(0, 4, 0);
    sun.shadow.map = new THREE.WebGLRenderTarget(32, 32);
    sun.shadow.updateMatrices(sun);
    const depth = new THREE.DepthTexture(320, 200);
    const releaseDepth = vi.spyOn(depth, 'dispose');
    const releaseShadow = vi.spyOn(sun.shadow.map, 'dispose');
    pass.apply(0.4);
    pass.bindFrame(camera, sun, depth);
    expect(pass.uniforms.uHasDepth.value).toBe(1);
    expect(pass.uniforms.uDepth.value).toBe(depth);
    expect(pass.uniforms.uSunShadow.value).toBe(sun.shadow.map.texture);
    expect(pass.uniforms.uCameraWorld.value.elements).toEqual(camera.matrixWorld.elements);
    expect(pass.uniforms.uSunMatrix.value.elements).toEqual(sun.shadow.matrix.elements);
    pass.bindFrame(camera, sun, null);
    expect(pass.uniforms.uHasDepth.value).toBe(0);
    pass.apply(0);
    expect(pass.uniforms.uHaze.value).toBe(0);
    pass.dispose();
    expect(releaseDepth).not.toHaveBeenCalled();
    expect(releaseShadow).not.toHaveBeenCalled();
    sun.shadow.map.dispose();
    depth.dispose();
  });

  it('opts into the far background only for v2 and keeps invalid haze out of shader uniforms', () => {
    const pass = new OutdoorSunShaftPass();
    pass.apply(0.12);
    expect(pass.uniforms.uBackgroundAir?.value).toBe(0);
    pass.apply(0, 2);
    expect(pass.uniforms.uBackgroundAir.value).toBe(1);
    expect(pass.uniforms.uHaze.value).toBe(0);
    pass.apply(Number.NaN, 2);
    expect(pass.uniforms.uHaze.value).toBe(0);
    pass.apply(Number.POSITIVE_INFINITY, 1);
    expect(pass.uniforms.uHaze.value).toBe(0);
    expect(pass.uniforms.uBackgroundAir.value).toBe(0);
    pass.dispose();
  });

  it('keeps v1 selectable and gives v2 a bounded volume with owned noise and the real sun radiance', () => {
    const sun = new THREE.DirectionalLight('#ffe3bd', 4);
    sun.position.set(-10, 30, 20);
    const options = { haze: 0.15, clouds: 0.4, reflections: 0.5 };
    const original = createOutdoorSky(sun, options);
    const detailed = createOutdoorSky(sun, { ...options, quality: 2 });
    expect(original.material.uniforms.uCloudVolumeNoise).toBeUndefined();
    const noise = detailed.material.uniforms.uCloudVolumeNoise.value as THREE.Data3DTexture;
    // The volume shader must let opaque geometry reject hidden sky fragments first.
    expect(detailed.renderOrder).toBeGreaterThan(new THREE.Mesh().renderOrder);
    expect(detailed.material.depthTest).toBe(true);
    expect(detailed.material.depthWrite).toBe(false);
    expect(noise.isData3DTexture).toBe(true);
    expect(noise.image.width).toBe(64);
    expect(detailed.material.uniforms.uCloudLayer.value.toArray()).toEqual([180, 330]);
    expect(detailed.material.uniforms.uCloudSunRadiance.value.toArray())
      .toEqual(sun.color.clone().multiplyScalar(sun.intensity).toArray());
    const release = vi.spyOn(noise, 'dispose');
    detailed.material.dispose();
    expect(release).toHaveBeenCalledOnce();
    original.material.dispose();
    original.geometry.dispose();
    detailed.geometry.dispose();
  });

  it('keeps the accepted cloud branch and switches only the requested sky to the new volume', () => {
    const sun = new THREE.DirectionalLight('#ffe3bd', 4);
    sun.position.set(-10, 30, 20);
    const options = { haze: 0.12, clouds: 0.43, reflections: 0.5, quality: 2 };
    const accepted = createOutdoorSky(sun, options);
    const upgraded = createOutdoorSky(sun, { ...options, skyQuality: 2 });
    const deeper = createOutdoorSky(sun, { ...options, skyQuality: 3 });
    const layered = createOutdoorSky(sun, { ...options, skyQuality: 4 });
    expect(accepted.material.fragmentShader).toContain('vec3 renderCumulus(');
    expect(accepted.material.fragmentShader).not.toContain('vec3 renderBillowingClouds(');
    expect(upgraded.material.fragmentShader).toContain('vec3 renderBillowingClouds(');
    expect(upgraded.material.fragmentShader).toContain(BILLOWING_CLOUD_FUNCTIONS);
    expect(upgraded.material.fragmentShader).not.toContain('vec3 renderCumulus(');
    expect(deeper.material.fragmentShader).toContain('vec3 renderSculptedClouds(');
    expect(deeper.material.fragmentShader).not.toContain('vec3 renderBillowingClouds(');
    expect(layered.material.fragmentShader).toContain('vec3 renderLayeredClouds(');
    expect(layered.material.fragmentShader).not.toContain('vec3 renderSculptedClouds(');
    expect(upgraded.material.uniforms.uCloudShapeNoise).toBeUndefined();
    expect(deeper.material.uniforms.uCloudShapeNoise).toBeUndefined();
    const shapeNoise = layered.material.uniforms.uCloudShapeNoise.value as THREE.Data3DTexture;
    const releaseShape = vi.spyOn(shapeNoise, 'dispose');
    expect(shapeNoise.isData3DTexture).toBe(true);
    expect(shapeNoise.image.data).not.toBe(layered.material.uniforms.uCloudVolumeNoise.value.image.data);
    expect(upgraded.material.uniforms.uCloudSunRadiance.value.toArray())
      .toEqual(accepted.material.uniforms.uCloudSunRadiance.value.toArray());
    expect(deeper.material.uniforms.uCloudSunRadiance.value.toArray())
      .toEqual(accepted.material.uniforms.uCloudSunRadiance.value.toArray());
    for (const sky of [accepted, upgraded, deeper, layered]) { sky.geometry.dispose(); sky.material.dispose(); }
    expect(releaseShape).toHaveBeenCalledOnce();
  });

  it.each([2, 3, 4])('captures the accepted sky and restores sky version %i even when capture throws', skyQuality => {
    const scene = new THREE.Scene();
    const runtime = new OutdoorAtmosphereRuntime({} as THREE.WebGLRenderer, scene);
    const sun = new THREE.DirectionalLight();
    sun.position.set(20, 40, 10);
    runtime.apply(sun, { haze: 0.12, clouds: 0.43, reflections: 0, quality: 2, skyQuality });
    const visible = scene.children[0] as ReturnType<typeof createOutdoorSky>;
    let dispose: ReturnType<typeof vi.spyOn> | undefined;
    expect(() => runtime.withBaselineSkyForCapture(() => {
      expect(visible.visible).toBe(false);
      const baseline = scene.children.find(child => child !== visible) as ReturnType<typeof createOutdoorSky>;
      expect(baseline.material.fragmentShader).toContain('vec3 renderCumulus(');
      expect(baseline.material.fragmentShader).not.toContain('vec3 renderBillowingClouds(');
      dispose = vi.spyOn(baseline.material, 'dispose');
      throw new Error('capture failure');
    })).toThrow('capture failure');
    expect(scene.children).toEqual([visible]);
    expect(visible.visible).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    runtime.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
