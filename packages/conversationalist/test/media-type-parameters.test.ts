/**
 * COR-716 — a media type's parameters (`;version=1.7`, `; charset=utf-8`) and
 * its case never change what the type is. Every family comparison goes through
 * the shared `baseMimeType`, so `application/pdf;version=1.7` is a PDF at every
 * surface: classification, the exporters, and the SDK mapping.
 */
import { describe, expect, it } from 'bun:test';

import { fromA2APart } from '../src/adapters/a2a/content';
import { toAnthropicMessagesForSdk } from '../src/adapters/anthropic/sdk';
import { modalityFromMimeType } from '../src/adapters/media';
import { toOpenAIMessages } from '../src/adapters/openai/outbound';
import type { ConversationHistory } from '../src/index';
import { Conversation } from '../src/index';

const PDF = 'JVBERi0='; // base64 of "%PDF-"

function pdfConversation(mimeType: string): ConversationHistory {
  const conversation = new Conversation();
  conversation.appendUserMessage([
    { type: 'document', mimeType, source: { kind: 'inline', data: PDF, encoding: 'base64' } },
  ]);
  return conversation.current;
}

describe('media type parameters and case (COR-716)', () => {
  it('classifies a parameterized or upper-cased type by its base type', () => {
    expect(modalityFromMimeType('application/pdf;version=1.7')).toBe('document');
    expect(modalityFromMimeType('Application/PDF')).toBe('document');
    expect(modalityFromMimeType('IMAGE/PNG; q=1')).toBe('image');
    expect(modalityFromMimeType('text/markdown; charset=utf-8')).toBe('document');
  });

  it('an A2A file part takes its modality from the base type, whatever its case', () => {
    expect(fromA2APart({ raw: 'QUJD', mediaType: 'IMAGE/PNG; q=1' })).toMatchObject({
      type: 'image',
    });
    expect(fromA2APart({ raw: 'QUJD', mediaType: 'Audio/MPEG' })).toMatchObject({
      type: 'audio',
    });
  });

  it('the OpenAI exporter sends a parameterized PDF as a PDF', () => {
    const { messages } = toOpenAIMessages(pdfConversation('application/pdf;version=1.7'));
    const [part] =
      (messages[0]?.content as Array<{ type: string; file?: { file_data?: string } }>) ?? [];
    expect(part?.type).toBe('file');
    expect(part?.file?.file_data?.startsWith('data:application/pdf;base64,')).toBe(true);
  });

  it('the Anthropic SDK mapping accepts a parameterized PDF as a PDF', () => {
    const { messages } = toAnthropicMessagesForSdk(pdfConversation('application/pdf;version=1.7'));
    const wire = JSON.stringify(messages);
    expect(wire).toContain('"media_type":"application/pdf"');
    expect(wire).not.toContain('version=1.7');
  });
});
