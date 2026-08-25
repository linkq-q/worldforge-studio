import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

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
    // UnrealBloomPass already composites additively into readBuffer and declares
    // needsSwap=false. Mirroring that contract prevents the wrapper from adding
    // bloom a second time and feeding a swapped, over-bright buffer into later
    // depth effects such as ExponentialFogPass.
    this.needsSwap = false;
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
    this.bloomPass.renderToScreen = this.renderToScreen;
    this.bloomPass.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }

  dispose() {
    this.bloomPass.dispose();
  }
}

export default GlobalBloomPass;
