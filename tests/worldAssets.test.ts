import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';
import * as THREE from 'three';
import {buildWorldAssetLibrary,buildWorldAssetBuildings,disposeWorldAssetLibrary,pickWorldAsset,type WorldAssetSource} from '../src/client/worldAssets';
import {disposeWorldStructures} from '../src/client/worldContent';
import {validateWorldBundle,createPlannedWorldSampler,townBuildingBounds} from '../src/shared/worldPlanning';
const pack=JSON.parse(readFileSync(new URL('../scripts/fixtures/medieval-assets.json',import.meta.url),'utf8'));
const bundle=validateWorldBundle(JSON.parse(readFileSync(new URL('../scripts/fixtures/compact-world.json',import.meta.url),'utf8').replace(/^\uFEFF/,'')));
describe('saved medieval assets in the continuous world',()=>{
  it('uses all four saved assets locally and batches buildings within their rotated plots',async()=>{
    const request=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('unexpected remote request'));
    const library=await buildWorldAssetLibrary(pack.assets as WorldAssetSource[]);
    try {
      expect(request).not.toHaveBeenCalled();
      for(const model of library.byId.values()){
        expect(model.geometry.getAttribute('position').count).toBeGreaterThan(500);
        expect(model.geometry.boundingBox!.min.y).toBeCloseTo(0,5);
        expect(model.geometry.getAttribute('color').count).toBe(model.geometry.getAttribute('position').count);
      }
      const sample=createPlannedWorldSampler(bundle.plan,bundle.patches);
      const root=buildWorldAssetBuildings(bundle,sample,library);
      expect(root.children).toHaveLength(3);
      let instances=0;
      for(const child of root.children){
        const mesh=child as THREE.InstancedMesh;instances+=mesh.count;
        for(let i=0;i<mesh.count;i++){
          const id=mesh.userData.buildingIds[i];
          const patch=bundle.patches.find(p=>p.buildings.some(b=>b.id===id))!;
          const town=bundle.plan.towns.find(t=>t.id===patch.townId)!;
          const b=patch.buildings.find(b=>b.id===id)!;
          const matrix=new THREE.Matrix4();mesh.getMatrixAt(i,matrix);
          const bounds=mesh.geometry.boundingBox!.clone().applyMatrix4(matrix);
          const reserved=townBuildingBounds({...b,x:b.x+town.center[0],z:b.z+town.center[1]});
          expect(bounds.min.y).toBeCloseTo(sample(reserved.x,reserved.z).height,3);
          expect(bounds.min.x).toBeGreaterThanOrEqual(reserved.x-reserved.width/2-.001);
          expect(bounds.max.x).toBeLessThanOrEqual(reserved.x+reserved.width/2+.001);
          expect(bounds.min.z).toBeGreaterThanOrEqual(reserved.z-reserved.depth/2-.001);
          expect(bounds.max.z).toBeLessThanOrEqual(reserved.z+reserved.depth/2+.001);
        }
      }
      expect(instances).toBe(75);
      const disposed=vi.fn();library.byRole.house[0].geometry.addEventListener('dispose',disposed);
      disposeWorldStructures(root);expect(disposed).not.toHaveBeenCalled();
    } finally {disposeWorldAssetLibrary(library);request.mockRestore();}
  });
  it('accepts partial generated packs but rejects empty packs and unsupported model shapes',async()=>{
    const partial=await buildWorldAssetLibrary(pack.assets.slice(0,1));
    disposeWorldAssetLibrary(partial);
    await expect(buildWorldAssetLibrary([])).rejects.toThrow('invalid_preview_asset_pack');
    const broken=structuredClone(pack.assets);
    broken[0].modelJson.nodes.find((n:{mesh?:unknown})=>n.mesh).mesh.type='unknown-shape';
    await expect(buildWorldAssetLibrary(broken)).rejects.toThrow('unsupported_preview_asset');
  });
  it('supports deterministic role variants and exact asset keys',async()=>{
    const second={...structuredClone(pack.assets.find((asset:WorldAssetSource)=>asset.role==='house')),id:'house-second',name:'第二套住宅'};
    const landmark={...structuredClone(pack.assets.find((asset:WorldAssetSource)=>asset.role==='workshop')),id:'town-hall',name:'议事厅',role:'landmark'};
    const library=await buildWorldAssetLibrary([...pack.assets,second,landmark] as WorldAssetSource[]);
    try {
      const building=structuredClone(bundle.patches[0].buildings[0]);
      expect(pickWorldAsset(library,building)).toBe(pickWorldAsset(library,building));
      expect(pickWorldAsset(library,{...building,assetKey:'town-hall'})).toBe(library.byId.get('town-hall'));
      expect(library.byRole.house).toHaveLength(2);
    } finally {disposeWorldAssetLibrary(library);}
  });
});

