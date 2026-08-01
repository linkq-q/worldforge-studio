import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  COMPOSER_MSAA_SAMPLES,
  configureRendererOutput,
  createComposerRenderTarget
} from '../src/client/renderOutputPipeline';

describe('render output pipeline', () => {
  it('creates a four-sample composer target', () => {
    const target = createComposerRenderTarget();
    expect(target.samples).toBe(COMPOSER_MSAA_SAMPLES);
    expect(target.depthBuffer).toBe(true);
    expect(target.stencilBuffer).toBe(false);
    target.dispose();
  });

  it('keeps ACES enabled with or without a render scheme', () => {
    const renderer = {
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 0
    } as THREE.WebGLRenderer;

    configureRendererOutput(renderer, 1.25);

    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.toneMappingExposure).toBe(1.25);
  });
});
