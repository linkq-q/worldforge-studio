// 农庄配色 v2：按反馈修正——金属走冷色并写 metalness、窝棚砖顶/木身反差、
// 植物换更鲜活的绿并按节点 hash 打散（告别一片黄绿）、清除水井等模型里
// 违和的绿色、图库里的"白化"动物恢复自然毛色。
// 全部目标色仍取自曼德鸭色卡 palette-2b9c0834。
//
//   node scripts/recolorFarmAssetsV2.mjs --dry-run
//   node scripts/recolorFarmAssetsV2.mjs            # backup + apply

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const dryRun = process.argv.includes('--dry-run');

const MAP_ID = 'map-0c71bd9e-2018-4672'; // 农庄
const ASSET_DIR = join(ROOT, 'data/map-editor/assets');
const PALETTE_PATH = join(ROOT, 'data/map-editor/color-palettes/palette-2b9c0834-be76-4477.json');

// ---------- Lab helpers ----------
function rgb(hex) {
  const v = Number.parseInt(hex.slice(1), 16);
  return [v >> 16 & 0xff, v >> 8 & 0xff, v & 0xff];
}
function lab(hex) {
  let [r, g, b] = rgb(hex).map((c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const labCache = new Map();
const labOf = (hex) => { if (!labCache.has(hex)) labCache.set(hex, lab(hex)); return labCache.get(hex); };
const dist = (a, b) => {
  const l = labOf(a), r = labOf(b);
  return (l[0] - r[0]) ** 2 + (l[1] - r[1]) ** 2 + (l[2] - r[2]) ** 2;
};
const toHex = (n) => '#' + n.toString(16).padStart(6, '0').toUpperCase();
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

// ---------- palette pools ----------
const palette = JSON.parse(readFileSync(PALETTE_PATH, 'utf8'));
const ALL = palette.colors.map((c) => c.hex.toUpperCase());
const POOLS = {
  // 冷色金属：色卡中最深的青蓝系
  metal: ['#499D92', '#4BAFCA', '#74C4BB', '#45BDF6'],
  // 砖屋顶：红褐砖 + 琥珀陶瓦，和木主体拉开反差
  roofBrick: ['#B84A27', '#A96F05', '#714D48', '#9E7A55'],
  trim: palette.roles['building.trim'],                       // 木件棕
  window: palette.roles['building.window'],
  road: palette.roles['terrain.road'],
  rock: palette.roles['terrain.rock'],
  grass: ['#E4E77F', '#C6CC97', '#DEE5BC', '#D1B825'],        // 干草/稻草偏黄
  // 鲜活 foliage：只用色卡里最绿的三档，避开黄绿
  foliage: ['#76904C', '#809712', '#5F6F48'],
  water: palette.roles.water,
  lighting: palette.roles.lighting,
  effect: palette.roles.effect,
  blossom: ['#FFD2BA', '#FFB08A', '#FF8A5B', '#F1AD69'],
  aubergine: ['#8E664D', '#714D48', '#52362E']
};
const GREEN_SET = new Set([
  ...palette.roles['vegetation.grass'], ...palette.roles['vegetation.foliage'],
  '#D1B825', '#9C8510', '#F1F5AF', '#DCDB22'
]);

// 在池内按与源色的距离排序后，用节点 hash 在前 K 名里挑一个 → 同类部件颜色有变化
function varied(from, pool, key, k = 3) {
  const ranked = [...pool].sort((a, b) => dist(a, from) - dist(b, from));
  return ranked[hash(key) % Math.min(k, ranked.length)];
}

// ---------- 场景物件分类（最近命名父组 + tags） ----------
const tagText = (node) => (Array.isArray(node.tags) ? node.tags : [])
  .map((t) => (t && typeof t === 'object' ? `${t.tag}=${t.value}` : String(t))).join(' ');

const PLANT_ASSET = /植株|树|藤|苗|草|菜|花|瓜|甘蓝|甜菜|萝卜|玉米|向日葵|葡萄|干草|堆肥|田埂/;

function classifyScene(a, n, g, t) {
  const s = `${n} ${g}`;
  if (/water=/.test(t)) return 'water';
  if (/emissive=/.test(t) || /吊灯|灯泡|灯罩|前灯|灯光|lantern|headlight/.test(s)) return 'lighting';
  if (/灯柱|post/.test(s)) return 'metal';                      // 路灯柱 → 冷色金属
  if (/base=glass/.test(t)) return 'window';
  if (/窗板/.test(s)) return 'trim';
  if (/窗|玻璃/.test(s)) return 'window';
  if (/屋顶|瓦顶|棚顶|板顶|压顶|瓦|烟囱|cap_tiles/.test(s)) return 'roofBrick';
  if (/鸡冠|肉垂|领巾/.test(s)) return 'comb';
  if (/喙|爪|蹼/.test(s)) return 'beak';
  if (/紫色叶球|紫甘蓝|甘蓝|葡萄串/.test(s)) return 'aubergine';
  if (/青草莓|未熟|苞叶/.test(s)) return 'foliage';
  if (/胡萝卜根/.test(s)) return 'carrot';
  if (/甜菜根冠/.test(s)) return 'beet';
  if (/成熟草莓|成熟果|辣椒果实|橙子|苹果|农产品|produce/.test(s)) return 'effect';
  if (/香蕉/.test(a)) return 'lighting';
  if (/桃子|花朵/.test(s)) return 'blossom';
  if (/雄穗|花盘|玉米穗/.test(s)) return 'lighting';
  if (/稻草|干草|草束|草料|hay|straw/.test(s)) return 'grass';
  if (/foliage=|vegetation=/.test(t)) return 'foliage';
  if (/叶|苔藓|植物|青菜/.test(s)) return 'foliage';
  if (/主根|树干|树枝|trunk/.test(s)) return 'trim';
  if (/嫩茎|主茎|花茎|茎秆|藤蔓?|攀枝|果枝/.test(s)) return 'foliage';
  if (/砖墙|brickwork/.test(s)) return 'effect';
  if (/base=stone/.test(t) || /毛石|墙基|基座|水盆|沥水板|门柱|围墙主体/.test(s)) return 'rock';
  if (/车身|车体|chassis/.test(s) || (/车架/.test(s) && !/木/.test(s))) return 'effect';
  if (/轮胎|橡胶|tire|车轮|前轮|后轮|wheel/.test(s)) return 'roofDark'; // 车轮/轮胎近黑，非金属
  if (/base=metal/.test(t) || /金属|铁|轮毂|水龙头|灯柱/.test(s)) return 'metal';
  if (/base=fur|base=fabric/.test(t)) return null;
  if (/base=wood/.test(t) || /木|柱|门|栅栏|框|梁|杆|棚架|柄|把手|凳|梯|辘轳|水桶|巢箱|支腿|坡道|栖木|围栏|隔栏|门栏|木槛|板墙|支架|箱/.test(s)) return 'trim';
  if (/磨痕|泥土|种植垄|堆肥/.test(s) || /田埂|堆肥/.test(a)) return 'road';
  if (/干草堆/.test(a)) return 'grass';
  if (/青菜/.test(a)) return 'foliage';
  return null;
}

POOLS.roofDark = ['#52362E', '#714D48'];

// ---------- 动物配色 ----------
function classifyAnimal(kind, g) {
  if (/鸡冠|肉垂/.test(g)) return 'combRed';
  if (/眼/.test(g)) return 'eyeDark';
  if (kind === 'horse') {
    if (/尾|鬃/.test(g)) return 'tailDark';
    if (/腿/.test(g)) return 'legDark';
    return 'bodyBrown';
  }
  if (/喙|嘴|爪|蹼|足|腿/.test(g)) return 'beakAmber';
  if (kind === 'chick') return 'chickYellow';
  if (kind === 'dark') return /尾|翼/.test(g) ? 'tailDark' : 'bodyDark';
  if (kind === 'duck') return /翼|尾/.test(g) ? 'wingAccent' : 'whiteBody';
  if (kind === 'goose') return 'whiteBody'; // 鹅通体白羽，靠喙/蹼的橙黄提色
  if (kind === 'fish') return /鳍|尾/.test(g) ? 'finPale' : 'fishOrange';
  // chicken / horse default
  if (/尾/.test(g)) return 'tailDark';
  return 'bodyBrown';
}
const ANIMAL_POOLS = {
  combRed: ['#F06B3E', '#B84A27'],
  beakAmber: ['#F8BC44', '#F1AD69'],
  eyeDark: ['#52362E'],
  chickYellow: ['#FCD75F', '#F6E24B', '#FFE2A0'],
  whiteBody: ['#F8E8CF', '#FEF9EA', '#FDD8A3'],
  wingAccent: ['#4BAFCA', '#74C4BB', '#D99256'],
  fishOrange: ['#F1AD69', '#F06B3E', '#D99256'],
  finPale: ['#FFD2BA', '#FFB08A'],
  tailDark: ['#714D48', '#52362E'],
  legDark: ['#714D48', '#8E664D'],
  bodyDark: ['#52362E', '#714D48', '#8E664D'],
  bodyBrown: ['#B89269', '#D99256', '#9E7A55', '#8E664D', '#C9A06E']
};
const ANIMAL_KIND = [
  [/鸡雏|鸭雏|鹅雏|小鹅仔/, 'chick'],
  [/深色家鸭|深色土鸡|深色/, 'dark'],
  [/彩羽鸭/, 'duck'], [/彩羽母鸡/, 'chicken'],
  [/家鸭|鸭/, 'duck'], [/鹅/, 'goose'],
  [/鱼/, 'fish'], [/鸡/, 'chicken'], [/马/, 'horse']
];
// 只处理真实农场动物：名字必须含动物词，且不是玩偶/摆件/建筑/容器
const REAL_ANIMAL = /鸡|鸭|鹅|马|牛|羊|猪|兔|鱼/;
const NOT_REAL_ANIMAL = /玩偶|玩具|机械|雕像|木马|摇摇|摇摆|蜗牛|帽|瓶|窝|厩|棚|偶|盆/;

// ---------- 目标色计算 ----------
function targetFor(role, from, key) {
  const fromL = labOf(from)[0];
  switch (role) {
    case 'carrot': return '#F06B3E';
    case 'beet': return '#B84A27';
    case 'comb': return fromL >= 55 ? '#F06B3E' : '#B84A27';
    case 'beak': return '#F8BC44';
    case 'metal': return fromL < 40 ? '#499D92' : varied(from, POOLS.metal, key, 2);
    case 'roofBrick': return fromL >= 60 ? '#B84A27' : varied(from, POOLS.roofBrick, key);
    case 'roofDark': return varied(from, POOLS.roofDark, key, 2);
    case 'foliage': {
      if (fromL < 40) return null; // 深色小件（眼睛等）别变绿
      return varied(from, POOLS.foliage, key);
    }
    case 'grass': return varied(from, POOLS.grass, key);
    case 'effect': return fromL >= 55 ? '#F06B3E' : varied(from, POOLS.effect, key, 2);
    case 'lighting': return fromL < 40 ? null : varied(from, POOLS.lighting, key, 2);
    case 'water': return varied(from, POOLS.water, key, 2);
    case 'window': return varied(from, POOLS.window, key, 3);
    case 'rock': return varied(from, POOLS.rock, key);
    case 'road': return varied(from, POOLS.road, key);
    case 'trim': return varied(from, POOLS.trim, key);
    case 'blossom': return varied(from, POOLS.blossom, key, 2);
    case 'aubergine': return varied(from, POOLS.aubergine, key, 2);
    default: return null;
  }
}

// ---------- 处理一个资产文件（场景规则） ----------
let guardSkipped = 0;
function processAsset(asset, changes) {
  const nodes = asset.modelJson?.nodes ?? [];
  const byId = new Map(nodes.filter((n) => typeof n.id === 'string').map((n) => [n.id, n]));
  const groupNameOf = (node) => {
    let current = node;
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      if (current !== node && typeof current.name === 'string' && current.name) return current.name;
      current = typeof current.parent === 'string' ? byId.get(current.parent) : null;
    }
    return '';
  };
  const isPlant = PLANT_ASSET.test(asset.name ?? '');
  for (const node of nodes) {
    const owner = node.mesh && typeof node.mesh.color === 'number' ? node.mesh
      : typeof node.color === 'number' ? node : null;
    if (!owner) continue;
    const raw = owner.color;
    if (raw < 0 || raw > 0xffffff) continue;
    const from = toHex(raw);
    const group = groupNameOf(node);
    const key = `${asset.id}:${node.id}`;
    let role = classifyScene(asset.name ?? '', node.name ?? '', group, tagText(node));
    // 深色灯具外壳 → 冷色金属；深色的花盘中心等保持原色
    if (role === 'lighting' && labOf(from)[0] < 40) role = /灯|lantern/.test(group) ? 'metal' : null;
    let to = role ? targetFor(role, from, key) : null;
    let metal = role === 'metal';
    // 非植物资产里的绿色 → 违和（水井绿苔、绿水龙头等），按材质归位
    if (!to && isPlant === false && GREEN_SET.has(from)) {
      const tags = tagText(node);
      role = /base=metal/.test(tags) ? 'metal' : /base=wood/.test(tags) ? 'trim' : 'rock';
      to = targetFor(role, from, key);
      metal = role === 'metal';
    }
    if (!to) {
      const fallback = nearestAll(from);
      if (fallback !== from && Math.sqrt(dist(from, fallback)) >= 8) {
        to = fallback; // 色卡外的残留色（路灯青灰等）
      }
    }
    if (!to || to === from) continue;
    const dL = Math.abs(labOf(from)[0] - labOf(to)[0]);
    if (dL > 35) { guardSkipped += 1; continue; }
    if (!dryRun) {
      owner.color = Number.parseInt(to.slice(1), 16);
      if (metal && node.mesh) {
        node.mesh.material = { ...(node.mesh.material ?? {}), metalness: 0.78, roughness: 0.35 };
      }
    }
    changes.push({ from, to, reason: `${group || node.name || node.id}→${role ?? 'nearest'}${metal ? '+metal' : ''}` });
  }
}
const nearestAll = (hex) => {
  let best = ALL[0], bestDist = Infinity;
  for (const c of ALL) { const d = dist(c, hex); if (d < bestDist) { bestDist = d; best = c; } }
  return best;
};

// ---------- 处理一个动物资产 ----------
function processAnimal(asset, kind, changes) {
  const nodes = asset.modelJson?.nodes ?? [];
  const byId = new Map(nodes.filter((n) => typeof n.id === 'string').map((n) => [n.id, n]));
  const groupNameOf = (node) => {
    let current = node;
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      if (current !== node && typeof current.name === 'string' && current.name) return current.name;
      current = typeof current.parent === 'string' ? byId.get(current.parent) : null;
    }
    return '';
  };
  for (const node of nodes) {
    const owner = node.mesh && typeof node.mesh.color === 'number' ? node.mesh
      : typeof node.color === 'number' ? node : null;
    if (!owner) continue;
    const from = toHex(owner.color);
    const group = groupNameOf(node);
    const roleKey = classifyAnimal(kind, group || node.name || '');
    if (!roleKey) continue;
    const to = varied(from, ANIMAL_POOLS[roleKey], `${asset.id}:${node.id}`, ANIMAL_POOLS[roleKey].length);
    if (to === from) continue;
    if (Math.abs(labOf(from)[0] - labOf(to)[0]) > 45) { guardSkipped += 1; continue; }
    if (!dryRun) owner.color = Number.parseInt(to.slice(1), 16);
    changes.push({ from, to, reason: `${group}→${roleKey}` });
  }
}

// ---------- 主流程 ----------
const map = JSON.parse(readFileSync(join(ROOT, 'data/map-editor/maps', `${MAP_ID}.json`), 'utf8'));
const sceneAssetIds = new Set(map.objects.filter((o) => o.assetId).map((o) => o.assetId));

// 图库文件按全名索引（资产 id 可能是文件名的前缀）
const libFiles = readdirSync(ASSET_DIR).filter((f) => f.endsWith('.json'));
const fileFor = (id) => libFiles.find((f) => f === `${id}.json`) ?? libFiles.find((f) => f.startsWith(id));

// 图库中的真实动物（含未放进场景的）
const animalAssets = [];
for (const f of libFiles) {
  const asset = JSON.parse(readFileSync(join(ASSET_DIR, f), 'utf8'));
  const name = asset.name ?? '';
  if (!REAL_ANIMAL.test(name) || NOT_REAL_ANIMAL.test(name)) continue;
  const kind = ANIMAL_KIND.find(([re]) => re.test(name))?.[1];
  if (kind) animalAssets.push({ asset, kind, file: f });
}

const targets = new Map(); // file -> {asset, mode, kind}
for (const id of sceneAssetIds) {
  const f = fileFor(id);
  if (!f) { console.log('找不到资产文件:', id); continue; }
  targets.set(f, { mode: 'scene' });
}
for (const { file, kind } of animalAssets) {
  const prev = targets.get(file) ?? {};
  targets.set(file, { ...prev, mode: 'animal', kind });
}

if (!dryRun) {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const backupDir = join(ROOT, 'data/map-editor/backups', `recolor-farm-v2-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  for (const f of targets.keys()) copyFileSync(join(ASSET_DIR, f), join(backupDir, f));
  console.log(`已备份 ${targets.size} 个资产到 ${backupDir}`);
}

let changed = 0;
for (const [file, info] of targets) {
  const asset = JSON.parse(readFileSync(join(ASSET_DIR, file), 'utf8'));
  const changes = [];
  if (info.mode === 'animal') processAnimal(asset, info.kind, changes);
  else processAsset(asset, changes);
  if (!changes.length) continue;
  changed += 1;
  console.log(`\n${asset.name} [${info.mode}${info.kind ? ':' + info.kind : ''}]`);
  const agg = new Map();
  for (const c of changes) {
    const k = `${c.from}->${c.to}`;
    const e = agg.get(k) ?? { ...c, count: 0 };
    e.count += 1;
    agg.set(k, e);
  }
  for (const e of [...agg.values()].sort((a, b) => a.from.localeCompare(b.from))) {
    console.log(`  ${e.from} -> ${e.to} ×${e.count}  [${e.reason}]`);
  }
  if (!dryRun) writeFileSync(join(ASSET_DIR, file), JSON.stringify(asset, null, 1));
}
console.log(`\n${dryRun ? '[dry-run] ' : ''}共 ${changed} 个资产有调整，守卫拦截 ${guardSkipped} 处`);
