import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildWorldRoadChunk, sampleWorldQuaySurface, WorldContentView, worldHarborQuayExtension,
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
});
