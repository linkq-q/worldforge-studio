/**
 * HDRISkyDome.js — HDRI/Panorama 天空球
 *
 * 使用自定义 ShaderMaterial 显示 equirectangular 全景贴图，
 * 支持旋转、色调、曝光、饱和度、强度等实时调整。
 *
 * 该 SkyDome 仅用于背景显示，不负责环境反射。
 * 环境反射由 scene.environment 单独处理。
 */

import * as THREE from 'three';
import { RENDER_ORDER } from '../../render/RenderOrders.js';

// ─── 顶点着色器 ─────────────────────────────────────────────

const vertexShader = /* glsl */`
varying vec3 vWorldDirection;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  // 天空球以 (0,0,0) 为中心，世界方向 = 归一化的世界坐标
  vWorldDirection = normalize(worldPos.xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// ─── 片元着色器 ─────────────────────────────────────────────

const fragmentShader = /* glsl */`
varying vec3 vWorldDirection;

uniform sampler2D uMap;

// Rotation
uniform float uRotationY;

// Color adjustments
uniform float uIntensity;
uniform float uExposure;
uniform float uSaturation;

// Tint
uniform bool uApplyTint;
uniform vec3 uTintColor;
uniform float uTintStrength;

#define PI 3.14159265359

void main() {
  vec3 dir = normalize(vWorldDirection);

  // ── Y 轴旋转 ──
  float c = cos(uRotationY);
  float s = sin(uRotationY);
  mat3 rotY = mat3(
     c, 0.0, s,
    0.0, 1.0, 0.0,
    -s, 0.0, c
  );
  dir = rotY * dir;

  // ── Equirectangular UV ──
  vec2 uv;
  uv.x = atan(dir.z, dir.x) / (2.0 * PI) + 0.5;
  uv.y = asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5;

  // 如果纹理上下颠倒，取消此行注释
  // uv.y = 1.0 - uv.y;

  vec3 color = texture2D(uMap, uv).rgb;

  // ── Saturation ──
  float gray = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(vec3(gray), color, uSaturation);

  // ── Tint ──
  if (uApplyTint) {
    vec3 tinted = color * uTintColor;
    color = mix(color, tinted, uTintStrength);
  }

  // ── Exposure / Intensity ──
  color *= uExposure * uIntensity;

  gl_FragColor = vec4(color, 1.0);
}
`;

// ─── HDRISkyDome 类 ────────────────────────────────────────

export class HDRISkyDome {
  /**
   * @param {number} [radius=500] 天空球半径
   */
  constructor(radius = 500) {
    this.radius = radius;

    // Uniforms
    this.uniforms = {
      uMap: { value: null },
      uRotationY: { value: 0.0 },
      uIntensity: { value: 1.0 },
      uExposure: { value: 1.0 },
      uSaturation: { value: 1.0 },
      uApplyTint: { value: false },
      uTintColor: { value: new THREE.Color(0xffffff) },
      uTintStrength: { value: 0.0 },
    };

    // Material
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
    });

    // Geometry
    this.geometry = new THREE.SphereGeometry(radius, 64, 32);

    // Mesh
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'HDRISkyDome';
    this.mesh.renderOrder = RENDER_ORDER.SKY;
    this.mesh.frustumCulled = false;

    // 禁用 raycasting — 天空球不应被选中
    this.mesh.raycast = () => {};

    // userData 标签 — 用于材质隔离
    this.mesh.userData.isEnvironment = true;
    this.mesh.userData.isSky = true;
    this.mesh.userData.isHDRISky = true;
    this.mesh.userData.skipShaderApply = true;
  }

  /**
   * 设置/替换背景贴图
   * @param {THREE.Texture|null} texture
   */
  setTexture(texture) {
    this.uniforms.uMap.value = texture;
  }

  /**
   * 获取当前贴图
   * @returns {THREE.Texture|null}
   */
  getTexture() {
    return this.uniforms.uMap.value;
  }

  /**
   * 设置旋转角度（弧度）
   * @param {number} radians
   */
  setRotationY(radians) {
    this.uniforms.uRotationY.value = radians;
  }

  /**
   * 设置强度
   * @param {number} value
   */
  setIntensity(value) {
    this.uniforms.uIntensity.value = value;
  }

  /**
   * 设置曝光
   * @param {number} value
   */
  setExposure(value) {
    this.uniforms.uExposure.value = value;
  }

  /**
   * 设置饱和度
   * @param {number} value
   */
  setSaturation(value) {
    this.uniforms.uSaturation.value = value;
  }

  /**
   * 设置色调
   * @param {boolean} enabled
   * @param {string|THREE.Color} color
   * @param {number} strength 0-1
   */
  setTint(enabled, color, strength) {
    this.uniforms.uApplyTint.value = enabled;
    if (color !== undefined) {
      if (typeof color === 'string') {
        this.uniforms.uTintColor.value.set(color);
      } else if (color instanceof THREE.Color) {
        this.uniforms.uTintColor.value.copy(color);
      }
    }
    if (strength !== undefined) {
      this.uniforms.uTintStrength.value = THREE.MathUtils.clamp(strength, 0, 1);
    }
  }

  /**
   * 设置可见性
   * @param {boolean} visible
   */
  setVisible(visible) {
    this.mesh.visible = visible;
  }

  /**
   * 获取可见性
   * @returns {boolean}
   */
  isVisible() {
    return this.mesh.visible;
  }

  /**
   * 将 mesh 添加到指定的父节点
   * @param {THREE.Object3D} parent
   */
  addTo(parent) {
    if (parent && !this.mesh.parent) {
      parent.add(this.mesh);
    }
  }

  /**
   * 从父节点移除 mesh
   */
  removeFromParent() {
    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
  }

  /**
   * 释放资源
   * @param {boolean} [disposeTexture=false] 是否也 dispose 关联贴图
   */
  dispose(disposeTexture = false) {
    this.removeFromParent();

    if (disposeTexture && this.uniforms.uMap.value) {
      this.uniforms.uMap.value.dispose();
      this.uniforms.uMap.value = null;
    }

    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }

    if (this.material) {
      this.material.dispose();
      this.material = null;
    }

    this.mesh = null;
  }
}
