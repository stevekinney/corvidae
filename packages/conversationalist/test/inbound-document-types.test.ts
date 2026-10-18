/**
 * COR-716 — inbound classification reads the shared document table: a
 * structured-text or office media type arriving from a provider becomes a
 * `document`, which the same provider's exporter accepts, so it round-trips.
 */
import { describe, expect, it } from 'bun:test';

import { fromA2APart } from '../src/adapters/a2a/content';
import { fromGeminiMessages } from '../src/adapters/gemini/inbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import { modalityFromMimeType } from '../src/adapters/media';
import { fromOpenAIMessages } from '../src/adapters/openai/inbound';

const DOCUMENT_TYPES = [
  'application/json',
  'application/xml',
  'application/rtf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

describe('inbound document inference uses the shared table', () => {
  it('classifies every document type in the table as a document', () => {
    for (const mimeType of DOCUMENT_TYPES) expect(modalityFromMimeType(mimeType)).toBe('document');
    expect(modalityFromMimeType('application/octet-stream')).toBe('file');
  });

  it('a Gemini inlineData application/json part is a document that round-trips', () => {
    const conversation = fromGeminiMessages({
      contents: [
        { role: 'user', parts: [{ inlineData: { data: 'e30=', mimeType: 'application/json' } }] },
      ],
    } as never);
    const [id] = conversation.ids;
    expect(conversation.messages[id!]?.content).toEqual([
      {
        type: 'document',
        mimeType: 'application/json',
        source: { kind: 'inline', data: 'e30=', encoding: 'base64' },
      },
    ]);
    const { contents } = toGeminiMessages(conversation);
    expect(JSON.stringify(contents)).toContain('"mimeType":"application/json"');
  });

  it('a Gemini fileData office document is a document', () => {
    const conversation = fromGeminiMessages({
      contents: [
        {
          role: 'user',
          parts: [
            {
              fileData: {
                fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
                mimeType: 'application/msword',
              },
            },
          ],
        },
      ],
    } as never);
    const [id] = conversation.ids;
    expect(conversation.messages[id!]?.content).toMatchObject([{ type: 'document' }]);
  });

  it('an OpenAI file part carrying application/json is a document', () => {
    const conversation = fromOpenAIMessages([
      {
        role: 'user',
        content: [{ type: 'file', file: { file_data: 'data:application/json;base64,e30=' } }],
      },
    ] as never);
    const [id] = conversation.ids;
    expect(conversation.messages[id!]?.content).toMatchObject([{ type: 'document' }]);
  });

  it('an A2A raw part keeps its modality from the shared table', () => {
    expect(fromA2APart({ raw: 'e30=', mediaType: 'application/json' })).toMatchObject({
      type: 'document',
    });
    expect(fromA2APart({ raw: 'QUJD', mediaType: 'video/mp4' })).toMatchObject({ type: 'video' });
  });
});
