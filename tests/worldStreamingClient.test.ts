import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildWorldRoadChunk, sampleWorldQuaySurface, WORLD_CONTENT_CHUNK_SIZE, WorldContentView, worldBridgeDeck, worldHarborQuayExtension,
  selectWorldContentChunks } from '../src/client/worldContent';
import { stepWorldWalk, type WorldWalkState } from '../src/client/worldWalkController';
import { buildWorldAssetLibrary, disposeWorldAssetLibrary, type WorldAssetSource } from '../src/client/worldAssets';
import { createPlannedWorldSampler, validateWorldBundle } from '../src/shared/worldPlanning';
import type { WorldSample } from '../src/shared/worldTerrain';
import type { MapGuide } from '../src/shared/mapGuide';

const bundle = validateWorldBundle(JSON.parse(readFileSync(new URL('../scripts/fixtures/hierarchical-world.json', import.meta.url), 'utf8').replace(/^\uFEFF/, '')));
const flatSample = (height = 0, waterLevel: number | null = null): WorldSample => ({
  height, continentalness: 0, temperature: .5, moisture: .5,
  weights: { ocean: 0, grassland: 1, forest: 0, desert: 0, mountains: 0, snow: 0 },
  waterLevel, waterBodyId: waterLevel === null ? null : 'water'
});

