import { readFileSync, writeFileSync } from 'node:fs';

const reportPath = 'scripts/plannerModeVillageReport.html';
const studyPath = 'scripts/roadTopologyStudy.json';
const html = readFileSync(reportPath, 'utf8');
const study = JSON.parse(readFileSync(studyPath, 'utf8')) as {
  runs: Array<{ fixture: string; arm: string; status: string; verticality?: { buildings?: number; centerElevationRange?: number } }>;
};
const ski = study.runs.filter(run => run.fixture === 'ski-relief');
const valid = ski.filter(run => run.status === 'saved');
const begin = '<!-- ROAD_TOPOLOGY_STUDY_BEGIN -->';
const end = '<!-- ROAD_TOPOLOGY_STUDY_END -->';
const block = `${begin}<section id="mode-road-topology-study" class="intro" style="margin-top:72px">
  <h2>下一轮：固定地形与立体村庄</h2>
  <div class="info">保持标准 Scene Code API，用同一高度场对比现有提示、数值打分的拓扑候选、无需数值打分的定性选择；失败样本最多独立重试一次，不启用模型或空间修复。滑雪场高差地形共 ${valid.length}/${ski.length} 个首版灰盒可执行。俯视图只是布局示意，房屋占地、入口连接与真实三维可走性仍需在地图里检验。</div>
  <p class="hint"><a href="/scripts/roadTopologyReport.html" target="_blank" rel="noreferrer">单独打开完整实验页 ↗</a> · 下方可在本报告内直接对照全部样本。</p>
  <iframe title="固定地形与立体村庄实验" src="/scripts/roadTopologyReport.html" loading="lazy" style="width:100%;height:1300px;border:1px solid #365149;border-radius:18px;background:#111b1b"></iframe>
</section>${end}`;
let next: string;
const oldStart = html.indexOf(begin);
if (oldStart >= 0) {
  const oldEnd = html.indexOf(end, oldStart);
  if (oldEnd < 0) throw new Error('road_study_end_marker_missing');
  next = html.slice(0, oldStart) + block + html.slice(oldEnd + end.length);
} else {
  const insertion = html.lastIndexOf('</main>');
  if (insertion < 0) throw new Error('planner_report_main_missing');
  next = html.slice(0, insertion) + block + html.slice(insertion);
}
writeFileSync(reportPath, next, 'utf8');
console.log(`EMBEDDED ${reportPath}`);
