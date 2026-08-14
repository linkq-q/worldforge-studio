import {
  getMapBounds,
  TERRAIN_MIN_HEIGHT,
  type EditableMap,
  type MapBehaviorKind,
  type MapLocomotion
} from './map';
import type { MapScatterQuality } from './mapScatter';
import { normalizeMapAssetLight, type MapAssetLight, type MapAssetSizeClass } from './mapAssetMetadata';
import { isCeilingMountedSemantic } from './indoorScale';
import { normalizeInteriorArtDirection, type InteriorArtDirection } from './interiorArtDirection';
import {
  inferGrassPreset,
  normalizeGrassPreset,
  type GrassPresetId
} from './mapGrass';
import {
  TERRAIN_CLIFF_LAYOUTS,
  TERRAIN_ACCESS_MODES,
  TERRAIN_MODIFIERS,
  TERRAIN_SURFACES,
  normalizeTerrainGenerationParams,
  normalizeTerrainRefinementParams,
  type TerrainCliffLayout,
  type TerrainAccessMode,
  type TerrainGenerationParams,
  type TerrainModifier,
  type TerrainRefinementParams,
  type TerrainSurfaceKind
} from './terrainGeneration';

export const SCENE_COMPOSITION_VERSION = 1 as const;
export const MIN_SCENE_COVERAGE = 0.8;
export const SCENE_COMPOSITION_LIMITS = Object.freeze({
  zoneCount: 12,
  assetFamilyCount: 16,
  grassFamilyCount: 6,
  transitionCount: 16,
  consultationCount: 2,
  specialistPatchCount: 6,
  reviewPatchCount: 8,
  requirementCount: 16
});
export const SCENE_ZONE_ROLES = ['primary', 'secondary', 'transition', 'negative-space'] as const;
export const SCENE_DISTRIBUTIONS = ['even', 'clustered', 'accent'] as const;
export const SCENE_PLACEMENT_MODES = ['anchor', 'field', 'patch', 'linear', 'layout', 'attached'] as const;
export const SCENE_LAYOUT_PATTERNS = ['row', 'courtyard', 'radial', 'grid', 'arc'] as const;
export const SCENE_PLACEMENT_INTENTS = [
  'landmark', 'settlement', 'street-edge', 'audience', 'social',
  'viewpoint', 'wall', 'attached-service', 'playground', 'functional-group', 'paired', 'supported'
] as const;

export type SceneZoneRole = typeof SCENE_ZONE_ROLES[number];
export type SceneDistribution = typeof SCENE_DISTRIBUTIONS[number];
export type ScenePlacementMode = typeof SCENE_PLACEMENT_MODES[number];
export type SceneLayoutPattern = typeof SCENE_LAYOUT_PATTERNS[number];
export type ScenePlacementIntent = typeof SCENE_PLACEMENT_INTENTS[number];

