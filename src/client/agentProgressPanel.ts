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
  if (error instanceof Error && error.name === 'AbortError') return '用户已取消，本次规划没有应用到地图。';
  const message = error instanceof Error ? error.message : String(error || 'unknown_error');
  if (/fetch failed|failed to fetch/i.test(message)) {
    return '无法连接 Voxel Studio 后端。网络可能短暂中断，本次规划没有应用；请检查网络后重试。';
  }
  const labels: Record<string, string> = {
    agent_result_missing: '连接已结束，但没有收到最终规划结果。请重试；若再次出现，请检查服务端终端日志。',
    map_agent_no_spatial_plan: 'AI 没有返回可执行的地图修改，请补充更具体的地形或场景内容后重试。',
    map_agent_asset_limit: 'AI 请求的资产超过当前地图额度，本次规划没有应用。',
    invalid_agent_json: 'AI 返回的场景结构无法解析，本次规划没有应用。'
  };
  return labels[message] ?? message;
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
