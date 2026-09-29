import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildPatchGeometry } from '@voxel-studio/render-runtime/batching/PrimitiveGeometryBuilders.js';
import { buildModelGroup, type ModelRuntime } from './modelRenderer';
import type { TownBuilding, WorldBundle } from '../shared/worldPlanning';
import type { WorldSample } from '../shared/worldTerrain';

export type WorldAssetRole = 'house' | 'shop' | 'workshop' | 'tree';
export interface WorldAssetSource { id: string; name: string; role: WorldAssetRole; modelJson: unknown }
export interface WorldAssetPrototype {
  id: string; name: string; geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial; size: THREE.Vector3;
}
export type WorldAssetLibrary = Record<WorldAssetRole, WorldAssetPrototype>;

// These saved static assets contain boxes and patches. Use the repository's renderer
// and patch builder without requiring a remote runtime or generating substitute models.
const localRuntime: ModelRuntime = {
  buildGeometry(type, params) {
    if (type === 'box') return new THREE.BoxGeometry(Number(params.width??1),Number(params.height??1),Number(params.depth??1));
    if (type === 'patch') return buildPatchGeometry(THREE, params);
    throw new Error('unsupported_preview_geometry:'+type);
  },
  evaluateMotion: () => ({})
};
export async function buildWorldAssetLibrary(sources: WorldAssetSource[]): Promise<WorldAssetLibrary> {
  if (sources.length !== 4 || new Set(sources.map(a=>a.role)).size !== 4
    || sources.some(a=>!['house','shop','workshop','tree'].includes(a.role))) throw new Error('invalid_preview_asset_pack');
  const library = {} as WorldAssetLibrary;
  try {
    for (const asset of sources) {
      const nodes = (asset.modelJson as {nodes?: Array<{mesh?:{type?:string}}>})?.nodes;
      if (!nodes?.some(n=>n.mesh) || nodes.some(n=>n.mesh && !['box','patch'].includes(n.mesh.type??''))) throw new Error('unsupported_preview_asset:'+asset.id);
      const template = await buildModelGroup(asset.modelJson, localRuntime);
      template.updateMatrixWorld(true);
      const parts:THREE.BufferGeometry[]=[];
      try {
        template.traverse(child=>{
          if (!(child instanceof THREE.Mesh)) return;
          const material=child.material as THREE.MeshStandardMaterial;
          if (Array.isArray(material) || material.transparent || material.opacity<1) throw new Error('nonopaque_preview_asset:'+asset.id);
          const geometry=(child.geometry.index?child.geometry.toNonIndexed():child.geometry.clone()).applyMatrix4(child.matrixWorld);
          for(const name of Object.keys(geometry.attributes))if(!['position','normal'].includes(name))geometry.deleteAttribute(name);
          if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
          const colors = new Float32Array(geometry.getAttribute('position').count*3);
          for(let i=0;i<colors.length;i+=3)colors.set(material.color.toArray(),i);
          geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));geometry.clearGroups();parts.push(geometry);
        });
        const geometry=mergeGeometries(parts);
        if(!geometry)throw new Error('preview_asset_merge_failed:'+asset.id);
        geometry.computeBoundingBox();geometry.computeBoundingSphere();
        library[asset.role]={id:asset.id,name:asset.name,geometry,
          material:new THREE.MeshStandardMaterial({vertexColors:true,roughness:.9,side:THREE.DoubleSide}),
          size:geometry.boundingBox!.getSize(new THREE.Vector3())};
      } finally {
        parts.forEach(g=>g.dispose());
        template.traverse(child=>{
          if(child instanceof THREE.Mesh){child.geometry.dispose();for(const m of Array.isArray(child.material)?child.material:[child.material])m.dispose();}
        });
      }
    }
    return library;
  } catch(error) { disposeWorldAssetLibrary(library);throw error; }
}
export function disposeWorldAssetLibrary(library:WorldAssetLibrary) {
  for(const model of Object.values(library)){model.geometry.dispose();model.material.dispose();}
}
export function buildingAssetRole(building:TownBuilding):Exclude<WorldAssetRole,'tree'> {
  return /工|仓|农具/.test(building.use)?'workshop':/商|店|客/.test(building.use)?'shop':'house';
}
export function buildWorldAssetBuildings(bundle:WorldBundle,sample:(x:number,z:number)=>WorldSample,library:WorldAssetLibrary):THREE.Group {
  const root=new THREE.Group();
  const placements=bundle.patches.flatMap(p=>{
    const town=bundle.plan.towns.find(t=>t.id===p.townId)!;
    return p.buildings.map(b=>({...b,x:b.x+town.center[0],z:b.z+town.center[1]}));
  });
  for(const role of ['house','shop','workshop'] as const){
    const model=library[role], entries=placements.filter(b=>buildingAssetRole(b)===role);
    if(!entries.length)continue;
    const mesh=new THREE.InstancedMesh(model.geometry,model.material,entries.length), transform=new THREE.Object3D();
    mesh.name=model.name;mesh.userData.sharedWorldAsset=true;mesh.userData.buildingIds=entries.map(b=>b.id);
    entries.forEach((b,i)=>{
      const scale=Math.min(b.width/model.size.x,b.depth/model.size.z);
      transform.position.set(b.x,sample(b.x,b.z).height,b.z);
      transform.rotation.y=b.rotation??0;transform.scale.setScalar(scale);transform.updateMatrix();
      mesh.setMatrixAt(i,transform.matrix);
    });
    mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();mesh.castShadow=true;mesh.receiveShadow=true;root.add(mesh);
  }
  return root;
}

