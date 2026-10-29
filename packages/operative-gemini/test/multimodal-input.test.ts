import type { GenerateContext } from '@lostgradient/operative/provider-kit';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import type { MediaContent, MultiModalContent } from 'conversationalist';
import { Conversation } from 'conversationalist';
import { createGeminiProvider } from '../src/gemini.ts';
import { geminiFunctionCallResponse, geminiTextResponse } from '../src/test/gemini-fixtures.ts';
import { createMockGeminiModel } from '../src/test/gemini-mock-clients.ts';

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
  it('Gemini records lineage on a response that only calls tools', async () => {
    const gemini = await createGeminiProvider({
      model: 'gemini-2.5-flash',
      client: createMockGeminiModel([geminiFunctionCallResponse]),
    })(contextFor([dataUrlImage]));

    expect(gemini.toolCalls.length).toBeGreaterThan(0);
    expect(gemini.metadata?.['inputLineage']).toEqual([
      expect.objectContaining({ partIndex: 0, modality: 'image' }),
    ]);
  });

  it('Gemini: sends audio as inline data and a hosted video as file data', async () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({ model: 'gemini-2.5-flash', client });

    const response = await generate(
      contextFor([
        {
          type: 'audio',
          mimeType: 'audio/mpeg',
          source: { kind: 'inline', data: BYTES, encoding: 'base64' },
        },
        {
          type: 'video',
          mimeType: 'video/mp4',
          source: { kind: 'remote-url', url: 'https://example.com/v.mp4' },
        },
      ]),
    );

    expect(client._calls[0]?.contents).toEqual([
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/mpeg', data: BYTES } },
          { fileData: { mimeType: 'video/mp4', fileUri: 'https://example.com/v.mp4' } },
        ],
      },
    ]);
    expect(response.metadata?.['inputLineage']).toEqual([
      expect.objectContaining({ modality: 'audio', transform: 'inline-base64' }),
      expect.objectContaining({ modality: 'video', transform: 'remote-url-delegated' }),
    ]);
  });
});
