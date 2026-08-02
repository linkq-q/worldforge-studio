import assert from 'node:assert/strict';
import {
  bakeMapCollisions,
  createEmptyMap,
  findSafeSpawnPosition,
  movePlayerPositionForMap,
  sampleTerrainHeight
} from '../dist-map-core/index.js';

// The point of this check is packaging, not logic: it fails if the bundle stops
// being runnable by bare Node ESM (extensionless imports, browser-only globals,
// an accidental `three` import). Run by `npm run build:map-core`.

const map = createEmptyMap('smoke');
assert.equal(typeof sampleTerrainHeight(map, 0, 0), 'number');

const [spawnX, spawnZ] = findSafeSpawnPosition(map, 0, 0);
const spawn = [spawnX, sampleTerrainHeight(map, spawnX, spawnZ), spawnZ];

const obstacles = bakeMapCollisions(map);
assert.ok(Array.isArray(obstacles.boxes), 'collision bake has no boxes');

const moved = movePlayerPositionForMap(spawn, [1, 0, 0], map, obstacles);
assert.equal(moved.length, 3, 'movePlayerPositionForMap is not a 3-vector');
assert.ok(moved.every(Number.isFinite), 'movePlayerPositionForMap returned NaN');

console.log('map-core smoke ok');
