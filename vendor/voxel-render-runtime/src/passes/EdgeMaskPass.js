/**
 * EdgeMaskPass.js — 独立几何边缘通道（供 Pixel 描边保持用）
 *
 * 不进 composer 链：ShaderMaterial + FullScreenQuad 手动渲染进独立 RT。
 * 输入 tNormal/tDepth（复用 normalRenderTarget 及其 depthTexture，零额外几何渲染），
 * 输出 vec4(vec3(edge),1)，edge = 阈值化的 max(深度 Sobel, 法线边)。
 * 检测固定在一个物理像素；线宽由下游独立扩张，避免放大 Sobel 步长造成台阶和断线。
 *
 * 深度/法线解码抄自 InkEdgePass（保持一致），但刻意自带一份、不耦合那条脆弱链路。
 */

import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import * as THREE from 'three';

const EdgeMaskShader = {
  uniforms: {
    tNormal: { value: null },
    tDepth: { value: null },
    tBoundaryId: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 1000 },
    uEdgeThreshold: { value: 0.1 }, // 越小越灵敏（更多边）
    uDepthWeight: { value: 1.0 },
    uNormalWeight: { value: 1.0 },
    uObjectWeight: { value: 0.0 },
    uMaterialWeight: { value: 0.0 },
    // 兼容旧状态；检测不再使用它，线宽由消费者的 expansion 阶段控制。
    uEdgeWidth: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform sampler2D tBoundaryId;
    uniform vec2 uResolution;
    uniform float uCameraNear;
    uniform float uCameraFar;
    uniform float uEdgeThreshold;
    uniform float uDepthWeight;
    uniform float uNormalWeight;
    uniform float uObjectWeight;
    uniform float uMaterialWeight;
    uniform float uEdgeWidth;
    varying vec2 vUv;

    float linearizeDepth(float d) {
      if (d >= 0.9999) return uCameraFar;
      return (2.0 * uCameraNear * uCameraFar) /
             (uCameraFar + uCameraNear - d * (uCameraFar - uCameraNear));
    }
    float readLinearDepth(vec2 uv) { return linearizeDepth(texture2D(tDepth, uv).r); }
    vec3 decodeNormal(vec2 uv) {
      vec3 p = texture2D(tNormal, uv).rgb;
      if (length(p) < 0.01) return vec3(0.0);
      return normalize(p * 2.0 - 1.0);
    }

    // 深度 Sobel 幅值（归一化到深度范围）
    float sobelDepthMag(vec2 uv, vec2 texel) {
      float tl = readLinearDepth(uv + vec2(-1.0,  1.0) * texel);
      float t  = readLinearDepth(uv + vec2( 0.0,  1.0) * texel);
      float tr = readLinearDepth(uv + vec2( 1.0,  1.0) * texel);
      float l  = readLinearDepth(uv + vec2(-1.0,  0.0) * texel);
      float r  = readLinearDepth(uv + vec2( 1.0,  0.0) * texel);
      float bl = readLinearDepth(uv + vec2(-1.0, -1.0) * texel);
      float b  = readLinearDepth(uv + vec2( 0.0, -1.0) * texel);
      float br = readLinearDepth(uv + vec2( 1.0, -1.0) * texel);
      float gx = -tl + tr - 2.0 * l + 2.0 * r - bl + br;
      float gy =  tl + 2.0 * t + tr - bl - 2.0 * b - br;
      return sqrt(gx * gx + gy * gy) / (uCameraFar - uCameraNear);
    }

    // 法线方向差异（4 邻域，取最不连续方向）
    float normalEdge(vec2 uv, vec2 texel) {
      vec3 n0 = decodeNormal(uv);
      if (length(n0) < 0.001) return 0.0;
      vec3 nR = decodeNormal(uv + vec2(texel.x, 0.0));
      vec3 nL = decodeNormal(uv - vec2(texel.x, 0.0));
      vec3 nU = decodeNormal(uv + vec2(0.0, texel.y));
      vec3 nD = decodeNormal(uv - vec2(0.0, texel.y));
      float eR = length(nR) < 0.001 ? 0.0 : 1.0 - abs(dot(n0, nR));
      float eL = length(nL) < 0.001 ? 0.0 : 1.0 - abs(dot(n0, nL));
      float eU = length(nU) < 0.001 ? 0.0 : 1.0 - abs(dot(n0, nU));
      float eD = length(nD) < 0.001 ? 0.0 : 1.0 - abs(dot(n0, nD));
      return max(max(eR, eL), max(eU, eD));
    }

    float packedIdValid(vec2 id) {
      return step(0.5 / 255.0, id.x + id.y);
    }

    float packedIdChanged(vec2 center, vec2 neighbor) {
      float bothValid = packedIdValid(center) * packedIdValid(neighbor);
      float delta = max(abs(center.x - neighbor.x), abs(center.y - neighbor.y));
      return bothValid * step(0.5 / 255.0, delta);
    }

    vec2 boundaryEdges(vec2 uv, vec2 texel) {
      vec4 center = texture2D(tBoundaryId, uv);
      vec4 right = texture2D(tBoundaryId, uv + vec2(texel.x, 0.0));
      vec4 left = texture2D(tBoundaryId, uv - vec2(texel.x, 0.0));
      vec4 up = texture2D(tBoundaryId, uv + vec2(0.0, texel.y));
      vec4 down = texture2D(tBoundaryId, uv - vec2(0.0, texel.y));
      float objectEdge = max(max(packedIdChanged(center.rg, right.rg), packedIdChanged(center.rg, left.rg)),
                             max(packedIdChanged(center.rg, up.rg), packedIdChanged(center.rg, down.rg)));
      float materialEdge = max(max(packedIdChanged(center.ba, right.ba), packedIdChanged(center.ba, left.ba)),
                               max(packedIdChanged(center.ba, up.ba), packedIdChanged(center.ba, down.ba)));
      return vec2(objectEdge, materialEdge);
    }

    void main() {
      vec2 texel = 1.0 / uResolution;
      // 深度边灵敏度放大到与法线边同量级；两者取 max
      float depthEdge = sobelDepthMag(vUv, texel) * 25.0 * max(uDepthWeight, 0.0);
      float normalCrease = normalEdge(vUv, texel) * max(uNormalWeight, 0.0);
      vec2 ids = boundaryEdges(vUv, texel);
      float objectBoundary = ids.x * max(uObjectWeight, 0.0);
      float materialBoundary = ids.y * max(uMaterialWeight, 0.0);
      float e = max(max(depthEdge, normalCrease), max(objectBoundary, materialBoundary));
      float edge = smoothstep(uEdgeThreshold * 0.5, uEdgeThreshold, e);
      gl_FragColor = vec4(vec3(edge), 1.0);
    }
  `,
};

/**
 * 创建 EdgeMaskPass（手动渲染型，不进 composer）。
 * @returns {{ material: THREE.ShaderMaterial, render: Function, setSize: Function, dispose: Function }}
 */
export function createEdgeMaskPass() {
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(EdgeMaskShader.uniforms),
    vertexShader: EdgeMaskShader.vertexShader,
    fragmentShader: EdgeMaskShader.fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  const fsQuad = new FullScreenQuad(material);

  return {
    material,
    /**
     * 把边缘渲染进 targetRT。normalTex/depthTex 来自 normalRenderTarget。
     */
    render(renderer, targetRT, normalTex, depthTex, boundaryIdTex, near, far) {
      const u = material.uniforms;
      u.tNormal.value = normalTex;
      u.tDepth.value = depthTex;
      u.tBoundaryId.value = boundaryIdTex;
      u.uCameraNear.value = near;
      u.uCameraFar.value = far;
      u.uResolution.value.set(targetRT.width, targetRT.height);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(targetRT);
      fsQuad.render(renderer);
      renderer.setRenderTarget(prev);
    },
    setSize(w, h) {
      material.uniforms.uResolution.value.set(w, h);
    },
    dispose() {
      fsQuad.dispose();
      material.dispose();
    },
  };
}

export { EdgeMaskShader };
