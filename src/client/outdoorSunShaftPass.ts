import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/** Single scattering through world-space sunlight, truncated at opaque scene depth. */
export class OutdoorSunShaftPass extends ShaderPass {
  private sun: THREE.DirectionalLight | null = null;

  constructor() {
    super({
      name: 'OutdoorSunShaftPass',
      uniforms: {
        tDiffuse: { value: null },
        uDepth: { value: null },
        uSunShadow: { value: null },
        uHasDepth: { value: 0 },
        uHasShadow: { value: 0 },
        uVarianceShadow: { value: 0 },
        uHaze: { value: 0 },
        uBackgroundAir: { value: 0 },
        uProjectionInverse: { value: new THREE.Matrix4() },
        uCameraWorld: { value: new THREE.Matrix4() },
        uSunMatrix: { value: new THREE.Matrix4() },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color('#ffe6c3') },
        uSunIntensity: { value: 1 },
        uShadowBias: { value: 0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: AIR_FRAGMENT,
    });
  }

  apply(haze: number, quality = 1): void {
    this.uniforms.uHaze.value = Number.isFinite(haze) ? THREE.MathUtils.clamp(haze, 0, 1) : 0;
    this.uniforms.uBackgroundAir.value = Number.isFinite(quality) && quality >= 2 ? 1 : 0;
  }

  bindFrame(camera: THREE.PerspectiveCamera, sun: THREE.DirectionalLight, depth: THREE.DepthTexture | null): void {
    this.sun = sun;
    this.uniforms.uDepth.value = depth;
    this.uniforms.uHasDepth.value = depth ? 1 : 0;
    this.uniforms.uProjectionInverse.value.copy(camera.projectionMatrixInverse);
    this.uniforms.uCameraWorld.value.copy(camera.matrixWorld);
    this.uniforms.uSunDirection.value.copy(sun.getWorldPosition(new THREE.Vector3()))
      .sub(sun.target.getWorldPosition(new THREE.Vector3())).normalize();
    this.uniforms.uSunColor.value.copy(sun.color);
    this.uniforms.uSunIntensity.value = sun.intensity;
    this.bindSunShadow();
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean
  ): void {
    // The preceding RenderPass creates/updates the actual light shadow map this frame.
    this.bindSunShadow();
    this.uniforms.uVarianceShadow.value = renderer.shadowMap.type === THREE.VSMShadowMap ? 1 : 0;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }

  private bindSunShadow(): void {
    const shadow = this.sun?.shadow;
    this.uniforms.uHasShadow.value = shadow?.map ? 1 : 0;
    this.uniforms.uSunShadow.value = shadow?.map?.texture ?? null;
    if (shadow) {
      this.uniforms.uSunMatrix.value.copy(shadow.matrix);
      this.uniforms.uShadowBias.value = shadow.bias;
    }
  }
}

const AIR_FRAGMENT = /* glsl */`
  #include <packing>
  uniform sampler2D tDiffuse, uDepth, uSunShadow;
  uniform float uHasDepth, uHasShadow, uVarianceShadow, uHaze, uBackgroundAir, uSunIntensity, uShadowBias;
  uniform mat4 uProjectionInverse, uCameraWorld, uSunMatrix;
  uniform vec3 uSunDirection, uSunColor;
  varying vec2 vUv;

  float sunlight(vec3 world) {
    if (uHasShadow < 0.5) return 1.0;
    vec4 projected = uSunMatrix * vec4(world, 1.0);
    vec3 uvz = projected.xyz / projected.w;
    if (uvz.x < 0.0 || uvz.x > 1.0 || uvz.y < 0.0 || uvz.y > 1.0 || uvz.z < 0.0 || uvz.z > 1.0) return 1.0;
    vec4 stored = texture2D(uSunShadow, uvz.xy);
    float compare = uvz.z + uShadowBias;
    if (uVarianceShadow > 0.5) {
      vec2 distribution = unpackRGBATo2Half(stored);
      float delta = compare - distribution.x;
      float variance = max(distribution.y * distribution.y, 0.000002);
      return max(step(compare, distribution.x), clamp((variance / (variance + delta * delta) - 0.3) / 0.65, 0.0, 1.0));
    }
    return step(compare, unpackRGBAToDepth(stored));
  }

  void main() {
    vec4 source = texture2D(tDiffuse, vUv);
    if (uHasDepth < 0.5 || (uHaze <= 0.0 && uBackgroundAir < 0.5)) { gl_FragColor = source; return; }
    float depth = texture2D(uDepth, vUv).x;
    vec4 endpoint = uProjectionInverse * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec3 view = endpoint.xyz / endpoint.w;
    float distanceToSurface = length(view);
    vec3 ray = mat3(uCameraWorld) * normalize(view);
    vec3 origin = uCameraWorld[3].xyz;
    if (uBackgroundAir > 0.5 && depth >= 0.99999) {
      // Presentation-only distant air. Cube-camera probes never run this post pass.
      vec3 distantAir = mix(vec3(0.20, 0.25, 0.27), vec3(0.38, 0.46, 0.51),
        smoothstep(-0.60, 0.04, ray.y));
      source.rgb = mix(distantAir, source.rgb, smoothstep(-0.025, 0.075, ray.y));
    }
    if (uHaze <= 0.0) { gl_FragColor = source; return; }
    float end = min(distanceToSurface, 220.0);
    // The sky already contains planetary scattering. Only integrate local air in front of it.
    if (depth > 0.99999) end = min(end, 140.0);
    float stepLength = end / 24.0;
    float extinction = 0.006 * uHaze;
    float transmission = 1.0;
    vec3 scattering = vec3(0.0);
    float cosine = dot(ray, uSunDirection);
    float g = 0.64;
    float phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosine, 1.5);
    phase = min(phase, 8.0);
    vec3 skyLight = vec3(0.32, 0.47, 0.72);
    for (int i = 0; i < 24; i++) {
      vec3 world = origin + ray * ((float(i) + 0.5) * stepLength);
      float density = exp(-max(world.y, 0.0) / 48.0);
      float opticalDepth = density * extinction * stepLength;
      float scatterFraction = 1.0 - exp(-opticalDepth);
      vec3 direct = uSunColor * min(uSunIntensity, 5.0) * 0.19 * phase * sunlight(world);
      scattering += transmission * scatterFraction * (skyLight + direct);
      transmission *= 1.0 - scatterFraction;
    }
    gl_FragColor = vec4(source.rgb * transmission + scattering, source.a);
  }
`;
