import * as THREE from 'three';
import type { WorldRecipe, WorldSample } from '../shared/worldTerrain';
import { ECOLOGY_CHUNK_SIZE, selectEcologyChunks, type EcologyRule, type EcologyInstance } from '../shared/worldEcology';
import { worldRoadSampleSpacing, type WorldBundle } from '../shared/worldPlanning';
import type { MapGuide } from '../shared/mapGuide';
import { buildWorldAssetBuildings, type WorldAssetLibrary } from './worldAssets';

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
        for (const coarse of [false, true]) for (const kind of ['broadleaf', 'pine', 'shrub', 'rock'] as const) {
          const entries = instances.filter(i => i.kind === kind);
          if (!entries.length) continue;
          const tree = assets && (kind === 'broadleaf' || kind === 'pine') ? assets.tree : undefined;
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

