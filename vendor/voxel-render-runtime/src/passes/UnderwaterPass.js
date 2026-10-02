import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const UnderwaterShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uProjectionMatrixInverse: { value: new THREE.Matrix4() },
    uCameraMatrixWorld: { value: new THREE.Matrix4() },
    uCameraPosition: { value: new THREE.Vector3() },
    uCameraFar: { value: 1000 },
    uWaterLevel: { value: 0 },
    uSubmersion: { value: 0 },
    uTime: { value: 0 },
    uAbsorption: { value: new THREE.Vector3() },
    uScatterColor: { value: new THREE.Color('#19747d') },
    uScatterStrength: { value: 0.72 },
    uCausticStrength: { value: 0.22 }
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
    uniform mat4 uProjectionMatrixInverse;
    uniform mat4 uCameraMatrixWorld;
    uniform vec3 uCameraPosition;
    uniform float uCameraFar;
    uniform float uWaterLevel;
    uniform float uSubmersion;
    uniform float uTime;
    uniform vec3 uAbsorption;
    uniform vec3 uScatterColor;
    uniform float uScatterStrength;
    uniform float uCausticStrength;
    varying vec2 vUv;

    vec3 worldPositionAtDepth(float depthSample) {
      vec4 clip = vec4(vUv * 2.0 - 1.0, depthSample * 2.0 - 1.0, 1.0);
      vec4 view = uProjectionMatrixInverse * clip;
      view /= max(view.w, 0.00001);
      return (uCameraMatrixWorld * view).xyz;
    }

    float causticPattern(vec2 worldXZ, float time) {
      vec2 p = worldXZ * 0.42;
      float waveA = sin(p.x * 1.7 + time * 1.05) + sin(p.y * 1.3 - time * 0.83);
      float waveB = sin((p.x + p.y) * 1.15 - time * 0.62)
        + sin((p.x - p.y) * 0.92 + time * 0.74);
      float ridge = 1.0 - min(abs(waveA), abs(waveB)) * 0.7;
      return pow(clamp(ridge, 0.0, 1.0), 5.0);
    }

    void main() {
      vec4 inColor = texture2D(tDiffuse, vUv);
      float depthSample = texture2D(tDepth, vUv).r;
      vec3 scenePosition = worldPositionAtDepth(depthSample);
      vec3 cameraToScene = scenePosition - uCameraPosition;
      float sceneDistance = depthSample >= 0.9999 ? uCameraFar : length(cameraToScene);
      float waterDistance = sceneDistance;

      float verticalDelta = scenePosition.y - uCameraPosition.y;
      bool cameraUnderwater = uCameraPosition.y <= uWaterLevel;
      bool sceneUnderwater = scenePosition.y <= uWaterLevel;
      if (!cameraUnderwater && !sceneUnderwater) {
        waterDistance = 0.0;
      } else if (abs(verticalDelta) > 0.00001 && cameraUnderwater != sceneUnderwater) {
        float planeFraction = clamp((uWaterLevel - uCameraPosition.y) / verticalDelta, 0.0, 1.0);
        waterDistance *= cameraUnderwater ? planeFraction : 1.0 - planeFraction;
      }

      vec3 transmission = exp(-uAbsorption * max(waterDistance, 0.0));
      vec3 scattered = inColor.rgb * transmission
        + uScatterColor * (1.0 - transmission) * uScatterStrength;
      if (depthSample < 0.9999 && sceneUnderwater) {
        float surfaceDepth = max(uWaterLevel - scenePosition.y, 0.0);
        float caustic = causticPattern(scenePosition.xz, uTime)
          * exp(-surfaceDepth * 0.11)
          * transmission.g;
        scattered += vec3(0.38, 0.72, 0.62) * caustic * uCausticStrength;
      }
      gl_FragColor = vec4(mix(inColor.rgb, scattered, uSubmersion), inColor.a);
    }
  `
};

export function absorptionFromTransmittance(color, distance) {
  const safeDistance = Math.max(0.001, Number(distance) || 0.001);
  return new THREE.Vector3(
    -Math.log(THREE.MathUtils.clamp(color.r, 0.001, 1)) / safeDistance,
    -Math.log(THREE.MathUtils.clamp(color.g, 0.001, 1)) / safeDistance,
    -Math.log(THREE.MathUtils.clamp(color.b, 0.001, 1)) / safeDistance
  );
}

export function createUnderwaterPass() {
  const pass = new ShaderPass(UnderwaterShader);
  pass.name = 'UnderwaterPass';
  return pass;
}

export { UnderwaterShader };
