import * as THREE from 'three';
import { sampleTerrainHeight, type EditableMap } from '../shared/map';
import { isPointInsidePlayableArea } from '../shared/mapLayout';
import { visualZoneWeight } from '../shared/visualDirection';

/** R: coverage, G: shallow wind-shaped relief, B: grain roughness. No geometry. */
export function createTerrainSnowTexture(map: EditableMap): THREE.DataTexture {
  const snow = map.visualSemantics.zones.filter(zone => zone.tags.includes('snow'));
  const exposed = map.visualSemantics.zones.filter(zone => zone.tags.includes('soil') || zone.tags.includes('paving'));
  const size = snow.length ? 512 : 1;
  const pixels = new Uint8Array(size * size * 4);
  const phase = (map.seed % 997) / 997 * Math.PI * 2;
  for (let row = 0; row < size; row += 1) {
    const z = ((row + 0.5) / size - 0.5) * map.box.size[2];
    for (let col = 0; col < size; col += 1) {
      const x = ((col + 0.5) / size - 0.5) * map.box.size[0];
      let coverage = 0;
      for (const zone of snow) coverage = Math.max(coverage, visualZoneWeight(zone, x, z));
      let road = 0;
      if (coverage > 0) for (const zone of exposed) road = Math.max(road, visualZoneWeight(zone, x, z));
      const warp = Math.sin(x * 0.19 + phase) * 1.6 + Math.sin(z * 0.24 - phase);
      const relief = 0.5 + Math.sin(x * 0.95 + z * 0.25 + warp) * 0.18
        + Math.sin(x * 1.9 + z * 0.35 + warp * 2) * 0.1 + Math.sin(z * 2.3 - x * 0.5) * 0.08;
      const grain = Math.sin(x * 39.7 + z * 17.3 + phase) * Math.sin(z * 41.1 - x * 13.7);
      const offset = (row * size + col) * 4;
      pixels[offset] = Math.round(coverage * (1 - road) * 255);
      pixels[offset + 1] = Math.round(relief * 255);
      pixels[offset + 2] = Math.round((0.5 + grain * 0.5) * 255);
      pixels[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.name = 'terrain-snow-coverage-relief';
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}


export const SNOW_LAYER_THICKNESS = 0.125;

/** One continuous skin with shared top vertices and side faces only at its boundary. */
export function buildTerrainSnowLayer(
  map: EditableMap,
  field: THREE.DataTexture,
  terrainMaterial: THREE.MeshStandardMaterial
): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null {
  if (field.image.width === 1 || map.sceneMode === 'indoor') return null;
  const textureSize = field.image.width;
  const data = field.image.data as Uint8Array;
  const nx = Math.min(256, Math.ceil(map.box.size[0] / 0.5));
  const nz = Math.min(256, Math.ceil(map.box.size[2] / 0.5));
  type Point = { x: number; z: number; mask: number; relief: number };
  const sample = (x: number, z: number): Point => {
    const col = Math.max(0, Math.min(textureSize - 1, Math.floor((x / map.box.size[0] + 0.5) * textureSize)));
    const row = Math.max(0, Math.min(textureSize - 1, Math.floor((z / map.box.size[2] + 0.5) * textureSize)));
    const offset = (row * textureSize + col) * 4;
    return { x, z, mask: isPointInsidePlayableArea(map.layout, map.box.size, x, z) ? data[offset] / 255 : 0,
      relief: data[offset + 1] / 255 };
  };
  const positions: number[] = [], colors: number[] = [], uvs: number[] = [], indices: number[] = [];
  const vertexIds = new Map<string, number>();
  const edges = new Map<string, { a: number; b: number; count: number }>();
  const vertex = (point: Point): number => {
    const key = `${point.x.toFixed(5)},${point.z.toFixed(5)}`;
    const known = vertexIds.get(key);
    if (known !== undefined) return known;
    const id = positions.length / 3;
    vertexIds.set(key, id);
    positions.push(point.x, sampleTerrainHeight(map, point.x, point.z) + SNOW_LAYER_THICKNESS, point.z);
    colors.push(0.76 + point.relief * 0.17, 0.84 + point.relief * 0.12, 0.92 + point.relief * 0.07);
    uvs.push(point.x / map.box.size[0] + 0.5, point.z / map.box.size[2] + 0.5);
    return id;
  };
  const triangle = (points: Point[]): void => {
    const clipped: Point[] = [];
    for (let i = 0; i < 3; i += 1) {
      const a = points[i], b = points[(i + 1) % 3];
      if (a.mask >= 0.5) clipped.push(a);
      if ((a.mask >= 0.5) !== (b.mask >= 0.5)) {
        const t = (0.5 - a.mask) / (b.mask - a.mask);
        clipped.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
          mask: 0.5, relief: a.relief + (b.relief - a.relief) * t });
      }
    }
    if (clipped.length < 3) return;
    const ids = clipped.map(vertex);
    for (let i = 1; i < ids.length - 1; i += 1) indices.push(ids[0], ids[i], ids[i + 1]);
    for (let i = 0; i < ids.length; i += 1) {
      const a = ids[i], b = ids[(i + 1) % ids.length];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const edge = edges.get(key);
      if (edge) edge.count += 1;
      else edges.set(key, { a, b, count: 1 });
    }
  };
  const grid: Point[] = [];
  for (let z = 0; z <= nz; z += 1) for (let x = 0; x <= nx; x += 1) {
    grid.push(sample((x / nx - 0.5) * map.box.size[0], (z / nz - 0.5) * map.box.size[2]));
  }
  for (let z = 0; z < nz; z += 1) for (let x = 0; x < nx; x += 1) {
    const a = z * (nx + 1) + x, b = a + 1, c = a + nx + 1, d = c + 1;
    triangle([grid[a], grid[c], grid[b]]);
    triangle([grid[b], grid[c], grid[d]]);
  }
  if (!indices.length) return null;
  for (const { a, b, count } of edges.values()) {
    if (count !== 1) continue;
    const start = positions.length / 3;
    for (const [id, drop] of [[a, 0], [b, 0], [a, SNOW_LAYER_THICKNESS], [b, SNOW_LAYER_THICKNESS]]) {
      positions.push(positions[id * 3], positions[id * 3 + 1] - drop, positions[id * 3 + 2]);
      colors.push(0.7, 0.79, 0.87);
      uvs.push(uvs[id * 2], uvs[id * 2 + 1]);
    }
    indices.push(start, start + 2, start + 1, start + 1, start + 2, start + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Textures remain owned by the terrain; the layer owns only its geometry and material.
  const mesh = new THREE.Mesh(geometry, terrainMaterial.clone());
  mesh.name = 'terrain-snow-layer';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.thickness = SNOW_LAYER_THICKNESS;
  return mesh;
}
