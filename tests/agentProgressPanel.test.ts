import { describe, expect, it } from 'vitest';
import {
  humanizeAgentError,
  humanizeRenderAgentError,
  renderAgentProgress,
  updateAgentProgress
} from '../src/client/agentProgressPanel';
import type { AgentProgressEvent } from '../src/shared/protocol';

describe('agent progress panel', () => {
  it('keeps a prominent running status before and during slow model work', () => {
    const html = renderAgentProgress([], {
      running: true,
      elapsedMs: 74_000,
      slowAssetMode: true
    });

    expect(html).toContain('AI 正在工作');
    expect(html).toContain('已用时 1:14');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('PRO 资产单个可能需要数分钟');
  });

  it('shows terminal failure details instead of silently clearing the busy state', () => {
    const events: AgentProgressEvent[] = [{ phase: 'composing', label: '组织场景' }];
    updateAgentProgress(events, {
      phase: 'failed',
      label: '地图 Agent 执行失败',
      detail: humanizeAgentError(new Error('fetch failed'))
    });

    const html = renderAgentProgress(events, { running: false, elapsedMs: 3_000 });
    expect(html).toContain('生成失败');
    expect(html).toContain('无法连接 Voxel Studio 后端');
    expect(html).toContain('组织场景');
  });

  it('explains a render JSON repair failure as a terminal two-attempt failure', () => {
    expect(humanizeRenderAgentError(new Error('invalid_render_ai_json'))).toContain('连续两次');
  });

  it('uses asset counters to advance the workflow bar', () => {
    const html = renderAgentProgress([
      { phase: 'generating-asset', label: '生成资产 2/4', current: 2, total: 4 }
    ], { running: true, elapsedMs: 5_000 });

    expect(html).toContain('aria-valuenow="52"');
    expect(html).toContain('2 / 4');
  });
});
