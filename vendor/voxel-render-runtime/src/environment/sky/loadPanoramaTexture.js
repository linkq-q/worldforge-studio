/**
 * loadPanoramaTexture.js — equirectangular 全景贴图加载。
 *
 * 只负责"给一个 URL，拿回一张 mapping/colorSpace 都设置正确的贴图"。
 * 纹理的归属、替换和释放由调用方决定。
 */

import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

export const PANORAMA_EXTENSIONS = ['hdr', 'exr', 'jpg', 'jpeg', 'png'];

/**
 * @param {string} url 贴图地址（http(s)、相对路径或 object URL 均可）
 * @param {string} extension 小写扩展名，不带点
 * @returns {Promise<THREE.Texture>}
 */
export async function loadPanoramaTexture(url, extension) {
  const ext = String(extension || '').toLowerCase().replace(/^\./, '');

  if (ext === 'hdr') {
    const texture = await new RGBELoader().loadAsync(url);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    return texture;
  }

  if (ext === 'exr') {
    const texture = await new EXRLoader().loadAsync(url);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    return texture;
  }

  if (ext === 'jpg' || ext === 'jpeg' || ext === 'png') {
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  throw new Error(`Unsupported sky texture format: .${ext}`);
}
