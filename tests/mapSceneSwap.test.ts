import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shouldPromoteLiveMapPreview } from '../src/client/mapEditor';

const source = readFileSync(new URL('../src/client/mapEditor.ts', import.meta.url), 'utf8');

describe('map scene swap', () => {
  it('keeps the current scene attached until the replacement finishes building', () => {
    const start = source.indexOf('private async rebuildScene(): Promise<void>');
    const end = source.indexOf('private handlePointer', start);
    const rebuild = source.slice(start, end);
    const build = rebuild.indexOf('await buildEditableMapGroup');
    const detach = rebuild.indexOf('this.renderScene?.attach(null)', build);

    expect(build).toBeGreaterThan(-1);
    expect(detach).toBeGreaterThan(build);
  });

  it('shows a loading state and locks map selection while a scene switch is running', () => {
    const changeStart = source.indexOf("this.app.querySelector('#editor-map-select')?.addEventListener('change'");
    const changeEnd = source.indexOf("this.app.querySelectorAll<HTMLButtonElement>('[data-view]')", changeStart);
    const changeHandler = source.slice(changeStart, changeEnd);
    const toolbarStart = source.indexOf('private updateToolbarState(): void');
    const toolbarEnd = source.indexOf('private renderStageTabs', toolbarStart);
    const toolbar = source.slice(toolbarStart, toolbarEnd);

    expect(changeHandler).toContain("this.setBusy(true, '正在切换地图…')");
    expect(changeHandler).toContain('window.setTimeout(resolve, 0)');
    expect(changeHandler).toContain('this.setBusy(false)');
    expect(toolbar).toContain("mapSelect.disabled = this.state.busy");
  });

  it('does not replace a fuller live scene with a partial agent candidate', () => {
    expect(shouldPromoteLiveMapPreview(8, 2)).toBe(false);
    expect(shouldPromoteLiveMapPreview(8, 8)).toBe(true);
    expect(shouldPromoteLiveMapPreview(8, 10)).toBe(true);
  });
});
