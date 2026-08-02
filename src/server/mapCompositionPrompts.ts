import { getMapBounds, type EditableMap, type MapAsset } from '../shared/map';
import { planLimits } from '../shared/mapPlanning';
import type {
  SceneCompositionMetrics,
  SceneCompositionPlan,
  SceneConsultationRequest
} from '../shared/sceneComposition';
import { SCENE_COMPOSITION_LIMITS } from '../shared/sceneComposition';
import type { ResolvedSceneFamily } from '../shared/sceneCompositionAssets';

export function buildSceneDirectorPrompt(map: EditableMap, assets: readonly MapAsset[]): string {
  const bounds = getMapBounds(map);
  const limits = planLimits(bounds);
  const compatibleAssets = assets
    .filter((asset) => asset.mode === map.assetGenerationMode)
    .slice(0, 80)
    .map((asset) => ({
      id: asset.id,
      name: asset.name,
      tags: asset.tags ?? [],
      sizeClass: asset.sizeClass ?? null
    }));
  return [
    'You are the scene director for a 3D world editor.',
    'Transform the user request into one coherent environment composition plan before any terrain or objects are generated.',
    'You decide what this world looks like: regions, hierarchy, focal areas, transitions, terrain intent, asset families, density, scale, and negative space.',
    'Do not output object coordinates, low-level map operations, spawn points, combat rules, cover, quests, or gameplay logic.',
    'Do not use a fixed forest/camp template. Choose regions and asset roles that specifically fit this request.',
    'Extract every explicitly named physical requirement (for example terrain, pond, cabin, landmark) into intentRequirements. These are acceptance criteria, not suggestions.',
    'A water requirement must point to a zone that contains structured water. An asset-family requirement must name its familyId.',
    'For a pond, lake, or pool zone, set water to {"type":"lake","level":0.35,"depth":1.8}; use null when the zone has no water.',
    'Use normalized XZ coordinates in [-1,1]. Region radius is relative to the shorter map half-extent.',
    `Use 1-${SCENE_COMPOSITION_LIMITS.zoneCount} zones. A one-zone composition is valid when the request genuinely calls for it.`,
    'Cover the map deliberately. Any large uncovered area must be intentional negative space described by a zone, not an accidental omission.',
    'Asset family role is free semantic text. Tags should be reusable lower-case search terms.',
    'Grass is editable ground vegetation, not a generated model asset. When appropriate, define reusable grassFamilies and assign grassLayers to zones.',
    'For each grass zone decide short/tall/flower proportions, density, variation, edge falloff, and residualDensity around structures (0 tidy, larger abandoned).',
    'Keep flower accents sparse and readable: usually 0.02-0.08 of a grass mix, unless the user explicitly requests a flower field.',
    'Grass may intentionally continue to pond edges or underwater. Do not remove it merely because a zone contains water; slope fading is deterministic.',
    `Use consultations only when a genuinely difficult local relationship would benefit from an independent specialist. Use 0-${SCENE_COMPOSITION_LIMITS.consultationCount}; do not create one per zone.`,
    'A consultation may improve the plan but cannot directly create assets or map operations.',
    'Rendering is a later stage. Only provide short renderPromptSuggestions; do not choose or edit a render scheme.',
    `Map: ${map.box.size[0]} x ${map.box.size[1]} x ${map.box.size[2]}, seed ${map.seed}, asset mode ${map.assetGenerationMode}.`,
    `Execution budgets: about ${limits.objectCount} objects and at most ${limits.assetRequestCount} newly generated reusable assets.`,
    `Compatible asset catalog: ${JSON.stringify(compatibleAssets)}.`,
    'Return JSON only with this shape:',
    JSON.stringify({
      version: 1,
      summary: 'short composition summary',
      globalBrief: {
        spatialTheme: 'overall spatial idea',
        visualHierarchy: 'primary/secondary visual relationship',
        assetArtDirection: 'shared asset style, proportions and palette',
        focalZoneId: 'zone-id',
        terrainBase: { preset: 'plain|hills|valley|island|canyon', seed: map.seed, amplitude: 4, roughness: 0.5 }
      },
      intentRequirements: [
        { id: 'terrain-foundation', kind: 'terrain', description: 'visible terrain foundation', targetZoneId: 'zone-id', minCount: 1 },
        { id: 'named-water', kind: 'water', description: 'pond requested by the user', targetZoneId: 'water-zone-id', minCount: 1 },
        { id: 'named-focus', kind: 'asset-family', description: 'focal cabin requested by the user', familyId: 'family-id', targetZoneId: 'zone-id', minCount: 1 }
      ],
      zones: [{
        id: 'zone-id', label: 'human label', role: 'primary|secondary|transition|negative-space', importance: 0.8,
        region: { kind: 'circle', center: [0, 0], radius: 0.35 },
        brief: { atmosphere: 'text', hierarchy: 'text', openness: 0.4, transitionIntent: 'text' },
        terrain: { elevation: 0.1, roughness: 0.5, flatness: 0.2 },
        water: null,
        layers: [{ familyId: 'family-id', density: 0.04, scaleRange: [0.8, 1.2], distribution: 'even|clustered|accent', edgeFalloff: 0.25 }],
        grassLayers: [{ grassFamilyId: 'grass-family-id', density: 0.7, variation: 0.2, edgeFalloff: 0.25, residualDensity: 0.08 }],
        excludeZoneIds: ['other-zone-id']
      }],
      transitions: [{ fromZoneId: 'zone-a', toZoneId: 'zone-b', kind: 'soft|buffer|shore', width: 0.15 }],
      assetFamilies: [{
        id: 'family-id', label: 'human label', role: 'free semantic role', tags: ['tag'],
        sizeClass: 'small|medium|large', desiredVariants: 1, priority: 0.8, generationBrief: 'single reusable asset brief'
      }],
      grassFamilies: [{ id: 'grass-family-id', label: 'Meadow mix', mix: { short: 0.7, tall: 0.2, flowers: 0.1 } }],
      consultations: [{
        id: 'consultation-id', discipline: 'free specialist discipline', targetZoneIds: ['zone-id'],
        question: 'specific relationship to improve', priority: 0.8
      }],
      renderPromptSuggestions: ['short later-stage style hint']
    })
  ].join('\n');
}

