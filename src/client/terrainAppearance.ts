import * as THREE from 'three';
import { sampleTerrainHeight, type EditableMap } from '../shared/map';
import { terrainSlopeDegrees } from '../shared/mapTerrainAnalysis';
import { visualZoneWeight, type VisualZoneTag } from '../shared/visualDirection';
import {DEFAULT_RUNTIME_ROAD_COLORS, type RuntimeGrassStyle, type RuntimeTerrainMaterialStyle} from '../shared/renderPlan';

const roadColorKeys = {'compacted-earth':'compactedEarthColor','garden-stone':'gardenStoneColor',asphalt:'asphaltColor',concrete:'concreteColor','brick-paver':'brickPaverColor',cobblestone:'cobblestoneColor',gravel:'gravelColor',mud:'mudColor'} as const;
export function terrainRecipeTextureColor(recipe: string, style: RuntimeTerrainMaterialStyle): string | undefined {
  if (!(recipe in roadColorKeys)) return undefined;
  const key = recipe as keyof typeof roadColorKeys;
  if (style.explicitRoadColors?.includes(key)) return '#ffffff';
  return style[roadColorKeys[key]] ?? DEFAULT_RUNTIME_ROAD_COLORS[key];
}

export function applyGrassGroundColor(base: THREE.Color, style: RuntimeGrassStyle, density: number, coverage: number,
  groundColor = new THREE.Color(style.groundColor).lerp(new THREE.Color(style.rootColor), style.groundColorExplicit ? 0 : 0.58)): THREE.Color {
  if (style.groundColorExplicit) {
    // Sparse blades still belong to the planned ground material. Only the
    // near-zero edge and semantic exclusions transition back to the terrain.
    const edge = clamp01(density / 0.05);
    return base.lerp(groundColor, edge * edge * (3 - 2 * edge) * coverage);
  }
  const weight = density * coverage;
  return base.lerp(groundColor, weight * weight * (3 - 2 * weight) * style.groundTintStrength);
}

const SAND_COLOR = new THREE.Color('#e6c77d');
const DRY_COLOR = new THREE.Color('#b89558');
const ROCK_COLOR = new THREE.Color('#8b857a');
const SOIL_COLOR = new THREE.Color('#8f704d');
const PAVING_COLOR = new THREE.Color('#aaa498');
const SNOW_COLOR = new THREE.Color('#edf3f7');
const GRASS_COLOR = new THREE.Color('#789255');
const FOREST_COLOR = new THREE.Color('#42643c');

export interface TerrainPaletteColors {
  base: string;
  dry: string;
  sand: string;
  soil: string;
  rock: string;
  paving: string;
  grass: string;
  foliage: string;
  water: string;
  settlement: string;
}

export type TerrainSurfaceWeightSampler = (x: number, z: number, tags: readonly VisualZoneTag[]) => number;

export function terrainVertexColor(
  map: EditableMap,
  x: number,
  y: number,
  z: number,
  palette?: TerrainPaletteColors,
  renderSurfaceHeight?: number,
  includeSnow = true,
  surfaceWeight?: TerrainSurfaceWeightSampler
): [number, number, number] {
  return createTerrainColorSampler(map, palette, includeSnow, surfaceWeight)(x, y, z, renderSurfaceHeight);
}

/** Reuse palette colors while baking a surface; no per-texel Color allocations. */
export function createTerrainColorSampler(
  map: EditableMap,
  palette?: TerrainPaletteColors,
  includeSnow = true,
  surfaceWeight?: TerrainSurfaceWeightSampler,
  materialStyle?: RuntimeTerrainMaterialStyle
): (x: number, y: number, z: number, renderSurfaceHeight?: number) => [number, number, number] {
  const floor = new THREE.Color(palette?.base ?? map.box.colors.floor);
  const base = new THREE.Color();
  const shore = new THREE.Color('#9c9470');
  const slopeColor = new THREE.Color('#777b74');
  const high = new THREE.Color('#c8cec4');
  const layers: Array<{ tags: VisualZoneTag[]; color: THREE.Color; strength: number }> = [
    { tags: ['grass'], color: new THREE.Color(palette?.grass ?? GRASS_COLOR), strength: 0.78 },
    { tags: ['forest'], color: new THREE.Color(palette?.foliage ?? FOREST_COLOR), strength: 0.84 },
    { tags: ['dry'], color: new THREE.Color(palette?.dry ?? DRY_COLOR), strength: 0.62 },
    { tags: ['rocky'], color: new THREE.Color(palette?.rock ?? ROCK_COLOR), strength: 0.88 },
    { tags: ['sand'], color: new THREE.Color(palette?.sand ?? SAND_COLOR), strength: 0.96 },
    { tags: ['snow'], color: SNOW_COLOR, strength: includeSnow ? 0.98 : 0 },
    { tags: ['soil'], color: new THREE.Color(palette?.soil ?? SOIL_COLOR), strength: 0.92 },
    { tags: ['paving'], color: new THREE.Color(palette?.paving ?? PAVING_COLOR), strength: 0.94 }
  ];
  const activeLayers = layers.filter(layer => layer.strength > 0
    && (surfaceWeight || map.visualSemantics.zones.some(zone => zone.tags.includes(layer.tags[0]))));
  const explicitRoads = map.visualSemantics.zones.flatMap(zone => {
    const recipe = zone.material as keyof typeof roadColorKeys;
    if (!materialStyle?.explicitRoadColors?.includes(recipe)) return [];
    return [{zone, color:new THREE.Color(materialStyle[roadColorKeys[recipe]] ?? DEFAULT_RUNTIME_ROAD_COLORS[recipe])}];
  });
  return (x, y, z, renderSurfaceHeight) => {
    const surfaceY = renderSurfaceHeight ?? sampleTerrainHeight(map, x, z);
    base.copy(floor);
    if (y < surfaceY - 0.05) return colorTuple(base.multiplyScalar(0.42));

    const heightRatio = Math.max(0, surfaceY) / Math.max(0.01, map.box.size[1]);
    const slope = terrainSlopeDegrees(map, x, z);
    if (surfaceY < 0.35) base.lerp(shore, clamp01((0.35 - surfaceY) / 0.7));
    if (slope > 24) base.lerp(slopeColor, clamp01((slope - 24) / 28));
    if (heightRatio > 0.58) base.lerp(high, clamp01((heightRatio - 0.58) / 0.28));
    for (const layer of activeLayers) {
      const weight = surfaceWeight ? surfaceWeight(x, z, layer.tags)
        : terrainSemanticSurfaceWeight(map, x, z, layer.tags);
      base.lerp(layer.color, weight * layer.strength);
    }
    for (const road of explicitRoads) base.lerp(road.color, visualZoneWeight(road.zone, x, z));
    return colorTuple(base);
  };
}

export function terrainSemanticSurfaceWeight(
  map: Pick<EditableMap, 'visualSemantics'>,
  x: number,
  z: number,
  tags: readonly VisualZoneTag[]
): number {
  let weight = 0;
  for (const zone of map.visualSemantics.zones) {
    if (!tags.some((tag) => zone.tags.includes(tag))) continue;
    weight = Math.max(weight, visualZoneWeight(zone, x, z));
  }
  return clamp01(weight);
}

function colorTuple(color: THREE.Color): [number, number, number] {
  return [color.r, color.g, color.b];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
