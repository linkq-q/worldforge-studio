import * as THREE from 'three';
import { buildWorldAssetLibrary, disposeWorldAssetLibrary, type WorldAssetLibrary } from './worldAssets';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEFAULT_ECOLOGY_RULES, WorldEcologyView, buildWorldStructures, disposeWorldStructures } from './worldContent';
import { createPlannedWorldSampler, createTownTasks, validateWorldBundle, validateWorldPlan, mergeTownPatch, type WorldBundle, type WorldPlan, type TownPatch } from '../shared/worldPlanning';
import { BIOME_LABELS, REGION_LABELS, WORLD_BIOMES, createWorldSampler, dominantBiome, parseWorldPrompt, selectWorldTiles, type WorldRecipe, type WorldTile, type WorldTileData } from '../shared/worldTerrain';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>('world');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor('#90b3bd');
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight('#e5f3ff', '#67664a', 2));
const sun = new THREE.DirectionalLight('#fff0da', 2.5);
sun.position.set(-18000, 30000, 12000); scene.add(sun);
const camera = new THREE.PerspectiveCamera(43, canvas.clientWidth / canvas.clientHeight, 5, 1000000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.1;
controls.minDistance = 80; controls.maxPolarAngle = Math.PI * 0.485;
const landMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98 });
const terrainRoot = new THREE.Group(); scene.add(terrainRoot);
const waterMaterial = new THREE.MeshStandardMaterial({ color: '#287f97', roughness: 0.3, metalness: 0.12, transparent: true, opacity: 0.88, side: THREE.DoubleSide });
const sea = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), waterMaterial);
sea.rotation.x = -Math.PI / 2; sea.position.y = 0; scene.add(sea);
const colors = ['#286780', '#939858', '#335d3c', '#d8b879', '#858379', '#e5ebdf'].map(c => new THREE.Color(c));
const sand = new THREE.Color('#c7b98a'), rock = new THREE.Color('#7f7d73');
const cssColors = ['#286780', '#939858', '#335d3c', '#d8b879', '#858379', '#e5ebdf'];
element('legend').innerHTML = WORLD_BIOMES.map((b, i) => '<span><i class="dot" style="background:' + cssColors[i] + '"></i>' + BIOME_LABELS[b] + '</span>').join('');
const ecology = new WorldEcologyView(); scene.add(ecology.root);
let structures = new THREE.Group(); scene.add(structures);
let bundle: WorldBundle | undefined;
let assetLibrary: WorldAssetLibrary | undefined;
let assetLoadMs=0;
let forestPoint: [number, number] = [0, 20000];
let recipe: WorldRecipe;
let sample: ReturnType<typeof createWorldSampler>;
let worker: Worker;
let busy = false;
let desired: WorldTile[] = [];
let active: THREE.Mesh[] = [];
const cache = new Map<string, THREE.Mesh>();
const tileTimes: number[] = [];
const frameTimes: number[] = [];
let started = 0, firstReadyMs = 0, exaggeration = 1, generation = 0, renderedGeneration = -1;
let lastLod = 0, lodDirty = true;
let atlasImage: ImageData | undefined;
let surveyRunning = false;
const keyOf = (tile: WorldTile) => [tile.x, tile.z, tile.size].join(':');
let lastError = '';
function showError(error: unknown) {
  lastError = error instanceof Error ? error.message : String(error);
  const messages:Record<string,string> = {world_stale_patch:'这个城镇任务来自旧的世界计划，请重新导出任务后再规划。',world_building_outside:'建筑越出了所属城镇的边界，请修改该城镇计划。',world_buildings_overlap:'城镇中有建筑占地重叠，请调整布局。',world_building_intersects_street:'建筑占用了道路，请调整建筑或街道位置。',world_streets_disconnected:'城镇路网没有连通，请在连接处使用共同的道路顶点。',world_road_geometry_quota:'道路细分超过本轮预览预算，请简化过密或重复的道路。'};
  element('error').textContent = messages[lastError] ?? lastError;
}
function makeMesh(tile: WorldTile, data: WorldTileData): THREE.Mesh {
  const n = data.resolution, gridCount = n * n, edgeCount = (n - 1) * 4;
  const positions = new Float32Array((gridCount + edgeCount) * 3);
  const normals = new Float32Array(positions.length);
  const vertexColors = new Float32Array(positions.length);
  const c = new THREE.Color();
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const i = z * n + x;
    positions.set([x * tile.size / (n - 1), data.heights[i], z * tile.size / (n - 1)], i * 3);
    normals.set(data.normals.subarray(i * 3, i * 3 + 3), i * 3);
    c.setRGB(0, 0, 0);
    WORLD_BIOMES.forEach((_, b) => { const w = data.weights[i * 6 + b]; c.r += colors[b].r * w; c.g += colors[b].g * w; c.b += colors[b].b * w; });
    const beach = Math.max(0, 1 - Math.abs(data.heights[i] - 4) / 22);
    c.lerp(sand, beach * 0.85);
    const slope = 1 - data.normals[i * 3 + 1];
    c.lerp(rock, Math.min(0.7, Math.max(0, slope - 0.08) * 1.8));
    vertexColors.set([c.r, c.g, c.b], i * 3);
  }
  const indices: number[] = [];
  for (let z = 0; z < n - 1; z++) for (let x = 0; x < n - 1; x++) {
    const i = z * n + x;
    indices.push(i, i + n, i + 1, i + 1, i + n, i + n + 1);
  }
  const edges: number[] = [];
  for (let x = 0; x < n - 1; x++) edges.push(x);
  for (let z = 0; z < n - 1; z++) edges.push(z * n + n - 1);
  for (let x = n - 1; x > 0; x--) edges.push((n - 1) * n + x);
  for (let z = n - 1; z > 0; z--) edges.push(z * n);
  // ponytail: skirts hide mixed-LOD T-junctions; production needs edge stitching and geomorphing.
  for (let j = 0; j < edges.length; j++) {
    const source = edges[j], dest = gridCount + j;
    positions.set(positions.subarray(source * 3, source * 3 + 3), dest * 3);
    positions[dest * 3 + 1] -= recipe.size < 2000 ? Math.max(0.5,tile.size*0.015) : Math.max(50, tile.size * 0.15);
    normals.set(normals.subarray(source * 3, source * 3 + 3), dest * 3);
    vertexColors.set(vertexColors.subarray(source * 3, source * 3 + 3), dest * 3);
    const next = (j + 1) % edges.length;
    indices.push(source, dest, edges[next], edges[next], dest, gridCount + next);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3));
  geometry.setIndex(indices); geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, landMaterial);
  mesh.position.set(tile.x, 0, tile.z);
  mesh.userData.tile = tile;
  mesh.receiveShadow=true;
  return mesh;
}
function pump() {
  if (busy || !recipe) return;
  const next = desired.find(tile => !cache.has(keyOf(tile)));
  if (next) {
    busy = true;
    worker.postMessage({ kind: 'tile', tile: next, key: keyOf(next) });
    return;
  }
  // Swap only complete coverings: a cancelled/obsolete worker result never leaves a hole.
  for (const mesh of active) terrainRoot.remove(mesh);
  active = desired.map(tile => cache.get(keyOf(tile))!);
  active.forEach(mesh => terrainRoot.add(mesh));
  if (renderedGeneration !== generation) {
    renderedGeneration = generation;
    firstReadyMs = performance.now() - started;
  }
  const keep = new Set(active);
  for (const [key, mesh] of cache) {
    if (cache.size <= 384) break;
    if (!keep.has(mesh)) { mesh.geometry.dispose(); cache.delete(key); }
  }
  element('progress').textContent = '已就绪 · 点击左侧群落图探索局部';
}
function updateCameraClip() {
  if (!recipe) return;
  const distance = camera.position.distanceTo(controls.target);
  const near = Math.max(1, distance * 0.005);
  const far = Math.max(recipe.size * 2, distance + recipe.size * 1.5);
  if (Math.abs(camera.near - near) > near * 0.01 || Math.abs(camera.far - far) > far * 0.01) {
    camera.near = near; camera.far = far; camera.updateProjectionMatrix();
  }
}
function updateLod() {
  updateCameraClip();
  if (!recipe) return;
  const distance = camera.position.distanceTo(controls.target);
  desired = selectWorldTiles(recipe.size, controls.target.x, controls.target.z, distance)
    .sort((a, b) => Math.hypot(a.x + a.size / 2 - controls.target.x, a.z + a.size / 2 - controls.target.z)
      - Math.hypot(b.x + b.size / 2 - controls.target.x, b.z + b.size / 2 - controls.target.z));
  lastLod = performance.now(); lodDirty = false;
  pump(); ecology.update(controls.target, camera.position);
}
function atlasDraw(data: { resolution: number; heights: Float32Array; weights: Float32Array; counts: Record<string, number>; min: number; max: number }) {
  const atlas = element<HTMLCanvasElement>('atlas');
  atlas.width = data.resolution; atlas.height = data.resolution;
  const ctx = atlas.getContext('2d')!;
  const image = ctx.createImageData(data.resolution, data.resolution);
  const color = new THREE.Color();
  for (let i = 0; i < data.heights.length; i++) {
    color.setRGB(0, 0, 0);
    WORLD_BIOMES.forEach((_, b) => {
      const w = data.weights[i * 6 + b]; color.r += colors[b].r * w; color.g += colors[b].g * w; color.b += colors[b].b * w;
    });
    const x = i % data.resolution, z = Math.floor(i / data.resolution);
    if (x > 0 && z > 0 && data.heights[i] > 0) {
      const slope = (data.heights[i - 1] + data.heights[i - data.resolution] - 2 * data.heights[i]) / (recipe.size / data.resolution);
      color.multiplyScalar(Math.max(0.65, Math.min(1.3, 1 + slope * 0.7)));
    }
    color.convertLinearToSRGB();
    image.data.set([color.r * 255, color.g * 255, color.b * 255, 255], i * 4);
  }
  let bestForest = -1;
  for (let i=0;i<data.heights.length;i++) if (data.heights[i]>10 && i%data.resolution>4 && i%data.resolution<data.resolution-5 && Math.floor(i/data.resolution)>4 && Math.floor(i/data.resolution)<data.resolution-5 && data.weights[i*6+2]>bestForest) {
    bestForest=data.weights[i*6+2]; forestPoint=[(i%data.resolution/(data.resolution-1)-0.5)*recipe.size,(Math.floor(i/data.resolution)/(data.resolution-1)-0.5)*recipe.size];
  }
  sea.visible = recipe.size >= 2000 || data.min <= 0;
  atlasImage = image; ctx.putImageData(image, 0, 0);
  const count = data.heights.length;
  element('metrics').textContent = '全域采样高程 ' + data.min.toFixed(0) + ' … ' + data.max.toFixed(0) + ' m\n'
    + Object.entries(data.counts).map(([name, n]) => name + ' ' + (n / count * 100).toFixed(1) + '%').join(' · ');
}
function overview(top = false) {
  const centerY = recipe.size < 2000 ? Math.max(0,sample(0,0).height)*exaggeration : 0;
  controls.target.set(0, centerY, 0);
  const halfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect));
  const distance = recipe.size * (recipe.size < 2000 ? 0.57 : 0.72) / Math.sin(halfFov);
  camera.position.set(0, top ? 1 : 0.76, top ? 0.001 : 0.83).normalize().multiplyScalar(distance).add(controls.target);
  controls.update(); lodDirty = true; updateLod();
}
function visit(x: number, z: number, distance = Math.min(2800,recipe.size*0.65)) {
  const point = sample(x, z);
  const y = Math.max(0, point.height) * exaggeration;
  controls.target.set(x, y, z);
  camera.position.set(x + distance * 0.12, y + distance * 0.6, z + distance);
  camera.position.y = Math.max(camera.position.y, sample(camera.position.x, camera.position.z).height * exaggeration + distance * 0.2);
  controls.update(); lodDirty = true; updateLod();
  element('inspection').textContent = 'X ' + coordinateLabel(x) + ' · Z ' + coordinateLabel(z) + ' · ' + point.height.toFixed(0) + ' m · ' + BIOME_LABELS[dominantBiome(point)];
}
function generate(nextBundle?: WorldBundle) {
  try {
    const next = nextBundle?.plan.recipe ?? parseWorldPrompt(element<HTMLTextAreaElement>('prompt').value, Number(element<HTMLInputElement>('seed').value), Number(element<HTMLSelectElement>('size').value));
    lastError = ''; element('error').textContent = '';
    worker?.terminate();
    for (const mesh of active) terrainRoot.remove(mesh);
    for (const mesh of cache.values()) mesh.geometry.dispose();
    active = []; cache.clear(); desired = []; tileTimes.length = 0; frameTimes.length = 0;
    busy = false; started = performance.now(); firstReadyMs = 0; generation++;
    recipe = next; bundle = nextBundle;
    const previewUrl=new URL(location.href);
    if(bundle?.plan.id==='compact-four-towns') previewUrl.searchParams.set('demo','compact'); else previewUrl.searchParams.delete('demo');
    history.replaceState(null,'',previewUrl);
    if(bundle) {
      element<HTMLTextAreaElement>('prompt').value=recipe.constraints.map(c=>REGION_LABELS[c.region]+'是'+BIOME_LABELS[c.biome]).join('，');
      element<HTMLInputElement>('seed').value=String(recipe.seed);
      const sizeSelect=element<HTMLSelectElement>('size');
      if(![...sizeSelect.options].some(o=>o.value===String(recipe.size))) { const o=document.createElement('option');o.value=String(recipe.size);o.textContent=recipe.size<1000?recipe.size+' 米':recipe.size/1000+' km';sizeSelect.append(o); }
      sizeSelect.value=String(recipe.size);
    }
    sample = bundle ? createPlannedWorldSampler(bundle.plan, bundle.patches) : createWorldSampler(recipe);
    scene.remove(structures); disposeWorldStructures(structures);
    structures = bundle ? buildWorldStructures(bundle, sample, bundle.plan.id==='compact-four-towns'?assetLibrary:undefined) : new THREE.Group(); structures.scale.y=exaggeration; scene.add(structures);
    renderer.shadowMap.enabled = !!assetLibrary && bundle?.plan.id==='compact-four-towns';
    renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    sun.castShadow=renderer.shadowMap.enabled;
    if(sun.castShadow){
      sun.position.set(-180,450,160);sun.target.position.set(0,sample(0,0).height,0);scene.add(sun.target);
      sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-360,right:360,top:360,bottom:-360,near:1,far:900});
      sun.shadow.camera.updateProjectionMatrix();sun.shadow.normalBias=.18;sun.shadow.bias=-.00015;
    } else {sun.position.set(-18000,30000,12000);sun.target.position.set(0,0,0);}
    resetEcology();
    refreshPlanningUi();
    sea.scale.set(recipe.size, recipe.size, 1);
    camera.far = recipe.size * 12; camera.updateProjectionMatrix();
    controls.maxDistance = recipe.size * 8;
    element('caption').textContent = recipe.size<1000 ? recipe.size+' × '+recipe.size+' 米 · '+(bundle?.plan.towns.length ?? 0)+' 个聚落' : recipe.size / 1000 + ' × ' + recipe.size / 1000 + ' km · seed ' + recipe.seed;
    element('study-info').textContent=recipe.size<1000?'500 米聚落群 · 地形与中世纪资产':'连续地形与多群落衔接实验';
    element('plan').innerHTML = recipe.constraints.map(c => '<li><span>' + REGION_LABELS[c.region] + '</span><span>' + BIOME_LABELS[c.biome] + '</span></li>').join('');
    worker = new Worker(new URL('./terrainBiomeWorker.ts', import.meta.url), { type: 'module' });
    worker.onerror = event => { busy = false; showError(event.message); element('progress').textContent = '生成失败'; };
    worker.onmessage = event => {
      if (event.data.kind === 'error') { busy = false; showError(event.data.message); element('progress').textContent = '生成失败'; return; }
      if (event.data.kind === 'atlas') { atlasDraw(event.data); return; }
      busy = false;
      const tile = desired.find(t => keyOf(t) === event.data.key);
      if (tile && !cache.has(event.data.key)) {
        cache.set(event.data.key, makeMesh(tile, event.data.data));
        const protectedKeys = new Set(desired.map(keyOf));
        const activeMeshes = new Set(active);
        for (const [key, mesh] of cache) {
          if (cache.size <= 512) break;
          if (!protectedKeys.has(key) && !activeMeshes.has(mesh)) { mesh.geometry.dispose(); cache.delete(key); }
        }
        tileTimes.push(event.data.ms);
        if (tileTimes.length > 2000) tileTimes.shift();
      }
      const ready = desired.filter(t => cache.has(keyOf(t))).length;
      element('progress').textContent = '准备地形块 ' + ready + ' / ' + desired.length;
      pump();
    };
    worker.postMessage({ kind:'configure', recipe, bundle, rules: [] });
    worker.postMessage({ kind: 'atlas' });
    overview();
  } catch (error) { showError(error); }
}
const percentile = (values: number[], p: number) => values.length ? [...values].sort((a,b) => a-b)[Math.floor((values.length - 1) * p)] : 0;
function getMetrics() {
  const vertices = active.reduce((sum, mesh) => sum + mesh.geometry.getAttribute('position').count, 0);
  const residentBytes = [...cache.values()].reduce((sum, mesh) => sum + Object.values(mesh.geometry.attributes).reduce((s, a) => s + a.array.byteLength, 0) + (mesh.geometry.index?.array.byteLength ?? 0), 0);
  return { assetLoadMs, assetVariants: bundle?.plan.id==='compact-four-towns' && assetLibrary ? Object.keys(assetLibrary).length : 0, ...ecology.metrics(), drawCalls: renderer.info.render.calls, buildings: bundle?.patches.reduce((n,p)=>n+p.buildings.length,0) ?? 0, towns: bundle?.patches.length ?? 0, cameraPosition: camera.position.toArray(), target: controls.target.toArray(), generation, renderedGeneration, recipe, firstReadyMs, activeTiles: active.length, desiredTiles: desired.length,
    ready: !busy && desired.every(t => cache.has(keyOf(t))), cacheTiles: cache.size, vertices,
    triangles: renderer.info.render.triangles, residentGeometryMiB: residentBytes / 1048576,
    nearestSpacing: active.length ? Math.min(...active.map(m => (m.userData.tile as WorldTile).size / 32)) : 0,
    tileP50Ms: percentile(tileTimes, 0.5), tileP95Ms: percentile(tileTimes, 0.95),
    frameP50Ms: percentile(frameTimes, 0.5), frameP95Ms: percentile(frameTimes, 0.95), error: lastError };
}
async function waitForReady(timeout = 45000) {
  const start = performance.now();
  while (!getMetrics().ready || !getMetrics().ecologyReady) {
    if (lastError || ecology.error) throw new Error(lastError || ecology.error);
    if (performance.now() - start > timeout) throw new Error('地形块准备超时');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function survey() {
  if (surveyRunning) return;
  surveyRunning = true; element<HTMLButtonElement>('survey').disabled = true;
  element<HTMLButtonElement>('generate').disabled = true;
  const results = [];
  const surveyGeneration = generation;
  try {
    const route = bundle ? [...bundle.plan.towns.map(t => [t.center[0]*2/recipe.size,t.center[1]*2/recipe.size,Math.min(620,t.radius*3.5)]), [forestPoint[0]*2/recipe.size,forestPoint[1]*2/recipe.size,450]] : [[-0.65, 0, 6500], [-0.16, 0.15, 3800], [0, 0, 2400], [0.65, 0, 2600], [0, 0.65, 1400]];
    for (const [nx, nz, distance] of route) {
      if (generation !== surveyGeneration) throw new Error('巡检中地图已改变');
      visit(nx * recipe.size / 2, nz * recipe.size / 2, distance);
      await waitForReady();
      frameTimes.length = 0;
      const initial = performance.now();
      await new Promise<void>(resolve => {
        const step = () => {
          const t = Math.min(1, (performance.now() - initial) / 2000);
          const y = controls.target.y, x = controls.target.x, z = controls.target.z;
          camera.position.set(x + Math.sin(t * 0.6) * distance, y + distance * 0.6, z + Math.cos(t * 0.6) * distance);
          camera.position.y = Math.max(camera.position.y, sample(camera.position.x, camera.position.z).height * exaggeration + distance * 0.2);
          controls.update();
          if (t < 1) requestAnimationFrame(step); else resolve();
        };
        requestAnimationFrame(step);
      });
      results.push({ nx, nz, ...getMetrics() });
      element('survey-results').textContent = JSON.stringify(results, null, 2);
    }
    download('terrain-survey-' + recipe.seed + '.json', { route: results, note: '本机浏览器固定路径帧时间；非跨设备性能保证。' });
  } catch (error) { showError(error); }
  finally { surveyRunning = false; element<HTMLButtonElement>('survey').disabled = false; element<HTMLButtonElement>('generate').disabled = false; }
  return results;
}
function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
element<HTMLFormElement>('form').addEventListener('submit', event => { event.preventDefault(); generate(); });
element<HTMLSelectElement>('example').addEventListener('change', event => {
  const value = (event.target as HTMLSelectElement).value;
  if (value) element<HTMLTextAreaElement>('prompt').value = value;
});
element('overview').onclick = () => overview();
element('top').onclick = () => overview(true);
element('wire').onclick = () => { landMaterial.wireframe = !landMaterial.wireframe; };
element('relief').onclick = () => {
  exaggeration = exaggeration === 1 ? 2 : exaggeration === 2 ? 4 : 1;
  terrainRoot.scale.y = exaggeration; structures.scale.y = exaggeration; ecology.root.scale.y = exaggeration;
  element('relief').textContent = '高度 ' + exaggeration + '×';
};
element('export').onclick = () => download('world-recipe-' + recipe.seed + '.json', recipe);
element('survey').onclick = () => { void survey(); };
element<HTMLCanvasElement>('atlas').onclick = event => {
  const rect = element('atlas').getBoundingClientRect();
  visit(((event.clientX - rect.left) / rect.width - 0.5) * recipe.size, ((event.clientY - rect.top) / rect.height - 0.5) * recipe.size);
};
canvas.addEventListener('dblclick', event => {
  const rect = canvas.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), camera);
  const hit = ray.intersectObjects([...active, sea])[0];
  if (hit) visit(hit.point.x, hit.point.z, Math.max(180, camera.position.distanceTo(controls.target) * 0.3));
});
controls.addEventListener('change', () => { lodDirty = true; });
const observer = new ResizeObserver(() => {
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  camera.aspect = canvas.clientWidth / canvas.clientHeight; camera.updateProjectionMatrix();
}); observer.observe(element('viewport'));
let previous = performance.now(), lastStats = 0;
function animate(now: number) {
  requestAnimationFrame(animate);
  const delta = now - previous; previous = now;
  if (delta > 0 && delta < 1000) { frameTimes.push(delta); if (frameTimes.length > 600) frameTimes.shift(); }
  controls.update();
  if (lodDirty && now - lastLod > 500 && !surveyRunning) updateLod();
  updateCameraClip();
  if (now-lastStats>500) ecology.update(controls.target,camera.position);
  renderer.render(scene, camera);
  if (now - lastStats > 500 && recipe) {
    lastStats = now;
    const m = getMetrics();
    element('stream-metrics').textContent = JSON.stringify(m,null,2);
    element('status').textContent = m.activeTiles + ' 块 · ' + (m.vertices / 1000).toFixed(0) + 'k 顶点 · 最近格距 ' + m.nearestSpacing.toFixed(1) + ' m\n'
      + '帧时间 P50 / P95 ' + m.frameP50Ms.toFixed(1) + ' / ' + m.frameP95Ms.toFixed(1) + ' ms · 网格数据 ' + m.residentGeometryMiB.toFixed(1) + ' MiB\n'
      + '植被 ' + m.ecologyInstances + ' 株 / ' + m.ecologyChunks + ' 块 · Draw calls ' + m.drawCalls + ' · 生态生成 P95 ' + m.ecologyP95Ms.toFixed(1) + ' ms\n'
      + '块生成 P50 / P95 ' + m.tileP50Ms.toFixed(1) + ' / ' + m.tileP95Ms.toFixed(1) + ' ms · 首屏 ' + (m.firstReadyMs / 1000).toFixed(2) + ' s';
    if (atlasImage) {
      const atlas = element<HTMLCanvasElement>('atlas'), ctx = atlas.getContext('2d')!;
      ctx.putImageData(atlasImage, 0, 0);
      drawPlanAtlas(ctx,atlas.width);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc((controls.target.x / recipe.size + 0.5) * atlas.width, (controls.target.z / recipe.size + 0.5) * atlas.height, 3, 0, Math.PI * 2); ctx.stroke();
    }
  }
}
window.addEventListener('pagehide', () => { worker?.terminate(); ecology.dispose(); disposeWorldStructures(structures); if(assetLibrary)disposeWorldAssetLibrary(assetLibrary); observer.disconnect(); controls.dispose(); renderer.dispose(); });


