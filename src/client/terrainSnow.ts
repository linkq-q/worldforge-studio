import * as THREE from 'three';
import type { EditableMap } from '../shared/map';
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
