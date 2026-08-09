import {
  getMapBounds,
  type EditableMap
} from './map';
import type { MapAssetSizeClass } from './mapAssetMetadata';
import {
  normalizeTerrainGenerationParams,
  type TerrainGenerationParams
} from './terrainGeneration';

export const SCENE_COMPOSITION_VERSION = 1 as const;
export const SCENE_COMPOSITION_LIMITS = Object.freeze({
  zoneCount: 12,
  assetFamilyCount: 16,
  grassFamilyCount: 4,
  transitionCount: 16,
  consultationCount: 2,
  specialistPatchCount: 6,
  reviewPatchCount: 8,
  requirementCount: 16
});
export const SCENE_ZONE_ROLES = ['primary', 'secondary', 'transition', 'negative-space'] as const;
export const SCENE_DISTRIBUTIONS = ['even', 'clustered', 'accent'] as const;

export type SceneZoneRole = typeof SCENE_ZONE_ROLES[number];
export type SceneDistribution = typeof SCENE_DISTRIBUTIONS[number];

export interface SceneCompositionPlan {
  version: 1;
  summary: string;
  globalBrief: {
    spatialTheme: string;
    visualHierarchy: string;
    assetArtDirection: string;
    focalZoneId: string;
    terrainBase: TerrainGenerationParams;
  };
  intentRequirements: SceneIntentRequirement[];
  zones: SceneCompositionZone[];
  transitions: SceneTransition[];
  assetFamilies: SceneAssetFamily[];
  grassFamilies: SceneGrassFamily[];
  consultations: SceneConsultationRequest[];
  renderPromptSuggestions: string[];
}

export interface SceneIntentRequirement {
  id: string;
  kind: 'terrain' | 'water' | 'asset-family';
  description: string;
  targetZoneId?: string;
  familyId?: string;
  minCount: number;
}

export interface SceneCompositionZone {
  id: string;
  label: string;
  role: SceneZoneRole;
  importance: number;
  region: {
    kind: 'circle';
    center: [number, number];
    radius: number;
  };
  brief: {
    atmosphere: string;
    hierarchy: string;
    openness: number;
    transitionIntent: string;
  };
  terrain: {
    elevation: number;
    roughness: number;
    flatness: number;
  };
  water?: {
    type: 'lake';
    level: number;
    depth: number;
  };
  layers: SceneZoneLayer[];
  grassLayers: SceneZoneGrassLayer[];
  excludeZoneIds: string[];
}

export interface SceneZoneLayer {
  familyId: string;
  density: number;
  scaleRange: [number, number];
  distribution: SceneDistribution;
  edgeFalloff: number;
}

export interface SceneGrassFamily {
  id: string;
  label: string;
  mix: { short: number; tall: number; flowers: number };
}

export interface SceneZoneGrassLayer {
  grassFamilyId: string;
  density: number;
  variation: number;
  edgeFalloff: number;
  /** Density deliberately left around structures: 0 tidy, larger values abandoned. */
  residualDensity: number;
}

export interface SceneTransition {
  fromZoneId: string;
  toZoneId: string;
  kind: 'soft' | 'buffer' | 'shore';
  width: number;
}

export interface SceneAssetFamily {
  id: string;
  label: string;
  /** Free semantic role selected by the director, not an editor preset. */
  role: string;
  tags: string[];
  /** Specific identity required for reuse; broad tags such as `tree` are not enough. */
  identityTags: string[];
  sizeClass: MapAssetSizeClass;
  desiredVariants: number;
  priority: number;
  generationBrief: string;
}

export interface SceneConsultationRequest {
  id: string;
  discipline: string;
  targetZoneIds: string[];
  question: string;
  priority: number;
}

export interface SceneCompositionMetrics {
  zoneCoverage: number;
  zoneCount: number;
  objectCount: number;
  waterCount: number;
  terrainRelief?: number;
  terrainChangedCells?: number;
  familyCounts: Record<string, number>;
  zoneCounts: Record<string, number>;
  unresolvedFamilyIds: string[];
}

