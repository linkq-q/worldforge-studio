import fs from 'node:fs';
import path from 'node:path';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import { calculateModelVisualBounds } from '../src/shared/modelBounds';
import { MapStore } from '../src/server/mapStore';
import { createMapAssetGenerator } from '../src/server/mapAssetGenerator';
import { executeMapCodePlan, generateMapCodeSuggestion } from '../src/server/mapCodePlanner';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Pass an absolute result directory');
fs.mkdirSync(output, { recursive: true });

const store = new MapStore();
await store.ensureReady();

type Run = {
  key: string; group: 'heuristic' | 'free' | 'principle'; repeat: number;
  status: 'running' | 'saved' | 'failed'; mapId?: string; transactionId?: string;
  startedAt: string; completedAt?: string; objectCount?: number; operationCount?: number;
  error?: string; diagnostics?: unknown; functions?: string[];
};
type Ledger = {
  name: string; fixtureMapId?: string; fixtureSeed: number;
  plannerProvider: 'gpt'; assetProvider: 'deepseek'; assetMode: 'voxel';
  revisionMode: 'first-pass'; spatialPolicy: 'diagnose'; size: [96, 16, 96];
  kit: Record<string, string>; runs: Run[];
};
const ledgerPath = path.join(output, 'ledger.json');
const ledger: Ledger = fs.existsSync(ledgerPath)
  ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
  : {
      name: '固定坡地聚落三组对照', fixtureSeed: 240925, plannerProvider: 'gpt',
      assetProvider: 'deepseek', assetMode: 'voxel', revisionMode: 'first-pass',
      spatialPolicy: 'diagnose', size: [96, 16, 96], kit: {}, runs: []
    };
function writeJson(name: string, value: unknown): void {
  const destination = path.join(output, name);
  const temporary = destination + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, destination);
}
function save(): void { writeJson('ledger.json', ledger); }
function writeText(name: string, value: string): void { fs.writeFileSync(path.join(output, name), value, 'utf8'); }

const kitRequests = [
  {
    key: 'house', name: '山地民居',
    prompt: 'Standalone small mountain village house, low-poly voxel architecture. Rectangular stone-and-timber body, clear usable front door centered on local Z+ side, modest pitched roof, visible solid base. Intended footprint about 7m wide by 6m deep, 5m tall. No terrain, trees, people, labels or background. Local Y+ up, X+ right, Z+ front.'
  },
  {
    key: 'hall', name: '村民公共屋',
    prompt: 'Standalone modest mountain village communal hall, low-poly voxel architecture. Wider than a house, open recognizable entrance centered on local Z+ side, stone-and-timber construction, simple pitched roof, solid base. Intended footprint about 9m wide by 7m deep, 5m tall. No terrain, trees, people, labels or background. Local Y+ up, X+ right, Z+ front.'
  },
  {
    key: 'steps', name: '石阶模块',
    prompt: 'Standalone walkable short outdoor stone stair module, low-poly voxel construction. About 3m wide, 3m run along local Z, 1m total rise, distinct broad even treads, no side walls and no surrounding terrain. Ascend toward local Z+. Intended to connect modular routes. Local Y+ up, X+ right, Z+ front. No people, labels or background.'
  },
  {
    key: 'tree', name: '山地阔叶树',
    prompt: 'Standalone mature broadleaf tree for a mountain village, low-poly voxel shape. Distinct trunk and irregular readable crown, about 5m tall and 3m wide, natural green foliage. No terrain patch, pot, people, labels or background. Local Y+ up.'
  }
] as const;

