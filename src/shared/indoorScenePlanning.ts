import type { EditableMap } from './map';
import type {
  SceneAssetFamily,
  SceneCompositionPlan,
  ScenePlacementIntent,
  SceneZoneLayer
} from './sceneComposition';
import { sceneAssetCategory } from './sceneComposition';
import type { MapAssetLight } from './mapAssetMetadata';

interface IndoorAssetDemand {
  key: string;
  label: string;
  role: string;
  tags: string[];
  matches: RegExp;
  sizeClass: SceneAssetFamily['sizeClass'];
  priority: number;
  generationBrief: string;
  placement: 'anchor' | 'wall' | 'group' | 'paired' | 'social' | 'supported';
  targetKey?: string;
  wallDirection?: number;
  maxPerGroup?: number;
}

/**
 * Expands a sparse model-authored indoor inventory breadth-first: essential
 * room fixtures, primary activity furniture, supporting furniture, then decor.
 * The model still owns the room concept; this only supplies commonly omitted
 * functional relationships until a room-size-derived target is reached.
 */
export function completeIndoorScenePlan(
  plan: SceneCompositionPlan,
  map: EditableMap,
  prompt: string,
  minimumAssets: number,
  maximumAssets: number
): SceneCompositionPlan {
  if (map.sceneMode !== 'indoor' || !map.room || maximumAssets <= 0) return plan;

  const semantic = `${prompt} ${plan.summary} ${plan.globalBrief.spatialTheme}`;
  const residential = /living room|family room|kitchen|apartment|small home|residential|客厅|起居室|厨房|公寓|住宅|小户型/i.test(semantic);
  const target = residential
    ? Math.max(0, Math.round(maximumAssets))
    : indoorAssetTargetCount(map, minimumAssets, maximumAssets);
  const demands = indoorDemandTree(semantic);
  const families = plan.assetFamilies.map((family) => ({ ...family, desiredVariants: 1 }));
  const zones = plan.zones.map((zone) => ({ ...zone, layers: [...zone.layers] }));
  const targetZone = zones.find((zone) => zone.id === plan.globalBrief.focalZoneId)
    ?? zones.find((zone) => zone.role !== 'negative-space')
    ?? zones[0];
  if (!targetZone) return plan;

  const familyByDemand = new Map<string, string>();
  for (const demand of demands) {
    const match = families.find((family) => demand.matches.test(familySemantic(family)));
    if (match) familyByDemand.set(demand.key, match.id);
  }

  for (const demand of demands) {
    if (families.length >= target || families.length >= maximumAssets) break;
    if (familyByDemand.has(demand.key)) continue;
    const id = uniqueFamilyId(demand.key, families);
    const family: SceneAssetFamily = {
      id,
      label: demand.label,
      role: demand.role,
      tags: demand.tags,
      identityTags: [demand.tags[0]],
      sizeClass: demand.sizeClass,
      desiredVariants: 1,
      priority: demand.priority,
      generationBrief: demand.generationBrief,
      ...indoorDemandLight(demand.tags)
    };
    families.push(family);
    familyByDemand.set(demand.key, id);
  }

  const familyIds = new Set(families.map((family) => family.id));
  for (const demand of demands) {
    const familyId = familyByDemand.get(demand.key);
    if (!familyId || !familyIds.has(familyId) || zones.some((zone) => zone.layers.some((layer) => layer.familyId === familyId))) {
      continue;
    }
    targetZone.layers.push(demandLayer(demand, familyId, familyByDemand, map));
  }

  for (const family of families) {
    if (zones.some((zone) => zone.layers.some((layer) => layer.familyId === family.id))) continue;
    const zone = indoorFamilyZone(plan, zones, family) ?? targetZone;
    zone.layers.push(fallbackFamilyLayer(family));
  }

  return { ...plan, assetFamilies: families, zones };
}

function indoorDemandLight(tags: readonly string[]): { light: MapAssetLight } | Record<string, never> {
  const tagSet = new Set(tags);
  if (![...tagSet].some((tag) => tag === 'lighting' || tag.includes('light') || tag.includes('lamp'))) return {};
  return {
    light: {
      kind: 'point', color: '#ffd8a0', intensity: 3, range: 7,
      offset: tagSet.has('ceiling-mounted') ? [0, -0.2, 0] : [0, 0.8, 0]
    }
  };
}

export function indoorAssetTargetCount(
  map: EditableMap,
  minimumAssets: number,
  maximumAssets: number
): number {
  const maximum = Math.max(0, Math.round(maximumAssets));
  const minimum = Math.min(maximum, Math.max(0, Math.round(minimumAssets)));
  if (map.sceneMode !== 'indoor' || !map.room || maximum <= minimum) return minimum;
  const floorArea = map.room.size[0] * map.room.size[2];
  const usefulVariety = Math.round(4 + Math.sqrt(Math.max(1, floorArea)) * 0.55);
  return Math.min(maximum, Math.max(minimum, usefulVariety));
}

