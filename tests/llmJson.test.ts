import { describe, expect, it } from 'vitest';
import { parseLlmJsonObject } from '../src/server/llmJson';

describe('LLM JSON extraction', () => {
  it('recovers a complete object followed by an extra closing brace', () => {
    expect(parseLlmJsonObject('{"plan":{"version":2}}}', 'invalid')).toEqual({
      plan: { version: 2 }
    });
  });

  it('uses the last complete object and ignores braces inside strings', () => {
    const content = 'Example: {bad}\n```json\n{"plan":{"note":"keep {this}"}}\n```\n';
    expect(parseLlmJsonObject(content, 'invalid')).toEqual({
      plan: { note: 'keep {this}' }
    });
  });

  it('keeps the explicit error code when no complete object exists', () => {
    expect(() => parseLlmJsonObject('{"plan":', 'invalid_render_ai_json'))
      .toThrow('invalid_render_ai_json');
  });
});