if (!ledger.fixtureMapId) {
  const fixture = createEmptyMap('坡地聚落对照 · 共同地形', undefined, ledger.size, 'voxel', 'outdoor');
  fixture.seed = ledger.fixtureSeed;
  const created = await store.saveMap(fixture);
  const committed = await store.commitTransaction(created.id, {
    label: '固定丘陵与水文侵蚀地形', source: 'agent', operations: [
      { type: 'terrain.generate', preset: 'hills', seed: ledger.fixtureSeed, amplitude: 7.4, roughness: 0.62, direction: 28 },
      { type: 'terrain.refine', erosion: 0.4, drainage: 0.22, iterations: 4, talus: 42 }
    ]
  });
  ledger.fixtureMapId = committed.map.id;
  save();
  const heights = committed.map.terrain.heights;
  writeJson('fixture.json', {
    mapId: committed.map.id, seed: committed.map.seed, size: committed.map.box.size,
    terrainResolution: [committed.map.terrain.resolutionX, committed.map.terrain.resolutionZ],
    terrainHeightRange: [Math.min(...heights), Math.max(...heights)], transactionId: committed.transaction.id
  });
  console.log(`FIXTURE ${committed.map.id}`);
}

const assetGenerator = createMapAssetGenerator(
  store, await store.loadMap(ledger.fixtureMapId), [], 'deepseek', null, new AbortController().signal
);
for (const request of kitRequests) {
  if (ledger.kit[request.key]) continue;
  console.log(`ASSET_START ${request.name}`);
  const asset = await assetGenerator({
    name: `坡地聚落实验·${request.name}`, prompt: request.prompt, mode: 'voxel',
    tags: ['hill-town-comparison', request.key]
  }, (progress) => console.log(`ASSET_PROGRESS ${request.key} ${progress.status}`));
  ledger.kit[request.key] = asset.id;
  save();
  console.log(`ASSET_SAVED ${request.name} ${asset.id}`);
}

const assets: MapAsset[] = await Promise.all(kitRequests.map((request) => store.loadAsset(ledger.kit[request.key])));
const id = Object.fromEntries(kitRequests.map((request) => [request.key, ledger.kit[request.key]]));
const catalog = assets.map((asset) => {
  const bounds = calculateModelVisualBounds(asset.modelJson);
  return {
    id: asset.id, name: asset.name, provider: asset.provider,
    localBounds: bounds,
    size: bounds.max.map((value, axis) => +(value - bounds.min[axis]).toFixed(2))
  };
});
if (catalog.some((asset) => asset.provider !== 'deepseek')) throw new Error('asset_provider_mismatch');
writeJson('shared-assets.json', catalog);

const baseBrief = '在现有山地上建设一个小型聚落，含四至六户住宅和一处供居民使用的公共场所。保留山地的自然起伏。';
const principle = '请根据人们在各处停留与往来的实际需要，判断建筑、地面与通路之间应形成什么关系。具体空间组织和构造方法由你决定。';
const system = `You compose an outdoor WorldForge map with executable Scene Code.
Return only one synchronous JavaScript function named plan(api), with bounded loops, plain JavaScript and Math. You may write local helper functions freely. Do not output Markdown or explanations.
This is a fixed 96 x 16 x 96 mountain terrain. Horizontal coordinates x,z run from -48 to 48. The existing terrain is part of the experimental input: preserve its overall form and do not call api.terrain, api.refineTerrain, or generate a replacement heightfield. Local terrain edits are allowed. Use only the four reusable DeepSeek assets listed below; do not call api.requireAsset. Each result must fit this same terrain.
Available observations and operations:
- api.environmentSample([x,z]) returns {height,slope,waterDistance,...} for the actual current terrain; you can query it inside your own algorithms.
- api.sculptTerrain({mode:'raise'|'lower'|'flatten'|'smooth',point:[x,z],radius?,strength?,targetHeight?}) changes a local area.
- api.rampTerrain({start:[x,z],end:[x,z],width,startHeight?,endHeight?,softness?,strength?}) grades a local connection.
- api.route({id,points:[[x,z],...],width?,surface?:'paving'|'soil'|'grass'|'sand'|'rock'|'none'}) creates an editable path.
- api.surface({id,surface:'grass'|'sand'|'rock'|'soil'|'paving',region:{kind:'circle',x,z,radius},intensity?}) paints a local area.
- api.place({assetId,name?,position:[x,z]|[x,y,z],facing?:{target:[x,z]},rotationY?,terrain?,role?}) returns a placement reference. A two-number position samples the final terrain; [x,y,z] is fixed world height unless terrain:true.
- api.foundation({under:[placementReference,...],shape?:'rounded-rectangle'|'polygon'|'path',top?:'level'|'slope'|'steps',margin?,thickness?,maxThickness?}) makes an editable foundation whose bottom follows terrain.
- api.random(min?,max?) is seeded, and Math is available for your own helpers.
All building assets face local Z+; their front door is on that side. The stair module ascends toward local Z+.
Reusable assets (IDs and measured model-local bounds):
${JSON.stringify(catalog)}
Use asset IDs exactly as listed. Do not invent APIs or asset IDs. The environment will report problems, but this experiment will not repair your code or spatial result.`;
writeText('shared-system-prompt.txt', system);
writeText('free-user-prompt.txt', baseBrief);
writeText('principle-user-prompt.txt', baseBrief + '\n\n' + principle);

