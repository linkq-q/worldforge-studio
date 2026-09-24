import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildStructuredWaterGroup } from '../src/client/mapRenderer';
import { createEmptyMap, type MapWaterBody } from '../src/shared/map';

const lake: MapWaterBody = { id: 'depth-lake', name: 'Depth lake', type: 'lake', points: [[-12,-12],[12,-12],[12,12],[-12,12]], level: 2, width: 1, depth: 2, shorelineSmoothness: 0 };
function depthAt(mesh: THREE.Mesh, x: number, z: number) {
  const binding = mesh.userData.waterShore;
  const image = binding.depthTexture.image;
  const col = Math.floor(((x-binding.center[0])/binding.size+0.5)*image.width);
  const row = Math.floor((0.5-(z-binding.center[1])/binding.size)*image.height);
  const i=(row*image.width+col)*4;
  return {depth:(image.data[i]*256+image.data[i+1])/65535*64, valid:image.data[i+2]};
}
function dispose(group: THREE.Group) {
  for(const object of group.children) {
    const mesh=object as THREE.Mesh;
    mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose();
    mesh.userData.waterShore.texture.dispose(); mesh.userData.waterShore.depthTexture?.dispose();
  }
}
describe('terrain water depth', () => {
  it('keeps structural water invalid inside a connected river-lake mesh', () => {
    const map=createEmptyMap();
    map.waterBodies=[lake,{...lake,id:'chute',type:'river',points:[[0,12],[0,24]],width:4,levels:[2,5],carveTerrain:false}];
    const group=buildStructuredWaterGroup(map);
    expect(group.children).toHaveLength(1);
    const mesh=group.children[0] as THREE.Mesh;
    expect(depthAt(mesh,0,0).valid).toBe(255);
    expect(depthAt(mesh,0,20).valid).toBe(0);
    dispose(group);
  });
  it('distinguishes different bed heights at the same distance from shore', () => {
    const map=createEmptyMap();
    for(let z=0;z<map.terrain.resolutionZ;z++) for(let x=0;x<map.terrain.resolutionX;x++) {
      map.terrain.heights[z*map.terrain.resolutionX+x]=x<map.terrain.resolutionX/2 ? 1.5 : -3;
    }
    map.waterBodies=[lake];
    const group=buildStructuredWaterGroup(map), mesh=group.children[0] as THREE.Mesh;
    expect(depthAt(mesh,-6,0).depth).toBeCloseTo(0.5,2);
    expect(depthAt(mesh,6,0).depth).toBeCloseTo(5,2);
    expect(depthAt(mesh,6,0).valid).toBe(255);
    dispose(group);
  });
  it('does not invent terrain depth for hidden indoor ground or structure-supported water', () => {
    const map=createEmptyMap(); map.waterBodies=[lake]; map.sceneMode='indoor';
    const indoor=buildStructuredWaterGroup(map);
    expect(indoor.children[0].userData.waterShore.depthTexture).toBeUndefined(); dispose(indoor);
    map.sceneMode='outdoor'; map.waterBodies=[{...lake,carveTerrain:false}];
    const structural=buildStructuredWaterGroup(map);
    expect(structural.children[0].userData.waterShore.depthTexture).toBeUndefined(); dispose(structural);
  });
  it('samples varying river surface elevation and clamps beds above the water to zero', () => {
    const map=createEmptyMap(); map.terrain.heights.fill(1);
    map.waterBodies=[{...lake,type:'river',points:[[0,-12],[0,12]],width:6,level:0,levels:[4,0]}];
    const group=buildStructuredWaterGroup(map), mesh=group.children[0] as THREE.Mesh;
    expect(depthAt(mesh,0,-6).depth).toBeCloseTo(2,1);
    expect(depthAt(mesh,0,10).depth).toBe(0);
    dispose(group);
  });
});
