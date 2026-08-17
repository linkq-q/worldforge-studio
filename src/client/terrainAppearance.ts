import * as THREE from 'three';
import { sampleTerrainHeight, type EditableMap } from '../shared/map';
import { terrainSlopeDegrees } from '../shared/mapTerrainAnalysis';
import { visualZoneWeight, type VisualZoneTag } from '../shared/visualDirection';

const SAND_COLOR = new THREE.Color('#e6c77d');
const DRY_COLOR = new THREE.Color('#b89558');
const ROCK_COLOR = new THREE.Color('#8b857a');
const SOIL_COLOR = new THREE.Color('#8f704d');
const PAVING_COLOR = new THREE.Color('#aaa498');

export function terrainVertexColor(map: EditableMap, x: number, y: number, z: number): [number, number, number] {
  const surfaceY = sampleTerrainHeight(map, x, z);
  const base = new THREE.Color(map.box.colors.floor);
  if (y < surfaceY - 0.05) return colorTuple(base.multiplyScalar(0.42));

  const heightRatio = Math.max(0, surfaceY) / Math.max(0.01, map.box.size[1]);
  const slope = terrainSlopeDegrees(map, x, z);
  if (surfaceY < 0.35) base.lerp(new THREE.Color('#9c9470'), clamp01((0.35 - surfaceY) / 0.7));
  if (slope > 24) base.lerp(new THREE.Color('#777b74'), clamp01((slope - 24) / 28));
  if (heightRatio > 0.58) base.lerp(new THREE.Color('#c8cec4'), clamp01((heightRatio - 0.58) / 0.28));
  base.lerp(DRY_COLOR, terrainSemanticSurfaceWeight(map, x, z, ['dry']) * 0.62);
  base.lerp(ROCK_COLOR, terrainSemanticSurfaceWeight(map, x, z, ['rocky']) * 0.88);
  base.lerp(SAND_COLOR, terrainSemanticSurfaceWeight(map, x, z, ['sand']) * 0.96);
  base.lerp(SOIL_COLOR, terrainSemanticSurfaceWeight(map, x, z, ['soil']) * 0.92);
  base.lerp(PAVING_COLOR, terrainSemanticSurfaceWeight(map, x, z, ['paving']) * 0.94);
  return colorTuple(base);
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
