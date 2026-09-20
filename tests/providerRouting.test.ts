import { describe, expect, it } from 'vitest';
import {
  isModelProvider,
  modelProviderForChatProvider,
  type ChatProvider
} from '../src/shared/protocol';

describe('provider routing', () => {
  it.each([
    ['gpt', 'gpt'],
    ['glm', 'glm'],
    ['fireworks', 'fireworks'],
    ['deepseek-v4-pro', 'deepseek']
  ] satisfies Array<[ChatProvider, string]>)('maps chat provider %s to asset provider %s', (chat, asset) => {
    expect(modelProviderForChatProvider(chat)).toBe(asset);
  });

  it('accepts only model-generation providers at the asset boundary', () => {
    expect(isModelProvider('deepseek')).toBe(true);
    expect(isModelProvider('deepseek-v4-pro')).toBe(false);
    expect(isModelProvider('unknown')).toBe(false);
    expect(isModelProvider(null)).toBe(false);
  });
});