function demandLayer(
  demand: IndoorAssetDemand,
  familyId: string,
  familyByDemand: ReadonlyMap<string, string>,
  map: EditableMap
): SceneZoneLayer {
  const seedDirection = demand.wallDirection ?? familyDirection(map.seed, familyId);
  const targetFamilyId = demand.targetKey ? familyByDemand.get(demand.targetKey) : undefined;
  const intent: ScenePlacementIntent = demand.placement === 'group'
    ? 'functional-group'
    : demand.placement === 'paired'
      ? 'paired'
      : demand.placement === 'social'
        ? 'social'
        : demand.placement === 'supported'
          ? 'supported'
        : demand.placement === 'wall'
          ? 'wall'
          : 'landmark';
  const mode = demand.placement === 'wall'
    ? 'linear' as const
    : demand.placement === 'paired' || demand.placement === 'social' || demand.placement === 'supported'
      ? 'attached' as const
      : demand.placement === 'group'
        ? 'layout' as const
        : 'anchor' as const;
  return {
    familyId,
    density: demand.placement === 'group' ? 0.055 : demand.placement === 'wall' ? 0.018 : 0.012,
    scaleRange: [1, 1.15],
    distribution: demand.placement === 'anchor' ? 'accent' : demand.placement === 'paired' || demand.placement === 'social' || demand.placement === 'supported' ? 'clustered' : 'even',
    edgeFalloff: 0.12,
    placement: {
      mode,
      ...(demand.placement === 'wall' ? { pattern: 'row' as const } : {}),
      ...(demand.placement === 'group' ? { pattern: 'grid' as const } : {}),
      intent,
      direction: seedDirection,
      spacing: demand.placement === 'group' ? 2.1 : demand.placement === 'wall' ? 2.4 : 1.1,
      offset: demand.placement === 'wall' ? 0.15 : 0,
      facing: demand.placement === 'group' ? 'inward' : demand.placement === 'wall' ? 'inward' : 'guide',
      ...(targetFamilyId ? { targetFamilyId } : {}),
      ...(demand.key === 'student-desk' ? { focusFamilyId: familyByDemand.get('blackboard') } : {}),
      maxPerGroup: demand.maxPerGroup ?? (demand.placement === 'wall' || demand.placement === 'anchor' || demand.placement === 'supported' ? 1 : demand.placement === 'paired' ? 1 : 4),
      ...(demand.placement === 'group' ? { aisleEvery: 4 } : {})
    }
  };
}

function fallbackFamilyLayer(family: SceneAssetFamily): SceneZoneLayer {
  const furniture = sceneAssetCategory(family) === 'furniture';
  return {
    familyId: family.id,
    density: furniture ? 0.04 : 0.01,
    scaleRange: [1, 1.15],
    distribution: furniture ? 'even' : 'accent',
    edgeFalloff: 0.12
  };
}

function indoorFamilyZone(
  plan: SceneCompositionPlan,
  zones: SceneCompositionPlan['zones'],
  family: SceneAssetFamily
): SceneCompositionPlan['zones'][number] | undefined {
  const requiredZoneId = plan.intentRequirements.find((requirement) => (
    requirement.kind === 'asset-family' && requirement.familyId === family.id
  ))?.targetZoneId;
  if (requiredZoneId) {
    const requiredZone = zones.find((zone) => zone.id === requiredZoneId && zone.role !== 'negative-space');
    if (requiredZone) return requiredZone;
  }
  const semantic = familySemantic(family);
  const preference = /door|entry|入口|门/i.test(semantic)
    ? /entry|entrance|入口|门厅/i
    : /window|daylight|窗|采光/i.test(semantic)
      ? /window|daylight|采光|窗/i
      : /service|counter|bar|storage|shelf|服务|吧台|收银|储物|货架/i.test(semantic)
        ? /service|counter|bar|storage|wall|服务|吧台|收银|储物|墙/i
        : null;
  return preference
    ? zones.find((zone) => zone.role !== 'negative-space' && preference.test(zoneSemantic(zone)))
    : undefined;
}

function zoneSemantic(zone: SceneCompositionPlan['zones'][number]): string {
  return `${zone.id} ${zone.label} ${zone.brief.atmosphere} ${zone.brief.hierarchy} ${zone.brief.transitionIntent}`;
}

