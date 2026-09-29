import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { urbanCityCases } from './urbanCityCases';

const modulePath=process.env.STUDY_PLAYWRIGHT ?? 'C:/Users/31483/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(pathToFileURL(modulePath).href);
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-webgl']});
const draft=process.argv.includes('--draft');
const only=process.argv.find(arg=>arg.startsWith('--id='))?.slice(5);
const promptFile=process.argv.find(arg=>arg.startsWith('--prompt-file='))?.slice('--prompt-file='.length);
const promptRecord=promptFile?JSON.parse(readFileSync(promptFile,'utf8')):null;
const captureId=process.argv.find(arg=>arg.startsWith('--capture-id='))?.slice('--capture-id='.length) ?? 'pompeii';
const finish=process.argv.find(arg=>arg.startsWith('--finish='))?.slice('--finish='.length);
if(finish&&!/^[a-z0-9-]+$/.test(finish))throw Error('Invalid finish');
if(!/^[a-z0-9-]+$/.test(captureId))throw Error('Invalid capture ID');
const cases=promptRecord?[{id:captureId,name:promptRecord.prompt,prompt:promptRecord.prompt}]:urbanCityCases;
const readLedger=(id:string)=>promptRecord ?? JSON.parse(readFileSync(`${directory}/${id}.json`,'utf8'));
const directory='output/urban-city-study';
mkdirSync(`${directory}/images`,{recursive:true});
const records=[];
try {
  for(const scene of cases){
    if(only && scene.id!==only)continue;
    const ledger=readLedger(scene.id);
    const page=await browser.newPage({viewport:{width:1200,height:840},deviceScaleFactor:1});
    const errors:string[]=[];
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    const query=(draft?`draft=${scene.id}`:`map=${ledger.mapId}`)+(finish?`&finish=${finish}`:'');
    await page.goto(`http://127.0.0.1:5180/scripts/urbanCityPreview.html?${query}&capture`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=> (window as any).cityStudy?.ready || (window as any).cityStudyError,undefined,{timeout:90_000});
    const error=await page.evaluate(()=> (window as any).cityStudyError);
    if(error)throw Error(error);
    for(const view of ['top','oblique','near']){
      await page.evaluate((v:string)=>(window as any).cityStudy.view(v),view);
      await page.screenshot({path:`${directory}/images/${scene.id}${draft?'-draft':''}-${view}.png`});
    }
    const motion=await page.evaluate(async()=>{
      const {viewer,controls,frame,stats}=(window as any).cityStudy;
      viewer.renderer.info.autoReset=false;
      const times=[];
      for(let i=0;i<24;i++){
        const a=i/24*Math.PI*2, distance=95+35*Math.sin(i/24*Math.PI*2);
        viewer.camera.position.set(Math.cos(a)*distance,65+20*Math.cos(a),Math.sin(a)*distance);
        viewer.camera.lookAt(controls.target);
        viewer.renderer.info.reset();
        const start=performance.now();frame();viewer.renderer.getContext().finish();times.push(performance.now()-start);
        await new Promise(requestAnimationFrame);
      }
      return {...stats,frameMs:times,drawCalls:viewer.renderer.info.render.calls,triangles:viewer.renderer.info.render.triangles};
    });
    records.push({id:scene.id,mapId:ledger.mapId,draft,errors,...motion});
    console.log(`${scene.id}: ${JSON.stringify(records.at(-1))}`);
    await page.close();
  }
}finally{await browser.close();}
writeFileSync(`${directory}/capture${promptRecord?'-'+captureId:''}${draft?'-draft':''}.json`,JSON.stringify(records,null,2));
const html=(value:unknown)=>String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const cards=cases.map(scene=>{
  const ledger=readLedger(scene.id), query=(draft?`draft=${scene.id}`:`map=${ledger.mapId}`)+(finish?`&finish=${finish}`:'');
  return `<article><h2>${html(scene.name)}</h2><p>${html(scene.prompt)}</p><div class="images">${['top','oblique','near'].map(view=>`<a href="/scripts/urbanCityPreview.html?${query}&view=${view}"><img src="images/${scene.id}${draft?'-draft':''}-${view}.png"></a>`).join('')}</div><p>${draft?'规划灰盒':`<a href="/?map=${ledger.mapId}">在编辑器打开</a>`} · ${ledger.objectCount ?? '?'} 个物体 · ${ledger.assetCount ?? 0} 个 DeepSeek 资产</p></article>`;
}).join('');
const report=`${directory}/${promptRecord?captureId:'index'}.html`;
writeFileSync(report,`<!doctype html><meta charset="utf-8"><title>WorldForge 城市布局研究</title><style>body{font:16px system-ui;background:#13202a;color:#e5eef1;margin:40px}h1{font-size:30px}article{margin:40px 0;padding:24px;background:#20303c;border-radius:12px}p{color:#bfccd6}a{color:#86daca}.images{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}img{width:100%;border-radius:6px}</style><h1>WorldForge · 城市布局研究</h1><p>GPT 空间规划 / DeepSeek 实体资产 / 原生 Three.js 查看器 / 未施加渲染方案</p>${cards}`);
console.log(path.resolve(report));
