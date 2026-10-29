import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import {
  type MediaContent,
  type MultiModalContent,
  Conversation,
  UnsupportedContentError,
} from 'conversationalist';

import type { GenerateContext } from '@lostgradient/operative/provider-kit';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createAnthropicProvider } from '../src/anthropic.ts';
import { anthropicTextResponse, anthropicToolUseResponse } from '../src/test/anthropic-fixtures.ts';
import { createMockAnthropicClient } from '../src/test/anthropic-mock-clients.ts';

const BYTES = 'QUJDREVGRw==';

describe('providers deliver every part or reject before the provider call', () => {
  function contextFor(
    content: MultiModalContent[],
    resolvedSources?: GenerateContext['resolvedSources'],
  ): GenerateContext {
    const conversation = new Conversation();
    conversation.appendUserMessage(content);
    return { conversation, step: 0, toolbox: createToolbox([]), resolvedSources };
  }

  const dataUrlImage: MediaContent = {
    type: 'image',
    source: { kind: 'data-url', url: `data:image/png;base64,${BYTES}` },
  };
  it('Anthropic records lineage on a response that only calls tools', async () => {
    const anthropic = await createAnthropicProvider({
      model: 'claude-sonnet-5-5',
      client: createMockAnthropicClient([anthropicToolUseResponse]),
    })(contextFor([dataUrlImage]));

    expect(anthropic.toolCalls.length).toBeGreaterThan(0);
    expect(anthropic.metadata?.['inputLineage']).toEqual([
      expect.objectContaining({ partIndex: 0, modality: 'image' }),
    ]);
  });

  it('Anthropic: substitutes a resolved source at export time and records the original asset identity', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'claude-sonnet-5-5', client });
    const managed: MediaContent = {
      type: 'document',
      name: 'contract.pdf',
      mimeType: 'application/pdf',
      source: { kind: 'managed-asset', assetId: 'asset-9', revision: 2 },
    };
    const context = contextFor([managed]);
    const messageId = context.conversation.current.ids[0]!;

    const response = await generate({
      ...context,
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
    });

    expect(client._calls[0]?.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            title: 'contract.pdf',
            source: { type: 'base64', media_type: 'application/pdf', data: BYTES },
          },
        ],
      },
    ]);
    expect(response.metadata?.['inputLineage']).toEqual([
      expect.objectContaining({
        from: 'managed-asset',
        to: 'inline',
        transform: 'resolved',
        assetId: 'asset-9',
        revision: 2,
      }),
    ]);
    // The stored message still names the asset and revision.
    expect(context.conversation.getMessages()[0]?.content).toEqual([managed]);
  });

  it('Anthropic: rejects an unresolved managed asset instead of dropping it', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'claude-sonnet-5-5', client });

    const reason = await rejectionOf(
      generate(
        contextFor([
          {
            type: 'document',
            source: { kind: 'managed-asset', assetId: 'asset-9' },
            mimeType: 'application/pdf',
          },
        ]),
      ),
    );

    expect(reason).toBeInstanceOf(UnsupportedContentError);
    expect((reason as UnsupportedContentError).reason).toBe('source-form-not-accepted');
    expect(client._calls).toHaveLength(0);
  });
});
