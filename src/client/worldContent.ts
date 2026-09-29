import * as THREE from 'three';
import type { WorldRecipe, WorldSample } from '../shared/worldTerrain';
import { ECOLOGY_CHUNK_SIZE, selectEcologyChunks, type EcologyRule, type EcologyInstance } from '../shared/worldEcology';
import { worldRoadSampleSpacing, type WorldBundle } from '../shared/worldPlanning';
import type { MapGuide } from '../shared/mapGuide';
import {
  buildWorldAssetBuildingPlacements, buildWorldAssetBuildings, pickWorldAsset, pickWorldEcologyAsset,
  worldAssetBuildingMatrix, type WorldAssetLibrary, type WorldBuildingPlacement
} from './worldAssets';
import { createCollisionMeshInstance, MeshCollisionWorld } from './mapMeshCollision';

export const DEFAULT_ECOLOGY_RULES: EcologyRule[] = [
  { id: 'forest-canopy', kind: 'broadleaf', biome: 'forest', density: 0.95, spacing: 18, maxSlope: 32, scale: [0.8, 1.6] },
  { id: 'forest-pine', kind: 'pine', biome: 'forest', density: 0.6, spacing: 22, maxSlope: 38, scale: [0.9, 1.5] },
  { id: 'meadow-trees', kind: 'broadleaf', biome: 'grassland', density: 0.10, spacing: 26, maxSlope: 25, scale: [0.65, 1.2] },
  { id: 'meadow-shrub', kind: 'shrub', biome: 'grassland', density: 0.4, spacing: 12, maxSlope: 38, scale: [0.7, 1.8] },
  { id: 'desert-scrub', kind: 'shrub', biome: 'desert', density: 0.2, spacing: 16, maxSlope: 28, scale: [0.5, 1.2] },
  { id: 'mountain-rock', kind: 'rock', biome: 'mountains', density: 0.5, spacing: 25, maxSlope: 55, scale: [1, 3] }
];

type Prototype = { geometry: THREE.BufferGeometry; material: THREE.Material; y: number; scale: [number, number, number] };
const foliage = new THREE.MeshStandardMaterial({ color: '#42643c', roughness: 1 });
const pine = new THREE.MeshStandardMaterial({ color: '#294c40', roughness: 1 });
const trunk = new THREE.MeshStandardMaterial({ color: '#67503b', roughness: 1 });
const shrub = new THREE.MeshStandardMaterial({ color: '#8b8957', roughness: 1 });
const stone = new THREE.MeshStandardMaterial({ color: '#898882', roughness: 1 });
const stem = new THREE.CylinderGeometry(0.25, 0.45, 7, 5);
const crown = new THREE.IcosahedronGeometry(1, 1), simpleCrown = new THREE.IcosahedronGeometry(1, 0);
const cone = new THREE.ConeGeometry(1, 1, 8), simpleCone = new THREE.ConeGeometry(1, 1, 4);
const prototypes = (kind: EcologyInstance['kind'], coarse: boolean): Prototype[] => {
  if (kind === 'shrub') return [{ geometry: simpleCrown, material: shrub, y: 1.0, scale: [1.7, 1.3, 1.7] }];
  if (kind === 'rock') return [{ geometry: simpleCrown, material: stone, y: 0.6, scale: [1.5, 1, 1.3] }];
  const leaf = kind === 'pine'
    ? { geometry: coarse ? simpleCone : cone, material: pine, y: 8, scale: [3.8, 13, 3.8] as [number, number, number] }
    : { geometry: coarse ? simpleCrown : crown, material: foliage, y: 10, scale: [5.2, 5.5, 5.2] as [number, number, number] };
  return coarse ? [leaf] : [{ geometry: stem, material: trunk, y: 3.5, scale: [1, 1, 1] }, leaf];
};

