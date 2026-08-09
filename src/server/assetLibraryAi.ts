import {
  normalizeAssetLibraryMetadata,
  type AssetLibraryMetadata
} from '../shared/assetLibrary';
import type { MapAsset } from '../shared/map';
import type { ChatProvider } from '../shared/protocol';
import { parseLlmJsonObject } from './llmJson';
import { llmChat } from './modelApi';

export interface AnalyzeAssetLibraryOptions {
  provider?: ChatProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function analyzeAssetForLibrary(
  asset: MapAsset,
  options: AnalyzeAssetLibraryOptions = {}
): Promise<AssetLibraryMetadata> {
  const content = await llmChat([
    {
      role: 'system',
      content: [
        'You label reusable 3D map assets for WorldForge.',
        'Return one JSON object only with: tags, applicableZones, repeatable, landmark.',
        'tags: 1-8 precise lowercase English identity or role tags. Do not use material-part tags.',
        'applicableZones: one or more of any, grass, forest, water, lowland, dry, settlement, rocky.',
        'Use any only when the asset genuinely fits nearly every region.',
        'repeatable means many copies can plausibly appear; landmark means it should remain rare.'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        name: asset.name,
        originalPrompt: asset.prompt,
        originalTags: asset.tags ?? [],
        sizeClass: asset.sizeClass,
        footprintRadius: asset.footprintRadius,
        modelSummary: summarizeModel(asset.modelJson)
      })
    }
  ], {
    provider: options.provider ?? 'gpt',
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    temperature: 0.1,
    maxTokens: 450
  });
  const result = parseLlmJsonObject(content, 'invalid_asset_library_analysis');
  return normalizeAssetLibraryMetadata({
    tags: result.tags as string[],
    applicableZones: result.applicableZones as AssetLibraryMetadata['applicableZones'],
    repeatable: result.repeatable !== false,
    landmark: result.landmark === true,
    enabled: true,
    priority: result.landmark === true ? 0.7 : 0.5,
    analysisStatus: 'ready',
    rotation: 'random'
  }, asset.tags);
}

export function pendingAssetLibraryMetadata(asset: Pick<MapAsset, 'tags'>): AssetLibraryMetadata {
  return normalizeAssetLibraryMetadata({
    tags: asset.tags ?? [],
    applicableZones: ['any'],
    repeatable: true,
    landmark: false,
    enabled: false,
    priority: 0.5,
    analysisStatus: 'pending',
    rotation: 'random'
  }, asset.tags);
}

function summarizeModel(modelJson: unknown): { nodeNames: string[]; materialNames: string[] } {
  const nodes = new Set<string>();
  const materials = new Set<string>();
  visitModel(modelJson, nodes, materials, 0);
  return { nodeNames: [...nodes].slice(0, 30), materialNames: [...materials].slice(0, 20) };
}

function visitModel(value: unknown, nodes: Set<string>, materials: Set<string>, depth: number): void {
  if (!value || typeof value !== 'object' || depth > 8 || nodes.size + materials.size > 60) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 120)) visitModel(item, nodes, materials, depth + 1);
    return;
  }
  const input = value as Record<string, unknown>;
  if (typeof input.name === 'string' && input.name.trim()) nodes.add(input.name.trim().slice(0, 80));
  if (typeof input.material === 'string' && input.material.trim()) materials.add(input.material.trim().slice(0, 80));
  for (const child of Object.values(input).slice(0, 120)) visitModel(child, nodes, materials, depth + 1);
}
