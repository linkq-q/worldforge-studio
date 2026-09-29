import * as THREE from 'three';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildEditableMapGroup } from '../src/client/mapRenderer';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE, type RuntimeTerrainMaterialStyle } from '../src/shared/renderPlan';

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => null })
  });
});

afterEach(() => vi.unstubAllGlobals());

type CanvasCommand = { method: string; args: number[]; color: unknown; alpha: number };

function recordCanvases(): void {
  vi.stubGlobal('document', {
    createElement: () => {
      const commands: CanvasCommand[] = [];
      const state: Record<PropertyKey, unknown> = { globalAlpha: 1 };
      const stack: Array<Record<PropertyKey, unknown>> = [];
      const paint = (method: string, args: number[]) => commands.push({
        method, args, color: state[method.startsWith('stroke') ? 'strokeStyle' : 'fillStyle'],
        alpha: Number(state.globalAlpha)
      });
      const context = new Proxy({
        save: () => stack.push({ ...state }),
        restore: () => Object.assign(state, stack.pop() ?? {}),
        createRadialGradient: () => ({ addColorStop: () => undefined }),
        fill: () => paint('fill', []), stroke: () => paint('stroke', []),
        fillRect: (...args: number[]) => paint('fillRect', args),
        strokeRect: (...args: number[]) => paint('strokeRect', args),
        ellipse: (...args: number[]) => paint('ellipse', args)
      }, {
        get: (target, key) => key in target ? Reflect.get(target, key) : state[key] ?? (() => undefined),
        set: (_target, key, value) => { state[key] = value; return true; }
      });
      return { width: 0, height: 0, commands, getContext: () => context };
    }
  });
}

function roadMap() {
  const map = applyMapOperations(createEmptyMap('road finish lifecycle'), [
    { type: 'terrain.surface', surface: 'paving', material: 'brick-paver',
      region: { kind: 'path', points: [[-10, -12], [10, -12]], width: 2 }, zoneId: 'narrow-bricks' },
    { type: 'terrain.surface', surface: 'paving', material: 'brick-paver',
      region: { kind: 'path', points: [[-10, -4], [10, -4]], width: 6 }, zoneId: 'wide-bricks' },
    { type: 'terrain.surface', surface: 'paving', material: 'cobblestone',
      region: { kind: 'path', points: [[-10, 5], [10, 5]], width: 4 }, zoneId: 'cobbles' },
    { type: 'terrain.surface', surface: 'paving', material: 'asphalt',
      region: { kind: 'path', points: [[-10, 12], [10, 12]], width: 3 }, zoneId: 'asphalt' }
  ]);
  map.seed = 73;
  return map;
}

function roadMeshes(rendered: Awaited<ReturnType<typeof buildEditableMapGroup>>) {
  return {
    terrain: rendered.group.getObjectByName('terrain') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>,
    bricks: rendered.group.getObjectByName('brick-road-surface:narrow-bricks') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>,
    stones: rendered.group.getObjectByName('road-bodies:cobblestone') as THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  };
}

function commands(texture: THREE.Texture | null): CanvasCommand[] {
  return (texture!.image as { commands: CanvasCommand[] }).commands;
}

function watchResources(rendered: Awaited<ReturnType<typeof buildEditableMapGroup>>) {
  const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
  const { terrain } = roadMeshes(rendered);
  for (const texture of [terrain.material.map, terrain.material.roughnessMap, terrain.material.bumpMap, terrain.material.normalMap]) {
    if (texture) resources.add(texture);
  }
  for (const name of ['road-material-bodies', 'road-surface-overlays']) {
    rendered.group.getObjectByName(name)!.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      resources.add(object.geometry);
      const material = object.material as THREE.MeshStandardMaterial;
      resources.add(material);
      for (const texture of [material.map, material.bumpMap, material.normalMap]) if (texture) resources.add(texture);
    });
  }
  return [...resources].map(resource => vi.spyOn(resource, 'dispose'));
}

function expectRoadColors(rendered: Awaited<ReturnType<typeof buildEditableMapGroup>>, style: RuntimeTerrainMaterialStyle) {
  const { terrain, bricks, stones } = roadMeshes(rendered);
  expect(bricks.material.color.getHexString()).toBe(style.brickPaverColor!.slice(1));
  expect(stones.material.color.getHexString()).toBe(style.cobblestoneColor!.slice(1));
  const terrainCommands = commands(terrain.material.map);
  for (const color of [style.brickPaverColor!, style.cobblestoneColor!, style.asphaltColor!]) {
    const rgb = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16));
    expect(terrainCommands.some(command => String(command.color).startsWith(`rgba(${rgb.join(',')},`))).toBe(true);
  }
}

