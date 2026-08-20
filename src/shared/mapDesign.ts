import type { Vec3 } from './protocol';
import type { VisualZoneRegion } from './visualDirection';

export const MAP_DESIGN_VERSION = 1 as const;
export const MAP_EXPERIENCE_MODES = ['immediate', 'sequential', 'mixed'] as const;
export const MAP_DENSITY_TONES = ['tight', 'normal', 'open'] as const;
export const MAP_FOCUS_KINDS = ['primary', 'secondary', 'node'] as const;
export const MAP_REVEAL_MODES = ['visible', 'screened', 'framed', 'sequence'] as const;
export const MAP_RELATION_KINDS = ['attract', 'repel', 'support'] as const;

export type MapExperienceMode = typeof MAP_EXPERIENCE_MODES[number];
export type MapDensityTone = typeof MAP_DENSITY_TONES[number];
export type MapFocusKind = typeof MAP_FOCUS_KINDS[number];
export type MapRevealMode = typeof MAP_REVEAL_MODES[number];
export type MapRelationKind = typeof MAP_RELATION_KINDS[number];
export type MapCompositionLayer = 1 | 2 | 3 | 4;

export interface MapDesignLayerPolicy {
  level: MapCompositionLayer;
  intent: string;
  density: MapDensityTone;
  minCount?: number;
}

export interface MapDesignGroup {
  id: string;
  name: string;
  parentId?: string;
  intent: string;
  region?: VisualZoneRegion;
  focusIds: string[];
  guideIds: string[];
  entryGuideIds: string[];
  exitGuideIds: string[];
  axisGuideIds: string[];
  protectedObjectIds: string[];
  removableObjectIds: string[];
  layers: MapDesignLayerPolicy[];
}

export interface MapDesignFocus {
  id: string;
  groupId: string;
  name: string;
  kind: MapFocusKind;
  rank: number;
  selector?: string;
  objectId?: string;
  reveal: MapRevealMode;
}

export interface MapDesignViewpoint {
  id: string;
  groupId?: string;
  point: [number, number];
  targetFocusId?: string;
  role: 'entry' | 'route' | 'node' | 'overview';
}

export interface MapDesignRelation {
  id: string;
  kind: MapRelationKind;
  sourceSelector: string;
  targetSelector?: string;
  sourceGroupId?: string;
  targetGroupId?: string;
  strength: MapDensityTone;
  minDistance?: number;
  maxDistance?: number;
}

export interface MapDesignSemantics {
  version: 1;
  experienceMode: MapExperienceMode;
  intent: string;
  groups: MapDesignGroup[];
  focuses: MapDesignFocus[];
  viewpoints: MapDesignViewpoint[];
  relations: MapDesignRelation[];
}

export const DEFAULT_MAP_DESIGN_SEMANTICS: MapDesignSemantics = Object.freeze({
  version: MAP_DESIGN_VERSION,
  experienceMode: 'mixed',
  intent: '',
  groups: [],
  focuses: [],
  viewpoints: [],
  relations: []
});

