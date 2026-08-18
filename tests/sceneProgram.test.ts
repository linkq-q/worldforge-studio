import { describe, expect, it } from 'vitest';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { executeSceneProgram, SCENE_PROGRAM_API_REFERENCE } from '../src/server/sceneProgram';

const asset = (id: string, name: string, tags: string[]): MapAsset => ({
  id,
  name,
  prompt: name,
  tags,
  modelJson: {},
  colliderPlan: {
    version: 1,
    boxes: [{ min: [-0.35, 0, -0.35], max: [0.35, 1, 0.35] }],
    sourceMeshCount: 1,
    candidateCount: 1,
    fallbackUsed: false
  },
  footprintRadius: 0.35,
  mode: 'asset',
  createdAt: 1,
  updatedAt: 1
});

const assets = [
  asset('bench-a', 'Park Bench', ['bench']),
  asset('crop-a', 'Corn Plant', ['crop']),
  asset('hall-a', 'Campus Hall', ['campus-building'])
];

describe('bounded scene program', () => {
  it('lets AI express a curved seaside park with path-relative furniture', () => {
    const result = executeSceneProgram(`
      const loop = scene.guide("seaside-loop", {
        points: [[-18,-4],[-10,7],[2,10],[15,5],[18,-5],[4,-9]],
        curve: "catmull-rom", closed: true, width: 2.5, tags: ["park", "walkway"]
      });
      scene.surface(loop, "sand", 0.7);
      scene.placeAlong("bench", loop, { spacing: 7, offset: 2.2, groupSize: 3 });
    `, createEmptyMap('park', 'program-park'), assets);

    expect(result.guideCount).toBe(1);
    expect(result.objectCount).toBeGreaterThan(4);
    expect(result.operations).toContainEqual(expect.objectContaining({ type: 'terrain.surface', surface: 'sand' }));
    const generated = applyMapOperations(createEmptyMap('park result'), result.operations);
    const region = generated.visualSemantics.zones.find((zone) => zone.id === 'scene-program:seaside-loop')?.region;
    expect(region?.kind).toBe('path');
    if (region?.kind === 'path') {
      expect(region.points.length).toBeLessThanOrEqual(64);
      expect(region.points.at(-1)).toEqual(region.points[0]);
    }
  });

  it('uses a for loop to turn a polygon into planted farm rows', () => {
    const result = executeSceneProgram(`
      const rows = scene.parallelGuides("field", [[-14,-8],[13,-7],[11,9],[-12,8]], {
        direction: 8, spacing: 3.5, inset: 1, width: 0.7, tags: ["farm-row"]
      });
      for (const row of rows) {
        scene.placeAlong("crop", row, { spacing: 2.2, count: 8 });
      }
      if (rows.length > 3) scene.note("field has enough crop rows");
    `, createEmptyMap('farm', 'program-farm'), assets);

    expect(result.guideCount).toBeGreaterThan(3);
    expect(result.objectCount).toBeGreaterThan(15);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'program-note' }));
  });

  it('supports campus anchors plus buildings arranged along a shared curved spine', () => {
    const result = executeSceneProgram(`
      const spine = scene.guide("campus-spine", {
        points: [[-16,-10],[-6,-2],[0,9],[12,12]], curve: "catmull-rom", width: 3, tags: ["campus"]
      });
      scene.placeAlong("campus-building", spine, { spacing: 8, offset: 5, count: 4, scale: 1.3 });
      scene.placeAt("campus-building", [0, 4], { yaw: 180, scale: 1.6, name: "Main Hall" });
    `, createEmptyMap('campus', 'program-campus'), assets);

    expect(result.guideCount).toBe(1);
    expect(result.objectCount).toBeGreaterThanOrEqual(3);
  });

  it('composes two guide families into a small street network instead of a city-only preset', () => {
    const result = executeSceneProgram(`
      const town = scene.streetGrid("town", [[-18,-14],[18,-14],[18,14],[-18,14]], {
        direction: 0, blockWidth: 9, blockDepth: 9, roadWidth: 3, inset: 1, tags: ["town"]
      });
      for (const street of town.streets) {
        scene.surface(street, "paving", 0.65);
      }
      for (const block of town.blocks) {
        scene.surfaceRegion(block.id, "grass", { kind: "polygon", points: block.points }, 0.35);
        scene.placeAt("campus-building", block.center, { scale: 1.1, searchRadius: 2 });
      }
    `, createEmptyMap('small town', 'program-town'), assets);

    expect(result.guideCount).toBeGreaterThanOrEqual(6);
    expect(result.objectCount).toBeGreaterThanOrEqual(4);
    expect(result.operations.filter((operation) => operation.type === 'terrain.surface').length).toBeGreaterThan(result.guideCount);
    expect(result.operations).toContainEqual(expect.objectContaining({ type: 'terrain.surface', surface: 'paving' }));
  });

  it('combines terrain, water, grass, scatter, safe spawn and computed layouts in one program', () => {
    const result = executeSceneProgram(`
      scene.terrain("hills", { amplitude: 3.5, roughness: 0.35 });
      scene.modifyTerrain("basin", { kind: "circle", x: -10, z: 0, radius: 8 }, { amplitude: 2.5, softness: 0.7 });
      scene.surfaceRegion("beach", "sand", { kind: "polygon", points: [[-16,-12],[-2,-12],[-2,12],[-16,12]] }, 0.85);
      scene.water("coast", { type: "ocean", points: [[-16,-12],[-8,-12],[-8,12],[-16,12]], level: 0, depth: 2.5 });
      scene.grass("park-lawn", { kind: "circle", x: 7, z: 0, radius: 8 }, { preset: "meadow", density: 0.7 });
      scene.scatter("crop", { center: [7,0], radius: 7 }, { count: 8, minSpacing: 2, avoidWater: 1 });
      const angles = scene.range(0, 360, 90);
      for (const angle of angles) {
        const point = scene.polar([7,0], 5.5, angle);
        scene.placeAt("bench", point, { yaw: angle, searchRadius: 1.5 });
      }
      scene.spawn([12, 10], 180);
      scene.renderSuggestion("coastal mist and warm sunset reflections");
    `, createEmptyMap('complete park', 'program-complete'), assets);

    const types = result.operations.map((operation) => operation.type);
    expect(types).toEqual(expect.arrayContaining([
      'terrain.generate', 'terrain.modify', 'terrain.surface', 'water.add',
      'grass.layer.add', 'grass.generate', 'object.add', 'reference.set', 'map.update'
    ]));
    expect(result.objectCount).toBeGreaterThanOrEqual(6);
    expect(result.renderPromptSuggestions).toEqual(['coastal mist and warm sunset reflections']);
  });

  it('combines deterministic fields and grid math with the existing safe placement kernel', () => {
    const program = `
      const points = scene.gridPoints({ center: [0,0], columns: 5, rows: 5, spacing: [4,3] });
      for (const point of points) {
        const density = scene.fbm2D(point[0], point[1], { scale: 0.08, octaves: 3 });
        if (scene.smoothstep(-0.45, 0.35, density) > 0.3) {
          const rotated = scene.rotate2D(point, 18);
          scene.placeAt("crop", rotated, { searchRadius: 1.2, avoidWater: 0.5, maxSlope: 32 });
        }
      }
      const mapped = scene.remap(scene.noise2D(3, 7, 0.2), -1, 1, 0, 10);
      if (scene.clamp(mapped, 0, 10) >= 0 && scene.distance2D([0,0], [3,4]) === 5) {
        scene.note("field math completed");
      }
    `;
    const map = createEmptyMap('field layout', 'program-field-layout');
    const first = executeSceneProgram(program, map, assets);
    const second = executeSceneProgram(program, map, assets);
    const positions = (result: typeof first) => result.operations.flatMap((operation) => (
      operation.type === 'object.add' ? [operation.object.transform?.position] : []
    ));

    expect(first.objectCount).toBeGreaterThan(4);
    expect(first.objectCount).toBeLessThanOrEqual(25);
    expect(positions(first)).toEqual(positions(second));
    expect(first.diagnostics).toContainEqual(expect.objectContaining({ code: 'program-note', message: 'field math completed' }));
    expect(SCENE_PROGRAM_API_REFERENCE).toContain('scene.fbm2D');
    expect(SCENE_PROGRAM_API_REFERENCE).toContain('scene.gridPoints');
  });

  it('rejects arbitrary JavaScript and stops programs that exceed loop budgets', () => {
    expect(() => executeSceneProgram('while (true) { scene.note("x"); }', createEmptyMap(), assets))
      .toThrow(/unsupported_scene_program/);
    expect(() => executeSceneProgram('scene.constructor("x");', createEmptyMap(), assets))
      .toThrow('invalid_scene_program_property:constructor');
    expect(() => executeSceneProgram(`
      const rows = scene.parallelGuides("row", [[-10,-10],[10,-10],[10,10],[-10,10]], { direction: 0, spacing: 1 });
      for (const row of rows) scene.note("row");
    `, createEmptyMap(), assets, { maxLoopIterations: 2 })).toThrow('scene_program_loop_budget_exceeded');
  });
});
