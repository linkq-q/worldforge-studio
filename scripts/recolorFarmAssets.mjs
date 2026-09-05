// Recolor the 农庄 (farm) map's assets onto the Manduck palette, role-aware.
// Fixes: cream/ivory fruits & scarecrow scarf, tan tree trunks, off-palette
// teal lamppost, all-beige tractor — by mapping each colored node into the
// palette role pool that matches its semantics. Mesh nodes are unnamed
// (m0..mN), so roles come from the NEAREST NAMED ANCESTOR group (成熟橙子,
// 鸡冠, 砖墙…) plus part tags (base=wood, foliage=leaf, water=pool…).
// Within a pool the nearest (CIE76) color is chosen so per-part light/dark
// shading survives; accent "effect" picks pop to #F06B3E for light sources.
// A guard rejects remaps that flip light<->dark or are barely visible.
//
// Usage:
//   node scripts/recolorFarmAssets.mjs --dry-run   # report only
//   node scripts/recolorFarmAssets.mjs             # backup + apply

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const dryRun = process.argv.includes('--dry-run');

const MAP_ID = 'map-0c71bd9e-2018-4672'; // 农庄
const MAP_PATH = join(ROOT, 'data/map-editor/maps', `${MAP_ID}.json`);
const ASSET_DIR = join(ROOT, 'data/map-editor/assets');
const PALETTE_PATH = join(ROOT, 'data/map-editor/color-palettes/palette-2b9c0834-be76-4477.json');

// ---------- Lab helpers (same metric as adaptAssetsToPalette.mjs) ----------
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

// ---------- palette + role pools ----------
const palette = JSON.parse(readFileSync(PALETTE_PATH, 'utf8'));
const ALL = palette.colors.map((c) => c.hex.toUpperCase());
const POOLS = {
  roof: palette.roles['building.roof'],
  trim: palette.roles['building.trim'],
  window: palette.roles['building.window'],
  road: palette.roles['terrain.road'],
  rock: palette.roles['terrain.rock'],
  grass: palette.roles['vegetation.grass'],
  foliage: palette.roles['vegetation.foliage'],
  water: palette.roles.water,
  lighting: palette.roles.lighting,
  effect: palette.roles.effect
};
// warm pinks/soft oranges for blossom & peach-type fruit
POOLS.blossom = ['#FFD2BA', '#FFB08A', '#FF8A5B', '#F1AD69', '#D99256'];
// dark aubergine stand-in for purple crops (palette has no true purple)
POOLS.aubergine = ['#8E664D', '#714D48', '#52362E'];

const EFFECT_POP = '#F06B3E'; // accent red-orange for currently-pale accents
const nearest = (hex, pool) => {
  let best = pool[0], bestDist = Infinity;
  for (const candidate of pool) {
    const d = dist(candidate, hex);
    if (d < bestDist) { bestDist = d; best = candidate; }
  }
  return best;
};

// ---------- role classification ----------
const tagText = (node) => (Array.isArray(node.tags) ? node.tags : [])
  .map((t) => (t && typeof t === 'object' ? `${t.tag}=${t.value}` : String(t))).join(' ');

// g = nearest named ancestor group, n = own name, t = own tags, a = asset name
function classify(a, n, g, t) {
  const s = `${n} ${g}`;

  if (/water=/.test(t)) return 'water';
  if (/emissive=/.test(t) || /吊灯|灯泡|灯罩|前灯|灯光|lantern|headlight/.test(s)) return 'lighting';
  if (/灯柱|post/.test(s)) return 'roof';
  if (/base=glass/.test(t)) return 'window';
  if (/窗板/.test(s)) return 'trim';
  if (/窗|玻璃/.test(s)) return 'window';
  if (/屋顶|瓦顶|棚顶|板顶|压顶|瓦|烟囱|cap_tiles/.test(s)) return 'roof';
  if (/鸡冠|肉垂|领巾/.test(s)) return 'comb';
  if (/喙|爪|蹼/.test(s)) return 'beak';
  if (/叶球|甘蓝/.test(s)) return 'aubergine';
  if (/葡萄串/.test(s)) return 'aubergine';
  if (/青草莓|未熟|苞叶/.test(s)) return 'foliage';
  if (/胡萝卜根/.test(s)) return 'carrot';
  if (/甜菜根冠/.test(s)) return 'beet';
  if (/成熟草莓|成熟果|辣椒果实|橙子|农产品|produce/.test(s)) return 'effect';
  if (/桃子/.test(s)) return 'blossom';
  if (/花朵/.test(s)) return 'blossom';
  if (/雄穗|花盘/.test(s)) return 'lighting';
  if (/玉米穗/.test(s)) return 'lighting';
  if (/稻草|干草|草束|草料|hay|straw/.test(s)) return 'grass';
  if (/foliage=|vegetation=/.test(t)) return 'foliage';
  if (/叶|苔藓|植物|青菜/.test(s)) return 'foliage';
  if (/主根|树干|树枝|trunk/.test(s)) return 'trim';
  if (/嫩茎|主茎|花茎|茎秆|藤蔓?|攀枝|果枝/.test(s)) return 'foliage';
  if (/砖墙|brickwork/.test(s)) return 'effect';
  if (/base=stone/.test(t) || /毛石|墙基|基座|水盆|沥水板|门柱|围墙主体/.test(s)) return 'rock';
  if (/车身|车体|chassis/.test(s) || (/车架/.test(s) && !/木/.test(s))) return 'effect';
  if (/车轮|轮胎|轮毂|tire|wheel|锻铁|黑铁|铁桶箍|铁铲|金属|水龙头/.test(s) || /base=metal/.test(t)) return 'roof';
  if (/base=fur|base=fabric/.test(t)) return null; // keep animal body / cloth
  if (/base=wood/.test(t) || /木|柱|门|栅栏|框|梁|杆|棚架|柄|把手|凳|梯|辘轳|水桶|巢箱|支腿|坡道|栖木|围栏|隔栏|门栏|木槛|板墙|支架|箱/.test(s)) return 'trim';
  if (/磨痕|泥土|种植垄|堆肥/.test(s) || /田埂|堆肥/.test(a)) return 'road';
  if (/干草堆/.test(a)) return 'grass';
  if (/青菜/.test(a)) return 'foliage';
  return null; // fall back to nearest palette color overall
}

