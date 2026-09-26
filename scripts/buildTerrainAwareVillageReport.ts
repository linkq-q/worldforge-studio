import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MapStore } from '../src/server/mapStore';
import type { EditableMap } from '../src/shared/map';

type Entry = { label: string; group: string; mapId: string; code?: string; functions?: string[]; diagnostics?: Array<{ code: string; repaired?: boolean }> };
const root = path.resolve('data/map-editor/experiments');
const prior = JSON.parse(readFileSync(path.join(root, 'experiment-3d736527-6eb3-41f0.json'), 'utf8'));
const study = JSON.parse(readFileSync('scripts/terrainAwareVillageStudy.json', 'utf8'));
if (study.runs.some((run: { status: string }) => run.status !== 'saved')) throw new Error('four_new_maps_required');
const oldEntries = (caseIndex: number, group: string): Entry[] => prior.runs
  .filter((run: { caseIndex: number; status: string }) => run.caseIndex === caseIndex && run.status === 'completed')
  .sort((a: { repeat: number }, b: { repeat: number }) => a.repeat - b.repeat)
  .map((run: { id: string; repeat: number; mapId: string; functions?: string[] }) => {
    const result = JSON.parse(readFileSync(path.join(root, prior.id, `${run.id}.result.json`), 'utf8'));
    return { label: `${group} ${run.repeat}`, group, mapId: run.mapId,
      code: result.suggestion.codePlan?.code, functions: run.functions,
      diagnostics: result.suggestion.diagnostics };
  });
