import { evaluateIndoorLightCoverage } from './indoorLighting';
import type { EditableMap, MapAsset, MapSceneMode } from './map';

export interface RenderSceneProfile {
  sceneMode: MapSceneMode;
  size: [number, number, number];
  room?: {
    windowCount: number;
    doorCount: number;
    windowArea: number;
  };
  interior?: {
    summary: string;
    palette: string[];
    materialKeywords: string[];
    surfaceRecipes: string[];
  };
  lighting: {
    practicalLightCount: number;
    coverageRatio: number;
  };
  content: {
    hasWater: boolean;
    hasGrass: boolean;
    hasEmissive: boolean;
  };
}

/** Compact, non-authoring context for the render planner. */
export function createRenderSceneProfile(map: EditableMap): RenderSceneProfile {
  const room = map.room;
  const coverage = evaluateIndoorLightCoverage(map);
  const referencedIds = new Set(map.objects
    .filter((object) => object.visible !== false && object.assetId)
    .map((object) => object.assetId!));
  const assets = (map.assets ?? []).filter((asset) => referencedIds.has(asset.id));
  const tags = new Set(assets.flatMap((asset) => asset.tags ?? []).map((tag) => tag.toLowerCase()));
  const direction = map.interiorArtDirection;
  return {
    sceneMode: map.sceneMode,
    size: [...(room?.size ?? map.box.size)],
    ...(room ? {
      room: {
        windowCount: room.openings.filter((opening) => opening.kind === 'window').length,
        doorCount: room.openings.filter((opening) => opening.kind === 'door').length,
        windowArea: round(room.openings
          .filter((opening) => opening.kind === 'window')
          .reduce((sum, opening) => sum + opening.width * opening.height, 0))
      }
    } : {}),
    ...(direction ? {
      interior: {
        summary: direction.summary,
        palette: [...direction.palette],
        materialKeywords: [...direction.materialKeywords],
        surfaceRecipes: [...new Set(Object.values(direction.surfaces).map((surface) => surface.recipe))]
      }
    } : {}),
    lighting: {
      practicalLightCount: coverage.practicalLightCount,
      coverageRatio: round(coverage.ratio)
    },
    content: {
      hasWater: map.waterBodies.length > 0 || tags.has('water'),
      hasGrass: map.grassLayers.length > 0,
      hasEmissive: assets.some((asset) => Boolean(asset.light) || assetHasEmission(asset))
    }
  };
}

export function normalizeRenderSceneProfile(value: unknown): RenderSceneProfile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<RenderSceneProfile>;
  if (input.sceneMode !== 'indoor' && input.sceneMode !== 'outdoor' && input.sceneMode !== 'mixed') return undefined;
  const room = input.room && typeof input.room === 'object' ? input.room : undefined;
  const interior = input.interior && typeof input.interior === 'object' ? input.interior : undefined;
  const lighting = input.lighting && typeof input.lighting === 'object' ? input.lighting : undefined;
  const content = input.content && typeof input.content === 'object' ? input.content : undefined;
  return {
    sceneMode: input.sceneMode,
    size: vec3(input.size, [10, 3, 8]),
    ...(room ? {
      room: {
        windowCount: integer(room.windowCount, 0, 64),
        doorCount: integer(room.doorCount, 0, 64),
        windowArea: number(room.windowArea, 0, 10000)
      }
    } : {}),
    ...(interior ? {
      interior: {
        summary: text(interior.summary, 240),
        palette: colors(interior.palette, 6),
        materialKeywords: texts(interior.materialKeywords, 8, 40),
        surfaceRecipes: texts(interior.surfaceRecipes, 8, 40)
      }
    } : {}),
    lighting: {
      practicalLightCount: integer(lighting?.practicalLightCount, 0, 256),
      coverageRatio: number(lighting?.coverageRatio, 0, 1)
    },
    content: {
      hasWater: content?.hasWater === true,
      hasGrass: content?.hasGrass === true,
      hasEmissive: content?.hasEmissive === true
    }
  };
}

function assetHasEmission(asset: MapAsset): boolean {
  if ((asset.tags ?? []).some((tag) => /^(?:emissive|fire|neon|glow|light|lighting)$/.test(tag.toLowerCase()))) return true;
  const nodes = (asset.modelJson as { nodes?: unknown })?.nodes;
  return Array.isArray(nodes) && nodes.some((node) => {
    if (!node || typeof node !== 'object') return false;
    const nodeTags = (node as { tags?: unknown }).tags;
    return Array.isArray(nodeTags) && nodeTags.some((tag) => (
      tag && typeof tag === 'object' && ['emissive', 'fire'].includes(String((tag as { tag?: unknown }).tag))
    ));
  });
}

function vec3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [0, 1, 2].map((axis) => number(value[axis], 0.1, 10000)) as [number, number, number];
}

function colors(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && /^#[0-9a-f]{6}$/i.test(entry)).slice(0, limit)
    : [];
}

function texts(value: unknown, limit: number, maxLength: number): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => typeof entry === 'string' && entry.trim() ? [entry.trim().slice(0, maxLength)] : []).slice(0, limit)
    : [];
}

function text(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function integer(value: unknown, min: number, max: number): number {
  return Math.trunc(number(value, min, max));
}

function number(value: unknown, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