// ---------- collect farm asset ids ----------
const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
const assetIds = [...new Set(map.objects.filter((o) => o.assetId).map((o) => o.assetId))];
console.log(`地图「${map.name}」引用 ${assetIds.length} 个资产`);

// ---------- backup ----------
if (!dryRun) {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const backupDir = join(ROOT, 'data/map-editor/backups', `recolor-farm-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  for (const id of assetIds) {
    const src = join(ASSET_DIR, `${id}.json`);
    if (existsSync(src)) copyFileSync(src, join(backupDir, `${id}.json`));
  }
  console.log(`已备份 ${assetIds.length} 个资产到 ${backupDir}`);
}

// ---------- walk & recolor ----------
const MAX_DL = 35;  // reject remaps that flip light<->dark
const MIN_DE = 8;   // skip cosmetic changes
let filesChanged = 0;
let guardSkipped = 0;
const grandTotal = new Map(); // from->to -> asset count
for (const id of assetIds) {
  const path = join(ASSET_DIR, `${id}.json`);
  const asset = JSON.parse(readFileSync(path, 'utf8'));
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
  const mapping = new Map(); // `${from}->${to}` -> {from, to, reason, count}
  const applyNode = (node) => {
    const owner = node.mesh && typeof node.mesh.color === 'number' ? node.mesh
      : typeof node.color === 'number' ? node : null;
    if (!owner) return;
    const raw = owner.color;
    if (raw < 0 || raw > 0xffffff) return;
    const from = toHex(raw);
    const group = groupNameOf(node);
    const role = classify(asset.name ?? '', node.name ?? '', group, tagText(node));
    const fromL = labOf(from)[0];
    let to;
    if (role === 'carrot') to = '#F06B3E';
    else if (role === 'beet') to = '#B84A27';
    else if (role === 'comb') to = fromL >= 55 ? '#F06B3E' : '#B84A27';
    else if (role === 'beak') to = '#F8BC44';
    else if (role) {
      // dark parts stay dark in green pools (scarecrow eyes under 稻草头 etc.)
      if ((role === 'grass' || role === 'foliage') && fromL < 40) return;
      // dark lamp housing can't go bright yellow — route to dark browns
      const effectiveRole = role === 'lighting' && fromL < 40 ? 'roof' : role;
      to = nearest(from, POOLS[effectiveRole]);
      if (role === 'effect' && fromL >= 55) to = EFFECT_POP; // pale accent -> pop red
    } else {
      to = nearest(from, ALL);
    }
    if (to === from) return;
    const dL = Math.abs(fromL - labOf(to)[0]);
    const dE = Math.sqrt(dist(from, to));
    if (dL > MAX_DL || dE < MIN_DE) { guardSkipped += 1; return; }
    if (!dryRun) owner.color = Number.parseInt(to.slice(1), 16);
    const key = `${from}->${to}`;
    const entry = mapping.get(key) ?? { from, to, reason: `${group || node.name || node.id}→${role ?? 'nearest'}`, count: 0 };
    entry.count += 1;
    mapping.set(key, entry);
  };
  for (const node of nodes) applyNode(node);
  if (mapping.size === 0) continue;
  filesChanged += 1;
  console.log(`\n${asset.name} (${id})`);
  for (const { from, to, reason, count } of [...mapping.values()].sort((a, b) => a.from.localeCompare(b.from))) {
    console.log(`  ${from} -> ${to} ×${count}  [${reason}]`);
    const key = `${from}->${to}`;
    grandTotal.set(key, (grandTotal.get(key) ?? 0) + 1);
  }
  if (dryRun) continue;
  writeFileSync(path, JSON.stringify(asset, null, 1));
}

console.log(`\n${dryRun ? '[dry-run] ' : ''}共 ${filesChanged} 个资产有颜色调整，守卫拦截 ${guardSkipped} 处`);
console.log('\n汇总 (颜色对 -> 涉及资产数):');
for (const [pair, count] of [...grandTotal.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${pair}  ×${count}`);
}
