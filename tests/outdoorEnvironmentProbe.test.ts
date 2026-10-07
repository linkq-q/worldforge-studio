import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutdoorEnvironmentProbe } from '../src/client/outdoorEnvironmentProbe';

afterEach(() => vi.restoreAllMocks());

describe('courtyard reflection and diffuse light capture', () => {
  it('uses synchronous Three r160 readback for diffuse light and restores the preceding sky environment', () => {
    const previousTarget = new THREE.WebGLRenderTarget(2, 2);
    const reflection = new THREE.WebGLRenderTarget(16, 16);
    const releaseReflection = vi.spyOn(reflection, 'dispose');
    const capture = vi.spyOn(THREE.CubeCamera.prototype, 'update').mockImplementation(() => {});
    vi.spyOn(THREE.PMREMGenerator.prototype, 'fromCubemap').mockReturnValue(reflection);
    const reads = vi.fn((_target, _x, _y, _w, _h, buffer: Uint16Array) => {
      for (let i = 0; i < buffer.length; i += 4) {
        buffer[i] = THREE.DataUtils.toHalfFloat(0.8);
        buffer[i + 1] = THREE.DataUtils.toHalfFloat(0.4);
        buffer[i + 2] = THREE.DataUtils.toHalfFloat(0.2);
        buffer[i + 3] = THREE.DataUtils.toHalfFloat(1);
      }
    });
    const render = vi.fn();
    const renderer = {
      compile: vi.fn(), getRenderTarget: () => previousTarget,
      setRenderTarget: vi.fn(), readRenderTargetPixels: reads, render,
    } as unknown as THREE.WebGLRenderer;
    const scene = new THREE.Scene();
    const sky = new THREE.Texture();
    scene.environment = sky;
    const content = new THREE.Mesh(new THREE.BoxGeometry(20, 40, 50));
    scene.add(content);
    const sync = vi.fn();
    const runtime = new OutdoorEnvironmentProbe(renderer, scene, sync);
    runtime.capture(content, 0.8, 0.4);
    expect(capture).toHaveBeenCalledOnce();
    expect(reads).toHaveBeenCalledTimes(6);
    const light = scene.getObjectByName('outdoorCourtyardBounce') as THREE.LightProbe;
    expect(light).toBeInstanceOf(THREE.LightProbe);
    expect(light.intensity).toBeCloseTo(0.28);
    expect(light.sh.coefficients[0].x / light.sh.coefficients[0].z).toBeCloseTo(4);
    expect(scene.environment).not.toBe(reflection.texture);
    expect(sync).toHaveBeenLastCalledWith(scene.environment);
    expect(render).toHaveBeenCalledOnce();
    const scaleMaterial = (render.mock.calls[0][0] as THREE.Mesh).material as THREE.ShaderMaterial;
    expect(scaleMaterial.uniforms.uIntensity.value).toBe(0.4);
    // Reflection strength must not attenuate the RGB readback used by the diffuse probe.
    expect(light.sh.coefficients[0].x).toBeGreaterThan(2.8);
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(previousTarget);
    runtime.clear();
    expect(scene.getObjectByName('outdoorCourtyardBounce')).toBeUndefined();
    expect(scene.environment).toBe(sky);
    expect(sync).toHaveBeenLastCalledWith(sky);
    expect(releaseReflection).toHaveBeenCalledOnce();
    content.geometry.dispose();
    previousTarget.dispose();
    sky.dispose();
  });
});
