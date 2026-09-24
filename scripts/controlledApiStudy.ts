import ts from 'typescript';
import { buildMapCodePlannerSystemPrompt } from '../src/server/mapCodePlanner';
import { EXTRA_API_DOCS } from '../src/server/mapExperimentProfiles';
import { createEmptyMap } from '../src/shared/map';
import type { ModelGenerationMode } from '../src/shared/modelGenerationMode';

export const LIMIT = 100;
export const CORE = ['terrain', 'modifyTerrain', 'sculptTerrain', 'rampTerrain', 'surface', 'water', 'route', 'grass', 'requireAsset', 'asset', 'place', 'random'];
export const FULL = [...CORE, 'sceneIntent', 'design', 'routeNetwork', 'placeAlongRoute', 'spawn', 'renderSuggestion', 'distance2D', 'bezierPoint', 'circlePoint', 'environmentSample', 'waterPoint', 'subdividePathBySpan', 'poissonDisk', 'sampleProbabilityField', 'tangentYaw', 'faceYaw', 'foundation', 'sightline', 'passage', 'attach', 'bridge', 'placeBetween'];
export type Profile = 'minimal' | 'full' | 'foundation' | 'sampleProbabilityField' | 'attach' | 'placeBetween';
export const SCENES = [
  { id: 'village', name: '山谷村庄', prompt: '一座坐落在山谷坡地上的密集石屋村庄，有公共小广场、随山势转弯的道路和台阶。', extras: ['foundation', 'sampleProbabilityField'] },
  { id: 'rainforest', name: '雨林神庙', prompt: '一座隐藏在热带雨林中的大型古代神庙遗迹。', extras: ['sampleProbabilityField', 'attach'] },
  { id: 'ski', name: '滑雪度假村', prompt: '一座建在雪山坡地上的大型滑雪度假村，包含缆车、雪道和木屋酒店。', extras: [] },
  { id: 'desert', name: '沙漠炼油厂', prompt: '一座位于起伏沙漠中的大型炼油厂，布满储油罐、蒸馏塔和管线。', extras: [] },
  { id: 'airport', name: '机场', prompt: '一座拥有长跑道、现代航站楼和停机坪的国际机场。航站楼屋顶具有连续起伏的波浪轮廓，廊桥连接航站楼与飞机。', extras: ['placeBetween', 'attach'] },
  { id: 'hydro', name: '山谷水电站', prompt: '一座横跨陡峭山谷的大型混凝土水坝与水力发电站，坝前高处水库和坝后低处河道有清晰的水位高差。', extras: ['foundation', 'placeBetween'] },
  { id: 'abstract', name: '记忆之城', prompt: '一座以“记忆与遗忘”为主题的抽象空间场景。让主题通过可辨识的空间关系、主体层次和留白表达。', extras: [] },
  { id: 'colosseum', name: '斗兽场', prompt: '一座中古时期的宏伟石砌斗兽场，有椭圆形连续外墙、多层拱廊、环形看台和通向内场的入口。', extras: [] }
] as const;
export type SceneId = typeof SCENES[number]['id'];
export interface Trial {
  key: string; group: string; scene: SceneId; profile: Profile; repeat: number; seed: number;
  stage: 'main' | 'single-api' | 'open-assets' | 'reference' | 'review';
  kitKey: string; reference?: boolean; reviewReason?: string;
}
export function trials(): Trial[] {
  const out: Trial[] = [];
  for (const [index, scene] of SCENES.slice(0, 7).entries()) {
    for (let repeat = 1; repeat <= 3; repeat++) {
      const group = `${scene.id}-r${repeat}`, seed = 925000 + index * 100 + repeat;
      const pair: Profile[] = repeat % 2 ? ['minimal', 'full'] : ['full', 'minimal'];
      for (const profile of [...pair, ...scene.extras] as Profile[]) out.push({
        key: `${group}-${profile}`, group, scene: scene.id, profile, repeat, seed,
        stage: pair.includes(profile) ? 'main' : 'single-api', kitKey: group
      });
      if (scene.id === 'abstract') for (const profile of pair) out.push({
        key: `${group}-${profile}-reference`, group, scene: scene.id, profile, repeat, seed,
        stage: 'reference', kitKey: group, reference: true
      });
    }
  }
  for (const [index, scene] of ['airport', 'colosseum'].entries()) for (let repeat = 1; repeat <= 6; repeat++) {
    const group = `open-${scene}-r${repeat}`, seed = 926000 + index * 100 + repeat;
    for (const profile of (repeat % 2 ? ['minimal', 'full'] : ['full', 'minimal']) as Profile[]) out.push({
      key: `${group}-${profile}`, group, scene: scene as SceneId, profile, repeat, seed,
      stage: 'open-assets', kitKey: `${group}-${profile}`
    });
  }
  return out;
}

