import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BLOOM_LAYER } from '../RenderLayers.js';
import { shouldSkipShaderApply } from '../utils/ShaderApplyGuard.js';

const CompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tBloom: { value: null },
    bloomEnabled: { value: 0 },
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
    uniform float bloomEnabled;
    varying vec2 vUv;
    void main() {
      gl_FragColor = texture2D(tDiffuse, vUv) + texture2D(tBloom, vUv) * bloomEnabled;
    }
  `,
};

export class SelectiveBloomPass extends Pass {
  constructor(camera, bloomRoot = null, resolution = new THREE.Vector2(1, 1), strength = 0.42, radius = 0.72, threshold = 0.05) {
    super();
    this.camera = camera;
    this.bloomRoot = bloomRoot;
    this.name = 'SelectiveBloomPass';
    this.bloomPass = new UnrealBloomPass(resolution, strength, radius, threshold);
    this.sceneTarget = new THREE.WebGLRenderTarget(resolution.x, resolution.y, { type: THREE.HalfFloatType });
    this.sceneTarget.texture.name = 'SelectiveBloomPass.scene';
    this.darkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
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

  setBloomRoot(root) {
    this.bloomRoot = root || null;
  }

  setSize(width, height) {
    this.sceneTarget.setSize(width, height);
    this.bloomPass.setSize(width, height);
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    if (!this.bloomRoot?.traverse) {
      this._composite(renderer, writeBuffer, readBuffer, null);
      return;
    }

    const replaced = new Map();
    const hidden = new Map();
    this.bloomRoot.traverse((object) => {
      if (!object.isMesh) return;
      if (object.layers?.isEnabled?.(BLOOM_LAYER)) return;
      if (shouldSkipShaderApply(object)) {
        hidden.set(object, object.visible);
        object.visible = false;
        return;
      }
      replaced.set(object, object.material);
      object.material = this.darkMaterial;
    });

    const previousTarget = renderer.getRenderTarget();
    const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
    const previousClearAlpha = renderer.getClearAlpha();
    try {
      renderer.setRenderTarget(this.sceneTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.bloomRoot, this.camera);
      this.bloomPass.render(renderer, null, this.sceneTarget, deltaTime, maskActive);
    } finally {
      for (const [object, material] of replaced) object.material = material;
      for (const [object, visible] of hidden) object.visible = visible;
      renderer.setClearColor(previousClearColor, previousClearAlpha);
      renderer.setRenderTarget(previousTarget);
    }

    this._composite(renderer, writeBuffer, readBuffer, this.bloomPass.renderTargetsHorizontal[0].texture);
  }

  _composite(renderer, writeBuffer, readBuffer, bloomTexture) {
    this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tBloom.value = bloomTexture || this.sceneTarget.texture;
    this.compositeMaterial.uniforms.bloomEnabled.value = bloomTexture ? 1 : 0;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
  }

  dispose() {
    this.bloomPass.dispose();
    this.sceneTarget.dispose();
    this.darkMaterial.dispose();
    this.compositeMaterial.dispose();
    this.fsQuad.dispose();
  }
}

export default SelectiveBloomPass;