function heuristicCode(repeat: number): string {
  return `function plan(api) {
  let state = ${repeat * 7919 + 31};
  function rand() { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; }
  function dist(a,b) { return Math.hypot(a[0]-b[0],a[1]-b[1]); }
  const sites=[];
  for (let x=-34; x<=34; x+=5) for (let z=-34; z<=34; z+=5) {
    const p=[x+(rand()-.5)*2,z+(rand()-.5)*2];
    const s=api.environmentSample(p);
    const corners=[[p[0]-3,p[1]-3],[p[0]+3,p[1]-3],[p[0]-3,p[1]+3],[p[0]+3,p[1]+3]];
    const heights=corners.map(q=>api.environmentSample(q).height);
    const relief=Math.max(...heights)-Math.min(...heights);
    sites.push({p, h:s.height, relief, slope:s.slope, jitter:rand()});
  }
  sites.sort((a,b)=>(a.relief*2+Math.hypot(...a.p)*.04+a.jitter*1.2)-(b.relief*2+Math.hypot(...b.p)*.04+b.jitter*1.2));
  const center=sites[0];
  const homes=[];
  for (let i=0;i<5;i++) {
    const options=sites.filter(s=>dist(s.p,center.p)>13 && dist(s.p,center.p)<36 && homes.every(h=>dist(s.p,h.p)>12));
    options.sort((a,b)=>(a.relief*1.8+Math.abs(dist(a.p,center.p)-24)*.07+a.jitter*1.4)-(b.relief*1.8+Math.abs(dist(b.p,center.p)-24)*.07+b.jitter*1.4));
    if (options.length) homes.push(options[0]);
  }
  const nodes=[center,...homes];
  const connected=[center];
  const edges=[];
  while (connected.length<nodes.length) {
    let best=null;
    for (const a of connected) for (const b of nodes) if (!connected.includes(b)) {
      const cost=dist(a.p,b.p)+Math.abs(a.h-b.h)*2.5;
      if (!best || cost<best.cost) best={a,b,cost};
    }
    if (!best) break;
    edges.push(best); connected.push(best.b);
  }
  for (const e of edges) api.rampTerrain({start:e.a.p,end:e.b.p,width:2.6,softness:.55,strength:.9});
  for (const s of nodes) api.sculptTerrain({mode:'flatten',point:s.p,radius:s===center?6:4.8,strength:.9,targetHeight:s.h});
  for (let i=0;i<edges.length;i++) api.route({id:'footpath-'+i,points:[edges[i].a.p,edges[i].b.p],width:2.4,surface:'soil'});
  api.surface({id:'shared-ground',surface:'paving',region:{kind:'circle',x:center.p[0],z:center.p[1],radius:6.5}});
  const hall=api.place({assetId:'${id.hall}',name:'村民公共屋',position:center.p,role:'structure'});
  api.foundation({under:[hall],top:'level',margin:.5,maxThickness:4});
  for (let i=0;i<homes.length;i++) {
    const s=homes[i];
    const home=api.place({assetId:'${id.house}',name:'住宅 '+(i+1),position:s.p,facing:{target:center.p},role:'structure'});
    api.foundation({under:[home],top:'level',margin:.45,maxThickness:4});
  }
  for (const s of sites) {
    if (rand()>.05 || nodes.some(n=>dist(s.p,n.p)<9) || edges.some(e=>{
      const ax=e.a.p[0],az=e.a.p[1],bx=e.b.p[0],bz=e.b.p[1];
      const t=Math.max(0,Math.min(1,((s.p[0]-ax)*(bx-ax)+(s.p[1]-az)*(bz-az))/((bx-ax)**2+(bz-az)**2)));
      return Math.hypot(s.p[0]-(ax+t*(bx-ax)),s.p[1]-(az+t*(bz-az)))<5;
    })) continue;
    api.place({assetId:'${id.tree}',name:'山地树',position:s.p,role:'environment'});
  }
}`;
}

