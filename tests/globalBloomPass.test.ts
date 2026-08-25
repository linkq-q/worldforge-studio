import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GlobalBloomPass } from '@voxel-studio/render-runtime/postprocess';

describe('GlobalBloomPass composer contract', () => {
  it('delegates one in-place bloom composite without swapping buffers', () => {
    const pass = new GlobalBloomPass(new THREE.Vector2(4, 4));
    const render = vi.fn();
    const internal = pass as GlobalBloomPass & {
      bloomPass: { render: typeof render };
    };
    internal.bloomPass.render = render;
    const renderer = {} as THREE.WebGLRenderer;
    const writeBuffer = {} as THREE.WebGLRenderTarget;
    const readBuffer = {} as THREE.WebGLRenderTarget;

    pass.render(renderer, writeBuffer, readBuffer, 1 / 60, false);

    expect(pass.needsSwap).toBe(false);
    expect(render).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith(renderer, writeBuffer, readBuffer, 1 / 60, false);
    pass.dispose();
  });
});
