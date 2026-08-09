/**
 * ExponentialFogPass — post-process depth-based exponential distance fog.
 *
 * NOTE: This pass runs in the postProcess EffectComposer chain only.
 * It is NOT active during CubeCamera / glassEnv environment captures
 * (those use renderer.render() directly, bypassing the composer).
 * Do not attach this pass to any environment bake render path.
 *
 * Water surface coordination: WaterSurface Step-6 absorption already
 * applies a distance-based deep tint (uDeepTint / uAbsorptionDistanceScale).
 * Stacking fog on top can double-darken distant water. No separate water
 * mask uniform is implemented — if the effect is too heavy, lower
 * fogDensity or fogStartDistance. A dedicated uFogWaterDamping could be
 * added in a future step once visual acceptance is confirmed.
 */
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import * as THREE from 'three';

const ExponentialFogShader = {
  uniforms: {
    tDiffuse:          { value: null },
    tDepth:            { value: null },
    uCameraNear:       { value: 0.1 },
    uCameraFar:        { value: 1000.0 },
    uFogColor:         { value: new THREE.Vector3(0.8, 0.82, 0.85) },
    uFogDensity:       { value: 0.02 },
    uFogStartDistance: { value: 0.0 },
    uFogExpPow:        { value: 2.0 },
    uFogSkyFade:       { value: 0.0 },
    // Debug: 0 = normal, 1 = show fogFactor as greyscale
    uFogDebugMode:     { value: 0 },
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
    uniform float uCameraNear;
    uniform float uCameraFar;
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    uniform float uFogStartDistance;
    uniform float uFogExpPow;
    uniform float uFogSkyFade;
    uniform float uFogDebugMode;
    varying vec2 vUv;

    float linearizeDepth(float depthSample) {
      if (depthSample >= 0.9999) return uCameraFar;
      return (2.0 * uCameraNear * uCameraFar)
        / (uCameraFar + uCameraNear - depthSample * (uCameraFar - uCameraNear));
    }

    void main() {
      vec4 inColor = texture2D(tDiffuse, vUv);
      float depthSample = texture2D(tDepth, vUv).r;
      float dist = linearizeDepth(depthSample);

      float d = max(dist - uFogStartDistance, 0.0);
      float fogFactor = 1.0 - exp(-pow(d * uFogDensity, uFogExpPow));
      fogFactor = clamp(fogFactor, 0.0, 1.0);

      bool isSky = depthSample >= 0.9999;
      float skyWeight = isSky ? uFogSkyFade : 1.0;
      fogFactor *= skyWeight;

      // Debug: output fogFactor as greyscale for density tuning
      if (uFogDebugMode > 0.5) {
        gl_FragColor = vec4(fogFactor, fogFactor, fogFactor, 1.0);
        return;
      }

      vec3 outColor = mix(inColor.rgb, uFogColor, fogFactor);
      gl_FragColor = vec4(outColor, inColor.a);
    }
  `,
};

export function createExponentialFogPass() {
  const pass = new ShaderPass(ExponentialFogShader);
  pass.name = 'ExponentialFogPass';
  return pass;
}
