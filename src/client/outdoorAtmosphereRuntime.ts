import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CLOUD_VOLUME_FUNCTIONS, createCloudVolumeNoise } from './outdoorCloudVolume';
import { BILLOWING_CLOUD_FUNCTIONS } from './outdoorCloudVolumeV2';
import { SCULPTED_CLOUD_FUNCTIONS } from './outdoorCloudVolumeV3';
import { LAYERED_CLOUD_FUNCTIONS } from './outdoorCloudVolumeV4';
import { createConnectedCloudNoise } from './outdoorCloudShapeNoise';

export interface OutdoorAtmosphereOptions {
  haze: number;
  clouds: number;
  reflections: number;
  quality?: number;
  skyQuality?: number;
}

/** The visible sky and reflection bake use the same sun and cloud field. */
export function createOutdoorSky(sun: THREE.DirectionalLight, options: OutdoorAtmosphereOptions): Sky {
  const sky = new Sky();
  sky.name = 'worldforge-outdoor-sky';
  sky.scale.setScalar(10000);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  sky.userData.isEnvironmentObject = true;
  sky.userData.skipShaderApply = true;
  sky.userData.skipNormalDepthPrePass = true;
  const uniforms = sky.material.uniforms;
  const direction = sun.getWorldPosition(new THREE.Vector3())
    .sub(sun.target.getWorldPosition(new THREE.Vector3())).normalize();
  uniforms.sunPosition.value.copy(direction).multiplyScalar(450000);
  uniforms.turbidity.value = 2.2 + options.haze * 2;
  uniforms.rayleigh.value = 2.2;
  uniforms.mieCoefficient.value = 0.0035;
  uniforms.mieDirectionalG.value = 0.82;
  uniforms.uCloudCoverage = { value: THREE.MathUtils.clamp(options.clouds, 0, 1) };
  uniforms.uCloudTime = { value: 0 };
  // Sky's physical model was authored for a lower exposure than the scene's PBR surfaces.
  uniforms.uSkyIntensity = { value: 0.24 };
  const volumeClouds = (options.quality ?? 1) >= 2;
  const billowingClouds = volumeClouds && (options.skyQuality ?? 1) >= 2;
  const sculptedClouds = billowingClouds && options.skyQuality === 3;
  const layeredClouds = billowingClouds && options.skyQuality === 4;
  if (volumeClouds) {
    // Sky writes far depth: drawing after solids lets early depth testing skip hidden cloud rays.
    sky.renderOrder = 1000;
    const noise = createCloudVolumeNoise();
    uniforms.uCloudVolumeNoise = { value: noise };
    if (layeredClouds) {
      const shapeNoise = createConnectedCloudNoise();
      uniforms.uCloudShapeNoise = { value: shapeNoise };
      sky.material.addEventListener('dispose', () => shapeNoise.dispose());
    }
    uniforms.uCloudLayer = { value: layeredClouds ? new THREE.Vector2(360, 1180)
      : billowingClouds ? new THREE.Vector2(520, 950) : new THREE.Vector2(180, 330) };
    uniforms.uCloudSunRadiance = { value: sun.color.clone().multiplyScalar(sun.intensity) };
    if (billowingClouds) {
      uniforms.uCloudHaze = { value: THREE.MathUtils.clamp(options.haze, 0, 1) };
      uniforms.turbidity.value = 1.65 + options.haze;
      uniforms.rayleigh.value = 2.5;
      uniforms.mieCoefficient.value = 0.0025;
      if (sculptedClouds) {
        uniforms.turbidity.value = 1.40 + options.haze * 0.7;
        uniforms.rayleigh.value = 3.0;
        uniforms.mieCoefficient.value = 0.0014;
      }
    }
    sky.material.addEventListener('dispose', () => noise.dispose());
  }
  const cloudFunctions = layeredClouds ? LAYERED_CLOUD_FUNCTIONS : sculptedClouds ? SCULPTED_CLOUD_FUNCTIONS
    : billowingClouds ? BILLOWING_CLOUD_FUNCTIONS : volumeClouds ? CLOUD_VOLUME_FUNCTIONS : '';
  const renderClouds = layeredClouds ? 'renderLayeredClouds' : sculptedClouds ? 'renderSculptedClouds'
    : billowingClouds ? 'renderBillowingClouds' : 'renderCumulus';
  sky.material.fragmentShader = CLOUD_FUNCTIONS + cloudFunctions
    + sky.material.fragmentShader.replace(
    'gl_FragColor = vec4( retColor, 1.0 );',
    volumeClouds ? `
      retColor = mix(vec3(0.10, 0.12, 0.075), retColor, smoothstep(-0.18, 0.015, direction.y));
      retColor = ${renderClouds}(cameraPosition, direction, vSunDirection, retColor);
      gl_FragColor = vec4(retColor * uSkyIntensity, 1.0);
    ` : `
      if (direction.y > 0.015 && uCloudCoverage > 0.001) {
        vec2 cloudPoint = cameraPosition.xz * 0.0018
          + direction.xz / max(direction.y, 0.035) * max(300.0 - cameraPosition.y, 30.0) * 0.0018
          + vec2(uCloudTime * 0.0012, 0.0);
        float threshold = mix(0.78, 0.37, uCloudCoverage);
        float density = cloudFbm(cloudPoint);
        float cloud = smoothstep(threshold, threshold + 0.18, density);
        float towardsSun = cloudFbm(cloudPoint + vSunDirection.xz * 0.14);
        float lightEdge = clamp((density - towardsSun) * 3.2 + 0.55, 0.0, 1.0);
        vec3 cloudColor = mix(vec3(0.72, 1.0, 1.38), vec3(3.6, 3.4, 3.0), lightEdge);
        float silver = pow(max(dot(direction, vSunDirection), 0.0), 12.0)
          * (1.0 - cloud) * cloud;
        cloudColor += vec3(1.0, 0.87, 0.66) * silver * 2.0;
        cloud *= smoothstep(0.015, 0.14, direction.y);
        retColor = mix(retColor, cloudColor, cloud * 0.94);
      }
      // The reflection hemisphere below the horizon represents surrounding ground.
      retColor = mix(vec3(0.10, 0.12, 0.075), retColor, smoothstep(-0.18, 0.015, direction.y));
      gl_FragColor = vec4(retColor * uSkyIntensity, 1.0);
    `
  );
  return sky;
}