function indoorDemandTree(semantic: string): IndoorAssetDemand[] {
  const common = [
    demand('door', 'Room door', 'primary room entrance', ['door', 'entry', 'wall-fixture'], /\bdoor\b|房门|门扇|入口门/i, 'medium', 0.96,
      'One complete cartoon voxel interior door model with frame and readable handle; standalone asset, no wall or room shell.', 'wall', undefined, 180, 1),
    demand('window', 'Room window', 'daylight wall fixture', ['window', 'glass', 'wall-prop'], /\bwindow\b|窗户|窗框/i, 'medium', 0.92,
      'One complete cartoon voxel window model with frame and transparent glass material; standalone asset, no wall.', 'wall', undefined, 90, 3)
  ];
  if (/internet cafe|cyber cafe|gaming cafe|网吧|电竞馆/i.test(semantic)) return [...common, ...internetCafeDemands()];
  if (/classroom|school|教室|课堂|学校/i.test(semantic)) return [...common, ...classroomDemands()];
  if (/restaurant|diner|cafe|cafeteria|餐厅|饭店|咖啡馆|食堂/i.test(semantic)) return [...common, ...restaurantDemands()];
  if (/office|workplace|studio|办公室|办公区|工作室/i.test(semantic)) return [...common, ...officeDemands()];
  if (/bedroom|bed room|卧室|寝室|睡房/i.test(semantic)) return [...common, ...bedroomDemands()];
  if (/living room|family room|kitchen|apartment|small home|residential|客厅|起居室|厨房|公寓|住宅|小户型/i.test(semantic)) {
    return [...common, ...residentialDemands(semantic)];
  }
  if (/warehouse|stockroom|storage room|仓库|库房|储藏室/i.test(semantic)) return [...common, ...warehouseDemands()];
  return [...common, ...genericDemands()];
}

function internetCafeDemands(): IndoorAssetDemand[] {
  return [
    demand('gaming-desk', 'Gaming desk', 'repeated internet-cafe workstation', ['gaming-desk', 'computer-desk', 'furniture'], /gaming desk|computer desk|internet cafe desk|网吧桌|电脑桌|电竞桌/i, 'medium', 0.99, 'One broad cartoon voxel gaming desk sized for one computer station; reusable desk only, no computer.', 'group', undefined, 0, 16),
    demand('gaming-chair', 'Gaming chair', 'one chair paired with every gaming desk', ['gaming-chair', 'internet-cafe', 'furniture'], /gaming chair|computer chair|网吧椅|电竞椅|电脑椅/i, 'medium', 0.98, 'One sturdy cartoon voxel gaming chair; reusable chair only.', 'paired', 'gaming-desk', 0, 1),
    demand('desktop-computer', 'Desktop computer station', 'one complete computer station supported by every desk', ['desktop-computer', 'monitor', 'keyboard', 'internet-cafe-equipment'], /desktop computer|computer station|gaming pc|电脑主机|台式电脑|显示器/i, 'medium', 0.99, 'One complete cartoon voxel desktop computer station containing monitor, keyboard, mouse and compact tower, arranged as one readable asset with a flat tabletop base; no desk.', 'supported', 'gaming-desk', 0, 1),
    demand('service-counter', 'Internet cafe counter', 'reception and payment point', ['service-counter', 'internet-cafe', 'furniture'], /service counter|reception counter|收银台|前台/i, 'large', 0.8, 'One compact internet-cafe reception and payment counter.', 'wall', undefined, 0, 1),
    demand('network-cabinet', 'Network cabinet', 'visible network service equipment', ['network-cabinet', 'internet-cafe-equipment'], /network cabinet|server rack|机柜|服务器柜/i, 'large', 0.68, 'One enclosed readable network cabinet with indicator lights.', 'wall', undefined, 90, 1),
    demand('wall-display', 'Gaming wall display', 'large shared game display', ['wall-display', 'internet-cafe-decor', 'wall-prop'], /wall display|large screen|游戏大屏|墙面屏幕/i, 'medium', 0.58, 'One large wall-mounted gaming display with a shallow frame.', 'wall', undefined, 180, 1),
    demand('snack-shelf', 'Snack shelf', 'daily service detail', ['snack-shelf', 'internet-cafe', 'furniture'], /snack shelf|drink shelf|零食架|饮料架/i, 'medium', 0.48, 'One compact shelf stocked with colorful drinks and snacks.', 'wall', undefined, 270, 1),
    demand('waste-bin', 'Internet cafe waste bin', 'readable daily-use prop', ['waste-bin', 'internet-cafe-prop'], /waste bin|trash bin|垃圾桶/i, 'medium', 0.4, 'One broad readable waste bin, not a tiny prop.', 'anchor')
  ];
}

