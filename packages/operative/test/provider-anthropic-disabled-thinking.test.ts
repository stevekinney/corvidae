/**
 * `thinking: { type: 'disabled' }` combinations Anthropic documents as a 400 are refused before
 * any request, from the per-model table in `src/providers/anthropic-thinking.ts`.
 */
import { describe, expect, it } from 'bun:test';

import {
  createAnthropicProvider,
  createAnthropicProviderStream,
} from '../src/providers/anthropic.ts';
import { ProviderError } from '../src/providers/errors.ts';
import { anthropicTextResponse } from '../src/providers/test/anthropic-fixtures.ts';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
} from '../src/providers/test/anthropic-mock-clients.ts';
import type { Effort } from '../src/providers/types.ts';

const disabled = { type: 'disabled' } as const;
const every: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function build(model: string, effort: Effort | undefined) {
  return createAnthropicProvider({
    model,
    client: createMockAnthropicClient([anthropicTextResponse]),
    thinking: disabled,
    ...(effort ? { effort } : {}),
  });
}

describe('models that reject disabled thinking at every effort', () => {
  const never = [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-fable-5-1',
    'claude-mythos-5-1',
    'claude-fable-5',
    'claude-mythos-5',
  ];

  for (const model of never) {
    it(`${model} refuses it with and without effort`, () => {
      expect(() => build(model, undefined)).toThrow(ProviderError);
      for (const effort of every) expect(() => build(model, effort)).toThrow(ProviderError);
    });
  }

  it('names the model and the remedy', () => {
    expect(() => build('claude-sonnet-5-5', 'low')).toThrow(
      /claude-sonnet-5-5 rejects thinking.type 'disabled' at every effort/,
    );
  });

  it('allows leaving thinking unset or adaptive', () => {
    expect(() =>
      createAnthropicProvider({
        model: 'claude-opus-5-5',
        client: createMockAnthropicClient([]),
        thinking: { type: 'adaptive' },
        effort: 'max',
      }),
    ).not.toThrow();
  });
});

describe('models that accept disabled thinking only at high effort or below', () => {
  for (const model of ['claude-haiku-5-5', 'claude-opus-5']) {
    it(`${model} refuses xhigh and max`, () => {
      expect(() => build(model, 'xhigh')).toThrow(/at effort 'xhigh'/);
      expect(() => build(model, 'max')).toThrow(/at effort 'max'/);
    });

    it(`${model} accepts low, medium, high and no effort`, () => {
      for (const effort of [...every.slice(0, 3), undefined]) {
        expect(() => build(model, effort)).not.toThrow();
      }
    });
  }
});

describe('models that accept disabled thinking at every effort', () => {
  it('claude-sonnet-5 and claude-opus-4-8 accept it, even at max', () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5']) {
      expect(() => build(model, 'max')).not.toThrow();
    }
  });

  it('does not guess for a model the table does not list', () => {
    expect(() => build('claude-opus-6', 'max')).not.toThrow();
  });
});

describe('streaming factory', () => {
  it('applies the same table', () => {
    const client = createMockAnthropicStreamingClient([]);
    expect(() =>
      createAnthropicProviderStream({ model: 'claude-opus-5-5', client, thinking: disabled }),
    ).toThrow(ProviderError);
    expect(() =>
      createAnthropicProviderStream({
        model: 'claude-haiku-5-5',
        client,
        thinking: disabled,
        effort: 'xhigh',
      }),
    ).toThrow(ProviderError);
    expect(() =>
      createAnthropicProviderStream({
        model: 'claude-haiku-5-5',
        client,
        thinking: disabled,
        effort: 'high',
      }),
    ).not.toThrow();
  });
});