it('applies, refreshes, and resets road finishes together without changing map semantics or leaking replaced resources', async () => {
  recordCanvases();
  const map = roadMap();
  const before = JSON.stringify(map);
  const rendered = await buildEditableMapGroup(map);
  const style = { ...DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE,
    brickPaverColor: '#abc4d8', cobblestoneColor: '#8ca58b', asphaltColor: '#173b59',
    roadDetailStrength: 0.2, roadTextureScale: 0.75 };
  try {
    expectRoadColors(rendered, DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE);
    let disposed = watchResources(rendered);
    rendered.setTerrainMaterialStyle(style);
    disposed.forEach(spy => expect(spy).toHaveBeenCalledOnce());
    expectRoadColors(rendered, style);
    const { bricks, stones } = roadMeshes(rendered);
    expect(bricks.material.bumpScale).toBeCloseTo(0.007);
    expect(bricks.material.normalScale.x).toBeCloseTo(0.1);
    const initialMatrices = Array.from(stones.instanceMatrix.array);
    const initialUv = Array.from(bricks.geometry.getAttribute('uv').array);
    disposed = watchResources(rendered);
    rendered.refreshTerrain(map);
    disposed.forEach(spy => expect(spy).toHaveBeenCalledOnce());
    expectRoadColors(rendered, style);
    expect(Array.from(roadMeshes(rendered).stones.instanceMatrix.array)).toEqual(initialMatrices);
    expect(Array.from(roadMeshes(rendered).bricks.geometry.getAttribute('uv').array)).toEqual(initialUv);
    disposed = watchResources(rendered);
    rendered.setTerrainMaterialStyle(DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE);
    disposed.forEach(spy => expect(spy).toHaveBeenCalledOnce());
    expectRoadColors(rendered, DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE);
    expect(JSON.stringify(map)).toBe(before);
    disposed = watchResources(rendered);
    rendered.dispose();
    disposed.forEach(spy => expect(spy).toHaveBeenCalledOnce());
  } catch (error) {
    rendered.dispose();
    throw error;
  }
});

it('keeps brick world dimensions independent of road width and scales terrain cobble detail with the same finish', async () => {
  recordCanvases();
  const rendered = await buildEditableMapGroup(roadMap());
  try {
    const cobbleRadii: number[] = [];
    for (const roadTextureScale of [0.5, 1.5]) {
      rendered.setTerrainMaterialStyle({ ...DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE, roadTextureScale });
      for (const name of ['narrow-bricks', 'wide-bricks']) {
        const mesh = rendered.group.getObjectByName(`brick-road-surface:${name}`) as THREE.Mesh;
        const p = mesh.geometry.getAttribute('position');
        const uv = mesh.geometry.getAttribute('uv');
        const row = Array.from({ length: p.count / 5 - 1 }, (_, index) => index * 5)
          .find(index => p.getX(index) > -9 && p.getX(index + 5) < 9)!;
        const metresPerU = (p.getX(row + 5) - p.getX(row)) / (uv.getX(row + 5) - uv.getX(row));
        const metresPerV = Math.abs((p.getZ(row + 4) - p.getZ(row)) / (uv.getY(row + 4) - uv.getY(row)));
        // Four bricks per repeat along the road, three rows across it.
        expect(metresPerU / 4).toBeCloseTo(0.6 * roadTextureScale, 5);
        expect(metresPerV / 3).toBeCloseTo(0.35 * roadTextureScale, 5);
      }
      cobbleRadii.push(commands(roadMeshes(rendered).terrain.material.map).find(command => command.method === 'ellipse')!.args[2]);
    }
    expect(cobbleRadii[1] / cobbleRadii[0]).toBeCloseTo(3);
    rendered.setTerrainMaterialStyle({ ...DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE, roadDetailStrength: 0 });
    expect(rendered.group.getObjectByName('road-material-bodies')!.children).toHaveLength(0);
    const { terrain, bricks } = roadMeshes(rendered);
    expect(bricks.material.bumpScale).toBe(0);
    expect(bricks.material.normalScale.length()).toBe(0);
    expect(commands(terrain.material.map).filter(command => command.color === 'rgba(48, 52, 53, 0.4)')
      .every(command => command.alpha === 0)).toBe(true);
  } finally {
    rendered.dispose();
  }
});

it('renders cobblestones as shallow paving stones within their intended footprint', async () => {
  const map = applyMapOperations(createEmptyMap('cobblestone dimensions'), [{
    type: 'terrain.surface', surface: 'paving', material: 'cobblestone', intensity: 1,
    region: { kind: 'path', points: [[-20, 0], [20, 0]], width: 3 }, zoneId: 'stone-road'
  }]);
  map.seed = 73;
  const rendered = await buildEditableMapGroup(map);
  try {
    const bodies = rendered.modelsRoot.getObjectByName('road-material-bodies');
    expect(bodies?.children).toHaveLength(1);
    const stones = bodies?.children[0] as THREE.InstancedMesh;
    expect(stones.isInstancedMesh).toBe(true);
    expect(stones.count).toBeGreaterThan(20);
    stones.geometry.computeBoundingBox();
    const size = stones.geometry.boundingBox!.getSize(new THREE.Vector3());
    // A paving stone has a roughly 34 cm footprint and 12 cm thickness before variation.
    expect(size.x).toBeGreaterThan(0.3);
    expect(size.x).toBeLessThanOrEqual(0.34);
    expect(size.z).toBeGreaterThan(0.3);
    expect(size.z).toBeLessThanOrEqual(0.34);
    expect(size.y).toBeGreaterThan(0.1);
    expect(size.y).toBeLessThanOrEqual(0.12);

    const positions = stones.geometry.getAttribute('position');
    const matrix = new THREE.Matrix4();
    const vertex = new THREE.Vector3();
    const bounds = new THREE.Box3();
    for (let index = 0; index < stones.count; index += 1) {
      stones.getMatrixAt(index, matrix);
      bounds.makeEmpty();
      for (let point = 0; point < positions.count; point += 1) {
        bounds.expandByPoint(vertex.fromBufferAttribute(positions, point).applyMatrix4(matrix));
      }
      bounds.getSize(size);
      // Seeded scale and tilt must not turn the rendered stones back into large rubble.
      expect(Math.max(size.x, size.z)).toBeLessThan(0.41);
      expect(size.y).toBeLessThan(0.3);
    }
  } finally {
    rendered.dispose();
  }
});