function residentialDemands(semantic: string): IndoorAssetDemand[] {
  const living = [
    demand('sofa', 'Living-room sofa', 'primary social anchor', ['sofa', 'living-room', 'furniture'], /sofa|couch|沙发/i, 'large', 0.99, 'One cozy compact cartoon voxel sofa with cushions; standalone furniture.', 'wall', undefined, 0, 1),
    demand('coffee-table', 'Coffee table', 'reachable center surface', ['coffee-table', 'living-room', 'furniture'], /coffee table|茶几/i, 'medium', 0.94, 'One low compact coffee table with a broad usable top.', 'anchor'),
    demand('media-console', 'Media console', 'wall-side media storage', ['media-console', 'tv-stand', 'living-room', 'furniture'], /media console|tv stand|电视柜|媒体柜/i, 'medium', 0.88, 'One low media console with mixed open and closed storage.', 'wall', undefined, 180, 1),
    demand('television', 'Television', 'screen supported by the media console', ['television', 'living-room-electronics'], /television|\btv\b|电视机/i, 'medium', 0.86, 'One readable flat television on a short tabletop stand; no cabinet or wall.', 'supported', 'media-console', 0, 1),
    demand('area-rug', 'Area rug', 'soft zone-defining floor layer', ['area-rug', 'living-room-decor'], /area rug|carpet|地毯/i, 'large', 0.72, 'One flat rectangular patterned area rug for defining a compact seating zone.', 'anchor'),
    demand('tabletop-decor', 'Coffee-table daily decor', 'reachable everyday tabletop detail', ['book-stack', 'tray', 'tabletop-decor'], /book stack|tabletop decor|茶几摆件|书堆|托盘/i, 'small', 0.68, 'One readable grouped tabletop asset containing a book stack, tray and small cup; flat base, no table.', 'supported', 'coffee-table', 0, 1),
    demand('floor-lamp', 'Living-room floor lamp', 'warm secondary light accent', ['floor-lamp', 'living-room-decor'], /floor lamp|standing lamp|落地灯/i, 'medium', 0.6, 'One readable floor lamp with a broad warm shade.', 'anchor'),
    demand('plant', 'Living-room plant', 'soft living corner accent', ['indoor-plant', 'living-room-decor'], /indoor plant|potted plant|绿植|盆栽/i, 'medium', 0.54, 'One full indoor potted plant with a broad silhouette.', 'anchor'),
    demand('wall-art', 'Personal wall art', 'personal visual identity', ['wall-art', 'living-room-decor', 'wall-prop'], /wall art|painting|挂画|墙饰/i, 'medium', 0.5, 'One grouped framed wall-art composition, readable from across the room.', 'wall', undefined, 90, 1)
  ];
  const kitchen = [
    demand('kitchen-counter', 'Kitchen counter', 'primary preparation and storage run', ['kitchen-counter', 'base-cabinet', 'furniture'], /kitchen counter|base cabinet|厨房台面|地柜|橱柜/i, 'large', 0.99, 'One compact kitchen counter run with broad worktop and closed base storage; no appliances.', 'wall', undefined, 0, 2),
    demand('refrigerator', 'Refrigerator', 'cold-storage work center', ['refrigerator', 'kitchen-appliance'], /refrigerator|fridge|冰箱/i, 'large', 0.97, 'One compact refrigerator with readable doors and handles.', 'wall', undefined, 90, 1),
    demand('sink-counter', 'Sink counter', 'washing work center', ['sink-counter', 'kitchen-counter', 'furniture'], /sink counter|kitchen sink|水槽柜|厨房水槽/i, 'large', 0.95, 'One compact sink counter with basin, faucet and closed base storage.', 'wall', undefined, 0, 1),
    demand('cooktop-counter', 'Cooktop counter', 'cooking work center', ['cooktop-counter', 'kitchen-counter', 'furniture'], /cooktop|stove counter|灶台|炉灶/i, 'large', 0.94, 'One compact cooking counter with cooktop and closed base storage.', 'wall', undefined, 270, 1),
    demand('upper-cabinet', 'Upper kitchen cabinet', 'vertical household storage', ['upper-cabinet', 'kitchen-storage', 'wall-prop'], /upper cabinet|wall cabinet|吊柜/i, 'medium', 0.75, 'One compact wall-mounted kitchen cabinet with readable doors.', 'wall', undefined, 0, 2),
    demand('countertop-appliance', 'Countertop appliance group', 'everyday preparation detail', ['kettle', 'toaster', 'countertop-appliance'], /countertop appliance|kettle|toaster|台面电器|水壶|烤面包机/i, 'small', 0.7, 'One grouped countertop asset with a kettle and toaster on a flat base; no counter.', 'supported', 'kitchen-counter', 0, 1),
    demand('kitchen-daily-items', 'Kitchen daily items', 'visible lived-in countertop detail', ['dishware', 'fruit-bowl', 'kitchen-decor'], /dishware|fruit bowl|餐具|果盘/i, 'small', 0.64, 'One readable grouped countertop asset with bowls, plates and a fruit bowl; no counter.', 'supported', 'sink-counter', 0, 1),
    demand('kitchen-runner', 'Kitchen runner rug', 'soft floor accent outside the work route', ['kitchen-runner', 'area-rug', 'kitchen-decor'], /kitchen runner|runner rug|kitchen rug|厨房地毯|厨房脚垫/i, 'large', 0.61, 'One flat washable cartoon kitchen runner with a simple readable pattern; no raised border.', 'anchor'),
    demand('kitchen-wall-decor', 'Kitchen wall decor', 'warm visual detail on an unused wall', ['kitchen-wall-decor', 'wall-art', 'wall-prop'], /kitchen wall decor|kitchen wall art|厨房挂饰|厨房挂画/i, 'medium', 0.58, 'One shallow wall-mounted kitchen decoration, such as framed utensils or a cheerful food print.', 'wall', undefined, 180, 1),
    demand('kitchen-spice-shelf', 'Kitchen spice shelf', 'reachable wall storage detail', ['kitchen-spice-shelf', 'wall-prop', 'kitchen-storage'], /spice shelf|spice rack|调料架|香料架/i, 'medium', 0.56, 'One shallow wall-mounted spice shelf with a few broad readable jars; no wall.', 'wall', undefined, 0, 1),
    demand('kitchen-utensil-rack', 'Kitchen utensil rack', 'visible cooking tool detail', ['kitchen-utensil-rack', 'wall-prop', 'kitchen-decor'], /utensil rack|hanging utensils|厨具挂架|锅铲挂架/i, 'medium', 0.53, 'One shallow wall-mounted rack with several broad cartoon cooking utensils.', 'wall', undefined, 270, 1),
    demand('kitchen-ceiling-light', 'Kitchen ceiling light', 'even task lighting', ['kitchen-ceiling-light', 'ceiling-light', 'ceiling-mounted', 'lighting'], /kitchen ceiling light|kitchen pendant|厨房顶灯|厨房吊灯/i, 'medium', 0.51, 'One compact ceiling-mounted kitchen light with a broad warm diffuser.', 'anchor', undefined, 0, 1),
    demand('kitchen-bin', 'Kitchen bin', 'daily household utility', ['waste-bin', 'kitchen-prop'], /kitchen bin|trash bin|厨房垃圾桶/i, 'medium', 0.46, 'One compact readable lidded kitchen bin.', 'anchor')
  ];
  const hasLiving = /living room|family room|客厅|起居室/i.test(semantic);
  const hasKitchen = /kitchen|厨房/i.test(semantic);
  if (hasLiving && hasKitchen) {
    return [living[0], kitchen[0], living[1], kitchen[1], kitchen[2], kitchen[3], living[2], living[3], living[4], kitchen[5], living[5], kitchen[6], living[6], living[7]];
  }
  return hasKitchen && !hasLiving ? kitchen : living;
}

