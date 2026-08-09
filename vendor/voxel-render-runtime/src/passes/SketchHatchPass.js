/**
 * SketchHatchPass.js — 程序化交叉排线素描 presentation mode（'sketch'）
 *
 * 全程序化，零纹理资产：亮度分 4 档排线层，越暗叠越多交叉方向。
 * 密度用「双网格交叉淡入」——基准网格 + 加密网格（各自间距恒定，暗部把
 * 加密网格淡入），间距不随亮度连续变，所以不会出现莫尔纹/线条游动。
 * Boil：抖动种子按量化时间跳变（手绘沸腾感，一拍 N）；断线：沿线随机擦段。
 *
 * 协作：纸张纹理复用主链 PaperTexturePass；轮廓线交给主链 InkEdge。
 */

import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import * as THREE from 'three';

const SketchHatchShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uProjectionMatrixInverse: { value: new THREE.Matrix4() },
    uCameraMatrixWorld: { value: new THREE.Matrix4() },
    uTime: { value: 0.0 },
    uHatchSpaceMode: { value: 1.0 }, // 0=screen print pattern, 1=world/surface stable
    uWorldScale: { value: 3.5 },
    uHatchSpacing: { value: 7 },
    uHatchAngle: { value: (35 * Math.PI) / 180 }, // 弧度
    uLineWidth: { value: 0.16 },
    uJitter: { value: 0.20 },
    uLineColor: { value: new THREE.Vector3(0.169, 0.180, 0.220) }, // #2b2e38
    uPaperColor: { value: new THREE.Vector3(0.965, 0.945, 0.902) }, // #f6f1e6
    uPreserveColor: { value: 1 },
    uToneStrength: { value: 0.5 },
    uToneBias: { value: -0.05 },     // 排线档位偏置：正=整体读更暗、各档提前激活（压暗部）
    uDenseSpacing: { value: 0.5 },   // 加密网格间距比（相对基准，越小暗部越密）
    uDarkFill: { value: 0.45 },      // 深暗整片压向墨色的强度
    uBoilSpeed: { value: 0.0 },      // 沸腾速度：抖动种子每秒跳变次数（0=静止）
    uBreak: { value: 0.10 },         // 断线量：沿线随机擦除的比例（0=实线）
    uStrength: { value: 0.70 },
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
    uniform vec2 uResolution;
    uniform mat4 uProjectionMatrixInverse;
    uniform mat4 uCameraMatrixWorld;
    uniform float uTime;
    uniform float uHatchSpaceMode;
    uniform float uWorldScale;
    uniform float uHatchSpacing;
    uniform float uHatchAngle;
    uniform float uLineWidth;
    uniform float uJitter;
    uniform vec3 uLineColor;
    uniform vec3 uPaperColor;
    uniform float uPreserveColor;
    uniform float uToneStrength;
    uniform float uToneBias;
    uniform float uDenseSpacing;
    uniform float uDarkFill;
    uniform float uBoilSpeed;
    uniform float uBreak;
    uniform float uStrength;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    vec3 reconstructWorldPosition(vec2 uv, float depthSample) {
      vec4 clipPosition = vec4(uv * 2.0 - 1.0, depthSample * 2.0 - 1.0, 1.0);
      vec4 viewPosition = uProjectionMatrixInverse * clipPosition;
      viewPosition /= max(abs(viewPosition.w), 0.00001);
      return (uCameraMatrixWorld * viewPosition).xyz;
    }

    // 单层排线：返回墨迹覆盖 [0,1]（1=线中心）。boilT=量化时间种子，brk=断线量
    float hatchLayer(vec2 sc, float angle, float spacing, float lineWidth, float jitter, float boilT, float brk) {
      vec2 dir = vec2(cos(angle), sin(angle));
      float p = dot(sc, vec2(-dir.y, dir.x));
      // 手绘抖动：低频 sin 摆动 + 分块 hash；种子随 boilT 跳变 → 沸腾
      p += sin(sc.x * 0.09 + boilT * 1.7) * jitter * 2.0
         + (hash(floor(sc / 3.0) + boilT) - 0.5) * jitter * 2.0;
      float d = abs(fract(p / max(spacing, 1.0)) - 0.5) * 2.0; // 0=线心 1=条纹边
      float aa = fwidth(d) + 0.01;
      float cover = 1.0 - smoothstep(lineWidth - aa, lineWidth + aa, d);
      // 断线：沿线方向分段，hash 擦掉一部分（gap 随 boilT 抖动）
      if (brk > 0.001) {
        float lineId = floor(p / max(spacing, 1.0));
        float seg = floor(dot(sc, dir) / (spacing * 3.0));
        float g = hash(vec2(lineId * 13.0 + seg, floor(boilT * 0.5)));
        cover *= smoothstep(brk - 0.12, brk + 0.12, g);
      }
      return cover;
    }

    // 一套四方向网格的墨量（按亮度档 t0..t3 叠加交叉方向）
    float grid(vec2 sc, float A, float spacing, float boilT,
               float t0, float t1, float t2, float t3) {
      float g0 = hatchLayer(sc, A,          spacing, uLineWidth, uJitter, boilT, uBreak);
      float g1 = hatchLayer(sc, A + 1.5708, spacing, uLineWidth, uJitter, boilT, uBreak);
      float g2 = hatchLayer(sc, A + 0.7854, spacing, uLineWidth, uJitter, boilT, uBreak);
      float g3 = hatchLayer(sc, A + 2.3562, spacing, uLineWidth, uJitter, boilT, uBreak);
      return max(max(g0 * t0, g1 * t1), max(g2 * t2, g3 * t3));
    }

    float triplanarGrid(vec3 worldPosition, vec3 worldNormal, float A, float spacing, float boilT,
                        float t0, float t1, float t2, float t3) {
      vec3 blend = pow(abs(worldNormal), vec3(8.0));
      blend /= max(blend.x + blend.y + blend.z, 0.0001);
      vec3 coordinate = worldPosition * max(uWorldScale, 0.01);
      float xPlane = grid(coordinate.zy, A, spacing, boilT, t0, t1, t2, t3);
      float yPlane = grid(coordinate.xz, A, spacing, boilT, t0, t1, t2, t3);
      float zPlane = grid(coordinate.xy, A, spacing, boilT, t0, t1, t2, t3);
      return dot(vec3(xPlane, yPlane, zPlane), blend);
    }

    void main() {
      vec3 src = texture2D(tDiffuse, vUv).rgb;
      float l = luma(src);
      vec2 screenCoordinate = vUv * uResolution;

      // 排线档位读的亮度先减偏置：uToneBias 正 = 整体读更暗、各档提前激活（压暗部）
      float lh = clamp(l - uToneBias, 0.0, 1.0);

      // 4 档软激活（smoothstep 避免明暗档硬跳变）；越暗叠越多交叉方向
      float t0 = smoothstep(0.90, 0.80, lh); // lh<0.85 起
      float t1 = smoothstep(0.65, 0.55, lh); // lh<0.6
      float t2 = smoothstep(0.40, 0.30, lh); // lh<0.35
      float t3 = smoothstep(0.22, 0.10, lh); // lh<0.16 深暗

      float boilT = floor(uTime * uBoilSpeed); // 量化时间：一拍 N 的沸腾节奏

      // 双网格：世界空间只画真实模型表面；Screen / Print 才是全屏固定网纹。
      float A = uHatchAngle;
      float depthSample = texture2D(tDepth, vUv).r;
      vec3 viewNormal = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
      bool hasSurface = depthSample < 0.9999 && dot(viewNormal, viewNormal) > 0.1;
      float surfaceMask = (uHatchSpaceMode > 0.5)
        ? (hasSurface ? 1.0 : 0.0)
        : 1.0;

      float baseHatch = 0.0;
      float denseHatch = 0.0;
      if (uHatchSpaceMode > 0.5) {
        if (hasSurface) {
          vec3 worldPosition = reconstructWorldPosition(vUv, depthSample);
          vec3 worldNormal = normalize(mat3(uCameraMatrixWorld) * viewNormal);
          float worldSpacing = max(uHatchSpacing / 7.0, 0.25);
          baseHatch = triplanarGrid(
            worldPosition, worldNormal, A, worldSpacing, boilT, t0, t1, t2, t3
          );
          denseHatch = triplanarGrid(
            worldPosition, worldNormal, A,
            worldSpacing * max(uDenseSpacing, 0.15), boilT, t0, t1, t2, t3
          );
        }
      } else {
        baseHatch = grid(
          screenCoordinate, A, uHatchSpacing, boilT, t0, t1, t2, t3
        );
        denseHatch = grid(
          screenCoordinate, A,
          uHatchSpacing * max(uDenseSpacing, 0.15), boilT, t0, t1, t2, t3
        );
      }

      // 暗部把加密网格淡入到基准之上（淡入的是墨量不是间距→平滑无莫尔纹）
      float denseW = smoothstep(0.55, 0.05, lh);
      float hatch = max(baseHatch, denseHatch * denseW);

      // 深暗整片压黑：max 合成线间永远露纸底，压不黑——这里整片填充
      float fillT = smoothstep(0.40, 0.0, lh) * uDarkFill;
      hatch = max(hatch, fillT * surfaceMask);

      // 纸底：淡彩=原图色；黑白=纸色按亮度压暗（uToneStrength 保留灰阶渐变）
      vec3 paper = (uPreserveColor > 0.5)
        ? src
        : uPaperColor * mix(1.0, l, uToneStrength);
      vec3 sketch = mix(paper, uLineColor, hatch);
      vec3 outc = mix(src, sketch, uStrength * surfaceMask);
      gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * 创建 SketchHatchPass（默认 disabled，由 PostProcessPanel 控制）
 * @returns {ShaderPass}
 */
export function createSketchHatchPass() {
  const pass = new ShaderPass(SketchHatchShader);
  pass.enabled = false;
  return pass;
}

export { SketchHatchShader };
