import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Pass an absolute output directory');
const runs = (JSON.parse(readFileSync('scripts/mainModeComparison.json', 'utf8')) as { runs: Run[] }).runs;
type Run = { name: string; prompt: string; seed: number; full: string; minimal: string;
  mapId?: string; status: string; objectCount?: number; assetCount?: number; error?: string;
  attempt?: number; code?: string; minNewAssets?: number; maxNewAssets?: number;
  interruptedBudgetAttempt?: { minNewAssets: number; maxNewAssets: number; stage: string };
  discardedResults?: { attempt: number; mapId: string; reason: string }[];
  failures?: { attempt: number; error: string }[];
  earlierAttempts?: { mapId?: string; error?: string }[]; retest?: Run; improved?: Run; terrain?: Run; ground?: Run };
const retestFile = 'scripts/mainModeRetest.json';
const retests = existsSync(retestFile)
  ? new Map((JSON.parse(readFileSync(retestFile, 'utf8')) as { runs: Run[] }).runs.map(run => [run.name, run]))
  : new Map<string, Run>();
for (const run of runs) run.retest = retests.get(run.name);
const improvedFile = 'scripts/mainModeImprovedComparison.json';
const improvedRuns = existsSync(improvedFile)
  ? new Map((JSON.parse(readFileSync(improvedFile, 'utf8')) as { runs: Run[] }).runs.map(run => [run.name, run]))
  : new Map<string, Run>();
for (const run of runs) run.improved = improvedRuns.get(run.name);
const terrainFile = 'scripts/terrainSettlementRerun.json';
const terrainRuns = existsSync(terrainFile)
  ? new Map((JSON.parse(readFileSync(terrainFile, 'utf8')) as { runs: Run[] }).runs.map(run => [run.name, run]))
  : new Map<string, Run>();
for (const run of runs) run.terrain = terrainRuns.get(run.name);
const groundFile = 'scripts/groundCoverComparison.json';
const groundRuns = existsSync(groundFile)
  ? new Map((JSON.parse(readFileSync(groundFile, 'utf8')) as { runs: Run[] }).runs.map(run => [run.name, run]))
  : new Map<string, Run>();
for (const run of runs) run.ground = groundRuns.get(run.name);
type Review = { winner: 'full' | 'minimal' | 'main' | 'improved' | 'terrain' | 'ground' | 'tie' | 'undecided'; note: string };
const reviewFile = 'scripts/mainModeComparisonReviews.json';
const reviews = existsSync(reviewFile) ? JSON.parse(readFileSync(reviewFile, 'utf8')) as Record<string, Review> : {};
const improvedReviewFile = 'scripts/mainModeImprovedReviews.json';
const improvedReviews = existsSync(improvedReviewFile)
  ? JSON.parse(readFileSync(improvedReviewFile, 'utf8')) as Record<string, Review> : {};
const terrainReviewFile = 'scripts/terrainSettlementReviews.json';
const terrainReviews = existsSync(terrainReviewFile)
  ? JSON.parse(readFileSync(terrainReviewFile, 'utf8')) as Record<string, Review> : {};
const groundReviewFile = 'scripts/groundCoverReviews.json';
const groundReviews = existsSync(groundReviewFile)
  ? JSON.parse(readFileSync(groundReviewFile, 'utf8')) as Record<string, Review> : {};
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const labels = { full: '旧全规划 + DeepSeek', minimal: '旧精简规划 + DeepSeek',
  main: '上一轮主模式 + DeepSeek', improved: '改进后主模式 + DeepSeek',
  terrain: '本轮地形聚落主模式 + DeepSeek', ground: '道路草层改进后主模式 + DeepSeek' } as const;
