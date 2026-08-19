import { getMapBounds, getMapObjectAabbs, type EditableMap } from '../shared/map';
import {
  normalizeMapVisualReview,
  type IndoorVisualReview,
  type MapVisualReview
} from '../shared/indoorVisualReview';
import type { ChatProvider } from '../shared/protocol';
import { parseLlmJsonObject } from './llmJson';
import { llmChat, type ChatApiOptions } from './modelApi';

export interface IndoorVisualReviewOptions {
  provider?: ChatProvider;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export type MapVisualReviewOptions = IndoorVisualReviewOptions;

export async function reviewMapVisual(
  map: EditableMap,
  imageDataUrl: string,
  options: MapVisualReviewOptions = {}
): Promise<MapVisualReview> {
  if (map.sceneMode === 'indoor' && !map.room) throw new Error('indoor_visual_review_requires_room');
  if (!/^data:image\/(?:jpeg|png|webp);base64,/i.test(imageDataUrl) || imageDataUrl.length > 8 * 1024 * 1024) {
    throw new Error('invalid_map_review_image');
  }
  const indoor = map.sceneMode === 'indoor';
  const bounds = getMapBounds(map);
  const manifest = compactObjectManifest(map);
  const validObjectIds = new Set(map.objects.map((object) => object.id));
  const content = await llmChat([
    {
      role: 'system',
      content: (indoor ? [
        'You are a strict but lightweight 3D indoor-scene final inspector.',
        'The image is one contact sheet: four diagonal room views plus one top view.',
        'Only mark severity major when the issue materially harms use or presentation: solid furniture interpenetration, blocked door/cabinet access, obvious floating/embedding, a large unusably dark area, or severe composition imbalance.'
      ] : [
        'You are a strict but lightweight 3D outdoor-environment final inspector.',
        'The image is one contact sheet: four diagonal map views plus one top view.',
        'Judge the rendered composition, not numeric spacing. Allow intentional contact or slight overlap between modules that form one building.',
        'Only mark severity major when it materially harms presentation or playability: disconnected architecture, severe accidental sparsity, missing focal hierarchy, an unreadable main route or entrance, obvious floating/embedding, or destructive interpenetration.'
      ]).concat([
        'Do not request new assets and do not critique style preferences or minor polish.',
        'Return JSON only: {"summary":"...","findings":[{"code":"overlap|occlusion|floating|embedded|dark-corner|composition|sparse|hierarchy|route","severity":"minor|major","message":"...","objectIds":["exact id"]}]}.'
      ]).join('\n')
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: indoor
            ? `Scene: ${map.name}\nRoom size: ${map.room!.size.join(' x ')}\nObjects:\n${JSON.stringify(manifest)}`
            : `Scene: ${map.name}\nMap bounds: X ${bounds.minX}..${bounds.maxX}, Z ${bounds.minZ}..${bounds.maxZ}\nObjects:\n${JSON.stringify(manifest)}`
        },
        { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } }
      ]
    }
  ], {
    provider: options.provider,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    temperature: 0.1,
    maxTokens: 900
  } satisfies ChatApiOptions);
  return normalizeMapVisualReview(parseLlmJsonObject(content, 'invalid_map_visual_review'), validObjectIds, map.sceneMode);
}

export async function reviewIndoorMapVisual(
  map: EditableMap,
  imageDataUrl: string,
  options: IndoorVisualReviewOptions = {}
): Promise<IndoorVisualReview> {
  if (map.sceneMode !== 'indoor' || !map.room) throw new Error('indoor_visual_review_requires_room');
  return reviewMapVisual(map, imageDataUrl, options);
}

function compactObjectManifest(map: EditableMap): Array<{
  id: string;
  name: string;
  position: [number, number, number];
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}> {
  const boundsById = new Map<string, { min: [number, number, number]; max: [number, number, number] }>();
  for (const bounds of getMapObjectAabbs(map)) {
    const current = boundsById.get(bounds.objectId);
    if (!current) {
      boundsById.set(bounds.objectId, { min: [...bounds.min], max: [...bounds.max] });
      continue;
    }
    current.min = current.min.map((value, axis) => Math.min(value, bounds.min[axis])) as [number, number, number];
    current.max = current.max.map((value, axis) => Math.max(value, bounds.max[axis])) as [number, number, number];
  }
  return map.objects.slice(0, 160).map((object) => ({
    id: object.id,
    name: object.name,
    position: object.transform.position,
    ...(boundsById.has(object.id) ? { bounds: boundsById.get(object.id) } : {})
  }));
}