export function buildSceneSpecialistPrompt(
  plan: SceneCompositionPlan,
  consultation: SceneConsultationRequest
): string {
  const targetZones = plan.zones.filter((zone) => consultation.targetZoneIds.includes(zone.id));
  return [
    `You are an independent ${consultation.discipline} specialist advising a 3D scene director.`,
    `Question: ${consultation.question}`,
    'Review only the requested zones and their relationship to the whole plan.',
    'Improve visual hierarchy, natural transitions, local terrain intent, object and grass density, scale, and use of existing families.',
    'Do not create new asset families, request assets, output map operations, or add gameplay/spawn logic.',
    `Your changes must be small structured patches. Return no more than ${SCENE_COMPOSITION_LIMITS.specialistPatchCount} patches.`,
    `Global brief: ${JSON.stringify(plan.globalBrief)}.`,
    `Target zones: ${JSON.stringify(targetZones)}.`,
    `Available asset families: ${JSON.stringify(plan.assetFamilies)}.`,
    `Available grass families: ${JSON.stringify(plan.grassFamilies)}.`,
    'Return JSON only: {"summary":"...","findings":[{"code":"...","severity":"info|warning|error","message":"..."}],"patches":[...]}.',
    patchSchemaText()
  ].join('\n');
}

export function buildSceneReviewerPrompt(
  plan: SceneCompositionPlan,
  metrics: SceneCompositionMetrics,
  families: readonly ResolvedSceneFamily[]
): string {
  const familyAvailability = families.map((resolved) => ({
    familyId: resolved.family.id,
    assetIds: resolved.assets.map((asset) => asset.id),
    missingCount: resolved.missingCount
  }));
  return [
    'You are the final composition reviewer for a generated 3D environment.',
    'Review visual and technical composition only: continuity, focal hierarchy, empty or repetitive areas, scale balance, and terrain/water transitions.',
    'Do not add gameplay, spawn, combat, cover, quests, or navigation requirements.',
    'Do not request or invent new assets. You may only redistribute existing families and adjust bounded plan fields.',
    'The plan intentRequirements are mandatory acceptance criteria. Never remove or invalidate a required water or asset family.',
    'The renderer will be handled in a separate stage.',
    `Return pass when no meaningful correction is needed. Otherwise return no more than ${SCENE_COMPOSITION_LIMITS.reviewPatchCount} differential patches.`,
    `Plan: ${JSON.stringify(plan)}.`,
    `Deterministic execution metrics: ${JSON.stringify(metrics)}.`,
    `Resolved families: ${JSON.stringify(familyAvailability)}.`,
    'Return JSON only: {"status":"pass|revise","summary":"...","findings":[{"code":"...","severity":"info|warning|error","message":"..."}],"patches":[...]}.',
    patchSchemaText()
  ].join('\n');
}

export function buildStructuredRepairPrompt(kind: string, invalidOutput: string, error: unknown): string {
  return [
    `Repair the invalid ${kind} JSON below.`,
    `Validation error: ${error instanceof Error ? error.message : String(error)}`,
    'Preserve the intended scene. Change only what is necessary to satisfy the schema and references.',
    'Return corrected JSON only. Do not use markdown fences.',
    invalidOutput.slice(0, 12_000)
  ].join('\n');
}

function patchSchemaText(): string {
  return [
    'Allowed patches:',
    '- zone.update: {type,zoneId,center?,radius?,importance?,brief?,terrain?}',
    '- layer.update: {type,zoneId,familyId,density?,scaleRange?,distribution?,edgeFalloff?}',
    '- layer.add: {type,zoneId,layer:{familyId,density,scaleRange,distribution,edgeFalloff}}',
    '- layer.remove: {type,zoneId,familyId}',
    '- grass.update: {type,zoneId,grassFamilyId,density?,variation?,edgeFalloff?,residualDensity?}',
    '- grass.add: {type,zoneId,layer:{grassFamilyId,density,variation,edgeFalloff,residualDensity}}',
    '- grass.remove: {type,zoneId,grassFamilyId}',
    '- water.update: {type,zoneId,level?,depth?}',
    '- water.remove: {type,zoneId}'
  ].join('\n');
}
