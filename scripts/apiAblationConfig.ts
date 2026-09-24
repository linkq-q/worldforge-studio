import ts from 'typescript';
import { buildMapCodePlannerSystemPrompt } from '../src/server/mapCodePlanner';
import type { EditableMap } from '../src/shared/map';

export const MAX_ROUNDS = 50;
export const MIN_ASSETS = 10;
export const MAX_ASSETS = 16;
export const PLANNER_PROVIDER = 'gpt' as const;
export const ASSET_PROVIDER = 'deepseek' as const;
export const CORE_APIS = ['terrain', 'modifyTerrain', 'surface', 'water', 'route', 'grass', 'requireAsset', 'asset', 'place', 'random'];
export const EXTRA_API_DOCS = {
  placeBetween: "api.placeBetween({assetId?,name?,start:[x,z],end:[x,z],dimensions:[width,height,depth],spanAxis:'x'|'z',gapRatio?,frontTarget?:[x,z],scale?,terrain?,elevation?:number}) returns a placement reference. It fits ONLY the declared connection axis between endpoints and aligns its yaw. Use spanAxis:'x' for side-by-side wall/facade modules, 'z' for traversal modules. elevation is a fixed offset above the final terrain; it does not tilt geometry in pitch/roll. The endpoints and shape remain your decision.",
  foundation: "api.foundation({name?,shape:'capsule'|'rounded-rectangle'|'polygon'|'path',under?:[placementReference,...],position?:[x,z]|[x,y,z],width?,depth?,margin?,cornerRadius?,points?:[[localX,localZ],...],curve?:'polyline'|'catmull-rom',closed?,top?:'level'|'slope'|'steps',thickness?,maxThickness?,slope?,slopeDirection?:radians,stepHeight?,stepCount?,material?}) creates a separate editable foundation AFTER the supported placements. Its bottom follows terrain and its top supports the linked objects; it does not flatten terrain. Bounded maxThickness can cause an unsuitable foundation to be skipped. This is optional when the intended construction needs a foundation.",
  attach: "api.attach({assetId?,name?,parentId:placementReference,kind:'supported'|'mounted',side?:'north'|'south'|'east'|'west',offset?,anchorY?:'bottom'|'center'|'top',contact?,scale?,rotationY?,role?}) returns a placement reference and physically relates a child to an earlier host. For mounted facade contact, offset is [horizontal,vertical] in the host frame, side is host-local, anchorY selects the height baseline (entrances default to bottom), contact is embed depth. For supported top contact use offset:[x,y,z]. Supply a real host reference returned by place; it is not an asset ID.",
  sampleProbabilityField: "api.sampleProbabilityField({bounds?:{minX,maxX,minZ,maxZ},maxPoints?,candidates?,minDistance?,seed?,guideIds?:string[],region?,cluster?:{strength,scale,seed},marks?:[{id,minDistance?,maxPoints?,cluster?}]}, sample => weightOrMarkWeights) returns [x,z] points with optional point.mark. sample includes x,z,height,slope,waterDistance,guideDistance and signed regionDistance when a region is supplied (negative inside). Weights are clamped to [0,1]. Return a number, or {[markId]:weight} when marks are specified. Different marks may have their own spacing/quota/clustering; labels and weights are yours. At most 4096 candidates and 512 results; maxPoints is an upper bound, so an over-restrictive field may be empty. This only samples points; place the results yourself.",
  design: "api.design({intent,experienceMode?:'immediate'|'sequential'|'mixed',groups?:[{id,name,region?,spatialRole?:'landmark-ensemble'|'urban-fabric'|'open-space'|'landscape',substrate?:'dry'|'water'|'amphibious'|'underwater',layers?:[{level:1|2|3|4,intent,density:'tight'|'normal'|'open'}]}],focuses?:[{id,groupId,name,kind:'primary'|'secondary'|'node',rank,objectId?,reveal:'visible'|'screened'|'framed'|'sequence'}],relations?:[{id,kind:'attract'|'repel'|'support',sourceSelector,targetSelector?,sourceGroupId?,targetGroupId?,strength:'tight'|'normal'|'open',minDistance?,maxDistance?}]}) stores optional semantic labels; it does NOT move/place/attract/repel objects or physically support them. place also accepts groupId and layer to link those labels. Use at most one design call if those labels help describe actual spatial responsibilities. Geometry still comes from the executable terrain/routes/placements. No design style or group count is required."
} as const;
export type Profile = 'core10' | keyof typeof EXTRA_API_DOCS;
export const PROFILES: Profile[] = ['core10', 'placeBetween', 'foundation', 'attach', 'sampleProbabilityField', 'design'];
export const SCENES = [
  { id: 'airport', name: '机场', prompt: '建造一座可辨识的现代国际机场微缩场景。航站楼是视觉主体，屋顶应有连续起伏的波浪轮廓，不用平顶、三角坡顶或一排台阶替代。体现陆侧入口与落客区、空侧停机坪、飞机和登机廊桥的空间关系；旅客入口和廊桥应与航站楼实际接合，飞机通路保持开放。安排有节奏但不机械铺满的配套设施，主次分明。' },
  { id: 'hillside', name: '山地村落', prompt: '建造依山而建的村落。地势有明显高差，多栋房屋随山势形成不完全规则的聚落，保留可辨识的屋顶轮廓和公共小广场。房屋有可信承托，门口与坡路或台阶相连；有一段沿山势转弯的栏杆或廊道，不能悬空、穿山或将全场铺成一块平平台。植被疏密随地形变化，留出主要通行空间。' },
  { id: 'hydro', name: '水电站', prompt: '建造山谷水电站微缩场景。高处水库由坝体拦蓄，下游河道低于库面，泄水口与水流方向对应；厂房、检修平台和设备布置与坝体有功能联系。检修步道及栏杆应连续，设备有合理承托，门和附属设施与宿主接合。两岸植被随坡度和水边关系疏密变化，保持水库、坝和河流边界协调，不能把水面贴成悬浮的胶片。' },
  { id: 'wetland', name: '湿地观测区', prompt: '建造自然湿地中的生态观测区。弯曲水道、浅滩和高处林地形成非均匀生态分布；乔木、灌木、芦苇等形成有空隙的群落，不要整齐棋盘或均匀撒满。曲折的观测栈道连接入口和高脚观景亭，栈道、栏杆、亭子的支撑和接合可信；标牌或灯应依附对应设施。保留自然留白、开阔观察面和主体层级。' }
] as const;
export interface Trial { key: string; scene: typeof SCENES[number]['id']; profile: Profile; repeat: number; seed: number }

