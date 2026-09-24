import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createWaterDetailTexture, syncWaterSurfaceLight } from '../src/client/renderEnvironmentBridge';
import { WaterSurface } from '@voxel-studio/render-runtime/environment';

describe('water material lighting', () => {
  it('follows the actual sun target and dims direct highlights when the sun is off', () => {
    const surface=new WaterSurface(new THREE.Scene(),{} as THREE.WebGLRenderer,new THREE.Group(),{size:1,segments:1});
    expect(surface.material.uniforms.uHasTerrainWaterDepth.value).toBe(false);
    expect(surface.material.uniforms.uHasWaterSceneColor.value).toBe(false);
    expect(surface.material.uniforms.uUseSceneWaterLight.value).toBe(false);
    const sun=new THREE.DirectionalLight(0xffccaa,2.5);
    sun.position.set(3,4,0); sun.target.position.set(0,0,0);
    syncWaterSurfaceLight(surface.material,sun);
    const u=surface.material.uniforms;
    expect(u.uSceneWaterLightDirection.value.x).toBeCloseTo(0.6);
    expect(u.uSceneWaterLightDirection.value.y).toBeCloseTo(0.8);
    expect(u.uSceneWaterLightDirection.value.z).toBe(0);
    expect(u.uSceneWaterLightColor.value.r).toBeCloseTo(1);
    sun.intensity=0; syncWaterSurfaceLight(surface.material,sun);
    expect(u.uSceneWaterLightColor.value.toArray()).toEqual([0,0,0]);
    syncWaterSurfaceLight(surface.material,null);
    expect(u.uUseSceneWaterLight.value).toBe(false);
    surface.dispose();
  });
  it('does not concentrate the detail field into a few repeating stripe directions', () => {
    const texture = createWaterDetailTexture();
    const { width } = texture.image;
    const data = texture.image.data as Uint8Array;
    const size = 64, samples: number[][] = [];
    let energy = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const index = (y * width / size * width + x * width / size) * 4;
      const nz = data[index + 2] / 255 * 2 - 1;
      const sx = (data[index] / 255 * 2 - 1) / nz;
      const sy = (data[index + 1] / 255 * 2 - 1) / nz;
      samples.push([x, y, sx, sy]);
      energy += sx * sx + sy * sy;
    }
    let peak = 0;
    // Inspect the resolved ripple band, including the old crossed-stripe modes.
    for (let kx = 0; kx <= 26; kx++) for (let ky = -26; ky <= 26; ky++) {
      if (kx === 0 && ky <= 0) continue;
      let xr = 0, xi = 0, yr = 0, yi = 0;
      for (const [x, y, sx, sy] of samples) {
        const phase = 2 * Math.PI * (kx * x + ky * y) / size;
        const c = Math.cos(phase), s = Math.sin(phase);
        xr += sx * c; xi += sx * s; yr += sy * c; yi += sy * s;
      }
      peak = Math.max(peak, 2 * (xr * xr + xi * xi + yr * yr + yi * yi) / (samples.length * energy));
    }
    // A single periodic mode must not visibly dominate the normal field.
    expect(peak).toBeLessThan(0.08);
    texture.dispose();
  });

  it('creates reusable filtered detail with unit normals and bounded slope', () => {
    const texture=createWaterDetailTexture();
    const data=texture.image.data as Uint8Array;
    // The faster bake must preserve every byte of the accepted normal field.
    expect(createHash('sha256').update(data).digest('hex')).toBe('811fc0c3cbae1fbc1b8698b3836f826a164ef5935e37b4bd1d6f33772bb1b321');
    let maxSlope=0;
    for(let i=0;i<data.length;i+=4) {
      const x=data[i]/255*2-1,y=data[i+1]/255*2-1,z=data[i+2]/255*2-1;
      expect(Math.hypot(x,y,z)).toBeCloseTo(1,2);
      maxSlope=Math.max(maxSlope,Math.hypot(x,y));
      expect(z).toBeGreaterThan(0.85);
    }
    expect(maxSlope).toBeGreaterThan(0.12);
    expect(texture.generateMipmaps).toBe(true);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    texture.dispose();
  });
});
