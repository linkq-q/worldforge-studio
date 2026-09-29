import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildEditableMapGroup } from '../src/client/mapRenderer';
import { createEmptyMap } from '../src/shared/map';
import { createPlannedWorldSampler, validateWorldBundle } from '../src/shared/worldPlanning';

Object.defineProperty(globalThis, 'document', {
  value: { createElement: () => ({ width: 0, height: 0, getContext: () => null }) },
  configurable: true
});

const bundle = validateWorldBundle(JSON.parse(readFileSync(
  new URL('./fixtures/hierarchical-world.json', import.meta.url), 'utf8'
).replace(/^\uFEFF/, '')));
const town = bundle.plan.towns[0];
const sample = createPlannedWorldSampler(bundle.plan, bundle.patches);
const map = createEmptyMap();
map.world = { bundle, assets: [] };
map.box.size = [bundle.plan.recipe.size, 4096, bundle.plan.recipe.size];
map.spawnPoints = [[town.center[0], sample(...town.center).height, town.center[1]]];

const startedAt = performance.now();
const rendered = await buildEditableMapGroup(map);
const initialBuildMs = performance.now() - startedAt;
const initial = rendered.getDebugStats().streaming!;
await new Promise(resolve => setTimeout(resolve, 0));
for (let attempt = 0; attempt < 600; attempt += 1) {
  const streaming = rendered.getDebugStats().streaming!;
  if (streaming.pendingTiles === 0 && streaming.contentChunks > initial.contentChunks) break;
  await new Promise(resolve => setTimeout(resolve, 10));
  if (attempt === 599) throw new Error('streaming_timeout');
}
const settled = rendered.getDebugStats().streaming!;

const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 100_000);
const target = new THREE.Vector3(town.center[0], sample(...town.center).height, town.center[1]);
const frameTimes: number[] = [];
for (let frame = 0; frame < 1_200; frame += 1) {
  const angle = frame / 1_200 * Math.PI * 2;
  camera.position.set(target.x + Math.cos(angle) * 600, target.y + 300, target.z + Math.sin(angle) * 600);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  const frameStartedAt = performance.now();
  rendered.update(1 / 60, camera, 3_000);
  frameTimes.push(performance.now() - frameStartedAt);
}
frameTimes.sort((a, b) => a - b);
await Promise.resolve();
const final = rendered.getDebugStats().streaming!;
console.log(JSON.stringify({
  note: 'Node CPU timing of the actual editor streamed renderer; excludes WebGL/GPU frame time.',
  initialBuildMs,
  initialTerrainTiles: initial.terrainTiles,
  initialContentChunks: initial.contentChunks,
  initialBuildings: initial.buildings,
  initialEcologyInstances: initial.ecologyInstances,
  settledTerrainTiles: settled.terrainTiles,
  settledContentChunks: settled.contentChunks,
  rotationUpdateP50Ms: frameTimes[Math.floor(frameTimes.length * 0.5)],
  rotationUpdateP95Ms: frameTimes[Math.floor(frameTimes.length * 0.95)],
  unloadedTilesDuringRotation: final.unloadedTiles - settled.unloadedTiles
}, null, 2));
rendered.dispose();
