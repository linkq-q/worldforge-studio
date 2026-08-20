/**
 * ShoreDistanceGenerator.js — Local Water Body 岸线距离场生成器
 *
 * 输入：黑白 waterMask（白=水域，黑=非水域/陆地），分辨率任意
 * 输出：THREE.DataTexture（R 通道编码 0~1 的归一化"岸线距离"）
 *   - 0   = 岸边 / 非水域
 *   - 1   = 离岸最远的水域中心
 *
 * 算法：两遍（forward/backward）距离传播近似算法（4-邻域，权重 1）。
 * 不要求精确欧氏距离，足够支撑 shoreFoam / shoreWave 的平滑过渡。
 *
 * 性能：仅在用户上传/生成 mask 时计算一次，结果缓存为 DataTexture，
 * 不在每帧重新计算。
 */

import * as THREE from 'three';

const INF = 1e9;

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

export class ShoreDistanceGenerator {
  /**
   * 两遍距离传播：陆地像素(isWater=false)距离为 0，作为种子向水域传播。
   * @param {Uint8Array} isWater - 长度 width*height，1=水域，0=非水域
   * @param {number} width
   * @param {number} height
   * @returns {Float32Array} 未归一化的传播距离（陆地=0，水域>=1）
   */
  static computeDistanceTransform(isWater, width, height) {
    const dist = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      dist[i] = isWater[i] ? INF : 0;
    }

    // forward pass: 从左上到右下，检查左邻居和上邻居
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (x > 0) dist[i] = Math.min(dist[i], dist[i - 1] + 1);
        if (y > 0) dist[i] = Math.min(dist[i], dist[i - width] + 1);
      }
    }

    // backward pass: 从右下到左上，检查右邻居和下邻居
    for (let y = height - 1; y >= 0; y--) {
      for (let x = width - 1; x >= 0; x--) {
        const i = y * width + x;
        if (x < width - 1) dist[i] = Math.min(dist[i], dist[i + 1] + 1);
        if (y < height - 1) dist[i] = Math.min(dist[i], dist[i + width] + 1);
      }
    }

    return dist;
  }

  /**
   * 由 mask 像素数据计算归一化的岸线距离场（0~1，Float32Array）。
   * @param {Uint8Array|Uint8ClampedArray} maskData - RGBA 像素数据，长度 width*height*4
   * @param {number} width
   * @param {number} height
   * @param {object} [options]
   * @param {number} [options.threshold=127] - 亮度阈值，>=阈值视为水域(白)
   * @param {boolean} [options.invert=false] - 反转水域判定（黑=水域）
   * @param {number} [options.maxDistancePx] - 归一化上限（像素）：距岸超过该值即为 1.0。
   *   默认按"最远水域像素"归一化——岸线带宽会随覆盖区域变大而变大；
   *   scene-shore 等大区域场景用它把带宽钉在固定世界距离上。
   * @returns {{ data: Float32Array, width: number, height: number }}
   */
  static computeDistanceData(maskData, width, height, options = {}) {
    const threshold = options.threshold ?? 127;
    const invert = !!options.invert;
    const count = width * height;

    const isWater = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      const lum = (maskData[o] + maskData[o + 1] + maskData[o + 2]) / 3;
      let water = lum >= threshold;
      if (invert) water = !water;
      isWater[i] = water ? 1 : 0;
    }

    const dist = ShoreDistanceGenerator.computeDistanceTransform(isWater, width, height);

    let maxDist = 0;
    for (let i = 0; i < count; i++) {
      if (isWater[i] && dist[i] < INF && dist[i] > maxDist) maxDist = dist[i];
    }
    if (maxDist <= 0) maxDist = 1;
    if (Number.isFinite(options.maxDistancePx) && options.maxDistancePx > 0) {
      maxDist = Math.min(maxDist, options.maxDistancePx);
    }

    const normalized = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      normalized[i] = isWater[i] ? Math.min(dist[i] / maxDist, 1.0) : 0;
    }

    return { data: normalized, width, height };
  }

  /**
   * 将归一化距离场打包为 THREE.DataTexture（R=G=B=distance, A=255）。
   * @param {Float32Array} distanceData - 归一化 0~1 的距离场
   * @param {number} width
   * @param {number} height
   * @returns {THREE.DataTexture}
   */
  static createDataTexture(distanceData, width, height) {
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const v = Math.round(clamp01(distanceData[i]) * 255);
      rgba[i * 4 + 0] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }

    const texture = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * 由 mask 像素数据直接生成 shoreDistance DataTexture。
   * @param {Uint8Array|Uint8ClampedArray} maskData - RGBA 像素数据
   * @param {number} width
   * @param {number} height
   * @param {object} [options] - 见 computeDistanceData
   * @returns {THREE.DataTexture}
   */
  static fromMaskData(maskData, width, height, options = {}) {
    const { data } = ShoreDistanceGenerator.computeDistanceData(maskData, width, height, options);
    return ShoreDistanceGenerator.createDataTexture(data, width, height);
  }

  /**
   * 由 <canvas> 元素（黑白 waterMask）生成 shoreDistance DataTexture。
   * @param {HTMLCanvasElement} canvas
   * @param {object} [options]
   * @param {number} [options.resolution] - 若提供，先重采样为 resolution x resolution
   * @returns {THREE.DataTexture}
   */
  static fromCanvas(canvas, options = {}) {
    let width = canvas.width;
    let height = canvas.height;
    let sourceCanvas = canvas;

    if (options.resolution && (options.resolution !== width || options.resolution !== height)) {
      width = options.resolution;
      height = options.resolution;
      sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = width;
      sourceCanvas.height = height;
      const resizeCtx = sourceCanvas.getContext('2d');
      resizeCtx.drawImage(canvas, 0, 0, width, height);
    }

    const ctx = sourceCanvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, width, height);
    return ShoreDistanceGenerator.fromMaskData(imageData.data, width, height, options);
  }

  /**
   * 由 <img> / ImageBitmap（黑白 waterMask）生成 shoreDistance DataTexture。
   * @param {HTMLImageElement|ImageBitmap} image
   * @param {object} [options]
   * @param {number} [options.resolution] - 若提供，重采样到 resolution x resolution
   * @returns {THREE.DataTexture}
   */
  static fromImage(image, options = {}) {
    const width = options.resolution || image.naturalWidth || image.width;
    const height = options.resolution || image.naturalHeight || image.height;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);

    const imageData = ctx.getImageData(0, 0, width, height);
    return ShoreDistanceGenerator.fromMaskData(imageData.data, width, height, options);
  }

  /**
   * 生成灰度 debug 预览 canvas（岸边=黑，湖心=白）。
   * @param {Float32Array} distanceData - 归一化 0~1 的距离场（来自 computeDistanceData）
   * @param {number} width
   * @param {number} height
   * @returns {HTMLCanvasElement}
   */
  static createDebugCanvas(distanceData, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
      const v = Math.round(clamp01(distanceData[i]) * 255);
      imageData.data[i * 4 + 0] = v;
      imageData.data[i * 4 + 1] = v;
      imageData.data[i * 4 + 2] = v;
      imageData.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }
}