const traceDir = 'data/map-editor/logs/generation-2026-09-26';
const attempts = new Map<string, { at: string; code: string; gptAttempts: number }[]>();
const improvedAttempts = new Map<string, { at: string; attempt: number; code: string }[]>();
const groundAttempts = new Map<string, { at: string; attempt: number; code: string }[]>();
const assetAttempts = new Map<string, number>();
for (const file of readdirSync(traceDir).filter(name => name.endsWith('.jsonl'))) {
  const lines = readFileSync(path.join(traceDir, file), 'utf8').trim().split('\n');
  try {
    const first = JSON.parse(lines[0]);
    if (first.type !== 'run.start') continue;
    const operation = String(first.data?.operation);
    if (!/^main-mode-(comparison|retest)-/.test(operation)
      && operation !== 'improved-main-comparison-plan'
      && operation !== 'ground-cover-comparison-plan') continue;
    const events = lines.map(line => JSON.parse(line));
    if (operation === 'improved-main-comparison-plan' || operation === 'ground-cover-comparison-plan') {
      const response = events.find(row => row.type === 'chat.response' && row.data?.stage === 'map.initial-plan');
      const code = response?.data?.response?.content;
      if (typeof code === 'string') {
        const target = operation === 'ground-cover-comparison-plan' ? groundAttempts : improvedAttempts;
        const list = target.get(first.data.scene) ?? [];
        list.push({ at: first.at, attempt: Number(first.data.attempt), code });
        target.set(first.data.scene, list);
      }
      continue;
    }
    if (String(first.data.operation).endsWith('-generate')) {
      assetAttempts.set(first.data.scene, (assetAttempts.get(first.data.scene) ?? 0)
        + events.filter(row => row.type === 'asset.attempt.start').length);
      continue;
    }
    const response = events.find(row => row.type === 'chat.response' && row.data?.stage === 'map.initial-plan');
    const code = response?.data?.response?.content;
    if (typeof code !== 'string') continue;
    const list = attempts.get(first.data.scene) ?? [];
    list.push({ at: first.at, code, gptAttempts: events.filter(row => row.type === 'chat.attempt.start').length });
    attempts.set(first.data.scene, list);
  } catch { /* An in-progress trace is shown when complete. */ }
}
for (const list of attempts.values()) list.sort((a, b) => a.at.localeCompare(b.at));
for (const list of improvedAttempts.values()) list.sort((a, b) => a.at.localeCompare(b.at));
for (const list of groundAttempts.values()) list.sort((a, b) => a.at.localeCompare(b.at));
function picture(index: number, mode: keyof typeof labels, view: 'top' | 'oblique'): string {
  const file = path.join(output, 'images', `${String(index + 1).padStart(2, '0')}-${mode}-${view}.png`);
  if (!existsSync(file)) return '<div class="missing">该视图尚未生成</div>';
  const src = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  return `<img src="${src}" loading="lazy" alt="${escape(labels[mode])} · ${view === 'top' ? '俯视' : '45°'}" title="点击放大">`;
}
const sections = runs.map((run, index) => {
  const review = groundReviews[run.name] ?? terrainReviews[run.name] ?? improvedReviews[run.name] ?? reviews[run.name];
  const latest = run.retest?.status === 'saved' ? run.retest : run;
  const attemptCount = 1 + (run.earlierAttempts?.length ?? 0)
    + (run.retest && ['saved', 'failed'].includes(run.retest.status) ? 1 : 0);
  const modes: (keyof typeof labels)[] = run.terrain
    ? ['full', 'minimal', 'main', 'improved', 'terrain']
    : run.improved ? ['full', 'minimal', 'main', 'improved'] : ['full', 'minimal', 'main'];
  if (run.ground) modes.unshift('ground');
  const cards = modes.map(mode => {
    const current = mode === 'ground' ? run.ground : mode === 'terrain' ? run.terrain : mode === 'improved' ? run.improved : mode === 'main' ? latest : undefined;
    const id = current ? (current.status === 'saved' ? current.mapId : undefined) : run[mode as 'full' | 'minimal'];
    const status = mode === 'ground'
      ? `${current?.status === 'saved' ? '已生成' : current?.status === 'failed' ? '失败' : '生成中'} · 资产 ${current?.minNewAssets ?? '?'}–${current?.maxNewAssets ?? '?'} · 第 ${current?.attempt ?? 1} 次首版`
      : mode === 'terrain'
      ? `${current?.status === 'saved' ? '已生成' : current?.status === 'failed' ? '失败' : '生成中'} · 资产 ${current?.minNewAssets ?? '?'}–${current?.maxNewAssets ?? '?'} · 第 ${current?.attempt ?? 1} 次首版`
      : mode === 'improved'
      ? `${current?.status === 'saved' ? '已生成' : current?.status === 'failed' ? '失败' : '生成中'} · 资产 ${current?.minNewAssets ?? '?'}–${current?.maxNewAssets ?? '?'} · 第 ${current?.attempt ?? 1} 次生成`
      : mode === 'main'
        ? `${latest.status === 'saved' ? '已生成' : '失败'} · 第 ${attemptCount} 次首版尝试${latest === run.retest ? '（修复后）' : ''} · 资产 0–16`
        : '旧记录';
    return `<article class="card${mode === 'ground' ? ' current' : ''}"><div class="cardhead"><h3>${mode === 'ground' ? '本轮新增 · ' : ''}${labels[mode]}</h3><span>${escape(status)}</span></div>
      <div class="view"><b>俯视图</b>${picture(index, mode, 'top')}</div>
      <div class="view"><b>45°视图</b>${picture(index, mode, 'oblique')}</div>
      ${id ? `<a href="http://127.0.0.1:5180/?map=${encodeURIComponent(id)}" target="_blank" rel="noreferrer">在编辑器中打开地图</a>` : ''}
      ${current?.status === 'saved' ? `<small>${current.objectCount ?? '?'} 个物件 · ${current.assetCount ?? '?'} 个资产</small>` : ''}
      ${current?.status === 'failed' && current.error ? `<p class="error">${escape(current.error)}</p>` : ''}
      ${index === 4 && mode === 'full' ? '<p class="caution">旧防雷塔资产有 26 个无效几何节点；本页截图仅在内存中跳过这些节点，保存的原地图未改。</p>' : ''}
    </article>`;
  }).join('');
  const winner = review?.winner === 'tie' ? '并列' : review?.winner === 'undecided' ? '暂不判定' : review?.winner ? labels[review.winner] : '待评价';
  const failures = [...(run.earlierAttempts ?? []), ...(run.status === 'failed' ? [{ error: run.error }] : []),
    ...(run.retest?.status === 'failed' ? [{ error: run.retest.error }] : [])];
  const prior = failures.map((attempt, i) => `<p class="error">第 ${i + 1} 次首版失败：${escape(attempt.error)}</p>`).join('');
  const codeDetails = (attempts.get(run.name) ?? []).map((attempt, i) => `<details><summary>GPT 首版代码 · 第 ${i + 1} 次尝试</summary><pre>${escape(attempt.code)}</pre></details>`).join('');
  const improvedEvidence = run.improved ? `${run.improved.interruptedBudgetAttempt ? `<p class="caution">改进轮正式生成前，曾以资产 ${run.improved.interruptedBudgetAttempt.minNewAssets}–${run.improved.interruptedBudgetAttempt.maxNewAssets} 启动 1 次，已在资产阶段中断，未保存地图；这次不计为有效对照。${escape(run.improved.interruptedBudgetAttempt.stage)}</p>` : ''}
    ${(run.improved.discardedResults ?? []).map(item => `<p class="caution">改进轮第 ${item.attempt} 次结果已作废（地图 ${escape(item.mapId)}）：${escape(item.reason)} 报告只展示后续重生成结果。</p>`).join('')}
    ${(run.improved.failures ?? []).map(item => `<p class="error">改进轮第 ${item.attempt} 次有效首版失败：${escape(item.error)}</p>`).join('')}
    ${run.improved.code ? `<details><summary>改进轮 GPT 首版代码 · 第 ${run.improved.attempt ?? 1} 次生成</summary><pre>${escape(run.improved.code)}</pre></details>`
      : run.improved.status === 'failed' ? (improvedAttempts.get(run.name) ?? []).filter(item => item.attempt === run.improved?.attempt).slice(-1)
        .map(item => `<details><summary>本次失败的 GPT 首版代码 · 第 ${item.attempt} 次生成</summary><pre>${escape(item.code)}</pre></details>`).join('') : ''}` : '';
  const terrainEvidence = run.terrain ? `${(run.terrain.failures ?? []).map(item => `<p class="error">本轮第 ${item.attempt} 次首版失败：${escape(item.error)}</p>`).join('')}
    ${run.terrain.code ? `<details><summary>本轮 GPT 首版代码 · 第 ${run.terrain.attempt ?? 1} 次</summary><pre>${escape(run.terrain.code)}</pre></details>` : ''}` : '';
  const groundEvidence = run.ground ? `${(run.ground.failures ?? []).map(item => `<p class="error">道路草层改进轮第 ${item.attempt} 次首版失败：${escape(item.error)}</p>`).join('')}
    ${(groundAttempts.get(run.name) ?? []).map(item => `<details><summary>道路草层改进轮 GPT 首版代码 · 第 ${item.attempt} 次</summary><pre>${escape(item.code)}</pre></details>`).join('')}` : '';
  return `<section id="scene-${index + 1}"><div class="sectionhead"><span class="number">${String(index + 1).padStart(2, '0')}</span><div><h2>${escape(run.name)}</h2><p>原提示词：${escape(run.prompt)}</p><small>尺寸 96 × 16 × 96 · 新图种子 ${run.seed}${index === 0 ? '；旧精简图种子另为 1431999235' : ''}</small></div></div>
    <div class="grid${run.improved || run.ground ? ' four' : ''}"${run.terrain || run.ground ? ' style="grid-template-columns:repeat(auto-fit,minmax(250px,1fr))"' : ''}>${cards}</div>
    <div class="assessment"><div><strong>${run.ground?.status === 'saved' && groundReviews[run.name] ? '本轮同题判断' : run.terrain?.status === 'saved' && terrainReviews[run.name] ? '五图判断' : run.improved?.status === 'saved' && improvedReviews[run.name] ? '四图判断' : '当前可见图判断'}：${escape(winner)}</strong><p>${escape(review?.note ?? '新图或截图尚未齐备，暂不判定。')}</p></div>
      <label>你的评语<textarea data-scene="${escape(run.name)}" placeholder="在这里写下你的观察。内容保存在当前浏览器；可用页面顶部按钮导出。"></textarea></label></div>
    <div class="evidence">${prior}${codeDetails}${improvedEvidence}${terrainEvidence}${groundEvidence}</div>
  </section>`;
}).join('');
const canyon = terrainRuns.get('峡谷村庄');
const canyonReview = terrainReviews['峡谷村庄'];
const canyonSection = canyon ? `<section id="scene-13"><div class="sectionhead"><span class="number">13</span><div><h2>峡谷村庄</h2><p>本轮新增提示词：${escape(canyon.prompt)}</p><small>尺寸 96 × 16 × 96 · 种子 ${canyon.seed} · 资产 ${canyon.minNewAssets}–${canyon.maxNewAssets}；没有相同提示词的旧图，山谷聚落只作跨地形参考</small></div></div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))"><article class="card"><div class="cardhead"><h3>${labels.terrain}</h3><span>${escape(canyon.status)} · 第 ${canyon.attempt ?? 1} 次首版</span></div>
    <div class="view"><b>俯视图</b>${picture(12, 'terrain', 'top')}</div><div class="view"><b>45°视图</b>${picture(12, 'terrain', 'oblique')}</div>
    ${canyon.status === 'saved' && canyon.mapId ? `<a href="http://127.0.0.1:5180/?map=${encodeURIComponent(canyon.mapId)}" target="_blank" rel="noreferrer">在编辑器中打开地图</a><small>${canyon.objectCount ?? '?'} 个物件 · ${canyon.assetCount ?? '?'} 个资产</small>` : ''}
    ${canyon.error ? `<p class="error">${escape(canyon.error)}</p>` : ''}</article>
    <article class="card"><div class="cardhead"><h3>山谷密集石屋村庄 · 本轮参考</h3><span>不同提示词，不计同题胜负</span></div>
    <div class="view"><b>俯视图</b>${picture(3, 'terrain', 'top')}</div><div class="view"><b>45°视图</b>${picture(3, 'terrain', 'oblique')}</div></article></div>
  <div class="assessment"><div><strong>本轮观察：${canyonReview ? escape(canyonReview.winner === 'undecided' ? '暂不判定' : canyonReview.winner === 'tie' ? '并列' : labels[canyonReview.winner]) : '待评价'}</strong><p>${escape(canyonReview?.note ?? '截图齐备后评价峡谷地形、聚落选址和通行关系。')}</p></div>
    <label>你的评语<textarea data-scene="峡谷村庄" placeholder="写下你对峡谷村庄的观察。"></textarea></label></div>
  <div class="evidence">${(canyon.failures ?? []).map(item => `<p class="error">第 ${item.attempt} 次首版失败：${escape(item.error)}</p>`).join('')}
    ${canyon.code ? `<details><summary>本轮 GPT 首版代码 · 第 ${canyon.attempt ?? 1} 次</summary><pre>${escape(canyon.code)}</pre></details>` : ''}</div></section>` : '';
