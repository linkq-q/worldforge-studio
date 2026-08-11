/**
 * Deterministic natural grass placement.
 *
 * A low-frequency field creates broad clumps and clearings. A Halton candidate
 * sequence plus minimum-distance rejection removes the visible rows produced by
 * one-sample-per-cell grids. Each accepted anchor expands into a small tuft.
 */
export function collectGrassPlacements({
  layer,
  width,
  depth,
  cellSize,
  paletteVariation,
  maxInstances,
  sampleHeight,
  sampleNormal,
}) {
  const safeWidth = positive(width, 1);
  const safeDepth = positive(depth, 1);
  const spacing = positive(cellSize, 0.8);
  const budget = Math.max(0, Math.floor(finite(maxInstances, 0)));
  if (budget === 0) return [];

  const seed = Math.trunc(finite(layer?.seed, 1));
  const mix = normalizeMix(layer?.mix);
  const preset = normalizePreset(layer?.preset);
  const profile = PLACEMENT_PROFILES[preset];
  const anchorSpacing = spacing * 1.55 * profile.spacing;
  const minimumDistance = anchorSpacing * 0.45;
  const clusterScale = Math.max(spacing * 7, Math.min(safeWidth, safeDepth) * 0.09);
  const estimatedAnchors = Math.ceil((safeWidth * safeDepth) / (anchorSpacing * anchorSpacing));
  const candidateCount = Math.max(32, estimatedAnchors * 4);
  const sequenceStart = 1 + Math.floor(hash01(seed, 0, 131) * 4096);
  const offsetU = hash01(seed, 1, 149);
  const offsetV = hash01(seed, 2, 167);
  const anchorGrid = new Map();
  const placements = [];

  for (let candidateIndex = 0; candidateIndex < candidateCount && placements.length < budget; candidateIndex += 1) {
    const sequenceIndex = sequenceStart + candidateIndex;
    const u = fract(halton(sequenceIndex, 2) + offsetU);
    const v = fract(halton(sequenceIndex, 3) + offsetV);
    const anchorX = (u - 0.5) * safeWidth;
    const anchorZ = (v - 0.5) * safeDepth;
    const density = sampleLayerDensity(layer, u, v);
    if (density <= 0.001) continue;

    const cluster = clusterField(anchorX / clusterScale, anchorZ / clusterScale, seed);
    const patchWeight = mixNumber(profile.patchMin, profile.patchMax, smoothstep(0.2, 0.8, cluster));
    const acceptance = clamp(density * patchWeight, 0, 1);
    if (hash01(candidateIndex, seed, 191) > acceptance) continue;
    if (!acceptAnchor(anchorGrid, anchorX, anchorZ, minimumDistance)) continue;

    const tuftId = `${seed}:${candidateIndex}`;
    const tuftSize = profile.tuftMin + Math.floor(hash01(candidateIndex, seed, 211) * (profile.tuftMax - profile.tuftMin + 1));
    const tuftRadius = spacing * profile.radius * mixNumber(0.8, 1.2, hash01(candidateIndex, seed, 223));
    const tuftYaw = hash01(candidateIndex, seed, 227) * Math.PI * 2;
    const tuftScale = mixNumber(0.82, 1.18, hash01(candidateIndex, seed, 229));
    const hasFlower = hash01(candidateIndex, seed, 233) < mix.flowers;
    const leafyTotal = mix.short + mix.tall;
    const shortShare = leafyTotal > 0 ? mix.short / leafyTotal : 1;

    for (let bladeIndex = 0; bladeIndex < tuftSize && placements.length < budget; bladeIndex += 1) {
      const bladeHash = hash01(candidateIndex, bladeIndex, seed + 239);
      const angle = tuftYaw + bladeHash * Math.PI * 2;
      const radius = bladeIndex === 0
        ? 0
        : tuftRadius * Math.sqrt(hash01(candidateIndex, bladeIndex, seed + 241));
      const x = clamp(anchorX + Math.cos(angle) * radius, -safeWidth / 2, safeWidth / 2);
      const z = clamp(anchorZ + Math.sin(angle) * radius, -safeDepth / 2, safeDepth / 2);
      const variant = hasFlower && bladeIndex === 0
        ? 'flowers'
        : hash01(candidateIndex, bladeIndex, seed + 251) < shortShare ? 'short' : 'tall';
      const bladeScale = tuftScale * mixNumber(0.86, 1.14, hash01(candidateIndex, bladeIndex, seed + 257));

      placements.push({
        rank: hash01(candidateIndex, bladeIndex, seed + 263),
        tuftId,
        bladeIndex,
        x,
        y: Number(sampleHeight(x, z)) || 0,
        z,
        yaw: hash01(candidateIndex, bladeIndex, seed + 269) * Math.PI * 2,
        widthScale: bladeScale * profile.width * (variant === 'tall' ? 0.92 : variant === 'flowers' ? 0.8 : 1),
        heightScale: bladeScale * profile.height * (variant === 'tall' ? 1.28 : variant === 'flowers' ? 0.82 : 1),
        paletteScale: paletteScale(hash01(candidateIndex, bladeIndex, seed + 271), paletteVariation),
        flowerPalette: Math.floor(hash01(candidateIndex, bladeIndex, seed + 277) * 6),
        normal: normalizeNormal(sampleNormal(x, z)),
        variant,
      });
    }
  }

  return placements;
}

