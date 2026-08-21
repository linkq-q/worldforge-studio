import type { MapAiSuggestion } from '../shared/mapOperations';
import type { EditableMap } from '../shared/map';
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
              <small>布局：${zone.symmetry === 'asymmetric'
                ? '非对称'
                : `默认对称 · ${zone.symmetryAxis === 'z' ? 'Z' : 'X'} = 区域中心`}</small>
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

export function renderMapCodePlanApproval(suggestion: MapAiSuggestion): string {
  const plan = suggestion.codePlan;
  if (!plan) return '';
  const requirements = plan.assetRequirements ?? [];
  const total = requirements.reduce((sum, item) => sum + item.variants, 0);
  return `
    <section class="editor-section map-composition-approval" aria-label="待确认的室内功能规划">
      <span class="stage-kicker">生成前规划</span>
      <h2>${escapeHtml(suggestion.summary)}</h2>
      <p class="empty">AI 已统一确定门窗、功能关系与摆放逻辑；此时尚未生成任何 3D 资产。</p>
      <div class="map-ai-stats">
        <span>摆放意图 <b>${plan.placementCount}</b></span>
        <span>资产变体 <b>${total}</b></span>
        <span>自动修复 <b>${plan.repairAttempts ?? 0}</b></span>
      </div>
      <div class="style-tags">${requirements.map((item) => `
        <span>${escapeHtml(item.name)} · ${item.role === 'decor' ? '装饰' : '功能'} · ${item.variants} 个${item.optional ? ' · 可选' : ''}</span>
      `).join('')}</div>
      ${renderMapCodePlanSummary(suggestion)}
      <div class="map-ai-actions">
        <button id="discard-code-plan" class="secondary">放弃并修改提示词</button>
        <button id="regenerate-code-plan" class="secondary">重新规划</button>
        <button id="approve-code-plan">确认规划并开始生成</button>
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
  const placementQuality = mapCompositionPlacementQuality(
    composition.metrics.initialObjectCount ?? composition.metrics.objectCount,
    composition.metrics.objectCount
  );
  return `
    <div class="map-composition-quality map-composition-quality-${placementQuality.tone}">
      <div><b>${placementQuality.label}</b>
      <span>初始规划正常落位 <b>${placementQuality.initial} / ${placementQuality.total}</b> · ${placementQuality.percent}%</span></div>
      ${placementQuality.tone !== 'good' ? '<button id="repair-map-ai-composition" class="secondary compact">再次提升规划</button>' : ''}
    </div>
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
        ${composition.plan.zones.map((zone) => `<span>${escapeHtml(zone.label)} · ${zone.role} · ${zone.symmetry === 'asymmetric' ? '非对称' : `${zone.symmetryAxis === 'z' ? 'Z' : 'X'}轴对称`}</span>`).join('')}
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

export function renderMapCodePlanSummary(suggestion: MapAiSuggestion): string {
  const codePlan = suggestion.codePlan;
  if (!codePlan) return '';
  const failedAssetIssues = (suggestion.diagnostics ?? [])
    .filter((issue) => (issue.code === 'asset.generation-degraded' || issue.code === 'asset.unplaced') && !issue.repaired);
  return `
    ${failedAssetIssues.length > 0 ? `
      <div class="map-composition-quality map-composition-quality-warning">
        <div><b>部分资产待修复</b><span>${failedAssetIssues.map((issue) => escapeHtml(issue.message)).join(' · ')}</span></div>
        <button id="repair-map-ai-assets" class="secondary compact">修复失败项</button>
      </div>
    ` : ''}
    <details class="inspector-disclosure compact map-code-plan-details">
      <summary><span><b>场景 Code 详情</b><small>${codePlan.sceneIntent === 'authored' ? '营造场景' : codePlan.sceneIntent === 'natural' ? '自然场景' : '通用场景'} · ${codePlan.placementCount} 个摆放意图 · ${codePlan.functions.length} 种工具</small></span></summary>
      <div class="inspector-body asset-library-details">
        ${codePlan.sceneIntentReason ? `<p>${escapeHtml(codePlan.sceneIntentReason)}</p>` : ''}
        <div class="style-tags">${codePlan.functions.map((name) => `<span>${escapeHtml(mapCodeFunctionLabel(name))}</span>`).join('')}</div>
        <pre class="map-code-plan-source"><code>${escapeHtml(codePlan.code)}</code></pre>
      </div>
    </details>
  `;
}

export function renderMapDesignSummary(map: EditableMap): string {
  const design = map.designSemantics;
  if (design.groups.length === 0) return '';
  const experience = design.experienceMode === 'immediate' ? '直接聚焦'
    : design.experienceMode === 'sequential' ? '逐步展开' : '混合体验';
  return `
    <details class="inspector-disclosure compact map-design-details">
      <summary><span><b>设计组与焦点</b><small>${experience} · ${design.groups.length} 组 · ${design.focuses.length} 个焦点</small></span></summary>
      <div class="inspector-body asset-library-details">
        ${design.intent ? `<p class="empty">${escapeHtml(design.intent)}</p>` : ''}
        <div class="style-tags">${design.groups.map((group) => {
          const focuses = design.focuses.filter((focus) => focus.groupId === group.id);
          const layers = group.layers.map((layer) => `${layer.level}级${layer.density === 'tight' ? '密' : layer.density === 'open' ? '疏' : '中'}`).join('、');
          return `<button type="button" class="secondary compact" data-map-design-group="${escapeHtml(group.id)}">${escapeHtml(group.name)} · ${focuses.length} 焦点${layers ? ` · ${escapeHtml(layers)}` : ''}</button>`;
        }).join('')}</div>
        ${design.focuses.length > 0 ? `<div class="style-tags">${design.focuses.map((focus) => `<span>${focus.kind === 'primary' ? '主焦点' : focus.kind === 'secondary' ? '次焦点' : '节点'} · ${escapeHtml(focus.name)} · ${focus.reveal === 'visible' ? '直接可见' : focus.reveal === 'framed' ? '框景' : focus.reveal === 'screened' ? '遮景' : '逐步揭示'}</span>`).join('')}</div>` : ''}
      </div>
    </details>
  `;
}

export function renderMapGenerationFailure(
  failure: { detail: string; retainedCandidate: boolean; replayAvailable?: boolean } | null,
  busy = false
): string {
  if (!failure) return '';
  return `
    <section class="editor-section map-ai-result">
      <span class="stage-kicker">生成未完成</span>
      <h2>${failure.retainedCandidate ? '已保留最后可用结果' : '当前地图未受影响'}</h2>
      <p class="empty inspector-note">${failure.replayAvailable
        ? '资产已经保存。重新重放只恢复本轮布局，不会再次请求 AI 或生成重复资产。'
        : '错误只作为提示，不会阻断编辑。可以直接修改提示词，也可以让系统重新尝试。'}</p>
      <details class="inspector-disclosure compact"><summary><span><b>错误详情</b><small>用于排查</small></span></summary><p class="empty inspector-body">${escapeHtml(failure.detail)}</p></details>
      <div class="map-ai-actions"><button id="retry-map-ai" class="secondary" ${busy ? 'disabled' : ''}>${failure.replayAvailable ? '重新重放布局' : '重新尝试'}</button></div>
    </section>
  `;
}

function mapCodeFunctionLabel(name: string): string {
  return ({
    sceneIntent: '场景判断', design: '构图设计', terrain: '基础地形', modifyTerrain: '地形塑形', refineTerrain: '地形细化',
    surface: '地表绘制', route: '游览路线', water: '水体', grass: '草地', spawn: '出生点', renderSuggestion: '渲染建议',
    requireAsset: '新资产', asset: '选择资产', place: '物体摆放', placeBetween: '连接摆放',
    roomPoint: '房间坐标', wallFrame: '墙面定位', ceilingPoint: '天花定位', opening: '门窗预留', attach: '附件连接',
    linePoint: '直线路径', bezierPoint: '曲线路径', sampleBezier: '曲线采样',
    sampleBezierFrames: '曲线朝向', sampleBezierFramesBySpacing: '等距曲线', circlePoint: '环形布局',
    gridPoints: '网格布局', poissonDisk: '自然散布', noise2D: '噪声变化', fbm2D: '自然变化',
    random: '随机变化', rotate2D: '旋转', distance2D: '距离', tangentYaw: '沿线朝向', faceYaw: '面向目标',
    clamp: '范围限制', lerp: '渐变', remap: '数值映射', smoothstep: '平滑过渡'
  } as Record<string, string>)[name] ?? name;
}

export function mapCompositionPlacementQuality(initialObjectCount: number, objectCount: number): {
  label: '规划不足' | '需要注意' | '规划良好';
  tone: 'danger' | 'warning' | 'good';
  initial: number;
  total: number;
  percent: number;
} {
  const total = Math.max(0, Math.round(objectCount));
  const initial = Math.min(total, Math.max(0, Math.round(initialObjectCount)));
  const ratio = total > 0 ? initial / total : 1;
  const tier = ratio >= 0.75
    ? { label: '规划良好' as const, tone: 'good' as const }
    : ratio >= 0.4
      ? { label: '需要注意' as const, tone: 'warning' as const }
      : { label: '规划不足' as const, tone: 'danger' as const };
  return { ...tier, initial, total, percent: Math.round(ratio * 100) };
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