export function normalizeMapDesignSemantics(value: unknown, boxSize: Vec3): MapDesignSemantics {
  const input = record(value);
  const groupInputs = Array.isArray(input.groups) ? input.groups.slice(0, 32) : [];
  const groups: MapDesignGroup[] = [];
  const groupIds = new Set<string>();
  for (const raw of groupInputs) {
    const item = record(raw);
    const id = cleanId(item.id);
    if (!id || groupIds.has(id)) continue;
    groupIds.add(id);
    groups.push({
      id,
      name: text(item.name, id, 80),
      intent: text(item.intent, '', 240),
      region: normalizeRegion(item.region, boxSize),
      focusIds: ids(item.focusIds, 16),
      guideIds: ids(item.guideIds, 32),
      entryGuideIds: ids(item.entryGuideIds, 16),
      exitGuideIds: ids(item.exitGuideIds, 16),
      axisGuideIds: ids(item.axisGuideIds, 16),
      protectedObjectIds: ids(item.protectedObjectIds, 64),
      removableObjectIds: ids(item.removableObjectIds, 128),
      layers: normalizeLayers(item.layers)
    });
  }
  for (const [index, raw] of groupInputs.entries()) {
    const group = groups.find((item) => item.id === cleanId(record(raw).id));
    const parentId = cleanId(record(raw).parentId);
    if (group && parentId && parentId !== group.id && groupIds.has(parentId)) group.parentId = parentId;
    if (index >= groups.length) break;
  }

  const focuses: MapDesignFocus[] = [];
  const focusIds = new Set<string>();
  for (const raw of (Array.isArray(input.focuses) ? input.focuses.slice(0, 64) : [])) {
    const item = record(raw);
    const id = cleanId(item.id);
    const groupId = cleanId(item.groupId);
    if (!id || focusIds.has(id) || !groupIds.has(groupId)) continue;
    focusIds.add(id);
    focuses.push({
      id,
      groupId,
      name: text(item.name, id, 80),
      kind: enumValue(item.kind, MAP_FOCUS_KINDS, 'secondary'),
      rank: integer(item.rank, 1, 16, 1),
      selector: optionalText(item.selector, 80),
      objectId: optionalText(item.objectId, 80),
      reveal: enumValue(item.reveal, MAP_REVEAL_MODES, 'visible')
    });
  }
  for (const group of groups) group.focusIds = [...new Set([...group.focusIds, ...focuses.filter((focus) => focus.groupId === group.id).map((focus) => focus.id)])].filter((id) => focusIds.has(id));

  const viewpoints: MapDesignViewpoint[] = [];
  for (const raw of (Array.isArray(input.viewpoints) ? input.viewpoints.slice(0, 64) : [])) {
    const item = record(raw);
    const id = cleanId(item.id);
    const point = point2(item.point, boxSize);
    if (!id || !point || viewpoints.some((viewpoint) => viewpoint.id === id)) continue;
    const groupId = cleanId(item.groupId);
    const targetFocusId = cleanId(item.targetFocusId);
    viewpoints.push({
      id,
      point,
      role: enumValue(item.role, ['entry', 'route', 'node', 'overview'] as const, 'route'),
      ...(groupIds.has(groupId) ? { groupId } : {}),
      ...(focusIds.has(targetFocusId) ? { targetFocusId } : {})
    });
  }

  const relations: MapDesignRelation[] = [];
  for (const raw of (Array.isArray(input.relations) ? input.relations.slice(0, 64) : [])) {
    const item = record(raw);
    const id = cleanId(item.id);
    const sourceSelector = text(item.sourceSelector, '', 80);
    const sourceGroupId = cleanId(item.sourceGroupId);
    const targetGroupId = cleanId(item.targetGroupId);
    if (!id || relations.some((relation) => relation.id === id) || (!sourceSelector && !groupIds.has(sourceGroupId))) continue;
    relations.push({
      id,
      kind: enumValue(item.kind, MAP_RELATION_KINDS, 'attract'),
      sourceSelector,
      targetSelector: optionalText(item.targetSelector, 80),
      strength: enumValue(item.strength, MAP_DENSITY_TONES, 'normal'),
      ...(groupIds.has(sourceGroupId) ? { sourceGroupId } : {}),
      ...(groupIds.has(targetGroupId) ? { targetGroupId } : {}),
      ...(Number.isFinite(Number(item.minDistance)) ? { minDistance: clamp(Number(item.minDistance), 0, 80) } : {}),
      ...(Number.isFinite(Number(item.maxDistance)) ? { maxDistance: clamp(Number(item.maxDistance), 0, 160) } : {})
    });
  }

  return {
    version: MAP_DESIGN_VERSION,
    experienceMode: enumValue(input.experienceMode, MAP_EXPERIENCE_MODES, 'mixed'),
    intent: text(input.intent, '', 500),
    groups,
    focuses,
    viewpoints,
    relations
  };
}

function normalizeLayers(value: unknown): MapDesignLayerPolicy[] {
  if (!Array.isArray(value)) return [];
  const result: MapDesignLayerPolicy[] = [];
  for (const raw of value.slice(0, 8)) {
    const item = record(raw);
    const level = Number(item.level);
    if (![1, 2, 3, 4].includes(level) || result.some((layer) => layer.level === level)) continue;
    result.push({
      level: level as MapCompositionLayer,
      intent: text(item.intent, '', 160),
      density: enumValue(item.density, MAP_DENSITY_TONES, 'normal'),
      ...(Number.isFinite(Number(item.minCount)) ? { minCount: integer(item.minCount, 1, 64, 1) } : {})
    });
  }
  return result.sort((left, right) => left.level - right.level);
}

function normalizeRegion(value: unknown, boxSize: Vec3): VisualZoneRegion | undefined {
  const item = record(value);
  const halfX = boxSize[0] / 2;
  const halfZ = boxSize[2] / 2;
  if (item.kind === 'circle') {
    return {
      kind: 'circle',
      x: clamp(Number(item.x) || 0, -halfX, halfX),
      z: clamp(Number(item.z) || 0, -halfZ, halfZ),
      radius: clamp(Number(item.radius) || 1, 0.1, Math.max(boxSize[0], boxSize[2]))
    };
  }
  if (item.kind !== 'path' && item.kind !== 'polygon') return undefined;
  const points = Array.isArray(item.points) ? item.points.flatMap((point) => {
    const normalized = point2(point, boxSize);
    return normalized ? [normalized] : [];
  }).slice(0, 64) : [];
  if (points.length < (item.kind === 'path' ? 2 : 3)) return undefined;
  return item.kind === 'path'
    ? { kind: 'path', points, width: clamp(Number(item.width) || 1, 0.1, Math.max(boxSize[0], boxSize[2])) }
    : { kind: 'polygon', points };
}

function point2(value: unknown, boxSize: Vec3): [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2 || !Number.isFinite(Number(value[0])) || !Number.isFinite(Number(value[1]))) return undefined;
  return [clamp(Number(value[0]), -boxSize[0] / 2, boxSize[0] / 2), clamp(Number(value[1]), -boxSize[2] / 2, boxSize[2] / 2)];
}

function ids(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? [...new Set(value.map(cleanId).filter(Boolean))].slice(0, limit) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanId(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/[^a-zA-Z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) : '';
}

function text(value: unknown, fallback: string, limit: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : fallback;
}

function optionalText(value: unknown, limit: number): string | undefined {
  const result = text(value, '', limit);
  return result || undefined;
}

function integer(value: unknown, min: number, max: number, fallback: number): number {
  const result = Number(value);
  return Number.isFinite(result) ? clamp(Math.round(result), min, max) : fallback;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, fallback: T[number]): T[number] {
  return values.includes(value as T[number]) ? value as T[number] : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
