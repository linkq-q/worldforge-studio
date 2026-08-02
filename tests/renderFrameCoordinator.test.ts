import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderFrameCoordinator } from '../src/client/renderFrameCoordinator';

function createHarness(needsPrePass = true) {
  const order: string[] = [];
  const renderer = {
    render: vi.fn(() => order.push('direct'))
  } as unknown as THREE.WebGLRenderer;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const composer = {
    passes: [] as Array<{ enabled: boolean; renderToScreen: boolean }>,
    render: vi.fn(() => order.push('composer'))
  };
  const planarReflection = {
    render: vi.fn(() => order.push('reflection'))
  };
  const normal = new THREE.Texture();
  const depth = new THREE.DepthTexture(1, 1);
  const coordinator = new RenderFrameCoordinator({
    renderer,
    scene,
    camera,
    composer: composer as unknown as EffectComposer,
    planarReflection,
    needsPrePass: () => needsPrePass,
    producePrePass: () => {
      order.push('prepass');
      return { normal, depth };
    },
    updateWater: (_deltaTime, depthTexture) => {
      order.push(depthTexture === depth ? 'water:depth' : 'water:none');
    }
  });

  return { coordinator, composer, order, normal, depth };
}

describe('RenderFrameCoordinator', () => {
  it('runs reflection, demanded pre-pass, water and the composer in runtime order', () => {
    const { coordinator, order } = createHarness(true);
    coordinator.registerPass({ name: 'base', enabled: true } as never, 'base', 0, true);

    coordinator.renderFrame(1 / 60, 2);

    expect(order).toEqual(['reflection', 'prepass', 'water:depth', 'composer']);
  });

  it('keeps pass membership behind the pipeline registry', () => {
    const { coordinator, composer } = createHarness(false);
    const base = { name: 'base', enabled: true, renderToScreen: false };
    const fog = { name: 'fog', enabled: false, renderToScreen: false };
    coordinator.registerPass(base as never, 'base', 0, true);
    coordinator.registerPass(fog as never, 'fog', 10, false);

    coordinator.renderFrame(1 / 60, 1);
    expect(composer.passes).toEqual([base]);

    coordinator.setPassEnabled('fog', true);
    coordinator.renderFrame(1 / 60, 2);
    expect(composer.passes).toEqual([base, fog]);
  });

  it('does not produce or feed stale depth when no consumer needs the pre-pass', () => {
    const { coordinator, order } = createHarness(false);
    coordinator.registerPass({ name: 'base', enabled: true } as never, 'base', 0, true);

    coordinator.renderFrame(1 / 60, 2);

    expect(order).toEqual(['reflection', 'water:none', 'composer']);
  });
});
