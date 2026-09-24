import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildStructuredWaterGroup } from '../src/client/mapRenderer';
import { createEmptyMap, type MapWaterBody } from '../src/shared/map';

const lake: MapWaterBody = { id: 'lake', name: 'lake', type: 'lake', level: 1, depth: 2, width: 1,
  points: [[-20,-20],[20,-20],[20,20],[-20,20]], shorelineSmoothness: 0 };
function maxEdge(mesh: THREE.Mesh): number {
  const positions=mesh.geometry.getAttribute('position'), indices=mesh.geometry.index!;
  const a=new THREE.Vector3(), b=new THREE.Vector3(); let longest=0;
  for(let i=0;i<indices.count;i+=3) for(let j=0;j<3;j++) {
    a.fromBufferAttribute(positions,indices.getX(i+j)); b.fromBufferAttribute(positions,indices.getX(i+(j+1)%3));
    longest=Math.max(longest,a.distanceTo(b));
  }
  return longest;
}
function dispose(mesh: THREE.Mesh): void {
  mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose();
  mesh.userData.waterShore.texture.dispose();mesh.userData.waterShore.depthTexture?.dispose();
}
describe('water wave sampling',()=>{
  it.each(['outdoor','indoor'] as const)('samples the lake interior independently of its four bank vertices (%s)',sceneMode=>{
    const map=createEmptyMap();map.sceneMode=sceneMode;map.waterBodies=[lake];
    const mesh=buildStructuredWaterGroup(map).children[0] as THREE.Mesh;
    try {
      expect(maxEdge(mesh)).toBeLessThanOrEqual(Math.SQRT2+0.001);
      const positions=mesh.geometry.getAttribute('position');
      expect(Array.from({length:positions.count},(_,i)=>Math.hypot(positions.getX(i)+mesh.position.x,positions.getZ(i)+mesh.position.z)).some(d=>d<1)).toBe(true);
      expect(mesh.userData.waterShore.worldSpace).toBe(false);
      expect(mesh.geometry.hasAttribute('riverFlow')).toBe(false);
      expect(positions.count).toBeLessThanOrEqual(193*193);
    } finally { dispose(mesh); }
  });
  it('retains a concave lake mask and limits the grid budget for large lakes',()=>{
    const map=createEmptyMap();map.waterBodies=[{...lake,points:[[-20,-20],[20,-20],[20,0],[0,0],[0,20],[-20,20]]}];
    const mesh=buildStructuredWaterGroup(map).children[0] as THREE.Mesh;
    try {
      const shore=mesh.userData.waterShore,image=shore.texture.image;
      const at=(x:number,z:number)=>image.data[Math.floor((0.5-(z-shore.center[1])/shore.size)*image.height)*image.width+Math.floor(((x-shore.center[0])/shore.size+0.5)*image.width)];
      expect(at(10,10)).toBe(0);expect(at(-10,-10)).toBeGreaterThan(0);
    } finally {dispose(mesh);}
    map.waterBodies=[{...lake,points:[[-500,-500],[500,-500],[500,500],[-500,500]]}];
    const large=buildStructuredWaterGroup(map).children[0] as THREE.Mesh;
    try {expect(large.geometry.getAttribute('position').count).toBeLessThanOrEqual(193*193);} finally {dispose(large);}
  });
  it('samples a long wide river by world distance while retaining slope and flow',()=>{
    const map=createEmptyMap();map.waterBodies=[{...lake,type:'river',points:[[0,-30],[0,30]],width:24,level:1,levels:[4,1]}];
    const mesh=buildStructuredWaterGroup(map).children[0] as THREE.Mesh;
    try {
      expect(maxEdge(mesh)).toBeLessThan(1.5);
      const p=mesh.geometry.getAttribute('position'), flow=mesh.geometry.getAttribute('riverFlow');
      expect(p.getY(0)+mesh.position.y).toBeCloseTo(4);
      expect(p.getY(p.count-1)+mesh.position.y).toBeCloseTo(1);
      expect(p.getX(0)).toBeCloseTo(-12);expect(p.getX(p.count-1)).toBeCloseTo(12);
      for(let i=0;i<flow.count;i++){expect(flow.getX(i)).toBeCloseTo(0);expect(flow.getY(i)).toBeCloseTo(1);}
    } finally {dispose(mesh);}
  });
});