import type { AgentProgressEvent } from '../shared/protocol';

export interface AgentProgressViewOptions {
  running: boolean;
  elapsedMs: number;
  slowAssetMode?: boolean;
}

const PHASE_PROGRESS: Partial<Record<AgentProgressEvent['phase'], number>> = {
  planning: 12,
  composing: 12,
  consulting: 25,
  'checking-assets': 34,
  'resolving-assets': 36,
  'generating-asset': 40,
  'asset-retrying': 40,
  replanning: 68,
  compiling: 72,
  reviewing: 84,
  validating: 92,
  repairing: 96,
  complete: 100
};

export function updateAgentProgress(list: AgentProgressEvent[], event: AgentProgressEvent): void {
  const previous = list.at(-1);
  if (
    previous
    && previous.phase === event.phase
    && event.current === undefined
    && event.total === undefined
  ) {
    previous.label = event.label || previous.label;
    previous.detail = event.detail ?? previous.detail;
    return;
  }
  list.push({ ...event });
  if (list.length > 10) list.splice(0, list.length - 10);
}

export function humanizeAgentError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return '【用户取消】本次规划已中断，没有内容应用到地图。';
  const message = error instanceof Error ? error.message : String(error || 'unknown_error');
  if (/failed to fetch|econnrefused|networkerror|socket|connection (?:closed|reset)|terminated/i.test(message)) {
    return '【连接失败】无法连接 Voxel Studio 后端，或连接中途断开。请确认服务端仍在运行、网络连接正常，然后重试；本次规划没有应用。';
  }
  const labels: Record<string, string> = {
    agent_result_missing: '【响应中断】连接已结束，但没有收到最终规划结果。请直接重试；若连续出现，请检查服务端终端日志。',
    map_agent_no_spatial_plan: '【没有可执行内容】AI 返回了说明，但没有地形、水体、物体或其他地图操作。请在提示词中明确要生成的位置与内容后重试。',
    empty_map_suggestion: '【没有可执行内容】AI 的方案在安全过滤后为空，通常是修改范围超出目标区块。请缩小内容尺度或改用整张地图生成。',
    map_agent_asset_minimum_not_met: '【资产数量不足】AI 没有满足“最少新资产”设置。请降低最少值，或在提示词中明确列出需要的新资产种类后重试。',
    map_agent_asset_limit: '【资产数量超限】AI 在达到本次新资产上限后仍要求更多资产。请提高最大值、减少场景种类，或允许复用所选资产库。',
    map_agent_generated_assets_not_placed: '【区块没有合法落点】AI 重规划和确定性补摆都已执行，但目标区块内仍没有满足资产足迹、水体距离、坡度与碰撞约束的位置。请扩大区块、减少新资产数量或降低区块内已有内容密度后重试。',
    indoor_prompt_requires_indoor_map: '【场景类型不匹配】提示词明确要求室内空间，但当前是室外地图。请新建或切换为“室内”地图后再生成，系统会使用参数化房间、墙面和室内家具布局。',
    scene_asset_family_count_above_max: '【资产数量超限】场景规划包含过多资产家族，超过当前地图额度。请减少生态/建筑种类或提高最大新资产数。',
    scene_asset_variant_count_above_max: '【资产数量超限】AI 为同类资产规划了过多变体。请减少变体要求或提高最大新资产数。',
    scene_asset_variant_count_below_min: '【资产数量不足】场景规划无法在当前上下限内满足最少资产数。请检查资产最少/最多值是否冲突。',
    invalid_agent_json: '【AI 输出格式错误】AI 连续修正后仍未返回可解析的场景规划 JSON。请重试；若重复出现，可简化提示词。',
    invalid_map_ai_json: '【AI 输出格式错误】AI 返回的地图修改 JSON 不完整或格式错误。请重试；若重复出现，可缩短并明确提示词。',
    invalid_scatter_plan: '【散布范围无效】AI 的某项批量摆放缺少可用资产或范围。圆形范围需包含中心与半径；分区生成时系统会自动使用当前区块。请重试，若仍失败可减少批量摆放种类。',
    unknown_ecology_region: '【目标区块失效】要生成的生态区块已不存在或分区已变化。请重新选择区块后再生成。',
    ecology_region_content_locked: '【目标区块已锁定】该区块禁止重新生成内容。请先关闭“锁定内容”，再重试。',
    unknown_visual_zone: '【目标区域失效】所选视觉区域已不存在。请改为整张地图或重新选择区域。',
    provider_unavailable: '【模型不可用】所选 AI 提供方当前不可用。请切换可用模型后重试。',
    chat_service_unreachable: '【AI 服务连接失败】本地编辑器仍可访问，但它无法连接上游 AI 模型服务。请稍后重试或切换模型提供方；本次规划没有应用。',
    missing_prompt: '【缺少提示词】没有收到可用的地图提示词。请填写生成要求后重试。',
    map_layout_incomplete_partition: '【分区拓扑校验失败】AI 给出的区块存在重叠或缺口，自动修正后仍未完整覆盖地图。请简化分区描述后重试。',
    map_layout_region_limit: '【分区数量超限】AI 返回的区块数量超过当前地图尺寸允许的上限。请减少区块数量后重试。',
    invalid_map_layout_json: '【AI 输出格式错误】AI 没有返回可解析的分区 JSON，自动修正后仍失败。请重试或简化分区描述。'
  };
  if (labels[message]) return labels[message];
  if (/^map_asset_generation_failed:/.test(message)) {
    const payload = message.slice('map_asset_generation_failed:'.length);
    const separator = payload.indexOf(':');
    const assetName = separator >= 0 ? payload.slice(0, separator) : payload;
    const cause = separator >= 0 ? payload.slice(separator + 1) : '未返回具体原因';
    return `【资产生成失败】资产“${assetName || '未命名资产'}”在全部重试后仍失败。最后原因：${cause.slice(0, 240)}。请检查模型服务，或降低该资产描述的复杂度后重试。`;
  }
  if (/^scene_outcome_missing_(?:asset_family|water):/.test(message)) {
    const target = message.slice(message.indexOf(':') + 1);
    return `【空间放置失败】规划中的“${target}”无法在边界、坡度、水体和碰撞限制内找到合法位置。请扩大目标区块、减少密度或缩小资产尺度后重试。`;
  }
  if (/^(?:unknown_map_asset|map_agent_existing_asset_reuse_disabled|generated_asset_mode_mismatch)/.test(message)) {
    return `【资产引用冲突】AI 引用了当前不可用、不可复用或生成模式不匹配的资产（${message}）。请检查资产库复用选项与地图资产模式后重试。`;
  }
  if (/^(?:invalid_|unknown_scene_|duplicate_scene_|forbidden_scene_|required_scene_|scene_composition_)/.test(message)) {
    return `【AI 规划校验失败】AI 返回的场景关系或地图操作不符合编辑器约束（${message}）。请重试；若重复出现，请简化区域关系与内容要求。`;
  }
  if (/^(?:empty_operations|too_many_operations|unsupported_operation|invalid_operation)/.test(message)) {
    return `【地图操作校验失败】生成结果包含空、过多或不受支持的地图操作（${message}），因此没有应用。请减少一次生成的内容规模后重试。`;
  }
  if (/HTTP \d{3}|provider|model|Empty AI response|chat_http_/i.test(message)) {
    return `【AI 服务失败】模型服务没有正常完成请求。服务端信息：${message.slice(0, 240)}。请稍后重试或切换模型提供方。`;
  }
  return `【未分类错误】地图生成未完成，服务端返回：${message.slice(0, 240)}。本次结果没有应用；请重试，并在重复出现时查看服务端日志。`;
}