const entries: Entry[] = [
  ...study.runs.map((run: { repeat: number; mapId: string; code: string; functions?: string[]; diagnostics?: Entry['diagnostics'] }) => ({
    label: `地形感知 ${run.repeat}`, group: '地形感知标准模式', mapId: run.mapId,
    code: run.code, functions: run.functions, diagnostics: run.diagnostics
  })),
  ...oldEntries(0, '原标准模式'),
  ...oldEntries(6, '老师 D · 生成选择')
];
const store = new MapStore();
await store.ensureReady();
const maps = new Map<string, EditableMap>();
for (const entry of entries) maps.set(entry.mapId, await store.loadMap(entry.mapId));
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]!);
const buildingName = /住宅|民居|石屋|房屋|屋舍|会堂|礼堂|教堂|工坊|旅店|客栈|仓库|磨坊|钟楼|house|hall|chapel/i;
const stats = (map: EditableMap) => {
  const visible = map.objects.filter(object => object.assetId);
  const heights = map.terrain.heights;
  let total = 0, aligned = 0;
  for (const guide of map.guides) for (let index = 1; index < guide.points.length; index++) {
    const dx = guide.points[index][0] - guide.points[index - 1][0];
    const dz = guide.points[index][1] - guide.points[index - 1][1];
    const length = Math.hypot(dx, dz);
    total += length;
    if (Math.min(Math.abs(dx), Math.abs(dz)) <= length * Math.sin(Math.PI / 18)) aligned += length;
  }
  return {
    objects: map.objects.length, assets: new Set(visible.map(object => object.assetId)).size,
    buildings: visible.filter(object => buildingName.test(object.name)).length,
    guides: map.guides.length, foundations: map.objects.filter(object => object.foundation).length,
    relief: `${Math.min(...heights).toFixed(1)}～${Math.max(...heights).toFixed(1)}`,
    axis: total > 0 ? Math.round(aligned / total * 100) : 0
  };
};
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[1] + sorted[2]) / 2;
};
const groups = ['地形感知标准模式', '原标准模式', '老师 D · 生成选择'];
const summaryRows = groups.map(group => {
  const groupEntries = entries.filter(entry => entry.group === group);
  const numbers = groupEntries.map(entry => stats(maps.get(entry.mapId)!));
  return `<tr><th>${esc(group)}</th><td>${numbers.length}/4</td><td>${median(numbers.map(item => item.objects))}</td><td>${median(numbers.map(item => item.buildings))}</td><td>${median(numbers.map(item => item.guides))}</td><td>${median(numbers.map(item => item.axis))}%</td></tr>`;
}).join('');
const diagram = (map: EditableMap) => {
  const size = 300;
  const sx = (x: number) => (x / map.box.size[0] + 0.5) * size;
  const sz = (z: number) => (z / map.box.size[2] + 0.5) * size;
  const resolution = 24;
  const cells = Array.from({ length: resolution * resolution }, (_, index) => {
    const x = index % resolution, z = Math.floor(index / resolution);
    const tx = Math.floor(x / (resolution - 1) * (map.terrain.resolutionX - 1));
    const tz = Math.floor(z / (resolution - 1) * (map.terrain.resolutionZ - 1));
    const height = map.terrain.heights[tz * map.terrain.resolutionX + tx] ?? 0;
    const hue = height < 0 ? 198 : 90 - Math.min(35, height * 4);
    const light = height < 0 ? 24 : 17 + Math.min(20, height * 2.1);
    return `<rect x="${x * size / resolution}" y="${z * size / resolution}" width="${size / resolution + 0.3}" height="${size / resolution + 0.3}" fill="hsl(${hue} 29% ${light}%)"/>`;
  }).join('');
  const waters = map.waterBodies.map(water => {
    const points = water.points.map(point => `${sx(point[0])},${sz(point[1])}`).join(' ');
    return water.type === 'river'
      ? `<polyline points="${points}" fill="none" stroke="#5f9dad" stroke-width="${Math.max(3, water.width * size / map.box.size[0])}" opacity=".78"/>`
      : `<polygon points="${points}" fill="#3e788b" opacity=".7"/>`;
  }).join('');
  const roads = map.guides.map(guide => `<polyline points="${guide.points.map(point => `${sx(point[0])},${sz(point[1])}`).join(' ')}" fill="none" stroke="#ddc79a" stroke-width="${Math.max(1.4, guide.width * size / map.box.size[0])}" stroke-linejoin="round" stroke-linecap="round" opacity=".8"/>`).join('');
  const objects = map.objects.filter(object => object.assetId && object.transform?.position).map(object => {
    const [x, , z] = object.transform.position;
    return buildingName.test(object.name)
      ? `<rect x="${sx(x) - 3.3}" y="${sz(z) - 3.3}" width="6.6" height="6.6" rx="1" fill="#e5a488" stroke="#19251f" stroke-width=".8"/>`
      : `<circle cx="${sx(x)}" cy="${sz(z)}" r="1.7" fill="#a7c583" opacity=".8"/>`;
  }).join('');
  return `<svg class="map" viewBox="0 0 ${size} ${size}" role="img" aria-label="地图俯视数据示意">${cells}${waters}${roads}${objects}<rect x=".5" y=".5" width="299" height="299" fill="none" stroke="#8ca497"/></svg>`;
};
const cards = (group: string) => entries.filter(entry => entry.group === group).map(entry => {
  const map = maps.get(entry.mapId)!;
  const s = stats(map);
  const used = (entry.functions ?? []).filter(name => ['environmentSample', 'sampleProbabilityField', 'foundation', 'route', 'rampTerrain'].includes(name));
  const warnings = (entry.diagnostics ?? []).filter(issue => !issue.repaired).length;
  return `<article class="card"><div class="card-heading"><h3>${esc(entry.label)}</h3><span class="tag">${esc(entry.mapId)}</span></div>${diagram(map)}<div class="numbers"><span><b>${s.objects}</b> 物件</span><span><b>${s.assets}</b> 使用资产</span><span><b>${s.buildings}</b> 建筑候选</span><span><b>${s.guides}</b> 道路</span></div><p class="fine">地形 ${s.relief}m · 地基 ${s.foundations} · 轴向路段 ${s.axis}% · 未修复诊断 ${warnings}</p><p class="fine">相关调用：${esc(used.join('、') || '无')}</p><div class="actions"><a href="http://127.0.0.1:5180/?map=${esc(entry.mapId)}" target="_blank" rel="noreferrer">打开 3D 地图 ↗</a>${group === '地形感知标准模式' ? `<details><summary>查看首版 Code</summary><pre>${esc(entry.code)}</pre></details>` : ''}</div></article>`;
}).join('');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>地形感知村庄 · 四次生成对照</title><style>
:root{font-family:Inter,"Microsoft YaHei",sans-serif;color:#e6eee6;background:#101b1b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 84% 2%,#2c4942,transparent 34rem),#101b1b}a{color:#a8e5cd}a:hover{color:#fff}header,main,footer{max-width:1450px;margin:auto;padding:0 32px}header{padding-top:74px;padding-bottom:54px}.eyebrow{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#a8d9bd;font-weight:800}h1{font-size:clamp(42px,5vw,70px);line-height:1.12;letter-spacing:-.055em;margin:13px 0 18px}header p{max-width:880px;color:#c4d3ca;font-size:18px;line-height:1.8}.pills{display:flex;flex-wrap:wrap;gap:9px;margin-top:22px}.pills span,.tag{border:1px solid #4d7061;background:#20372f;border-radius:99px;padding:8px 12px;color:#cde8d6;font-size:12px}main{padding-bottom:100px}section{margin-bottom:70px}h2{font-size:30px;letter-spacing:-.04em;margin:0 0 20px}.note{max-width:1100px;color:#d0dcd2;line-height:1.85;background:#1b302b;border:1px solid #3c5a4d;border-radius:16px;padding:20px 24px}.table-wrap{overflow:auto;border-radius:16px;border:1px solid #3d5b50;background:#1b2c29}table{border-collapse:collapse;min-width:720px;width:100%}th,td{text-align:left;padding:14px 16px;border-bottom:1px solid #344b42}th{color:#e8efe5}td{color:#bfd0c3}tr:last-child>*{border-bottom:0}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}@media(max-width:1100px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:650px){.grid{grid-template-columns:1fr}header,main,footer{padding-left:17px;padding-right:17px}}.card{background:#1a2b29;border:1px solid #395449;border-radius:17px;padding:15px;min-width:0}.card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:12px}.card h3{font-size:19px;margin:2px 0}.tag{font-size:10px;white-space:nowrap;padding:5px 7px}.map{width:100%;display:block;border-radius:9px;background:#263b2e}.numbers{display:flex;flex-wrap:wrap;gap:7px 13px;margin-top:14px;color:#c5d3c7;font-size:12px}.numbers b{font-size:17px;color:#f3eed7}.fine{font-size:12px;line-height:1.6;color:#abc0b2;margin:10px 0}.actions{border-top:1px solid #355047;margin-top:13px;padding-top:13px;font-size:13px}.actions a{font-weight:700}details{margin-top:12px}summary{cursor:pointer;color:#a8e5cd}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:500px;overflow:auto;background:#10201d;padding:12px;border-radius:8px;font-size:11px;line-height:1.5}footer{color:#9ab0a1;padding-bottom:40px;font-size:12px}code{color:#f0e2b6}
</style></head><body><header><span class="eyebrow">WorldForge Studio / Terrain-aware settlement study</span><h1>同一座山谷，<br>让规划先读取地形</h1><p>在标准完整能力模式中加入一段简短的适地规划原则后，重新独立生成四座石屋村庄，与此前的原标准模式和老师 D「生成选择」各四座并列查看。</p><div class="pills"><span>4 张新图 + 8 张旧图</span><span>同一需求 · 96 × 16 × 96 中地图</span><span>同一 map seed：${study.baseSeed}</span><span>GPT 规划 / DeepSeek 资产</span><span>模型修复关 / 空间修复关</span></div></header><main><section><h2>如何读这次对照</h2><div class="note">新图与旧实验使用相同的村庄请求、地图尺寸、地图种子及生成配置。每张图仍由 GPT 独立编写 Code，资产独立交给 DeepSeek 生成。新增提示只讲依赖顺序和选择原则，不指定道路必须弯曲或规则。图块是地图数据的俯视示意；建筑类别按名称粗分类，轴向路段比例仅表示接近水平或垂直方向的道路长度，<strong>两者都不能代替 3D 可通行性判断</strong>。点开地图查看实际场景。完整旧实验见 <a href="/scripts/plannerModeVillageReport.html">八模式对照报告 ↗</a>。</div></section><section><h2>四次结果的中位数</h2><div class="table-wrap"><table><thead><tr><th>模式</th><th>完成</th><th>物件</th><th>建筑候选</th><th>道路数</th><th>轴向路段长度占比</th></tr></thead><tbody>${summaryRows}</tbody></table></div></section><section><h2>这轮看到了什么</h2><div class="note">新提示确实让四份首版 Code 都调用了地形采样、地基和路线能力；其中两份也用连续场采样安排自然物。然而，四张俯视图仍以近乎平行的纵路和横向街巷为骨架，轴向道路占比依次为 99%、82%、98%、95%，中位数 96.5%；原标准模式为 88.5%，老师 D「生成选择」为 27.5%。<strong>在这四张村庄样本里，新增原则没有改善道路形态，反而伴随更强的格网倾向。</strong>这说明“调用了采样 API”与“用采样结果改变构图”是两件事；也不能仅凭道路曲直判定整体质量。第四张在成功前有两次首版 Code 执行失败，均未开启修复，最终另做独立规划；展示的是四张成功地图，并非全部尝试的成功率。样本较少、模型输出随机，以上是观察结果，不是提示词造成退化的因果证明；实际通行性仍需逐图游走。</div></section><section><h2>新方案 · 地形感知标准模式</h2><div class="grid">${cards('地形感知标准模式')}</div></section><section><h2>原标准完整能力</h2><div class="grid">${cards('原标准模式')}</div></section><section><h2>老师 D · 生成选择</h2><div class="grid">${cards('老师 D · 生成选择')}</div></section><section><h2>更早的个人结果</h2><div class="note">此前的 <a href="http://127.0.0.1:5180/?map=map-09beb297-3da6-4230" target="_blank" rel="noreferrer">山谷密集石屋村庄 ↗</a> 可作为审美与可游览性的补充参照。它不属于本次严格对照组，不能把与它的差异全部归因于新增提示。</div></section></main><footer>生成时间：${new Date().toLocaleString('zh-CN')} · 地图数据经 MapStore 读取；俯视示意不是 3D 截图。</footer></body></html>`;
writeFileSync('scripts/terrainAwareVillageReport.html', html, 'utf8');
console.log('REPORT scripts/terrainAwareVillageReport.html');

// Keep the original eight-mode report intact and add the new four-run comparison there.
const originalPath = 'scripts/plannerModeVillageReport.html';
const startMarker = '<!-- terrain-aware-study:start -->';
const endMarker = '<!-- terrain-aware-study:end -->';
const original = readFileSync(originalPath, 'utf8');
const sectionCards = entries.filter(entry => entry.group === '地形感知标准模式').map(entry => {
  const map = maps.get(entry.mapId)!;
  const s = stats(map);
  const used = (entry.functions ?? []).filter(name => ['environmentSample', 'sampleProbabilityField', 'foundation', 'route', 'rampTerrain'].includes(name));
  return `<article class="map-card"><div class="card-head"><b>${esc(entry.label)}</b><span class="status">已保存</span></div><div class="map-graphic">${diagram(map)}</div><div class="numbers"><span><b>${s.objects}</b> 物件</span><span><b>${s.assets}</b> 资产</span><span><b>${s.buildings}</b> 建筑候选</span><span><b>${s.guides}</b> 道路</span></div><p class="substats">地形 ${s.relief}m · 地基 ${s.foundations} · 轴向路段 ${s.axis}%<br>相关调用：${esc(used.join('、') || '无')}</p><div class="actions"><a href="http://127.0.0.1:5180/?map=${esc(entry.mapId)}" target="_blank" rel="noreferrer">打开 3D 地图 ↗</a><details><summary>首版 Code</summary><pre>${esc(entry.code)}</pre></details></div></article>`;
}).join('');
const inserted = `${startMarker}<section class="mode" id="mode-terrain-aware"><div class="mode-title"><span class="index">NEW / 4</span><div><h2>地形感知标准模式 · 四张新图</h2><p>标准完整能力增加适地规划原则；其余条件与原实验一致。失败尝试没有纳入四张样本。</p></div><span class="mode-count">4 / 4 已保存</span></div><div class="info" style="margin-bottom:16px">下面四张与本报告的「标准完整能力」和「老师 D · 生成选择」各四张直接并列比较。摘要：${groups.map(group => `${esc(group)}的物件中位数 ${median(entries.filter(entry => entry.group === group).map(entry => stats(maps.get(entry.mapId)!).objects))}、轴向道路占比中位数 ${median(entries.filter(entry => entry.group === group).map(entry => stats(maps.get(entry.mapId)!).axis))}%`).join('；')}。<b>本轮没有改善道路形态：</b>新四张均呈纵横格网，轴向占比中位数比原标准更高；虽然 Code 调用了地形采样，采样结果并未明显改变道路骨架。第四张成功前两次首版执行失败，均未修复而重新独立规划。这个小样本只能支持上述观察，不能证明提示词造成了退化；实际可游览性仍需逐图检查。完整分析与数据说明见 <a href="/scripts/terrainAwareVillageReport.html">新增实验报告 ↗</a>。</div><div class="cards">${sectionCards}</div></section>${endMarker}`;
let updated: string;
if (original.includes(startMarker) && original.includes(endMarker)) {
  updated = original.replace(new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`), inserted);
} else {
  const anchor = '<section class="mode" id="mode-0">';
  if (!original.includes(anchor)) throw new Error('original_report_anchor_missing');
  updated = original.replace(anchor, `${inserted}${anchor}`);
}
writeFileSync(originalPath, updated, 'utf8');
console.log(`REPORT ${originalPath}`);