const PLACEMENT_PROFILES = Object.freeze({
  meadow: { spacing: 1, tuftMin: 2, tuftMax: 5, radius: 0.32, width: 1, height: 1, patchMin: 0.25, patchMax: 1.15 },
  sand: { spacing: 1.35, tuftMin: 1, tuftMax: 3, radius: 0.24, width: 0.8, height: 0.86, patchMin: 0.12, patchMax: 0.88 },
  wetland: { spacing: 0.9, tuftMin: 3, tuftMax: 6, radius: 0.38, width: 0.9, height: 1.12, patchMin: 0.38, patchMax: 1.18 },
  farm: { spacing: 0.62, tuftMin: 12, tuftMax: 20, radius: 0.42, width: 0.9, height: 1.04, patchMin: 0.9, patchMax: 1.3 },
  magic: { spacing: 0.96, tuftMin: 3, tuftMax: 6, radius: 0.46, width: 1, height: 1.08, patchMin: 0.2, patchMax: 1.2 },
  'alpine-moss': { spacing: 1.18, tuftMin: 1, tuftMax: 2, radius: 0.48, width: 1.25, height: 0.78, patchMin: 0.3, patchMax: 1.05 },
});

function normalizePreset(value) {
  return Object.prototype.hasOwnProperty.call(PLACEMENT_PROFILES, value) ? value : 'meadow';
}

function acceptAnchor(grid, x, z, minimumDistance) {
  const cellX = Math.floor(x / minimumDistance);
  const cellZ = Math.floor(z / minimumDistance);
  const minimumDistanceSq = minimumDistance * minimumDistance;
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const entries = grid.get(`${cellX + dx}:${cellZ + dz}`) || [];
      if (entries.some((entry) => squaredDistance(entry.x, entry.z, x, z) < minimumDistanceSq)) return false;
    }
  }
  const key = `${cellX}:${cellZ}`;
  const entries = grid.get(key) || [];
  entries.push({ x, z });
  grid.set(key, entries);
  return true;
}

function clusterField(x, z, seed) {
  const broad = valueNoise(x, z, seed + 307);
  const detail = valueNoise(x * 2.17 + 7.3, z * 2.17 - 4.1, seed + 331);
  return broad * 0.72 + detail * 0.28;
}

function valueNoise(x, z, seed) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smoothCurve(x - x0);
  const tz = smoothCurve(z - z0);
  const top = mixNumber(hash01(x0, z0, seed), hash01(x0 + 1, z0, seed), tx);
  const bottom = mixNumber(hash01(x0, z0 + 1, seed), hash01(x0 + 1, z0 + 1, seed), tx);
  return mixNumber(top, bottom, tz);
}

function halton(index, base) {
  let result = 0;
  let fraction = 1 / base;
  let value = index;
  while (value > 0) {
    result += fraction * (value % base);
    value = Math.floor(value / base);
    fraction /= base;
  }
  return result;
}

function sampleLayerDensity(layer, u, v) {
  const width = Math.max(1, Math.round(layer?.resolutionX || 1));
  const height = Math.max(1, Math.round(layer?.resolutionZ || 1));
  const x = clamp(u, 0, 1) * (width - 1);
  const z = clamp(v, 0, 1) * (height - 1);
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const x1 = Math.min(width - 1, x0 + 1);
  const z1 = Math.min(height - 1, z0 + 1);
  const tx = x - x0;
  const tz = z - z0;
  const values = layer?.densities || [];
  const top = mixNumber(Number(values[z0 * width + x0]) || 0, Number(values[z0 * width + x1]) || 0, tx);
  const bottom = mixNumber(Number(values[z1 * width + x0]) || 0, Number(values[z1 * width + x1]) || 0, tx);
  return clamp(mixNumber(top, bottom, tz), 0, 1);
}

function normalizeMix(value = {}) {
  const short = Math.max(0, finite(value.short, 0.7));
  const tall = Math.max(0, finite(value.tall, 0.2));
  const flowers = Math.max(0, finite(value.flowers, 0.1));
  const total = short + tall + flowers || 1;
  return { short: short / total, tall: tall / total, flowers: flowers / total };
}

function normalizeNormal(value) {
  const normal = Array.isArray(value) ? value : [value?.x, value?.y, value?.z];
  const x = finite(normal[0], 0);
  const y = finite(normal[1], 1);
  const z = finite(normal[2], 0);
  const length = Math.hypot(x, y, z);
  return length < 0.0001 ? [0, 1, 0] : [x / length, y / length, z / length];
}

function paletteScale(value, variation = 0.14) {
  const steps = [-1, -0.33, 0.33, 1];
  return 1 + steps[Math.min(steps.length - 1, Math.floor(value * steps.length))] * variation;
}

function hash01(x, z, seed) {
  let value = Math.imul(Math.trunc(x) + 0x9e3779b9, 0x85ebca6b)
    ^ Math.imul(Math.trunc(z) + Math.trunc(seed), 0xc2b2ae35);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return (value >>> 0) / 0xffffffff;
}

function squaredDistance(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function smoothCurve(value) {
  return value * value * (3 - 2 * value);
}

function smoothstep(edge0, edge1, value) {
  return smoothCurve(clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1));
}

function fract(value) {
  return value - Math.floor(value);
}

function finite(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback) {
  const parsed = finite(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mixNumber(a, b, t) {
  return a + (b - a) * t;
}
