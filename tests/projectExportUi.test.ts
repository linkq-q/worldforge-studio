import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/client/mapEditor.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('project export editor UI', () => {
  it('keeps project export beside the existing transfer actions', () => {
    expect(source).toContain('id="configure-project-export"');
    expect(source).toContain('id="export-to-project"');
    expect(source).toContain('项目导出配置…');
    expect(source).toContain('一键导出到项目');
  });

  it('blocks unsaved project exports and reviews all collisions before overwrite', () => {
    expect(source).toContain('当前地图存在未保存内容，请先保存后再导出到项目');
    expect(source).toContain('data-project-export-conflict');
    expect(source).toContain('默认保留目标项目中的文件。勾选后才会覆盖。');
    expect(source).toContain('整张地图另存为…');
    expect(source).toContain("if (mapFolder) setInputValue(this.app, '#project-export-map-folder', mapFolder)");
  });

  it('styles the configuration and conflict dialogs', () => {
    expect(styles).toContain('.project-export-dialog');
    expect(styles).toContain('.project-export-conflict-list');
  });
});
