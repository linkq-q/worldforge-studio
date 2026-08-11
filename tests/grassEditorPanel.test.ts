import { describe, expect, it } from 'vitest';
import { renderGrassEditorPanel, type GrassEditorState } from '../src/client/grassEditorPanel';
import { createEmptyMap } from '../src/shared/map';
import { createGrassLayer, GRASS_PRESET_IDS } from '../src/shared/mapGrass';

describe('grass editor panel', () => {
  it('offers every distinct morphology and exposes per-layer height and flowers', () => {
    const map = createEmptyMap('Grass editor', 'grass-editor');
    const layer = createGrassLayer(
      { id: 'magic', name: 'Magic grass', preset: 'magic', height: 1.35 },
      map.terrain.resolutionX,
      map.terrain.resolutionZ
    );
    map.grassLayers = [layer];
    const state: GrassEditorState = {
      selectedLayerId: layer.id,
      brushMode: 'add',
      brushSize: 3,
      brushStrength: 0.35,
      targetDensity: 0.6,
      fillDensity: 0.7,
      regionX: 0,
      regionZ: 0,
      regionRadius: 8
    };

    const html = renderGrassEditorPanel(map, state);

    for (const preset of GRASS_PRESET_IDS) expect(html).toContain(`value="${preset}"`);
    expect(html).toContain('value="magic" selected');
    expect(html).toContain('data-grass-height');
    expect(html).toContain('鲜花');
  });
});
