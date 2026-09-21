import { evaluateIndoorLightCoverage } from './indoorLighting';
import { getObjectWorldTransforms, type EditableMap, type MapAsset, type MapSceneMode } from './map';
import { normalizeMapDesignSemantics, type MapDesignGroup, type MapExperienceMode, type MapFocusKind, type MapRevealMode, type MapRelationKind } from './mapDesign';
import { normalizeAssetTags, normalizeMapAssetLight, type MapAssetLight } from './mapAssetMetadata';

/** Map-authored composition cues, not a RenderPlan or a second styling authority. */
export interface SceneArtBrief {
  intent: string;
  experienceMode: MapExperienceMode;
  groups: Array<Pick<MapDesignGroup, 'id' | 'name' | 'intent' | 'focusIds' | 'guideIds' | 'region' | 'spatialRole'>>;
  focuses: Array<{ id: string; groupId: string; name: string; kind: MapFocusKind; reveal: MapRevealMode; objectId?: string }>;
  viewpoints: Array<{ role: 'entry' | 'route' | 'node' | 'overview'; point: [number, number]; targetFocusId?: string }>;
  relations: Array<{ kind: MapRelationKind; sourceGroupId: string; targetGroupId: string }>;
  renderHints: string[];
}

export interface RenderSceneProfile {
  sceneArtBrief?: SceneArtBrief;
  targets?: {
    objects: Array<{ id: string; name: string; position: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number]; parentId?: string; groupId?: string; tags?: string[]; light?: MapAssetLight; parts: Array<{ id: string; tags: string[] }> }>;
    zones: Array<{ id: string; tags: string[]; center: [number, number]; radius: number }>;
    grassLayers: Array<{ id: string; preset: string }>;
  };
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
  const design = map.designSemantics;
  const worldTransforms = getObjectWorldTransforms(map);
  const assetById = new Map(assets.map(asset => [asset.id, asset]));
  const focusIds = new Set(design.focuses.flatMap(focus => focus.objectId ? [focus.objectId] : []));
  const walkViews = design.viewpoints.filter(view => view.role !== 'overview');
  // Keep the same context budget, but do not let early vegetation hide later focal objects and lights.
  const renderObjects = map.objects.filter(object => object.visible).map(object => {
    const asset = object.assetId ? assetById.get(object.assetId) : undefined;
    const sourceLight = object.light === undefined ? asset?.light : object.light;
    const light = object.light?.enabled !== false ? normalizeMapAssetLight(sourceLight) : undefined;
    const world = worldTransforms.get(object.id)!;
    const distance = Math.min(...walkViews.map(view => Math.hypot(world.position[0] - view.point[0], world.position[2] - view.point[1])));
    const priority = focusIds.has(object.id) ? 0 : light ? 1 : object.parentId && focusIds.has(object.parentId) ? 2 : 3;
    return { object, asset, light, world, priority, distance };
  }).sort((a, b) => a.priority - b.priority || a.distance - b.distance).slice(0, 128);
  const sceneArtBrief: SceneArtBrief | undefined = design.groups.length || map.renderPromptSuggestions.length ? {
    intent: design.intent,
    experienceMode: design.experienceMode,
    groups: design.groups.slice(0, 16).map((group) => ({
      id: group.id, name: group.name, intent: group.intent,
      ...(group.spatialRole ? { spatialRole: group.spatialRole } : {}),
      ...(group.region ? { region: group.region } : {}),
      focusIds: group.focusIds.slice(0, 8),
      guideIds: [...new Set([...group.guideIds, ...group.entryGuideIds, ...group.exitGuideIds, ...group.axisGuideIds])].slice(0, 16)
    })),
    focuses: design.focuses.slice(0, 24).map((focus) => ({
      id: focus.id, groupId: focus.groupId, name: focus.name, kind: focus.kind, reveal: focus.reveal,
      ...(focus.objectId ? { objectId: focus.objectId } : {})
    })),
    viewpoints: design.viewpoints.slice(0, 16).map((view) => ({
      role: view.role, point: [...view.point], ...(view.targetFocusId ? { targetFocusId: view.targetFocusId } : {})
    })),
    relations: design.relations.filter((relation) => relation.sourceGroupId && relation.targetGroupId).slice(0, 24)
      .map((relation) => ({ kind: relation.kind, sourceGroupId: relation.sourceGroupId!, targetGroupId: relation.targetGroupId! })),
    renderHints: map.renderPromptSuggestions.slice(0, 8)
  } : undefined;
  return {
    sceneMode: map.sceneMode,
    ...(sceneArtBrief ? { sceneArtBrief } : {}),
    targets: {
      objects: renderObjects.map(({ object, asset, light, world }) => {
        const nodes = (asset?.modelJson as { nodes?: Array<{ id?: string; tags?: Array<{ tag?: string; value?: unknown }> }> })?.nodes;
        return { id: object.id, name: object.name, position: [...world.position], rotation: [...world.rotation], scale: [...world.scale], ...(object.parentId ? { parentId: object.parentId } : {}), ...(object.designGroupId ? { groupId: object.designGroupId } : {}), tags: asset?.tags?.slice(0, 16) ?? [], ...(light ? { light } : {}), parts: (Array.isArray(nodes) ? nodes : []).filter(node => node?.id && Array.isArray(node.tags) && node.tags.length).slice(0, 32).map(node => ({ id: node.id!, tags: node.tags!.slice(0, 8).filter(Boolean).map(tag => typeof tag === 'object' ? `${tag.tag}:${tag.value ?? ''}` : String(tag)) })) };
      }),
      zones: map.visualSemantics.zones.slice(0, 64).map(zone => ({ id: zone.id, tags: [...zone.tags], center: [...zone.center], radius: zone.radius })),
      grassLayers: map.grassLayers.slice(0, 8).map(layer => ({ id: layer.id, preset: layer.preset }))
    },
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
  const brief = input.sceneArtBrief && typeof input.sceneArtBrief === 'object' ? input.sceneArtBrief : undefined;
  return {
    sceneMode: input.sceneMode,
    ...(brief ? { sceneArtBrief: normalizeSceneArtBrief(brief) } : {}),
    ...(input.targets ? { targets: normalizeRenderTargets(input.targets) } : {}),
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

function normalizeSceneArtBrief(input: SceneArtBrief): SceneArtBrief {
  const list = (value: unknown, limit: number): Array<Record<string, unknown>> => Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).slice(0, limit) : [];
  const choice = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
    values.includes(value as T) ? value as T : fallback;
  return {
    intent: text(input.intent, 500),
    experienceMode: choice(input.experienceMode, ['immediate', 'sequential', 'mixed'], 'mixed'),
    groups: normalizeMapDesignSemantics({ groups: list(input.groups, 16), focuses: input.focuses }, [20000, 10000, 20000]).groups.map((group) => ({
      id: text(group.id, 80), name: text(group.name, 80), intent: text(group.intent, 240),
      ...(group.spatialRole ? { spatialRole: group.spatialRole } : {}),
      ...(group.region ? { region: group.region } : {}),
      focusIds: texts(group.focusIds, 8, 80), guideIds: texts(group.guideIds, 16, 80)
    })),
    focuses: list(input.focuses, 24).map((focus) => ({
      id: text(focus.id, 80), groupId: text(focus.groupId, 80), name: text(focus.name, 80),
      kind: choice(focus.kind, ['primary', 'secondary', 'node'], 'secondary'),
      reveal: choice(focus.reveal, ['visible', 'screened', 'framed', 'sequence'], 'visible'),
      ...(focus.objectId ? { objectId: text(focus.objectId, 80) } : {})
    })),
    viewpoints: list(input.viewpoints, 16).map((view) => ({
      role: choice(view.role, ['entry', 'route', 'node', 'overview'], 'route'),
      point: [number(Array.isArray(view.point) ? view.point[0] : 0, -10000, 10000),
        number(Array.isArray(view.point) ? view.point[1] : 0, -10000, 10000)] as [number, number],
      ...(view.targetFocusId ? { targetFocusId: text(view.targetFocusId, 80) } : {})
    })),
    relations: list(input.relations, 24).map((relation) => ({
      kind: choice(relation.kind, ['attract', 'repel', 'support'], 'support'),
      sourceGroupId: text(relation.sourceGroupId, 80), targetGroupId: text(relation.targetGroupId, 80)
    })),
    renderHints: texts(input.renderHints, 8, 160)
  };
}

function normalizeRenderTargets(input: NonNullable<RenderSceneProfile['targets']>): NonNullable<RenderSceneProfile['targets']> {
  const list = (value: unknown, limit: number): Array<Record<string, unknown>> => Array.isArray(value) ? value.filter(v => v && typeof v === 'object').slice(0, limit) : [];
  const coordinate = (value: unknown, axis: number) => number(Array.isArray(value) ? value[axis] : 0, -10000, 10000);
  return {
    objects: list(input.objects, 128).map(object => ({ id: text(object.id, 120), name: text(object.name, 80), position: [coordinate(object.position, 0), coordinate(object.position, 1), coordinate(object.position, 2)], ...(Array.isArray(object.rotation) ? { rotation: [coordinate(object.rotation, 0), coordinate(object.rotation, 1), coordinate(object.rotation, 2)] as [number, number, number] } : {}), ...(Array.isArray(object.scale) ? { scale: [coordinate(object.scale, 0), coordinate(object.scale, 1), coordinate(object.scale, 2)] as [number, number, number] } : {}), ...(object.parentId ? { parentId: text(object.parentId, 120) } : {}), ...(object.groupId ? { groupId: text(object.groupId, 80) } : {}), tags: normalizeAssetTags(object.tags) ?? [], ...(normalizeMapAssetLight(object.light) ? { light: normalizeMapAssetLight(object.light) } : {}), parts: list(object.parts, 32).map(part => ({ id: text(part.id, 120), tags: texts(part.tags, 8, 80) })) })),
    zones: list(input.zones, 64).map(zone => ({ id: text(zone.id, 120), tags: texts(zone.tags, 8, 40), center: [coordinate(zone.center, 0), coordinate(zone.center, 1)], radius: number(zone.radius, 0, 10000) })),
    grassLayers: list(input.grassLayers, 8).map(layer => ({ id: text(layer.id, 120), preset: text(layer.preset, 40) }))
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