const failureRows = runs.flatMap(run => [...(run.earlierAttempts ?? []), ...(run.status === 'failed' ? [{ error: run.error }] : []),
  ...(run.retest?.status === 'failed' ? [{ error: run.retest.error }] : [])]
  .map((attempt, index) => {
    const error = attempt.error ?? '未知错误';
    const kind = error.includes('invalid_map_code_surface') ? 'surface 参数格式'
      : error.includes('unknown_map_environment_water') ? '水体 ID 不一致'
      : error.includes('map_code_asset_prompt_too_long') ? '资产提示词超长' : '其他规划错误';
    return `<tr><td>${escape(run.name)}</td><td>第 ${index + 1} 次</td><td>${escape(kind)}</td><td><code>${escape(error)}</code></td><td>${index >= 2 ? assetAttempts.get(run.name) ?? 0 : 0}</td></tr>`;
  })).join('');
const gptTotal = [...attempts.values()].flat().reduce((sum, attempt) => sum + attempt.gptAttempts, 0);
const assetTotal = [...assetAttempts.values()].reduce((sum, count) => sum + count, 0);
const savedCount = runs.filter(run => run.status === 'saved' || run.retest?.status === 'saved').length;
const failedCount = runs.length - savedCount;
const failedAttempts = runs.reduce((sum, run) => sum + (run.earlierAttempts?.length ?? 0)
  + (run.status === 'failed' ? 1 : 0) + (run.retest?.status === 'failed' ? 1 : 0), 0);