export function allowed(profile: Profile): string[] {
  return profile === 'full' ? FULL : [...CORE, ...(profile === 'minimal' ? [] : [profile])];
}
export function audit(code: string, profile: Profile): string[] {
  const names = new Set(allowed(profile)), calls: string[] = [];
  const source = ts.createSourceFile('plan.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === 'api') {
      const p = node.parent;
      if (ts.isParameter(p) && p.name === node && ts.isFunctionDeclaration(p.parent) && p.parent.name?.text === 'plan') return;
      if (!ts.isPropertyAccessExpression(p) || p.expression !== node) throw Error('indirect_api_access');
      if (profile === 'full' && ['TAU', 'PHI', 'seed', 'bounds'].includes(p.name.text)) return;
      if (!ts.isCallExpression(p.parent) || p.parent.expression !== p || !names.has(p.name.text)) throw Error(`api_not_available:${p.name.text}`);
      calls.push(p.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls;
}

export const REFERENCE = '空间结构参考（仅供组织关系，不规定几何外形）：建立一个可辨识的主核心、若干与它呼应的次级片段，以及从清晰到稀疏的过渡区域；让通路串联不同层次的观察位置，用间隔和空白表达遗忘。可改变轴线、形状和分布，不增加资产种类。';
export function systemPrompt(trial: Trial, mode: ModelGenerationMode, catalog = ''): string {
  const map = { ...createEmptyMap('API study', 'study-template', [96, 48, 96], mode, 'outdoor'), seed: trial.seed };
  const open = trial.stage === 'open-assets';
  let prompt = buildMapCodePlannerSystemPrompt(map, [], open ? 10 : 0, open ? 16 : 0, 'scene', 'generate', '', [], trial.profile === 'full' ? 'standard' : 'minimal');
  if (!['minimal', 'full'].includes(trial.profile)) {
    prompt = prompt.replace('The sandbox exposes exactly these 12 WorldForge APIs;', 'The sandbox exposes the following base APIs plus the additional API below;');
    prompt += '\nAdditional available API:\n' + EXTRA_API_DOCS[trial.profile as keyof typeof EXTRA_API_DOCS];
  }
  prompt = prompt.replace('- No reusable assets are available. Declare the assets you need with api.requireAsset.', open ? 'Declare new assets for this independent trial.' : 'Use only the shared catalog appended below.');
  return `${prompt}\n\nFrozen experiment contract: use direct api.method(...) calls only, no aliases or dynamic api access. No automatic spatial repair or model revision is run. Tool use is optional and is not a quality score. Use at most 512 placements; all visible subject content should use real supplied or generated assets. rotationY is degrees; facing is a direction. In [x,y,z], y is height. Ground objects use [x,z] or terrain:true with [x,0,z]. Keep loops bounded.\n${open
    ? 'Generate 10..16 distinct reusable asset families with variants:1. Asset models are generated by DeepSeek only. Family counts do not count random seed variations. Use api.asset(key) for generated bindings. An integrated complex roof may be one asset; do not replace a requested curved silhouette with a flat or triangular roof. Do not declare assets you never place.'
    : `No new asset generation in this arm: do not call requireAsset or asset. Use catalog id strings directly as place/attach/placeBetween assetId values. Reuse the shared families as appropriate; do not alter their models. Shared catalog (identical across this pair and its single-API arms):\n${catalog}`}`;
}

export const KIT_PROMPT = 'Design a neutral reusable asset kit for a map-layout comparison. Return only JSON {"requirements":[{"key":"id","name":"简短中文名","prompt":"description","dimensions":[width,height,depth],"role":"structure or environment"}]}. Choose exactly 12 distinct asset families for the user scene. Do not choose a placement API or write map coordinates. Fit the scene into 96x48x96 world units. Buildings may be whole assets; independently reusable connectors, supports and props may be separate. Preserve defining silhouettes, curved roofs and functional openings. No completed whole map or ground plane asset. Each prompt at most 450 characters, dimensions finite and positive. Y+ up, Z+ front, X+ right, centered horizontally with base at local Y=0. Do not prescribe a regular grid or a terrain layout. All geometry will be generated by DeepSeek.';
