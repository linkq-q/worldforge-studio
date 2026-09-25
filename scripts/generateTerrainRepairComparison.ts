import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEmptyMap, refineTerrainResolution, sampleTerrainHeight, type EditableMap, type MapWaterBody } from '../src/shared/map';
import { generateTerrainInPlace, refineTerrainInPlace } from '../src/shared/terrainGeneration';
import { carveWaterBasinInPlace, waterBoundaryPoints } from '../src/shared/mapWater';

const root = path.resolve(import.meta.dirname, '..');
const baseline = 'cb213fe';
const snapshots = [
  ['src/shared/terrainGeneration.ts', '.terrain-repair-baseline-generation.ts', baseline],
  ['src/shared/terrainGeneration.ts', '.terrain-repair-prior-flow.ts', 'f1425b9'],
  ['src/shared/terrainGeneration.ts', '.terrain-repair-uniform-polish.ts', '80e4fe9']
] as const;
const snapshotPaths = snapshots.map(([, name]) => path.join(root, 'src/shared', name));

for (const [[source, , ref], target] of snapshots.map((entry, index) => [entry, snapshotPaths[index]] as const)) {
  writeFileSync(target, execFileSync('git', ['show', `${ref}:${source}`], { cwd: root }));
}

try {
  const oldGeneration = await import(pathToFileURL(snapshotPaths[0]).href) as typeof import('../src/shared/terrainGeneration');
  const priorGeneration = await import(pathToFileURL(snapshotPaths[1]).href) as typeof import('../src/shared/terrainGeneration');
  const uniformPolish = await import(pathToFileURL(snapshotPaths[2]).href) as typeof import('../src/shared/terrainGeneration');
  const stages = [
    { id: 'baseline', name: '基线', commit: baseline, dense: false, drain: oldGeneration.refineTerrainInPlace },
    { id: 'grid', name: '① 网格加密', commit: '8405944', dense: true, drain: oldGeneration.refineTerrainInPlace },
    { id: 'flow', name: '② 排水分流', commit: 'f1425b9', dense: true, drain: priorGeneration.refineTerrainInPlace },
    { id: 'polish', name: '③ 山脉修型', commit: '80e4fe9', dense: true, drain: uniformPolish.refineTerrainInPlace },
    { id: 'selective', name: '④ 分区修型', commit: '658e3b0', dense: true, drain: refineTerrainInPlace }
  ];
  const waters: Record<string, MapWaterBody> = {
    river: { id: 'river', name: 'River', type: 'river', points: [[0,-33],[-5,-16],[4,2],[0,18],[7,34]], level: 2, levels: [2,2,2,2,2], width: 8, depth: 3, shorelineSmoothness: 0.82 },
    lake: { id: 'lake', name: 'Lake', type: 'lake', points: [[-14,-8],[-10,-16],[4,-18],[16,-9],[18,5],[8,15],[-8,14],[-17,5]], level: 2, width: 8, depth: 3, shorelineSmoothness: 0.82, shorelineIrregularity: 0.12, seed: 42 }
  };
  const output: Record<string, unknown> = {
    stages: stages.map(({ id, name, commit }) => ({ id, name, commit })),
    cases: {
      mountain: { name: '自然山脉', description: '同一种子生成山体，再进行热侵蚀与排水；比较沟槽、山脊和网格细节。' },
      cone: { name: '圆锥诊断', description: '完全对称的坡面。方向差异只来自网格和排水算法，便于识别十字纹。' },
      river: { name: '河道', description: '在 5 米平地雕刻弯曲河道，保留原来的较陡岸坡。', boundary: waterBoundaryPoints(waters.river), water: waters.river, level: 2 },
      lake: { name: '湖岸', description: '在 5 米平地雕刻湖盆，保留原来的较陡岸坡。', boundary: waterBoundaryPoints(waters.lake), water: waters.lake, level: 2 }
    },
    data: {} as Record<string, unknown>
  };
  const data = output.data as Record<string, unknown[]>;

  for (const kind of ['mountain', 'cone', 'river', 'lake'] as const) {
    data[kind] = [];
    for (const stage of stages) {
      const map = createEmptyMap(`terrain-comparison-${kind}`, `comparison-${kind}`, [96, 48, 96]);
      if (stage.dense) map.terrain = refineTerrainResolution(map.terrain, 2);
      let metric: number;
      let metricLabel: string;
      let before: EditableMap;
      if (kind === 'mountain') {
        generateTerrainInPlace(map, { preset: 'mountains', seed: 42, amplitude: 35, roughness: 0.65, direction: 30 });
        before = structuredClone(map);
        stage.drain(map, { erosion: 0.2, drainage: 0.55, iterations: 8, talus: 46 });
        metric = Math.max(...map.terrain.heights.map((height, index) => before.terrain.heights[index] - height));
        metricLabel = '最深下切';
      } else if (kind === 'cone') {
        const n = map.terrain.resolutionX;
        const step = 96 / (n - 1);
        for (let z = 0; z < n; z += 1) {
          for (let x = 0; x < n; x += 1) {
            map.terrain.heights[z * n + x] = Math.max(0, 40 - Math.hypot((x - (n - 1) / 2) * step, (z - (n - 1) / 2) * step) * 0.7);
          }
        }
        before = structuredClone(map);
        stage.drain(map, { erosion: 0, drainage: 0.5, iterations: 1 });
        const incision = [0, 11.25, 22.5, 33.75, 45].map((degrees) => {
          const angle = degrees * Math.PI / 180;
          const x = 22 * Math.cos(angle), z = 22 * Math.sin(angle);
          return sampleTerrainHeight(before, x, z) - sampleTerrainHeight(map, x, z);
        });
        metric = Math.max(...incision) - Math.min(...incision);
        metricLabel = '方向下切差';
      } else {
        map.terrain.heights.fill(5);
        before = structuredClone(map);
        carveWaterBasinInPlace(map, waters[kind]);
        metric = maxCrossSectionStep(map);
        metricLabel = '剖面最大单格落差';
      }
      data[kind].push({
        n: map.terrain.resolutionX,
        spacing: 96 / (map.terrain.resolutionX - 1),
        heights: encodeHeights(map.terrain.heights),
        cut: encodeHeights(map.terrain.heights.map((height, index) => Math.max(0, before.terrain.heights[index] - height))),
        metric: +metric.toFixed(3), metricLabel
      });
    }
  }

  const replacement = JSON.stringify(output);
  for (const name of ['terrainRepairComparison.html', 'terrainRepair3D.html']) {
    const target = path.join(root, 'scripts', name);
    const html = readFileSync(target, 'utf8');
    const updated = html.replace(/(<script id="terrain-data" type="application\/json">)[\s\S]*?(<\/script>)/,
      (_, open: string, close: string) => `${open}${replacement}${close}`);
    if (!html.includes('<script id="terrain-data" type="application/json">')) throw new Error(`comparison_data_marker_missing:${name}`);
    writeFileSync(target, updated, 'utf8');
    console.log(`Wrote ${target}`);
  }
} finally {
  for (const snapshot of snapshotPaths) rmSync(snapshot, { force: true });
}

function maxCrossSectionStep(map: EditableMap): number {
  const n = map.terrain.resolutionX;
  const row = Math.floor(map.terrain.resolutionZ / 2) * n;
  let max = 0;
  for (let x = 0; x < n - 1; x += 1) {
    max = Math.max(max, Math.abs(map.terrain.heights[row + x + 1] - map.terrain.heights[row + x]));
  }
  return max;
}

function encodeHeights(heights: number[]): string {
  const bytes = Buffer.allocUnsafe(heights.length * 2);
  heights.forEach((height, index) => bytes.writeUInt16LE(Math.round((Math.max(-16, Math.min(64, height)) + 16) * 100), index * 2));
  return bytes.toString('base64');
}
