/**
 * SharedSSAOPass.js — SSAO pass that reuses an externally-provided
 * normal + depth render target instead of rendering the scene again.
 *
 * Forked from Three.js 0.160 SSAOPass (MIT).  Key difference:
 *   - No internal normalRenderTarget
 *   - No renderOverride() call
 *   - Uses setSharedNormalDepth() → normal + depth from project prePass
 *
 * Saves one full-scene renderer.render(scene, camera) per frame.
 */

import {
  AddEquation,
  Color,
  CustomBlending,
  DataTexture,
  DstAlphaFactor,
  DstColorFactor,
  FloatType,
  HalfFloatType,
  NearestFilter,
  NoBlending,
  RedFormat,
  RepeatWrapping,
  ShaderMaterial,
  UniformsUtils,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  ZeroFactor,
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { SSAOShader, SSAODepthShader } from 'three/addons/shaders/SSAOShader.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { TraceGate } from '../debug/TraceGate.js';

const DepthAwareSSAOBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    tNormal: { value: null },
    resolution: { value: new Vector2() },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform sampler2D tNormal;
    uniform vec2 resolution;
    uniform float cameraNear;
    uniform float cameraFar;
    varying vec2 vUv;

    #include <packing>

    float getViewZ(vec2 uv) {
      return perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
    }

    vec3 getViewNormal(vec2 uv) {
      return normalize(texture2D(tNormal, uv).xyz * 2.0 - 1.0);
    }

    void main() {
      float centerDepth = texture2D(tDepth, vUv).x;
      if (centerDepth >= 1.0) {
        gl_FragColor = vec4(1.0);
        return;
      }

      vec2 texel = 1.0 / resolution;
      float centerViewZ = getViewZ(vUv);
      vec3 centerNormal = getViewNormal(vUv);
      float depthScale = max(0.05, abs(centerViewZ) * 0.01);
      float result = 0.0;
      float weightSum = 0.0;

      for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
          vec2 offset = vec2(float(x), float(y));
          vec2 sampleUv = clamp(vUv + offset * texel, vec2(0.0), vec2(1.0));
          float sampleDepth = texture2D(tDepth, sampleUv).x;
          if (sampleDepth >= 1.0) continue;

          float depthWeight = exp(-abs(getViewZ(sampleUv) - centerViewZ) / depthScale);
          float normalWeight = pow(max(dot(centerNormal, getViewNormal(sampleUv)), 0.0), 8.0);
          float spatialWeight = exp(-dot(offset, offset) * 0.35);
          float weight = depthWeight * normalWeight * spatialWeight;
          result += texture2D(tDiffuse, sampleUv).r * weight;
          weightSum += weight;
        }
      }

      float occlusion = weightSum > 0.0 ? result / weightSum : texture2D(tDiffuse, vUv).r;
      gl_FragColor = vec4(vec3(occlusion), 1.0);
    }
  `,
};

export class SharedSSAOPass extends Pass {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {number} [width]
   * @param {number} [height]
   * @param {number} [kernelSize=32]
   */
  constructor(scene, camera, width, height, kernelSize = 32) {
    super();

    this.width = width !== undefined ? width : 512;
    this.height = height !== undefined ? height : 512;

    this.clear = true;

    this.camera = camera;
    this.scene = scene;

    this.kernelRadius = 5;
    this.kernel = [];
    this.noiseTexture = null;
    this.output = 0;

    this.minDistance = 0.005;
    this.maxDistance = 0.05;

    // ── Shared prePass textures (set via setSharedNormalDepth) ──
    /** @type {THREE.Texture|null} */
    this.sharedNormalTexture = null;
    /** @type {THREE.Texture|null} */
    this.sharedDepthTexture = null;
    /** Whether to skip internal scene render */
    this.useSharedPrePass = true;
    /** For trace logging */
    this.internalRenderOverrideSkipped = true;

    // ── Generate kernel & noise ──
    this._generateSampleKernel(kernelSize);
    this._generateRandomKernelRotations();

    // ── SSAO render target ──
    this.ssaoRenderTarget = new WebGLRenderTarget(this.width, this.height, {
      type: HalfFloatType,
    });

    this.blurRenderTarget = this.ssaoRenderTarget.clone();

    // ── SSAO material ──
    this.ssaoMaterial = new ShaderMaterial({
      defines: Object.assign({}, SSAOShader.defines),
      uniforms: UniformsUtils.clone(SSAOShader.uniforms),
      vertexShader: SSAOShader.vertexShader,
      fragmentShader: SSAOShader.fragmentShader,
      blending: NoBlending,
    });

    this.ssaoMaterial.defines['KERNEL_SIZE'] = kernelSize;

    // tNormal/tDepth point to shared textures initially (null-safe — set by setSharedNormalDepth)
    this.ssaoMaterial.uniforms['tNormal'].value = null;
    this.ssaoMaterial.uniforms['tDepth'].value = null;
    this.ssaoMaterial.uniforms['tNoise'].value = this.noiseTexture;
    this.ssaoMaterial.uniforms['kernel'].value = this.kernel;
    this.ssaoMaterial.uniforms['cameraNear'].value = this.camera.near;
    this.ssaoMaterial.uniforms['cameraFar'].value = this.camera.far;
    this.ssaoMaterial.uniforms['resolution'].value.set(this.width, this.height);
    this.ssaoMaterial.uniforms['cameraProjectionMatrix'].value.copy(this.camera.projectionMatrix);
    this.ssaoMaterial.uniforms['cameraInverseProjectionMatrix'].value.copy(this.camera.projectionMatrixInverse);

    // ── Blur material ──
    this.blurMaterial = new ShaderMaterial({
      uniforms: UniformsUtils.clone(DepthAwareSSAOBlurShader.uniforms),
      vertexShader: DepthAwareSSAOBlurShader.vertexShader,
      fragmentShader: DepthAwareSSAOBlurShader.fragmentShader,
    });
    this.blurMaterial.uniforms['tDiffuse'].value = this.ssaoRenderTarget.texture;
    this.blurMaterial.uniforms['cameraNear'].value = this.camera.near;
    this.blurMaterial.uniforms['cameraFar'].value = this.camera.far;
    this.blurMaterial.uniforms['resolution'].value.set(this.width, this.height);

    // ── Depth visualization material ──
    this.depthRenderMaterial = new ShaderMaterial({
      defines: Object.assign({}, SSAODepthShader.defines),
      uniforms: UniformsUtils.clone(SSAODepthShader.uniforms),
      vertexShader: SSAODepthShader.vertexShader,
      fragmentShader: SSAODepthShader.fragmentShader,
      blending: NoBlending,
    });
    // tDepth will be updated in setSharedNormalDepth
    this.depthRenderMaterial.uniforms['tDepth'].value = null;
    this.depthRenderMaterial.uniforms['cameraNear'].value = this.camera.near;
    this.depthRenderMaterial.uniforms['cameraFar'].value = this.camera.far;

    // ── Copy material for output blending ──
    this.copyMaterial = new ShaderMaterial({
      uniforms: UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blendSrc: DstColorFactor,
      blendDst: ZeroFactor,
      blendEquation: AddEquation,
      blendSrcAlpha: DstAlphaFactor,
      blendDstAlpha: ZeroFactor,
      blendEquationAlpha: AddEquation,
    });

    this.fsQuad = new FullScreenQuad(null);
    this.originalClearColor = new Color();
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Set shared normal + depth textures from project prePass.
   * Call once after bundle creation, and after any RT resize.
   * @param {THREE.Texture} normalTexture
   * @param {THREE.Texture} depthTexture
   */
  setSharedNormalDepth(normalTexture, depthTexture) {
    this.sharedNormalTexture = normalTexture;
    this.sharedDepthTexture = depthTexture;

    this.ssaoMaterial.uniforms['tNormal'].value = normalTexture;
    this.ssaoMaterial.uniforms['tDepth'].value = depthTexture;
    this.blurMaterial.uniforms['tNormal'].value = normalTexture;
    this.blurMaterial.uniforms['tDepth'].value = depthTexture;
    this.depthRenderMaterial.uniforms['tDepth'].value = depthTexture;
  }

  dispose() {
    this.ssaoRenderTarget.dispose();
    this.blurRenderTarget.dispose();

    if (this.noiseTexture) {
      this.noiseTexture.dispose();
      this.noiseTexture = null;
    }

    this.ssaoMaterial.dispose();
    this.blurMaterial.dispose();
    this.copyMaterial.dispose();
    this.depthRenderMaterial.dispose();
    this.fsQuad.dispose();

    // NOTE: sharedNormalTexture / sharedDepthTexture are NOT disposed —
    // they are owned by PostProcessPanel.
  }

  // ── Render ────────────────────────────────────────────────

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget|null} writeBuffer
   * @param {THREE.WebGLRenderTarget|null} readBuffer
   */
  render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */) {
    const tStart = performance.now();
    let tSsao = 0, tBlur = 0, tOutput = 0;

    // ── Sync camera params every frame ──
    this.ssaoMaterial.uniforms['cameraNear'].value = this.camera.near;
    this.ssaoMaterial.uniforms['cameraFar'].value = this.camera.far;
    this.ssaoMaterial.uniforms['cameraProjectionMatrix'].value.copy(this.camera.projectionMatrix);
    this.ssaoMaterial.uniforms['cameraInverseProjectionMatrix'].value.copy(this.camera.projectionMatrixInverse);
    this.blurMaterial.uniforms['cameraNear'].value = this.camera.near;
    this.blurMaterial.uniforms['cameraFar'].value = this.camera.far;
    this.depthRenderMaterial.uniforms['cameraNear'].value = this.camera.near;
    this.depthRenderMaterial.uniforms['cameraFar'].value = this.camera.far;

    // ═══════════════════════════════════════════════════════════
    // KEY CHANGE: DO NOT call renderOverride().
    // Shared normal/depth textures are already set via
    // setSharedNormalDepth() and synced each frame.
    //
    // WAS: this.renderOverride(renderer, this.normalMaterial,
    //          this.normalRenderTarget, 0x7777ff, 1.0);
    // NOW: textures come from project prePass — zero scene renders.
    // ═══════════════════════════════════════════════════════════
    this.internalRenderOverrideSkipped = true;

    // Render SSAO
    const tSsaoStart = performance.now();
    this.ssaoMaterial.uniforms['kernelRadius'].value = this.kernelRadius;
    this.ssaoMaterial.uniforms['minDistance'].value = this.minDistance;
    this.ssaoMaterial.uniforms['maxDistance'].value = this.maxDistance;
    this._renderPass(renderer, this.ssaoMaterial, this.ssaoRenderTarget);
    tSsao = performance.now() - tSsaoStart;

    // Render blur
    const tBlurStart = performance.now();
    this._renderPass(renderer, this.blurMaterial, this.blurRenderTarget);
    tBlur = performance.now() - tBlurStart;

    // Output result to screen
    const tOutputStart = performance.now();
    switch (this.output) {
      case SharedSSAOPass.OUTPUT.SSAO:
        this.copyMaterial.uniforms['tDiffuse'].value = this.ssaoRenderTarget.texture;
        this.copyMaterial.blending = NoBlending;
        this._renderPass(renderer, this.copyMaterial, this.renderToScreen ? null : writeBuffer);
        break;

      case SharedSSAOPass.OUTPUT.Blur:
        this.copyMaterial.uniforms['tDiffuse'].value = this.blurRenderTarget.texture;
        this.copyMaterial.blending = NoBlending;
        this._renderPass(renderer, this.copyMaterial, this.renderToScreen ? null : writeBuffer);
        break;

      case SharedSSAOPass.OUTPUT.Depth:
        this._renderPass(renderer, this.depthRenderMaterial, this.renderToScreen ? null : writeBuffer);
        break;

      case SharedSSAOPass.OUTPUT.Normal:
        // Use shared normal texture instead of internal normalRenderTarget
        this.copyMaterial.uniforms['tDiffuse'].value = this.sharedNormalTexture || this.ssaoRenderTarget.texture;
        this.copyMaterial.blending = NoBlending;
        this._renderPass(renderer, this.copyMaterial, this.renderToScreen ? null : writeBuffer);
        break;

      case SharedSSAOPass.OUTPUT.Default:
      default:
        this.copyMaterial.uniforms['tDiffuse'].value = readBuffer.texture;
        this.copyMaterial.blending = NoBlending;
        this._renderPass(renderer, this.copyMaterial, this.renderToScreen ? null : writeBuffer);

        this.copyMaterial.uniforms['tDiffuse'].value = this.blurRenderTarget.texture;
        this.copyMaterial.blending = CustomBlending;
        this._renderPass(renderer, this.copyMaterial, this.renderToScreen ? null : writeBuffer);
        break;
    }

    tOutput = performance.now() - tOutputStart;

    // ── Trace logging via TraceGate ──
    const total = performance.now() - tStart;
    if (TraceGate.shouldLog('ssao')) {
      console.log(
        `[SSAOPassTrace]` +
        ` enabled=${this.enabled}` +
        ` usesSharedPrePass=${this.useSharedPrePass}` +
        ` internalRenderOverrideSkipped=${this.internalRenderOverrideSkipped}` +
        ` normalTexture=${this.sharedNormalTexture ? 'shared' : 'null'}` +
        ` depthTexture=${this.sharedDepthTexture ? 'shared' : 'null'}` +
        ` ssaoMs=${tSsao.toFixed(1)}` +
        ` blurMs=${tBlur.toFixed(1)}` +
        ` outputMs=${tOutput.toFixed(1)}` +
        ` totalMs=${total.toFixed(1)}`
      );
    }

    // Anomaly warns (throttled to 2s)
    if (!this.useSharedPrePass) {
      TraceGate.warnThrottled('ssaoWarn',
        'SSAO using native high-cost path (useSharedPrePass=false)', 2000);
    }
    if (!this.internalRenderOverrideSkipped) {
      TraceGate.warnThrottled('ssaoWarn',
        'SSAO renderOverride NOT skipped (internalRenderOverrideSkipped=false)', 2000);
    }
    if (total > 2) {
      TraceGate.warnThrottled('ssaoWarn',
        `SSAO slow: totalMs=${total.toFixed(1)}`, 2000);
    }
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;

    this.ssaoRenderTarget.setSize(width, height);
    this.blurRenderTarget.setSize(width, height);

    this.ssaoMaterial.uniforms['resolution'].value.set(width, height);
    this.ssaoMaterial.uniforms['cameraProjectionMatrix'].value.copy(this.camera.projectionMatrix);
    this.ssaoMaterial.uniforms['cameraInverseProjectionMatrix'].value.copy(this.camera.projectionMatrixInverse);
    this.blurMaterial.uniforms['resolution'].value.set(width, height);

    // NOTE: shared normal/depth texture size is managed by PostProcessPanel
    // via resize() → getPrePassRenderSize() → normalRenderTarget.setSize()
  }

  // ── Internal helpers ──────────────────────────────────────

  /**
   * Full-screen quad render to a target.
   */
  _renderPass(renderer, passMaterial, renderTarget, clearColor, clearAlpha) {
    renderer.getClearColor(this.originalClearColor);
    const originalClearAlpha = renderer.getClearAlpha();
    const originalAutoClear = renderer.autoClear;

    renderer.setRenderTarget(renderTarget);
    renderer.autoClear = false;

    if (clearColor !== undefined && clearColor !== null) {
      renderer.setClearColor(clearColor);
      renderer.setClearAlpha(clearAlpha || 0.0);
      renderer.clear();
    }

    this.fsQuad.material = passMaterial;
    this.fsQuad.render(renderer);

    renderer.autoClear = originalAutoClear;
    renderer.setClearColor(this.originalClearColor);
    renderer.setClearAlpha(originalClearAlpha);
  }

  _generateSampleKernel(kernelSize) {
    const kernel = this.kernel;

    for (let i = 0; i < kernelSize; i++) {
      const sample = new Vector3();
      sample.x = Math.random() * 2 - 1;
      sample.y = Math.random() * 2 - 1;
      sample.z = Math.random();

      sample.normalize();

      let scale = i / kernelSize;
      scale = 0.1 + (1 - 0.1) * scale * scale;
      sample.multiplyScalar(scale);

      kernel.push(sample);
    }
  }

  _generateRandomKernelRotations() {
    const width = 4;
    const height = 4;

    const simplex = new SimplexNoise();

    const size = width * height;
    const data = new Float32Array(size);

    for (let i = 0; i < size; i++) {
      const x = Math.random() * 2 - 1;
      const y = Math.random() * 2 - 1;
      const z = 0;

      data[i] = simplex.noise3d(x, y, z);
    }

    this.noiseTexture = new DataTexture(data, width, height, RedFormat, FloatType);
    this.noiseTexture.wrapS = RepeatWrapping;
    this.noiseTexture.wrapT = RepeatWrapping;
    this.noiseTexture.needsUpdate = true;
  }
}

// ── Output mode constants (same as SSAOPass) ──
SharedSSAOPass.OUTPUT = {
  Default: 0,
  SSAO: 1,
  Blur: 2,
  Depth: 3,
  Normal: 4,
};

export default SharedSSAOPass;
