import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { createPlannedWorldSampler, createWorldEcologyDensity, createWorldExclusion, mergeTownPatch, validateWorldBundle } from '../src/shared/worldPlanning';
import { generateEcologyChunk, selectEcologyChunks } from '../src/shared/worldEcology';
import { sampleWorldTile } from '../src/shared/worldTerrain';
import { buildWorldStructures, disposeWorldStructures } from '../src/client/worldContent';
import * as THREE from 'three';

const bundle = validateWorldBundle(JSON.parse(readFileSync(new URL('../scripts/fixtures/hierarchical-world.json',import.meta.url),'utf8').replace(/^\uFEFF/,'')));
describe('hierarchical world pipeline',()=>{
  it('merges the two AI town plans in either completion order with their designed differences',()=>{
    const empty={plan:bundle.plan,patches:[]};
    const first=mergeTownPatch(mergeTownPatch(empty,bundle.patches[0]),bundle.patches[1]);
    const second=mergeTownPatch(mergeTownPatch(empty,bundle.patches[1]),bundle.patches[0]);
    expect(first).toEqual(second); expect(first).toEqual(bundle);
    expect(bundle.patches.map(p=>p.buildings.length)).toEqual([31,33]);
    expect(bundle.patches[0].summary).not.toEqual(bundle.patches[1].summary);
  });
  it('keeps only the replaced town patch mutable and preserves distant surface and ecology',()=>{
    const revised=structuredClone(bundle.patches[1]); revised.buildings[0].height+=1;
    const next=mergeTownPatch(bundle,revised);
    expect(next.patches[0]).toEqual(bundle.patches[0]);
    expect(bundle.patches[1].buildings[0].height).toBe(revised.buildings[0].height-1);
    const before=createPlannedWorldSampler(bundle.plan,bundle.patches),after=createPlannedWorldSampler(next.plan,next.patches);
    const options={sample:before,exclusion:createWorldExclusion(bundle.plan,bundle.patches),density:createWorldEcologyDensity(bundle.plan,bundle.patches)};
    const nextOptions={sample:after,exclusion:createWorldExclusion(next.plan,next.patches),density:createWorldEcologyDensity(next.plan,next.patches)};
    const chunk={x:-5,z:55};
    expect(generateEcologyChunk(bundle.plan.recipe,bundle.plan.ecology,chunk,options))
      .toEqual(generateEcologyChunk(next.plan.recipe,next.plan.ecology,chunk,nextOptions));
    for(const [x,z]of [[0,0],[-1250,13250],[18740,5750],[19740,5750]]) expect(after(x,z)).toEqual(before(x,z));
  });
  it('uses the composed surface for both neighbouring terrain tiles and plant roots',()=>{
    const sample=createPlannedWorldSampler(bundle.plan,bundle.patches), town=bundle.plan.towns[0];
    const left=sampleWorldTile(bundle.plan.recipe,{x:town.center[0]-256,z:town.center[1]-128,size:256},33,sample);
    const right=sampleWorldTile(bundle.plan.recipe,{x:town.center[0],z:town.center[1]-128,size:256},33,sample);
    for(let i=0;i<33;i++){
      expect(left.heights[i*33+32]).toBe(right.heights[i*33]);
      expect([...left.normals.slice((i*33+32)*3,(i*33+33)*3)]).toEqual([...right.normals.slice(i*33*3,(i*33+1)*3)]);
    }
    const items=generateEcologyChunk(bundle.plan.recipe,bundle.plan.ecology,{x:-5,z:55},{
      sample,exclusion:createWorldExclusion(bundle.plan,bundle.patches),density:createWorldEcologyDensity(bundle.plan,bundle.patches)
    }).instances;
    expect(items.length).toBeGreaterThan(0);
    items.forEach(i=>expect(i.y).toBe(sample(i.x,i.z).height));
  });
  it('bounds visible ecology equally for 16,64 and256 km; far world view materializes no plants',()=>{
    for(const size of [16000,64000,256000]) {
      expect(selectEcologyChunks(size,1000,-1000,800)).toHaveLength(25);
      expect(selectEcologyChunks(size,1000,-1000,20000)).toHaveLength(0);
    }
  });
  it('renders a closed local street segment and releases experimental geometry',()=>{
    const sample=createPlannedWorldSampler(bundle.plan,bundle.patches);
    const changed=structuredClone(bundle);
    changed.plan.roads=[{id:'closed-preview',name:'closed preview',points:[[0,0],[100,0],[100,100]],closed:true,curve:'polyline',width:12,tags:[]}];
    changed.patches=[];
    const root=buildWorldStructures(changed,sample);
    root.updateMatrixWorld(true);
    const ray=new THREE.Raycaster(new THREE.Vector3(50,sample(50,50).height+100,50),new THREE.Vector3(0,-1,0));
    expect(ray.intersectObject(root,true).length).toBeGreaterThan(0);
    disposeWorldStructures(root); expect(root.children).toHaveLength(0);
  });
});

