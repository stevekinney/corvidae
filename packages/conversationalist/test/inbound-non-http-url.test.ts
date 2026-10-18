import { describe, expect, it } from 'bun:test';

import { fromA2APart } from '../src/adapters/a2a/content';
import { fromAGUIMessages } from '../src/adapters/ag-ui/inbound';
import { fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import { fromGeminiMessages } from '../src/adapters/gemini/inbound';
import { fromOpenAIMessages } from '../src/adapters/openai/inbound';

describe('every inbound adapter refuses a non-HTTP URL', () => {
  it('AG-UI', () => {
    expect(() =>
      fromAGUIMessages([
        {
          id: 'm1',
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'url', value: 's3://bucket/a.png', mimeType: 'image/png' },
            },
          ],
        } as never,
      ]),
    ).toThrow(/s3:\/\/bucket/);
  });
  it('Anthropic image and document', () => {
    expect(() =>
      fromAnthropicMessages({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url: 's3://bucket/a.png' } }],
          },
        ],
      } as never),
    ).toThrow(/s3:\/\/bucket/);
    expect(() =>
      fromAnthropicMessages({
        messages: [
          {
            role: 'user',
            content: [{ type: 'document', source: { type: 'url', url: 'ftp://h/a.pdf' } }],
          },
        ],
      } as never),
    ).toThrow(/ftp:\/\/h/);
  });
  it('OpenAI', () => {
    expect(() =>
      fromOpenAIMessages([
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }],
        },
      ] as never),
    ).toThrow();
  });
  it('A2A', () => {
    expect(() => fromA2APart({ url: 'ftp://h/a.png', mediaType: 'image/png' })).toThrow();
  });
  it('Gemini', () => {
    for (const fileUri of ['ftp://h/a.png', 's3://bucket/a.png', 'file:///a.png']) {
      expect(() =>
        fromGeminiMessages({
          contents: [{ role: 'user', parts: [{ fileData: { fileUri, mimeType: 'image/png' } }] }],
        } as never),
      ).toThrow(fileUri);
    }
  });

  it('Gemini keeps a Files API URI and a Cloud Storage URI as its own handles', () => {
    for (const fileUri of [
      'https://generativelanguage.googleapis.com/v1beta/files/abc-123',
      'gs://bucket/a.png',
    ]) {
      const conversation = fromGeminiMessages({
        contents: [{ role: 'user', parts: [{ fileData: { fileUri, mimeType: 'image/png' } }] }],
      } as never);
      const [id] = conversation.ids;
      expect(conversation.messages[id!]?.content).toEqual([
        {
          type: 'image',
          mimeType: 'image/png',
          source: { kind: 'provider-file', provider: 'gemini', providerFileId: fileUri },
        },
      ]);
    }
  });
});
