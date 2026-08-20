import type { EditableMap } from '../shared/map';
import {
  createDefaultMapLayout,
  maxMapRegionCount,
  measureMapLayoutCoverage,
  normalizeMapLayout,
  type MapEcologyRegion,
  type MapLayout
} from '../shared/mapLayout';
import type { AgentProgressEvent, ChatProvider } from '../shared/protocol';
import { parseLlmJsonObject } from './llmJson';
import { llmChat } from './modelApi';

export interface MapLayoutAiOptions {
  apiBase?: string;
  provider?: ChatProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;
}

export interface MapLayoutSuggestion {
  summary: string;
  layout: MapLayout;
}

export async function generateMapLayoutSuggestion(
  prompt: string,
  map: EditableMap,
  options: MapLayoutAiOptions = {}
): Promise<MapLayoutSuggestion> {
  const cleanPrompt = prompt.trim().slice(0, 1_200);
  if (!cleanPrompt) throw new Error('missing_layout_prompt');
  const system = buildMapLayoutPrompt(map);
  let previous = '';
  options.signal?.throwIfAborted();
  options.onProgress?.({ phase: 'planning', label: '理解分区要求并规划公共边界' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content = await llmChat([
      { role: 'system', content: system },
      { role: 'user', content: attempt === 0
        ? cleanPrompt
        : `Repair the previous invalid partition. Preserve the user intent and return valid JSON only. Previous response: ${previous}` }
    ], {
      apiBase: options.apiBase,
      provider: options.provider,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      temperature: 0.2,
      maxTokens: 2_400,
      onProgress: options.onProgress
    });
    previous = content;
    options.onProgress?.({ phase: 'validating', label: '检查区块数量、重叠、缺口与地图覆盖' });
    try {
      const suggestion = normalizeMapLayoutSuggestion(parseLlmJsonObject(content, 'invalid_map_layout_json'), map);
      options.onProgress?.({ phase: 'complete', label: '生态分区预览已完成' });
      return suggestion;
    } catch (error) {
      if (attempt === 1) throw error;
      options.onProgress?.({
        phase: 'replanning',
        label: '分区存在重叠、缺口或格式问题，正在自动修正',
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }
  throw new Error('invalid_map_layout');
}

export function normalizeMapLayoutSuggestion(value: unknown, map: EditableMap): MapLayoutSuggestion {
  if (!value || typeof value !== 'object') throw new Error('invalid_map_layout');
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.regions)) throw new Error('invalid_map_layout_regions');
  const limit = maxMapRegionCount(map.box.size);
  if (input.regions.length < 1 || input.regions.length > limit) throw new Error('map_layout_region_limit');
  const halfWidth = map.box.size[0] / 2;
  const halfDepth = map.box.size[2] / 2;
  const regions = input.regions.map((raw, index): MapEcologyRegion => {
    if (!raw || typeof raw !== 'object') throw new Error('invalid_map_layout_region');
    const region = raw as Record<string, unknown>;
    if (!Array.isArray(region.points) || region.points.length < 3) throw new Error('invalid_map_layout_region');
    const points = region.points.slice(0, 64).map((point): [number, number] => {
      if (!Array.isArray(point) || point.length < 2
        || !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1]))) {
        throw new Error('invalid_map_layout_point');
      }
      const x = clamp(Number(point[0]), -1, 1) * halfWidth;
      const z = clamp(Number(point[1]), -1, 1) * halfDepth;
      return [x, z];
    });
    return {
      id: cleanId(region.id, `region-${index + 1}`),
      name: cleanText(region.name, 80) || `区块 ${index + 1}`,
      prompt: cleanText(region.prompt, 1_200),
      groupId: typeof region.groupId === 'string' && region.groupId.trim()
        ? cleanId(region.groupId, '')
        : null,
      color: regionColor(index),
      points,
      boundaryLocked: false,
      contentLocked: false
    };
  });
  const layout = normalizeMapLayout({
    ...createDefaultMapLayout(map.box.size),
    edgeMask: map.layout.edgeMask,
    stitchSources: map.layout.stitchSources,
    seams: map.layout.seams,
    globalPrompt: cleanText(input.globalPrompt, 1_200) || map.layout.globalPrompt,
    regions
  }, map.box.size);
  assertLayoutCoverage(map, layout);
  return {
    summary: cleanText(input.summary, 200) || `已划分 ${layout.regions.length} 个区块`,
    layout
  };
}

function assertLayoutCoverage(map: EditableMap, layout: MapLayout): void {
  if (!measureMapLayoutCoverage(layout, map.box.size).valid) throw new Error('map_layout_incomplete_partition');
}

function buildMapLayoutPrompt(map: EditableMap): string {
  const limit = maxMapRegionCount(map.box.size);
  return [
    'You design only the ecological partition of a map before content generation.',
    'Return mutually exclusive polygon regions that together cover the complete normalized square [-1,1] x [-1,1].',
    'Every outer corner must belong to one region. Adjacent regions must reuse exactly matching boundary coordinates so there are no gaps.',
    'Use simple clockwise polygons with 4-12 points. Do not overlap regions and do not create holes.',
    `This map allows 1-${limit} regions. Respect explicit requests such as equal quarters or a larger upper-right region.`,
    `The currently saved global terrain prompt is: ${JSON.stringify(map.layout.globalPrompt)}. Preserve it unless the user explicitly replaces it.`,
    'Do not generate terrain, objects, rendering, gameplay, roads, rivers, assets or coordinates outside the normalized square.',
    'globalPrompt and each non-empty region prompt must be one short sentence. Preserve the player’s simple wording and infer layout details yourself.',
    'The global sentence describes the overall environment, two or three main contents, and optionally their rough relationship. A region sentence describes only its local ecology or landmark.',
    'Do not ask the player for coordinates, exact counts, density parameters, generation steps or technical terrain terms. An empty region prompt means base terrain only.',
    'Return JSON only:',
    JSON.stringify({
      summary: 'short partition summary',
      globalPrompt: 'mountain-ringed forest valley with cabins and an eastern lake',
      regions: [{
        id: 'stable-region-id',
        name: 'human label',
        prompt: 'pine forest with scattered cabins, thinning toward the lake',
        groupId: null,
        points: [[-1, -1], [0, -1], [0, 1], [-1, 1]]
      }]
    })
  ].join('\n');
}

function cleanId(value: unknown, fallback: string): string {
  return typeof value === 'string'
    ? value.trim().replace(/[^a-zA-Z0-9:_-]+/g, '-').slice(0, 80) || fallback
    : fallback;
}

function cleanText(value: unknown, length: number): string {
  return typeof value === 'string' ? value.trim().slice(0, length) : '';
}

function regionColor(index: number): string {
  const colors = ['#4f8fdd', '#49a078', '#db8a4b', '#9b6bd3', '#d65f7e', '#79a63a', '#4ca7a5', '#c6a240'];
  return colors[index % colors.length];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
