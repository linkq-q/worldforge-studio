import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const CompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tBloom: { value: null },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    varying vec2 vUv;
    void main() {
      gl_FragColor = texture2D(tDiffuse, vUv) + texture2D(tBloom, vUv);
    }
  `,
};

/**
 * GlobalBloomPass — 经典全屏亮度阈值 bloom：直接对已合成帧（readBuffer）做
 * UnrealBloomPass 的内建 luminosity highpass，不做按物体 mask/黑化。
 *
 * 与 SelectiveBloomPass（按 tag/effect 强制点亮 BLOOM_LAYER 部件，强度由效果
 * 自身参数决定，不受本 pass 影响）是两套独立机制：打了 tag 的发光部件（火焰/
 * 金属高光等）的自发光强度不该被这个全局滑条二次放大——只有整帧的亮度溢出
 * 部分（真正的"全屏 bloom"）受 bloomStrength/bloomRadius 滑条控制。
 * 2026-07-17 解耦，render-runtime-package-v1 A2 后续需求。
 */
export class GlobalBloomPass extends Pass {
  constructor(resolution = new THREE.Vector2(1, 1), strength = 0.4, radius = 0.4, threshold = 0.85) {
    super();
    this.name = 'GlobalBloomPass';
    this.bloomPass = new UnrealBloomPass(resolution, strength, radius, threshold);
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CompositeShader.uniforms),
      vertexShader: CompositeShader.vertexShader,
      fragmentShader: CompositeShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.compositeMaterial);
  }

  get strength() { return this.bloomPass.strength; }
  set strength(value) { this.bloomPass.strength = value; }
  get radius() { return this.bloomPass.radius; }
  set radius(value) { this.bloomPass.radius = value; }
  get threshold() { return this.bloomPass.threshold; }
  set threshold(value) { this.bloomPass.threshold = value; }

  setSize(width, height) {
    this.bloomPass.setSize(width, height);
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    // readBuffer 已经是链条走到这一步的合成帧（RenderPass + SelectiveBloomPass 之后）；
    // UnrealBloomPass 内部按 luminosityThreshold 直接从这张纹理提亮，不需要额外渲染。
    this.bloomPass.render(renderer, null, readBuffer, deltaTime, maskActive);

    this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tBloom.value = this.bloomPass.renderTargetsHorizontal[0].texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
  }

  dispose() {
    this.bloomPass.dispose();
    this.compositeMaterial.dispose();
    this.fsQuad.dispose();
  }
}

export default GlobalBloomPass;
