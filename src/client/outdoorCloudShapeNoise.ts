import * as THREE from 'three';
import { createCloudVolumeNoise, periodicCloudNoise } from './outdoorCloudVolume';

let shapeBytes: Uint8Array<ArrayBuffer> | null = null;
const SIZE = 64;

/** v6 only: connected low-frequency bodies, with billows dilating their surface. */
export function createConnectedCloudNoise(): THREE.Data3DTexture {
  if (!shapeBytes) {
    const original = createCloudVolumeNoise();
    const bytes = original.image.data as Uint8Array;
    // Match the repeat + linear filtering used by the original GPU texture.
    const worley = (x: number, y: number, z: number) => {
      const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
      const fx = x - ix, fy = y - iy, fz = z - iz;
      let value = 0;
      for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = ((((iz + dz) & 63) * SIZE + ((iy + dy) & 63)) * SIZE + ((ix + dx) & 63)) * 2;
        value += bytes[i + 1] / 255 * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
      }
      return value;
    };
    shapeBytes = new Uint8Array(SIZE * SIZE * SIZE * 2);
    for (let z = 0; z < SIZE; z++) for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const i = ((z * SIZE + y) * SIZE + x) * 2;
      const broad = periodicCloudNoise((x + 0.5) / 16, (y + 0.5) / 16, (z + 0.5) / 16, 4) * 0.45
        + bytes[i] / 255 * 0.55;
      const lobes = bytes[i + 1] / 255 * 0.65 + worley(x * 2 + 0.5, y * 2 + 0.5, z * 2 + 0.5) * 0.35;
      // Dilation never cuts a high-density core apart; detail is applied separately in the shader.
      shapeBytes[i] = Math.round(255 * (broad + (1 - broad) * lobes * 0.60));
      shapeBytes[i + 1] = Math.round(255 * lobes);
    }
    original.dispose();
  }
  const texture = new THREE.Data3DTexture(shapeBytes, SIZE, SIZE, SIZE);
  texture.format = THREE.RGFormat;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}
