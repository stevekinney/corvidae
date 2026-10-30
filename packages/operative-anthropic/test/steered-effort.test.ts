/**
 * COR-1935 — the effort a session's steering names is read on every call, not at construction: it
 * reaches `output_config.effort` of the next request, is clamped like a construction-time effort,
 * is dropped for a model with no effort support, and never fails a call. The response's
 * `metadata.effectiveEffort` reports what was sent.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import type { Effort, GenerateContext } from '@lostgradient/operative/provider-kit';
import { createAnthropicProvider, createAnthropicProviderStream } from '../src/anthropic.ts';
import {
  anthropicStreamTextEvents,
  anthropicTextResponse,
} from '../src/test/anthropic-fixtures.ts';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
} from '../src/test/anthropic-mock-clients.ts';

function context(effort?: Effort): GenerateContext {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createToolbox([]),
    ...(effort === undefined ? {} : { steering: { effort, paused: false, configVersion: 1 } }),
  };
}

const sentEffort = (call: unknown) =>
  (call as { output_config?: { effort?: string } } | undefined)?.output_config?.effort;

describe('a steered effort on the Anthropic request', () => {
  it('is read per call: the next call carries it and an earlier one did not', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse, anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'claude-opus-5-5', client });

    await generate(context());
    const steered = await generate(context('high'));

    expect(client._calls.map(sentEffort)).toEqual([undefined, 'high']);
    expect(steered.metadata).toMatchObject({ effectiveEffort: 'high' });
  });

  it('wins over the construction-time effort, which returns when steering names none', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse, anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-opus-5-5',
      effort: 'low',
      client,
    });

    await generate(context('max'));
    await generate(context());

    expect(client._calls.map(sentEffort)).toEqual(['max', 'low']);
  });

  it('is clamped to the tier the model has, and reported as sent', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'claude-opus-4-5', client });

    const response = await generate(context('max'));

    expect(sentEffort(client._calls[0])).toBe('high');
    expect(response.metadata).toMatchObject({ effectiveEffort: 'high' });
  });

  it('is dropped for a model with no effort support, without failing the call', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'claude-haiku-4-5', client });

    const response = await generate(context('high'));

    expect(client._calls[0]).not.toHaveProperty('output_config');
    expect(response.metadata).toMatchObject({ effectiveEffort: 'none' });
  });

  it('is not applied where the API would refuse it beside disabled thinking, and the call still succeeds', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-opus-5',
      thinking: { type: 'disabled' },
      client,
    });

    const response = await generate(context('max'));

    expect(client._calls[0]).not.toHaveProperty('output_config');
    expect(response.metadata).toMatchObject({ effectiveEffort: 'none' });
  });

  it('reaches a streamed request the same way', async () => {
    const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
    const generate = createAnthropicProviderStream({ model: 'claude-opus-5-5', client });

    await generate({
      ...context('xhigh'),
      streaming: { update: () => {}, messageId: 'message-1' },
    });

    expect(sentEffort(client._calls[0])).toBe('xhigh');
  });
});
