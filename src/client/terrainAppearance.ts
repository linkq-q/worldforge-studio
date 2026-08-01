import * as THREE from 'three';
import { sampleTerrainHeight, type EditableMap } from '../shared/map';
import { terrainSlopeDegrees } from '../shared/mapTerrainAnalysis';

export function terrainVertexColor(map: EditableMap, x: number, y: number, z: number): [number, number, number] {
  const surfaceY = sampleTerrainHeight(map, x, z);
  const base = new THREE.Color(map.box.colors.floor);
  if (y < surfaceY - 0.05) return colorTuple(base.multiplyScalar(0.42));

  const heightRatio = Math.max(0, surfaceY) / Math.max(0.01, map.box.size[1]);
  const slope = terrainSlopeDegrees(map, x, z);
  if (surfaceY < 0.35) base.lerp(new THREE.Color('#9c9470'), clamp01((0.35 - surfaceY) / 0.7));
  if (slope > 24) base.lerp(new THREE.Color('#777b74'), clamp01((slope - 24) / 28));
  if (heightRatio > 0.58) base.lerp(new THREE.Color('#c8cec4'), clamp01((heightRatio - 0.58) / 0.28));
  return colorTuple(base);
}

function colorTuple(color: THREE.Color): [number, number, number] {
  return [color.r, color.g, color.b];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