export class OutdoorAtmosphereRuntime {
  private sky: Sky | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private environment: THREE.WebGLRenderTarget | null = null;
  private key = '';
  private source: { sun: THREE.DirectionalLight; options: OutdoorAtmosphereOptions } | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly onEnvironment: (environment: THREE.Texture | null, panorama: THREE.Texture | null) => void = () => {}
  ) {}

  apply(sun: THREE.DirectionalLight, options: OutdoorAtmosphereOptions): void {
    const direction = sun.getWorldPosition(new THREE.Vector3())
      .sub(sun.target.getWorldPosition(new THREE.Vector3())).normalize();
    const key = [...direction.toArray(), ...sun.color.toArray(), sun.intensity,
      options.haze, options.clouds, options.reflections, options.quality ?? 1, options.skyQuality ?? 1]
      .map(value => value.toFixed(4)).join(':');
    if (this.sky && key === this.key) return;
    this.clear();
    this.key = key;
    this.source = { sun, options: { ...options } };
    this.sky = createOutdoorSky(sun, options);
    this.scene.add(this.sky);
    if (options.reflections <= 0) return;
    this.pmrem ??= new THREE.PMREMGenerator(this.renderer);
    const environmentScene = new THREE.Scene();
    const captureSky = createOutdoorSky(sun, { ...options, skyQuality: 1 });
    captureSky.material.uniforms.uSkyIntensity.value *= options.reflections;
    environmentScene.add(captureSky);
    try {
      this.environment = this.pmrem.fromScene(environmentScene, 0.04, 0.1, 20000);
    } finally {
      captureSky.geometry.dispose();
      captureSky.material.dispose();
    }
    this.scene.environment = this.environment.texture;
    // Water shaders need an equirectangular texture, not this CubeUV PMREM.
    this.onEnvironment(this.environment.texture, null);
  }

  update(camera: THREE.PerspectiveCamera, elapsedSeconds: number): void {
    if (!this.sky) return;
    camera.getWorldPosition(this.sky.position);
    this.sky.material.uniforms.uCloudTime.value = elapsedSeconds;
  }

  /** Sky-only trials keep the accepted courtyard reflection and diffuse lighting. */
  withBaselineSkyForCapture<T>(capture: () => T): T {
    if (!this.sky || !this.source || (this.source.options.skyQuality ?? 1) < 2) return capture();
    const visibleSky = this.sky;
    const baseline = createOutdoorSky(this.source.sun, { ...this.source.options, skyQuality: 1 });
    baseline.position.copy(visibleSky.position);
    baseline.material.uniforms.uCloudTime.value = visibleSky.material.uniforms.uCloudTime.value;
    const visible = visibleSky.visible;
    visibleSky.visible = false;
    this.scene.add(baseline);
    try { return capture(); }
    finally {
      baseline.removeFromParent();
      baseline.geometry.dispose();
      baseline.material.dispose();
      visibleSky.visible = visible;
    }
  }

  clear(): void {
    this.sky?.removeFromParent();
    this.sky?.geometry.dispose();
    this.sky?.material.dispose();
    this.sky = null;
    if (this.environment && this.scene.environment === this.environment.texture) {
      this.scene.environment = null;
      this.onEnvironment(null, null);
    }
    this.environment?.dispose();
    this.environment = null;
    this.key = '';
    this.source = null;
  }

  dispose(): void {
    this.clear();
    this.pmrem?.dispose();
    this.pmrem = null;
  }
}

const CLOUD_FUNCTIONS = /* glsl */`
  uniform float uCloudCoverage, uCloudTime, uSkyIntensity;
  float cloudHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float cloudNoise(vec2 p) {
    vec2 cell = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(cloudHash(cell), cloudHash(cell + vec2(1, 0)), f.x),
      mix(cloudHash(cell + vec2(0, 1)), cloudHash(cell + vec2(1, 1)), f.x), f.y);
  }
  float cloudFbm(vec2 p) {
    float result = 0.0, amplitude = 0.57;
    for (int i = 0; i < 4; i++) {
      result += cloudNoise(p) * amplitude;
      p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(9.2, 4.1);
      amplitude *= 0.48;
    }
    return result;
  }
`;
