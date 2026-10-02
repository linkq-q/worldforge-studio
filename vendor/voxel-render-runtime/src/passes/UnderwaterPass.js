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
    uCausticStrength: { value: 0.12 },
    uAbsorption: { value: new THREE.Vector3() },
    uScatterColor: { value: new THREE.Color('#19747d') },
    uScatterStrength: { value: 0.72 }
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
    uniform float uCausticStrength;
    uniform vec3 uAbsorption;
    uniform vec3 uScatterColor;
    uniform float uScatterStrength;
    varying vec2 vUv;

    vec3 worldPositionAtDepth(float depthSample) {
      vec4 clip = vec4(vUv * 2.0 - 1.0, depthSample * 2.0 - 1.0, 1.0);
      vec4 view = uProjectionMatrixInverse * clip;
      view /= max(view.w, 0.00001);
      return (uCameraMatrixWorld * view).xyz;
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
      if (sceneUnderwater && depthSample < 0.9999) {
        float waterDepth = max(uWaterLevel - scenePosition.y, 0.0);
        vec2 causticPosition = scenePosition.xz * 1.4;
        float causticA = sin(causticPosition.x + causticPosition.y * 0.73 + uTime * 0.65);
        float causticB = sin(causticPosition.x * -0.62 + causticPosition.y * 1.17 - uTime * 0.52);
        float causticPattern = pow(clamp(1.0 - abs(causticA + causticB), 0.0, 1.0), 4.0);
        float caustic = causticPattern * exp(-waterDepth * 0.18) * uCausticStrength;
        scattered += vec3(0.38, 0.72, 0.82) * caustic;
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
