/**
 * GradientMapPass.js — 亮度→多色渐变重映射（presentation 独立叠加层）
 *
 * 不是 mode：独立 enabled 开关，slot='presentation' order=5（跑在所有 mode 之前），
 * 与 none/pixel/comic/sketch/ascii 任意组合。
 *
 * 算法：l = luma(color)；按 stopCount 分段 mix 色标得到 ramp；
 *       color = mix(color, ramp, uStrength)。
 * 色标位置：count=2 → {0,1}；count=3 → {0, p1, 1}；count=4 → {0, p1, p2, 1}。
 *
 * 组合示例：pixel + 四色绿渐变 = GameBoy；comic + 红蓝双色 = riso；
 *           none + 暗紫→暖白 = 海报 duotone。
 */

import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import * as THREE from 'three';

const GradientMapShader = {
  uniforms: {
    tDiffuse: { value: null },
    uColorA: { value: new THREE.Vector3(0.10, 0.11, 0.25) }, // #1a1c40
    uColorB: { value: new THREE.Vector3(0.88, 0.34, 0.34) }, // #e05656
    uColorC: { value: new THREE.Vector3(0.96, 0.84, 0.43) }, // #f5d76e
    uColorD: { value: new THREE.Vector3(0.99, 0.96, 0.89) }, // #fdf6e3
    uStopCount: { value: 2 },
    uMidPos1: { value: 0.5 },
    uMidPos2: { value: 0.75 },
    uStrength: { value: 1.0 },
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
    uniform vec3 uColorA;
    uniform vec3 uColorB;
    uniform vec3 uColorC;
    uniform vec3 uColorD;
    uniform float uStopCount;
    uniform float uMidPos1;
    uniform float uMidPos2;
    uniform float uStrength;
    varying vec2 vUv;

    float luma(vec3 c) {
      return dot(c, vec3(0.299, 0.587, 0.114));
    }

    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      float l = clamp(luma(color), 0.0, 1.0);

      vec3 ramp;
      if (uStopCount < 2.5) {
        // 2 色标：A@0, B@1
        ramp = mix(uColorA, uColorB, l);
      } else if (uStopCount < 3.5) {
        // 3 色标：A@0, B@p1, C@1
        float p1 = clamp(uMidPos1, 0.02, 0.98);
        if (l < p1) ramp = mix(uColorA, uColorB, l / p1);
        else        ramp = mix(uColorB, uColorC, (l - p1) / max(1.0 - p1, 1e-3));
      } else {
        // 4 色标：A@0, B@p1, C@p2, D@1
        float p1 = clamp(uMidPos1, 0.02, 0.96);
        float p2 = clamp(max(uMidPos2, p1 + 0.02), p1 + 0.02, 0.98);
        if (l < p1)      ramp = mix(uColorA, uColorB, l / p1);
        else if (l < p2) ramp = mix(uColorB, uColorC, (l - p1) / max(p2 - p1, 1e-3));
        else             ramp = mix(uColorC, uColorD, (l - p2) / max(1.0 - p2, 1e-3));
      }

      color = mix(color, ramp, uStrength);
      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * 创建 GradientMapPass（默认 disabled，由 PostProcessPanel 控制）
 * @returns {ShaderPass}
 */
export function createGradientMapPass() {
  const pass = new ShaderPass(GradientMapShader);
  pass.enabled = false;
  return pass;
}

export { GradientMapShader };