describe('continuous-world streaming client', () => {
  it('keeps an authored bridge on dry banks while spanning sampled water', () => {
    const road: MapGuide = { id: 'island-bridge', name: 'Island bridge',
      points: [[0, 0], [40, 0]], curve: 'polyline', closed: false, width: 4,
      tags: ['world-route', 'walking-bridge'] };
    const sample = (x: number) => x > 10 && x < 30 ? flatSample(-2, 0)
      : flatSample(x <= 10 ? 1 : 2);
    expect(worldBridgeDeck(road, x => sample(x))).toEqual({
      from: [0, 0], to: [40, 0], width: 4, fromHeight: 1.25, toHeight: 2.25
    });
    expect(worldBridgeDeck({ ...road, tags: ['world-route'] }, x => sample(x))).toBeUndefined();
    expect(worldBridgeDeck({ ...road, points: [[20, 0], [40, 0]] }, x => sample(x))).toBeUndefined();
  });
  it('keeps only a fixed nearby content window and replaces its scene roots after travel', () => {
    const sample = createPlannedWorldSampler(bundle.plan, bundle.patches), view = new WorldContentView();
    view.reset(bundle, sample);
    const first = bundle.plan.towns[0], second = bundle.plan.towns[1];
    const focus = new THREE.Vector3(first.center[0], sample(...first.center).height, first.center[1]);
    view.update(focus, focus.clone().add(new THREE.Vector3(0, 2, 0)));
    const before = [...view.root.children], metrics = view.metrics();
    expect(metrics.contentChunks).toBe(25);
    expect(metrics.contentBuildings).toBeGreaterThan(0);
    expect(metrics.contentBuildings).toBeLessThan(bundle.patches.reduce((sum, patch) => sum + patch.buildings.length, 0));
    const next = new THREE.Vector3(second.center[0], sample(...second.center).height, second.center[1]);
    view.update(next, next.clone().add(new THREE.Vector3(0, 2, 0)));
    expect(before.every(root => root.parent === null)).toBe(true);
    expect(view.root.children.some(root => before.includes(root))).toBe(false);
    view.dispose(); expect(view.root.children).toHaveLength(0);
  });

  it('materializes no content for an overview camera', () => {
    expect(selectWorldContentChunks(64000, 0, 0, 3001)).toEqual([]);
  });

  it('uses nearby enterable asset geometry instead of a solid footprint collider', async () => {
    const pack = JSON.parse(readFileSync(new URL('../scripts/fixtures/medieval-assets.json', import.meta.url), 'utf8'));
    const library = await buildWorldAssetLibrary(pack.assets as WorldAssetSource[]), changed = structuredClone(bundle);
    const building = changed.patches[0].buildings[0], model = library.byRole.house[0];
    building.enterable = true; building.assetKey = model.id;
    const sample = createPlannedWorldSampler(changed.plan, changed.patches), town = changed.plan.towns[0], view = new WorldContentView();
    try {
      view.reset(changed, sample, library);
      const focus = new THREE.Vector3(town.center[0], sample(...town.center).height, town.center[1]);
      view.update(focus, focus.clone().add(new THREE.Vector3(0, 2, 0)));
      expect(view.metrics().contentMeshColliders).toBe(1);
      expect(view.colliders.some(collider => collider.id === building.id)).toBe(false);
    } finally { view.dispose(); disposeWorldAssetLibrary(library); }
  });

  it('walks on the sampled surface while respecting slopes, bounds and building footprints', () => {
    const initial: WorldWalkState = { x: .8, y: 0, z: 0, yaw: 0, pitch: 0, wading: false };
    const right = { forward: false, backward: false, left: false, right: true, sprint: false };
    const collider = { id: 'house', x: 1.8, z: 0, width: 1, depth: 1, rotation: 0 };
    const blocked = stepWorldWalk(initial, right, .05, { size: 20, sample: () => flatSample(), colliders: [collider] });
    expect(blocked.x).toBe(initial.x);
    const cliff = stepWorldWalk({ ...initial, x: .45 }, right, .05, { size: 20, sample: x => flatSample(x > .5 ? 10 : 0), colliders: [] });
    expect(cliff.x).toBe(.45);
    const wet = stepWorldWalk({ ...initial, x: 0 }, right, .05, { size: 2, sample: () => flatSample(0, 1), colliders: [] });
    expect(wet.x).toBeLessThanOrEqual(.6); expect(wet.wading).toBe(true);
  });

  it('extends a tagged dry landing into a visible walkable pier over sampled water', () => {
    const coast=(x:number):WorldSample=>flatSample(x<12?2:-2,x<12?null:0);
    const quay:MapGuide={id:'harbor-quay',name:'harbor quay',points:[[0,0],[8,0]],curve:'polyline',closed:false,
      width:6.4,tags:['settlement','sea-landing','harbor-quay']};
    const street:MapGuide={...quay,id:'street',name:'street',points:[[0,10],[8,10]],tags:['settlement','street']};
    const extension=worldHarborQuayExtension(quay,(x)=>coast(x),500)!;
    expect(extension.from).toEqual([8,0]);
    expect(extension.to[0]).toBeGreaterThanOrEqual(22);
    expect(coast(extension.to[0]).waterLevel).toBe(0);
    expect(worldHarborQuayExtension({ ...quay, id: 'authored-pier', tags: ['world-route', 'pier'] },
      (x)=>coast(x),500)).toEqual(extension);
    expect(worldHarborQuayExtension(street,(x)=>coast(x),500)).toBeUndefined();
    expect(worldHarborQuayExtension(quay,()=>flatSample(2),500)).toBeUndefined();

    const built=buildWorldRoadChunk([quay,street],{x:0,z:0},(x)=>coast(x),500),positions=built.mesh!.geometry.getAttribute('position');
    const colors=built.mesh!.geometry.getAttribute('color');
    const tip=Array.from({length:positions.count},(_,index)=>index).sort((a,b)=>positions.getX(b)-positions.getX(a))[0];
    expect(positions.getX(tip)).toBeGreaterThanOrEqual(extension.to[0]);
    expect(positions.getY(tip)).toBeCloseTo(extension.height);
    expect(new Set(Array.from({length:colors.count},(_,index)=>colors.getX(index).toFixed(3))).size).toBe(2);

    const deckSample=(x:number,z:number)=>sampleWorldQuaySurface((worldX)=>coast(worldX),[extension],x,z);
    const walked=stepWorldWalk({x:18,y:extension.height,z:0,yaw:0,pitch:0,wading:false},
      {forward:false,backward:false,left:false,right:true,sprint:false},.05,{size:500,sample:deckSample,colliders:[]});
    expect(walked.x).toBeGreaterThan(18);
    expect(walked.y).toBeCloseTo(extension.height);
    expect(walked.wading).toBe(false);
    built.mesh!.geometry.dispose();
    (built.mesh!.material as THREE.Material).dispose();
  });

  it('builds a curved road mesh from the canonical sampled centerline', () => {
    const road:MapGuide={id:'curve',name:'curve',points:[[-20,0],[0,20],[20,0]],curve:'catmull-rom',closed:false,
      width:2,tags:['world-route']};
    const built=buildWorldRoadChunk([road],{x:-1,z:0},()=>flatSample(2),500);
    const positions=built.mesh!.geometry.getAttribute('position');
    const distanceToSegment=(x:number,z:number,a:[number,number],b:[number,number])=>{
      const dx=b[0]-a[0],dz=b[1]-a[1],length2=dx*dx+dz*dz;
      const t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/length2));
      return Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t);
    };
    const centers=Array.from({length:positions.count/2},(_,index)=>[
      (positions.getX(index*2)+positions.getX(index*2+1))/2,
      (positions.getZ(index*2)+positions.getZ(index*2+1))/2
    ] as [number,number]);
    expect(centers.some(([x,z])=>Math.min(distanceToSegment(x,z,[-20,0],[0,20]),
      distanceToSegment(x,z,[0,20],[20,0]))>.25)).toBe(true);
    built.mesh!.geometry.dispose();
    (built.mesh!.material as THREE.Material).dispose();
  });

  it('renders and walks on the same explicitly graded road surface', () => {
    const changed=structuredClone(bundle),route=changed.plan.roads[0];
    changed.plan.whitebox=true;changed.plan.generationPolicy='raw-first-call';
    changed.plan.featureGraph={regions:[],anchors:[],relations:[],paths:[{
      id:'graded-path',kind:'road',name:'Graded path',points:route.points,curve:route.curve,width:route.width
    }]};
    changed.plan.mobilityPlan={routes:[{id:route.id,pathId:'graded-path',mode:'cart road',connects:[],
      construction:{terrain:'grade',maxGrade:.18}}]};
    changed.patches=[];
    const checked=validateWorldBundle(changed),sample=createPlannedWorldSampler(checked.plan,checked.patches);
    const focus:[number,number]=[(route.points[0][0]+route.points[1][0])/2,(route.points[0][1]+route.points[1][1])/2];
    const built=buildWorldRoadChunk([route],{x:Math.floor(focus[0]/WORLD_CONTENT_CHUNK_SIZE),
      z:Math.floor(focus[1]/WORLD_CONTENT_CHUNK_SIZE)},sample,checked.plan.recipe.size);
    const positions=built.mesh!.geometry.getAttribute('position');
    for(let index=0;index<positions.count;index++)expect(positions.getY(index))
      .toBeCloseTo(sample(positions.getX(index),positions.getZ(index)).height+1.2,4);
    const view=new WorldContentView();view.reset(checked,sample);
    const point=route.points[0],surface=view.sampleSurface(point[0],point[1]);
    expect(surface).toEqual(sample(point[0],point[1]));
    view.dispose();built.mesh!.geometry.dispose();(built.mesh!.material as THREE.Material).dispose();
  });
});
