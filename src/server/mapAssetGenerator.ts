import type { EditableMap, MapAsset } from '../shared/map';
import type { ModelProvider, AgentProgressEvent } from '../shared/protocol';
import type { ColorPalette } from '../shared/colorPalette';
import { applyPaletteToModelJson } from '../shared/colorPalette';
import { generateModel, mountModel, replayModel } from './modelApi';
import { generateMapAssetWithRetry } from './mapAssetGenerationRetry';
import { recordGenerationTrace } from './generationTrace';
import type { MapStore } from './mapStore';
import type { MapAgentOptions } from './mapAi';

export function createMapAssetGenerator(store: MapStore, planningMap: EditableMap, assets: readonly MapAsset[], modelProvider: ModelProvider, colorPalette: ColorPalette | null, signal: AbortSignal): MapAgentOptions['createAsset'] {
  const seededModelSources = new Map<string, Promise<unknown>>();
  return async (request, report) => {
    recordGenerationTrace('asset.request', request);
    const generationPrompt = request.prompt;
    const retryOptions = {
      attempts: 3,
      signal,
      onProgress: (event: AgentProgressEvent) => report({
        status: event.phase === 'asset-retrying' ? 'retrying' as const : 'running' as const,
        detail: event.detail ?? event.label
      })
    };
    const variantIndex = request.variantIndex ?? 0;
    const seededFamily = request.seedFamilyKey && (request.variantCount ?? 0) > 1;
    let generatedModelJson: unknown;
    if (request.mountOnAssetId) {
      const primary = assets.find((asset) => asset.id === request.mountOnAssetId);
      if (!primary) throw new Error('map_asset_generation_failed:mount_source_missing');
      report({ status: 'running', detail: '通过现有 Mount 接口添加固定配件（一次装配请求）' });
      recordGenerationTrace('asset.mount.request', { sourceAssetId: primary.id, name: request.name });
      generatedModelJson = await mountModel(primary.modelJson, request.prompt, request.prompt, {
        providers: [modelProvider], signal
      });
    } else if (seededFamily) {
      let source = seededModelSources.get(request.seedFamilyKey!);
      if (!source) {
        source = generateMapAssetWithRetry(request.name, () => generateModel(generationPrompt, {
          mode: request.mode,
          providers: [modelProvider],
          seeded: true,
          seed: mapAssetVariantSeed(planningMap.seed, request.seedFamilyKey!, 0),
          signal,
          onStage: (stage) => report({ status: 'running', detail: stage.stage })
        }), retryOptions);
        seededModelSources.set(request.seedFamilyKey!, source);
      }
      generatedModelJson = variantIndex === 0
        ? await source
        : await generateMapAssetWithRetry(
            request.name,
            async () => replayModel(
              await source,
              mapAssetVariantSeed(planningMap.seed, request.seedFamilyKey!, variantIndex),
              { signal }
            ),
            retryOptions
          );
    } else {
      generatedModelJson = await generateMapAssetWithRetry(request.name, () => generateModel(generationPrompt, {
        mode: request.mode,
        providers: [modelProvider],
        signal,
        onStage: (stage) => report({ status: 'running', detail: stage.stage })
      }), retryOptions);
    }
    const modelJson = colorPalette
      ? applyPaletteToModelJson(generatedModelJson, colorPalette)
      : generatedModelJson;
    return store.saveAsset({
      name: request.name,
      prompt: request.prompt,
      tags: request.tags,
      light: request.light,
      modelJson,
      mode: request.mode,
      provider: modelProvider
    });
  };
}

function mapAssetVariantSeed(mapSeed: number, familyKey: string, variantIndex: number): number {
  let hash = Math.trunc(mapSeed) >>> 0;
  for (const character of `${familyKey}:${variantIndex}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return hash;
}
