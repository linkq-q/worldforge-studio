import { auditApiUse, type Profile } from './apiAblationConfig';

export const LANDMARK_PROFILES = ['core10', 'placeBetween', 'attach'] as const;
export const LANDMARKS = [
  { id: 'qiniandian', name: '天坛祈年殿', source: 'https://gygl.beijing.gov.cn/mlgy/mlgy_gyjg01/201912/t20191211_1048233.html',
    prompt: '建造可一眼辨识的北京天坛祈年殿及其三层汉白玉圆台。主体是圆形殿身、蓝瓦三重檐攒尖顶，三重屋檐向上逐层收缩，顶部金色宝顶；红柱、彩绘檐下构件、白石栏杆及通向殿门的台阶有明确位置关系。三层圆台、殿身、屋檐必须层级清楚、同心且可信接合，屋顶不能变成方盒、普通方亭或直立圆筒。只做这一座建筑及其台基，不扩展成整个天坛公园。允许有棱面的低多边形表达，但保持圆形和曲线屋檐的总体轮廓。' },
  { id: 'colosseum', name: '罗马斗兽场', source: 'https://colosseo.it/en/area/the-colosseum/',
    prompt: '建造可一眼辨识的罗马斗兽场，以完整时期的结构复原示意为目标。主体具有椭圆形平面、层叠的连续拱券外廊、最上层实体墙、中央露天竞技场和向内逐层下降的环形看台；入口贯通外墙到内部，不封死中央空场。外廊各层相互承托，重复拱券沿椭圆连续连接，形成一座复合建筑，不能用一圈互不相连的房子或一个实心椭圆块代替。不扩展成城市街区，允许低多边形简化而保持主要空间关系。' }
] as const;

export function landmarkTrials() {
  return LANDMARKS.flatMap((scene, index) => [1, 2].flatMap(repeat =>
    (repeat === 1 ? [...LANDMARK_PROFILES] : [...LANDMARK_PROFILES].reverse()).map(profile => ({
      key: `landmark-${scene.id}-${profile}-r${repeat}`, scene: scene.id, profile, repeat, seed: 92500 + index * 10 + repeat
    }))));
}

// These contracts describe the implementation, not the earlier hillside appendix.
export const LANDMARK_HELPERS = {
  placeBetween: "api.placeBetween({assetId,name?,start:[x,z],end:[x,z],dimensions:[width,height,depth],spanAxis:'x'|'z',gapRatio?,frontTarget?:[x,z],elevation?:number,scale?}) places a connected module. It returns no value. The chosen span axis fits the endpoint distance; the other dimensions set its height/depth. elevation is the bottom height above the fixed flat ground. It aligns yaw only, not pitch/roll. Use spanAxis:'x' for side-by-side facade bays or 'z' for traversal modules. frontTarget chooses which side the front faces. Do not use its return value as parentId.",
  attach: "api.attach({assetId,name?,parentId,kind:'supported'|'mounted',side?:'north'|'south'|'east'|'west',offset?:[a,b],anchorY?:'bottom'|'center'|'top',contact?,scale?,rotationY?}) returns a placement reference. parentId must be a reference from an earlier place or attach. supported puts a child on the host's top using host-local offset:[x,z]. mounted uses a host-local side and offset:[horizontal,vertical] relative to anchorY (doors default bottom); contact is embed depth. This uses host geometry/bounds, not arbitrary curved-surface snapping. Use place when a precise authored world position is more appropriate."
} as const;

export function landmarkSystemPrompt(profile: typeof LANDMARK_PROFILES[number], catalog: unknown, seed: number) {
  const common = `Return only function plan(api) { ... }, synchronous bounded JavaScript. Build the requested recognizable compound landmark from the supplied identical DeepSeek asset kit. This is an assembly experiment, not an asset-generation comparison. No imports, network, async, timers, eval or external state. Plain JavaScript helpers, Math and loops are allowed. Use at most 512 placements. Map bounds x,z=-48..48, height=48, ground is fixed flat y=0, random seed=${seed}. Keep the landmark within x,z=-40..40 and y=0..44. Do not change terrain, create scenery, or generate additional assets. Do not invent IDs or proxy geometry. Use the catalog's real asset IDs; use whatever subset actually benefits the building, with repetition where appropriate. The kit decomposition is held constant across all arms, not evidence that this is the optimal decomposition.
Available common APIs:
api.place({assetId,name?,position:[x,y,z],terrain:false,rotationY?:degrees,scale?:number|[sx,sy,sz]}) returns a placement reference. Y-up; position y is the object's bottom height, x/z its horizontal center. Local Z+ is front and X+ right. Scale multiplies actual catalog dimensions, not target dimensions. Use measured dimensions below when planning contacts. Do not treat a placement reference as an asset ID.
api.random(min?,max?) returns a deterministic random value.
No helper use is mandatory. First preserve the landmark silhouette, open spaces and physically joined structural parts. Avoid spending the budget on detached decorations. Preserve the original brief in your choices. Available shared assets with measured local bounds and generation descriptions:
${JSON.stringify(catalog)}
`;
  return common + (profile === 'core10' ? '' : `\nAdditional optional API:\n${LANDMARK_HELPERS[profile]}`);
}

export function auditLandmarkCode(code: string, profile: Profile) {
  const calls = auditApiUse(code, profile);
  for (const call of calls) if (!['place', 'random', ...(profile === 'core10' ? [] : [profile])].includes(call)) {
    throw new Error(`landmark_fixed_environment_or_asset_kit:${call}`);
  }
  return calls;
}

export function assertLandmarkOperations(operations: readonly { type: string }[]) {
  // The executor appends the editor reference point even for placement-only code.
  for (const op of operations) if (!['object.add', 'map.update', 'reference.set'].includes(op.type)) {
    throw new Error(`landmark_unexpected_environment_mutation:${op.type}`);
  }
}
