/**
 * COR-1935 — the effort a session's steering names is read on every call, not at construction: it
 * reaches `config.thinkingConfig.thinkingBudget` of the next request, is dropped for a model with
 * no thinking mode, and never fails a call. The response's `metadata.effectiveEffort` reports what
 * was sent.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import type { Effort, GenerateContext } from '@lostgradient/operative/provider-kit';
import { createGeminiProvider, createGeminiProviderStream } from '../src/gemini.ts';
import { geminiStreamTextChunks, geminiTextResponse } from '../src/test/gemini-fixtures.ts';
import {
  createMockGeminiModel,
  createMockGeminiStreamingModel,
} from '../src/test/gemini-mock-clients.ts';

function context(effort?: Effort): GenerateContext {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createToolbox([]),
    ...(effort === undefined ? {} : { steering: { effort, paused: false, configVersion: 1 } }),
  };
}

const budgetOf = (call: unknown) =>
  (call as { config?: { thinkingConfig?: { thinkingBudget?: number } } } | undefined)?.config
    ?.thinkingConfig?.thinkingBudget;

describe('a steered effort on the Gemini request', () => {
  it('is read per call: the next call carries it and an earlier one did not', async () => {
    const client = createMockGeminiModel([geminiTextResponse, geminiTextResponse]);
    const generate = createGeminiProvider({ model: 'gemini-2.5-pro', client });

    await generate(context());
    const steered = await generate(context('high'));

    expect(client._calls.map(budgetOf)).toEqual([undefined, 16384]);
    expect(steered.metadata).toMatchObject({ effectiveEffort: 'high' });
  });

  it('wins over the construction-time effort, which returns when steering names none', async () => {
    const client = createMockGeminiModel([geminiTextResponse, geminiTextResponse]);
    const generate = createGeminiProvider({ model: 'gemini-2.5-pro', effort: 'low', client });

    await generate(context('max'));
    await generate(context());

    expect(client._calls.map(budgetOf)).toEqual([-1, 1024]);
  });

  it('is dropped for a model with no thinking mode, without failing the call', async () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({ model: 'gemini-2.0-flash', client });

    const response = await generate(context('high'));

    expect(budgetOf(client._calls[0])).toBeUndefined();
    expect(response.metadata).toMatchObject({ effectiveEffort: 'none' });
  });

  it('reaches a streamed request the same way', async () => {
    const client = createMockGeminiStreamingModel([geminiStreamTextChunks]);
    const generate = createGeminiProviderStream({ model: 'gemini-2.5-pro', client });

    await generate({
      ...context('medium'),
      streaming: { update: () => {}, messageId: 'message-1' },
    });

    expect(budgetOf(client._calls[0])).toBe(8192);
  });
});