export function normalizeSceneCompositionPlan(value: unknown, map: EditableMap): SceneCompositionPlan {
  const input = requireRecord(value, 'invalid_scene_composition');
  const familyValues = requireArray(input.assetFamilies, 'invalid_scene_asset_families')
    .slice(0, SCENE_COMPOSITION_LIMITS.assetFamilyCount);
  const assetFamilies = familyValues.map(normalizeFamily);
  const familyIds = uniqueIds(assetFamilies, 'duplicate_scene_family_id');
  const declaredGrassFamilies = Array.isArray(input.grassFamilies)
    ? input.grassFamilies.slice(0, SCENE_COMPOSITION_LIMITS.grassFamilyCount).map(normalizeGrassFamily)
    : [];
  const zoneValues = requireArray(input.zones, 'invalid_scene_zones').slice(0, SCENE_COMPOSITION_LIMITS.zoneCount);
  if (zoneValues.length < 1) throw new Error('scene_composition_requires_zones');
  const { grassFamilies, grassFamilyReferences } = completeGrassFamilyReferences(declaredGrassFamilies, zoneValues);
  uniqueIds(grassFamilies, 'duplicate_scene_grass_family_id');
  const zones = zoneValues.map((zone) => normalizeZone(zone, map, familyIds, grassFamilyReferences));
  const zoneIds = uniqueIds(zones, 'duplicate_scene_zone_id');
  for (const zone of zones) {
    if (zone.excludeZoneIds.some((id) => !zoneIds.has(id) || id === zone.id)) {
      throw new Error('unknown_scene_exclusion');
    }
  }
  const transitions = Array.isArray(input.transitions)
    ? input.transitions.slice(0, SCENE_COMPOSITION_LIMITS.transitionCount)
      .map((transition) => normalizeTransition(transition, zoneIds))
    : [];
  const consultations = Array.isArray(input.consultations)
    ? input.consultations.slice(0, SCENE_COMPOSITION_LIMITS.consultationCount)
      .map((item) => normalizeConsultation(item, zoneIds))
    : [];
  uniqueIds(consultations, 'duplicate_scene_consultation_id');
  const globalInput = requireRecord(input.globalBrief, 'invalid_scene_global_brief');
  const focalZoneId = cleanId(globalInput.focalZoneId);
  if (!zoneIds.has(focalZoneId)) throw new Error('unknown_scene_focal_zone');
  const intentRequirements = Array.isArray(input.intentRequirements)
    ? input.intentRequirements.slice(0, SCENE_COMPOSITION_LIMITS.requirementCount)
      .map((requirement) => normalizeRequirement(requirement, zones, assetFamilies))
    : derivePlanRequirements(zones, assetFamilies, focalZoneId);
  uniqueIds(intentRequirements, 'duplicate_scene_requirement_id');
  return {
    version: SCENE_COMPOSITION_VERSION,
    summary: cleanText(input.summary, 'AI 场景构图', 200),
    globalBrief: {
      spatialTheme: cleanText(globalInput.spatialTheme, '自然场景', 120),
      visualHierarchy: cleanText(globalInput.visualHierarchy, '', 240),
      assetArtDirection: cleanText(globalInput.assetArtDirection, '', 240),
      focalZoneId,
      terrainBase: normalizeTerrainGenerationParams(globalInput.terrainBase, map)
    },
    intentRequirements,
    zones,
    transitions,
    assetFamilies,
    grassFamilies,
    consultations,
    renderPromptSuggestions: normalizeTextList(input.renderPromptSuggestions, 8, 80)
  };
}

function normalizeRequirement(
  value: unknown,
  zones: SceneCompositionZone[],
  families: SceneAssetFamily[]
): SceneIntentRequirement {
  const input = requireRecord(value, 'invalid_scene_requirement');
  const kind = input.kind === 'water' || input.kind === 'asset-family' ? input.kind : input.kind === 'terrain' ? 'terrain' : null;
  if (!kind) throw new Error('invalid_scene_requirement');
  const targetZoneId = input.targetZoneId === undefined ? undefined : requireId(input.targetZoneId, 'invalid_scene_requirement');
  const familyId = input.familyId === undefined ? undefined : requireId(input.familyId, 'invalid_scene_requirement');
  const zone = targetZoneId ? zones.find((item) => item.id === targetZoneId) : undefined;
  if (targetZoneId && !zone) throw new Error('unknown_scene_requirement_zone');
  if (kind === 'water' && (!zone || !zone.water)) throw new Error('scene_water_requirement_requires_water_zone');
  if (kind === 'asset-family' && (!familyId || !families.some((family) => family.id === familyId))) {
    throw new Error('unknown_scene_requirement_family');
  }
  return {
    id: requireId(input.id, 'invalid_scene_requirement'),
    kind,
    description: cleanText(input.description, kind, 160),
    ...(targetZoneId ? { targetZoneId } : {}),
    ...(familyId ? { familyId } : {}),
    minCount: Math.round(clamp(finiteNumber(input.minCount, 1), 1, 24))
  };
}

