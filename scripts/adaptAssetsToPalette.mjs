// Adapt asset colors to the Manduck reference palette.
// Usage:
//   node scripts/adaptAssetsToPalette.mjs --dry-run          # report distance distribution
//   node scripts/adaptAssetsToPalette.mjs --threshold=2500   # apply (default 2500)
//
// Distance metric: CIE76 ΔE in Lab space. The app's own colorDistance()
// (weighted RGB + hue penalty) misbehaves for near-black colors whose hue
// is unstable — it mapped #080A0D device screens to bright cyan. Lab
// handles neutrals correctly.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MAP_IDS = ['map-ce3aecec-6688-48b9', 'map-c131ec2e-0354-4d1c']; // 房间-1, 房间-2
const ASSET_DIRS = ['assets/starter-data/assets', 'data/map-editor/assets'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const thresholdArg = args.find((a) => a.startsWith('--threshold='));
const THRESHOLD = thresholdArg ? Number(thresholdArg.split('=')[1]) : 400; // ΔE² = 20²

function rgb(hex) {
  const v = Number.parseInt(hex.slice(1), 16);
  return [v >> 16 & 0xff, v >> 8 & 0xff, v & 0xff];
}
function lab(hex) {
  let [r, g, b] = rgb(hex).map((c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  // sRGB D65 -> XYZ
  let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const labCache = new Map();
function labOf(hex) {
  if (!labCache.has(hex)) labCache.set(hex, lab(hex));
  return labCache.get(hex);
}
function colorDistance(a, b) {
  const l = labOf(a), r = labOf(b);
  return (l[0] - r[0]) ** 2 + (l[1] - r[1]) ** 2 + (l[2] - r[2]) ** 2; // ΔE²
}
const toHex = (n) => '#' + n.toString(16).padStart(6, '0').toUpperCase();
const fromHex = (hex) => Number.parseInt(hex.slice(1), 16);

// ---- load palette ----
const paletteDir = join(ROOT, 'assets/starter-data/color-palettes');
const paletteFile = join(paletteDir, 'palette-2b9c0834-be76-4477.json');
const palette = JSON.parse(readFileSync(paletteFile, 'utf8'));
const paletteHexes = palette.colors.map((c) => c.hex.toUpperCase());
console.log(`Palette "${palette.name}": ${paletteHexes.length} colors`);

// ---- collect asset ids from both maps ----
const assetIds = new Set();
for (const mapId of MAP_IDS) {
  const map = JSON.parse(readFileSync(join(ROOT, 'assets/starter-data/maps', `${mapId}.json`), 'utf8'));
  const text = JSON.stringify(map);
  for (const m of text.matchAll(/"assetId":\s*"(asset-[^"]+)"/g)) assetIds.add(m[1]);
}
console.log(`Maps reference ${assetIds.size} unique assets`);

// ---- nearest palette color cache ----
const nearestCache = new Map();
function nearest(sourceHex) {
  if (!nearestCache.has(sourceHex)) {
    let best = null, bestDist = Infinity;
    for (const hex of paletteHexes) {
      const d = colorDistance(hex, sourceHex);
      if (d < bestDist) { bestDist = d; best = hex; }
    }
    nearestCache.set(sourceHex, { hex: best, dist: bestDist });
  }
  return nearestCache.get(sourceHex);
}

// ---- walk assets ----
const changes = []; // {assetId, assetName, from, to, dist, count}
const distances = [];
let missing = 0;
for (const assetId of assetIds) {
  const path = join(ROOT, ASSET_DIRS[0], `${assetId}.json`);
  let asset;
  try {
    asset = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    missing += 1;
    continue;
  }
  const perColor = new Map(); // fromHex -> {to, dist, count}
  const stack = [asset.modelJson];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (typeof node.color === 'number' && Number.isInteger(node.color) && node.color >= 0 && node.color <= 0xffffff) {
      const from = toHex(node.color);
      const { hex: to, dist } = nearest(from);
      distances.push(dist);
      if (dist > THRESHOLD && to !== from) {
        const entry = perColor.get(from) ?? { to, dist, count: 0 };
        entry.count += 1;
        perColor.set(from, entry);
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === 'object') stack.push(value);
    }
  }
  for (const [from, entry] of perColor) {
    changes.push({ assetId, assetName: asset.name ?? assetId, from, ...entry });
  }
}
if (missing) console.log(`WARNING: ${missing} asset ids not found on disk`);

// ---- report (distances are ΔE²; display as ΔE) ----
distances.sort((a, b) => a - b);
const pct = (p) => Math.sqrt(distances[Math.min(distances.length - 1, Math.floor(distances.length * p))] ?? 0).toFixed(1);
console.log(`\nScanned ${distances.length} color fields, ${nearestCache.size} unique colors`);
console.log(`ΔE percentiles: p50=${pct(0.5)} p75=${pct(0.75)} p90=${pct(0.9)} p95=${pct(0.95)} p99=${pct(0.99)} max=${Math.sqrt(distances.at(-1) ?? 0).toFixed(1)}`);
const buckets = [0, 25, 100, 225, 400, 625, 900, 1600, Infinity];
console.log('Histogram (ΔE):');
for (let i = 0; i < buckets.length - 1; i++) {
  const n = distances.filter((d) => d >= buckets[i] && d < buckets[i + 1]).length;
  const lo = Math.sqrt(buckets[i]).toFixed(0);
  const hi = buckets[i + 1] === Infinity ? '∞' : Math.sqrt(buckets[i + 1]).toFixed(0);
  console.log(`  [${lo}, ${hi}): ${n}`);
}
console.log(`\nThreshold ΔE=${Math.sqrt(THRESHOLD).toFixed(1)}: ${changes.length} color groups across ${new Set(changes.map((c) => c.assetId)).size} assets would change`);
if (dryRun) {
  const top = [...changes].sort((a, b) => b.dist - a.dist).slice(0, 40);
  console.log('\nLargest deviations:');
  for (const c of top) console.log(`  ${c.assetName} (${c.assetId.slice(0, 17)}…): ${c.from} -> ${c.to}  ΔE=${Math.sqrt(c.dist).toFixed(1)}  parts=${c.count}`);
  process.exit(0);
}

// ---- apply ----
const changeByAsset = new Map();
for (const c of changes) {
  if (!changeByAsset.has(c.assetId)) changeByAsset.set(c.assetId, new Map());
  changeByAsset.get(c.assetId).set(c.from, c.to);
}
let filesWritten = 0;
for (const [assetId, mapping] of changeByAsset) {
  for (const dir of ASSET_DIRS) {
    const path = join(ROOT, dir, `${assetId}.json`);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch { continue; }
    // Replace only integer color fields, value-aware
    text = text.replace(/"color":\s*(\d+)/g, (match, num) => {
      const hex = toHex(Number(num));
      const target = mapping.get(hex);
      return target ? `"color": ${fromHex(target)}` : match;
    });
    writeFileSync(path, text);
    filesWritten += 1;
  }
}
console.log(`\nApplied: ${filesWritten} files written across ${ASSET_DIRS.length} stores`);
