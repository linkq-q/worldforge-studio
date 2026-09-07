// 农庄新资产润色（2026-09-06 批次）+ 水果正色 + 深木建筑屋顶统一 + 公园橡树副本。
//
//   1. 最新的 9 个模型（柿子树/松树/榆树/杨树/西红柿/大白菜/包菜/香蕉串/单根香蕉）
//      按 v2 约定润色：树干进棕、树冠进绿池按节点 hash 打散、果蔬更鲜活，
//      水果主体写 roughness≈0.45 的微蜡质光泽（makeMaterial 支持）。
//   2. 公园两棵古橡树（asset-e735a582 / asset-41e5b718，公园+森林营地共用，不动原件）
//      复制为农庄自有资产，配色模仿橘子树：树皮棕池 + 叶绿池，并补 base/foliage tags；
//      农庄地图里的 2 个对象改指副本。
//   3. 水果正色：香蕉→黄色系（色卡 lighting 黄），葡萄→紫色系（色卡无紫，按用户要求出色卡）。
//   4. 深木马厩/深木柴棚屋顶统一为砖红 #B84A27（v2 砖红顶 vs 木主体的约定）。
//
//   node scripts/polishFarmNewestAssets.mjs --dry-run
//   node scripts/polishFarmNewestAssets.mjs            # backup + apply

import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const dryRun = process.argv.includes('--dry-run');

const DATA_DIR = join(ROOT, 'data/map-editor');
const ASSET_DIR = join(DATA_DIR, 'assets');
const MAP_PATH = join(DATA_DIR, 'maps/map-0c71bd9e-2018-4672.json'); // 农庄

const toHex = (n) => '#' + n.toString(16).padStart(6, '0').toUpperCase();
const toInt = (hex) => Number.parseInt(hex.slice(1), 16);
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
// 池内按节点 hash 挑色 → 同类部件颜色有变化（同 v2 varied 的确定性）
const pick = (pool, key) => pool[hash(key) % pool.length];

const BARK = ['#8E664D', '#9E7A55', '#B89269'];          // 庄园树树干（橘子树同款）
const BARK_DARK = ['#714D48', '#8E664D', '#52362E'];     // 松树深色树皮
const LEAF = ['#76904C', '#809712', '#5F6F48', '#C6CC97']; // 庄园树绿叶池
const LEAF_PINE = ['#5F6F48', '#76904C', '#809712'];     // 松树偏深绿
const BANANA = ['#FCD75F', '#F6E24B'];                   // 香蕉黄
const BANANA_LIGHT = ['#FCEF72', '#FFF7A8'];             // 浅黄（原米白段）
const ROOF = '#B84A27';                                  // 砖红瓦顶

const GLOSS = { roughness: 0.45 }; // 水果微蜡质

const changes = []; // {file, log[]}

function loadAsset(id) {
  return JSON.parse(readFileSync(join(ASSET_DIR, `${id}.json`), 'utf8'));
}
function saveAsset(asset) {
  const log = asset.__log;
  delete asset.__log; // 不写进资产文件
  changes.push(log);
  if (!dryRun) writeFileSync(join(ASSET_DIR, `${asset.id}.json`), JSON.stringify(asset, null, 1));
}
function recolor(asset, nodeId, to, log, material) {
  const node = asset.modelJson.nodes.find((n) => n.id === nodeId);
  if (!node?.mesh) return;
  const from = toHex(node.mesh.color);
  if (from === to && !material) return;
  node.mesh.color = toInt(to);
  if (material) node.mesh.material = { ...(node.mesh.material ?? {}), ...material };
  log.push(`  ${nodeId} ${from} -> ${to}${material ? ' +gloss' : ''}`);
}

// ---------- 1a. 四棵新树 ----------
function polishTree(id, barkPool, leafPool) {
  const a = loadAsset(id);
  const log = (a.__log = { file: `${id}.json`, name: a.name, log: [] });
  for (const n of a.modelJson.nodes) {
    if (!n.mesh) continue;
    const tags = (n.tags ?? []).map((t) => `${t.tag}=${t.value}`).join(' ');
    const key = `${id}:${n.id}`;
    if (/base=wood/.test(tags)) recolor(a, n.id, pick(barkPool, key), log.log);
    else if (/foliage=leaf/.test(tags)) recolor(a, n.id, pick(leafPool, key), log.log);
  }
  saveAsset(a);
}