function derivePlanRequirements(
  zones: SceneCompositionZone[],
  families: SceneAssetFamily[],
  focalZoneId: string
): SceneIntentRequirement[] {
  const requirements: SceneIntentRequirement[] = [{
    id: 'terrain-foundation',
    kind: 'terrain',
    description: 'The planned terrain foundation must produce visible height-field data.',
    targetZoneId: focalZoneId,
    minCount: 1
  }];
  for (const zone of zones.filter((item) => item.water)) {
    requirements.push({
      id: `water-${zone.id}`,
      kind: 'water',
      description: `${zone.label} must exist as editable structured water.`,
      targetZoneId: zone.id,
      minCount: 1
    });
  }
  for (const family of families.filter((item) => item.priority >= 0.85)) {
    requirements.push({
      id: `family-${family.id}`,
      kind: 'asset-family',
      description: `${family.label} must appear in the scene.`,
      familyId: family.id,
      minCount: 1
    });
  }
  return requirements.slice(0, SCENE_COMPOSITION_LIMITS.requirementCount);
}

export function sceneZoneWorldRegion(zone: SceneCompositionZone, map: EditableMap): { x: number; z: number; r: number } {
  const bounds = getMapBounds(map);
  const halfWidth = (bounds.maxX - bounds.minX) / 2;
  const halfDepth = (bounds.maxZ - bounds.minZ) / 2;
  return {
    x: zone.region.center[0] * halfWidth,
    z: zone.region.center[1] * halfDepth,
    r: zone.region.radius * Math.min(halfWidth, halfDepth)
  };
}

export function isCompositionEmptyMap(map: EditableMap): boolean {
  return map.objects.length === 0
    && map.waterBodies.length === 0
    && map.paintStrokes.length === 0
    && map.grassLayers.every((layer) => layer.densities.every((density) => density <= 0.001))
    && map.terrain.heights.every((height) => Math.abs(height) < 0.001);
}

function normalizeFamily(value: unknown): SceneAssetFamily {
  const input = requireRecord(value, 'invalid_scene_asset_family');
  const sizeClass = input.sizeClass === 'small' || input.sizeClass === 'medium' || input.sizeClass === 'large'
    ? input.sizeClass
    : null;
  if (!sizeClass) throw new Error('invalid_scene_asset_family');
  const tags = normalizeTags(input.tags);
  const identityTags = Array.isArray(input.identityTags)
    ? normalizeTags(input.identityTags)
    : deriveIdentityTags(tags);
  const requiredIdentityTags = identityTags.length > 0 ? identityTags : tags.slice(0, 1);
  return {
    id: requireId(input.id, 'invalid_scene_asset_family'),
    label: cleanText(input.label, String(input.id ?? ''), 64),
    role: cleanText(input.role, 'scene asset', 80),
    tags: [...new Set([...tags, ...requiredIdentityTags])],
    identityTags: requiredIdentityTags,
    sizeClass,
    desiredVariants: Math.round(clamp(finiteNumber(input.desiredVariants, 1), 1, 3)),
    priority: clamp(finiteNumber(input.priority, 0.5), 0, 1),
    generationBrief: cleanText(input.generationBrief, '', 320)
  };
}

function normalizeConsultation(value: unknown, zoneIds: Set<string>): SceneConsultationRequest {
  const input = requireRecord(value, 'invalid_scene_consultation');
  const targetZoneIds = normalizeIds(input.targetZoneIds, 4);
  if (targetZoneIds.some((id) => !zoneIds.has(id))) throw new Error('unknown_scene_consultation_zone');
  return {
    id: requireId(input.id, 'invalid_scene_consultation'),
    discipline: cleanText(input.discipline, 'scene design', 80),
    targetZoneIds,
    question: cleanText(input.question, '', 320),
    priority: clamp(finiteNumber(input.priority, 0.5), 0, 1)
  };
}