const improvedFailureRows = runs.flatMap(run => (run.improved?.failures ?? []).map(item =>
  `<tr><td>${escape(run.name)}</td><td>第 ${item.attempt} 次有效首版</td><td><code>${escape(item.error)}</code></td></tr>`)).join('');
const improvedDiagnosis = `<h3>改进轮生成记录</h3><p>四个重点场景沿用原提示词和种子，并匹配各自旧图的资产预算。执行脚本初次误用旧主模式城中村地图 ID，将 8 个新资产写入旧图；发现后立即中断，并通过项目事务撤销恢复旧图，核对为原有 129 个物件和 8 个资产。那 8 个资产任务不属于有效对照，可能产生费用。其后城中村还曾以 0–16 启动一次，8 个资产任务中 7 个完成时中断，未提交地图；正式 22–32 轮另起空地图。斗兽场第 1 次有效首版在 GPT 上游请求阶段失败，独立第 2 次成功；该错误不是场景 Code 的接口报错，也没有触发 DeepSeek 资产生成。教堂第一次改进结果被用户判定质量异常并作废；第二次 GPT 首版把 <code>requireAsset.variants</code> 写成文字数组，执行器要求 1–8 的整数，故在生成 DeepSeek 资产前失败。报告展示该失败和首版代码，不再展示作废图。实际计费需查供应商账单。以下是改进轮的失败原文：</p>
${improvedFailureRows ? `<div class="tablewrap"><table><thead><tr><th>场景</th><th>有效首版</th><th>原始错误</th></tr></thead><tbody>${improvedFailureRows}</tbody></table></div>` : '<p>暂无失败。</p>'}`;
const groundDiagnosis = groundRuns.size ? `<h3>道路材质与草层改进后三场景</h3><p>教堂第 1 次首版成功；滑雪场第 1 次 GPT 输出在资产提示字符串中途结束，语法校验失败，第 2 次成功；雨林两次首版都把 <code>api.route</code> 写成执行器不接受的双参数形式，按约定停止。三次失败都发生在 DeepSeek 资产生成前。本轮成功保存 2 张地图，共 27 个新资产；雨林没有本轮新图，不能判断雨林中的道路与草层效果。报告保留失败代码和错误，费用仍须按供应商账单核对。</p>` : '';
const diagnosis = `<section id="diagnosis"><h2>失败与成本核对</h2>
<p>12 个场景中，${savedCount} 个已保存新主模式地图，${failedCount} 个目前没有可比较的新图；累计 ${failedAttempts} 次失败的首版尝试。日志记录了 ${gptTotal} 次 GPT 上游请求尝试、${assetTotal} 次 DeepSeek 资产上游请求尝试。这里统计的是请求尝试，不是供应商账单；日志没有可核对的 token 用量或金额，不能据此推算实际费用。旧轮的 14 次规划失败均发生在生成资产之前；修复后的新轮按时间线逐场景重测，一旦失败立即停止。</p>
<div class="tablewrap"><table><thead><tr><th>场景</th><th>首版尝试</th><th>原因类别</th><th>原始错误</th><th>本次 DeepSeek 资产尝试</th></tr></thead><tbody>${failureRows}</tbody></table></div>
<h3>原始失败原因与已做的修复</h3><ol>
<li><strong>surface 参数格式：</strong>原首版代码有时使用 <code>api.surface(id,{surface,region,...})</code>，执行器却只接受单对象或位置参数形式，因而把配置对象当成表面类型。现在执行器也接受这个明确的双参数形式，并在提示中给出标准单对象示例。</li>
<li><strong>水体 ID 不一致：</strong>原首版代码用中文名声明水体后，又用同一名称采样；执行器保存时会归一化 ID，采样时过去却按原字符串查找。现在同一份程序内的水体声明名会解析为实际 ID，提示也要求复用 <code>api.water(...)</code> 的返回值。</li>
<li><strong>资产提示词超长：</strong>上一轮的执行器限制单个资产提示词不超过 1200 字符，因此超长首版代码会在资产生成前失败；这是当时的规则，改进轮已移除该上限。</li>
</ol><p>上段记录的是上一轮生成时的规则。随后改进轮已移除单个资产提示词 1200 字符硬上限，并恢复建筑模块与聚落布局引导；因此新一轮结果还受到提示词和执行规则变化影响。先前的本地重放为 19 次中 18 次可执行，剩余一次资产提示词长达 1494 字符，在当时的硬上限处失败。之后对原先失败的 7 个场景重新调用 GPT 和 DeepSeek，7 个新首版均成功保存。重测没有启用可选代码或空间修复；历史失败与原首版代码仍在本页保留。日志只够统计请求尝试，不能计算真实费用。</p>${improvedDiagnosis}${groundDiagnosis}</section>`;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WorldForge 主模式与旧全规划／精简规划对照</title>
<style>
:root{color-scheme:dark;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#0c1219;color:#e6edf5}*{box-sizing:border-box}body{margin:0}a{color:#9bd5ff}header{padding:36px max(28px,4vw);background:linear-gradient(125deg,#172a3a,#101a25);border-bottom:1px solid #38506a}h1{font-size:clamp(26px,3vw,44px);margin:0 0 12px}header p{max-width:1100px;line-height:1.65;color:#c0d2e3}nav{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}nav a{border:1px solid #3c5366;padding:6px 10px;text-decoration:none;border-radius:6px}button{background:#245576;border:1px solid #6d9bb6;color:#fff;padding:9px 15px;border-radius:6px;cursor:pointer}main{padding:0 max(20px,3vw) 60px}section{padding:32px 0;border-bottom:1px solid #304355}.sectionhead{display:flex;gap:18px;align-items:start;margin-bottom:20px}.number{font-size:30px;color:#79bddb;font-weight:800}h2{margin:0;font-size:27px}.sectionhead p{margin:6px 0}.sectionhead small{color:#9db0c0}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.grid.four{grid-template-columns:repeat(4,minmax(0,1fr))}.card{min-width:0;background:#17222e;border:1px solid #354b60;border-radius:10px;padding:13px}.card.current{border:2px solid #55c8d5;background:#18313a}.cardhead{display:flex;justify-content:space-between;gap:8px;align-items:center}h3{font-size:18px;margin:0}.cardhead span,.card small{font-size:12px;color:#a7c0d0}.view{margin-top:12px}.view b{display:block;font-size:13px;color:#c3d7e5;margin-bottom:5px}.view img{width:100%;aspect-ratio:1200/760;object-fit:contain;display:block;background:#03070a;cursor:zoom-in;border-radius:4px}.missing{aspect-ratio:1200/760;background:#0c1720;display:grid;place-items:center;color:#9baebc}.card a,.card small{display:block;margin-top:9px}.error,.caution{font-size:13px;color:#ffc2a2;overflow-wrap:anywhere}.assessment{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:16px;padding:16px;border-left:4px solid #6dbddd;background:#142838}.assessment p{line-height:1.7;margin:8px 0 0}.assessment label{font-weight:700}.assessment textarea{display:block;width:100%;min-height:90px;margin-top:8px;background:#0b1924;border:1px solid #50677a;border-radius:5px;color:#fff;padding:10px;font:inherit;resize:vertical}.evidence{margin-top:12px}.evidence details{margin:7px 0;padding:8px 12px;background:#18232e;border:1px solid #344c5d;border-radius:5px}.evidence summary{cursor:pointer}.evidence pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:500px;overflow:auto;font-size:12px}dialog{border:0;padding:8px;background:#101820;max-width:95vw;max-height:95vh}dialog img{display:block;max-width:92vw;max-height:90vh}dialog::backdrop{background:#000d}.tablewrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:8px;border:1px solid #38506a;text-align:left;vertical-align:top}td code{overflow-wrap:anywhere}ol li{line-height:1.7;margin:10px 0}@media(max-width:1250px){.grid.four{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:1000px){.grid{grid-template-columns:1fr}.assessment{grid-template-columns:1fr}}@media(max-width:650px){.grid.four{grid-template-columns:1fr}}
</style><body><header><h1>同一场景，旧规划与改进主模式对照</h1><p><strong>本轮更新：</strong>第 3 节哥特式大教堂、第 11 节雪山滑雪度假村、第 12 节热带雨林神庙遗迹。每节最左侧青色边框为本轮结果；雨林两次首版失败，所以显示失败记录，没有新图。</p><p>按旧生成时间线排列的 12 个场景，并加入山谷聚落、城中村复跑及新场景峡谷村庄；教堂、滑雪场和雨林另加入道路材质与草层调整后的主模式结果。规划使用 GPT，资产使用 DeepSeek，代码修复和空间修复关闭。图片由同一查看器、同一画幅和固定俯视／45°机位截取，未套用新渲染方案。峡谷村庄没有同提示词旧图，山谷聚落仅作跨地形参考；我的判断是视觉初评，不代替实际行走验收。</p>
<p>新图沿用对应旧场景的种子，城中村除外：它的两张旧图本来就采用不同种子，本页新图沿用旧全规划种子。改进轮按旧图实际请求匹配资产预算：城中村 22–32，其余三组 0–16；上一轮主模式统一使用 0–16；本轮教堂、滑雪场、雨林也使用 0–16。初轮失败的场景先独立重试一次；修复执行接口后，再各做一次新的首版尝试。每次代码和错误均保留。关闭的是可选代码与空间修复；执行器仍会做内置的基础归一化。新旧图的尝试次数和执行器版本不同，解释视觉胜负时应考虑这一点。</p>
<nav>${runs.map((r,i)=>`<a href="#scene-${i+1}">${i+1}. ${escape(r.name)}</a>`).join('')}${canyon ? '<a href="#scene-13">13. 峡谷村庄</a>' : ''}<a href="#diagnosis">失败分析</a></nav><button id="export">导出我的评语 JSON</button></header><main>${sections}${canyonSection}${diagnosis}</main><dialog id="zoom"><img alt="放大视图"></dialog>
<script>
const key=name=>'worldforge-main-comparison:'+name;
document.querySelectorAll('textarea[data-scene]').forEach(t=>{try{t.value=localStorage.getItem(key(t.dataset.scene))||''}catch{}t.addEventListener('input',()=>{try{localStorage.setItem(key(t.dataset.scene),t.value)}catch{}})});
document.getElementById('export').onclick=()=>{const data={};document.querySelectorAll('textarea[data-scene]').forEach(t=>data[t.dataset.scene]=t.value);const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.download='我的场景评语.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};
const d=document.getElementById('zoom');document.querySelectorAll('.view img').forEach(img=>img.onclick=()=>{d.querySelector('img').src=img.src;d.showModal()});d.onclick=e=>{if(e.target===d)d.close()};
</script></body></html>`;
writeFileSync(path.join(output, 'mainModeComparison.html'), html);
console.log(`REPORT ${path.join(output, 'mainModeComparison.html')} ${Math.round(Buffer.byteLength(html) / 1024 / 1024)} MiB`);