export function trialMatrix(): Trial[] {
  return SCENES.flatMap((scene, sceneIndex) => [1, 2].flatMap(repeat => {
    const order = repeat === 1 ? PROFILES : [...PROFILES].reverse();
    return order.map(profile => ({ key: `${scene.id}-${profile}-r${repeat}`, scene: scene.id, profile, repeat, seed: 92400 + sceneIndex * 10 + repeat }));
  }));
}

export function hillsideReviewTrials(): Trial[] {
  return [1, 2, 3, 4].flatMap(repeat => {
    const order = repeat % 2 === 1 ? PROFILES : [...PROFILES].reverse();
    return order.map(profile => ({
      key: `hillside-${profile}-r${repeat}`,
      scene: 'hillside' as const,
      profile,
      repeat,
      seed: 92410 + repeat
    }));
  });
}

export function experimentPrompt(map: EditableMap, profile: Profile): string {
  const base = buildMapCodePlannerSystemPrompt(map, [], MIN_ASSETS, MAX_ASSETS, 'scene', 'generate', '', [], 'minimal')
    .replace("minimal outdoor scene composer", 'outdoor scene composer')
    .replace('The sandbox exposes exactly these 10 WorldForge APIs;', 'Only the WorldForge APIs documented below are permitted;');
  return `${base}\n\nCommon experiment contract: use only direct api.method(...) calls. Do not alias, enumerate or dynamically index api. Use ${MIN_ASSETS}..${MAX_ASSETS} distinct asset families; optional seed-derived variants do not count as extra families. Omit mountOnAssetId. You may reuse the resulting objects and vary placements. All visible required content must be placed. Call api.surface with one object containing id and surface; never pass id plus an options object. A requireAsset return value is a key, not an asset ID: every generated placement must use assetId:api.asset(key). The scene has Y-up; [x,z] is terrain-relative. [x,y,z] uses fixed world Y unless terrain:true, which makes y a terrain-relative offset. rotationY is in degrees. A placement reference returned by place is distinct from an asset ID. Use at most 512 placements. Each asset prompt must stay within 450 characters; preserve its distinguishing silhouette, connections and orientation before small details. You choose whether any available helper is appropriate; tool usage itself is not a success criterion.\n${profile === 'core10' ? '' : `\nAdditional available API:\n${EXTRA_API_DOCS[profile]}`}`;
}

export function assertModelRoute(url: string, body: { provider?: string }): void {
  const route = new URL(url).pathname;
  const required = route === '/api/chat' ? PLANNER_PROVIDER : route === '/api/generate/model' ? ASSET_PROVIDER : null;
  if (!required || body.provider !== required) throw new Error(`experiment_provider_mismatch:${route}:${body.provider}`);
}

/** Audit capability use before paying for assets; the existing VM remains the execution sandbox. */
export function auditApiUse(code: string, profile: Profile): string[] {
  const source = ts.createSourceFile('plan.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const allowed = new Set([...CORE_APIS, ...(profile === 'core10' ? [] : [profile])]);
  const calls: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === 'api') {
      const parent = node.parent;
      if (ts.isParameter(parent) && parent.name === node && ts.isFunctionDeclaration(parent.parent) && parent.parent.name?.text === 'plan') return;
      if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node
        || !ts.isCallExpression(parent.parent) || parent.parent.expression !== parent) throw new Error('experiment_api_indirect_access');
      const name = parent.name.text;
      if (!allowed.has(name)) throw new Error(`experiment_api_not_available:${name}`);
      calls.push(name);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls;
}

export function assertRoundAvailable(keys: readonly string[], key: string): void {
  if (keys.includes(key)) throw new Error(`experiment_round_already_attempted:${key}`);
  if (keys.length >= MAX_ROUNDS) throw new Error('experiment_round_limit_50');
}