function resetEcology() {
  const factor = Number(element<HTMLInputElement>('density').value);
  const rules = (bundle?.plan.ecology ?? DEFAULT_ECOLOGY_RULES).map(r=>({...r,density:Math.min(1,r.density*factor)}));
  ecology.reset(recipe,rules,bundle,bundle?.plan.id==='compact-four-towns'?assetLibrary:undefined); ecology.root.scale.y=exaggeration;
  element('density-label').textContent='植被密度预览 '+factor.toFixed(2)+'×';
  ecology.update(controls.target,camera.position);
}
function refreshPlanningUi() {
  const select=element<HTMLSelectElement>('town');
  select.replaceChildren();
  for (const town of bundle?.plan.towns ?? []) {
    const option=document.createElement('option'); option.value=town.id; option.textContent=town.name;
    select.append(option);
  }
  element('planning-status').textContent=bundle
    ? bundle.plan.prompt+'\n'+bundle.patches.length+'/'+bundle.plan.towns.length+' 个局部计划已合并 · 道路 '+bundle.plan.roads.length+' 条 · '+bundle.plan.ecology.length+' 条生态规则'
    : '地形预览模式。可加载分层样例，或导入 AI 编写的世界计划。';
  for (const id of ['visit-town','export-tasks','export-bundle']) element<HTMLButtonElement>(id).disabled=!bundle;
}
function drawPlanAtlas(ctx: CanvasRenderingContext2D, size: number) {
  if (!bundle) return;
  const point=(v:number)=>(v/recipe.size+0.5)*size;
  ctx.strokeStyle='#f1d3a0'; ctx.lineWidth=1;
  for (const r of bundle.plan.roads) {
    ctx.beginPath(); r.points.forEach(([x,z],i)=>i?ctx.lineTo(point(x),point(z)):ctx.moveTo(point(x),point(z))); ctx.stroke();
  }
  for (const t of bundle.plan.towns) { ctx.fillStyle='#ffe9ae'; ctx.fillRect(point(t.center[0])-2,point(t.center[1])-2,4,4); }
}
element('density').addEventListener('change',()=>resetEcology());
element('forest').onclick=()=>visit(...forestPoint,450);
element('visit-town').onclick=()=>{
  const t=bundle?.plan.towns.find(t=>t.id===element<HTMLSelectElement>('town').value);
  if(t) visit(t.center[0],t.center[1],Math.min(620,t.radius*3.6/Math.min(1,camera.aspect)));
};
const coordinateLabel=(value:number)=>recipe.size<1000?value.toFixed(0)+' 米':(value/1000).toFixed(1)+' km';
async function loadCompactDemo() {
  try {
    if(!assetLibrary){
      const loadStart=performance.now();
      element('progress').textContent='装载中世纪资产…';
      const assets=await fetch('/scripts/fixtures/medieval-assets.json');
      if(!assets.ok)throw new Error('中世纪资产读取失败：'+assets.status);
      assetLibrary=await buildWorldAssetLibrary((await assets.json()).assets);
      assetLoadMs=performance.now()-loadStart;
    }
    const response=await fetch('/scripts/fixtures/compact-world.json');
    if(!response.ok) throw new Error('紧凑样例读取失败：'+response.status);
    generate(validateWorldBundle(await response.json()));
    overview();
  } catch(error) { showError(error); }
}
element('compact-demo').onclick=()=>{ void loadCompactDemo(); };
element('demo').onclick=async()=>{
  try {
    const response=await fetch('/scripts/fixtures/hierarchical-world.json');
    if(!response.ok) throw new Error('样例读取失败：'+response.status);
    const next=validateWorldBundle(await response.json());
    generate(next);
    const town=next.plan.towns[0]; if(town) visit(town.center[0],town.center[1],620);
  } catch(error) { showError(error); }
};
element('export-tasks').onclick=()=>{ if(bundle) download('town-tasks.json',createTownTasks(bundle.plan)); };
element('export-bundle').onclick=()=>{ if(bundle) download('world-bundle.json',bundle); };
element('import-plan').onclick=()=>{
  try {
    const input=JSON.parse(element<HTMLTextAreaElement>('plan-json').value) as WorldBundle|WorldPlan|TownPatch;
    let next: WorldBundle;
    if ('townId' in input) {
      if(!bundle) throw new Error('请先导入对应的世界计划');
      next=mergeTownPatch(bundle,input);
    } else if ('plan' in input) next=validateWorldBundle(input);
    else next={plan:validateWorldPlan(input),patches:[]};
    const previous=controls.target.clone(), distance=camera.position.distanceTo(controls.target);
    generate(next);
    if ('townId' in input) visit(previous.x,previous.z,distance/1.17);
    element('planning-status').textContent += '\n导入通过：范围、版本、道路接口与建筑占地已验证';
  } catch(error) { showError(error); }
};
if(new URLSearchParams(location.search).get('demo')==='compact') void loadCompactDemo(); else generate();
requestAnimationFrame(animate);







