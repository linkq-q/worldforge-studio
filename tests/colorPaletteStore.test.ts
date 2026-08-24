import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MapStore } from '../src/server/mapStore';
import { BUILTIN_RENDER_SCHEMES } from '../src/shared/renderScheme';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('color palette store', () => {
  it('saves immutable palette versions and embeds a self-contained scheme snapshot', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-palette-'));
    tempDirs.push(rootDir);
    const store = new MapStore({ rootDir });
    const first = await store.saveColorPalette({ name: '街区色卡', colors: ['#E7C393', '#52362E', '#76D0F2'] });
    const second = await store.saveColorPalette({ ...first, name: '街区色卡 v2' });

    expect(second.id).not.toBe(first.id);
    expect((await store.listColorPalettes()).map((palette) => palette.id)).toEqual([second.id, first.id]);

    const scheme = await store.saveRenderScheme({
      ...BUILTIN_RENDER_SCHEMES[0],
      name: '街区套色',
      paletteId: first.id
    });
    expect(scheme.paletteId).toBe(first.id);
    expect(scheme.paletteSnapshot).toMatchObject({ id: first.id, name: '街区色卡' });

    await store.deleteColorPalette(first.id);
    expect((await store.loadRenderScheme(scheme.id)).paletteSnapshot?.id).toBe(first.id);
  });
});
