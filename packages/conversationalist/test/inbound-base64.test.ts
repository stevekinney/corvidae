/**
 * COR-716 — every inbound adapter validates third-party base64 at the mapping
 * boundary, with its own mapping error naming the padding, instead of storing
 * bytes the stricter content schema refuses later with a generic message.
 */
import { describe, expect, it } from 'bun:test';

import { fromA2APart } from '../src/adapters/a2a/content';
import { fromAGUIMessages } from '../src/adapters/ag-ui/inbound';
import { fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import { fromGeminiMessages } from '../src/adapters/gemini/inbound';
import { fromOpenAIMessages } from '../src/adapters/openai/inbound';

/** Three characters: not a multiple of four, so it is not padded base64. */
const UNPADDED = 'QUJ';
const PADDING = /padd/i;

describe('every inbound adapter refuses base64 that does not decode', () => {
  it('AG-UI', () => {
    expect(() =>
      fromAGUIMessages([
        {
          id: 'm1',
          role: 'user',
          content: [
            { type: 'image', source: { type: 'data', value: UNPADDED, mimeType: 'image/png' } },
          ],
        } as never,
      ]),
    ).toThrow(PADDING);
  });

  it('Anthropic image and document', () => {
    expect(() =>
      fromAnthropicMessages({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: UNPADDED },
              },
            ],
          },
        ],
      } as never),
    ).toThrow(PADDING);
    expect(() =>
      fromAnthropicMessages({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: UNPADDED },
              },
            ],
          },
        ],
      } as never),
    ).toThrow(PADDING);
  });

  it('OpenAI image data URL and file data URL', () => {
    expect(() =>
      fromOpenAIMessages([
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${UNPADDED}` } }],
        },
      ] as never),
    ).toThrow(PADDING);
    expect(() =>
      fromOpenAIMessages([
        {
          role: 'user',
          content: [
            {
              type: 'file',
              file: { file_data: `data:application/pdf;base64,${UNPADDED}`, filename: 'a.pdf' },
            },
          ],
        },
      ] as never),
    ).toThrow(PADDING);
  });

  it('A2A raw bytes and data URL', () => {
    expect(() => fromA2APart({ raw: UNPADDED, mediaType: 'image/png' })).toThrow(PADDING);
    expect(() =>
      fromA2APart({ url: `data:image/png;base64,${UNPADDED}`, mediaType: 'image/png' }),
    ).toThrow(PADDING);
  });

  it('Gemini inline data', () => {
    expect(() =>
      fromGeminiMessages({
        contents: [
          { role: 'user', parts: [{ inlineData: { data: UNPADDED, mimeType: 'image/png' } }] },
        ],
      } as never),
    ).toThrow(PADDING);
  });
});