function classroomDemands(): IndoorAssetDemand[] {
  return [
    demand('blackboard', 'Front blackboard', 'main teaching surface', ['blackboard', 'teaching-surface', 'wall-prop'], /blackboard|chalkboard|whiteboard|黑板|白板/i, 'large', 0.98, 'One wide classroom blackboard with a shallow frame; standalone wall-mounted asset.', 'wall', undefined, 0, 1),
    demand('student-desk', 'Student desk', 'repeated student work surface', ['student-desk', 'classroom-desk', 'furniture'], /student desk|classroom desk|school desk|课桌|学生桌/i, 'medium', 0.95, 'One sturdy cartoon voxel student desk with stocky proportions; single reusable desk only.', 'group', undefined, 0, 24),
    demand('student-chair', 'Student chair', 'seat paired behind each student desk', ['student-chair', 'classroom-chair', 'furniture'], /student chair|classroom chair|school chair|学生椅|课椅/i, 'medium', 0.95, 'One sturdy cartoon voxel student chair with broad seat and thick legs; single reusable chair only.', 'paired', 'student-desk', 0, 1),
    demand('teacher-desk', 'Teacher desk', 'teacher workstation near teaching wall', ['teacher-desk', 'classroom', 'furniture'], /teacher desk|教师桌|讲桌/i, 'medium', 0.82, 'One broad teacher desk matching the student furniture style.', 'anchor'),
    demand('bookcase', 'Classroom bookcase', 'book and teaching storage', ['bookcase', 'classroom-storage', 'furniture'], /bookcase|bookshelf|书柜|书架/i, 'large', 0.76, 'One broad classroom bookcase with readable books and closed base storage.', 'wall', undefined, 90, 2),
    demand('storage-cabinet', 'Classroom storage cabinet', 'teaching supply storage', ['storage-cabinet', 'classroom', 'furniture'], /storage cabinet|supply cabinet|储物柜|教具柜/i, 'large', 0.72, 'One stocky classroom supply cabinet.', 'wall', undefined, 270, 2),
    demand('notice-board', 'Classroom notice board', 'secondary teaching display', ['notice-board', 'wall-prop', 'classroom-decor'], /notice board|bulletin board|公告板|展示板/i, 'medium', 0.6, 'One colorful classroom notice board with a shallow frame.', 'wall', undefined, 270, 1),
    demand('wall-clock', 'Classroom wall clock', 'readable wall decoration', ['wall-clock', 'wall-prop', 'classroom-decor'], /wall clock|clock|挂钟|时钟/i, 'small', 0.55, 'One large readable cartoon wall clock, not a tiny prop.', 'wall', undefined, 0, 1),
    demand('teaching-prop', 'Teaching globe', 'secondary teaching prop', ['teaching-globe', 'classroom-prop'], /globe|teaching prop|地球仪|教学模型/i, 'medium', 0.5, 'One readable classroom teaching globe on a sturdy stand.', 'anchor'),
    demand('waste-bin', 'Classroom waste bin', 'small but readable service prop', ['waste-bin', 'classroom-prop'], /waste bin|trash bin|垃圾桶|废纸篓/i, 'medium', 0.45, 'One broad readable classroom waste bin, not a tiny prop.', 'anchor')
  ];
}

