import { describe, expect, it } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import { normalizeInteriorArtDirection } from '../src/shared/interiorArtDirection';
import {
  renderInteriorFinishPanel,
  renderRoomSurfaceFinishEditor
} from '../src/client/interiorFinishPanel';

describe('interior finish editor panel', () => {
  it('starts a plain legacy room with the feature panel off without changing its map', () => {
    const map = createEmptyMap('plain room', 'plain-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    expect(map.interiorArtDirection).toBeNull();

    const html = renderInteriorFinishPanel(map, true);
    expect(html).toContain('data-interior-master');
    expect(html).not.toMatch(/data-interior-master[^>]*checked/);
    expect(html).toContain('墙面装饰');
    expect(html).toContain('硬质地板');
    expect(html).toContain('满铺地毯');
    expect(html).toContain('独立地毯');
    expect(map.interiorArtDirection).toBeNull();
  });

  it('is available to the room inside a mixed map', () => {
    const map = createEmptyMap('mixed room', 'mixed-room', [16, 3, 16], 'voxel', 'mixed', [10, 3, 8]);
    expect(renderInteriorFinishPanel(map, false)).toContain('室内表面装饰总开关');
    expect(map.interiorArtDirection).toBeNull();
  });

  it('renders room-wide wall controls, separate floor and carpet recipes, and four editable rugs', () => {
    const map = createEmptyMap('editable room', 'editable-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    map.interiorArtDirection = normalizeInteriorArtDirection({
      summary: 'editable finishes', palette: ['#123456', '#abcdef'],
      surfaces: { north: { recipe: 'wallpaper.stripe' }, floor: { recipe: 'tile.ceramic' } },
      finishSettings: {
        enabled: true, wallsEnabled: true, floorEnabled: true, carpetEnabled: true, rugsEnabled: true,
        uniformWalls: true, locked: ['walls']
      },
      rugs: Array.from({ length: 4 }, (_, index) => ({
        id: `rug-${index}`, shape: 'rectangle' as const, center: [0, 0] as [number, number],
        size: [0.4, 0.3] as [number, number], rotation: 0 as const, pattern: 'border' as const,
        palette: ['#123456', '#abcdef'], seed: index
      }))
    }, map.seed);

    const panel = renderInteriorFinishPanel(map, true);
    const wall = renderRoomSurfaceFinishEditor(map, 'north');
    const floor = renderRoomSurfaceFinishEditor(map, 'floor');
    expect(panel).toMatch(/data-interior-master[^>]*checked/);
    expect(panel).toContain('4/4');
    expect(panel).toMatch(/data-add-procedural-rug[^>]*disabled/);
    expect(wall).toContain('整个房间');
    expect(wall).toContain('仅北墙');
    expect(wall).toContain('条纹墙纸');
    expect(floor).toContain('硬质地板');
    expect(floor).toContain('满铺地毯');
    expect(floor).toContain('陶瓷砖');
    expect(floor).toContain('圈绒满铺地毯');
    expect(renderRoomSurfaceFinishEditor(map, 'ceiling')).toContain('暂不纳入');
  });
});