// ---------- 1b. 蔬菜 ----------
function polishVegetables() {
  // 西红柿：果身砖红→亮橙红，顶面→橘粉高光，底盘保留深色当阴影
  const tomato = loadAsset('asset-4a5228b4-daf8-47e7');
  tomato.__log = { file: 'asset-4a5228b4-daf8-47e7.json', name: tomato.name, log: [] };
  for (const id of ['m0', 'm1', 'm2']) recolor(tomato, id, '#F06B3E', tomato.__log.log, GLOSS);
  recolor(tomato, 'm4', '#FF8A5B', tomato.__log.log, GLOSS);
  saveAsset(tomato);

  // 大白菜：外叶绿池打散，菜心米白→嫩黄绿
  const cab = loadAsset('asset-8a1f226f-5474-4840');
  cab.__log = { file: 'asset-8a1f226f-5474-4840.json', name: cab.name, log: [] };
  for (const n of cab.modelJson.nodes) {
    if (!n.mesh) continue;
    const from = toHex(n.mesh.color);
    if (from === '#AEAF6F') recolor(cab, n.id, pick(['#76904C', '#809712', '#AEAF6F'], `${cab.id}:${n.id}`), cab.__log.log);
    else if (from === '#E9DABD') recolor(cab, n.id, '#F1F5AF', cab.__log.log);
  }
  saveAsset(cab);

  // 包菜：橄榄绿→鲜绿池打散
  const round = loadAsset('asset-8ce386d5-ed30-42c3');
  round.__log = { file: 'asset-8ce386d5-ed30-42c3.json', name: round.name, log: [] };
  for (const n of round.modelJson.nodes) {
    if (!n.mesh || toHex(n.mesh.color) !== '#AEAF6F') continue;
    recolor(round, n.id, pick(['#809712', '#76904C', '#C6CC97'], `${round.id}:${n.id}`), round.__log.log);
  }
  saveAsset(round);
}

// ---------- 3. 水果正色 ----------
function polishFruits() {
  // 香蕉串：橄榄绿段+米白段→黄色系，小蒂/梗→棕
  const bunch = loadAsset('asset-5ab0f336-1b43-48ed');
  bunch.__log = { file: 'asset-5ab0f336-1b43-48ed.json', name: bunch.name, log: [] };
  for (const n of bunch.modelJson.nodes) {
    if (!n.mesh) continue;
    const from = toHex(n.mesh.color);
    const key = `${bunch.id}:${n.id}`;
    if (from === '#AEAF6F') recolor(bunch, n.id, pick(BANANA, key), bunch.__log.log, GLOSS);
    else if (from === '#E9DABD') recolor(bunch, n.id, pick(BANANA_LIGHT, key), bunch.__log.log, GLOSS);
    else if (from === '#9C8510') recolor(bunch, n.id, '#8E664D', bunch.__log.log);
  }
  saveAsset(bunch);

  // 单根香蕉：果身→黄，两端→深黄，柄→棕，花端→深棕
  const single = loadAsset('asset-cd538b67-a8c9-4d88');
  single.__log = { file: 'asset-cd538b67-a8c9-4d88.json', name: single.name, log: [] };
  for (const id of ['m1', 'm2', 'm3']) recolor(single, id, '#FCD75F', single.__log.log, GLOSS);
  for (const id of ['m0', 'm4']) recolor(single, id, '#F8BC44', single.__log.log, GLOSS);
  recolor(single, 'm5', '#8E664D', single.__log.log);
  recolor(single, 'm6', '#52362E', single.__log.log);
  saveAsset(single);

  // 一串葡萄：棕色果粒→紫双色（色卡无紫，按用户要求出色卡），m12 果梗保持棕
  const grape = loadAsset('asset-4868a376-be44-4761');
  grape.__log = { file: 'asset-4868a376-be44-4761.json', name: grape.name, log: [] };
  for (const n of grape.modelJson.nodes) {
    if (!n.mesh || n.id === 'm12') continue;
    const from = toHex(n.mesh.color);
    if (from === '#714D48') recolor(grape, n.id, '#5A3D7A', grape.__log.log, { roughness: 0.4 });
    else if (from === '#8E664D') recolor(grape, n.id, '#7E5CB0', grape.__log.log, { roughness: 0.4 });
  }
  saveAsset(grape);
}

// ---------- 4. 深木建筑屋顶统一 ----------
function unifyRoofs() {
  for (const [id, roofNodes] of [
    ['asset-439bdaeb-808d-4187', ['m18', 'm19', 'm20']],  // 深木柴棚·风化双坡瓦顶
    ['asset-cb994d97-708c-44e4', ['m55', 'm56', 'm57']]   // 深木马厩·双坡瓦顶
  ]) {
    const a = loadAsset(id);
    a.__log = { file: `${id}.json`, name: a.name, log: [] };
    for (const nodeId of roofNodes) recolor(a, nodeId, ROOF, a.__log.log);
    saveAsset(a);
  }
}