function restaurantDemands(): IndoorAssetDemand[] {
  return [
    demand('dining-table', 'Dining table', 'repeated dining group anchor', ['dining-table', 'restaurant', 'furniture'], /dining table|restaurant table|cafe table|coffee table|餐桌|饭桌|咖啡桌/i, 'medium', 0.96, 'One broad cartoon voxel dining table for a small restaurant; single reusable table only.', 'group', undefined, 0, 12),
    demand('dining-chair', 'Dining chair', 'chairs arranged around every dining table', ['dining-chair', 'restaurant', 'furniture'], /dining chair|restaurant chair|cafe chair|coffee chair|餐椅|咖啡馆椅|咖啡椅/i, 'medium', 0.95, 'One broad sturdy dining chair matching the dining table.', 'social', 'dining-table', 0, 4),
    demand('service-counter', 'Service counter', 'cashier and service focal point', ['service-counter', 'cashier-counter', 'furniture'], /service counter|cashier|checkout|收银台|服务台/i, 'large', 0.9, 'One broad restaurant cashier and service counter, human-scaled and not oversized.', 'wall', undefined, 0, 1),
    demand('menu-board', 'Menu board', 'menu display above service area', ['menu-board', 'wall-prop', 'restaurant-decor'], /menu board|menu sign|菜单板|菜单牌/i, 'medium', 0.72, 'One readable wall-mounted menu board with a shallow frame.', 'wall', undefined, 0, 1),
    demand('restaurant-storage', 'Restaurant storage shelf', 'service storage', ['restaurant-shelf', 'storage', 'furniture'], /restaurant shelf|service shelf|餐厅货架|餐具架/i, 'medium', 0.65, 'One stocky restaurant service shelf with tableware.', 'wall', undefined, 270, 2),
    demand('room-divider', 'Restaurant divider', 'secondary dining-zone divider', ['room-divider', 'restaurant', 'furniture'], /divider|screen|隔断|屏风/i, 'medium', 0.58, 'One low open restaurant divider that preserves sight lines.', 'anchor'),
    demand('wall-decor', 'Restaurant wall decoration', 'visual identity and wall detail', ['wall-art', 'wall-prop', 'restaurant-decor'], /wall art|wall decor|poster|挂画|墙饰|海报/i, 'medium', 0.52, 'One readable restaurant wall decoration, not a tiny prop.', 'wall', undefined, 90, 2),
    demand('plant', 'Indoor plant', 'soft secondary corner accent', ['indoor-plant', 'restaurant-decor'], /indoor plant|potted plant|绿植|盆栽/i, 'medium', 0.48, 'One full readable indoor potted plant with a broad silhouette.', 'anchor')
  ];
}