/** Fixed ecology cells, independent of changing terrain quadtree nodes. */
export class WorldEcologyView {
  readonly root = new THREE.Group();
  private worker?: Worker;
  private desired: ReturnType<typeof selectEcologyChunks> = [];
  private cache = new Map<string, { root: THREE.Group; count: number; near: THREE.Group; far: THREE.Group; coarse: boolean }>();
  private busy = false;
  private stopped = false;
  private recipe?: WorldRecipe;
  private times: number[] = [];
  private key = (p: { x: number; z: number }) => p.x + ':' + p.z;
  error = '';
  reset(recipe: WorldRecipe, rules: EcologyRule[], bundle?: WorldBundle, assets?: WorldAssetLibrary) {
    this.worker?.terminate();
    for (const chunk of this.cache.values()) this.disposeChunk(chunk.root);
    this.root.clear(); this.cache.clear(); this.desired = []; this.busy = false; this.times = []; this.error = ''; this.stopped = false;
    this.recipe = recipe;
    this.worker = new Worker(new URL('./terrainBiomeWorker.ts', import.meta.url), { type: 'module' });
    this.worker.postMessage({ kind: 'configure', recipe, rules, bundle });
    this.worker.onerror = event => { this.busy = false; this.stopped = true; this.error = event.message; };
    this.worker.onmessage = event => {
      this.busy = false;
      if (event.data.kind === 'error') { this.error = event.data.message; this.stopped = true; return; }
      const chunk = this.desired.find(p => this.key(p) === event.data.key);
      if (chunk && !this.cache.has(event.data.key)) {
        const instances = event.data.data.instances as EcologyInstance[];
        const root = new THREE.Group(), near = new THREE.Group(), far = new THREE.Group();
        root.position.set(chunk.x * ECOLOGY_CHUNK_SIZE, 0, chunk.z * ECOLOGY_CHUNK_SIZE);
        const groups = new Map(instances.map(instance => [`${instance.ruleId}:${instance.kind}`, instance] as const));
        for (const coarse of [false, true]) for (const representative of groups.values()) {
          const kind = representative.kind;
          const entries = instances.filter(i => i.ruleId === representative.ruleId && i.kind === kind);
          if (!entries.length) continue;
          const tree = assets ? pickWorldEcologyAsset(assets, representative) : undefined;
          const scale = tree ? 9 / Math.max(tree.size.x, tree.size.z) : 1;
          const shapes: Prototype[] = tree && !coarse ? [{geometry:tree.geometry,material:tree.material,y:0,scale:[scale,scale,scale]}] : prototypes(kind, coarse);
          for (const p of shapes) {
            const mesh = new THREE.InstancedMesh(p.geometry, p.material, entries.length);
            const matrix = new THREE.Object3D();
            entries.forEach((i, index) => {
              matrix.position.set(i.x - root.position.x, i.y + p.y * i.scale, i.z - root.position.z);
              matrix.rotation.set(0, i.rotation, 0);
              matrix.scale.set(p.scale[0] * i.scale, p.scale[1] * i.scale, p.scale[2] * i.scale);
              matrix.updateMatrix(); mesh.setMatrixAt(index, matrix.matrix);
            });
            mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); mesh.castShadow = true; mesh.receiveShadow = true;
            (coarse ? far : near).add(mesh);
          }
        }
        far.visible = false; root.add(near, far);
        this.cache.set(event.data.key, { root, near, far, count: instances.length, coarse: false });
        this.times.push(event.data.ms); if (this.times.length > 200) this.times.shift();
      }
      this.pump();
    };
  }
  update(focus: THREE.Vector3, camera: THREE.Vector3) {
    if (!this.recipe) return;
    // 300 m hysteresis at the overview transition.
    const distance = camera.distanceTo(focus);
    const range = this.desired.length && distance < 3300 ? Math.min(distance, 3000) : distance;
    this.desired = selectEcologyChunks(this.recipe.size, focus.x, focus.z, range);
    this.root.visible = this.desired.length > 0;
    const wanted = new Set(this.desired.map(this.key));
    this.root.clear();
    for (const [key, chunk] of this.cache) {
      if (!wanted.has(key)) continue;
      const distanceXZ = Math.hypot(chunk.root.position.x + 128 - camera.x, chunk.root.position.z + 128 - camera.z);
      chunk.coarse = chunk.coarse ? distanceXZ > 650 : distanceXZ > 850;
      chunk.near.visible = !chunk.coarse; chunk.far.visible = chunk.coarse;
      this.root.add(chunk.root);
    }
    this.pump();
  }
  private pump() {
    this.prune();
    if (this.stopped || this.busy || !this.worker) return;
    const next = this.desired.find(p => !this.cache.has(this.key(p)));
    if (next) { this.busy = true; this.worker.postMessage({ kind: 'ecology', key: this.key(next), chunk: next }); return; }
  }
  private prune() {
    const wanted = new Set(this.desired.map(this.key));
    for (const [key, chunk] of this.cache) {
      if (this.cache.size <= 49) break;
      if (!wanted.has(key)) { this.root.remove(chunk.root); this.disposeChunk(chunk.root); this.cache.delete(key); }
    }
  }
  metrics() {
    const active = this.desired.map(p => this.cache.get(this.key(p))).filter(p => !!p);
    const times = [...this.times].sort((a,b) => a-b);
    return { ecologyChunks: active.length, ecologyDesired: this.desired.length, ecologyCache: this.cache.size,
      ecologyInstances: active.reduce((s, c) => s + c!.count, 0), ecologyReady: !this.busy && active.length === this.desired.length,
      ecologyP95Ms: times[Math.floor((times.length - 1) * 0.95)] ?? 0, ecologyError: this.error };
  }
  private disposeChunk(root: THREE.Group) { root.traverse(child => { if (child instanceof THREE.InstancedMesh) child.dispose(); }); }
  dispose() { this.worker?.terminate(); for (const c of this.cache.values()) this.disposeChunk(c.root); this.cache.clear(); this.root.clear(); }
}

