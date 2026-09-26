import { sampleTerrainHeight } from '../src/shared/map';
import { MapStore } from '../src/server/mapStore';

const map = await new MapStore().loadMap('map-6ab5b068-3dc3-45fb');
const pads = [] as Array<{ x: number; z: number; height: number; relief: number }>;
for (let x = -40; x <= 40; x += 4) for (let z = -40; z <= 40; z += 4) {
  const corners = [[-4, -3.5], [-4, 3.5], [4, -3.5], [4, 3.5]]
    .map(([dx, dz]) => sampleTerrainHeight(map, x + dx, z + dz));
  pads.push({ x, z, height: sampleTerrainHeight(map, x, z), relief: Math.max(...corners) - Math.min(...corners) });
}
const bands = [0, 2, 4, 6, 8, 10, 12, 14];
for (const band of bands) {
  const available = pads.filter(item => item.height >= band && item.height < band + 2 && item.relief <= 1);
  console.log(`${band}-${band + 2}m: ${available.length} candidate 8x7m centers with corner relief <=1m`);
  if (band >= 2) console.log(available.slice(0, 8).map(item => `(${item.x},${item.z})`).join(' '));
}
