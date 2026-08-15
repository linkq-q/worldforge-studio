import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmptyMap, createMapObject } from '../src/shared/map';
import { BUILTIN_RENDER_SCHEMES } from '../src/shared/renderScheme';
import { MapStore } from '../src/server/mapStore';
import {
  buildProjectExportPlan,
  inspectProjectExport,
  writeProjectExport
} from '../src/server/projectExport';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('project directory export', () => {
  it('externalizes models into content-addressed shared assets and keeps relative references portable', async () => {
    const map = createEmptyMap('森林');
    map.updatedAt = 123;
    const asset = {
      id: 'asset-tree',
      name: '树',
      prompt: '一棵树',
      modelJson: { nodes: [{ id: 'trunk' }] },
      colliderPlan: {
        version: 1 as const,
        boxes: [],
        sourceMeshCount: 0,
        candidateCount: 0,
        fallbackUsed: false
      },
      mode: 'voxel',
      createdAt: 1,
      updatedAt: 2
    };
    map.assets = [asset];
    map.objects.push(createMapObject('树', asset.id));

    const plan = buildProjectExportPlan({
      map,
      renderScheme: BUILTIN_RENDER_SCHEMES[0],
      profile: profile(),
      mapFolder: '森林',
      hdri: { file: 'forest.exr', bytes: new Uint8Array([1, 2, 3]) }
    });

    expect(plan.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      'maps/森林/map.json',
      'maps/森林/render-scheme.json',
      'maps/森林/manifest.json',
      'assets/worldforge/libraries/' + map.id + '.json',
      'assets/worldforge/hdri/forest.exr'
    ]));
    const modelFile = plan.files.find((file) => file.path.startsWith('assets/worldforge/models/'));
    expect(modelFile?.path).toMatch(/^assets\/worldforge\/models\/[a-f0-9]{64}\.json$/);

    const exportedMap = JSON.parse(text(plan.files.find((file) => file.path.endsWith('/map.json'))!.bytes));
    expect(exportedMap.assets[0].modelJson.$ref).toMatch(/^\.\.\/\.\.\/assets\/worldforge\/models\//);
    const manifest = JSON.parse(text(plan.files.find((file) => file.path.endsWith('/manifest.json'))!.bytes));
    expect(manifest).toMatchObject({
      kind: 'worldforge-project-map',
      assetRoot: '../../assets/worldforge',
      map: 'map.json',
      renderScheme: 'render-scheme.json',
      hdri: { file: 'hdri/forest.exr' }
    });
  });

  it('preflights every conflict before writing and never removes unrelated files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worldforge-project-export-'));
    tempDirs.push(root);
    const plan = buildProjectExportPlan({
      map: createEmptyMap('森林'),
      renderScheme: BUILTIN_RENDER_SCHEMES[0],
      profile: profile(),
      mapFolder: '森林'
    });
    const conflict = path.join(root, 'maps', '森林', 'map.json');
    await writeFileSafe(conflict, 'user-owned');
    const unrelated = path.join(root, 'maps', '森林', 'notes.txt');
    await writeFileSafe(unrelated, 'keep');

    const preview = await inspectProjectExport(root, plan);
    expect(preview.conflicts.map((entry) => entry.path)).toContain('maps/森林/map.json');
    expect(await readFile(conflict, 'utf8')).toBe('user-owned');

    const kept = await writeProjectExport(root, plan, []);
    expect(kept.conflictsSkipped).toBe(1);
    expect(await readFile(conflict, 'utf8')).toBe('user-owned');
    expect(await readFile(unrelated, 'utf8')).toBe('keep');

    await writeProjectExport(root, plan, ['maps/森林/map.json']);
    expect(JSON.parse(await readFile(conflict, 'utf8'))).toMatchObject({ name: '森林' });
    expect(await readFile(unrelated, 'utf8')).toBe('keep');
  });

  it('persists multiple named export profiles outside map data', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-export-profiles-'));
    tempDirs.push(rootDir);
    const store = new MapStore({ rootDir });
    const browser = await store.saveProjectExportProfile({
      name: '浏览器项目', mode: 'browser', projectDirectory: 'HideAndSeek'
    });
    const server = await store.saveProjectExportProfile({
      name: '本地项目', mode: 'server', projectDirectory: 'D:\\Games\\HideAndSeek'
    });

    const restarted = new MapStore({ rootDir });
    expect((await restarted.listProjectExportProfiles()).map((item) => item.name).sort()).toEqual(['本地项目', '浏览器项目'].sort());
    await restarted.deleteProjectExportProfile(browser.id);
    expect((await restarted.listProjectExportProfiles()).map((item) => item.id)).toEqual([server.id]);
    await expect(restarted.saveProjectExportProfile({
      name: '坏路径', mode: 'server', projectDirectory: 'relative/project'
    })).rejects.toThrow('project_export_server_path_must_be_absolute');
    await expect(restarted.saveProjectExportProfile({
      name: '越界目录',
      mode: 'server',
      projectDirectory: 'D:\\Games\\HideAndSeek',
      mapsDirectory: '../maps'
    })).rejects.toThrow('invalid_project_export_directory');
  });
});

function profile() {
  return {
    version: 1 as const,
    id: 'profile-test',
    name: '躲猫猫项目',
    mode: 'server' as const,
    projectDirectory: 'D:\\Games\\HideAndSeek',
    mapsDirectory: 'maps',
    assetsDirectory: 'assets/worldforge',
    createdAt: 1,
    updatedAt: 1
  };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function writeFileSafe(file: string, value: string): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value, 'utf8');
}