function officeDemands(): IndoorAssetDemand[] {
  return [
    demand('work-desk', 'Office desk', 'repeated workstation anchor', ['office-desk', 'workstation', 'furniture'], /office desk|work desk|workstation|办公桌|工位/i, 'medium', 0.96, 'One broad cartoon office desk; single reusable workstation desk only.', 'group', undefined, 0, 12),
    demand('office-chair', 'Office chair', 'chair paired with every workstation', ['office-chair', 'workstation-chair', 'furniture'], /office chair|desk chair|办公椅|工位椅/i, 'medium', 0.95, 'One broad stocky office chair matching the workstation desk.', 'paired', 'work-desk', 0, 1),
    demand('office-storage', 'Office storage cabinet', 'document storage', ['office-cabinet', 'storage', 'furniture'], /office cabinet|filing cabinet|文件柜|办公柜/i, 'medium', 0.78, 'One broad office filing and storage cabinet.', 'wall', undefined, 90, 3),
    demand('bookcase', 'Office bookcase', 'books and display storage', ['bookcase', 'office', 'furniture'], /bookcase|bookshelf|书柜|书架/i, 'large', 0.7, 'One broad office bookcase with readable shelves.', 'wall', undefined, 270, 2),
    demand('meeting-table', 'Meeting table', 'secondary collaboration group', ['meeting-table', 'office', 'furniture'], /meeting table|conference table|会议桌/i, 'large', 0.66, 'One broad compact meeting table, visibly larger than a desk but below counter height.', 'anchor'),
    demand('notice-board', 'Office notice board', 'shared information display', ['notice-board', 'wall-prop', 'office-decor'], /notice board|whiteboard|公告板|白板/i, 'medium', 0.6, 'One readable office notice board.', 'wall', undefined, 0, 1),
    demand('printer-cabinet', 'Printer cabinet', 'shared office service station', ['printer-cabinet', 'office-service', 'furniture'], /printer|copy station|打印机|复印机/i, 'medium', 0.54, 'One office printer on a sturdy storage cabinet.', 'wall', undefined, 180, 1),
    demand('plant', 'Office plant', 'soft corner accent', ['indoor-plant', 'office-decor'], /indoor plant|potted plant|绿植|盆栽/i, 'medium', 0.46, 'One readable broad indoor office plant.', 'anchor')
  ];
}

function bedroomDemands(): IndoorAssetDemand[] {
  return [
    demand('bed', 'Bed', 'primary sleeping furniture', ['bed', 'bedroom', 'furniture'], /\bbed\b|床铺|双人床|单人床/i, 'large', 0.98, 'One complete broad cartoon voxel bed with headboard; standalone furniture only.', 'wall', undefined, 0, 1),
    demand('bedside-table', 'Bedside table', 'bedside support furniture', ['bedside-table', 'bedroom', 'furniture'], /bedside table|nightstand|床头柜/i, 'medium', 0.86, 'One stocky bedside table matching the bed.', 'anchor'),
    demand('wardrobe', 'Wardrobe', 'clothing storage', ['wardrobe', 'bedroom-storage', 'furniture'], /wardrobe|衣柜/i, 'large', 0.86, 'One broad wardrobe with readable doors and handles.', 'wall', undefined, 90, 1),
    demand('dresser', 'Bedroom dresser', 'secondary clothing storage', ['dresser', 'bedroom-storage', 'furniture'], /dresser|chest of drawers|斗柜|梳妆柜/i, 'medium', 0.7, 'One broad low bedroom dresser.', 'wall', undefined, 270, 1),
    demand('armchair', 'Bedroom armchair', 'secondary reading corner', ['armchair', 'bedroom', 'furniture'], /armchair|reading chair|扶手椅|阅读椅/i, 'medium', 0.62, 'One broad cozy cartoon armchair.', 'anchor'),
    demand('floor-lamp', 'Bedroom floor lamp', 'readable lighting accent', ['floor-lamp', 'bedroom-decor'], /floor lamp|standing lamp|落地灯/i, 'medium', 0.58, 'One readable floor lamp with a broad shade, not a tiny prop.', 'anchor'),
    demand('wall-art', 'Bedroom wall art', 'personal wall decoration', ['wall-art', 'wall-prop', 'bedroom-decor'], /wall art|painting|poster|挂画|墙饰|海报/i, 'medium', 0.5, 'One readable framed bedroom wall decoration.', 'wall', undefined, 180, 1),
    demand('storage-chest', 'Storage chest', 'secondary storage and room detail', ['storage-chest', 'bedroom', 'furniture'], /storage chest|blanket chest|储物箱|床尾凳/i, 'medium', 0.46, 'One broad low bedroom storage chest.', 'anchor')
  ];
}