// ---------- 2. 公园橡树 → 农庄副本 ----------
function cloneOak(srcId, newName) {
  const src = loadAsset(srcId);
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = `asset-${randomUUID().slice(0, 13)}`;
  copy.name = newName;
  copy.modelJson.name = newName;
  copy.createdAt = copy.updatedAt = Date.now();
  const log = { file: `${copy.id}.json`, name: `${newName}（副本自 ${src.name}）`, log: [] };
  const nodes = copy.modelJson.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (!n.mesh) continue;
    const parent = byId.get(n.parent);
    const group = parent?.name ?? '';
    const [r, g, b] = [(n.mesh.color >> 16) & 0xff, (n.mesh.color >> 8) & 0xff, n.mesh.color & 0xff];
    const isLeaf = /canopy/i.test(group) || (!/trunk/i.test(group) && g > r);
    const key = `${copy.id}:${n.id}`;
    const from = toHex(n.mesh.color);
    n.mesh.color = toInt(pick(isLeaf ? LEAF : BARK, key));
    // 补庄园树木同款 tags，方便后续批处理分类
    n.tags = isLeaf
      ? [{ tag: 'foliage', value: 'leaf' }]
      : [{ tag: 'base', value: 'wood', variant: 'bark' }];
    log.log.push(`  ${n.id} ${from} -> ${toHex(n.mesh.color)} [${isLeaf ? 'leaf' : 'bark'}]`);
  }
  changes.push(log);
  if (!dryRun) writeFileSync(join(ASSET_DIR, `${copy.id}.json`), JSON.stringify(copy, null, 1));
  return copy.id;
}

function retargetMapObjects(map, idMap) {
  const log = { file: 'map-0c71bd9e-2018-4672.json', name: '农庄地图对象改指橡树副本', log: [] };
  for (const o of map.objects ?? []) {
    if (o.assetId && idMap.has(o.assetId)) {
      log.log.push(`  object ${o.id}: ${o.assetId} -> ${idMap.get(o.assetId)}`);
      o.assetId = idMap.get(o.assetId);
    }
  }
  changes.push(log);
}

// ---------- 主流程 ----------
const TARGETS = [
  'asset-12a46459-1378-4616', 'asset-6caee4e9-cf6c-4c1d', 'asset-2f3a3dc5-1dda-4a49', 'asset-abd5e9e8-1dc6-4a8b',
  'asset-4a5228b4-daf8-47e7', 'asset-8a1f226f-5474-4840', 'asset-8ce386d5-ed30-42c3',
  'asset-5ab0f336-1b43-48ed', 'asset-cd538b67-a8c9-4d88', 'asset-4868a376-be44-4761',
  'asset-439bdaeb-808d-4187', 'asset-cb994d97-708c-44e4'
];

if (!dryRun) {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const backupDir = join(DATA_DIR, 'backups', `polish-farm-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  for (const id of TARGETS) copyFileSync(join(ASSET_DIR, `${id}.json`), join(backupDir, `${id}.json`));
  copyFileSync(MAP_PATH, join(backupDir, 'map-0c71bd9e-2018-4672.json'));
  console.log(`已备份 ${TARGETS.length} 个资产 + 农庄地图到 ${backupDir}`);
}

polishTree('asset-12a46459-1378-4616', BARK, LEAF);       // 柿子树
polishTree('asset-6caee4e9-cf6c-4c1d', BARK_DARK, LEAF_PINE); // 松树
polishTree('asset-2f3a3dc5-1dda-4a49', BARK, LEAF);       // 榆树
polishTree('asset-abd5e9e8-1dc6-4a8b', BARK, LEAF);       // 杨树
polishVegetables();
polishFruits();
unifyRoofs();

const oakIds = new Map([
  ['asset-e735a582-3cb8-4a78', cloneOak('asset-e735a582-3cb8-4a78', '古橡树·宽冠')],
  ['asset-41e5b718-9c9a-43e5', cloneOak('asset-41e5b718-9c9a-43e5', '古橡树·斜干')]
]);
const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
retargetMapObjects(map, oakIds);
if (!dryRun) writeFileSync(MAP_PATH, JSON.stringify(map, null, 1));

for (const c of changes) {
  if (!c.log.length) continue;
  console.log(`\n${c.name} (${c.file})`);
  for (const line of c.log) console.log(line);
}
console.log(`\n${dryRun ? '[dry-run] ' : ''}完成，${changes.filter((c) => c.log.length).length} 个文件有调整`);
