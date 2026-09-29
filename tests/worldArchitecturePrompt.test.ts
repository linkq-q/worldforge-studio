import { describe, expect, it } from 'vitest';
import {
  buildWorldArchitecturePrompt,
  WORLD_ARCHITECTURE_PROMPT_MAX_CHARS
} from '../src/server/worldArchitecturePrompt';

describe('world architecture prompt', () => {
  it('puts playability constraints before the complete causal building program', () => {
    const sentinel = 'PROGRAM-TAIL-SENTINEL';
    const prompt = `${'x'.repeat(5_900)}${sentinel}`;
    const result = buildWorldArchitecturePrompt(prompt, [24, 12, 18]);

    expect(result).toContain('Build ONLY the 24m by 18m footprint architecture, height 12m');
    expect(result).toContain('public arrival and service or logistics flows');
    expect(result).toContain('not a checklist of rooms');
    expect(result).toContain(sentinel);
    expect(result.indexOf('World architecture assembly contract:')).toBeLessThan(result.indexOf('Building program from the world plan:'));
    expect(result.length).toBeLessThanOrEqual(WORLD_ARCHITECTURE_PROMPT_MAX_CHARS);
  });

  it('rejects overflow instead of silently cutting building semantics', () => {
    expect(() => buildWorldArchitecturePrompt('x'.repeat(WORLD_ARCHITECTURE_PROMPT_MAX_CHARS)))
      .toThrow('world_architecture_prompt_too_long');
  });
});
