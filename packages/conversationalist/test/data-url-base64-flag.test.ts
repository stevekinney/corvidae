/**
 * COR-716 — a data URL's `;base64` flag, like its media-type parameters, is
 * case-insensitive (RFC 2397 header tokens). One shared parser serves
 * validation, the exporters, and the body reader, so `;BASE64` can never pass
 * validation as text and then be sent as the bytes of the literal base64 string.
 */
import { describe, expect, it } from 'bun:test';

import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import { parseDataUrl } from '../src/adapters/media';
import { toOpenAIMessages } from '../src/adapters/openai/outbound';
import type { ConversationHistory, MediaContent, MultiModalContent } from '../src/index';
import { Conversation, createPIIRedactionPlugin, readMediaBody } from '../src/index';

const ABC = 'QUJD'; // base64 of "ABC"

function history(part: MultiModalContent): ConversationHistory {
  const conversation = new Conversation();
  conversation.appendUserMessage([part]);
  return conversation.current;
}

function textDocument(url: string): MediaContent {
  return { type: 'document', mimeType: 'text/plain', source: { kind: 'data-url', url } };
}

describe('the data URL base64 flag is read without regard to case', () => {
  for (const flag of ['BASE64', 'Base64', 'base64']) {
    it(`parses ;${flag} as base64 bytes`, () => {
      expect(parseDataUrl(`data:text/plain;${flag},${ABC}`)).toEqual({
        data: ABC,
        mimeType: 'text/plain',
      });
    });

    it(`reads the body of a ;${flag} text document as ABC`, () => {
      const body = readMediaBody(textDocument(`data:text/plain;${flag},${ABC}`));
      expect(body).toMatchObject({ status: 'text', body: { text: 'ABC' } });
    });

    it(`sends ABC through the Anthropic exporter for ;${flag}`, () => {
      const { messages } = toAnthropicMessages(
        history(textDocument(`data:text/plain;${flag},${ABC}`)),
      );
      expect(JSON.stringify(messages)).toContain('"data":"ABC"');
    });

    it(`sends the bytes through the Gemini exporter for ;${flag}`, () => {
      const { contents } = toGeminiMessages(
        history(textDocument(`data:text/plain;${flag},${ABC}`)),
      );
      expect(JSON.stringify(contents)).toContain(`"data":"${ABC}"`);
    });

    it(`sends the bytes through the OpenAI exporter for ;${flag}`, () => {
      const image: MultiModalContent = {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'data-url', url: `data:image/png;${flag},${ABC}` },
      };
      const { messages } = toOpenAIMessages(history(image));
      expect(JSON.stringify(messages)).toContain(`;base64,${ABC}`);
    });
  }

  it('lower-cases the media type and ignores its parameters', () => {
    expect(parseDataUrl(`data:TEXT/PLAIN;charset=UTF-8;BASE64,${ABC}`)).toEqual({
      data: ABC,
      mimeType: 'text/plain',
    });
  });

  it('refuses a malformed ;BASE64 payload at the schema', () => {
    const conversation = new Conversation();
    expect(() =>
      conversation.appendUserMessage([textDocument('data:text/plain;BASE64,QUJ')]),
    ).toThrow();
  });

  it('reads the scheme without regard to case too', () => {
    expect(parseDataUrl(`DATA:text/plain;BASE64,${ABC}`)).toEqual({
      data: ABC,
      mimeType: 'text/plain',
    });
    const body = readMediaBody(textDocument(`DATA:text/plain;BASE64,${ABC}`));
    expect(body).toMatchObject({ status: 'text', body: { text: 'ABC' } });
  });

  it('keeps a parameter-only header from naming a media type', () => {
    expect(parseDataUrl(`data:;base64,${ABC}`)).toEqual({ data: ABC, mimeType: undefined });
  });

  it('redacts the body of a ;BASE64 data URL and writes it back as base64 under the same header', () => {
    const plugin = createPIIRedactionPlugin();
    const email = btoa('write jane.doe@example.com');
    const result = plugin({
      role: 'user',
      content: [textDocument(`data:text/plain;BASE64,${email}`)],
    });
    expect(JSON.stringify(result.content)).toContain(
      `data:text/plain;BASE64,${btoa('write [EMAIL_REDACTED]')}`,
    );
  });

  it('has no data URL parsing outside splitDataUrl, in any package that reads media', async () => {
    const roots = ['../src', '../../operative/src', '../../bureau/src'];
    const offenders: string[] = [];
    for (const root of roots) {
      for await (const file of new Bun.Glob('**/*.ts').scan({
        cwd: new URL(root, import.meta.url).pathname,
      })) {
        if (file.endsWith('.test.ts') || file.endsWith('media-types.ts')) continue;
        const text = await Bun.file(new URL(`${root}/${file}`, import.meta.url)).text();
        // A case-sensitive flag or scheme test is the defect: `;BASE64` and `DATA:` are valid.
        if (/includes\((['"])base64\1\)|startsWith\((['"])data:\2\)/.test(text)) {
          offenders.push(`${root}/${file}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
