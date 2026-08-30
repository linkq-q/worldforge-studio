import * as THREE from 'three';

export const COMPOSER_MSAA_SAMPLES = 4;

export function createComposerRenderTarget(width = 1, height = 1): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: true,
    // hAIde-seek 投票模式：2D 剪影描边依赖 stencil（mask + NotEqual 双 pass），需要 stencil 附件
    stencilBuffer: true
  });
  target.samples = COMPOSER_MSAA_SAMPLES;
  target.texture.colorSpace = THREE.NoColorSpace;
  return target;
}

export function configureRendererOutput(renderer: THREE.WebGLRenderer, exposure = 1): void {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;
}
