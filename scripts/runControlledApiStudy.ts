import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createEmptyMap, getMapObjectVisualAabbs, sampleTerrainHeight, type MapAsset } from '../src/shared/map';
import type { ModelGenerationMode } from '../src/shared/modelGenerationMode';
import { calculateModelVisualBounds } from '../src/shared/modelBounds';
import { MapStore } from '../src/server/mapStore';
import { mapCatalog } from '../src/server/mapCatalog';
import { executeMapCodePlan, discoverMapCodeAssets } from '../src/server/mapCodePlanner';
import { llmChat, generateModel } from '../src/server/modelApi';
import { withGenerationTrace } from '../src/server/generationTrace';
import { LIMIT, CORE, FULL, SCENES, KIT_PROMPT, REFERENCE, trials, audit, systemPrompt, type Trial } from './controlledApiStudy';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Pass an absolute output directory');
const mode = (process.argv.find(arg => arg.startsWith('--asset-mode='))?.split('=')[1] ?? 'voxel') as ModelGenerationMode;
if (!['voxel', 'standard'].includes(mode)) throw Error('Unsupported study asset mode');
const prepareOnly = process.argv.includes('--prepare-only');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
fs.mkdirSync(output, { recursive: true });
function write(name: string, value: unknown): void {
  const file = path.join(output, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}
function read<T>(name: string, fallback: T): T {
  const file = path.join(output, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as T : fallback;
}
interface Round extends Trial { status: string; mapId?: string; transactionId?: string; error?: string; [key: string]: unknown }
interface Ledger { limit: number; mode: string; status: string; rounds: Round[]; queue: Trial[]; folderId?: string; progress?: string }
const ledger = read<Ledger>('ledger.json', { limit: LIMIT, mode, status: 'preparing', rounds: [], queue: trials() });
if (ledger.limit !== LIMIT || ledger.mode !== mode || ledger.queue.length > LIMIT) throw Error('Study configuration changed');
const store = new MapStore();
const escape = (x: unknown) => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const labels: Record<string, string> = { minimal: '精简基线', full: '精简后的全规划', 'single-api': '单 API', main: '主对照', 'open-assets': '独立资产／形态', reference: '参考注入', review: '定向复核' };
function report(): void {
  const groups = [...new Set(ledger.queue.map(t => t.group))];
  const saved = ledger.rounds.filter(r => r.status === 'saved').length;
  const failed = ledger.rounds.filter(r => ['failed', 'interrupted'].includes(r.status)).length;
  const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WorldForge 100 张 API 对照</title>
<style>body{font:16px/1.6 system-ui;background:#10151b;color:#dbe4ee;margin:24px}h1{font-size:26px}a{color:#8fd4ff}header{position:sticky;top:0;background:#10151bee;padding:12px;z-index:2;border-bottom:1px solid #344}button,select{padding:8px;margin-right:12px}section{margin:28px 0;border-top:1px solid #445;padding-top:12px}.pair{display:flex;gap:14px;overflow-x:auto;align-items:flex-start}.card{min-width:360px;flex:1;background:#1a232d;padding:12px;border-radius:8px}.card img{display:block;width:100%;aspect-ratio:1200/760;object-fit:contain;background:#070b0f;margin:8px 0}.metadata{font-size:13px;color:#abc}.bad{color:#ffb0a0}body.blind .config{visibility:hidden}summary{cursor:pointer}pre{white-space:pre-wrap;max-height:260px;overflow:auto;font-size:12px}.pending{height:200px;display:grid;place-items:center;background:#121920}</style>
<body class="blind"><header><strong>已保存 ${saved} · 失败/中断 ${failed} · 已开始 ${ledger.rounds.length}/${LIMIT}</strong>　${escape(ledger.status)}<br>
<button onclick="document.body.classList.toggle('blind')">显示／隐藏配置（默认盲看）</button><button onclick="location.reload()">刷新</button><select onchange="document.querySelectorAll('section').forEach(s=>s.hidden=this.value&&s.dataset.scene!==this.value)"><option value="">全部场景</option>${SCENES.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select><a href="ledger.json">完整记录</a> · <a href="manifest.json">冻结版本</a> · <a href="preflight.json">旧记录排查</a></header>
<h1>100 张地图：GPT 规划 × DeepSeek 资产</h1><p>42 主对照＋24 单 API＋24 独立资产形态＋6 参考注入＋最多 4 定向复核。当前资产风格：${escape(mode)}。空间修复、规划重写和资产后布局调整关闭；地图尺寸统一 96×48×96。主对照每模式 3 次，形态每模式 6 次。失败占用名额，截图失败单独标记。</p>
<p>同组主对照与单 API 复用同一资产包和地图种子。形态实验每张独立生成资产，不能当纯布局对照。默认隐藏配置，先看两视图再揭示。图像使用统一相机和默认查看器，没有生成或应用新渲染方案。诊断数量不是审美评分。</p><p>${escape(ledger.progress ?? '')}</p>
${groups.map(group => { const items = ledger.queue.filter(t => t.group === group); const scene = SCENES.find(s => s.id === items[0].scene)!; return `<section data-scene="${scene.id}" id="${group}"><h2>${scene.name} · ${escape(group)}</h2><p>${escape(scene.prompt)}</p><div class="pair">${items.map((t, i) => {
  const r = ledger.rounds.find(r => r.key === t.key);
  return `<article class="card"><h3>样本 ${String.fromCharCode(65+i)} <span class="config">${escape(labels[t.profile] ?? '+'+t.profile)}${t.reference ? '＋结构参考' : ''}</span></h3><div class="metadata">${escape(labels[t.stage])} · seed ${t.seed} · ${escape(r?.status ?? '等待')}</div>${(['top', 'oblique'] as const).map(view => fs.existsSync(path.join(output, 'images', `${t.key}-${view}.png`)) ? `<a href="images/${t.key}-${view}.png" target="_blank"><img loading="lazy" src="images/${t.key}-${view}.png" alt="${view === 'top' ? '俯视图' : '45°透视图'}"></a>` : `<div class="pending">${view === 'top' ? '俯视图' : '45°透视图'} · ${r?.status === 'failed' ? '生成失败' : '待截图'}</div>`).join('')}
${r?.error ? `<p class="bad">${escape(r.error)}</p>` : ''}<details><summary>调用、诊断和资产证据（揭示配置）</summary><pre>${escape(JSON.stringify(r ?? t, null, 2))}</pre>${r ? `<a href="${t.key}-code.js">生成代码</a> · <a href="${t.key}-system.txt">完整提示词</a> · <a href="${t.key}-map.json">地图快照</a>` : ''}</details></article>`;
 }).join('')}</div></section>`; }).join('')}
${ledger.status === 'completed' ? '' : '<script>setTimeout(()=>location.reload(),120000)</script>'}</body></html>`;
  write('review.html', html);
}
function save(): void { write('ledger.json', ledger); report(); }
function progress(message: string): void { ledger.progress = message; console.log(new Date().toISOString(), message); save(); }

// Enforce provider routing at the network boundary and retain request counts separately from map slots.
const checkedFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input)), body = JSON.parse(String(init?.body));
  if ((url.pathname === '/api/chat' && body.provider !== 'gpt') || (url.pathname === '/api/generate/model' && body.provider !== 'deepseek') || !['/api/chat', '/api/generate/model'].includes(url.pathname)) throw Error('provider_route_mismatch');
  fs.appendFileSync(path.join(output, 'network.jsonl'), JSON.stringify({ at: new Date().toISOString(), route: url.pathname, provider: body.provider, requestHash: sha(String(init?.body)), mode: body.mode }) + '\n');
  return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000) });
};
function unfence(raw: string): string { return raw.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '').replace(/^\s*```(?:json|js|javascript|typescript)?\s*/i, '').replace(/\s*```\s*$/, '').trim(); }
async function chat(system: string, user: string, key: string): Promise<string> {
  write(`${key}-system.txt`, system); write(`${key}-user.txt`, user);
  const raw = await llmChat([{ role: 'system', content: system }, { role: 'user', content: user }], {
    provider: 'gpt', temperature: 0.25, maxTokens: 16000, thinking: true, fetchImpl: checkedFetch, reasoningLogPath: false
  });
  write(`${key}-raw.txt`, raw); return unfence(raw);
}
interface Requirement { key: string; name: string; prompt: string; dimensions: [number,number,number]; role: 'structure' | 'environment' }
interface Kit { requirements: Requirement[]; assets: { key: string; assetId: string }[]; error?: string }
async function generateAsset(req: Requirement): Promise<MapAsset> {
  const modelJson = await generateModel(`${req.prompt}\nTarget dimensions [width,height,depth]=${JSON.stringify(req.dimensions)}. Y+ up, Z+ front, X+ right. Center horizontally; base at local Y=0. No background or scene ground.`, { providers: ['deepseek'], mode, fetchImpl: checkedFetch });
  return store.saveAsset({ name: req.name, prompt: req.prompt, modelJson, mode, provider: 'deepseek', tags: ['controlled-api-study', req.role] });
}
async function sharedKit(t: Trial): Promise<MapAsset[]> {
  const name = `kits/${t.kitKey}.json`, kit = read<Kit>(name, { requirements: [], assets: [] });
  if (kit.error) throw Error('shared_kit_failed:' + kit.error);
  try {
    if (!kit.requirements.length) {
      kit.requirements = JSON.parse(await chat(KIT_PROMPT, SCENES.find(s => s.id === t.scene)!.prompt, `kits/${t.kitKey}`)).requirements;
      if (!Array.isArray(kit.requirements) || kit.requirements.length !== 12 || new Set(kit.requirements.map(r => r.key)).size !== 12
        || kit.requirements.some(r => !r.key || !r.name || !r.prompt || r.prompt.length > 450 || !['structure','environment'].includes(r.role) || r.dimensions?.length !== 3 || r.dimensions.some(x => !Number.isFinite(x) || x <= 0))) throw Error('invalid_shared_kit');
      write(name, kit);
    }
    for (let i=0;i<kit.requirements.length;i+=4) {
      const results = await Promise.allSettled(kit.requirements.slice(i,i+4).map(async req => {
        if (kit.assets.some(a => a.key === req.key)) return;
        progress(`资产包 ${t.kitKey}：DeepSeek 生成 ${req.name}`);
        const asset = await generateAsset(req); kit.assets.push({ key: req.key, assetId: asset.id }); write(name, kit);
      }));
      for (const r of results) if (r.status === 'rejected') throw r.reason;
    }
    return Promise.all(kit.requirements.map(r => store.loadAsset(kit.assets.find(a => a.key === r.key)!.assetId)));
  } catch (e) { kit.error = String(e); write(name, kit); throw e; }
}

let browser: any;
async function capture(t: Trial, id: string): Promise<void> {
  if (!browser) {
    const module = process.env.STUDY_PLAYWRIGHT ?? 'C:/Users/31483/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
    const { chromium } = await import(pathToFileURL(module).href);
    browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
  }
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 });
  try {
    for (const view of ['top','oblique']) {
      await page.goto(`http://127.0.0.1:5180/scripts/apiAblationPreview.html?map=${id}&view=${view}&framing=study`, { waitUntil: 'networkidle', timeout: 60_000 });
      await page.waitForFunction(() => (window as any).apiAblationReady || (window as any).apiAblationError, { timeout: 60_000 });
      const error = await page.evaluate(() => (window as any).apiAblationError);
      if (error) throw Error(error);
      fs.mkdirSync(path.join(output,'images'), { recursive: true });
      await page.screenshot({ path: path.join(output,'images',`${t.key}-${view}.png`) });
    }
  } finally { await page.close(); }
}

await store.ensureReady();
// Read-only checks of prior records; never include these maps in the new sample.
if (!fs.existsSync(path.join(output,'preflight.json'))) {
  const oldFile = 'C:/Users/31483/.codex/visualizations/2026/09/20/01a0bf3e-5cb0-7de0-bcba-0f9ae97e5e41/generation-comparison/summary.json';
  const old = JSON.parse(fs.readFileSync(oldFile,'utf8')).filter((r: any) => /雨林|滑雪|水坝/.test(r.scene));
  const rows = [];
  for (const r of old) {
    try {
      const map = await store.loadMap(r.id), bounds = getMapObjectVisualAabbs(map);
      const objects = map.objects.filter(o => /树|缆|吊|塔|坝/.test(o.name)).slice(0,80).map(o => ({
        id:o.id, name:o.name, transform:o.transform, parentId:o.parentId,
        terrainY:sampleTerrainHeight(map,o.transform.position[0],o.transform.position[2]),
        visualBounds:bounds.filter(b => b.objectId === o.id),
        assetBounds:map.assets?.find(a=>a.id===o.assetId) ? calculateModelVisualBounds(map.assets!.find(a=>a.id===o.assetId)!.modelJson) : null
      }));
      rows.push({ id:r.id, name:r.name, prompt:r.request?.prompt, tools:r.tools, previousDiagnostics:r.diagnostics, objects, waters:map.waterBodies, terrain:{resolution:[map.terrain.resolutionX,map.terrain.resolutionZ],min:Math.min(...map.terrain.heights),max:Math.max(...map.terrain.heights)}, note:'Local coordinates and AABBs are evidence for follow-up; do not equate bbox overlap or center-ground distance with visual failure.' });
    } catch(e) { rows.push({id:r.id,error:String(e)}); }
  }
  write('preflight.json',rows);
}

function sourceFiles(directory: string): string[] { return fs.readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?sourceFiles(path.join(directory,e.name)):[path.join(directory,e.name)]); }
const files = [...sourceFiles('src'), 'scripts/controlledApiStudy.ts','scripts/runControlledApiStudy.ts','scripts/apiAblationPreview.html'];
const hashes = Object.fromEntries(files.map(f=>[f,sha(fs.readFileSync(f,'utf8'))]));
const oldManifest = read<any>('manifest.json',null);
if (oldManifest && (JSON.stringify(oldManifest.sourceHashes)!==JSON.stringify(hashes) || oldManifest.assetMode!==mode)) throw Error('Frozen source changed; do not resume into a different experimental condition');
if (!oldManifest) {
  for (const f of files) write('source/'+f,fs.readFileSync(f,'utf8'));
  write('manifest.json',{createdAt:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceHashes:hashes,assetMode:mode,plannerProvider:'gpt',assetProvider:'deepseek',coreApis:CORE,fullApis:FULL,limit:LIMIT,primary:96,reserve:4,spatialPolicy:'diagnose',revisionMode:'first-pass',dimensions:[96,48,96],kitPrompt:KIT_PROMPT,reference:REFERENCE});
  for (const t of ledger.queue) write(`prompts/${t.key}.txt`,systemPrompt(t,mode));
}
save();
if (prepareOnly) { console.log('PREPARED 96 trials + 4 reserved; no model calls'); process.exit(0); }
const lock = path.join(output,'runner.lock');
if (fs.existsSync(lock)) {
  const pid = Number(fs.readFileSync(lock,'utf8'));
  let active = false; try { process.kill(pid,0); active=true; } catch { /* previous process exited */ }
  if (active) throw Error('Study runner already active');
  fs.unlinkSync(lock);
}
fs.writeFileSync(lock,String(process.pid),{flag:'wx'});
try {
  if (!ledger.folderId) ledger.folderId=(await mapCatalog(store).saveFolder({name:'API 对照 100 张 · 2026-09-25'})).id;
  for (const r of ledger.rounds.filter(r=>!['saved','failed','interrupted'].includes(r.status))) { r.status='interrupted';r.error='Previous runner stopped; slot retained without another model call.'; }
  ledger.status='running';save();
  for (let index=0;index<ledger.queue.length;index++) {
    const t=ledger.queue[index];
    if (ledger.rounds.some(r=>r.key===t.key)) continue;
    if (ledger.rounds.length>=LIMIT) break;
    const changed=files.filter(f=>sha(fs.readFileSync(f,'utf8'))!==hashes[f]);
    if(changed.length)throw Error('Source drift: '+changed.join(', '));
    const round: Round={...t,status:'preparing',startedAt:new Date().toISOString(),plannerProvider:'gpt',assetProvider:'deepseek'};
    ledger.rounds.push(round);progress(`开始 ${ledger.rounds.length}/${LIMIT} ${t.key}`);
    try {
      await withGenerationTrace(output,{trial:t,mode},async()=>{
        const scene=SCENES.find(s=>s.id===t.scene)!;
        const map=await store.saveMap({...createEmptyMap(`API100 ${scene.name} ${t.profile} ${t.stage} r${t.repeat}`,undefined,[96,48,96],mode,'outdoor'),seed:t.seed});
        round.mapId=map.id;await mapCatalog(store).move([map.id],ledger.folderId!);save();
        const assets:MapAsset[]=t.stage==='open-assets'?[]:await sharedKit(t);
        round.assetIds=assets.map(a=>a.id);round.kitHash=sha(JSON.stringify(assets.map(a=>({id:a.id,model:a.modelJson}))));
        const catalog=JSON.stringify(assets.map(a=>({id:a.id,name:a.name,prompt:a.prompt,localBounds:calculateModelVisualBounds(a.modelJson)})));
        const system=systemPrompt(t,mode,catalog),user=scene.prompt+(t.reference?'\n'+REFERENCE:'');
        round.status='planning';progress(`GPT 规划 ${t.key}`);
        const code=await chat(system,user,t.key);write(`${t.key}-code.js`,code);round.staticCalls=audit(code,t.profile);
        let bindings:Map<string,MapAsset[]>|undefined;
        if(t.stage==='open-assets') {
          const requirements=discoverMapCodeAssets(code,map,[],16);
          if(requirements.length<10||requirements.length>16||requirements.some(r=>r.variants!==1||r.mountOnAssetId||!r.dimensions))throw Error('Asset budget requires 10..16 distinct families with variants:1 and no mount');
          write(`${t.key}-requirements.json`,requirements);bindings=new Map();round.status='generating-assets';save();
          for(let i=0;i<requirements.length;i+=4) {
            const results=await Promise.allSettled(requirements.slice(i,i+4).map(async req=>{
              progress(`DeepSeek ${t.key}：${req.name}`);
              const asset=await generateAsset({...req,dimensions:req.dimensions??[1,1,1],role:req.role==='environment'?'environment':'structure'});
              bindings!.set(req.key,[asset]);assets.push(asset);write(`${t.key}-asset-bindings.json`,Object.fromEntries([...bindings!].map(([k,a])=>[k,a.map(x=>x.id)])));
            }));
            for(const r of results)if(r.status==='rejected')throw r.reason;
          }
          round.assetIds=assets.map(a=>a.id);round.kitHash=sha(JSON.stringify(assets.map(a=>({id:a.id,model:a.modelJson}))));
        }
        const result=executeMapCodePlan(code,map,assets,{scope:'scene',mode:'final',promptMode:t.profile==='minimal'?'minimal':'standard',legacyApis:false,spatialPolicy:'diagnose',maxNewAssets:t.stage==='open-assets'?16:0,assetBindings:bindings});
        write(`${t.key}-suggestion.json`,result);
        const committed=await store.commitTransaction(map.id,{label:`API100 ${t.key}`,source:'agent',operations:result.operations,ai:{prompt:user,codePlan:result.codePlan}});
        const loaded=await store.loadMap(map.id);write(`${t.key}-map.json`,loaded);
        Object.assign(round,{status:'saved',transactionId:committed.transaction.id,objectCount:loaded.objects.length,assetFamilies:assets.length,executedFunctions:result.codePlan?.functions??[],diagnostics:result.diagnostics??[],completedAt:new Date().toISOString()});
        progress(`已保存 ${t.key}，${loaded.objects.length} 个对象；截图中`);
        try {await capture(t,map.id);round.screenshots='complete';} catch(e){round.screenshotError=String(e);console.error('SCREENSHOT',String(e));}
      });
    }catch(e){Object.assign(round,{status:'failed',error:String(e),completedAt:new Date().toISOString()});console.error('FAILED',t.key,String(e));}
    save();
    // Two repeated matched pairs target the largest diagnostic disagreement; these are exploratory, not a visual verdict.
    if(index===95&&ledger.queue.length===96){
      const candidates=ledger.rounds.filter(r=>r.stage==='main'&&r.profile==='minimal').map(a=>{
        const b=ledger.rounds.find(r=>r.group===a.group&&r.profile==='full')!;
        const count=(r:Round)=>r.status!=='saved'?100:((r.diagnostics as any[])??[]).filter(d=>/overlap|ground|support|bounds|water/.test(d.code)).length/Math.max(1,Number(r.objectCount))*100;
        return {a,b,score:Math.abs(count(a)-count(b))};
      }).filter(p=>p.a.status==='saved'&&p.b?.status==='saved').sort((a,b)=>b.score-a.score).slice(0,2);
      for(const {a,b,score}of candidates)for(const base of [a,b])ledger.queue.push({...base,key:base.key+'-review',group:base.group+'-review',stage:'review',reviewReason:`Repeat matched pair with diagnostic-rate disagreement ${score.toFixed(2)}; no visual-quality claim.`});
      save();
    }
  }
  // Screenshot-only retries never consume a generation slot or change geometry.
  for(const r of ledger.rounds.filter(r=>r.status==='saved'&&r.screenshots!=='complete')) {
    try{await capture(r,r.mapId!);r.screenshots='complete';delete r.screenshotError;}catch(e){r.screenshotError=String(e);}save();
  }
  ledger.status='completed';progress(`完成：${ledger.rounds.length}/${LIMIT} 次尝试，${ledger.rounds.filter(r=>r.status==='saved').length} 张保存成功。`);
}catch(e){ledger.status='paused';ledger.progress=String(e);save();throw e;}
finally{if(browser)await browser.close();fs.unlinkSync(lock);}
