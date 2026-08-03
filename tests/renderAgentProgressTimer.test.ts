import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/client/mapEditor.ts', import.meta.url), 'utf8');

describe('render agent progress timer', () => {
  it('uses a live elapsed value and starts and stops it around render generation', () => {
    expect(source).toContain('elapsedMs: this.renderAgentElapsedMs');
    expect(source).toMatch(/this\.startRenderAgentProgressTimer\(\);[\s\S]*?await editorAgentFetch/);
    expect(source).toMatch(/finally\s*\{[\s\S]*?this\.stopRenderAgentProgressTimer\(\);/);
  });

  it('records a terminal render-agent failure instead of leaving the repair step active', () => {
    const start = source.indexOf("private async generateRenderAiPreview(mode: 'generate' | 'refine')");
    const end = source.indexOf('/**', start);
    const flow = source.slice(start, end);
    expect(flow).toContain('humanizeRenderAgentError(error)');
    expect(flow).toMatch(/updateAgentProgress\(this\.renderAgentProgress,\s*\{\s*phase: 'failed'/);
  });
});
