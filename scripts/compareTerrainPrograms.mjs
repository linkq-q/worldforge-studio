import {mkdir,writeFile,access} from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve('output/playwright/terrain-program-20261003');
const api = 'http://127.0.0.1:8797';
const prompt = '生成一片 500×500 米的自然山地：山体相连，有共同的宽厚基座、起伏的主山脊、一个主峰和高低大小不同的次峰，次级山脊从主脊分出。山体间有一条从西北高处向东南低地下降的主峡谷，几条大小不一的支流峡谷沿山坡汇入它，形成能看懂的分水岭、山间鞍部和树枝状谷网。峡谷上游窄浅、下游较宽深，谷底和谷坡自然过渡，不要等深圆管笔刷痕迹，不要孤立山包围成圆圈。只做自然地形，不要树木、城镇、道路、建筑或规划标记。';
await mkdir(directory,{recursive:true});
for (const representation of ['recipe','program']) {
  try {await access(path.join(directory,`${representation}-request.json`)); throw new Error(`already_started:${representation}`);}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
}
const results = await Promise.allSettled(['recipe','program'].map(async representation => {
  const request = {mode:'terrain-only',representation,prompt,seed:20261003,size:500};
  await writeFile(path.join(directory,`${representation}-request.json`),JSON.stringify(request,null,2));
  const started = Date.now();
  const response = await fetch(`${api}/api/editor/worlds/generate`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(1200000)
  });
  const raw = await response.text();
  await writeFile(path.join(directory,`${representation}-response.json`),raw);
  await writeFile(path.join(directory,`${representation}-timing.json`),JSON.stringify({status:response.status,elapsedMs:Date.now()-started}));
  if (!response.ok) throw new Error(`${representation}: ${response.status} ${raw}`);
  const result = JSON.parse(raw);
  await writeFile(path.join(directory,`${representation}-first-call.txt`),result.rawResponse);
  await writeFile(path.join(directory,`${representation}-bundle.json`),JSON.stringify(result.bundle));
  if (result.bundle.plan.recipe.terrainProgram) await writeFile(path.join(directory,'program-source.js'),result.bundle.plan.recipe.terrainProgram.source);
  console.log(JSON.stringify({representation,elapsedMs:Date.now()-started,paidCallCount:result.paidCallCount,heightRange:result.terrainEvidence.heightRange}));
}));
for (const result of results) if (result.status === 'rejected') {console.error(result.reason);process.exitCode=1;}
