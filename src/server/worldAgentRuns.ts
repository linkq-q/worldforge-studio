import { createId, type EditableMap, type MapAsset } from '../shared/map';
import { applyMapOperations, type MapOperation } from '../shared/mapOperations';
import { worldCapabilitySummary } from '../shared/worldCapabilities';
import type { MapStore } from './mapStore';
import {
  executeWorldCapability,
  observeWorldCapability,
  type WorldCapabilityObservation
} from './worldCapabilityExecutor';

export const WORLD_AGENT_MAX_TOOL_CALLS = 6;
const WORLD_AGENT_RUN_TTL_MS = 30 * 60 * 1000;

export interface WorldAgentRunView {
  id: string;
  mapId: string;
  baseVersion: number;
  status: 'draft';
  createdAt: number;
  expiresAt: number;
  toolCallCount: number;
  maxToolCalls: number;
  operationCount: number;
  selectedAssets: Array<{ id: string; name: string }>;
  capabilities: ReturnType<typeof worldCapabilitySummary>;
  trace: WorldAgentRunTrace[];
}

export interface WorldAgentRunTrace {
  index: number;
  capabilityId: string;
  input: unknown;
  operationCount: number;
  observation: WorldCapabilityObservation;
  createdAt: number;
}

export interface WorldAgentRunPreview {
  run: WorldAgentRunView;
  map: EditableMap;
  operations: MapOperation[];
  observation: WorldCapabilityObservation;
}

interface WorldAgentRunState {
  id: string;
  mapId: string;
  baseVersion: number;
  baseMap: EditableMap;
  assets: MapAsset[];
  selectedAssets: Array<{ id: string; name: string }>;
  operations: MapOperation[];
  trace: WorldAgentRunTrace[];
  createdAt: number;
  expiresAt: number;
}

export class WorldAgentRunManager {
  private readonly runs = new Map<string, WorldAgentRunState>();

  constructor(private readonly store: MapStore) {}

  async create(mapId: string, assetIds: readonly string[] = []): Promise<WorldAgentRunView> {
    this.prune();
    const normalizedIds = [...new Set(assetIds.map((id) => String(id).trim()).filter(Boolean))];
    if (normalizedIds.length > 64) throw new Error('world_agent_asset_limit');
    const [map, selected] = await Promise.all([
      this.store.loadMap(mapId),
      Promise.all(normalizedIds.map(async (id) => this.store.loadAsset(id).catch(() => {
        throw new Error(`unknown_world_agent_asset:${id}`);
      })))
    ]);
    const assets = dedupeAssets([...(map.assets ?? []), ...selected]);
    const createdAt = Date.now();
    const state: WorldAgentRunState = {
      id: createId('agent-run'),
      mapId,
      baseVersion: map.version,
      baseMap: { ...map, assets },
      assets,
      selectedAssets: selected.map((asset) => ({ id: asset.id, name: asset.name })),
      operations: [],
      trace: [],
      createdAt,
      expiresAt: createdAt + WORLD_AGENT_RUN_TTL_MS
    };
    this.runs.set(state.id, state);
    return this.view(state);
  }

  get(runId: string): WorldAgentRunView {
    return this.view(this.requireRun(runId));
  }

  execute(runId: string, capabilityId: string, input: unknown): WorldAgentRunPreview {
    const state = this.requireRun(runId);
    if (state.trace.length >= WORLD_AGENT_MAX_TOOL_CALLS) throw new Error('world_agent_tool_limit');
    const current = state.operations.length > 0
      ? applyMapOperations(state.baseMap, state.operations)
      : state.baseMap;
    const execution = executeWorldCapability(capabilityId, input, current, state.assets);
    state.operations.push(...execution.suggestion.operations);
    const preview = applyMapOperations(state.baseMap, state.operations);
    state.trace.push({
      index: state.trace.length + 1,
      capabilityId,
      input: structuredClone(input),
      operationCount: execution.suggestion.operations.length,
      observation: observeWorldCapability(preview, execution.suggestion),
      createdAt: Date.now()
    });
    return this.preview(state);
  }

  previewRun(runId: string): WorldAgentRunPreview {
    return this.preview(this.requireRun(runId));
  }

  async commit(runId: string, approved: boolean, label?: string): Promise<Awaited<ReturnType<MapStore['commitTransaction']>>> {
    const state = this.requireRun(runId);
    if (approved !== true) throw new Error('world_agent_approval_required');
    if (state.operations.length === 0) throw new Error('world_agent_empty_run');
    try {
      const result = await this.store.commitTransaction(state.mapId, {
        source: 'agent',
        label: label?.trim() || `Agent 工具草稿 ${state.trace.length} 步`,
        operations: state.operations,
        ai: {
          prompt: 'world-agent-capability-run',
          agent: {
            program: state.trace.map((item) => `${item.index}. ${item.capabilityId}`).join('\n'),
            iterations: state.trace.length,
            guideCount: applyMapOperations(state.baseMap, state.operations).guides.length,
            objectCount: applyMapOperations(state.baseMap, state.operations).objects.length,
            diagnostics: state.trace.flatMap((item) => item.observation.diagnostics.map((issue) => ({
              severity: issue.severity === 'error' || issue.severity === 'warning' ? issue.severity : 'info',
              code: issue.code,
              message: issue.message
            }))),
            trace: state.trace.map((item) => ({
              iteration: item.index,
              action: item.capabilityId,
              summary: `${item.operationCount} operations`
            }))
          }
        }
      }, state.baseVersion);
      this.runs.delete(runId);
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === 'map_transaction_stale') {
        throw new Error('world_agent_run_stale');
      }
      throw error;
    }
  }

  cancel(runId: string): void {
    if (!this.runs.delete(runId)) throw new Error('unknown_world_agent_run');
  }

  private preview(state: WorldAgentRunState): WorldAgentRunPreview {
    const map = state.operations.length > 0
      ? applyMapOperations(state.baseMap, state.operations)
      : state.baseMap;
    return {
      run: this.view(state),
      map,
      operations: [...state.operations],
      observation: observeWorldCapability(map)
    };
  }

  private requireRun(runId: string): WorldAgentRunState {
    this.prune();
    const state = this.runs.get(runId);
    if (!state) throw new Error('unknown_world_agent_run');
    return state;
  }

  private view(state: WorldAgentRunState): WorldAgentRunView {
    return {
      id: state.id,
      mapId: state.mapId,
      baseVersion: state.baseVersion,
      status: 'draft',
      createdAt: state.createdAt,
      expiresAt: state.expiresAt,
      toolCallCount: state.trace.length,
      maxToolCalls: WORLD_AGENT_MAX_TOOL_CALLS,
      operationCount: state.operations.length,
      selectedAssets: state.selectedAssets.map((asset) => ({ ...asset })),
      capabilities: worldCapabilitySummary('map-code'),
      trace: structuredClone(state.trace)
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, state] of this.runs) {
      if (state.expiresAt <= now) this.runs.delete(id);
    }
  }
}

function dedupeAssets(assets: readonly MapAsset[]): MapAsset[] {
  return [...new Map(assets.map((asset) => [asset.id, asset])).values()];
}