function normalizeZone(
  value: unknown,
  map: EditableMap,
  familyIds: Set<string>,
  grassFamilyReferences: ReadonlyMap<string, string>
): SceneCompositionZone {
  const input = requireRecord(value, 'invalid_scene_zone');
  const role = SCENE_ZONE_ROLES.includes(input.role as SceneZoneRole) ? input.role as SceneZoneRole : null;
  if (!role) throw new Error('invalid_scene_zone');
  const regionInput = requireRecord(input.region, 'invalid_scene_zone_region');
  const center = requirePair(regionInput.center, 'invalid_scene_zone_region');
  const briefInput = requireRecord(input.brief, 'invalid_scene_zone_brief');
  const terrainInput = requireRecord(input.terrain, 'invalid_scene_zone_terrain');
  const layers = Array.isArray(input.layers)
    ? input.layers.slice(0, 8).map((layer) => normalizeLayer(layer, familyIds))
    : [];
  const grassLayers = Array.isArray(input.grassLayers)
    ? input.grassLayers.slice(0, SCENE_COMPOSITION_LIMITS.grassFamilyCount)
      .map((layer) => normalizeZoneGrassLayer(layer, grassFamilyReferences))
    : [];
  const water = input.water === undefined || input.water === null
    ? undefined
    : normalizeZoneWater(input.water, map);
  return {
    id: requireId(input.id, 'invalid_scene_zone'),
    label: cleanText(input.label, String(input.id ?? ''), 64),
    role,
    importance: clamp(finiteNumber(input.importance, 0.5), 0, 1),
    region: {
      kind: 'circle',
      center: [clamp(center[0], -1, 1), clamp(center[1], -1, 1)],
      radius: clamp(finiteNumber(regionInput.radius, 0.25), 0.05, 0.9)
    },
    brief: {
      atmosphere: cleanText(briefInput.atmosphere, '', 160),
      hierarchy: cleanText(briefInput.hierarchy, '', 200),
      openness: clamp(finiteNumber(briefInput.openness, 0.5), 0, 1),
      transitionIntent: cleanText(briefInput.transitionIntent, '', 160)
    },
    terrain: {
      elevation: clamp(finiteNumber(terrainInput.elevation, 0), -1, 1),
      roughness: clamp(finiteNumber(terrainInput.roughness, 0.5), 0, 1),
      flatness: clamp(finiteNumber(terrainInput.flatness, 0), 0, 1)
    },
    water,
    layers,
    grassLayers,
    excludeZoneIds: normalizeIds(input.excludeZoneIds, 8)
  };
}

function normalizeGrassFamily(value: unknown): SceneGrassFamily {
  const input = requireRecord(value, 'invalid_scene_grass_family');
  const mixInput = input.mix === undefined ? {} : requireRecord(input.mix, 'invalid_scene_grass_family');
  const short = Math.max(0, finiteNumber(mixInput.short, 0.7));
  const tall = Math.max(0, finiteNumber(mixInput.tall, 0.2));
  const flowers = Math.max(0, finiteNumber(mixInput.flowers, 0.1));
  const total = short + tall + flowers || 1;
  return {
    id: requireId(input.id, 'invalid_scene_grass_family'),
    label: cleanText(input.label, String(input.id ?? ''), 64),
    mix: { short: short / total, tall: tall / total, flowers: flowers / total }
  };
}

function completeGrassFamilyReferences(
  declared: readonly SceneGrassFamily[],
  zoneValues: readonly unknown[]
): { grassFamilies: SceneGrassFamily[]; grassFamilyReferences: Map<string, string> } {
  const grassFamilies = [...declared];
  const references = new Map<string, string>();
  const addAliases = (family: SceneGrassFamily) => {
    references.set(family.id, family.id);
    references.set(grassReferenceKey(family.id), family.id);
    references.set(grassReferenceKey(family.label), family.id);
  };
  grassFamilies.forEach(addAliases);

  for (const zoneValue of zoneValues) {
    if (!zoneValue || typeof zoneValue !== 'object' || Array.isArray(zoneValue)) continue;
    const layers = (zoneValue as Record<string, unknown>).grassLayers;
    if (!Array.isArray(layers)) continue;
    for (const layerValue of layers) {
      if (!layerValue || typeof layerValue !== 'object' || Array.isArray(layerValue)) continue;
      const sourceId = cleanId((layerValue as Record<string, unknown>).grassFamilyId);
      if (!sourceId || resolveGrassFamilyReference(references, sourceId)) continue;

      if (grassFamilies.length < SCENE_COMPOSITION_LIMITS.grassFamilyCount) {
        const family: SceneGrassFamily = {
          id: sourceId,
          label: sourceId.replace(/[-_]+/g, ' '),
          mix: { short: 0.72, tall: 0.23, flowers: 0.05 }
        };
        grassFamilies.push(family);
        addAliases(family);
      } else if (grassFamilies[0]) {
        references.set(sourceId, grassFamilies[0].id);
        references.set(grassReferenceKey(sourceId), grassFamilies[0].id);
      }
    }
  }
  return { grassFamilies, grassFamilyReferences: references };
}

function normalizeZoneGrassLayer(
  value: unknown,
  familyReferences: ReadonlyMap<string, string>
): SceneZoneGrassLayer {
  const input = requireRecord(value, 'invalid_scene_grass_layer');
  const sourceId = requireId(input.grassFamilyId, 'invalid_scene_grass_layer');
  const grassFamilyId = resolveGrassFamilyReference(familyReferences, sourceId);
  if (!grassFamilyId) throw new Error('unknown_scene_grass_family');
  return {
    grassFamilyId,
    density: clamp(finiteNumber(input.density, 0.65), 0, 1),
    variation: clamp(finiteNumber(input.variation, 0.2), 0, 1),
    edgeFalloff: clamp(finiteNumber(input.edgeFalloff, 0.25), 0, 1),
    residualDensity: clamp(finiteNumber(input.residualDensity, 0.08), 0, 1)
  };
}

