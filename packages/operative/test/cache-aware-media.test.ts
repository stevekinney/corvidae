import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createContextAssembler } from '../src/context/assembly.ts';
import { createTokenBudget } from '../src/context/token-budget.ts';
import { createActiveRun } from '../src/create-run';
import { MediaAdmissionError } from '../src/errors';
import { createAnthropicProvider } from '../src/providers/anthropic.ts';
import { createMockAnthropicClient } from '../src/providers/test/anthropic-mock-clients.ts';
import type { GenerateContext } from '../src/types.ts';

const BYTES = 'QUJDREVGRw==';
function textResponse(text = 'ok') {
  return {
    content: [{ type: 'text' as const, text }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe('cache-aware assembly and media (COR-716)', () => {
  it('a run through a caching Anthropic provider sends the image the user gave', async () => {
    const client = createMockAnthropicClient([textResponse()]);
    const generate = createAnthropicProvider({
      model: 'claude-sonnet-5-5',
      client,
      assembler: createContextAssembler(),
      contextBudget: createTokenBudget({ maxTokens: 100_000 }),
    });
    const conversation = new Conversation();
    conversation.appendUserMessage([
      { type: 'text', text: 'what is in this picture?' },
      {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'inline', data: BYTES, encoding: 'base64' },
      },
    ]);
    const result = await createActiveRun({
      generate,
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
    }).result;
    // A media message is never dropped silently: it is sent.
    expect(result.finishReason).not.toBe('error');
    expect(JSON.stringify(client._calls[0]?.['messages'])).toContain(BYTES);
  });

  it('refuses, typed, a media message the budget cannot hold instead of dropping it', async () => {
    const client = createMockAnthropicClient([textResponse()]);
    const generate = createAnthropicProvider({
      model: 'claude-sonnet-5-5',
      client,
      assembler: createContextAssembler(),
      contextBudget: createTokenBudget({
        maxTokens: 100,
        mediaCostEstimator: (part, position) => ({
          ...position,
          modality: part.type,
          outcome: 'estimated',
          tokens: 10_000,
          basis: 'catalog-estimate',
        }),
      }),
    });
    const conversation = new Conversation();
    conversation.appendUserMessage([
      {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'inline', data: BYTES, encoding: 'base64' },
      },
    ]);
    for (const turn of [1, 2, 3]) {
      conversation.appendAssistantMessage(`reply ${turn}`);
      conversation.appendUserMessage(`question ${turn}`);
    }

    const error = await rejectionOf(
      generate({ conversation, step: 0, toolbox: createToolbox([]) }),
    );

    expect(error).toBeInstanceOf(MediaAdmissionError);
    expect(client._calls).toHaveLength(0);
  });

  it('a resolved managed asset survives the caching provider’s request projection, since it keeps its message ids', async () => {
    const client = createMockAnthropicClient([textResponse()]);
    const generate = createAnthropicProvider({
      model: 'claude-sonnet-5-5',
      client,
      assembler: createContextAssembler(),
      contextBudget: createTokenBudget({
        maxTokens: 100_000,
        mediaCostEstimator: (part, position) => ({
          ...position,
          modality: part.type,
          outcome: 'estimated',
          tokens: 10,
          basis: 'catalog-estimate',
        }),
      }),
    });
    const conversation = new Conversation();
    conversation.appendUserMessage([
      {
        type: 'document',
        name: 'c.pdf',
        mimeType: 'application/pdf',
        source: { kind: 'managed-asset', assetId: 'a', revision: 1 },
      },
    ]);
    const messageId = conversation.current.ids[0]!;
    const context: GenerateContext = {
      conversation,
      step: 0,
      toolbox: createToolbox([]),
      resolvedSources: new Map([
        [
          `${messageId}:0`,
          {
            outcome: 'resolved',
            source: { kind: 'inline', data: BYTES, encoding: 'base64' },
            safety: 'clean',
          },
        ],
      ]),
    };
    let thrown: unknown;
    try {
      await generate(context);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
    expect(JSON.stringify(client._calls[0]?.['messages'])).toContain(BYTES);
  });
});
