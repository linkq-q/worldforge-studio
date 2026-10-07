import * as THREE from 'three';
import { LightProbeGenerator } from 'three/examples/jsm/lights/LightProbeGenerator.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/** A scene-local courtyard probe. Captured once after lighting settles, not every frame. */
export class OutdoorEnvironmentProbe {
  private target: THREE.WebGLCubeRenderTarget | null = null;
  private environment: THREE.WebGLRenderTarget | null = null;
  private light: THREE.LightProbe | null = null;
  private previousEnvironment: THREE.Texture | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly syncEnvironment: (texture: THREE.Texture | null) => void
  ) {}

  capture(content: THREE.Object3D, bounce: number, reflections = 1, quality = 1): void {
    this.clear();
    const bounds = new THREE.Box3().setFromObject(content);
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    this.previousEnvironment = this.scene.environment;
    this.target = new THREE.WebGLCubeRenderTarget(quality >= 2 ? 256 : 64, { type: THREE.HalfFloatType });
    const camera = new THREE.CubeCamera(0.3, Math.max(200, size.length() * 3), this.target);
    // The front courtyard sees the facade, ground, and sky, rather than the inside of a solid building.
    camera.position.set(center.x + size.x * 0.18, bounds.min.y + Math.max(4, size.y * 0.18), bounds.max.z - size.z * 0.12);
    const background = this.scene.background;
    const target = this.renderer.getRenderTarget();
    try {
      camera.update(this.renderer, this.scene);
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      try { this.environment = pmrem.fromCubemap(this.target.texture); }
      finally { pmrem.dispose(); }
      this.scaleReflection(THREE.MathUtils.clamp(reflections, 0, 1));
      this.scene.environment = this.environment.texture;
      this.syncEnvironment(this.environment.texture);
      if (bounce > 0) {
        // Installed Three r160 returns synchronously; the newer @types package declares a Promise.
        const light: unknown = LightProbeGenerator.fromCubeRenderTarget(this.renderer, this.target);
        if (!(light instanceof THREE.LightProbe)) throw new Error('outdoor_probe_requires_three_r160_sync_readback');
        light.intensity = bounce * 0.35;
        light.name = 'outdoorCourtyardBounce';
        this.scene.add(light);
        this.light = light;
      }
    } catch (error) {
      this.clear();
      throw error;
    } finally {
      this.scene.background = background;
      this.renderer.setRenderTarget(target);
    }
  }

  clear(): void {
    if (this.environment && this.scene.environment === this.environment.texture) {
      this.scene.environment = this.previousEnvironment;
      this.syncEnvironment(this.previousEnvironment);
    }
    this.light?.removeFromParent();
    this.light = null;
    this.environment?.dispose();
    this.target?.dispose();
    this.environment = null;
    this.target = null;
    this.previousEnvironment = null;
  }

  dispose(): void { this.clear(); }

  private scaleReflection(intensity: number): void {
    if (!this.environment || intensity === 1) return;
    const source = this.environment;
    // Scale the linear HDR atlas once; retain the original cubemap for diffuse SH readback.
    this.environment = source.clone();
    const material = new THREE.ShaderMaterial({
      uniforms: { uSource: { value: source.texture }, uIntensity: { value: intensity } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `uniform sampler2D uSource; uniform float uIntensity; varying vec2 vUv;
        void main() { vec4 radiance = texture2D(uSource, vUv); gl_FragColor = vec4(radiance.rgb * uIntensity, radiance.a); }`,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    const quad = new FullScreenQuad(material);
    try {
      this.renderer.setRenderTarget(this.environment);
      quad.render(this.renderer);
    } finally {
      quad.dispose();
      material.dispose();
      source.dispose();
    }
  }
}