export function humanizeRenderAgentError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return '用户已取消，本次渲染预览没有应用。';
  }
  const message = error instanceof Error ? error.message : String(error || 'unknown_error');
  if (/fetch failed|failed to fetch/i.test(message)) {
    return '无法连接 Voxel Studio 后端。本次渲染预览没有应用，请检查网络后重试。';
  }
  if (message === 'invalid_render_ai_json') {
    return 'AI 连续两次未返回完整的渲染计划 JSON，本次预览没有应用。';
  }
  return message;
}

export function renderAgentProgress(
  events: readonly AgentProgressEvent[],
  options: AgentProgressViewOptions
): string {
  if (events.length === 0 && !options.running) return '';
  const last = events.at(-1);
  const failed = last?.phase === 'failed';
  const cancelled = failed && /取消/.test(last.label);
  const complete = last?.phase === 'complete';
  const progressEvent = failed ? [...events].reverse().find((event) => event.phase !== 'failed') : last;
  const percent = workflowPercent(progressEvent, options.running);
  const title = failed ? cancelled ? '已取消' : '生成失败' : complete ? '规划完成' : 'AI 正在工作';
  const currentLabel = last?.label ?? '正在连接地图 Agent';
  const detail = last?.detail ? agentStageLabel(last.detail) : waitingHint(last?.phase);
  const counter = last?.total && last.total > 0 && last.current
    ? `<span>${last.current} / ${last.total}</span>`
    : '';
  const slowHint = options.running && options.slowAssetMode
    ? '<p class="agent-progress-hint">PRO 资产单个可能需要数分钟；页面保持打开即可，也可以随时取消。</p>'
    : '';

  return `
    <section class="agent-run ${failed ? 'failed' : complete ? 'complete' : 'running'}" aria-live="polite">
      <div class="agent-run-heading">
        <strong>${title}</strong>
        <span>已用时 ${formatElapsed(options.elapsedMs)}</span>
      </div>
      <div class="agent-run-current">
        <b>${escapeHtml(currentLabel)}</b>
        ${counter}
      </div>
      <div class="agent-progress-bar" role="progressbar" aria-label="地图 Agent 流程进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
        <i style="width:${percent}%"></i>
      </div>
      ${detail ? `<small>${escapeHtml(detail)}</small>` : ''}
      ${slowHint}
      ${events.length > 0 ? `
        <ol class="agent-progress">
          ${events.map((event, index) => `
            <li class="${event.phase === 'failed' ? 'failed' : index === events.length - 1 && event.phase !== 'complete' ? 'active' : 'done'}">
              <span></span>
              <div>
                <strong>${escapeHtml(event.label)}</strong>
                ${event.detail ? `<small>${escapeHtml(agentStageLabel(event.detail))}</small>` : ''}
              </div>
            </li>
          `).join('')}
        </ol>
      ` : ''}
    </section>
  `;
}

