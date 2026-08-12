import type { MapAiSuggestion } from '../shared/mapOperations';
import type { SceneCompositionPlan } from '../shared/sceneComposition';

export function renderMapCompositionPlanApproval(plan: SceneCompositionPlan): string {
  const colors = {
    primary: '#c6f45b',
    secondary: '#70b7ff',
    transition: '#f7bc5d',
    'negative-space': '#71808a'
  } as const;
  const roleLabels = {
    primary: '主区域',
    secondary: '次区域',
    transition: '过渡区域',
    'negative-space': '有意留白'
  } as const;
  const zones = [...plan.zones].sort((left, right) => left.importance - right.importance);
  const zoneShapes = zones.map((zone) => {
    const x = clamp((zone.region.center[0] + 1) * 50, 4, 96);
    const y = clamp((zone.region.center[1] + 1) * 50, 4, 96);
    const radius = clamp(zone.region.radius * 50, 5, 48);
    return `<g><circle cx="${x}" cy="${y}" r="${radius}" fill="${colors[zone.role]}" fill-opacity="${zone.role === 'negative-space' ? 0.18 : 0.32}" stroke="${colors[zone.role]}" stroke-width="1.2" ${zone.role === 'negative-space' ? 'stroke-dasharray="3 2"' : ''}/><text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(zone.label)}</text></g>`;
  }).join('');
  return `
    <section class="editor-section map-composition-approval" aria-label="待确认的俯视空间规划">
      <span class="stage-kicker">生成前规划</span>
      <h2>${escapeHtml(plan.summary)}</h2>
      <p class="empty">${escapeHtml(plan.globalBrief.visualHierarchy)}</p>
      <div class="map-composition-plan-grid">
        <svg viewBox="0 0 100 100" role="img" aria-label="房间俯视分区图">
          <rect x="1" y="1" width="98" height="98" rx="2" fill="#131c1f" stroke="#829096" stroke-width="1.4"/>
          ${zoneShapes}
        </svg>
        <div class="map-composition-zone-list">
          ${plan.zones.map((zone) => `
            <div class="map-composition-zone-item">
              <b><i style="background:${colors[zone.role]}"></i>${escapeHtml(zone.label)} · ${roleLabels[zone.role]}</b>
              <span>${escapeHtml(zone.brief.hierarchy || zone.brief.transitionIntent || zone.brief.atmosphere)}</span>
              ${zone.role === 'negative-space' ? `<small>留白用途：${escapeHtml(zone.brief.transitionIntent || zone.brief.hierarchy || '保证通行、视线或节奏')}</small>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
      <p class="empty inspector-note">此时尚未生成任何 3D 资产。确认后系统会锁定这份分区关系，再继续生成和自动质检。</p>
      <div class="map-ai-actions">
        <button id="discard-composition-plan" class="secondary">放弃并修改提示词</button>
        <button id="regenerate-composition-plan" class="secondary">重新规划</button>
        <button id="approve-composition-plan">确认规划并开始生成</button>
      </div>
    </section>
  `;
}

export function renderMapCompositionSummary(suggestion: MapAiSuggestion): string {
  const composition = suggestion.composition;
  if (!composition) return '';
  const focalZone = composition.plan.zones.find((zone) => zone.id === composition.plan.globalBrief.focalZoneId);
  const findings = [
    ...composition.consultations.flatMap((consultation) => consultation.findings),
    ...composition.review.findings
  ];
  const diagnostics = [...new Map((suggestion.diagnostics ?? []).map((issue) => [
    `${issue.repaired}:${issue.message}`,
    issue
  ])).values()];
  const outcomeWarnings = composition.outcome.checks.filter((check) => check.status === 'warning');
  return `
    <details class="inspector-disclosure compact map-ai-composition-details">
      <summary><span><b>生成结果详情</b><small>构图、分区与自动验收</small></span></summary>
      <div class="inspector-body asset-library-details">
      <p class="empty">场景构图</p>
      <div class="map-ai-stats">
        <span>区块 <b>${composition.metrics.zoneCount}</b></span>
        <span>覆盖 <b>${Math.round(composition.metrics.zoneCoverage * 100)}%</b></span>
        <span>焦点 <b>${escapeHtml(focalZone?.label ?? composition.plan.globalBrief.focalZoneId)}</b></span>
        <span>审查 <b>${composition.review.status === 'pass' ? '通过' : '已修正'}</b></span>
        <span>实体验收 <b>${outcomeWarnings.length > 0
          ? `自动降级 ${outcomeWarnings.length}`
          : composition.outcome.repairCount > 0 ? `补齐 ${composition.outcome.repairCount}` : '通过'}</b></span>
      </div>
      <p class="empty">${escapeHtml(composition.plan.globalBrief.visualHierarchy)}</p>
      <div class="style-tags">
        ${composition.plan.zones.map((zone) => `<span>${escapeHtml(zone.label)} · ${zone.role}</span>`).join('')}
      </div>
      ${composition.consultations.length > 0 ? `
        <p class="empty">动态专家：${composition.consultations.map((item) => escapeHtml(item.id)).join('、')}</p>
      ` : ''}
      ${findings.length > 0 ? `
        <div class="style-tags">
          ${findings.map((finding) => `<span>${escapeHtml(finding.message)}</span>`).join('')}
        </div>
      ` : ''}
      <p class="empty">${composition.outcome.checks.map((check) => escapeHtml(check.message)).join(' · ')}</p>
      ${diagnostics.length > 0 ? `
        <div class="map-ai-composition-quality">
          <p class="empty">自动质检</p>
          <div class="style-tags">${diagnostics.map((issue) => `
            <span>${issue.repaired ? '已修复' : '建议'} · ${escapeHtml(issue.message)}</span>
          `).join('')}</div>
        </div>
      ` : ''}
      </div>
    </details>
  `;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[character] ?? character);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
