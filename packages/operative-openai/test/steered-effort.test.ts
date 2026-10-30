/**
 * COR-1935 — the effort a session's steering names is read on every call, not at construction: it
 * reaches `reasoning_effort` of the next request, is clamped to OpenAI's three tiers, is dropped
 * for a model that takes no `reasoning_effort`, and never fails a call. The response's
 * `metadata.effectiveEffort` reports what was sent.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import type { Effort, GenerateContext } from '@lostgradient/operative/provider-kit';
import { createOpenAIProvider, createOpenAIProviderStream } from '../src/openai.ts';
import { openAIStreamTextChunks, openAITextResponse } from '../src/test/openai-fixtures.ts';
import {
  createMockOpenAIClient,
  createMockOpenAIStreamingClient,
} from '../src/test/openai-mock-clients.ts';

function context(effort?: Effort): GenerateContext {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createToolbox([]),
    ...(effort === undefined ? {} : { steering: { effort, paused: false, configVersion: 1 } }),
  };
}

describe('a steered effort on the OpenAI request', () => {
  it('is read per call: the next call carries it and an earlier one did not', async () => {
    const client = createMockOpenAIClient([openAITextResponse, openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'o3', client });

    await generate(context());
    const steered = await generate(context('medium'));

    expect(client._calls.map((call) => call['reasoning_effort'])).toEqual([undefined, 'medium']);
    expect(steered.metadata).toMatchObject({ effectiveEffort: 'medium' });
  });

  it('wins over the construction-time effort, which returns when steering names none', async () => {
    const client = createMockOpenAIClient([openAITextResponse, openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'o3', effort: 'low', client });

    await generate(context('medium'));
    await generate(context());

    expect(client._calls.map((call) => call['reasoning_effort'])).toEqual(['medium', 'low']);
  });

  it('clamps the tiers above high to high, and reports it as sent', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'o3', client });

    const response = await generate(context('max'));

    expect(client._calls[0]?.['reasoning_effort']).toBe('high');
    expect(response.metadata).toMatchObject({ effectiveEffort: 'high' });
  });

  it('is dropped for a model that takes no reasoning_effort, without failing the call', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'gpt-4.1', client });

    const response = await generate(context('high'));

    expect(client._calls[0]).not.toHaveProperty('reasoning_effort');
    expect(response.metadata).toMatchObject({ effectiveEffort: 'none' });
  });

  it('reaches a streamed request the same way', async () => {
    const client = createMockOpenAIStreamingClient([openAIStreamTextChunks]);
    const generate = createOpenAIProviderStream({ model: 'o3', client });

    await generate({
      ...context('low'),
      streaming: { update: () => {}, messageId: 'message-1' },
    });

    expect(client._calls[0]?.['reasoning_effort']).toBe('low');
  });
});
