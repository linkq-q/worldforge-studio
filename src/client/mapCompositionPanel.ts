import type { MapAiSuggestion } from '../shared/mapOperations';

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
        <span>实体验收 <b>${composition.outcome.repairCount > 0 ? `补齐 ${composition.outcome.repairCount}` : '通过'}</b></span>
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
