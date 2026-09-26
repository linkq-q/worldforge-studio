import { readFileSync, writeFileSync } from 'node:fs';

type Road = { id: string; width: number; points: number[][] };
type Arm = 'current' | 'topology' | 'qualitative';
type Run = { fixture: string; repeat: number; arm: Arm; status: string; code?: string; error?: string; failedAttempts?: string[]; retryPromptClarified?: boolean; functions?: string[]; diagnostics?: unknown[]; roads?: Road[]; objects?: Array<{ name: string; position: number[] }>; axisShare?: number; terrainRelief?: number; terrainHeights?: number[]; counterfactual?: { terrain: string; roads?: Road[]; error?: string }; verticality?: { error?: string; buildings?: number; centerElevationRange?: number; elevationBands2m?: number; medianOriginalFootprintRelief?: number; medianFinalFootprintRelief?: number; footprintReliefAbove1m?: number; highestGroundAboveOriginAbove05m?: number; medianDistanceToRoad?: number; moreThan8mFromRoad?: number; foundations?: number }; materializedMapId?: string; materializedObjectCount?: number };
const study = JSON.parse(readFileSync('scripts/roadTopologyStudy.json', 'utf8')) as {
  prompt: string; fixtures: Array<{ id: string; seed: number; amplitude?: number; roughness?: number; direction?: number; sourceMapId?: string }>; runs: Run[]
};
const armLabels: Record<Arm, string> = { current: '现有地形提示', topology: '拓扑候选＋数值选择', qualitative: '拓扑候选＋定性选择' };
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]!);
const median = (values: number[]) => {
  if (values.length === 0) return '—';
  const sorted = values.toSorted((a, b) => a - b);
  return String((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2);
};
const diagram = (run: Run) => {
  if (!run.roads || !run.terrainHeights) return `<div class="empty">${esc(run.error || run.failedAttempts?.at(-1) || '尚未规划')}</div>`;
  const size = 360, resolution = 30, terrainResolution = Math.round(Math.sqrt(run.terrainHeights.length));
  const coord = (x: number) => (x / 96 + 0.5) * size;
  const cells = Array.from({ length: resolution * resolution }, (_, index) => {
    const x = index % resolution, z = Math.floor(index / resolution);
    const tx = Math.floor(x / (resolution - 1) * (terrainResolution - 1));
    const tz = Math.floor(z / (resolution - 1) * (terrainResolution - 1));
    const height = run.terrainHeights![tz * terrainResolution + tx] ?? 0;
    const light = 22 + Math.min(20, Math.max(0, height) * 2.1);
    return `<rect x="${x * size / resolution}" y="${z * size / resolution}" width="${size / resolution + 0.3}" height="${size / resolution + 0.3}" fill="hsl(103 23% ${light}%)"/>`;
  }).join('');
  const routes = run.roads.map(road => `<polyline points="${road.points.map(point => `${coord(point[0])},${coord(point[1])}`).join(' ')}" fill="none" stroke="#e6d0a3" stroke-width="${Math.max(1.4, road.width * size / 96)}" stroke-linejoin="round" stroke-linecap="round" opacity=".85"/>`).join('');
  const objects = (run.objects ?? []).map(object => {
    const x = object.position[0], z = object.position[2];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return '';
    const structure = !/地基|基座|台阶|挡墙|平台|步道/i.test(object.name)
      && /屋|宅|会堂|礼堂|教堂|工坊|旅舍|驿舍|客栈|仓库|house|hall|chapel|inn/i.test(object.name);
    return structure
      ? `<rect x="${coord(x) - 2.6}" y="${coord(z) - 2.6}" width="5.2" height="5.2" rx=".7" fill="#e7a287" stroke="#1e2b21" stroke-width=".5"/>`
      : `<circle cx="${coord(x)}" cy="${coord(z)}" r="1.2" fill="#a4c281" opacity=".78"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="固定地形上的灰盒路网示意">${cells}${routes}${objects}</svg>`;
};
const card = (run: Run | undefined, arm: string) => {
  if (!run) return '<article class="card missing">缺少样本</article>';
  const userVisualAssessment = run.fixture === 'diagonal-valley' && run.repeat === 1
    ? `<p class="assessment">用户目测：${run.arm === 'qualitative' ? '形态完整，未见同类降质' : '形态异常，疑似降质'}</p>`
    : '';
  const failure = run.error || run.failedAttempts?.at(-1);
  const relevant = (run.functions ?? []).filter(name => ['environmentSample', 'sampleProbabilityField', 'route', 'routeNetwork', 'streetGrid', 'optimizeLayout'].includes(name));
  const swap = run.counterfactual ? run.counterfactual.error ? `地形互换重放失败：${esc(run.counterfactual.error)}` : `地形互换后：${run.counterfactual.roads?.length ?? '—'} 条道路` : '地形互换：待测';
  const v = run.verticality;
  const vertical = v && !v.error ? `<div class="vertical">主体建筑 ${v.buildings} 座 · 建筑中心标高跨度 ${v.centerElevationRange ?? '—'}m · 2m 标高层 ${v.elevationBands2m ?? '—'} 层<br>原地形/完成后建筑占地起伏中位 ${v.medianOriginalFootprintRelief ?? '—'} / ${v.medianFinalFootprintRelief ?? '—'}m · 占地起伏&gt;1m ${v.footprintReliefAbove1m ?? '—'} 座<br>建筑原点低于占地最高处&gt;0.5m ${v.highestGroundAboveOriginAbove05m ?? '—'} 座 · 离最近路&gt;8m ${v.moreThan8mFromRoad ?? '—'} 座 · 地基 ${v.foundations ?? '—'} 座</div>` : v?.error ? `<p class="error">立体指标重放失败：${esc(v.error)}</p>` : '';
  return `<article class="card"><div class="cardtop"><strong>${esc(arm)}</strong><span>${esc(run.status)}</span></div><div class="graphic">${diagram(run)}</div>${userVisualAssessment}<div class="numbers"><span><b>${run.roads?.length ?? '—'}</b> 道路</span><span><b>${run.objects?.length ?? '—'}</b> 灰盒物件</span><span><b>${run.axisShare ?? '—'}%</b> 轴向路段</span></div><p>使用：${esc(relevant.join('、') || '—')} · 未修复诊断 ${(run.diagnostics ?? []).length}<br>${swap}${run.retryPromptClarified ? '<br>高差组重试：统一补充坡道参数范围' : ''}</p>${vertical}${run.materializedMapId && run.materializedObjectCount ? `<p><a href="/?map=${esc(run.materializedMapId)}" target="_blank" rel="noreferrer">打开 DeepSeek 资产 3D 地图 ↗</a></p>` : ''}${run.status === 'failed' && failure ? `<p class="error">${esc(failure)}</p>` : ''}${run.code ? `<details><summary>查看首版 Code</summary><pre>${esc(run.code)}</pre></details>` : ''}</article>`;
};
const groups = study.fixtures.flatMap(fixture => [1, 2].map(repeat => {
  const title = fixture.id === 'broad-valley' ? '开阔山谷' : fixture.id === 'diagonal-valley' ? '斜向起伏山谷' : '滑雪场高差地形';
  const terrainDescription = fixture.sourceMapId ? '复用已有滑雪场高度场 · 0–15.95m' : `振幅 ${fixture.amplitude}m · 方向 ${fixture.direction}°`;
  const cards = (Object.keys(armLabels) as Arm[]).map(arm => card(study.runs.find(run => run.fixture === fixture.id && run.repeat === repeat && run.arm === arm), armLabels[arm])).join('');
  return `<section id="${esc(fixture.id)}-${repeat}"><div class="pairtitle"><h2>${title} · 第 ${repeat} 次</h2><p>同一预存地形 · seed ${fixture.seed} · ${terrainDescription}</p></div><div class="pair">${cards}</div></section>`;
})).join('');
const rows = (Object.keys(armLabels) as Arm[]).map(arm => {
  const runs = study.runs.filter(run => run.arm === arm);
  const saved = runs.filter(run => run.status === 'saved');
  return `<tr><th>${armLabels[arm]}</th><td>${saved.length}/${runs.length}</td><td>${median(saved.map(run => run.roads?.length ?? 0))}</td><td>${median(saved.map(run => run.axisShare ?? 0))}%</td><td>${median(saved.map(run => run.objects?.length ?? 0))}</td></tr>`;
}).join('');
const skiRuns = study.runs.filter(run => run.fixture === 'ski-relief' && run.status === 'saved');
const maxSkiBuildingSpread = Math.max(0, ...skiRuns.map(run => run.verticality?.centerElevationRange ?? 0));
const lowSkiBuildingSpread = skiRuns.filter(run => (run.verticality?.centerElevationRange ?? 0) <= 0.69).length;
const findings = `<section class="note" style="margin-bottom:38px"><h2>高差地形读图重点</h2><p>滑雪场高度场整体有 0～15.95m 高差，但这 ${skiRuns.length} 张灰盒中有 ${lowSkiBuildingSpread} 张的主体建筑中心标高跨度不超过 0.69m。另有一张达到 ${maxSkiBuildingSpread}m，原因是放了一座高处驿舍；不能说所有建筑都在坡底。以 4m 网格抽样、8×7m 建筑占地四角高差不超过 1m 作粗略检查，0～2m 标高有 312 个候选中心，6～8m 只有 5 个，14～16m 只有 1 个；候选中心会重叠，不能当作可建房屋数。模型集中低地有地形原因；要得到真正多层的聚落，需要连同建筑占地、局部筑台和上下通路一起设计。</p><p>“定性选择”是给模型的提示目标，不代表它每次照做：滑雪场第 1 张定性样本仍写了数值 routeCost。道路更弯或更少也不能单独证明适地、可走或立体。高差组 4 个初次失败样本在统一补明 rampTerrain 的 softness/strength 范围 0～1 后重试成功，报告逐卡标注了这一差别。</p></section>`;
const qualityFindings = `<section class="note" style="margin-bottom:38px"><h2>停止追加样本后的判断</h2><p>用户对下面斜向山谷第 1 次的三张图给出的目测判断是：第 1、2 张形态异常，疑似降质；第 3 张形态完整。这个标注是<strong>人工形态判断</strong>，不是已证实的模型服务分档，也不能据此推算降质发生率。当前 18 个规划槽位只有 14 个保存成功，且有效视觉样本更少，不适合用三组的道路数量中位数宣布哪种提示更好。</p><p>首版 Code 解释了这三张图为何不同：第 1 张调用了 6 次环境采样，却没有用采样值决定路网；第 2 张确实准备两套候选，但只用坡度和相邻点高差打分，无法判断节点为何连接、道路是否服务房屋和广场；第 3 张先比较两种连接结构，再给 24 座住宅与公共建筑分别接门前短路并局部整地。因此其 35 条“道路”中只有 6 条街巷骨架、2 条公共连接，其余 27 条是门前短路。217 个灰盒物件也包含大量地基、墙段和装饰，不能直接当成独立建筑数量。</p><p>第 3 张的组织层次更完整，却仍偏规则：其主体建筑中心标高跨度只有 0.81m，说明“看起来没有降质”和“真正顺应地形形成多层聚落”是两项不同判断。这里的规划 API <code>api.route</code> 只记录模型给的折线并铺路面，不会主动把路变成方格；直线或抽搐形态首先出自模型写入的点和选择准则。现有证据支持“只让模型读取地形不够、候选比较目标过窄、缺少建筑入口与高差关系”这些原因；不足以证明模型服务确实降档，或证明定性提示稳定胜出。</p></section>`;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>固定地形 · 村庄路网提示对照</title><style>
:root{font-family:Inter,"Microsoft YaHei",sans-serif;background:#111b1b;color:#e9eee7}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 90% 0,#254239,transparent 35rem),#111b1b}a{color:#b7e2ca}header,main,footer{max-width:1500px;margin:auto;padding:0 28px}header{padding-top:68px;padding-bottom:42px}h1{font-size:clamp(38px,5vw,66px);line-height:1.12;letter-spacing:-.05em;margin:12px 0 22px}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.18em;color:#9bd6b5}header p{max-width:900px;font-size:17px;line-height:1.75;color:#bfcfc2}.pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:22px}.pills span{border:1px solid #48695a;border-radius:99px;background:#1e342c;color:#d4e7d7;padding:8px 12px;font-size:12px}main{padding-bottom:70px}section{margin-bottom:54px}h2{font-size:26px;margin:0 0 12px}.note{max-width:1100px;background:#1b2d29;border:1px solid #3b5949;border-radius:15px;padding:20px 24px;color:#c8d8ca;line-height:1.8}.note code{color:#d8e7b7}.table{overflow:auto;border:1px solid #3b5949;border-radius:13px}table{border-collapse:collapse;min-width:620px;width:100%}th,td{text-align:left;padding:14px 17px;border-bottom:1px solid #344b40}tr:last-child>*{border:0}.pairtitle{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}.pairtitle p{font-size:13px;color:#9fb9a7}.pair{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.card{min-width:0;background:#1b2c29;border:1px solid #395549;border-radius:17px;padding:15px}.cardtop{display:flex;justify-content:space-between;margin-bottom:12px}.cardtop span{font-size:12px;color:#b5d5bf}.graphic{aspect-ratio:1;background:#20372c;border-radius:9px;overflow:hidden}.graphic svg{display:block;width:100%;height:100%}.empty{display:grid;place-items:center;height:100%;color:#dd9d88;padding:18px}.numbers{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:14px;color:#bdcebf;font-size:12px}.numbers b{font-size:20px;color:#f1e9ce}.card p{color:#9db8a5;font-size:12px;line-height:1.6}.card .assessment{color:#f4d494;background:#443c2b;border-radius:7px;padding:7px 9px}.card .error{color:#efaa99;overflow-wrap:anywhere}summary{cursor:pointer;color:#b5e4cc;font-size:13px}pre{max-height:520px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.55;background:#10211d;padding:12px;border-radius:8px}footer{color:#95aa9b;font-size:12px;padding-bottom:35px}@media(max-width:1100px){.pair{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:750px){.pair{grid-template-columns:1fr}header,main,footer{padding-left:16px;padding-right:16px}}
</style></head><body><header><span class="eyebrow">WORLDFORGE STUDIO / TERRAIN-AWARE STUDY</span><h1>地形会改变<br>村庄的空间组织吗？</h1><p>固定标准 Scene Code API、地图尺寸与每组的原始高度场，比较现有地形提示、数值打分的拓扑候选提示，以及不用数值打分的定性选择提示。每组独立生成两次。滑雪场高度场用于检查房屋落点与立体高差；这里先展示 GPT 首版灰盒。</p><div class="pills"><span>3 种固定地形 × 2 次 × 3 提示</span><span>96 × 16 × 96 中地图</span><span>GPT 规划</span><span>模型修复关 · 空间修复关</span><span>灰盒阶段</span></div></header><main><section><h2>读图边界</h2><div class="note">三组沿用相同 API；原始地形已预先写入输入地图，规划 Code 不允许重新生成基础地形。桃色方块表示按名称识别的主要建筑，绿色圆点表示其他物件；它们只显示中心点，<strong>不能据此证明地基、门口与道路可走</strong>。轴向路段占比描述接近水平或垂直的长度，<strong>不是美观或可玩性的评分</strong>。滑雪场只提供高度场，原 <a href="/?map=map-6ab5b068-3dc3-45fb" target="_blank" rel="noreferrer">3D 场景 ↗</a> 可作为立体效果参照。与上一轮完整资产地图对照请看 <a href="/scripts/plannerModeVillageReport.html#mode-terrain-aware">原总报告 ↗</a>。</div></section><section><h2>完成样本概览</h2><div class="table"><table><thead><tr><th>条件</th><th>完成</th><th>道路中位数</th><th>轴向路段占比中位数</th><th>灰盒物件中位数</th></tr></thead><tbody>${rows}</tbody></table></div></section>${groups}</main><footer>生成时间：${new Date().toLocaleString('zh-CN')} · 路网与物件来自首版 Code 运行后的地图操作；本页仅为灰盒示意。</footer></body></html>`;
writeFileSync('scripts/roadTopologyReport.html', html
  .replace('</header><main>', '<nav style="display:flex;gap:18px;flex-wrap:wrap;margin-top:24px"><a href="#broad-valley-1">开阔山谷</a><a href="#diagonal-valley-1">斜向山谷</a><a href="#ski-relief-findings">直接看滑雪场高差组 ↓</a></nav></header><main>')
  .replace('<section id="diagonal-valley-1">', `<div id="quality-findings">${qualityFindings}</div><section id="diagonal-valley-1">`)
  .replace('<section id="ski-relief-1">', `<div id="ski-relief-findings">${findings}</div><section id="ski-relief-1">`), 'utf8');
console.log('REPORT scripts/roadTopologyReport.html');
