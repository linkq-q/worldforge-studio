import {describe, expect, it} from 'vitest';
import {createEmptyMap, createMapObject, type MapAsset} from '../src/shared/map';
import {lintMap} from '../src/shared/mapLint';
import {applyMapOperations} from '../src/shared/mapOperations';
import {worldPlanKey, type WorldPlan} from '../src/shared/worldPlanning';
import {validateMapSuggestion} from '../src/server/mapSuggestionValidation';
import {buildModelColliderPlan, MAP_ASSET_COLLIDER_PROFILE} from '../src/shared/modelBounds';

describe('diagnostic lint preserves the observed candidate',()=>{
  it('does not discard duplicate objects before measuring their actual buried positions',()=>{
    const map=createEmptyMap('buried duplicates','buried-duplicates',[64,20,64]);
    const modelJson={nodes:[{id:'box',transform:{pos:[0,1,0]},mesh:{type:'box',params:{width:2,height:2,depth:2}}}]};
    const asset:MapAsset={id:'house',name:'House',prompt:'House',tags:['house'],modelJson,
      colliderPlan:buildModelColliderPlan(modelJson,MAP_ASSET_COLLIDER_PROFILE),mode:'voxel',createdAt:1,updatedAt:1};
    map.assets=[asset];
    map.objects=['a','b'].map(id=>{
      const object=createMapObject('House '+id,asset.id);object.id=id;object.heightMode='fixed';
      object.transform.position=[0,-8,0];return object;
    });
    const original=structuredClone(map), result=lintMap(map,{repair:false});
    expect(result.repairOperations).toEqual([]);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code:'object.duplicate',repaired:false}),
      expect.objectContaining({code:'object.buried',objectIds:['a'],repaired:false}),
      expect.objectContaining({code:'object.buried',objectIds:['b'],repaired:false})
    ]));
    expect(result.issues.every(issue=>!issue.repaired)).toBe(true);
    expect(map).toEqual(original);
  });

  it('reports original overlap pairs and never claims or performs hypothetical relocation',()=>{
    const map=createEmptyMap('overlaps','diagnostic-overlaps',[64,12,64]);
    map.objects=[0,7,14].map((x,index)=>{
      const object=createMapObject('民居 '+index);object.id='house-'+index;object.locked=true;
      object.transform.position=[x,0,0];object.transform.size=[8,5,8];return object;
    });
    const repairableObjectIds=new Set(map.objects.map(object=>object.id)), original=structuredClone(map);
    const suggestion={summary:'inspect',operations:[{type:'sun.set' as const,point:[3,8,4] as [number,number,number]}],
      generatedAssets:[],renderPromptSuggestions:[]};
    const result=validateMapSuggestion(map,suggestion,{repair:false,repairableObjectIds});
    expect(result.issues.filter(issue=>issue.code==='object.overlap').map(issue=>issue.objectIds)).toEqual([
      ['house-0','house-1'],['house-1','house-2']
    ]);
    expect(result.issues.every(issue=>!issue.repaired)).toBe(true);
    expect(result.issues.map(issue=>issue.message).join(' ')).not.toMatch(/已将|已移动|已重新|已移除/);
    expect(result.repairCount).toBe(0);
    expect(result.suggestion.operations).toEqual(suggestion.operations);
    expect(applyMapOperations(map,result.suggestion.operations).objects).toEqual(original.objects);
    expect(map).toEqual(original);
    const legacy=lintMap(map,{repairableObjectIds});
    expect(legacy.repairOperations.some(operation=>operation.type==='object.update')).toBe(true);
    expect(legacy.issues.some(issue=>issue.code==='object.overlap' && issue.repaired)).toBe(true);
  });

  it('counts streamed town buildings in the coarse sparse-scene estimate',()=>{
    const map=createEmptyMap('town count','town-count',[500,4096,500]);
    const plan:WorldPlan={version:1,id:'world',revision:1,prompt:'',generationPolicy:'diagnostic',
      recipe:{version:1,seed:47,size:500,constraints:[{region:'center',biome:'grassland'}]},ecology:[],roads:[],
      towns:[{id:'town',name:'Town',prompt:'',center:[0,0],radius:50,blend:20,foundation:5,ports:[]}]};
    map.world={bundle:{plan,patches:[{townId:'town',worldKey:worldPlanKey(plan),summary:'',streets:[],
      buildings:Array.from({length:34},(_,i)=>({id:'home-'+i,x:(i%6)*7-18,z:Math.floor(i/6)*7-18,width:4,depth:4,height:5,use:'home'}))}]},assets:[]};
    expect(map.objects).toEqual([]);
    expect(lintMap(map,{repair:false}).issues.find(issue=>issue.code==='scene.sparse')?.message).toContain('共 34 个');
    map.objects=Array.from({length:50},()=>createMapObject('Prop'));
    expect(lintMap(map,{repair:false}).issues.some(issue=>issue.code==='scene.sparse')).toBe(false);
    map.world.bundle.patches[0].buildings.length=2;
    const sparse=lintMap(map,{repair:false}).issues.find(issue=>issue.code==='scene.sparse');
    expect(sparse?.message).toContain('共 52 个');
  });
});