export interface SceneCompositionPlan {
  version: 1;
  summary: string;
  globalBrief: {
    spatialTheme: string;
    visualHierarchy: string;
    assetArtDirection: string;
    interiorArtDirection?: InteriorArtDirection;
    focalZoneId: string;
    terrainBase: TerrainGenerationParams;
    terrainRefinement?: TerrainRefinementParams;
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
  /** Indoor layout policy. Omitted model output defaults to symmetric. */
  symmetry?: 'symmetric' | 'asymmetric';
  /** World-space mirror plane normal. `x` means mirror across X = zone center X. */
  symmetryAxis?: 'x' | 'z';
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
    modifier?: TerrainModifier;
    layout?: TerrainCliffLayout;
    access?: TerrainAccessMode;
    surface?: TerrainSurfaceKind;
    amplitude?: number;
    softness?: number;
    direction?: number;
    variation?: number;
    layers?: number;
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
  placement?: {
    mode: ScenePlacementMode;
    pattern?: SceneLayoutPattern;
    intent?: ScenePlacementIntent;
    direction: number;
    spacing?: number;
    offset: number;
    facing: 'random' | 'guide' | 'inward' | 'outward';
    targetFamilyId?: string;
    focusFamilyId?: string;
    guidePoints?: Array<[number, number]>;
    maxPerGroup?: number;
    arcDegrees?: number;
    aisleEvery?: number;
    spacingByFamily?: Record<string, number>;
    habitat?: {
      height?: [number, number, number, number];
      slope?: [number, number, number, number];
      waterDistance?: [number, number, number, number];
    };
  };
}

export interface SceneGrassFamily {
  id: string;
  label: string;
  preset: GrassPresetId;
  height: number;
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
  /** Structured local illumination chosen by the director; emissive-only props omit it. */
  light?: MapAssetLight;
  behavior?: SceneBehaviorProfile;
}

export interface SceneBehaviorProfile {
  kind: MapBehaviorKind;
  locomotion: MapLocomotion;
  groupCount: number;
  coreRatio: number;
  outlierMinDistance: number;
  altitudeRange: [number, number];
  coreState: string;
  outlierState: string;
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
  /** Objects placed by the coherent composition compiler before outcome repairs and fallbacks. */
  initialObjectCount?: number;
  objectCount: number;
  waterCount: number;
  terrainRelief?: number;
  terrainChangedCells?: number;
  indoorFloorOccupancy?: number;
  indoorObjectSpread?: number;
  familyCounts: Record<string, number>;
  zoneCounts: Record<string, number>;
  unresolvedFamilyIds: string[];
  behaviorQuality?: Record<string, MapScatterQuality>;
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
  const normalizedZones = zoneValues.map((zone) => normalizeZone(zone, map, familyIds, grassFamilyReferences));
  const zones = map.sceneMode === 'indoor'
    ? normalizedZones.map((zone) => ({
        ...zone,
        terrain: { elevation: 0, roughness: 0, flatness: 1 },
        water: undefined,
        grassLayers: []
      }))
    : normalizedZones;
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
  const normalizedRequirements = Array.isArray(input.intentRequirements)
    ? normalizeRequirements(input.intentRequirements, normalizedZones, assetFamilies, focalZoneId)
    : derivePlanRequirements(zones, assetFamilies, focalZoneId);
  const intentRequirements = map.sceneMode === 'indoor'
    ? normalizedRequirements.filter((requirement) => requirement.kind === 'asset-family')
    : normalizedRequirements;
  uniqueIds(intentRequirements, 'duplicate_scene_requirement_id');
  return {
    version: SCENE_COMPOSITION_VERSION,
    summary: cleanText(input.summary, 'AI 场景构图', 200),
    globalBrief: {
      spatialTheme: cleanText(globalInput.spatialTheme, '自然场景', 120),
      visualHierarchy: cleanText(globalInput.visualHierarchy, '', 240),
      assetArtDirection: cleanText(globalInput.assetArtDirection, '', 240),
      ...(map.sceneMode !== 'outdoor'
        ? { interiorArtDirection: normalizeInteriorArtDirection(
            (globalInput.interiorArtDirection as Partial<InteriorArtDirection> | undefined) ?? {
              summary: cleanText(globalInput.assetArtDirection, 'coherent indoor art direction', 240)
            },
            map.seed
          ) ?? undefined }
        : {}),
      focalZoneId,
      terrainBase: normalizeTerrainGenerationParams(globalInput.terrainBase, map),
      terrainRefinement: normalizeTerrainRefinementParams(globalInput.terrainRefinement)
    },
    intentRequirements,
    zones,
    transitions,
    assetFamilies,
    grassFamilies: map.sceneMode === 'indoor' ? [] : grassFamilies,
    consultations,
    renderPromptSuggestions: normalizeTextList(input.renderPromptSuggestions, 8, 80)
  };
}

export type SceneAssetCategory = 'architecture' | 'furniture' | 'facility' | 'prop' | 'nature' | 'creature';

export function sceneAssetCategory(family: SceneAssetFamily): SceneAssetCategory {
  const semantic = sceneFamilySemantic(family);
  if (/animal|creature|bird|fish|deer|sheep|动物|生物|鸟|鱼|鹿|羊/i.test(semantic)) return 'creature';
  if (/tree|plant|grass|flower|shrub|rock|stone|forest|树|植物|草|花|灌木|岩|石|森林/i.test(semantic)) return 'nature';
  if (/swing|slide|playground|gym|fountain|monument|秋千|滑梯|游乐|健身|喷泉|纪念碑/i.test(semantic)) return 'facility';
  if (/bench|chair|seat|pew|sofa|bed|cabinet|shelf|table|desk|stool|长椅|椅|座椅|长凳|沙发|床|柜|架|桌/i.test(semantic)) return 'furniture';
  if (/building|structure|house|cabin|church|shop|tower|pavilion|建筑|房|屋|教堂|商店|塔|亭/i.test(semantic)) return 'architecture';
  return 'prop';
}

/** Converts unsafe model-selected furniture patterns into bounded relationship layouts. */
export function enforceScenePlacementContracts(
  plan: SceneCompositionPlan,
  map: EditableMap,
  prompt = ''
): SceneCompositionPlan {
  const families = new Map(plan.assetFamilies.map((family) => [family.id, family]));
  const zones = plan.zones.map((zone) => {
    const zoneSemantic = `${zone.label} ${zone.brief.atmosphere} ${zone.brief.hierarchy} ${prompt}`;
    const audienceFocusFamilyId = findAudienceFocusFamilyId(zone, families);
    const relatedGroupFamilyId = findRelatedGroupFamilyId(zone, families, zoneSemantic);
    return {
      ...zone,
      layers: zone.layers.map((layer): SceneZoneLayer => {
      const family = families.get(layer.familyId);
      if (!family) return layer;
      const category = sceneAssetCategory(family);
      const semantic = sceneFamilySemantic(family);
      const current = layer.placement ?? {
        mode: layer.distribution === 'accent' ? 'anchor' as const : 'layout' as const,
        direction: plan.globalBrief.terrainBase.seed % 360,
        offset: 0,
        facing: 'random' as const
      };
      const supportFamilyId = current.intent === 'supported'
        ? current.targetFamilyId
        : findSupportFamilyId(zone, families, family);

      if (map.sceneMode === 'indoor' && (current.intent === 'supported' || supportFamilyId)) {
        return {
          ...layer,
          distribution: 'clustered' as const,
          placement: {
            ...current, mode: 'attached', pattern: undefined, intent: 'supported', facing: 'guide',
            targetFamilyId: supportFamilyId,
            maxPerGroup: 1
          }
        };
      }

      if (map.sceneMode === 'indoor' && category === 'prop'
        && /wall-prop|wall mounted|cross|door|window|blackboard|chalkboard|whiteboard|notice board|menu board|wall[-_ ]?clock|timepiece|poster|painting|safety sign|fire extinguisher|墙面|壁挂|十字架|门|窗|黑板|白板|公告板|菜单板|挂钟|时钟|海报|挂画|安全标识|灭火器/i.test(semantic)) {
        return {
          ...layer,
          distribution: 'even' as const,
          placement: {
            ...current, mode: 'linear', pattern: 'row', intent: 'wall', facing: 'inward',
            maxPerGroup: Math.min(current.maxPerGroup ?? 1, 4)
          }
        };
      }
      if (map.sceneMode === 'indoor' && family.id === audienceFocusFamilyId && category !== 'furniture') {
        return {
          ...layer,
          distribution: 'accent' as const,
          placement: { ...current, mode: 'anchor', pattern: undefined, intent: 'landmark', facing: 'guide' }
        };
      }
      if (map.sceneMode === 'indoor'
        && /ceiling[-_ ]?mounted|ceiling[-_ ]?light|industrial[-_ ]?light|overhead[-_ ]?light|pendant[-_ ]?light|顶灯|吊灯|工业照明/i.test(semantic)) {
        return {
          ...layer,
          distribution: 'even' as const,
          placement: {
            ...current, mode: 'layout', pattern: 'grid', intent: 'functional-group', facing: 'guide',
            maxPerGroup: 12
          }
        };
      }
      if (map.sceneMode === 'indoor'
        && /warehouse|storage|仓库|库房/i.test(zoneSemantic)
        && /shelf|rack|crate|box|pallet|货架|箱|托盘/i.test(semantic)) {
        return {
          ...layer,
          distribution: 'even' as const,
          placement: {
            ...current, mode: 'layout', pattern: 'grid', intent: 'functional-group', facing: 'guide',
            maxPerGroup: Math.min(current.maxPerGroup ?? 12, 12), aisleEvery: current.aisleEvery ?? 3
          }
        };
      }

      if (category === 'facility' && /swing|slide|playground|gym|秋千|滑梯|游乐|健身/i.test(semantic)) {
        return {
          ...layer,
          distribution: 'even' as const,
          placement: {
            ...current,
            mode: 'layout', pattern: 'arc', intent: 'playground', maxPerGroup: 2, arcDegrees: 36,
            direction: familyPlacementDirection(plan.globalBrief.terrainBase.seed, family.id)
          }
        };
      }
      if (category !== 'furniture') return layer;

      const explicitCircle = /amphitheater|circular seating|ceremony|ritual|圆形剧场|环形座位|仪式/i.test(semantic);
      let intent = current.intent ?? inferFurnitureIntent(semantic, current.targetFamilyId, zoneSemantic);
      const classroom = /classroom|school|教室|课堂|学校/i.test(zoneSemantic);
      const dining = /restaurant|diner|cafe|cafeteria|餐厅|饭店|咖啡馆|食堂/i.test(zoneSemantic);
      const office = /office|workplace|办公室|办公区/i.test(zoneSemantic);
      const identitySemantic = `${family.id} ${family.label} ${family.tags.join(' ')}`;
      const seatingFurniture = /chair|stool|椅|座椅/i.test(identitySemantic)
        || (/\bseat\b/i.test(identitySemantic)
          && !/table|desk|workstation|four[-_ ]?seat|四人|餐桌|饭桌/i.test(identitySemantic));
      if (relatedGroupFamilyId && seatingFurniture) {
        intent = dining ? 'social' : classroom || office ? 'paired' : intent;
      } else if ((classroom || dining || office)
        && /desk|table|workstation|课桌|餐桌|办公桌|工位/i.test(semantic)) {
        intent = 'functional-group';
      }
      if ((current.pattern === 'courtyard' || current.pattern === 'radial') && !explicitCircle) intent = 'viewpoint';
      if ((intent === 'social' || intent === 'attached-service') && !current.targetFamilyId && !relatedGroupFamilyId) {
        intent = /road|street|path|walkway|道路|街道|步道|沿路/i.test(semantic) ? 'street-edge' : 'viewpoint';
      }

      if (intent === 'audience') return {
        ...layer,
        distribution: 'even' as const,
        placement: {
          ...current, mode: 'layout', pattern: 'grid', intent,
          facing: current.facing === 'random' ? 'inward' : current.facing,
          focusFamilyId: current.focusFamilyId ?? audienceFocusFamilyId,
          maxPerGroup: Math.min(current.maxPerGroup ?? 24, 24), aisleEvery: current.aisleEvery ?? 4
        }
      };
      if (intent === 'street-edge') return {
        ...layer,
        distribution: 'even' as const,
        placement: {
          ...current, mode: 'linear', pattern: 'row', intent, facing: 'guide',
          maxPerGroup: Math.min(current.maxPerGroup ?? 4, 6),
          offset: Math.abs(current.offset) < 0.8 ? 1.5 : current.offset
        }
      };
      if (intent === 'social' || intent === 'attached-service') return {
        ...layer,
        distribution: 'clustered' as const,
        placement: {
          ...current, mode: 'attached', pattern: undefined, intent, facing: 'inward',
          targetFamilyId: current.targetFamilyId ?? relatedGroupFamilyId,
          maxPerGroup: intent === 'social'
            ? seatsPerDiningTarget(families.get(relatedGroupFamilyId ?? ''))
              ?? Math.min(current.maxPerGroup ?? (dining ? 4 : 6), 8)
            : Math.min(current.maxPerGroup ?? 1, 2)
        }
      };
      if (intent === 'paired') return {
        ...layer,
        distribution: 'clustered' as const,
        placement: {
          ...current, mode: 'attached', pattern: undefined, intent,
          facing: audienceFocusFamilyId ? 'inward' : 'guide',
          targetFamilyId: current.targetFamilyId ?? relatedGroupFamilyId,
          focusFamilyId: current.focusFamilyId ?? audienceFocusFamilyId,
          maxPerGroup: 1
        }
      };
      if (intent === 'functional-group') return {
        ...layer,
        distribution: 'even' as const,
        placement: {
          ...current, mode: 'layout', pattern: 'grid', intent,
          facing: audienceFocusFamilyId || office ? 'inward' : current.facing === 'random' ? 'guide' : current.facing,
          focusFamilyId: current.focusFamilyId ?? audienceFocusFamilyId,
          maxPerGroup: Math.min(current.maxPerGroup ?? 12, 24), aisleEvery: current.aisleEvery ?? 4
        }
      };
      if (intent === 'wall') return {
        ...layer,
        distribution: 'even' as const,
        placement: {
          ...current, mode: 'linear', pattern: 'row', intent, facing: 'inward',
          maxPerGroup: Math.min(current.maxPerGroup ?? 6, 10)
        }
      };
      if (explicitCircle) return {
        ...layer,
        placement: { ...current, intent: 'viewpoint', maxPerGroup: Math.min(current.maxPerGroup ?? 12, 16) }
      };
      return {
        ...layer,
        distribution: 'even' as const,
        placement: {
          ...current, mode: 'layout', pattern: 'arc', intent: 'viewpoint', facing: 'inward',
          maxPerGroup: Math.min(current.maxPerGroup ?? 5, 5), arcDegrees: Math.min(current.arcDegrees ?? 110, 140)
        }
      };
      })
    };
  });
  return { ...plan, zones };
}

function inferFurnitureIntent(semantic: string, targetFamilyId?: string, zoneSemantic = ''): ScenePlacementIntent {
  if (/bench|chair|seat|pew|长椅|椅子|座椅|长凳/i.test(semantic)
    && /church|chapel|classroom|cinema|theater|altar|stage|教堂|礼拜堂|教室|影院|礼堂|祭坛|舞台/i.test(zoneSemantic)) {
    return 'audience';
  }
  if (/pew|audience|church|classroom|cinema|theater|altar|stage|教堂|观众|教室|影院|礼堂|祭坛|舞台/i.test(semantic)) return 'audience';
  if (/road|street|path|walkway|roadside|道路|街道|步道|路边|沿路/i.test(semantic)) return 'street-edge';
  if (/sofa|bed|cabinet|shelf|wardrobe|wall|沙发|床|柜|书架|衣柜|靠墙/i.test(semantic)) return 'wall';
  if (/table|dining|cafe|campfire|firepit|餐桌|咖啡|篝火|火坑/i.test(semantic)) return targetFamilyId ? 'social' : 'viewpoint';
  if (/bin|planter|umbrella|service|垃圾桶|花盆|遮阳伞|附属/i.test(semantic)) return targetFamilyId ? 'attached-service' : 'street-edge';
  return 'viewpoint';
}

function findAudienceFocusFamilyId(
  zone: SceneCompositionZone,
  families: ReadonlyMap<string, SceneAssetFamily>
): string | undefined {
  const local = zone.layers
    .map((layer) => families.get(layer.familyId))
    .filter((family): family is SceneAssetFamily => Boolean(family));
  const candidates = [...local, ...[...families.values()].filter((family) => !local.includes(family))];
  return candidates.find((family) => (
    sceneAssetCategory(family) !== 'furniture'
    && /altar|stage|pulpit|lectern|blackboard|chalkboard|whiteboard|teaching surface|祭坛|舞台|讲台|黑板|白板/i.test(sceneFamilySemantic(family))
  ))?.id ?? candidates.find((family) => (
    sceneAssetCategory(family) === 'architecture'
    && /church|chapel|教堂|礼拜堂/i.test(sceneFamilySemantic(family))
  ))?.id;
}

function findRelatedGroupFamilyId(
  zone: SceneCompositionZone,
  families: ReadonlyMap<string, SceneAssetFamily>,
  zoneSemantic: string
): string | undefined {
  const local = zone.layers
    .map((layer) => families.get(layer.familyId))
    .filter((family): family is SceneAssetFamily => Boolean(family));
  const candidates = [...local, ...[...families.values()].filter((family) => !local.includes(family))];
  const pattern = /classroom|school|教室|课堂|学校/i.test(zoneSemantic)
    ? /student desk|classroom desk|school desk|课桌|学生桌/i
    : /restaurant|diner|cafe|cafeteria|餐厅|饭店|咖啡馆|食堂/i.test(zoneSemantic)
      ? /dining table|restaurant table|cafe table|coffee table|餐桌|饭桌|咖啡桌/i
      : /office|workplace|办公室|办公区/i.test(zoneSemantic)
        ? /office desk|work desk|workstation|办公桌|工位/i
        : null;
  return pattern ? candidates.find((family) => pattern.test(sceneFamilySemantic(family)))?.id : undefined;
}

function findSupportFamilyId(
  zone: SceneCompositionZone,
  families: ReadonlyMap<string, SceneAssetFamily>,
  dependent: SceneAssetFamily
): string | undefined {
  const dependentSemantic = sceneFamilySemantic(dependent);
  const targetPattern = /computer|monitor|keyboard|desktop pc|电脑|显示器|键盘/i.test(dependentSemantic)
    ? /gaming desk|computer desk|office desk|work desk|workstation|网吧桌|电脑桌|办公桌|工位/i
    : /television|\btv\b|电视/i.test(dependentSemantic)
      ? /media console|tv stand|television cabinet|电视柜|媒体柜/i
      : /kettle|toaster|coffee machine|countertop appliance|dishware|fruit bowl|水壶|烤面包机|咖啡机|餐具|果盘/i.test(dependentSemantic)
        ? /kitchen counter|countertop|base cabinet|service counter|厨房台面|橱柜|操作台/i
        : /book stack|tray|tabletop decor|茶几摆件|书堆|托盘/i.test(dependentSemantic)
          ? /coffee table|side table|茶几|边几/i
          : null;
  if (!targetPattern) return undefined;
  const localFamilies = zone.layers
    .map((layer) => families.get(layer.familyId))
    .filter((family): family is SceneAssetFamily => Boolean(family));
  return localFamilies.find((family) => family.id !== dependent.id && targetPattern.test(sceneFamilySemantic(family)))?.id;
}

function seatsPerDiningTarget(family: SceneAssetFamily | undefined): number | undefined {
  if (!family) return undefined;
  const semantic = sceneFamilySemantic(family);
  if (/two[-_ ]?(?:person|seat)|2[-_ ]?seat|双人|两人/i.test(semantic)) return 2;
  if (/four[-_ ]?(?:person|seat)|4[-_ ]?seat|四人/i.test(semantic)) return 4;
  return undefined;
}

function familyPlacementDirection(seed: number, familyId: string): number {
  let hash = Math.trunc(seed) >>> 0;
  for (const character of familyId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash % 360;
}

function sceneFamilySemantic(family: SceneAssetFamily): string {
  return `${family.label} ${family.role} ${family.tags.join(' ')} ${family.generationBrief}`;
}

/**
 * Preserve explicit, high-level terrain intent after model-authored revisions.
 * This only tightens a clearly requested high mountain; generic hills and
 * valleys remain entirely model-directed.
 */
export function enforcePromptSceneIntent(
  plan: SceneCompositionPlan,
  prompt: string,
  map: EditableMap
): SceneCompositionPlan {
  plan = enforceScenePlacementContracts(plan, map, prompt);
  if (!/高山|雪山|山峰|巍峨|峻峭|high[ -]?mountain|mountain peak|alpine massif/i.test(prompt)) return plan;

  const rockFamilyIds = new Set(plan.assetFamilies
    .filter((family) => isNaturalRockFamily(family))
    .map((family) => family.id));
  const target = [...plan.zones].sort((left, right) => (
    mountainZoneScore(right, rockFamilyIds) - mountainZoneScore(left, rockFamilyIds)
  ))[0];
  if (!target) return plan;

  const assetFamilies = plan.assetFamilies.map((family) => {
    if (!rockFamilyIds.has(family.id)) return family;
    const outcropBrief = 'low wide slope-integrated outcrop, irregular horizontal strata, partially buried base, no cairn, no stacked monument, no freestanding tower';
    return {
      ...family,
      desiredVariants: Math.max(2, family.desiredVariants),
      generationBrief: family.generationBrief.includes('no stacked monument')
        ? family.generationBrief
        : `${family.generationBrief}; ${outcropBrief}`
    };
  });
  const familiesById = new Map(assetFamilies.map((family) => [family.id, family]));
  const mapHeight = map.box.size[1];
  const zones = plan.zones.map((zone) => {
    if (zone.id !== target.id) return zone;
    const layers = [...zone.layers];
    for (const familyId of rockFamilyIds) {
      const index = layers.findIndex((layer) => layer.familyId === familyId);
      const current = index >= 0 ? layers[index] : undefined;
      const family = familiesById.get(familyId);
      const placement = current?.placement;
      const currentScale = current?.scaleRange ?? [0.7, 1.05];
      const next: SceneZoneLayer = {
        familyId,
        density: Math.max(current?.density ?? 0, 0.018),
        scaleRange: [
          clamp(currentScale[0], family?.sizeClass === 'large' ? 0.55 : 0.65, 0.9),
          clamp(currentScale[1], 0.8, family?.sizeClass === 'small' ? 1 : 1.1)
        ],
        distribution: 'clustered',
        edgeFalloff: Math.max(current?.edgeFalloff ?? 0, 0.16),
        placement: {
          ...placement,
          mode: 'patch',
          pattern: placement?.pattern,
          direction: placement?.direction ?? plan.globalBrief.terrainBase.seed % 360,
          spacing: placement?.spacing,
          offset: placement?.offset ?? 0,
          facing: placement?.facing ?? 'random',
          targetFamilyId: placement?.targetFamilyId,
          spacingByFamily: placement?.spacingByFamily,
          habitat: {
            ...placement?.habitat,
            height: [mapHeight * 0.14, mapHeight * 0.22, mapHeight * 0.82, mapHeight - 0.05],
            slope: [6, 14, 58, 78]
          }
        }
      };
      if (index >= 0) layers[index] = next;
      else layers.push(next);
    }
    return {
      ...zone,
      region: { ...zone.region, radius: Math.max(zone.region.radius, 0.62) },
      terrain: {
        ...zone.terrain,
        elevation: Math.max(zone.terrain.elevation, 0.55),
        roughness: Math.max(zone.terrain.roughness, 0.55),
        flatness: Math.min(zone.terrain.flatness, 0.12),
        modifier: 'mountain' as const,
        access: 'scenic' as const,
        surface: 'rock' as const,
        amplitude: Math.max(zone.terrain.amplitude ?? 0, mapHeight * 0.48),
        softness: Math.min(zone.terrain.softness ?? 0.38, 0.38),
        variation: Math.max(zone.terrain.variation ?? 0, 0.55)
      },
      layers
    };
  });
  return { ...plan, assetFamilies, zones };
}

function mountainZoneScore(zone: SceneCompositionZone, rockFamilyIds: ReadonlySet<string>): number {
  const semantic = `${zone.label} ${zone.brief.atmosphere} ${zone.brief.hierarchy}`;
  return (zone.terrain.modifier === 'mountain' ? 8 : zone.terrain.modifier === 'ridge' ? 5 : 0)
    + (/mountain|peak|ridge|alpine|高山|山峰|山脊|裸岩/i.test(semantic) ? 6 : 0)
    + (zone.layers.some((layer) => rockFamilyIds.has(layer.familyId)) ? 4 : 0)
    + zone.region.radius * 2
    + zone.importance;
}

export function isNaturalRockFamily(family: SceneAssetFamily): boolean {
  const semantic = `${family.label} ${family.role} ${family.tags.join(' ')}`;
  return /rock|stone|boulder|outcrop|岩|石/i.test(semantic)
    && !/boundary|border|marker|fence|边界|界石|围栏/i.test(semantic);
}

export function estimateSceneZoneCoverage(plan: SceneCompositionPlan): number {
  const samples = 24;
  let covered = 0;
  for (let z = 0; z < samples; z += 1) {
    for (let x = 0; x < samples; x += 1) {
      const nx = x / (samples - 1) * 2 - 1;
      const nz = z / (samples - 1) * 2 - 1;
      if (plan.zones.some((zone) => (
        Math.hypot(nx - zone.region.center[0], nz - zone.region.center[1]) <= zone.region.radius
      ))) covered += 1;
    }
  }
  return covered / (samples * samples);
}

/** Adds editable low ground cover when the director accidentally leaves most of the map undescribed. */
export function ensureMinimumSceneCoverage(plan: SceneCompositionPlan, map?: EditableMap): SceneCompositionPlan {
  if (estimateSceneZoneCoverage(plan) >= MIN_SCENE_COVERAGE) return plan;

  if (map?.sceneMode === 'indoor') {
    const target = [...plan.zones]
      .filter((zone) => zone.role !== 'negative-space')
      .sort((left, right) => right.importance - left.importance)[0];
    if (!target) throw new Error('scene_composition_insufficient_coverage');
    return {
      ...plan,
      zones: plan.zones.map((zone) => zone.id === target.id ? {
        ...zone,
        region: { kind: 'circle' as const, center: [0, 0] as [number, number], radius: 1.2 }
      } : zone)
    };
  }

  const grassFamily = plan.grassFamilies[0] ?? {
    id: 'ambient-ground-cover',
    label: 'Ambient ground cover',
    preset: 'meadow' as const,
    height: 1,
    mix: { short: 0.82, tall: 0.15, flowers: 0.03 }
  };
  const grassLayer = {
    grassFamilyId: grassFamily.id,
    density: 0.42,
    variation: 0.22,
    edgeFalloff: 0.08,
    residualDensity: 0.12
  };
  const grassFamilies = plan.grassFamilies.length > 0 ? plan.grassFamilies : [grassFamily];

  if (plan.zones.length < SCENE_COMPOSITION_LIMITS.zoneCount) {
    const usedIds = new Set(plan.zones.map((zone) => zone.id));
    let id = 'ambient-ground-cover';
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `ambient-ground-cover-${suffix}`;
    return {
      ...plan,
      grassFamilies,
      zones: [...plan.zones, {
        id,
        label: 'Ambient ground cover',
        role: 'transition',
        importance: 0.1,
        region: { kind: 'circle', center: [0, 0], radius: 1.2 },
        brief: {
          atmosphere: 'Continuous natural ground cover',
          hierarchy: 'Low vegetation fills otherwise blank ground without competing with focal areas',
          openness: 0.82,
          transitionIntent: 'Blend softly beneath the authored zones'
        },
        terrain: { elevation: 0, roughness: 0, flatness: 0 },
        layers: [],
        grassLayers: [grassLayer],
        excludeZoneIds: []
      }]
    };
  }

  const candidateIndex = plan.zones.findIndex((zone) => !zone.water && zone.grassLayers.length > 0);
  const fallbackIndex = plan.zones.findIndex((zone) => !zone.water);
  const index = candidateIndex >= 0 ? candidateIndex : fallbackIndex;
  if (index < 0) throw new Error('scene_composition_insufficient_coverage');
  const zones = plan.zones.map((zone, zoneIndex) => zoneIndex === index ? {
    ...zone,
    region: { kind: 'circle' as const, center: [0, 0] as [number, number], radius: 1.2 },
    grassLayers: zone.grassLayers.length > 0 ? zone.grassLayers : [grassLayer]
  } : zone);
  return { ...plan, grassFamilies, zones };
}

function normalizeRequirements(
  values: unknown[],
  zones: SceneCompositionZone[],
  families: SceneAssetFamily[],
  focalZoneId: string
): SceneIntentRequirement[] {
  const usedIds = new Set<string>();
  const requirements = values
    .slice(0, SCENE_COMPOSITION_LIMITS.requirementCount)
    .map((value, index) => normalizeRequirement(value, zones, families, focalZoneId, index))
    .filter((requirement): requirement is SceneIntentRequirement => Boolean(requirement))
    .map((requirement) => {
      const baseId = requirement.id;
      let id = baseId;
      for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${baseId}-${suffix}`;
      usedIds.add(id);
      return id === baseId ? requirement : { ...requirement, id };
    });
  return requirements.length > 0 || values.length === 0
    ? requirements
    : derivePlanRequirements(zones, families, focalZoneId);
}

function normalizeRequirement(
  value: unknown,
  zones: SceneCompositionZone[],
  families: SceneAssetFamily[],
  focalZoneId: string,
  index: number
): SceneIntentRequirement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const requestedZoneId = cleanId(input.targetZoneId);
  const requestedZone = zones.find((item) => item.id === requestedZoneId);
  const requestedFamilyId = cleanId(input.familyId);
  const requestedFamily = families.find((item) => item.id === requestedFamilyId);
  const description = cleanText(input.description, '', 160);
  const kind = input.kind === 'terrain' || input.kind === 'water' || input.kind === 'asset-family'
    ? input.kind
    : requestedFamily || /asset|object|family|furniture|prop/i.test(String(input.kind ?? ''))
      ? 'asset-family'
      : requestedZone?.water || /pond|lake|pool|water|池|湖|水/i.test(description)
        ? 'water'
        : /terrain|ground|hill|mountain|valley|地形|地面|山|谷/i.test(description)
          ? 'terrain'
          : null;
  if (!kind) return null;

  const zone = kind === 'water'
    ? (requestedZone?.water ? requestedZone : zones.find((item) => item.water))
    : kind === 'terrain'
      ? (requestedZone ?? zones.find((item) => item.id === focalZoneId) ?? zones[0])
      : requestedZone;
  if (kind === 'water' && !zone) return null;

  const family = kind === 'asset-family'
    ? (requestedFamily ?? inferRequirementFamily(description, zone, families))
    : undefined;
  if (kind === 'asset-family' && !family) return null;
  const targetZoneId = zone?.id;
  const familyId = family?.id;
  return {
    id: cleanId(input.id) || `requirement-${kind}-${familyId ?? targetZoneId ?? index + 1}`,
    kind,
    description: description || kind,
    ...(targetZoneId ? { targetZoneId } : {}),
    ...(familyId ? { familyId } : {}),
    minCount: Math.round(clamp(finiteNumber(input.minCount, 1), 1, 24))
  };
}

function inferRequirementFamily(
  description: string,
  zone: SceneCompositionZone | undefined,
  families: SceneAssetFamily[]
): SceneAssetFamily | undefined {
  const localIds = new Set(zone?.layers.map((layer) => layer.familyId) ?? []);
  const localFamilies = families.filter((family) => localIds.has(family.id));
  if (localFamilies.length === 1) return localFamilies[0];
  const semanticMatches = families.filter((family) => [family.id, family.label, ...family.tags]
    .some((term) => term.length >= 2 && description.toLowerCase().includes(term.toLowerCase())));
  if (semanticMatches.length === 1) return semanticMatches[0];
  return families.length === 1 ? families[0] : undefined;
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
  const label = cleanText(input.label, String(input.id ?? ''), 64);
  const role = cleanText(input.role, 'scene asset', 80);
  const generationBrief = cleanText(input.generationBrief, '', 320);
  const tags = normalizeTags(input.tags);
  if (isCeilingMountedSemantic(`${label} ${role} ${tags.join(' ')} ${generationBrief}`)) {
    tags.push('ceiling-mounted');
  }
  const identityTags = Array.isArray(input.identityTags)
    ? normalizeTags(input.identityTags)
    : deriveIdentityTags(tags);
  const requiredIdentityTags = identityTags.length > 0 ? identityTags : tags.slice(0, 1);
  const behavior = normalizeBehaviorProfile(input.behavior, `${label} ${role} ${tags.join(' ')}`);
  const light = normalizeMapAssetLight(input.light);
  return {
    id: requireId(input.id, 'invalid_scene_asset_family'),
    label,
    role,
    tags: [...new Set([...tags, ...requiredIdentityTags])],
    identityTags: requiredIdentityTags,
    sizeClass,
    desiredVariants: Math.round(clamp(finiteNumber(input.desiredVariants, 1), 1, 3)),
    priority: clamp(finiteNumber(input.priority, 0.5), 0, 1),
    generationBrief,
    ...(light ? { light } : {}),
    ...(behavior ? { behavior } : {})
  };
}

function normalizeBehaviorProfile(value: unknown, semantic: string): SceneBehaviorProfile | undefined {
  const inferred = inferBehaviorProfile(semantic);
  if (!value || typeof value !== 'object') return inferred;
  const input = value as Record<string, unknown>;
  const kinds: MapBehaviorKind[] = ['static', 'solitary', 'pair', 'flock', 'herd', 'school', 'territorial'];
  const locomotions: MapLocomotion[] = ['static', 'ground', 'air', 'water', 'mixed'];
  const kind = kinds.includes(input.kind as MapBehaviorKind)
    ? input.kind as MapBehaviorKind
    : inferred?.kind ?? 'solitary';
  const locomotion = locomotions.includes(input.locomotion as MapLocomotion)
    ? input.locomotion as MapLocomotion
    : inferred?.locomotion ?? 'ground';
  const altitude = Array.isArray(input.altitudeRange) && input.altitudeRange.length >= 2
    ? [finiteNumber(input.altitudeRange[0], 0), finiteNumber(input.altitudeRange[1], 0)] as [number, number]
    : inferred?.altitudeRange ?? [0, 0];
  const fallback = inferred ?? defaultBehaviorProfile(kind, locomotion);
  return {
    kind,
    locomotion,
    groupCount: Math.round(clamp(finiteNumber(input.groupCount, fallback.groupCount), 1, 4)),
    coreRatio: clamp(finiteNumber(input.coreRatio, fallback.coreRatio), 0.5, 1),
    outlierMinDistance: clamp(finiteNumber(input.outlierMinDistance, fallback.outlierMinDistance), 0.5, 64),
    altitudeRange: [clamp(Math.min(...altitude), 0, 64), clamp(Math.max(...altitude), 0, 64)],
    coreState: cleanText(input.coreState, fallback.coreState, 48),
    outlierState: cleanText(input.outlierState, fallback.outlierState, 48)
  };
}

function inferBehaviorProfile(semantic: string): SceneBehaviorProfile | undefined {
  const text = semantic.toLowerCase();
  if (/\b(bird|gull|seagull|crow|eagle|海鸥|鸟)\b/.test(text)) {
    return { kind: 'flock', locomotion: 'mixed', groupCount: 2, coreRatio: 0.72, outlierMinDistance: 7, altitudeRange: [3, 8], coreState: 'feed', outlierState: 'fly' };
  }
  if (/\b(fish|school|鱼群|鱼)\b/.test(text)) {
    return { kind: 'school', locomotion: 'water', groupCount: 2, coreRatio: 0.82, outlierMinDistance: 4, altitudeRange: [0, 0], coreState: 'swim', outlierState: 'swim' };
  }
  if (/\b(herd|deer|sheep|cattle|cow|鹿|羊|牛)\b/.test(text)) {
    return { kind: 'herd', locomotion: 'ground', groupCount: 2, coreRatio: 0.85, outlierMinDistance: 6, altitudeRange: [0, 0], coreState: 'graze', outlierState: 'walk' };
  }
  if (/\b(animal|creature|wildlife|动物|生物)\b/.test(text)) return defaultBehaviorProfile('solitary', 'ground');
  return undefined;
}

function defaultBehaviorProfile(kind: MapBehaviorKind, locomotion: MapLocomotion): SceneBehaviorProfile {
  return {
    kind,
    locomotion,
    groupCount: kind === 'pair' ? 2 : 1,
    coreRatio: kind === 'solitary' || kind === 'territorial' ? 1 : 0.8,
    outlierMinDistance: 5,
    altitudeRange: locomotion === 'air' || locomotion === 'mixed' ? [3, 8] : [0, 0],
    coreState: locomotion === 'air' ? 'fly' : locomotion === 'water' ? 'swim' : 'idle',
    outlierState: locomotion === 'air' || locomotion === 'mixed' ? 'fly' : locomotion === 'water' ? 'swim' : 'walk'
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
  const modifier = TERRAIN_MODIFIERS.includes(terrainInput.modifier as TerrainModifier)
    ? terrainInput.modifier as TerrainModifier
    : undefined;
  const layout = TERRAIN_CLIFF_LAYOUTS.includes(terrainInput.layout as TerrainCliffLayout)
    ? terrainInput.layout as TerrainCliffLayout
    : undefined;
  const surface = TERRAIN_SURFACES.includes(terrainInput.surface as TerrainSurfaceKind)
    ? terrainInput.surface as TerrainSurfaceKind
    : undefined;
  const layers = Array.isArray(input.layers)
    ? input.layers.slice(0, SCENE_COMPOSITION_LIMITS.assetFamilyCount).map((layer) => normalizeLayer(layer, familyIds, map))
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
    symmetry: input.symmetry === 'asymmetric'
      ? 'asymmetric'
      : input.symmetry === 'symmetric' || map.sceneMode === 'indoor' ? 'symmetric' : 'asymmetric',
    symmetryAxis: input.symmetryAxis === 'z' ? 'z' : 'x',
    region: {
      kind: 'circle',
      center: [clamp(center[0], -1, 1), clamp(center[1], -1, 1)],
      radius: clamp(finiteNumber(regionInput.radius, 0.25), 0.05, 1.2)
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
      flatness: clamp(finiteNumber(terrainInput.flatness, 0), 0, 1),
      modifier,
      layout,
      access: modifier && TERRAIN_ACCESS_MODES.includes(terrainInput.access as TerrainAccessMode)
        ? terrainInput.access as TerrainAccessMode
        : modifier ? 'walkable' : undefined,
      surface,
      amplitude: modifier
        ? clamp(finiteNumber(terrainInput.amplitude, map.box.size[1] * 0.3), 0.05, map.box.size[1] - 0.05)
        : undefined,
      softness: modifier ? clamp(finiteNumber(terrainInput.softness, 0.2), 0, 1) : undefined,
      direction: modifier ? finiteNumber(terrainInput.direction, map.seed % 360) : undefined,
      variation: modifier ? clamp(finiteNumber(terrainInput.variation, 0.45), 0, 1) : undefined,
      layers: modifier ? Math.round(clamp(finiteNumber(terrainInput.layers, 4), 2, 12)) : undefined
    },
    water,
    layers,
    grassLayers,
    excludeZoneIds: normalizeIds(input.excludeZoneIds, 8)
  };
}

function normalizeGrassFamily(value: unknown): SceneGrassFamily {
  const input = requireRecord(value, 'invalid_scene_grass_family');
  const id = requireId(input.id, 'invalid_scene_grass_family');
  const label = cleanText(input.label, String(input.id ?? ''), 64);
  const mixInput = input.mix === undefined ? {} : requireRecord(input.mix, 'invalid_scene_grass_family');
  const short = Math.max(0, finiteNumber(mixInput.short, 0.7));
  const tall = Math.max(0, finiteNumber(mixInput.tall, 0.2));
  const flowers = Math.max(0, finiteNumber(mixInput.flowers, 0.1));
  const total = short + tall + flowers || 1;
  return {
    id,
    label,
    preset: input.preset === undefined ? inferGrassPreset(`${id} ${label}`) : normalizeGrassPreset(input.preset),
    height: clamp(finiteNumber(input.height, 1), 0.2, 2.5),
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
          preset: inferGrassPreset(sourceId),
          height: 1,
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

function normalizeLayer(value: unknown, familyIds: Set<string>, map: EditableMap): SceneZoneLayer {
  const input = requireRecord(value, 'invalid_scene_layer');
  const familyId = requireId(input.familyId, 'invalid_scene_layer');
  if (!familyIds.has(familyId)) throw new Error('unknown_scene_family');
  const distribution = SCENE_DISTRIBUTIONS.includes(input.distribution as SceneDistribution)
    ? input.distribution as SceneDistribution
    : 'even';
  const scaleRange = requirePair(input.scaleRange ?? [0.9, 1.1], 'invalid_scene_layer');
  const placement = normalizePlacement(input.placement, familyIds, map);
  return {
    familyId,
    density: clamp(finiteNumber(input.density, 0.04), 0.0001, 1),
    scaleRange: [
      clamp(Math.min(scaleRange[0], scaleRange[1]), 0.1, 8),
      clamp(Math.max(scaleRange[0], scaleRange[1]), 0.1, 8)
    ],
    distribution,
    edgeFalloff: clamp(finiteNumber(input.edgeFalloff, 0.25), 0, 1),
    ...(placement ? { placement } : {})
  };
}

function normalizePlacement(
  value: unknown,
  familyIds: Set<string>,
  map: EditableMap
): SceneZoneLayer['placement'] | undefined {
  if (value === undefined || value === null) return undefined;
  const input = requireRecord(value, 'invalid_scene_placement');
  let mode = SCENE_PLACEMENT_MODES.includes(input.mode as ScenePlacementMode)
    ? input.mode as ScenePlacementMode
    : null;
  if (!mode) throw new Error('invalid_scene_placement');
  const pattern = SCENE_LAYOUT_PATTERNS.includes(input.pattern as SceneLayoutPattern)
    ? input.pattern as SceneLayoutPattern
    : undefined;
  const intent = SCENE_PLACEMENT_INTENTS.includes(input.intent as ScenePlacementIntent)
    ? input.intent as ScenePlacementIntent
    : undefined;
  const facing = input.facing === 'guide' || input.facing === 'inward' || input.facing === 'outward'
    ? input.facing
    : 'random';
  const targetFamilyId = cleanId(input.targetFamilyId);
  const focusFamilyId = cleanId(input.focusFamilyId);
  if (mode === 'attached' && (!targetFamilyId || !familyIds.has(targetFamilyId))) mode = 'layout';
  const validTargetFamilyId = targetFamilyId && familyIds.has(targetFamilyId) ? targetFamilyId : undefined;
  const validFocusFamilyId = focusFamilyId && familyIds.has(focusFamilyId) ? focusFamilyId : undefined;
  const normalizedGuidePoints = Array.isArray(input.guidePoints)
    ? input.guidePoints.slice(0, 16).flatMap((point): Array<[number, number]> => {
      if (!Array.isArray(point) || point.length < 2) return [];
      const x = Number(point[0]);
      const z = Number(point[1]);
      return Number.isFinite(x) && Number.isFinite(z)
        ? [[clamp(x, -1, 1), clamp(z, -1, 1)]]
        : [];
    })
    : undefined;
  const guidePoints = normalizedGuidePoints && normalizedGuidePoints.length >= 2
    ? normalizedGuidePoints
    : undefined;
  const spacingByFamily: Record<string, number> = {};
  if (input.spacingByFamily && typeof input.spacingByFamily === 'object' && !Array.isArray(input.spacingByFamily)) {
    for (const [familyId, spacing] of Object.entries(input.spacingByFamily as Record<string, unknown>)) {
      if (familyIds.has(familyId)) spacingByFamily[familyId] = clamp(finiteNumber(spacing, 1), 0.1, 64);
    }
  }
  const habitatInput = input.habitat && typeof input.habitat === 'object' && !Array.isArray(input.habitat)
    ? input.habitat as Record<string, unknown>
    : null;
  const habitat = habitatInput ? {
    ...(habitatInput.height === undefined ? {} : {
      height: normalizeBand(habitatInput.height, TERRAIN_MIN_HEIGHT, map.box.size[1] - 0.05)
    }),
    ...(habitatInput.slope === undefined ? {} : { slope: normalizeBand(habitatInput.slope, 0, 89) }),
    ...(habitatInput.waterDistance === undefined ? {} : {
      waterDistance: normalizeBand(
        habitatInput.waterDistance,
        0,
        Math.hypot(map.box.size[0], map.box.size[2])
      )
    })
  } : undefined;
  return {
    mode,
    ...(pattern ? { pattern } : {}),
    ...(intent ? { intent } : {}),
    direction: ((finiteNumber(input.direction, 0) % 360) + 360) % 360,
    ...(input.spacing === undefined ? {} : { spacing: clamp(finiteNumber(input.spacing, 2), 0.1, 64) }),
    offset: clamp(finiteNumber(input.offset, 0), -64, 64),
    facing,
    ...(validTargetFamilyId ? { targetFamilyId: validTargetFamilyId } : {}),
    ...(validFocusFamilyId ? { focusFamilyId: validFocusFamilyId } : {}),
    ...(guidePoints ? { guidePoints } : {}),
    ...(input.maxPerGroup === undefined ? {} : { maxPerGroup: Math.round(clamp(finiteNumber(input.maxPerGroup, 4), 1, 24)) }),
    ...(input.arcDegrees === undefined ? {} : { arcDegrees: clamp(finiteNumber(input.arcDegrees, 110), 20, 320) }),
    ...(input.aisleEvery === undefined ? {} : { aisleEvery: Math.round(clamp(finiteNumber(input.aisleEvery, 4), 2, 12)) }),
    ...(Object.keys(spacingByFamily).length > 0 ? { spacingByFamily } : {}),
    ...(habitat && Object.keys(habitat).length > 0 ? { habitat } : {})
  };
}

function normalizeBand(value: unknown, minimum: number, maximum: number): [number, number, number, number] {
  if (!Array.isArray(value) || value.length < 4) throw new Error('invalid_scene_habitat_band');
  const values = value.slice(0, 4).map((item) => clamp(finiteNumber(item, minimum), minimum, maximum));
  values.sort((left, right) => left - right);
  return values as [number, number, number, number];
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
