import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const CurvatureEdgeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 1000.0 },
    uTexelSize: { value: new THREE.Vector2() },
    uStrength: { value: 1.5 },
    uWidth: { value: 1.0 },
    uPower: { value: 2.0 },
    uThreshold: { value: 0.1 },
    // ── 远景深度衰减（与 InkEdgePass 共用同一套参数）──
    uDepthFadeEnabled: { value: true },
    uDepthFadeStart: { value: 18.0 },
    uDepthFadeEnd: { value: 45.0 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform float uCameraNear;
    uniform float uCameraFar;
    uniform vec2 uTexelSize;
    uniform float uStrength;
    uniform float uWidth;
    uniform float uPower;
    uniform float uThreshold;
    uniform bool uDepthFadeEnabled;
    uniform float uDepthFadeStart;
    uniform float uDepthFadeEnd;
    varying vec2 vUv;

    bool hasNormal(vec2 uv) {
      return length(texture2D(tNormal, uv).xyz) >= 0.01;
    }

    vec3 sampleNormal(vec2 uv, vec3 fallback) {
      vec3 packed = texture2D(tNormal, uv).xyz;
      if (length(packed) < 0.01) return fallback;
      return normalize(packed * 2.0 - 1.0);
    }

    // 非线性深度缓冲 → 视图空间线性深度（与 InkEdgePass 一致）
    float linearizeDepth(float depthSample) {
      if (depthSample >= 0.9999) return uCameraFar;
      return (2.0 * uCameraNear * uCameraFar) /
             (uCameraFar + uCameraNear - depthSample * (uCameraFar - uCameraNear));
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);

      if (!hasNormal(vUv) || uStrength <= 0.0) {
        gl_FragColor = color;
        return;
      }

      vec3 n0 = sampleNormal(vUv, vec3(0.0, 0.0, 1.0));
      vec2 off = uTexelSize * uWidth;

      vec3 nR = sampleNormal(vUv + vec2( off.x, 0.0), n0);
      vec3 nL = sampleNormal(vUv + vec2(-off.x, 0.0), n0);
      vec3 nU = sampleNormal(vUv + vec2(0.0,  off.y), n0);
      vec3 nD = sampleNormal(vUv + vec2(0.0, -off.y), n0);

      float consistency = min(
        min(dot(n0, nR), dot(n0, nL)),
        min(dot(n0, nU), dot(n0, nD))
      );
      consistency = clamp(consistency, 0.0, 1.0);

      float normalDelta = 1.0 - consistency;
      float edgeMask = smoothstep(uThreshold, uThreshold + 0.08, normalDelta);
      float curvatureAO = pow(consistency, uPower);
      float factor = mix(1.0, curvatureAO, edgeMask * clamp(uStrength * 0.5, 0.0, 1.0));

      // ── 远景深度衰减：避免远景与 InkEdge 重复叠加成黑团 ──
      if (uDepthFadeEnabled) {
        float centerLinearDepth = linearizeDepth(texture2D(tDepth, vUv).r);
        float dStart = uDepthFadeStart;
        float dEnd = max(uDepthFadeEnd, dStart + 0.001);
        float depthFade = 1.0 - smoothstep(dStart, dEnd, centerLinearDepth);
        factor = mix(1.0, factor, depthFade);
      }

      gl_FragColor = vec4(color.rgb * factor, color.a);
    }
  `,
};

export function createCurvatureEdgePass(renderer) {
  const pass = new ShaderPass(CurvatureEdgeShader);
  const size = new THREE.Vector2();
  renderer.getSize(size);
  const pixelRatio = renderer.getPixelRatio?.() || 1;
  pass.uniforms.uTexelSize.value.set(1.0 / (size.x * pixelRatio), 1.0 / (size.y * pixelRatio));
  return pass;
}