function workflowPercent(event: AgentProgressEvent | undefined, running: boolean): number {
  if (!event) return running ? 4 : 0;
  if (event.phase === 'generating-asset' && event.total && event.current) {
    return Math.round(40 + Math.min(1, event.current / event.total) * 24);
  }
  return PHASE_PROGRESS[event.phase] ?? (running ? 8 : 0);
}

function waitingHint(phase: AgentProgressEvent['phase'] | undefined): string {
  if (phase === 'composing' || phase === 'planning') return '正在等待 AI 返回结构化场景规划。';
  if (phase === 'reviewing') return '正在等待合成审查返回差量建议。';
  if (phase === 'generating-asset') return '模型正在生成并校验资产结构。';
  return '';
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function agentStageLabel(stage: string): string {
  if (stage.startsWith('provider:')) return `调用 ${stage.slice('provider:'.length)} 模型`;
  if (stage.startsWith('attempt:')) return `第 ${stage.slice('attempt:'.length)} 次尝试`;
  if (/fetch failed|failed to fetch/i.test(stage)) return '无法连接 Voxel Studio 后端';
  const labels: Record<string, string> = {
    invalid_render_ai_json: '模型返回的 JSON 不完整，正在进行最后一次自动修正',
    thinking: '分析资产结构',
    code: '生成模型结构',
    validate: '校验模型',
    result: '资产完成'
  };
  return labels[stage] ?? stage;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
