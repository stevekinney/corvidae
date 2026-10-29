import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import type { MediaContent, MultiModalContent } from 'conversationalist';
import { Conversation, UnsupportedContentError } from 'conversationalist';

import type { GenerateContext } from '@lostgradient/operative/provider-kit';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createOpenAIProvider } from '../src/openai.ts';
import { openAITextResponse, openAIToolCallResponse } from '../src/test/openai-fixtures.ts';
import { createMockOpenAIClient } from '../src/test/openai-mock-clients.ts';

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
  const inlinePdf: MediaContent = {
    type: 'document',
    name: 'spec.pdf',
    mimeType: 'application/pdf',
    source: { kind: 'inline', data: BYTES, encoding: 'base64' },
  };

  it('OpenAI: sends the image and the file part in order, and records both in the response lineage', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'gpt-4.1', client });

    const response = await generate(
      contextFor([{ type: 'text', text: 'look' }, dataUrlImage, inlinePdf]),
    );

    expect(client._calls[0]?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${BYTES}` } },
          {
            type: 'file',
            file: { file_data: `data:application/pdf;base64,${BYTES}`, filename: 'spec.pdf' },
          },
        ],
      },
    ]);
    expect(response.metadata?.['inputLineage']).toEqual([
      expect.objectContaining({ partIndex: 1, modality: 'image', provider: 'openai' }),
      expect.objectContaining({ partIndex: 2, modality: 'document', transform: 'inline-base64' }),
    ]);
  });

  it('OpenAI records lineage on a response that only calls tools', async () => {
    const openai = await createOpenAIProvider({
      model: 'gpt-4.1',
      client: createMockOpenAIClient([openAIToolCallResponse]),
    })(contextFor([dataUrlImage]));

    expect(openai.toolCalls.length).toBeGreaterThan(0);
    expect(openai.metadata?.['inputLineage']).toEqual([
      expect.objectContaining({ partIndex: 0, modality: 'image' }),
    ]);
  });

  it('OpenAI: rejects audio before the client is called, with a typed error', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'gpt-4.1', client });

    const reason = await rejectionOf(
      generate(
        contextFor([
          { type: 'audio', source: { kind: 'inline', data: BYTES, encoding: 'base64' } },
        ]),
      ),
    );

    expect(reason).toBeInstanceOf(UnsupportedContentError);
    expect(client._calls).toHaveLength(0);
  });
});
