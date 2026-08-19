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
      detail: humanizeAgentError(new Error('chat_service_unreachable'))
    });

    const html = renderAgentProgress(events, { running: false, elapsedMs: 3_000 });
    expect(html).toContain('生成失败');
    expect(html).toContain('无法连接上游 AI 模型服务');
    expect(html).toContain('组织场景');
  });

  it('classifies map generation failures with a cause and next action', () => {
    expect(humanizeAgentError(new Error('map_agent_asset_minimum_not_met'))).toContain('【资产数量不足】');
    expect(humanizeAgentError(new Error('map_agent_generated_assets_not_placed'))).toContain('【区块没有合法落点】');
    expect(humanizeAgentError(new Error('invalid_agent_json'))).toContain('【AI 输出格式错误】');
    expect(humanizeAgentError(new Error('invalid_scatter_plan'))).toContain('【散布范围无效】');
    expect(humanizeAgentError(new Error('scene_outcome_missing_asset_family:ancient-tree'))).toContain('【空间放置失败】');
    expect(humanizeAgentError(new Error('map_asset_generation_failed:松树:gpt: HTTP 500'))).toContain('【资产生成失败】');
    const upstreamAssetFailure = humanizeAgentError(new Error('map_asset_generation_failed:玄武岩:gpt: Failed to fetch'));
    expect(upstreamAssetFailure).toContain('【资产生成失败】');
    expect(upstreamAssetFailure).not.toContain('无法连接 Voxel Studio 后端');
    expect(humanizeAgentError(new Error('unknown_ecology_region'))).toContain('【目标区块失效】');
    expect(humanizeAgentError(new Error('indoor_prompt_requires_indoor_map'))).toContain('【场景类型不匹配】');
    expect(humanizeAgentError(new Error('Failed to fetch'))).toContain('【连接失败】');
    expect(humanizeAgentError(new Error('chat_service_unreachable'))).toContain('【AI 服务连接失败】');
    expect(humanizeAgentError(new Error('scene_agent_iteration_budget_exceeded'))).toContain('【Scene Agent 未收敛】');
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

  it('shows the shared parallel asset limit with retry and failure details', () => {
    const html = renderAgentProgress([{
      phase: 'generating-asset',
      label: '并行生成资产：已完成 0/3，进行中 3 个',
      current: 0,
      total: 3,
      assets: [
        { key: 'tree', name: '松树', status: 'running', slot: 1, detail: 'code' },
        { key: 'rock', name: '岩石', status: 'retrying', slot: 2, detail: 'HTTP 500' },
        { key: 'bench', name: '长椅', status: 'failed', slot: 3, detail: 'map_asset_generation_failed:长椅:gpt: HTTP 500' }
      ]
    }], { running: true, elapsedMs: 5_000 });

    expect(html).toContain('并行资产生成');
    expect(html).toContain('最多同时生成 6 项');
    expect(html).toContain('通道 1');
    expect(html).toContain('正在重试');
    expect(html).toContain('生成失败');
    expect(html).toContain('【资产生成失败】');
    expect(html).toContain('0 / 3');
  });

  it('shows short Chinese asset types instead of English generation names', () => {
    const html = renderAgentProgress([{
      phase: 'generating-asset',
      label: '并行生成资产',
      assets: [
        { key: 'stand', name: 'Radial spectator stands', status: 'running' },
        { key: 'gate', name: 'Arena entry causeway', status: 'running' },
        { key: 'pylon', name: 'Colosseum fusion pylon', status: 'failed', detail: 'map_asset_generation_failed:Colosseum fusion pylon:gpt: HTTP 500' }
      ]
    }], { running: true, elapsedMs: 5_000 });

    expect(html).toContain('看台');
    expect(html).toContain('入口');
    expect(html).toContain('塔柱');
    expect(html).not.toContain('Radial spectator stands');
    expect(html).not.toContain('Colosseum fusion pylon');
    expect(humanizeAgentError(new Error('map_asset_generation_failed:Colosseum fusion pylon:gpt: HTTP 500')))
      .toContain('资产“塔柱”');
  });

  it('keeps a completed run compact and folds the detailed event history', () => {
    const html = renderAgentProgress([
      { phase: 'generating-asset', label: '生成资产：沙发' },
      { phase: 'repairing', label: '自动修复 8 项' },
      { phase: 'complete', label: '场景构图与地图预览已完成' }
    ], { running: false, elapsedMs: 120_000, completionPercent: 38 });

    expect(html).toContain('规划完成率 <b>38%</b>');
    expect(html).toContain('<details class="agent-progress-details">');
    expect(html).not.toContain('agent-progress-details" open');
  });
});