function warehouseDemands(): IndoorAssetDemand[] {
  return [
    demand('warehouse-shelf', 'Warehouse shelving', 'repeated storage rows', ['warehouse-shelf', 'storage-rack', 'furniture'], /warehouse shelf|storage rack|货架|仓储架/i, 'large', 0.98, 'One tall broad industrial storage rack; single reusable rack only.', 'group', undefined, 0, 20),
    demand('crate', 'Storage crate', 'repeatable stored goods', ['crate', 'warehouse-prop'], /crate|木箱|货箱/i, 'medium', 0.86, 'One large readable storage crate, not a tiny box.', 'group', undefined, 90, 12),
    demand('pallet', 'Loaded pallet', 'floor storage group', ['loaded-pallet', 'warehouse-prop'], /pallet|托盘|栈板/i, 'medium', 0.76, 'One loaded warehouse pallet with a broad silhouette.', 'group', undefined, 90, 8),
    demand('workbench', 'Warehouse workbench', 'packing and maintenance station', ['workbench', 'warehouse', 'furniture'], /workbench|packing table|工作台|打包台/i, 'large', 0.7, 'One broad industrial workbench.', 'wall', undefined, 0, 2),
    demand('warehouse-cart', 'Warehouse cart', 'material handling equipment', ['warehouse-cart', 'facility'], /warehouse cart|trolley|推车|手推车/i, 'medium', 0.6, 'One readable warehouse material cart.', 'anchor'),
    demand('safety-sign', 'Warehouse safety sign', 'wall safety information', ['safety-sign', 'wall-prop', 'warehouse-decor'], /safety sign|warning sign|安全标识|警示牌/i, 'medium', 0.52, 'One large readable warehouse safety sign.', 'wall', undefined, 180, 2),
    demand('barrel', 'Storage barrel', 'secondary stored-goods variety', ['barrel', 'warehouse-prop'], /barrel|drum|桶|油桶/i, 'medium', 0.48, 'One large readable storage barrel.', 'group', undefined, 90, 6)
  ];
}

function genericDemands(): IndoorAssetDemand[] {
  return [
    demand('primary-table', 'Room table', 'primary activity surface', ['room-table', 'furniture'], /table|desk|桌|台/i, 'medium', 0.82, 'One broad general-purpose cartoon room table.', 'anchor'),
    demand('primary-seat', 'Room chair', 'primary activity seat', ['room-chair', 'furniture'], /chair|seat|椅|座位/i, 'medium', 0.78, 'One broad sturdy cartoon room chair.', 'anchor'),
    demand('storage-cabinet', 'Storage cabinet', 'room storage', ['storage-cabinet', 'furniture'], /cabinet|wardrobe|柜|衣柜/i, 'large', 0.72, 'One broad room storage cabinet.', 'wall', undefined, 90, 2),
    demand('bookcase', 'Bookcase', 'books and display storage', ['bookcase', 'furniture'], /bookcase|bookshelf|书柜|书架/i, 'large', 0.66, 'One broad bookcase with readable shelves.', 'wall', undefined, 270, 2),
    demand('wall-decor', 'Wall decoration', 'secondary wall detail', ['wall-art', 'wall-prop', 'room-decor'], /wall art|painting|poster|挂画|墙饰|海报/i, 'medium', 0.52, 'One readable framed wall decoration.', 'wall', undefined, 0, 2),
    demand('plant', 'Indoor plant', 'soft corner accent', ['indoor-plant', 'room-decor'], /indoor plant|potted plant|绿植|盆栽/i, 'medium', 0.48, 'One readable broad indoor plant.', 'anchor'),
    demand('floor-lamp', 'Floor lamp', 'readable lighting accent', ['floor-lamp', 'room-decor'], /floor lamp|standing lamp|落地灯/i, 'medium', 0.45, 'One readable floor lamp with broad proportions.', 'anchor')
  ];
}

function demand(
  key: string,
  label: string,
  role: string,
  tags: string[],
  matches: RegExp,
  sizeClass: SceneAssetFamily['sizeClass'],
  priority: number,
  generationBrief: string,
  placement: IndoorAssetDemand['placement'],
  targetKey?: string,
  wallDirection?: number,
  maxPerGroup?: number
): IndoorAssetDemand {
  return { key, label, role, tags, matches, sizeClass, priority, generationBrief, placement, targetKey, wallDirection, maxPerGroup };
}

function familySemantic(family: SceneAssetFamily): string {
  return `${family.id} ${family.label} ${family.role} ${family.tags.join(' ')} ${family.generationBrief}`;
}

function uniqueFamilyId(base: string, families: readonly SceneAssetFamily[]): string {
  const used = new Set(families.map((family) => family.id));
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

function familyDirection(seed: number, familyId: string): number {
  let hash = Math.trunc(seed) >>> 0;
  for (const character of familyId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return Math.round((hash % 4) * 90);
}
