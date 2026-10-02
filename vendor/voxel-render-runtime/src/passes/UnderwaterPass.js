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
    uWaveHeight: { value: 0.1 },
    uWaveScale: { value: 1.3 },
    uWaveSpeed: { value: 0.48 },
    uPrimaryWaveDirection: { value: new THREE.Vector2(0.875, 0.485).normalize() },
    uSecondaryWaveDirection: { value: new THREE.Vector2(-0.615, 0.789).normalize() },
    uWaterlineColor: { value: new THREE.Color('#eefcff') },
    uWaterlineStrength: { value: 0.78 },
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
    uniform float uWaveHeight;
    uniform float uWaveScale;
    uniform float uWaveSpeed;
    uniform vec2 uPrimaryWaveDirection;
    uniform vec2 uSecondaryWaveDirection;
    uniform vec3 uWaterlineColor;
    uniform float uWaterlineStrength;
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

    vec2 safeDirection(vec2 direction, vec2 fallback) {
      float lengthSquared = dot(direction, direction);
      return lengthSquared > 0.000001 ? normalize(direction) : normalize(fallback);
    }

    float waterWaveOffset(vec2 worldXZ) {
      vec2 primary = safeDirection(uPrimaryWaveDirection, vec2(1.0, 0.25));
      vec2 secondary = safeDirection(uSecondaryWaveDirection, vec2(-0.35, 1.0));
      vec2 detail = safeDirection(primary + secondary, vec2(0.6, 1.0));
      float scale = max(uWaveScale, 0.001);
      float broad = sin(dot(worldXZ, primary) * scale * 0.55 + uTime * uWaveSpeed * 0.85);
      float crossWave = sin(dot(worldXZ, secondary) * scale * 0.83 - uTime * uWaveSpeed * 0.62 + 1.7);
      float ripple = sin(dot(worldXZ, detail) * scale * 1.6 + uTime * uWaveSpeed * 1.15 - 0.4);
      return max(uWaveHeight, 0.0) * (broad * 0.55 + crossWave * 0.3 + ripple * 0.15);
    }

    float waterSurfaceHeight(vec2 worldXZ) {
      return uWaterLevel + waterWaveOffset(worldXZ);
    }

    vec2 waterSurfaceSlope(vec2 worldXZ) {
      float sampleStep = max(0.04, 0.08 / max(uWaveScale, 0.001));
      float center = waterSurfaceHeight(worldXZ);
      return vec2(
        waterSurfaceHeight(worldXZ + vec2(sampleStep, 0.0)) - center,
        waterSurfaceHeight(worldXZ + vec2(0.0, sampleStep)) - center
      ) / sampleStep;
    }

    float causticPattern(vec2 worldXZ) {
      vec2 primary = safeDirection(uPrimaryWaveDirection, vec2(1.0, 0.25));
      vec2 secondary = safeDirection(uSecondaryWaveDirection, vec2(-0.35, 1.0));
      float scale = max(uWaveScale, 0.001);
      float first = sin(dot(worldXZ, primary) * scale * 3.8 + uTime * uWaveSpeed * 1.6);
      float second = sin(dot(worldXZ, secondary) * scale * 4.6 - uTime * uWaveSpeed * 1.25 + 1.4);
      float crossed = sin(dot(worldXZ, primary + secondary) * scale * 2.5 + uTime * uWaveSpeed * 0.7);
      float ridge = clamp(first * 0.42 + second * 0.38 + crossed * 0.2, -1.0, 1.0) * 0.5 + 0.5;
      return pow(ridge, 5.0);
    }

    void main() {
      vec4 inColor = texture2D(tDiffuse, vUv);
      float depthSample = texture2D(tDepth, vUv).r;
      vec3 scenePosition = worldPositionAtDepth(depthSample);
      vec3 cameraToScene = scenePosition - uCameraPosition;
      float sceneDistance = depthSample >= 0.9999 ? uCameraFar : length(cameraToScene);
      vec3 rayDirection = cameraToScene / max(length(cameraToScene), 0.00001);
      float waterDistance = sceneDistance;

      float cameraSurfaceHeight = waterSurfaceHeight(uCameraPosition.xz);
      float cameraSurfaceDelta = uCameraPosition.y - cameraSurfaceHeight;
      float verticalDelta = scenePosition.y - uCameraPosition.y;
      bool cameraUnderwater = cameraSurfaceDelta <= 0.0;
      bool sceneUnderwater = scenePosition.y <= waterSurfaceHeight(scenePosition.xz);

      // Near the interface, use a world-space probe in front of the camera. This
      // preserves a readable moving silhouette instead of projecting one flat
      // infinite plane across the screen.
      float probeDistance = min(sceneDistance, mix(4.0, 8.0, clamp(sceneDistance / 80.0, 0.0, 1.0)));
      vec3 probePosition = uCameraPosition + rayDirection * probeDistance;
      float waterlineSlope = (waterSurfaceHeight(probePosition.xz) - uCameraPosition.y)
        / max(probeDistance, 0.001);
      float waterlineDelta = rayDirection.y - waterlineSlope;
      bool usesNearWaterline = depthSample >= 0.9999 || sceneDistance > probeDistance;
      if (usesNearWaterline && abs(cameraSurfaceDelta) < max(0.45, uWaveHeight * 3.0)) {
        sceneUnderwater = waterlineDelta <= 0.0;
      }

      if (!cameraUnderwater && !sceneUnderwater) {
        waterDistance = 0.0;
      } else if (abs(verticalDelta) > 0.00001 && cameraUnderwater != sceneUnderwater) {
        float surfaceFraction = clamp((uWaterLevel - uCameraPosition.y) / verticalDelta, 0.0, 1.0);
        for (int i = 0; i < 3; i++) {
          vec3 surfacePoint = uCameraPosition + cameraToScene * surfaceFraction;
          surfaceFraction = clamp(
            (waterSurfaceHeight(surfacePoint.xz) - uCameraPosition.y) / verticalDelta,
            0.0,
            1.0
          );
        }
        float interfaceDistance = sceneDistance * surfaceFraction;
        waterDistance = cameraUnderwater ? interfaceDistance : sceneDistance - interfaceDistance;
      }

      float nearSurface = 1.0 - smoothstep(
        max(0.12, uWaveHeight * 0.8),
        max(0.45, uWaveHeight * 3.0),
        abs(cameraSurfaceDelta)
      );
      float passActivation = smoothstep(0.015, 0.18, uSubmersion);
      float submergedPixel = step(0.0001, waterDistance) * passActivation;
      vec2 waveSlope = waterSurfaceSlope(probePosition.xz);
      float refractionStrength = (0.0012 + nearSurface * 0.0028)
        * (0.35 + 0.65 * clamp(waterDistance / 6.0, 0.0, 1.0));
      vec2 refractedUv = clamp(vUv + waveSlope * refractionStrength * submergedPixel, 0.002, 0.998);
      vec3 refractedColor = texture2D(tDiffuse, refractedUv).rgb;

      float surfaceDepth = max(0.0, waterSurfaceHeight(scenePosition.xz) - scenePosition.y);
      float caustic = causticPattern(scenePosition.xz)
        * (1.0 - smoothstep(0.5, 9.0, surfaceDepth))
        * (1.0 - step(0.9999, depthSample));
      vec3 litWaterColor = refractedColor + uWaterlineColor * caustic * 0.11;
      vec3 transmission = exp(-uAbsorption * max(waterDistance, 0.0));
      float upwardLight = smoothstep(-0.45, 0.7, rayDirection.y);
      vec3 scatterColor = uScatterColor * mix(0.78, 1.18, upwardLight);
      vec3 scattered = litWaterColor * transmission
        + scatterColor * (1.0 - transmission) * uScatterStrength;
      vec3 finalColor = mix(inColor.rgb, scattered, submergedPixel);

      vec2 foamDirection = safeDirection(uPrimaryWaveDirection - uSecondaryWaveDirection, vec2(1.0, -0.4));
      float foamNoise = sin(dot(probePosition.xz, foamDirection) * max(uWaveScale, 0.001) * 3.1
        - uTime * uWaveSpeed * 1.7);
      foamNoise += sin(dot(probePosition.xz, foamDirection.yx) * max(uWaveScale, 0.001) * 5.3
        + uTime * uWaveSpeed * 1.1) * 0.45;
      float foamBreakup = smoothstep(-0.55, 0.7, foamNoise);
      float lineWidth = mix(0.0018, 0.0042, clamp(uWaveHeight / 0.18, 0.0, 1.0));
      float rippledWaterlineDelta = waterlineDelta + foamNoise * lineWidth * 1.45;
      float waterlineHalo = (1.0 - smoothstep(lineWidth * 2.2, lineWidth * 7.5, abs(rippledWaterlineDelta)))
        * nearSurface
        * mix(0.45, 0.9, foamBreakup)
        * uWaterlineStrength
        * (usesNearWaterline ? 1.0 : 0.0);
      float waterlineFoamShelf = (1.0 - smoothstep(
        lineWidth * 2.0,
        lineWidth * 11.0,
        max(-rippledWaterlineDelta, 0.0)
      ))
        * step(rippledWaterlineDelta, 0.0)
        * nearSurface
        * mix(0.3, 0.9, foamBreakup)
        * uWaterlineStrength
        * (usesNearWaterline ? 1.0 : 0.0);
      float waterlineEdge = (1.0 - smoothstep(lineWidth, lineWidth * 2.4, abs(rippledWaterlineDelta)))
        * nearSurface
        * mix(0.7, 1.0, foamBreakup)
        * uWaterlineStrength
        * (usesNearWaterline ? 1.0 : 0.0);
      vec3 haloColor = mix(uScatterColor, uWaterlineColor, 0.58);
      finalColor = mix(finalColor, haloColor, clamp(waterlineHalo * 0.24 * passActivation, 0.0, 0.32));
      finalColor = mix(finalColor, uWaterlineColor, clamp(waterlineFoamShelf * 0.26 * passActivation, 0.0, 0.4));
      finalColor = mix(finalColor, uWaterlineColor, clamp(waterlineEdge * 0.96 * passActivation, 0.0, 0.96));
      gl_FragColor = vec4(finalColor, inColor.a);
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
