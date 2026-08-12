import { getMapBounds, getMapPlayerMetrics, type EditableMap, type MapAsset } from '../shared/map';
import { indoorAssetTargetCount } from '../shared/indoorScenePlanning';
import { planLimits } from '../shared/mapPlanning';
import type {
  SceneCompositionMetrics,
  SceneCompositionPlan,
  SceneConsultationRequest
} from '../shared/sceneComposition';
import { SCENE_COMPOSITION_LIMITS } from '../shared/sceneComposition';
import type { ResolvedSceneFamily } from '../shared/sceneCompositionAssets';
import { terrainCapabilitySummary } from '../shared/terrainGeneration';

export function buildSceneDirectorPrompt(
  map: EditableMap,
  assets: readonly MapAsset[],
  options: { reuseExistingAssets?: boolean; minNewAssets?: number; maxNewAssets?: number } = {}
): string {
  const indoor = map.sceneMode === 'indoor';
  const bounds = getMapBounds(map);
  const limits = planLimits(bounds, map.sceneMode);
  const player = getMapPlayerMetrics(map);
  const indoorAssetTarget = indoor
    ? indoorAssetTargetCount(map, options.minNewAssets ?? 0, options.maxNewAssets ?? limits.assetRequestCount)
    : 0;
  const catalogAssets = assets
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
    indoor
      ? 'This map is one existing indoor room. Treat zones as functional floor areas inside that room; the room shell, floor, ceiling, and walls already exist and must not become asset families.'
      : `Terrain capabilities are composable and independent: ${JSON.stringify(terrainCapabilitySummary())}. Choose a global terrainBase and terrainRefinement, then add a zone terrain.modifier and terrain.surface when the request calls for ridges, valleys, basins, cliffs, terraces, dunes, islands, sand, grass, or rock. For example, a mountain can use a cliff modifier even when the base is hills; never assume a modifier belongs only to one preset.`,
    indoor
      ? 'Indoor plans must use a plain zero-relief terrainBase placeholder, null water, empty grassFamilies and grassLayers, and no terrain or water intentRequirements. The compiler will preserve the room floor instead of generating terrain.'
      : 'Use terrainRefinement to remove synthetic cuts after all sculpting. Keep erosion around 0.12-0.35 and drainage around 0.04-0.16 unless the request explicitly needs heavily eroded terrain. Cliff softness below 0.16 is automatically given a natural shoulder; prefer 0.25-0.6 for broad formations.',
    indoor
      ? 'Doors and windows are standalone model assets placed at planned wall positions. The deterministic compiler reserves a matching parameterized wall opening behind each model, so the opening is visible and glass materials remain part of the asset. Wall-mounted props use placement.intent wall. Preserve walkable circulation and explicit aisles as negative space.'
      : '',
    indoor
      ? 'Repeated indoor furniture must be modular: generate one reusable pew, chair, desk, or row module and repeat it with placement operations. Never bundle the whole room layout or several separated rows into one generated asset.'
      : '',
    indoor
      ? `Plan the room in two passes inside this one response. First expand a breadth-first functional inventory: entrance/daylight fixtures, primary activity groups, supporting storage or service furniture, then readable decor. Aim for about ${indoorAssetTarget} useful asset families within the user's bounds; do not merely stop at the lower bound.`
      : '',
    indoor
      ? 'Then create a relationship graph between those families: support, paired, facing, aligned, close-to-wall, and circulation-clear. A typical room needs a standalone door model and normally at least one standalone glass window model unless the user explicitly requests a sealed or windowless room.'
      : '',
    indoor
      ? 'Classrooms use straight aligned desk rows facing a wall-mounted blackboard; pair one chair behind each desk. Restaurants and cafes infer multiple dining-table groups from usable floor area and attach chairs around every table. Offices infer multiple workstations and pair a chair with each desk. Do not use arcs for these functional groups unless the user explicitly requests curved seating.'
      : '',
    indoor
      ? 'For homes and small apartments, build named activity zones first, then layer functional furniture, reachable everyday objects, and personal decor. Use vertical storage plus a mix of open display and closed storage; rugs, lamps, plants, books, trays, tableware, art and countertop appliances should make the room feel lived in without blocking circulation. Kitchens keep refrigerator, sink and cooktop as three distinct work centers with clear paths between them.'
      : '',
    indoor
      ? 'Use placement.intent supported for an object that sits on another asset. It must name targetFamilyId and maxPerGroup 1. Internet cafes require one complete computer station per gaming desk; televisions sit on media consoles; countertop and coffee-table props sit on their named supporting surface. Never scatter these supported objects on the floor.'
      : '',
    indoor
      ? 'Treat the zone graph as a top-down interior plan even when the user skips plan confirmation: allocate entrance clearance, circulation spine, primary work or activity bays, wall storage or service bands, and daylight/safety fixtures before choosing densities. Warehouse shelves form aligned rows with service aisles; crates and pallets occupy staging bays rather than the circulation spine; pallet jacks stay near staging or loading; lights use a ceiling grid; signs and extinguishers attach to walls.'
      : '',
    indoor
      ? 'Set every zone symmetry to symmetric by default and choose symmetryAxis x or z. Axis x means the mirror plane X = zone center X; axis z means Z = zone center Z. Use asymmetric only when the room function or user request clearly calls for an irregular arrangement, such as many toilets or utility rooms. Symmetry affects repeated desks, chairs, windows, lights, shelves, and decor; it never duplicates a family that is intentionally singular, such as one entrance door, one blackboard, or one teacher podium.'
      : '',
    'Do not output object coordinates, low-level map operations, spawn points, combat rules, cover, quests, or gameplay logic.',
    'Do not use a fixed forest/camp template. Choose regions and asset roles that specifically fit this request.',
    'Extract every explicitly named physical requirement (for example terrain, pond, cabin, castle, a named tree species, or an animal) into intentRequirements. These are acceptance criteria, not suggestions.',
    'Every explicitly requested reusable object type must also have its own assetFamily and appear in at least one zone layer. Never let a generic tree family replace a named maple family, or a generic building replace a castle.',
    'A pond, lake, or pool water requirement must point to a zone that contains structured water. An asset-family requirement must name its familyId.',
    'For a pond, lake, or pool zone, set water to {"type":"lake","level":0.35,"depth":1.8}; use null when the zone has no water.',
    'Island and archipelago terrain automatically include an ocean at sea level. Represent a requested sea or ocean as a terrain requirement with island/archipelago terrain; do not add a water requirement or structured water zone for that surrounding ocean.',
    'Use normalized XZ coordinates in [-1,1]. Region radius is relative to the shorter map half-extent.',
    `Use 1-${SCENE_COMPOSITION_LIMITS.zoneCount} zones. A one-zone composition is valid when the request genuinely calls for it.`,
    'The union of all zones must cover at least 80% of the normalized map square. Any remaining large open area must be intentional negative space described by a zone, not an accidental omission.',
    'Asset family role is free semantic text. Tags should be reusable lower-case search terms.',
    'For each asset family provide 1-3 identityTags containing the specific identity required for reuse (for example maple, castle, deer, sakura). Do not put broad category tags such as tree, vegetation, building, structure, animal, forest, or landmark in identityTags.',
    'Choose a placement.mode for each object layer: anchor for landmarks, field for even natural cover, patch for mixed ecological communities, linear for fences/lights/roadside objects, layout for buildings/camps/courtyards, and attached for props dependent on another family.',
    'Buildings and structures must use anchor, linear, or layout; never field or patch. Use layout.pattern row|courtyard|radial|grid to establish order. Attached placement must name targetFamilyId. Related plant patch layers should share the zone habitat and use spacingByFamily when their ecological separation differs.',
    'Furniture is not architecture and must declare placement.intent. Use street-edge for benches/lights/bins along a path, audience for church/theater rows without desks, functional-group for repeated classroom desks, restaurant tables, or office workstations, paired for one chair behind each desk, social for chairs around tables or fire pits, viewpoint for small bench arcs facing scenery, wall for indoor wall furniture, attached-service for props beside another family, and supported for an object resting on a target surface.',
    'Never use field or patch for furniture. Never use a complete courtyard or radial furniture ring unless the user explicitly requests circular seating, an amphitheater, or a ceremony. Viewpoint seating uses pattern arc, maxPerGroup 2-5, and arcDegrees 45-140.',
    'Street-edge furniture should provide 2-16 normalized guidePoints following the shared path, use small groups separated by gaps, and face the guide or named focus. Audience seating uses grid plus focusFamilyId and aisleEvery. Functional-group uses an aligned row or grid. Paired, social, attached-service, and supported require targetFamilyId.',
    'Playground swings, slides, and fitness equipment are facilities: use sparse anchors, normally one or two instances, with enough spacing for a clear activity area.',
    'On mountains, give vegetation an explicit habitat.slope band. Keep large trees off cliff shoulders and narrow ridge crests; let shrubs and rocks tolerate progressively steeper ground.',
    'When the user explicitly requests a high mountain, snow mountain, mountain peak, or bare ridge, create a broad mountain zone with strong relief, rock surface, and scenic access. A low rounded hill is not an acceptable substitute. Put bare-rock and outcrop families inside that mountain zone with explicit high-elevation and steep-slope habitat bands.',
    'Repeated decorative rocks are terrain cover, not boundary markers. Unless the request is specifically for a compact rock field, distribute each natural rock family through compatible broad zones with only moderate clustering so it does not collapse into one side of the map.',
    `Use the ${player.height.toFixed(2)}m character as the scale reference. World scale profile is ${map.worldScaleProfile}. Ordinary visible assets should not have a major dimension below ${(player.height / 6).toFixed(2)}m; only explicitly requested tiny props may use ${(player.height / 24).toFixed(2)}-${(player.height / 6).toFixed(2)}m. Trees must read clearly taller than the character.`,
    'For repeated furniture, density describes how much of the usable area should be occupied. Do not encode one compact fixed-count block for a large room; preserve aisles and distribute rows across the available floor area.',
    indoor
      ? 'Before returning, estimate occupied floor area and spatial spread. If a large room would leave most of its floor unintentionally blank, add another functional group or supporting/decor families and explain any remaining open zone by its actual use. Empty space is valid only when it is a circulation route, activity area, sightline, or other named function.'
      : '',
    'For every animal family, provide behavior. kind is static|solitary|pair|flock|herd|school|territorial; locomotion is static|ground|air|water|mixed. Use groupCount, coreRatio, and outlierMinDistance to create several readable cores plus reserved separated individuals. For mixed birds, coreState is usually feed or rest and outlierState is fly; set an altitudeRange for airborne members.',
    'Treat ecology at three scales: zone habitat, family patches or social cores, then individually spaced instances. Do not represent a flock, herd, or mixed plant community as one undifferentiated cluster.',
    'Every mountain or ridge must choose terrain.access walkable|scenic. Walkable mountains are broad massifs; scenic mountains may be steeper but still require a wide region. A ridge is only valid inside a large region. Use layout terraces when traversal should happen by jumping between geometric platforms.',
    'Grass is editable ground vegetation, not a generated model asset. When appropriate, define reusable grassFamilies and assign grassLayers to zones.',
    'Every grassLayers[].grassFamilyId must exactly match one grassFamilies[].id. Reuse the same declared grass family ID across zones.',
    'Choose every grass family from these visibly distinct presets: meadow ordinary blades, sand sparse rigid spikes, wetland tall reeds, farm cereal-like crop grass, magic forked luminous-looking grass, alpine-moss low cushion moss.',
    'For every grass family set preset to meadow|sand|wetland|farm|magic|alpine-moss and height to 0.2-2.5. Different families mixed in one zone should normally use different heights and densities.',
    'For each grass zone decide short/tall/flower proportions, density, variation, edge falloff, and residualDensity around structures (0 tidy, larger abandoned).',
    'Keep flower accents sparse and readable: usually 0.02-0.08 of a grass mix, unless the user explicitly requests a flower field.',
    'Grass may intentionally continue to pond edges or underwater. Do not remove it merely because a zone contains water; slope fading is deterministic.',
    `Use consultations only when a genuinely difficult local relationship would benefit from an independent specialist. Use 0-${SCENE_COMPOSITION_LIMITS.consultationCount}; do not create one per zone.`,
    'A consultation may improve the plan but cannot directly create assets or map operations.',
    'Rendering is a later stage. Only provide short renderPromptSuggestions; do not choose or edit a render scheme.',
    `Map: ${map.box.size[0]} x ${map.box.size[1]} x ${map.box.size[2]}, scene mode ${map.sceneMode}, seed ${map.seed}, default new-asset mode ${map.assetGenerationMode}, character height ${player.height.toFixed(2)}m, world scale ${map.worldScaleProfile}.`,
    `Execution budgets: about ${limits.objectCount} objects and ${options.minNewAssets ?? 0}-${options.maxNewAssets ?? limits.assetRequestCount} newly generated assets. Define enough useful families or variants to satisfy the minimum; never exceed the maximum.`,
    'Use several semantically useful asset families. Do not create near-duplicate recolors or unnecessary variants of one landmark.',
    options.reuseExistingAssets
      ? `Existing assets may be reused only when their specific identity and size fit: ${JSON.stringify(catalogAssets)}.`
      : 'Existing asset reuse is disabled for this request. Define the asset families the scene actually needs; the server will generate them as new assets.',
    'Return JSON only with this shape:',
    JSON.stringify({
      version: 1,
      summary: 'short composition summary',
      globalBrief: {
        spatialTheme: 'overall spatial idea',
        visualHierarchy: 'primary/secondary visual relationship',
        assetArtDirection: 'shared asset style, proportions and palette',
        focalZoneId: 'zone-id',
        terrainBase: { preset: 'plain|hills|valley|island|archipelago|canyon|cliff-plateau|dune-desert', seed: map.seed, amplitude: 4, roughness: 0.5, direction: 90 },
        terrainRefinement: { erosion: 0.22, drainage: 0.08, iterations: 3, talus: 46 }
      },
      intentRequirements: [
        { id: 'terrain-foundation', kind: 'terrain', description: 'visible terrain foundation', targetZoneId: 'zone-id', minCount: 1 },
        { id: 'named-water', kind: 'water', description: 'pond requested by the user', targetZoneId: 'water-zone-id', minCount: 1 },
        { id: 'named-focus', kind: 'asset-family', description: 'focal cabin requested by the user', familyId: 'family-id', targetZoneId: 'zone-id', minCount: 1 }
      ],
      zones: [{
        id: 'zone-id', label: 'human label', role: 'primary|secondary|transition|negative-space', importance: 0.8, symmetry: 'symmetric|asymmetric', symmetryAxis: 'x|z',
        region: { kind: 'circle', center: [0, 0], radius: 0.35 },
        brief: { atmosphere: 'text', hierarchy: 'text', openness: 0.4, transitionIntent: 'text' },
        terrain: {
          elevation: 0.1, roughness: 0.5, flatness: 0.2,
          modifier: 'mountain|ridge|valley|basin|cliff|terrace|dune|island|null', layout: 'plateau|coast|canyon|wall|terraces|null', access: 'walkable|scenic',
          surface: 'grass|sand|rock|null', amplitude: 4, softness: 0.2, direction: 90, variation: 0.45, layers: 4
        },
        water: null,
        layers: [{
          familyId: 'family-id', density: 0.04, scaleRange: [0.8, 1.2], distribution: 'even|clustered|accent', edgeFalloff: 0.25,
          placement: {
            mode: 'anchor|field|patch|linear|layout|attached', pattern: 'row|courtyard|radial|grid|arc',
            intent: 'landmark|settlement|street-edge|audience|functional-group|paired|social|viewpoint|wall|attached-service|supported|playground',
            direction: 0, spacing: 3, offset: 0, facing: 'random|guide|inward|outward',
            targetFamilyId: null, focusFamilyId: null, guidePoints: [[-0.8, 0], [0, 0.1], [0.8, 0.2]],
            maxPerGroup: 4, arcDegrees: 110, aisleEvery: 4, spacingByFamily: { 'other-family-id': 2.5 },
            habitat: { height: [-2, 0, 6, 10], slope: [0, 0, 20, 35], waterDistance: [0, 1, 5, 9] }
          }
        }],
        grassLayers: [{ grassFamilyId: 'grass-family-id', density: 0.7, variation: 0.2, edgeFalloff: 0.25, residualDensity: 0.08 }],
        excludeZoneIds: ['other-zone-id']
      }],
      transitions: [{ fromZoneId: 'zone-a', toZoneId: 'zone-b', kind: 'soft|buffer|shore', width: 0.15 }],
      assetFamilies: [{
        id: 'family-id', label: 'human label', role: 'free semantic role', tags: ['broad-tag', 'specific-tag'], identityTags: ['specific-tag'],
        sizeClass: 'small|medium|large', desiredVariants: 1, priority: 0.8, generationBrief: 'single reusable asset brief',
        behavior: {
          kind: 'static|solitary|pair|flock|herd|school|territorial', locomotion: 'static|ground|air|water|mixed',
          groupCount: 2, coreRatio: 0.72, outlierMinDistance: 7, altitudeRange: [3, 8], coreState: 'feed', outlierState: 'fly'
        }
      }],
      grassFamilies: [{ id: 'grass-family-id', label: 'Meadow mix', preset: 'meadow|sand|wetland|farm|magic|alpine-moss', height: 1, mix: { short: 0.7, tall: 0.2, flowers: 0.1 } }],
      consultations: [{
        id: 'consultation-id', discipline: 'free specialist discipline', targetZoneIds: ['zone-id'],
        question: 'specific relationship to improve', priority: 0.8
      }],
      renderPromptSuggestions: ['short later-stage style hint']
    })
  ].filter(Boolean).join('\n');
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
    'For indoor scenes, deterministic metrics include indoorFloorOccupancy and indoorObjectSpread. When either is very low and no named circulation/activity/negative-space zone justifies it, revise existing group densities or zone radii so furniture uses the room instead of remaining in one compact island. Preserve deliberate aisles and door clearance.',
    'Check family relationships as a graph: every paired chair needs its desk target, restaurant chairs need dining-table targets, classroom groups face the teaching wall, and wall props remain wall-aligned. Correct relationship fields before merely increasing random density.',
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
    kind === 'scene composition plan'
      ? 'Every zones[] entry must be a JSON object with id, label, role (primary|secondary|transition|negative-space), region {center:[x,z],radius}, brief, terrain, layers, and excludeZoneIds.'
      : '',
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