export const WORLD_CONTENT_CHUNK_SIZE = ECOLOGY_CHUNK_SIZE;
export interface WorldContentChunk { x: number; z: number }
export interface WorldBuildingCollider {
  id: string; x: number; z: number; width: number; depth: number; rotation: number;
}

const contentKey = (chunk: WorldContentChunk) => chunk.x + ':' + chunk.z;

/** The same bounded 5x5 residency window as ecology, with stable world-space chunk identities. */
export function selectWorldContentChunks(worldSize: number, focusX: number, focusZ: number, distance: number): WorldContentChunk[] {
  return selectEcologyChunks(worldSize, focusX, focusZ, distance);
}

function worldBuildingPlacements(bundle: WorldBundle): WorldBuildingPlacement[] {
  return bundle.patches.flatMap(patch => {
    const town = bundle.plan.towns.find(candidate => candidate.id === patch.townId)!;
    return patch.buildings.map(building => ({
      ...building, x: building.x + town.center[0], z: building.z + town.center[1], townId: town.id
    }));
  });
}

function worldRoads(bundle: WorldBundle): MapGuide[] {
  const roads = [...bundle.plan.roads];
  for (const patch of bundle.patches) {
    const town = bundle.plan.towns.find(candidate => candidate.id === patch.townId)!;
    roads.push(...patch.streets.map(road => ({
      ...road, points: road.points.map(([x, z]): [number, number] => [x + town.center[0], z + town.center[1]])
    })));
  }
  return roads;
}

