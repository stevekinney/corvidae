/**
 * Manual extended thinking and forced tool choice are refused before any request on the models
 * Anthropic documents as returning a 400 for them (`shared/thinking.ts`, `shared/tool-choice.ts`).
 */
import { describe, expect, it } from 'bun:test';

import {
  createAnthropicProvider,
  createAnthropicProviderStream,
} from '../src/providers/anthropic.ts';
import { ProviderError } from '../src/providers/errors.ts';
import { anthropicTextResponse } from '../src/providers/test/fixtures.ts';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
} from '../src/providers/test/mock-clients.ts';
import type { ToolChoice } from '../src/structured-output/types.ts';

const manual = { type: 'enabled', budget_tokens: 2048 } as const;

function build(options: {
  model: string;
  thinking?: typeof manual | { type: 'adaptive' };
  toolChoice?: ToolChoice;
}) {
  return createAnthropicProvider({
    client: createMockAnthropicClient([anthropicTextResponse]),
    ...options,
  });
}

describe('manual extended thinking', () => {
  const rejected = [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-1',
    'claude-mythos-5-1',
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
  ];

  for (const model of rejected) {
    it(`${model} refuses it, and still allows adaptive`, () => {
      expect(() => build({ model, thinking: manual })).toThrow(/rejects thinking.type 'enabled'/);
      expect(() => build({ model, thinking: { type: 'adaptive' } })).not.toThrow();
    });
  }

  it.each(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-haiku-4-5'])(
    '%s accepts it',
    (model) => {
      expect(() => build({ model, thinking: manual })).not.toThrow();
    },
  );

  it('leaves a model the table does not list to the API', () => {
    expect(() => build({ model: 'claude-opus-6', thinking: manual })).not.toThrow();
  });

  it('applies to the streaming factory', () => {
    expect(() =>
      createAnthropicProviderStream({
        model: 'claude-opus-5-5',
        client: createMockAnthropicStreamingClient([]),
        thinking: manual,
      }),
    ).toThrow(ProviderError);
  });
});

describe('forced tool choice', () => {
  const rejecting = [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-fable-5-1',
    'claude-mythos-5-1',
  ];

  for (const model of rejecting) {
    it(`${model} refuses required and a named tool, and allows auto and none`, () => {
      expect(() => build({ model, toolChoice: 'required' })).toThrow(/rejects forced tool use/);
      expect(() => build({ model, toolChoice: { tool: 'lookup' } })).toThrow(/'lookup'/);
      expect(() => build({ model, toolChoice: 'auto' })).not.toThrow();
      expect(() => build({ model, toolChoice: 'none' })).not.toThrow();
      expect(() => build({ model })).not.toThrow();
    });
  }

  it.each([
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
  ])('%s is not in the documented exception list, so forced choice passes', (model) => {
    expect(() => build({ model, toolChoice: 'required' })).not.toThrow();
    expect(() => build({ model, toolChoice: { tool: 'lookup' } })).not.toThrow();
  });

  it('applies to the streaming factory', () => {
    expect(() =>
      createAnthropicProviderStream({
        model: 'claude-opus-5-5',
        client: createMockAnthropicStreamingClient([]),
        toolChoice: 'required',
      }),
    ).toThrow(ProviderError);
  });
});
