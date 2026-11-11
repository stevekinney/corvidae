/**
 * The names a person reads for a model, made from the identifier the catalog lists (board
 * PageSettingsSections, "Allowed models, provider connected").
 */
import { describe, expect, test } from 'bun:test';

import {
  formatModelAbilities,
  modelDisplayName,
  providersInOrder,
  providerTagline,
} from './format-model.ts';

describe('modelDisplayName', () => {
  test('capitalizes the words and joins a version split across hyphens with a point', () => {
    expect(modelDisplayName('claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(modelDisplayName('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
    expect(modelDisplayName('claude-haiku-4-5')).toBe('Claude Haiku 4.5');
  });

  test('leaves a whole version, an acronym and a part that is not a word as they are said', () => {
    expect(modelDisplayName('claude-sonnet-5')).toBe('Claude Sonnet 5');
    expect(modelDisplayName('gpt-4o')).toBe('GPT 4o');
    expect(modelDisplayName('gemini-2-5-pro')).toBe('Gemini 2.5 Pro');
    // A date is not a version, so it is not joined to the version before it.
    expect(modelDisplayName('claude-sonnet-4-20250514')).toBe('Claude Sonnet 4 20250514');
  });
});

describe('formatModelAbilities', () => {
  test('names tools and images, with the first word capitalized', () => {
    expect(formatModelAbilities({ tools: true, images: true })).toBe('Tools, images');
    expect(formatModelAbilities({ tools: true, images: false })).toBe('Tools');
    expect(formatModelAbilities({ tools: false, images: true })).toBe('Images');
    expect(formatModelAbilities({ tools: false, images: false })).toBe('Text only');
  });
});

describe('providersInOrder', () => {
  test('lists Anthropic, OpenAI and Gemini first whatever order the host reports, then the rest as reported', () => {
    const names = (list: readonly { name: string }[]) => list.map((entry) => entry.name);
    expect(
      names(
        providersInOrder([
          { name: 'gemini' },
          { name: 'zeta' },
          { name: 'anthropic' },
          { name: 'openai' },
          { name: 'alpha' },
        ]),
      ),
    ).toEqual(['anthropic', 'openai', 'gemini', 'zeta', 'alpha']);
  });
});

describe('providerTagline', () => {
  test('says what a known provider’s models are called, and nothing for one it has no words for', () => {
    expect(providerTagline('anthropic')).toBe('Claude models');
    expect(providerTagline('openai')).toBe('GPT models');
    expect(providerTagline('gemini')).toBe('Gemini models');
    expect(providerTagline('ollama')).toBeUndefined();
    expect(providerTagline('constructor')).toBeUndefined();
  });
});