const BROAD_ASSET_TAGS = new Set([
  'animal', 'architecture', 'building', 'decor', 'environment', 'forest',
  'landmark', 'nature', 'organic', 'outdoor', 'plant', 'prop', 'structure',
  'tree', 'vegetation', 'voxel', 'voxel-pro', 'woodland'
]);

function deriveIdentityTags(tags: string[]): string[] {
  const specific = tags.filter((tag) => !BROAD_ASSET_TAGS.has(tag));
  return specific.length > 0 ? specific.slice(0, 3) : tags.slice(0, 1);
}

function resolveGrassFamilyReference(references: ReadonlyMap<string, string>, id: string): string | undefined {
  return references.get(id) ?? references.get(grassReferenceKey(id));
}

function grassReferenceKey(value: string): string {
  return cleanId(value).replace(/[-_]/g, '');
}

function normalizeLayer(value: unknown, familyIds: Set<string>): SceneZoneLayer {
  const input = requireRecord(value, 'invalid_scene_layer');
  const familyId = requireId(input.familyId, 'invalid_scene_layer');
  if (!familyIds.has(familyId)) throw new Error('unknown_scene_family');
  const distribution = SCENE_DISTRIBUTIONS.includes(input.distribution as SceneDistribution)
    ? input.distribution as SceneDistribution
    : 'even';
  const scaleRange = requirePair(input.scaleRange ?? [0.9, 1.1], 'invalid_scene_layer');
  return {
    familyId,
    density: clamp(finiteNumber(input.density, 0.04), 0.0001, 1),
    scaleRange: [
      clamp(Math.min(scaleRange[0], scaleRange[1]), 0.1, 8),
      clamp(Math.max(scaleRange[0], scaleRange[1]), 0.1, 8)
    ],
    distribution,
    edgeFalloff: clamp(finiteNumber(input.edgeFalloff, 0.25), 0, 1)
  };
}

function normalizeZoneWater(value: unknown, map: EditableMap): SceneCompositionZone['water'] {
  const input = requireRecord(value, 'invalid_scene_zone_water');
  // A pond is represented by the same editable basin as a lake. Accept the
  // natural planning vocabulary the director is likely to use, then persist
  // the one canonical runtime type.
  const type = String(input.type ?? input.kind ?? 'lake').trim().toLowerCase();
  if (!['lake', 'pond', 'pool'].includes(type)) throw new Error('invalid_scene_zone_water');
  return {
    type: 'lake',
    level: clamp(finiteNumber(input.level, 0.2), 0.02, map.box.size[1] - 0.05),
    depth: clamp(finiteNumber(input.depth, 1.5), 0.1, 8)
  };
}

function normalizeTransition(value: unknown, zoneIds: Set<string>): SceneTransition {
  const input = requireRecord(value, 'invalid_scene_transition');
  const fromZoneId = requireId(input.fromZoneId, 'invalid_scene_transition');
  const toZoneId = requireId(input.toZoneId, 'invalid_scene_transition');
  if (!zoneIds.has(fromZoneId) || !zoneIds.has(toZoneId) || fromZoneId === toZoneId) {
    throw new Error('unknown_scene_transition_zone');
  }
  const kind = input.kind === 'shore' || input.kind === 'buffer' ? input.kind : 'soft';
  return { fromZoneId, toZoneId, kind, width: clamp(finiteNumber(input.width, 0.1), 0.01, 0.5) };
}

function uniqueIds<T extends { id: string }>(items: T[], error: string): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(error);
    ids.add(item.id);
  }
  return ids;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48))
    .filter(Boolean))]
    .slice(0, 12);
}

function normalizeIds(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanId).filter(Boolean))].slice(0, max);
}

function normalizeTextList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean))]
    .slice(0, maxItems);
}

function requireRecord(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, error: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(error);
  return value;
}

function requirePair(value: unknown, error: string): [number, number] {
  if (!Array.isArray(value) || value.length < 2) throw new Error(error);
  const left = Number(value[0]);
  const right = Number(value[1]);
  if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error(error);
  return [left, right];
}

function requireId(value: unknown, error: string): string {
  const id = cleanId(value);
  if (!id) throw new Error(error);
  return id;
}

function cleanId(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 64)
    : '';
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
