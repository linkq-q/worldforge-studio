import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('render prompt suggestions layout', () => {
  it('opens inside the inspector instead of overflowing to its left', () => {
    const menuRule = styles.match(/\.render-prompt-suggestion-menu\s*\{([^}]+)\}/)?.[1] ?? '';

    expect(menuRule).toContain('left: 0');
    expect(menuRule).toContain('right: auto');
  });
});