for (let repeat = 1; repeat <= 4; repeat++) {
  for (const group of ['heuristic', 'free', 'principle'] as const) {
    const key = `${group}-r${repeat}`;
    if (ledger.runs.some((run) => run.key === key && run.status === 'saved')) continue;
    let run = ledger.runs.find((item) => item.key === key);
    if (!run) {
      run = { key, group, repeat, status: 'running', startedAt: new Date().toISOString() };
      ledger.runs.push(run);
    }
    try {
      const map = run.mapId
        ? await store.loadMap(run.mapId)
        : await store.duplicateMap(ledger.fixtureMapId, `坡地聚落对照 ${group} ${repeat}`);
      run.mapId = map.id;
      save();
      console.log(`RUN_START ${key} ${map.id}`);
      let suggestion;
      if (group === 'heuristic') {
        const code = heuristicCode(repeat);
        writeText(key + '-code.js', code);
        suggestion = executeMapCodePlan(code, map, assets, {
          mode: 'final', requestMode: 'refine', scope: 'scene', promptMode: 'standard',
          spatialPolicy: 'diagnose', minNewAssets: 0, maxNewAssets: 0
        });
      } else {
        const prompt = group === 'free' ? baseBrief : baseBrief + '\n\n' + principle;
        suggestion = await generateMapCodeSuggestion(prompt, map, assets, {
          provider: 'gpt', mode: 'refine', scope: 'scene', promptMode: 'standard',
          revisionMode: 'first-pass', spatialPolicy: 'diagnose',
          minNewAssets: 0, maxNewAssets: 0, reuseExistingAssets: true,
          reusableAssetIds: assets.map((asset) => asset.id), systemPromptOverride: system,
          onProgress: (event) => console.log(`RUN_PROGRESS ${key} ${event.label}`)
        });
        writeText(key + '-code.js', suggestion.codePlan?.code ?? '');
      }
      writeJson(key + '-result.json', suggestion);
      if (suggestion.blocked) throw new Error('generation_blocked');
      if (suggestion.operations.some((operation) => ['terrain.generate', 'terrain.set', 'terrain.refine'].includes(operation.type))) {
        throw new Error('fixed_terrain_was_replaced');
      }
      if (!suggestion.operations.some((operation) => operation.type === 'object.add')) throw new Error('no_objects_generated');
      const committed = await store.commitTransaction(map.id, {
        label: `坡地聚落 ${group} 第${repeat}次`, source: 'agent', operations: suggestion.operations
      }, map.version);
      run.status = 'saved';
      run.transactionId = committed.transaction.id;
      run.objectCount = committed.map.objects.length;
      run.operationCount = suggestion.operations.length;
      run.diagnostics = suggestion.diagnostics;
      run.functions = suggestion.codePlan?.functions ?? [];
      run.completedAt = new Date().toISOString();
      save();
      console.log(`RUN_SAVED ${key} ${map.id} objects=${run.objectCount}`);
    } catch (error) {
      run.status = 'failed';
      run.error = error instanceof Error ? error.message : String(error);
      run.completedAt = new Date().toISOString();
      save();
      console.error(`RUN_FAILED ${key} ${run.error}`);
    }
  }
}

console.log(`FINISHED ${ledger.runs.filter((run) => run.status === 'saved').length}/12 saved`);