function clipSegment(
  a: [number, number], b: [number, number], minX: number, minZ: number, maxX: number, maxZ: number
): [[number, number], [number, number]] | null {
  const dx = b[0] - a[0], dz = b[1] - a[1]; let low = 0, high = 1;
  for (const [p, q] of [[-dx, a[0] - minX], [dx, maxX - a[0]], [-dz, a[1] - minZ], [dz, maxZ - a[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const ratio = q / p;
    if (p < 0) low = Math.max(low, ratio); else high = Math.min(high, ratio);
    if (low > high) return null;
  }
  return [[a[0] + dx * low, a[1] + dz * low], [a[0] + dx * high, a[1] + dz * high]];
}

function buildRoadChunk(
  roads: MapGuide[], chunk: WorldContentChunk, sample: (x: number, z: number) => WorldSample, worldSize: number
): { mesh?: THREE.Mesh; triangles: number } {
  const positions: number[] = [], indices: number[] = [];
  const minX = chunk.x * WORLD_CONTENT_CHUNK_SIZE, minZ = chunk.z * WORLD_CONTENT_CHUNK_SIZE;
  const maxX = minX + WORLD_CONTENT_CHUNK_SIZE, maxZ = minZ + WORLD_CONTENT_CHUNK_SIZE;
  const spacing = worldRoadSampleSpacing(worldSize), lift = worldSize < 2000 ? .12 : 1.2;
  for (const road of roads) {
    const points = road.closed ? [...road.points, road.points[0]] : road.points;
    for (let i = 1; i < points.length; i++) {
      const pad = road.width / 2;
      const clipped = clipSegment(points[i - 1], points[i], minX - pad, minZ - pad, maxX + pad, maxZ + pad);
      if (!clipped) continue;
      const [[ax, az], [bx, bz]] = clipped, length = Math.hypot(bx - ax, bz - az);
      if (length < 1e-6) continue;
      const steps = Math.max(1, Math.ceil(length / spacing)), offsetX = (bz - az) / length * pad, offsetZ = (ax - bx) / length * pad;
      const start = positions.length / 3;
      for (let step = 0; step <= steps; step++) {
        const x = ax + (bx - ax) * step / steps, z = az + (bz - az) * step / steps;
        for (const sign of [-1, 1]) {
          const px = x + offsetX * sign, pz = z + offsetZ * sign;
          positions.push(px, sample(px, pz).height + lift, pz);
        }
        if (step) { const next = start + step * 2; indices.push(next - 2, next - 1, next, next, next - 1, next + 1); }
      }
    }
  }
  if (!indices.length) return { triangles: 0 };
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices);
  geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#a78d67', roughness: 1, side: THREE.DoubleSide }));
  mesh.receiveShadow = true; return { mesh, triangles: indices.length / 3 };
}

function buildFallbackBuildings(placements: WorldBuildingPlacement[], sample: (x: number, z: number) => WorldSample): THREE.Group {
  const root = new THREE.Group();
  if (!placements.length) return root;
  const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#b4a887', roughness: 1 }), placements.length);
  const roofs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#675b4b', roughness: 1 }), placements.length);
  const matrix = new THREE.Object3D();
  placements.forEach((building, index) => {
    const y = sample(building.x, building.z).height; matrix.rotation.y = building.rotation ?? 0;
    matrix.position.set(building.x, y + building.height / 2, building.z); matrix.scale.set(building.width, building.height, building.depth); matrix.updateMatrix(); walls.setMatrixAt(index, matrix.matrix);
    matrix.position.y = y + building.height + .7; matrix.scale.set(building.width + 1.2, 1.4, building.depth + 1.2); matrix.updateMatrix(); roofs.setMatrixAt(index, matrix.matrix);
  });
  walls.instanceMatrix.needsUpdate = true; roofs.instanceMatrix.needsUpdate = true;
  walls.computeBoundingSphere(); roofs.computeBoundingSphere(); root.add(walls, roofs); return root;
}

interface ActiveContentChunk {
  root: THREE.Group; placements: WorldBuildingPlacement[]; buildingCount: number; roadTriangles: number;
}

/** GPU content exists only for the current fixed chunk window; inactive chunks are disposed, not hidden. */
export class WorldContentView {
  readonly root = new THREE.Group();
  private bundle?: WorldBundle;
  private sample?: (x: number, z: number) => WorldSample;
  private assets?: WorldAssetLibrary;
  private readonly active = new Map<string, ActiveContentChunk>();
  private placements: WorldBuildingPlacement[] = [];
  private roads: MapGuide[] = [];
  private desired: WorldContentChunk[] = [];
  private meshCollision = new MeshCollisionWorld();

  reset(bundle: WorldBundle, sample: (x: number, z: number) => WorldSample, assets?: WorldAssetLibrary): void {
    this.clear(); this.bundle = bundle; this.sample = sample; this.assets = assets;
    this.placements = worldBuildingPlacements(bundle); this.roads = worldRoads(bundle);
  }

  update(focus: THREE.Vector3, camera: THREE.Vector3): void {
    if (!this.bundle || !this.sample) return;
    this.desired = selectWorldContentChunks(this.bundle.plan.recipe.size, focus.x, focus.z, camera.distanceTo(focus));
    const wanted = new Set(this.desired.map(contentKey)); let changed = false;
    for (const [key, chunk] of this.active) {
      if (wanted.has(key)) continue;
      this.root.remove(chunk.root); disposeWorldStructures(chunk.root); this.active.delete(key); changed = true;
    }
    for (const chunk of this.desired) {
      const key = contentKey(chunk); if (this.active.has(key)) continue;
      const built = this.buildChunk(chunk); this.active.set(key, built); this.root.add(built.root); changed = true;
    }
    if (changed) this.rebuildCollision();
  }

  get colliders(): WorldBuildingCollider[] {
    return [...this.active.values()].flatMap(chunk => chunk.placements
      .filter(building => !building.enterable)
      .map(building => ({ id: building.id, x: building.x, z: building.z, width: building.width, depth: building.depth, rotation: building.rotation ?? 0 })));
  }

  get collisionWorld(): MeshCollisionWorld { return this.meshCollision; }

  metrics() {
    const chunks = [...this.active.values()];
    return { contentChunks: chunks.length, contentDesired: this.desired.length,
      contentBuildings: chunks.reduce((sum, chunk) => sum + chunk.buildingCount, 0),
      contentRoadTriangles: chunks.reduce((sum, chunk) => sum + chunk.roadTriangles, 0),
      contentMeshColliders: this.meshCollision.instances.length };
  }

  dispose(): void { this.clear(); this.bundle = undefined; this.sample = undefined; this.assets = undefined; }

  private buildChunk(chunk: WorldContentChunk): ActiveContentChunk {
    const root = new THREE.Group(), minX = chunk.x * WORLD_CONTENT_CHUNK_SIZE, minZ = chunk.z * WORLD_CONTENT_CHUNK_SIZE;
    const placements = this.placements.filter(building => building.x >= minX && building.x < minX + WORLD_CONTENT_CHUNK_SIZE
      && building.z >= minZ && building.z < minZ + WORLD_CONTENT_CHUNK_SIZE);
    if (this.assets) root.add(buildWorldAssetBuildingPlacements(placements, this.sample!, this.assets));
    const fallback = this.assets ? placements.filter(building => !pickWorldAsset(this.assets!, building)) : placements;
    root.add(buildFallbackBuildings(fallback, this.sample!));
    const road = buildRoadChunk(this.roads, chunk, this.sample!, this.bundle!.plan.recipe.size);
    if (road.mesh) root.add(road.mesh);
    return { root, placements, buildingCount: placements.length, roadTriangles: road.triangles };
  }

  private rebuildCollision(): void {
    this.meshCollision.dispose();
    if (!this.assets || !this.sample) { this.meshCollision = new MeshCollisionWorld(); return; }
    const instances = [...this.active.values()].flatMap(chunk => chunk.placements.flatMap(building => {
      if (!building.enterable) return [];
      const model = pickWorldAsset(this.assets!, building); if (!model) return [];
      return [createCollisionMeshInstance('world:' + building.id, 'scene', model.geometry,
        worldAssetBuildingMatrix(building, this.sample!, model).clone())];
    }));
    this.meshCollision = new MeshCollisionWorld(instances);
  }

  private clear(): void {
    this.meshCollision.dispose(); this.meshCollision = new MeshCollisionWorld();
    for (const chunk of this.active.values()) disposeWorldStructures(chunk.root);
    this.active.clear(); this.root.clear(); this.desired = []; this.placements = []; this.roads = [];
  }
}

export function buildWorldStructures(bundle: WorldBundle, sample: (x: number, z: number) => WorldSample, assets?: WorldAssetLibrary): THREE.Group {
  const root = new THREE.Group();
  if (assets) root.add(buildWorldAssetBuildings(bundle,sample,assets));
  const roads: MapGuide[] = [...bundle.plan.roads];
  for (const patch of bundle.patches) {
    const town = bundle.plan.towns.find(t => t.id === patch.townId)!;
    roads.push(...patch.streets.map(r => ({ ...r, points: r.points.map(([x,z]): [number,number] => [x+town.center[0],z+town.center[1]]) })));
    if (assets) continue;
    const buildings = new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({
      color: patch.townId === 'oasis' ? '#d5b888' : '#b4a887', roughness: 1
    }), patch.buildings.length);
    const roofs = new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({
      color: patch.townId === 'oasis' ? '#ae8357' : '#675b4b', roughness: 1
    }), patch.buildings.length);
    const matrix = new THREE.Object3D();
    patch.buildings.forEach((b, i) => {
      const x = town.center[0] + b.x, z = town.center[1] + b.z, y = sample(x,z).height;
      matrix.rotation.y = b.rotation ?? 0;
      matrix.position.set(x, y+b.height/2, z); matrix.scale.set(b.width,b.height,b.depth); matrix.updateMatrix(); buildings.setMatrixAt(i,matrix.matrix);
      matrix.position.y = y+b.height+0.7; matrix.scale.set(b.width+1.2,1.4,b.depth+1.2); matrix.updateMatrix(); roofs.setMatrixAt(i,matrix.matrix);
    });
    buildings.instanceMatrix.needsUpdate = true; roofs.instanceMatrix.needsUpdate = true;
    buildings.computeBoundingSphere(); roofs.computeBoundingSphere(); root.add(buildings,roofs);
  }
  const positions: number[] = [], indices: number[] = [];
  const spacing = worldRoadSampleSpacing(bundle.plan.recipe.size), lift = bundle.plan.recipe.size < 2000 ? 0.12 : 1.2;
  for (const road of roads) {
    const points = road.closed ? [...road.points,road.points[0]] : road.points;
    for (let i = 1; i < points.length; i++) {
    const [ax,az] = points[i-1], [bx,bz] = points[i];
    const length = Math.hypot(bx-ax,bz-az);
    const steps = Math.max(1,Math.ceil(length/spacing)), dx = (bz-az)/length*road.width/2, dz = (ax-bx)/length*road.width/2;
    const start = positions.length/3;
    for (let j = 0; j <= steps; j++) {
      const x = ax+(bx-ax)*j/steps,z = az+(bz-az)*j/steps;
      for (const sign of [-1,1]) { const px=x+dx*sign,pz=z+dz*sign; positions.push(px,sample(px,pz).height+lift,pz); }
      if (j) { const n=start+j*2; indices.push(n-2,n-1,n,n,n-1,n+1); }
    }
  }
    // Small round joins close ribbon corners without adding draw calls.
    for (const [x,z] of road.points) {
      const start=positions.length/3; positions.push(x,sample(x,z).height+lift+.01,z);
      for(let i=0;i<=8;i++) { const px=x+Math.cos(i*Math.PI/4)*road.width/2,pz=z+Math.sin(i*Math.PI/4)*road.width/2;positions.push(px,sample(px,pz).height+lift+.01,pz);if(i)indices.push(start,start+i,start+i+1); }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3)); geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  const surface=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:'#a78d67',roughness:1,side:THREE.DoubleSide}));
  surface.receiveShadow=true;root.add(surface);
  return root;
}

export function disposeWorldStructures(root: THREE.Group) {
  root.traverse(child => {
    if (child instanceof THREE.Mesh && !child.userData.sharedWorldAsset) { child.geometry.dispose(); for (const m of Array.isArray(child.material) ? child.material : [child.material]) m.dispose(); }
    if (child instanceof THREE.InstancedMesh) child.dispose();
  });
  root.clear();
}
