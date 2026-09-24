import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createWaterDetailTexture, syncWaterSurfaceLight } from '../src/client/renderEnvironmentBridge';
import { WaterSurface } from '@voxel-studio/render-runtime/environment';

describe('water material lighting', () => {
  it('follows the actual sun target and dims direct highlights when the sun is off', () => {
    const surface=new WaterSurface(new THREE.Scene(),{} as THREE.WebGLRenderer,new THREE.Group(),{size:1,segments:1});
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
  it('creates reusable filtered detail with unit normals and bounded slope', () => {
    const texture=createWaterDetailTexture();
    const data=texture.image.data as Uint8Array;
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
